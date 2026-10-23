import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { costForUsage, type TokenUsage } from '@solix/shared';
import type { DB } from '../db.js';
import { ensureProject } from './projects.js';
import { getSession, setSessionCost, upsertSession } from './sessions.js';

/**
 * Backfill the galaxy from Claude Code's own transcripts.
 *
 * Solix only ever saw sessions started *after* its hooks were wired, so a
 * fresh install opened on an empty galaxy however much work you had already
 * done — the first screen of a tool about watching your fleet showed no
 * fleet. Agent View's background sessions were already imported on boot
 * (`agentview.ts` walks every job, not just the live roster); this covers the
 * interactive ones, which are the ones most people have.
 *
 * Nothing is parsed from scratch: the transcripts are the same JSONL the live
 * watcher reads, and cost comes from the same `costForUsage` over the same
 * `message.usage`, so an imported session is priced exactly as a live one is.
 */
const TRANSCRIPT_BASE = join(homedir(), '.claude', 'projects');

export interface ImportedSession {
  sessionId: string;
  cwd: string;
  costUsd: number;
  startedAt: number;
  endedAt: number;
  messages: number;
}

export interface ImportResult {
  /** Transcript files considered (subagent files are not among them). */
  scanned: number;
  imported: number;
  /** Already in the database — the import is safe to re-run. */
  skipped: number;
  /** Unreadable or carrying no usable session, counted rather than thrown. */
  failed: number;
  costUsd: number;
  projects: number;
}

/** Every top-level `*.jsonl` under each project directory. */
function transcriptFiles(base: string): string[] {
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const project of readdirSync(base)) {
    const dir = join(base, project);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      // A session's own transcript sits directly in the project directory.
      // Its subagents live in `<sessionId>/subagents/*.jsonl`, which the live
      // watcher does not read either — their spend is not attributed twice.
      if (entry.endsWith('.jsonl')) out.push(join(dir, entry));
    }
  }
  return out;
}

interface Line {
  type?: string;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  message?: { model?: string; usage?: TokenUsage };
}

/** Read one transcript, summing what it cost. */
async function readTranscript(file: string): Promise<ImportedSession | null> {
  let sessionId = '';
  let cwd = '';
  let costUsd = 0;
  let messages = 0;
  let startedAt = 0;
  let endedAt = 0;

  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const raw of rl) {
      if (!raw) continue;
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        // A half-written last line is normal for a session that is still
        // running. Skip it rather than lose the whole transcript.
        continue;
      }
      if (!sessionId && line.sessionId) sessionId = line.sessionId;
      if (!cwd && line.cwd) cwd = line.cwd;
      if (line.timestamp) {
        const t = Date.parse(line.timestamp);
        if (!Number.isNaN(t)) {
          if (!startedAt || t < startedAt) startedAt = t;
          if (t > endedAt) endedAt = t;
        }
      }
      if (line.type === 'assistant' && line.message?.usage) {
        costUsd += costForUsage(line.message.model, line.message.usage);
        messages += 1;
      }
    }
  } finally {
    rl.close();
  }

  if (!sessionId || !cwd) return null;
  return { sessionId, cwd, costUsd, startedAt, endedAt, messages };
}

export async function importHistory(
  db: DB,
  opts: { base?: string; onSession?: (s: ImportedSession) => void } = {},
): Promise<ImportResult> {
  const files = transcriptFiles(opts.base ?? TRANSCRIPT_BASE);
  const result: ImportResult = {
    scanned: files.length,
    imported: 0,
    skipped: 0,
    failed: 0,
    costUsd: 0,
    projects: 0,
  };
  const projects = new Set<string>();

  for (const file of files) {
    let parsed: ImportedSession | null;
    try {
      parsed = await readTranscript(file);
    } catch {
      result.failed += 1;
      continue;
    }
    if (!parsed) {
      result.failed += 1;
      continue;
    }

    // Idempotent: a session Solix already knows — live, previously imported,
    // or still running right now — is left exactly as it is.
    if (getSession(db, parsed.sessionId)) {
      result.skipped += 1;
      continue;
    }

    const project = ensureProject(db, parsed.cwd);
    projects.add(project.id);

    upsertSession(db, {
      id: parsed.sessionId,
      // No live process: a historical session has no pid to signal.
      pid: 0,
      projectId: project.id,
      cwd: parsed.cwd,
      // Started in someone's terminal, not by Solix.
      origin: 'external',
    });
    setSessionCost(db, parsed.sessionId, parsed.costUsd);

    // Put it back in time. Without this every imported session claims to have
    // started now, which would make the timeline and the galaxy's ordering
    // nonsense on the very first screen.
    if (parsed.startedAt) {
      db.prepare(
        `UPDATE sessions SET status = 'idle', created_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(parsed.startedAt, parsed.endedAt || parsed.startedAt, parsed.sessionId);
    } else {
      db.prepare(`UPDATE sessions SET status = 'idle' WHERE id = ?`).run(
        parsed.sessionId,
      );
    }

    result.imported += 1;
    result.costUsd += parsed.costUsd;
    opts.onSession?.(parsed);
  }

  result.projects = projects.size;
  return result;
}
