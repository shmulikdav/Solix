import { resolve } from 'node:path';
import { SUBSTITUTION_PLACEHOLDER, type ApprovalRule, type ApprovalRuleInput } from '@solix/shared';
import { getDb } from '@solix/server/db';
import { listProjects } from '@solix/server/projects';
import { describeRule, explainRules, listRules, type RuleExplanation } from '@solix/server/rules';
import { loadPolicy } from './gate.js';

/**
 * `solix rules test` — would the gate allow this, and if not, which part?
 *
 *   solix rules test "npm publish --dry-run 2>&1 | tail -80"
 *   solix rules test --rules .solix/policy.json "cat package.json | head -60"
 *   solix rules test --rules defaults --file /etc/hosts
 *
 * Without `--rules` it reads the rules in force on this machine (global, plus
 * the project of `--cwd`), the ones the desk decides with. With `--rules` it
 * loads a policy exactly as `solix gate` does.
 *
 * Exit 0 when the rules allow the call, 1 when they do not (refused by a
 * rule, not covered, or blocked by the denylist), 2 for a policy that does
 * not load. So it can sit in CI next to the gate run it predicts.
 *
 * It exists because, on 2026-11-03, the only way to find out what a policy
 * would do was to run a real agent under it and read the refusal: three runs
 * to find a missing `head` and a `2>&1`. The verdict printed here is the
 * gate's own (`explainRules` → `evaluateRules`). (`CLAIM-RULES-TEST-IS-THE-GATE`)
 */
export interface RulesTestOptions {
  rules?: string;
  tool?: string;
  file?: string;
  cwd?: string;
}

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const OK = '\x1b[32m';
const RED = '\x1b[31m';
const AMBER = '\x1b[33m';

export const EXIT_ALLOWED = 0;
export const EXIT_NOT_ALLOWED = 1;
export const EXIT_BAD_POLICY = 2;

function asRules(inputs: ApprovalRuleInput[]): ApprovalRule[] {
  return inputs.map((r, i) => ({ ...r, id: `policy-${i}`, enabled: true, hits: 0, createdAt: 0 }));
}

/** The rules the desk decides with for this project: global, plus its own. */
function rulesInForce(root: string): ApprovalRule[] {
  const db = getDb();
  const project = listProjects(db).find((p) => resolve(p.cwd) === root);
  return project
    ? listRules(db, { projectId: project.id })
    : listRules(db).filter((r) => r.scope === 'global');
}

/** The lines `solix rules test` prints for one explained call. Pure. */
export function explanationLines(e: RuleExplanation, shown: string): { lines: string[]; code: number } {
  const lines: string[] = [`  ${BOLD}$ ${shown}${RESET}`, ''];

  if (e.denylisted) {
    lines.push(`  ${RED}BLOCKED by the denylist:${RESET} ${e.denylisted}.`);
    lines.push(`  ${DIM}The denylist runs before any rule, at every level, and no rule can allow this.${RESET}`);
    return { lines, code: EXIT_NOT_ALLOWED };
  }

  // Where a `$( … )` or `<( … )` was lifted out to be judged on its own.
  const shownSeg = (t: string) => t.split(SUBSTITUTION_PLACEHOLDER).join('( … )');
  const width = Math.min(48, Math.max(0, ...e.segments.map((s) => shownSeg(s.segment).length)));
  for (const s of e.segments) {
    const text = shownSeg(s.segment);
    const seg = text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
    if (s.coveredBy) {
      lines.push(`    ${OK}✓${RESET} ${seg}  ${DIM}${describeRule(s.coveredBy)}${RESET}`);
    } else if (s.assignment) {
      lines.push(`    ${DIM}·${RESET} ${seg}  ${DIM}a variable assignment — runs nothing${RESET}`);
    } else if (s.matchedButOutside.length > 0) {
      lines.push(
        `    ${RED}✗${RESET} ${seg}  ${describeRule(s.matchedButOutside[0]!)} matches, but ` +
          `${s.outside.join(', ')} is outside the project`,
      );
    } else {
      lines.push(`    ${RED}✗${RESET} ${seg}  no rule covers this`);
    }
  }
  if (e.segments.length > 0) lines.push('');

  const v = e.verdict;
  if (v?.decision === 'allow') {
    lines.push(`  ${OK}ALLOWED${RESET} by rule. Under \`solix gate\` it runs; at the desk nobody is asked.`);
    return { lines, code: EXIT_ALLOWED };
  }
  if (v?.decision === 'deny') {
    lines.push(`  ${RED}REFUSED${RESET} by rule: ${describeRule(v.rule)}.`);
    return { lines, code: EXIT_NOT_ALLOWED };
  }
  lines.push(
    `  ${AMBER}NOT COVERED.${RESET} Under \`solix gate\` it is refused at once; at the desk it waits for a person.`,
  );
  return { lines, code: EXIT_NOT_ALLOWED };
}

export function rulesTest(
  commandWords: string[],
  opts: RulesTestOptions,
  out: (line: string) => void = (l) => console.log(l),
): number {
  const root = resolve(opts.cwd ?? process.cwd());
  const command = commandWords.join(' ').trim();
  if (!command && !opts.file) {
    out('[solix] give a command to test, or --file <path> for a file tool');
    return EXIT_BAD_POLICY;
  }

  let rules: ApprovalRule[];
  let source: string;
  if (opts.rules) {
    const policy = loadPolicy(opts.rules);
    if (!policy.ok) {
      out(`[solix] policy rejected: ${policy.error}`);
      return EXIT_BAD_POLICY;
    }
    rules = asRules(policy.rules);
    source = opts.rules === 'defaults' ? 'the defaults' : opts.rules;
  } else {
    rules = rulesInForce(root);
    source = 'the rules in force on this machine';
  }

  const tool = opts.tool?.trim() || (opts.file ? 'Write' : 'Bash');
  const args: Record<string, unknown> = opts.file ? { file_path: opts.file } : { command };
  const shown = opts.file ? `${tool} ${opts.file}` : command;
  const e = explainRules(rules, { tool, args, root });

  out('');
  out(`  ${DIM}solix rules test · ${rules.length} rule${rules.length === 1 ? '' : 's'} from ${source} · project ${root}${RESET}`);
  out('');
  const { lines, code } = explanationLines(e, shown);
  for (const l of lines) out(l);
  out('');
  return code;
}
