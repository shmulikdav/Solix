import type { DB } from '../db.js';
import { listAudit } from './audit.js';
import { getSession } from './sessions.js';

/**
 * What you allowed, and when.
 *
 * `solix gain` counts what Solix prevented. This is the other half: the
 * record of what got through because a human said yes. Nothing else in this
 * space can produce it, because nothing else is holding the call — and it is
 * the artifact someone is asked for after an agent does something expensive.
 *
 * Unlike the impact report, a ledger entry contains the **actual command or
 * path**. That is the point of it, and the reason every export says so: the
 * file it writes is not safe to paste into a public issue.
 */
export type LedgerDecision = 'approved' | 'denied' | 'blocked';

export interface LedgerEntry {
  ts: number;
  decision: LedgerDecision;
  tool: string;
  /** The command for a shell call, the path for a write, else a summary. */
  detail: string;
  /** Why containment refused it. Only ever set on `blocked`. */
  reason?: string;
  sessionId?: string;
  sessionName?: string;
}

const KIND_TO_DECISION: Record<string, LedgerDecision> = {
  permission_approved: 'approved',
  permission_denied: 'denied',
  command_blocked: 'blocked',
};

function detailOf(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  if (typeof payload.command === 'string') return payload.command;
  const args = payload.args as Record<string, unknown> | undefined;
  if (args) {
    if (typeof args.command === 'string') return args.command;
    if (typeof args.file_path === 'string') return args.file_path;
    const first = Object.values(args)[0];
    if (typeof first === 'string') return first;
    if (first !== undefined) return JSON.stringify(first);
  }
  return '';
}

export function listLedger(
  db: DB,
  opts: { since?: number; until?: number; limit?: number } = {},
): LedgerEntry[] {
  const until = opts.until ?? Date.now();
  const since = opts.since ?? until - 30 * 24 * 60 * 60 * 1000;
  // One pass over the window, filtered to the three decision kinds. Session
  // names are looked up once per id rather than per row.
  const names = new Map<string, string | undefined>();
  const entries: LedgerEntry[] = [];

  for (const e of listAudit(db, { since, until, limit: opts.limit ?? 5000 })) {
    const decision = KIND_TO_DECISION[e.kind];
    if (!decision) continue;
    const payload = e.payload;
    if (e.sessionId && !names.has(e.sessionId)) {
      names.set(e.sessionId, getSession(db, e.sessionId)?.name ?? undefined);
    }
    entries.push({
      ts: e.ts,
      decision,
      tool: (payload?.tool as string) ?? 'unknown',
      detail: detailOf(payload) || e.summary,
      ...(typeof payload?.reason === 'string' ? { reason: payload.reason } : {}),
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.sessionId && names.get(e.sessionId)
        ? { sessionName: names.get(e.sessionId)! }
        : {}),
    });
  }
  // Oldest first reads as a record; listAudit hands back newest first.
  return entries.reverse();
}

export interface LedgerPattern {
  kind: 'late_night' | 'repeated' | 'denied_then_approved';
  summary: string;
  count: number;
  detail?: string;
}

/** Local hours that count as late. Deliberately generous at both ends. */
function isLateNight(ts: number): boolean {
  const h = new Date(ts).getHours();
  return h >= 22 || h < 6;
}

/**
 * The three patterns worth a second look.
 *
 * Not "risk scores" — just the shapes that, read back a week later, are the
 * ones people wish they had noticed: decisions made when you were tired, a
 * command you keep waving through, and one you refused and then allowed.
 */
export function ledgerPatterns(entries: LedgerEntry[]): LedgerPattern[] {
  const out: LedgerPattern[] = [];
  const approvals = entries.filter((e) => e.decision === 'approved');

  const late = approvals.filter((e) => isLateNight(e.ts));
  if (late.length > 0) {
    out.push({
      kind: 'late_night',
      count: late.length,
      summary: `${late.length} approval${late.length === 1 ? '' : 's'} between 22:00 and 06:00`,
    });
  }

  const byDetail = new Map<string, number>();
  for (const e of approvals) {
    if (!e.detail) continue;
    byDetail.set(e.detail, (byDetail.get(e.detail) ?? 0) + 1);
  }
  for (const [detail, count] of [...byDetail.entries()].sort((a, b) => b[1] - a[1])) {
    // Three is where "I keep doing this" starts; below that it is just work.
    if (count < 3) break;
    out.push({
      kind: 'repeated',
      count,
      summary: `approved ${count} times — worth a rule rather than a decision`,
      detail,
    });
  }

  // Refused, then later allowed. Usually fine; occasionally the moment
  // someone wore you down.
  const deniedAt = new Map<string, number>();
  for (const e of entries) {
    if (e.decision !== 'denied' || !e.detail) continue;
    if (!deniedAt.has(e.detail)) deniedAt.set(e.detail, e.ts);
  }
  for (const e of approvals) {
    const when = e.detail ? deniedAt.get(e.detail) : undefined;
    if (when !== undefined && e.ts > when) {
      out.push({
        kind: 'denied_then_approved',
        count: 1,
        summary: 'denied earlier, approved later',
        detail: e.detail,
      });
      deniedAt.delete(e.detail);
    }
  }

  return out;
}

const SYMBOL: Record<LedgerDecision, string> = {
  approved: '✓',
  denied: '✗',
  blocked: '⛔',
};

export function ledgerToMarkdown(
  entries: LedgerEntry[],
  patterns: LedgerPattern[],
  window: { since: number; until: number },
): string {
  const iso = (ts: number): string => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [
    '# Solix approval ledger',
    '',
    `${iso(window.since)} — ${iso(window.until)} · ${entries.length} decision${entries.length === 1 ? '' : 's'}`,
    '',
    '> This file contains the actual commands and file paths your agents asked',
    '> to run. Treat it like a shell history: fine for your team, not for a',
    '> public issue.',
    '',
  ];

  if (patterns.length) {
    lines.push('## Worth a look', '');
    for (const p of patterns) {
      lines.push(`- **${p.summary}**${p.detail ? `\n  \`${p.detail}\`` : ''}`);
    }
    lines.push('');
  }

  lines.push('## Decisions', '', '| When | | Tool | What |', '| --- | --- | --- | --- |');
  for (const e of entries) {
    const what = e.reason ? `${e.detail} — _${e.reason}_` : e.detail;
    lines.push(
      `| ${iso(e.ts)} | ${SYMBOL[e.decision]} | ${e.tool} | ${what.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** RFC 4180: double the quotes, wrap anything with a comma, quote or newline. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function ledgerToCsv(entries: LedgerEntry[]): string {
  const rows = [['timestamp', 'decision', 'tool', 'detail', 'reason', 'session'].join(',')];
  for (const e of entries) {
    rows.push(
      [
        new Date(e.ts).toISOString(),
        e.decision,
        e.tool,
        e.detail,
        e.reason ?? '',
        e.sessionName ?? e.sessionId ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}
