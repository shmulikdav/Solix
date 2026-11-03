import { getDb } from '@solix/server/db';
import {
  createRule,
  deleteRule,
  describeRule,
  installDefaultRules,
  listRules,
  setRuleEnabled,
  DEFAULT_ALLOW_PREFIXES,
} from '@solix/server/rules';
import type { ApprovalRuleInput, ApprovalRuleMatch } from '@solix/shared';
import { ensureProject } from '@solix/server/projects';
import { resolve } from 'node:path';

/**
 * `solix rules` — a person's standing decisions at the gate.
 *
 * Measured on 1.18.3: a five-task plan at `standard` produced thirty holds
 * for thirty tool calls, `Read SPEC.md` included, and `solix ledger` printed
 * "approved 4 times — worth a rule rather than a decision" with no rule to
 * make. This is the rule to make.
 *
 *   solix rules                              list
 *   solix rules defaults [--project <dir>]   install the opt-in defaults
 *   solix rules add --prefix "git status" [--deny] [--tool Bash] [--project <dir>]
 *   solix rules add --regex "^npm (test|run test)"
 *   solix rules add --readonly               Read / Glob / Grep
 *   solix rules add --writes-inside-root     Write / Edit inside the project
 *   solix rules enable|disable|remove <id>
 *
 * Writes the database directly, like `solix level`; a running server sees the
 * change on the next call (the rule table is read per decision), and the UI
 * on its next fetch.
 */
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const OK = '\x1b[32m';
const RED = '\x1b[31m';

export interface RulesAddOptions {
  prefix?: string;
  regex?: string;
  readonly?: boolean;
  writesInsideRoot?: boolean;
  deny?: boolean;
  tool?: string;
  project?: string;
}

function projectIdFor(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  return ensureProject(getDb(), resolve(dir)).id;
}

export function rulesList(opts: { project?: string } = {}): void {
  const db = getDb();
  const rules = listRules(db, { projectId: projectIdFor(opts.project) });
  if (rules.length === 0) {
    console.log(
      `\n${DIM}  No rules. Every gated call is a decision for you.\n` +
        `  \`solix rules defaults\` installs a short, boring allow list — reading,\n` +
        `  listing, testing, committing — and nothing that deletes, pushes or\n` +
        `  escalates. The floor still runs first, whatever the rules say.${RESET}\n`,
    );
    return;
  }
  console.log(`\n${BOLD}Rules at the gate${RESET}\n`);
  for (const r of rules) {
    const mark = r.enabled ? (r.decision === 'allow' ? `${OK}✓${RESET}` : `${RED}✗${RESET}`) : `${DIM}○${RESET}`;
    const scope = r.scope === 'project' ? `${DIM}project${RESET}` : `${DIM}global ${RESET}`;
    console.log(`  ${mark} ${r.id.padEnd(11)} ${scope} ${describeRule(r)}  ${DIM}· ${r.hits} hit${r.hits === 1 ? '' : 's'}${RESET}`);
  }
  console.log(`\n${DIM}  ${rules.length} rule${rules.length === 1 ? '' : 's'}. The denylist is not a rule and no rule can override it.${RESET}\n`);
}

export function rulesDefaults(opts: { project?: string } = {}): void {
  const res = installDefaultRules(getDb(), projectIdFor(opts.project));
  const where = opts.project ? `for ${resolve(opts.project)}` : 'globally';
  console.log(
    `[solix] installed ${res.installed.length} default rule${res.installed.length === 1 ? '' : 's'} ${where}` +
      (res.skipped ? ` (${res.skipped} already present)` : ''),
  );
  console.log(
    `${DIM}        read-only tools, writes inside the project, the project's own code via node,\n        and these shell prefixes:\n` +
      `        ${DEFAULT_ALLOW_PREFIXES.join(', ')}${RESET}`,
  );
}

export function rulesAdd(opts: RulesAddOptions): void {
  const chosen = [opts.prefix !== undefined, opts.regex !== undefined, Boolean(opts.readonly), Boolean(opts.writesInsideRoot)].filter(Boolean).length;
  if (chosen !== 1) {
    console.error('[solix] pick exactly one of --prefix, --regex, --readonly, --writes-inside-root');
    process.exitCode = 1;
    return;
  }
  let match: ApprovalRuleMatch;
  let value: string | undefined;
  if (opts.prefix !== undefined) {
    match = 'command_prefix';
    value = opts.prefix.trim();
  } else if (opts.regex !== undefined) {
    match = 'command_regex';
    value = opts.regex;
    try {
      new RegExp(value);
    } catch {
      console.error('[solix] --regex is not a valid regular expression');
      process.exitCode = 1;
      return;
    }
  } else if (opts.readonly) {
    match = 'readonly_tool';
  } else {
    match = 'write_inside_root';
  }
  if ((match === 'command_prefix' || match === 'command_regex') && !value) {
    console.error('[solix] the value is empty');
    process.exitCode = 1;
    return;
  }
  const projectId = projectIdFor(opts.project);
  const input: ApprovalRuleInput = {
    scope: projectId ? 'project' : 'global',
    projectId,
    tool: opts.tool?.trim() || (match === 'command_prefix' || match === 'command_regex' ? 'Bash' : '*'),
    match,
    value,
    decision: opts.deny ? 'deny' : 'allow',
    createdBy: 'cli',
  };
  const rule = createRule(getDb(), input);
  console.log(`[solix] rule ${rule.id}: ${describeRule(rule)}`);
}

export function rulesSetEnabled(id: string, enabled: boolean): void {
  const rule = setRuleEnabled(getDb(), id, enabled);
  if (!rule) {
    console.error(`[solix] no rule ${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[solix] ${enabled ? 'enabled' : 'disabled'} ${rule.id}: ${describeRule(rule)}`);
}

export function rulesRemove(id: string): void {
  if (!deleteRule(getDb(), id)) {
    console.error(`[solix] no rule ${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[solix] removed rule ${id}`);
}
