import { nanoid } from 'nanoid';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type {
  ApprovalRule,
  ApprovalRuleDecision,
  ApprovalRuleInput,
  ApprovalRuleMatch,
  ApprovalRuleScope,
} from '@solix/shared';
import type { DB } from '../db.js';
import { isWriteOutsideRoot } from '../containment.js';
import {
  READONLY_TOOLS,
  SHELL_TOOLS,
  WRITE_TOOLS,
  describeRule,
  shellSegments,
  suggestRuleFor,
} from '@solix/shared';

// Re-exported so callers and tests keep one import.
export { READONLY_TOOLS, SHELL_TOOLS, WRITE_TOOLS, describeRule, shellSegments, suggestRuleFor };

/**
 * Approval rules — a person's *standing* decision at the gate.
 *
 * ## Why this exists
 *
 * At `standard`, every tool call from a Maestro worker is held for a human.
 * Measured on 2026-11-03 against the published 1.18.3: a five-task plan
 * produced **30 holds for 30 tool calls**, including `Read SPEC.md` and
 * `ls -la`. The ledger even said so — "approved 4 times — worth a rule rather
 * than a decision" — and there was no rule to make. A hold has to be the
 * exception or people flip to `observe` and the gate is gone.
 *
 * ## What a rule can and cannot do
 *
 * - A rule is consulted **after** the containment floor and **before** a
 *   human is asked. The floor (`deniedCommandReason`, writes outside the
 *   project) is not a rule and no rule can override it — `rm -rf /` with an
 *   allow-everything rule is still refused by containment first. That is
 *   `CLAIM-RULES-NEVER-OVERRIDE-FLOOR`.
 * - A rule's decision is written to the audit log as
 *   `permission_auto_approved` / `permission_auto_denied`, which the signed
 *   ledger counts **separately** from human decisions. A rule is never
 *   reported as a person. That is `CLAIM-AUTO-DECISIONS-LABELLED`.
 * - Deny rules win over allow rules.
 * - An allow rule for a shell command must cover **every segment** of the
 *   command. `ls && git push --force` is not "an `ls`". Any absolute path in
 *   an allowed segment must be inside the project root, so `cat ~/.ssh/id_rsa`
 *   is not covered by an allow rule for `cat`.
 *
 * Pure matching lives in `evaluateRules` so it can be tested without a
 * database; `applyRules` is the one the router calls.
 */

const MATCHES: ReadonlySet<ApprovalRuleMatch> = new Set([
  'readonly_tool',
  'write_inside_root',
  'command_prefix',
  'command_regex',
]);

export function isApprovalRuleMatch(v: unknown): v is ApprovalRuleMatch {
  return typeof v === 'string' && MATCHES.has(v as ApprovalRuleMatch);
}

export function isApprovalRuleDecision(v: unknown): v is ApprovalRuleDecision {
  return v === 'allow' || v === 'deny';
}

