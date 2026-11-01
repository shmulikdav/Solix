import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { costForUsage, totalTokens } from '@solix/shared';
import type { Broadcaster } from '../broadcaster.js';
import type { DB } from '../db.js';
import {
  getSession,
  getTranscriptPos,
  setSessionCost,
  setTranscriptPos,
} from './sessions.js';
import { addMissionTokens } from './missions.js';

const TRANSCRIPT_BASE = join(homedir(), '.claude', 'projects');

// Heuristic context window for percentage. Claude Opus 4.x is ~200K. We pick
// a single anchor for now; per-model anchors land when transcripts include
// model metadata reliably (they already do — `message.model` is set).
const CONTEXT_BUDGETS_BY_MODEL: Record<string, number> = {
  'claude-opus-4-7': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
  default: 200_000,
};

// Cap how much of an existing transcript we replay on first attach. Anything
// older falls off — the chat UI is for live conversation, not deep history.
const REPLAY_TAIL_BYTES = 64 * 1024;

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

export function transcriptPathFor(cwd: string, sessionId: string): string {
  return join(TRANSCRIPT_BASE, encodeProjectPath(cwd), `${sessionId}.jsonl`);
}

interface AssistantContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  promptId?: string;
  timestamp?: string;
  message?: {
    role?: 'user' | 'assistant' | 'system' | 'tool';
    content?: string | AssistantContentBlock[];
    model?: string;
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface WatcherRecord {
  sessionId: string;
  filePath: string;
  position: number;
  fsWatcher?: FSWatcher;
  initialRead: boolean;
  /**
   * Byte offset up to which this transcript's cost has already been counted,
   * persisted on the session row and therefore surviving a restart.
   *
   * The replay does two jobs and only one of them may repeat. Chat deltas
   * have to be re-emitted every time something attaches, so the Chat tab has
   * recent context the moment it is opened — that is the whole reason the
   * replay exists. Cost and mission tokens *accumulate*, so re-emitting them
   * charges for work that already happened.
   *
   * It did. `records` lives in memory, so after a restart the session's
   * persisted costUsd was still there and the replay added the same messages
   * on top: measured at exactly 2.00× on a two-message transcript, and
   * compounding with every restart. Budgets read that number, so a plan
   * would pause before spend it had not reached.
   */
  countedTo: number;
}

export class TranscriptWatcherManager {
  private records = new Map<string, WatcherRecord>();
  private deferredRetry = new Map<string, NodeJS.Timeout>();
  // Sprint M: sessions we've already raised a budget alert for, so we don't
  // re-fire on every subsequent assistant message. Cleared when spend drops
  // back under the cap (e.g. after the cap is raised).
  private budgetAlerted = new Set<string>();

  constructor(
    private db: DB,
    private broadcaster: Broadcaster,
  ) {}

  /**
   * Begin tailing this session's transcript. Idempotent. If the file doesn't
   * exist yet, retries every second for up to 10 s (Claude Code creates the
   * file slightly after the SessionStart hook fires).
   */
  startWatching(sessionId: string, cwd: string): void {
    if (this.records.has(sessionId)) return;

    const filePath = transcriptPathFor(cwd, sessionId);
    if (!existsSync(filePath)) {
      this.scheduleRetry(sessionId, cwd, 0);
      return;
    }

    this.attach(sessionId, filePath);
  }

  /**
   * Read whatever has been appended since the last read, now.
   *
   * This is the synchronous half of what the `fs.watch` callback triggers,
   * exposed so a test can drive accrual deterministically instead of racing
   * a filesystem event. Harmless in production: it reads from the stored
   * position, so calling it adds nothing that is not new.
   */
  readNow(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record) this.readNewLines(record);
  }

  private scheduleRetry(
    sessionId: string,
    cwd: string,
    attempt: number,
  ): void {
    if (attempt >= 10) return;
    const t = setTimeout(() => {
      this.deferredRetry.delete(sessionId);
      const filePath = transcriptPathFor(cwd, sessionId);
      if (existsSync(filePath)) {
        this.attach(sessionId, filePath);
      } else {
        this.scheduleRetry(sessionId, cwd, attempt + 1);
      }
    }, 1000);
    this.deferredRetry.set(sessionId, t);
  }

  private attach(sessionId: string, filePath: string): void {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      return;
    }
    // Replay the tail of the existing file so the chat panel has recent
    // context the moment a user opens it.
    const startPos = Math.max(0, size - REPLAY_TAIL_BYTES);
    const record: WatcherRecord = {
      sessionId,
      filePath,
      position: startPos,
      initialRead: startPos > 0,
      countedTo: getTranscriptPos(this.db, sessionId) ?? 0,
    };
    this.records.set(sessionId, record);

    this.readNewLines(record);

    try {
      record.fsWatcher = watch(filePath, () => {
        // Coalesce rapid writes — readNewLines reads everything new.
        this.readNewLines(record);
      });
    } catch (err) {
      console.warn(
        `[transcript] could not watch ${filePath}:`,
        (err as Error).message,
      );
    }
  }

  private readNewLines(record: WatcherRecord): void {
    let stat;
    try {
      stat = statSync(record.filePath);
    } catch {
      return;
    }
    if (stat.size <= record.position) return;

    let buf: Buffer;
    try {
      const fd = openSync(record.filePath, 'r');
      buf = Buffer.alloc(stat.size - record.position);
      readSync(fd, buf, 0, buf.length, record.position);
      closeSync(fd);
    } catch (err) {
      console.warn(
        `[transcript] read failed for ${record.filePath}:`,
        (err as Error).message,
      );
      return;
    }
    const readFrom = record.position;
    record.position = stat.size;

    let text = buf.toString('utf8');
    // First read after tail-jump: drop any partial line at the start so the
    // JSON parser doesn't see truncated input.
    let dropped = 0;
    if (record.initialRead) {
      const nl = text.indexOf('\n');
      dropped = nl >= 0 ? nl + 1 : text.length;
      text = nl >= 0 ? text.slice(nl + 1) : '';
      record.initialRead = false;
    }

    // Walk the lines keeping each one's absolute end offset, so a line can be
    // replayed into the chat while being recognised as already paid for.
    // `dropped` counts in bytes; so does `offset`, which is why the length is
    // measured on a Buffer rather than on the string — a multi-byte character
    // would otherwise drift the offset and start charging twice again.
    let offset = readFrom + dropped;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // +1 for the newline that `split` consumed, except after the last piece.
      const end = offset + Buffer.byteLength(line, 'utf8') + (i < lines.length - 1 ? 1 : 0);
      offset = end;
      if (!line.trim()) continue;
      this.processLine(record.sessionId, line, end > record.countedTo);
    }

    if (stat.size > record.countedTo) {
      record.countedTo = stat.size;
      setTranscriptPos(this.db, record.sessionId, stat.size);
    }
  }

  /** `countable` is false for a line replayed from before the high-water
   *  mark: it still reaches the chat, it just must not be charged again. */
  private processLine(sessionId: string, line: string, countable = true): void {
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line) as TranscriptLine;
    } catch {
      return;
    }

    const message = obj.message;
    if (!message) return;
    const role = message.role;

    if (role === 'user') {
      this.emitUser(sessionId, obj);
    } else if (role === 'assistant') {
      this.emitAssistant(sessionId, obj, countable);
    }
  }

  private emitUser(sessionId: string, obj: TranscriptLine): void {
    const content = this.flattenUserContent(obj.message?.content);
    if (!content) return;
    this.broadcaster.broadcast({
      type: 'chat_delta',
      sessionId,
      delta: {
        messageId:
          obj.uuid ?? obj.promptId ?? `u-${Date.now()}-${Math.random()}`,
        role: 'user',
        content,
        ts: this.parseTs(obj.timestamp),
        done: true,
      },
    });
  }

  private emitAssistant(
    sessionId: string,
    obj: TranscriptLine,
    countable = true,
  ): void {
    const message = obj.message;
    if (!message) return;

    if (message.usage) {
      const total =
        (message.usage.input_tokens ?? 0) +
        (message.usage.cache_read_input_tokens ?? 0) +
        (message.usage.cache_creation_input_tokens ?? 0);
      const budget =
        CONTEXT_BUDGETS_BY_MODEL[message.model ?? 'default'] ??
        CONTEXT_BUDGETS_BY_MODEL.default!;
      const pct = Math.min(100, (total / budget) * 100);
      this.broadcaster.broadcast({
        type: 'context_update',
        sessionId,
        usagePct: pct,
      });

      // Sprint M — accumulate dollar cost from this message's token usage.
      //
      // Everything below here adds to a running total, so it must happen
      // exactly once per line of transcript, ever. `context_update` above
      // stays outside the guard because it is a view of the latest message
      // rather than a sum: re-deriving it is free and correct.
      const inc = countable ? costForUsage(message.model, message.usage) : 0;
      const session = countable ? getSession(this.db, sessionId) : null;
      if (session) {
        const updated = setSessionCost(this.db, sessionId, session.costUsd + inc);
        const costUsd = updated?.costUsd ?? session.costUsd + inc;
        const cap = updated?.budgetUsd ?? session.budgetUsd;
        this.broadcaster.broadcast({
          type: 'cost_update',
          sessionId,
          costUsd,
          budgetUsd: cap,
        });
        // Roll the message's tokens into the active mission's total.
        if (session.currentMissionId) {
          addMissionTokens(
            this.db,
            session.currentMissionId,
            totalTokens(message.usage),
          );
        }
        // Budget breach → one-shot alert; clears when back under the cap.
        if (cap != null && costUsd >= cap) {
          if (!this.budgetAlerted.has(sessionId)) {
            this.budgetAlerted.add(sessionId);
            this.broadcaster.broadcast({
              type: 'budget_alert',
              sessionId,
              costUsd,
              budgetUsd: cap,
            });
          }
        } else {
          this.budgetAlerted.delete(sessionId);
        }
      }
    }

    const content = this.flattenAssistantContent(message.content);
    if (!content) return;
    this.broadcaster.broadcast({
      type: 'chat_delta',
      sessionId,
      delta: {
        messageId: message.id ?? `a-${Date.now()}-${Math.random()}`,
        role: 'assistant',
        content,
        ts: this.parseTs(obj.timestamp),
        done: true,
      },
    });
  }

  private flattenUserContent(
    content: string | AssistantContentBlock[] | undefined,
  ): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    const parts: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) parts.push(b.text);
      else if (b.type === 'tool_result') {
        const inner = b.content;
        const text =
          typeof inner === 'string'
            ? inner
            : Array.isArray(inner)
              ? inner
                  .map((x) =>
                    typeof x === 'object' && x !== null && 'text' in x
                      ? String((x as { text?: string }).text ?? '')
                      : '',
                  )
                  .join('\n')
              : '';
        if (text) parts.push(`[tool result]\n${text.slice(0, 600)}`);
      }
    }
    return parts.join('\n').trim();
  }

  private flattenAssistantContent(
    content: string | AssistantContentBlock[] | undefined,
  ): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    const parts: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) {
        parts.push(b.text);
      } else if (b.type === 'tool_use' && b.name) {
        const inputSummary = JSON.stringify(b.input ?? {}).slice(0, 120);
        parts.push(`▸ ${b.name} ${inputSummary}`);
      } else if (b.type === 'thinking' && b.thinking) {
        // Thinking blocks are noisy; show only the first ~100 chars.
        const t = b.thinking.replace(/\s+/g, ' ').slice(0, 100);
        if (t) parts.push(`💭 ${t}…`);
      }
    }
    return parts.join('\n\n').trim();
  }

  private parseTs(value?: string): number {
    if (!value) return Date.now();
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : Date.now();
  }

  stopWatching(sessionId: string): void {
    const r = this.records.get(sessionId);
    if (r?.fsWatcher) {
      try {
        r.fsWatcher.close();
      } catch {
        /* ignore */
      }
    }
    this.records.delete(sessionId);
    const t = this.deferredRetry.get(sessionId);
    if (t) {
      clearTimeout(t);
      this.deferredRetry.delete(sessionId);
    }
  }

  shutdownAll(): void {
    for (const id of [...this.records.keys()]) this.stopWatching(id);
    for (const id of [...this.deferredRetry.keys()]) this.stopWatching(id);
  }
}
