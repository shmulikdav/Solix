import { nanoid } from 'nanoid';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  ApprovalRule,
  ApprovalRuleDecision,
  ApprovalRuleInput,
  ApprovalRuleMatch,
  ApprovalRuleScope,
} from '@solix/shared';
import type { DB } from '../db.js';
import { deniedCommandReason, isWriteOutsideRoot } from '../containment.js';
import {
  READONLY_TOOLS,
  SHELL_TOOLS,
  WRITE_TOOLS,
  describeRule,
  shellSegments,
  suggestRuleFor,
  SUBSTITUTION_PLACEHOLDER,
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
  /**
   * The session's own scratchpad directory, if known. Treated as inside the
   * worker's confinement for shell-coverage, so an agent's scratch commands
   * (`S=<scratchpad>; mkdir -p $S`, `cd <scratchpad> && node s.js`) are
   * auto-decided rather than held one by one — while every other outside-root
   * path stays held and the command denylist is untouched. See
   * `scratchpadDirFor`. (`CLAIM-SCRATCHPAD-COVERED`)
   */
  scratchpad?: string;
  /**
   * The directory the call runs in, when the hook reports it. Relative paths
   * (`../../x`) resolve against it; it defaults to `root`.
   */
  cwd?: string;
}

export interface RuleVerdict {
  decision: ApprovalRuleDecision;
  rule: ApprovalRule;
}

/**
 * A shell redirection operator, wherever it sits in a word: `>`, `>>`, `>|`,
 * `<`, `<<<`, with an optional fd number or `&` in front (`2>`, `&>`) and an
 * optional `&` after (`>&`). Splitting on it is what makes the target of
 * `echo x >/etc/y` visible as a path.
 */
const REDIRECT = /(?:\d*|&)?(?:>>|>\||<<<|>|<)&?/;

/**
 * Special files a redirect commonly names that are not a place to write or
 * read anything: discarding output (`>/dev/null`) and the standard streams.
 */
const HARMLESS_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin']);

/** What `shellSegments` leaves where a `$( … )` or `<( … )` was lifted out. */
const SUBST_TOKEN = SUBSTITUTION_PLACEHOLDER;

/** What a path check needs to know about the call. */
interface PathCtx {
  root: string;
  scratchpad?: string;
  /** Where relative paths resolve from. */
  cwd: string;
  /** Variables assigned in this same command: name → value, or null when unknowable. */
  vars: Map<string, string | null>;
}

function pathCtx(subject: RuleSubject): PathCtx {
  const command = typeof subject.args.command === 'string' ? subject.args.command : '';
  const cwd = subject.cwd ?? subject.root;
  return { root: subject.root, scratchpad: subject.scratchpad, cwd, vars: assignmentsIn(command, subject.root, cwd) };
}

/**
 * The value of `$NAME`, as far as a static reading of one command can know it.
 * `null` means unknowable, and an unknowable path counts as outside the
 * project: a rule cannot vouch for a path it cannot read.
 */
function expandVar(name: string, ctx: Pick<PathCtx, 'cwd' | 'vars'>): string | null {
  if (ctx.vars.has(name)) return ctx.vars.get(name) ?? null;
  if (name === 'HOME' || name === 'USERPROFILE') return homedir();
  if (name === 'PWD') return ctx.cwd;
  if (name === 'TMPDIR') return tmpdir();
  return null;
}