/** Validate a request body into a rule input, or explain what is wrong. */
export function parseRuleInput(
  body: unknown,
): { ok: true; input: ApprovalRuleInput } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as Record<string, unknown>;
  const scope = b.scope === 'project' ? 'project' : b.scope === 'global' || b.scope === undefined ? 'global' : null;
  if (!scope) return { ok: false, error: 'scope must be global or project' };
  const projectId = typeof b.projectId === 'string' && b.projectId ? b.projectId : undefined;
  if (scope === 'project' && !projectId) return { ok: false, error: 'a project rule needs projectId' };
  if (!isApprovalRuleMatch(b.match)) {
    return { ok: false, error: 'match must be readonly_tool, write_inside_root, command_prefix or command_regex' };
  }
  const decision = b.decision === undefined ? 'allow' : b.decision;
  if (!isApprovalRuleDecision(decision)) return { ok: false, error: 'decision must be allow or deny' };
  const tool = typeof b.tool === 'string' && b.tool.trim() ? b.tool.trim() : '*';
  const value = typeof b.value === 'string' ? b.value.trim() : '';
  if ((b.match === 'command_prefix' || b.match === 'command_regex') && !value) {
    return { ok: false, error: `${b.match} needs a value` };
  }
  if (b.match === 'command_regex') {
    try {
      new RegExp(value);
    } catch {
      return { ok: false, error: 'value is not a valid regular expression' };
    }
  }
  return {
    ok: true,
    input: {
      scope,
      projectId: scope === 'project' ? projectId : undefined,
      tool,
      match: b.match,
      value: value || undefined,
      decision,
      createdBy: typeof b.createdBy === 'string' ? b.createdBy : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Matching — pure
// ---------------------------------------------------------------------------

export interface RuleSubject {
  tool: string;
  args: Record<string, unknown>;
  /** The session's project root; relative paths resolve against it. */
  root: string;
}

export interface RuleVerdict {
  decision: ApprovalRuleDecision;
  rule: ApprovalRule;
}

/**
 * Absolute or home-relative path tokens in a segment, with `~` expanded —
 * `isWriteOutsideRoot` would otherwise resolve `~/.ssh/x` *under* the
 * project root and call it inside.
 */
function absolutePathTokens(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
    .filter((t) => t.startsWith('/') || t.startsWith('~'))
    .map((t) => (t.startsWith('~') ? resolve(homedir(), t.slice(1).replace(/^\//, '')) : t));
}

function segmentHasPrefix(segment: string, prefix: string): boolean {
  if (segment === prefix) return true;
  if (!segment.startsWith(prefix)) return false;
  // Word boundary: `git status` must not cover `git statusx`, and `ls` must
  // not cover `lsblk`.
  const next = segment.charAt(prefix.length);
  return next === ' ' || next === '\t';
}

function toolMatches(rule: ApprovalRule, tool: string): boolean {
  return rule.tool === '*' || rule.tool.toLowerCase() === tool.toLowerCase();
}

/** Does this rule speak to this segment of a shell command? */
function coversSegment(rule: ApprovalRule, segment: string, root: string): boolean {
  if (rule.match === 'command_prefix') {
    if (!rule.value || !segmentHasPrefix(segment, rule.value)) return false;
    // An allowed `cat` is not an allowed `cat /etc/hostname`.
    return rule.decision === 'deny' || absolutePathTokens(segment).every((t) => !isWriteOutsideRoot(t, root));
  }
  if (rule.match === 'command_regex') {
    if (!rule.value) return false;
    try {
      return new RegExp(rule.value).test(segment);
    } catch {
      return false;
    }
  }
  return false;
}

function matchesOne(rule: ApprovalRule, subject: RuleSubject): boolean {
  const tool = subject.tool.toLowerCase();
  if (!toolMatches(rule, subject.tool)) return false;
  switch (rule.match) {
    case 'readonly_tool':
      return READONLY_TOOLS.has(tool);
    case 'write_inside_root': {
      if (!WRITE_TOOLS.has(tool)) return false;
      const p = subject.args.file_path;
      if (typeof p !== 'string' || !p) return false;
      return !isWriteOutsideRoot(p, subject.root);
    }
    case 'command_prefix':
    case 'command_regex': {
      if (!SHELL_TOOLS.has(tool)) return false;
      const command = subject.args.command;
      if (typeof command !== 'string' || !command.trim()) return false;
      // Used for deny rules: one segment is enough.
      return shellSegments(command).some((seg) => coversSegment(rule, seg, subject.root));
    }
  }
}

/**
 * Decide a subject against a set of rules. Deny rules win. For a shell
 * command, an allow needs **every segment** covered by some allow rule —
 * `ls && git push --force` is not "an `ls`", while `git add -A && git commit`
 * is allowed when both prefixes are. The verdict names the rule that covered
 * the first segment.
 */
export function evaluateRules(rules: readonly ApprovalRule[], subject: RuleSubject): RuleVerdict | null {
  const live = rules.filter((r) => r.enabled);
  for (const rule of live) {
    if (rule.decision === 'deny' && matchesOne(rule, subject)) return { decision: 'deny', rule };
  }
  const allows = live.filter((r) => r.decision === 'allow' && toolMatches(r, subject.tool));
  const tool = subject.tool.toLowerCase();
  if (SHELL_TOOLS.has(tool)) {
    const command = subject.args.command;
    if (typeof command !== 'string' || !command.trim()) return null;
    const segments = shellSegments(command);
    if (segments.length === 0) return null;
    let first: ApprovalRule | null = null;
    for (const seg of segments) {
      const covering = allows.find((r) => coversSegment(r, seg, subject.root));
      if (!covering) return null;
      first ??= covering;
    }
    return first ? { decision: 'allow', rule: first } : null;
  }
  for (const rule of allows) {
    if (matchesOne(rule, subject)) return { decision: 'allow', rule };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string;
  scope: 'global' | 'project';
  project_id: string | null;
  tool: string;
  match: ApprovalRuleMatch;
  value: string | null;
  decision: ApprovalRuleDecision;
  enabled: number;
  hits: number;
  created_at: number;
  created_by: string | null;
}

function rowToRule(r: RuleRow): ApprovalRule {
  return {
    id: r.id,
    scope: r.scope,
    projectId: r.project_id ?? undefined,
    tool: r.tool,
    match: r.match,
    value: r.value ?? undefined,
    decision: r.decision,
    enabled: r.enabled === 1,
    hits: r.hits,
    createdAt: r.created_at,
    createdBy: r.created_by ?? undefined,
  };
}

export function listRules(db: DB, opts: { projectId?: string } = {}): ApprovalRule[] {
  const rows = opts.projectId
    ? (db
        .prepare(
          `SELECT * FROM approval_rules WHERE scope = 'global' OR project_id = ? ORDER BY created_at ASC`,
        )
        .all(opts.projectId) as RuleRow[])
    : (db.prepare('SELECT * FROM approval_rules ORDER BY created_at ASC').all() as RuleRow[]);
  return rows.map(rowToRule);
}

export function getRule(db: DB, id: string): ApprovalRule | null {
  const row = db.prepare('SELECT * FROM approval_rules WHERE id = ?').get(id) as RuleRow | undefined;
  return row ? rowToRule(row) : null;
}

/** An identical rule already present (same scope, project, tool, match, value, decision). */
export function findSameRule(db: DB, input: ApprovalRuleInput): ApprovalRule | null {
  const row = db
    .prepare(
      `SELECT * FROM approval_rules
       WHERE scope = ? AND COALESCE(project_id, '') = ? AND tool = ? AND match = ?
         AND COALESCE(value, '') = ? AND decision = ?`,
    )
    .get(
      input.scope,
      input.projectId ?? '',
      input.tool,
      input.match,
      input.value ?? '',
      input.decision,
    ) as RuleRow | undefined;
  return row ? rowToRule(row) : null;
}

export function createRule(db: DB, input: ApprovalRuleInput): ApprovalRule {
  const existing = findSameRule(db, input);
  if (existing) return existing;
  const id = nanoid(10);
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO approval_rules (id, scope, project_id, tool, match, value, decision, enabled, hits, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
  ).run(
    id,
    input.scope,
    input.projectId ?? null,
    input.tool,
    input.match,
    input.value ?? null,
    input.decision,
    createdAt,
    input.createdBy ?? null,
  );
  return getRule(db, id)!;
}

export function setRuleEnabled(db: DB, id: string, enabled: boolean): ApprovalRule | null {
  db.prepare('UPDATE approval_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getRule(db, id);
}

export function deleteRule(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM approval_rules WHERE id = ?').run(id).changes > 0;
}

function bumpHits(db: DB, id: string): void {
  db.prepare('UPDATE approval_rules SET hits = hits + 1 WHERE id = ?').run(id);
}

/**
 * The one the router calls. Returns the verdict and records the hit, or
 * null when no rule speaks and a person must be asked.
 */
export function applyRules(
  db: DB,
  subject: RuleSubject & { projectId?: string },
): RuleVerdict | null {
  const verdict = evaluateRules(listRules(db, { projectId: subject.projectId }), subject);
  if (verdict) bumpHits(db, verdict.rule.id);
  return verdict;
}

// ---------------------------------------------------------------------------
// Defaults — opt-in, never installed silently
// ---------------------------------------------------------------------------

/**
 * Shell prefixes a default allow covers. Deliberately short and boring:
 * reading, listing, testing, committing, and running the project's own code
 * with `node`. Nothing here deletes, pushes, escalates, or fetches code from
 * the network (`curl`, `wget`, a bare `npx <anything>`).
 *
 * `node` is allowed in full, `node -e` included, on purpose: `node --test`
 * already executes whatever the agent wrote, so refusing `-e` would only
 * make it write the same code to a file first and ask again. The boundary
 * that holds is the project root, the denylist, and no network fetch — not
 * the spelling of the node invocation. Absolute paths outside the project
 * are still refused by the matcher, so `cat /etc/hostname` is not an
 * allowed `cat`.
 */
export const DEFAULT_ALLOW_PREFIXES: readonly string[] = [
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'od',
  'sort',
  'uniq',
  'diff',
  'tr',
  'cut',
  'basename',
  'dirname',
  'date',
  'which',
  'echo',
  'printf',
  'test',
  'true',
  'grep',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git add',
  'git commit',
  'git rev-parse',
  'git ls-files',
  'git branch',
  'node',
  'npm test',
  'npm run test',
  'pnpm test',
  'npx vitest run',
  'mkdir -p',
  'chmod +x',
];

export function defaultRuleInputs(projectId?: string): ApprovalRuleInput[] {
  const scope: ApprovalRuleScope = projectId ? 'project' : 'global';
  const base = { scope, projectId, decision: 'allow' as const, createdBy: 'defaults' };
  return [
    { ...base, tool: '*', match: 'readonly_tool' },
    { ...base, tool: '*', match: 'write_inside_root' },
    ...DEFAULT_ALLOW_PREFIXES.map((value) => ({ ...base, tool: 'Bash', match: 'command_prefix' as const, value })),
  ];
}

export function installDefaultRules(
  db: DB,
  projectId?: string,
): { installed: ApprovalRule[]; skipped: number } {
  const installed: ApprovalRule[] = [];
  let skipped = 0;
  for (const input of defaultRuleInputs(projectId)) {
    if (findSameRule(db, input)) {
      skipped += 1;
      continue;
    }
    installed.push(createRule(db, input));
  }
  return { installed, skipped };
}