/** `S=/x`, `F="$HOME/a"` … assigned anywhere in the command, in order. */
function assignmentsIn(command: string, root: string, cwd: string): Map<string, string | null> {
  const vars = new Map<string, string | null>();
  const re = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g;
  for (const m of command.matchAll(re)) {
    const name = m[1]!;
    const raw = m[2] ?? '';
    if (/\$\(|`|<\(/.test(raw)) {
      vars.set(name, null); // a substitution's output cannot be known here
      continue;
    }
    const value = raw.replace(/^['"]|['"]$/g, '');
    vars.set(name, value === '' ? '' : resolvePiece(value, { root, cwd, vars } as PathCtx));
  }
  return vars;
}

/** One word-piece as an absolute path, or null when it cannot be known. */
function resolvePiece(piece: string, ctx: Pick<PathCtx, 'cwd' | 'vars'>): string | null {
  if (piece.startsWith('~')) return resolve(homedir(), piece.slice(1).replace(/^\//, ''));
  if (piece.startsWith('$')) {
    const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/.exec(piece);
    if (!m) return resolve(ctx.cwd, piece); // `$1`, `$?` … not a path root
    const base = expandVar(m[1]!, ctx);
    if (base === null) return null;
    return resolve(ctx.cwd, base, (m[2] ?? '').replace(/^\//, ''));
  }
  return resolve(ctx.cwd, piece);
}

/**
 * Every word-piece in a segment that could name a file, resolved to an
 * absolute path (or null when unknowable), with the text it came from.
 *
 * Measured on 2026-11-03 against 1.20.1's default rules: a path was only
 * recognised when a word began with `/` or `~`, so all of these were
 * auto-allowed: `cat $HOME/.ssh/id_ed25519`, `cat ${HOME}/.aws/credentials`,
 * `cat ../../.ssh/id_ed25519`, `echo x > ../../.bashrc`,
 * `git log --output=/etc/x`. Now:
 *
 * - every piece is resolved against the call's directory, so `..` that leaves
 *   the project is outside it;
 * - `$HOME`, `${HOME}`, `$PWD`, `$TMPDIR` and variables assigned earlier in
 *   the same command are expanded; any other variable is unknowable, and an
 *   unknowable path is outside;
 * - redirect targets (`>/x`, `2>/x`), option values (`--output=/x`, `-o/x`)
 *   and assignment values (`F=/x`) are pieces of their own.
 *
 * Arguments to `echo` and `printf` are printed, never opened, so only their
 * redirect targets are paths. (`CLAIM-RULES-SEE-REDIRECTS`,
 * `CLAIM-RULES-SEE-EVERY-PATH`)
 */
function pathCandidates(segment: string, ctx: PathCtx): Array<{ token: string; path: string | null }> {
  const printsOnly = /^(echo|printf)(\s|$)/.test(segment);
  const out: Array<{ token: string; path: string | null }> = [];
  // `> ../../x` → `>../../x`: a spaced redirect target stays attached to its
  // operator, so it is judged as a target even after `echo`.
  const glued = segment.replace(/((?:\d*|&)?(?:>>|>\||<<<|>|<)&?)\s+/g, '$1');
  for (const word of glued.split(/\s+/)) {
    const parts = word.replace(/['"]/g, '').split(REDIRECT);
    parts.forEach((part, i) => {
      if (printsOnly && i === 0) return; // an argument to echo/printf, not a redirect target
      for (let piece of part.split('=')) {
        if (piece.startsWith('-')) {
          // `-o/etc/x`, `--log-file=~/x` (after the `=` split): the path part.
          const at = /[/~$.]/.exec(piece);
          if (!at) continue;
          piece = piece.slice(at.index);
        }
        if (!piece || HARMLESS_DEVICES.has(piece) || piece === SUBST_TOKEN) continue;
        out.push({ token: piece, path: resolvePiece(piece, ctx) });
      }
    });
  }
  return out;
}

/** The nearest existing ancestor's real path, with the rest appended. */
function realPathOf(p: string): string {
  let dir = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return rest.length ? join(realpathSync(dir), ...rest.reverse()) : realpathSync(dir);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return p;
      rest.push(basename(dir));
      dir = parent;
    }
  }
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

/**
 * Is this path outside the worker's confinement — outside the project root
 * AND outside the session scratchpad? That is the boundary an allow rule
 * refuses to cross: an allowed `cat` is not an allowed `cat /etc/hostname`,
 * but it *is* an allowed `cat <scratchpad>/notes`.
 *
 * Checked twice: as written, and with symlinks resolved, so a link inside the
 * project that points out of it (`ln -s ~/.ssh keys`, then `cat keys/id`) is
 * outside too. An unknowable path (`null`) is outside.
 */
function isOutsideConfinement(path: string | null, root: string, scratchpad?: string): boolean {
  if (path === null) return true;
  const inside = (p: string, r: string, s?: string) =>
    !isWriteOutsideRoot(p, r) || (s !== undefined && !isWriteOutsideRoot(p, s));
  if (!inside(path, root, scratchpad)) return true;
  const real = realPathOf(path);
  if (real === path) return false;
  return !inside(real, realPathOf(root), scratchpad === undefined ? undefined : realPathOf(scratchpad));
}

/**
 * A pure leading shell-variable assignment (`S=/tmp/x`, or several), with no
 * command after it. It executes nothing, so it never blocks an otherwise
 * covered compound command — provided its own path tokens are within
 * confinement (`S=<scratchpad>` yes, `S=/etc/x` no). A dangerous value like
 * `S=$(rm -rf /)` is not reached here: `shellSegments` lifts the `$( … )` out
 * as its own segment, which must be covered on its own (and the floor
 * denylists it).
 */
function isBenignAssignment(segment: string, ctx: PathCtx): boolean {
  const toks = segment.trim().split(/\s+/);
  if (toks.length === 0) return false;
  for (const tok of toks) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) return false; // a command followed — not a pure assignment
  }
  // Values (`S=/etc/x`) and redirect targets (`S=x>/etc/y`) are pieces of
  // their own, so both are judged as paths here.
  return outsidePaths(segment, ctx).length === 0;
}

/**
 * Redirects that only send output to another stream or discard it — `2>&1`,
 * `>&2`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`, `>&-`. They change where
 * output goes, not what the command does.
 */
const OUTPUT_ONLY_REDIRECT = /(?:^|\s)(?:\d*|&)?>>?\|?\s*(?:&\d+|&-|\/dev\/(?:null|stdout|stderr))(?=\s|$)/g;

/**
 * The segment with its output-only redirects removed, so a rule is matched
 * against the command itself. Measured on 2026-11-03: a policy rule
 * `^npm (pack|publish) --dry-run$` refused `npm publish --dry-run 2>&1`,
 * because the agent added `2>&1` and the `$` no longer matched — a prefix rule
 * shrugged that off, a regex rule could not.
 */
export function withoutOutputRedirects(segment: string): string {
  return segment.replace(OUTPUT_ONLY_REDIRECT, '').replace(/\s+/g, ' ').trim();
}

/** The pieces of a segment that name a path outside the worker's confinement. */
function outsidePaths(segment: string, ctx: PathCtx): string[] {
  return pathCandidates(segment, ctx)
    .filter((c) => isOutsideConfinement(c.path, ctx.root, ctx.scratchpad))
    .map((c) => c.token);
}

/** Does this rule's pattern match the segment, ignoring output-only redirects? */
function patternMatches(rule: ApprovalRule, segment: string): boolean {
  if (!rule.value) return false;
  const bare = withoutOutputRedirects(segment);
  if (rule.match === 'command_prefix') {
    return segmentHasPrefix(segment, rule.value) || segmentHasPrefix(bare, rule.value);
  }
  if (rule.match === 'command_regex') {
    try {
      const re = new RegExp(rule.value);
      return re.test(segment) || re.test(bare);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The places a read-only tool call reads: `Read`'s `file_path`, `Grep`'s and
 * `Glob`'s `path`, and the fixed part of a `Glob` pattern that leaves the
 * directory (`/Users/x/.aws/*`, `../../**`). With none of them, the call
 * reads where it runs.
 *
 * Measured on 2026-11-03: the default read-only rule allowed
 * `Read ~/.ssh/id_ed25519`, `Read /etc/passwd`, `Grep` over the whole home
 * directory and `Glob /Users/x/.aws/*` — it never looked at a path. A Solix
 * allow is a real allow: it answers the hook, so Claude Code does not ask.
 * (`CLAIM-READS-CONFINED`)
 */
function readTargets(subject: RuleSubject): Array<string | null> {
  const ctx = pathCtx(subject);
  const targets: Array<string | null> = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = subject.args[key];
    if (typeof v === 'string' && v.trim()) targets.push(resolvePiece(v.trim(), ctx));
  }
  const pattern = subject.args.pattern;
  if (subject.tool.toLowerCase() === 'glob' && typeof pattern === 'string') {
    const fixed = pattern.split(/[*?[{]/)[0] ?? '';
    if (/^[/~$]|(^|\/)\.\.(\/|$)/.test(fixed)) targets.push(resolvePiece(fixed || '.', ctx));
  }
  return targets.length > 0 ? targets : [ctx.cwd];
}

/**
 * Does this rule speak to this segment of a shell command?
 *
 * An **allow** rule — prefix or regex — never covers a segment that names a
 * path outside the project: an allowed `cat` is not an allowed
 * `cat /etc/hostname` (it *is* an allowed `cat <scratchpad>/x`). Regex allow
 * rules used to skip that check, so `^cat ` covered `cat ~/.ssh/id_ed25519`
 * and `^echo` covered `echo x >/etc/y`. (`CLAIM-ALLOW-RULES-CONFINED`)
 * A **deny** rule matches wherever it applies.
 */
function coversSegment(rule: ApprovalRule, segment: string, ctx: PathCtx): boolean {
  if (rule.match !== 'command_prefix' && rule.match !== 'command_regex') return false;
  if (!patternMatches(rule, segment)) return false;
  return rule.decision === 'deny' || outsidePaths(segment, ctx).length === 0;
}

function matchesOne(rule: ApprovalRule, subject: RuleSubject): boolean {
  const tool = subject.tool.toLowerCase();
  if (!toolMatches(rule, subject.tool)) return false;
  switch (rule.match) {
    case 'readonly_tool':
      if (!READONLY_TOOLS.has(tool)) return false;
      // A deny rule refuses every read; an allow rule only reads inside.
      return rule.decision === 'deny' || readTargets(subject).every((p) => !isOutsideConfinement(p, subject.root, subject.scratchpad));
    case 'write_inside_root': {
      if (!WRITE_TOOLS.has(tool)) return false;
      const p = subject.args.file_path;
      if (typeof p !== 'string' || !p) return false;
      // Resolved from the call's directory and through symlinks, like a
      // shell path; the scratchpad is not "inside the root" for this rule.
      return !isOutsideConfinement(resolvePiece(p, pathCtx(subject)), subject.root);
    }
    case 'command_prefix':
    case 'command_regex': {
      if (!SHELL_TOOLS.has(tool)) return false;
      const command = subject.args.command;
      if (typeof command !== 'string' || !command.trim()) return false;
      // Used for deny rules: one segment is enough.
      const ctx = pathCtx(subject);
      return shellSegments(command).some((seg) => coversSegment(rule, seg, ctx));
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
    const ctx = pathCtx(subject);
    let first: ApprovalRule | null = null;
    for (const seg of segments) {
      const covering = allows.find((r) => coversSegment(r, seg, ctx));
      if (covering) {
        first ??= covering;
        continue;
      }
      // A pure variable assignment runs nothing, so it does not block an
      // otherwise-covered command (but it names no rule, so a command that is
      // ONLY assignments still falls through to a person).
      if (isBenignAssignment(seg, ctx)) continue;
      return null;
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

// ---------------------------------------------------------------------------
// Explaining a decision — what `solix rules test` prints
// ---------------------------------------------------------------------------

export interface SegmentExplanation {
  segment: string;
  /** The rule that covers this segment, if one does. */
  coveredBy?: ApprovalRule;
  /** A pure variable assignment, which never blocks a covered command. */
  assignment?: boolean;
  /** Paths outside the project that kept an allow rule from covering it. */
  outside: string[];
  /** Allow rules whose pattern matched but were kept out by `outside`. */
  matchedButOutside: ApprovalRule[];
}

export interface RuleExplanation {
  /** The containment denylist's reason, when it refuses — before any rule. */
  denylisted: string | null;
  /** Exactly what the gate decides by rule: `evaluateRules`, nothing else. */
  verdict: RuleVerdict | null;
  /** Shell commands only: how each segment fared. */
  segments: SegmentExplanation[];
}

/**
 * Why a call would be allowed, refused or left to a person.
 *
 * The verdict is `evaluateRules` itself, not a re-derivation, so `solix rules
 * test` cannot disagree with the gate (`CLAIM-RULES-TEST-IS-THE-GATE`). The
 * per-segment detail is only there to say *which* part was not covered —
 * the question that took three agent runs to answer by hand on 2026-11-03.
 */
export function explainRules(rules: readonly ApprovalRule[], subject: RuleSubject): RuleExplanation {
  const command = typeof subject.args.command === 'string' ? subject.args.command : undefined;
  const tool = subject.tool.toLowerCase();
  const denylisted = command && SHELL_TOOLS.has(tool) ? deniedCommandReason(command) : null;
  const verdict = evaluateRules(rules, subject);
  const segments: SegmentExplanation[] = [];
  if (command && SHELL_TOOLS.has(tool)) {
    const allows = rules.filter((r) => r.enabled && r.decision === 'allow' && toolMatches(r, subject.tool));
    const ctx = pathCtx(subject);
    for (const segment of shellSegments(command)) {
      const outside = outsidePaths(segment, ctx);
      const coveredBy = allows.find((r) => coversSegment(r, segment, ctx));
      const matchedButOutside = coveredBy
        ? []
        : allows.filter(
            (r) => (r.match === 'command_prefix' || r.match === 'command_regex') && patternMatches(r, segment),
          );
      const assignment = !coveredBy && isBenignAssignment(segment, ctx);
      segments.push({ segment, coveredBy, assignment: assignment || undefined, outside, matchedButOutside });
    }
  }
  return { denylisted, verdict, segments };
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
  'cd',
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
