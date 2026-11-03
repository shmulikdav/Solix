import type { ApprovalRule, ApprovalRuleInput } from './types.js';

/**
 * The parts of approval-rule matching that need no server: how a shell
 * command splits into the segments a shell would run, and which rule a
 * person most likely wants after approving a request by hand. The server's
 * matcher (`packages/server/src/state/rules.ts`) builds on these; the
 * Decisions card uses them to offer "always allow".
 */

/** A segment no rule can ever cover: how an unparseable command is refused. */
export const UNCOVERABLE = '__solix_uncoverable__';

const SUBST = '__solix_subst__';

/**
 * Split a shell command into the segments a shell would run.
 *
 * Three things a naive split got wrong on the first acceptance run, each
 * of which produced a hold a person then had to answer by hand:
 *
 * - **Quotes.** `node -e "a; b"` is one command, not two. Separators inside
 *   balanced quotes do not split. An *unbalanced* quote is a shell syntax
 *   error, and is reported as uncoverable so it is held rather than guessed.
 * - **Heredocs.** The body of `git commit -F - <<'EOF' … EOF` is data for
 *   `git commit`, not a list of commands. Body lines are dropped.
 * - **Substitution.** `echo "$(git push --force)"` *runs* `git push`. The
 *   contents of every `$( … )` and every backtick pair are lifted out as
 *   segments of their own that must be covered too, and the outer segment
 *   is judged with the substitution replaced by a placeholder. This closes a
 *   hole the naive split had, where any allowed prefix would have carried an
 *   arbitrary command behind it.
 *
 * Everything else errs towards *more* segments, which can only make an
 * allow harder to reach — never easier.
 */
export function shellSegments(command: string): string[] {
  const lifted: string[] = [];
  const outer = liftSubstitutions(stripHeredocBodies(command), lifted);
  if (outer === null) return [UNCOVERABLE];
  const parts = splitOutsideQuotes(outer);
  if (parts === null) return [UNCOVERABLE];
  const out: string[] = [];
  for (const raw of parts) {
    const seg = raw
      .replace(/^[({\s]+/, '')
      .replace(/[)}\s]+$/, '')
      // `FOO=1 ls` is judged as `ls`; `S=/tmp/x` on its own stays as is so a
      // path outside the project is still seen.
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    // An assignment whose whole value was a substitution: the substitution
    // itself has been lifted and will be judged on its own.
    if (seg === '' || /^[A-Za-z_][A-Za-z0-9_]*=\s*$/.test(seg.replace(SUBST, ''))) continue;
    if (seg === SUBST) continue;
    out.push(seg);
  }
  for (const inner of lifted) out.push(...shellSegments(inner));
  return out;
}

/** Drop the lines between `<<WORD` (or `<<-WORD`, quoted or not) and WORD. */
function stripHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) terminator = m[2]!;
  }
  return kept.join('\n');
}

/**
 * Replace every `$( … )` and every backtick pair with a placeholder, pushing
 * the inner text onto `lifted`. Returns null when the brackets or backticks
 * do not balance, which is a shell error and is not guessed at.
 */
function liftSubstitutions(command: string, lifted: string[]): string | null {
  let out = '';
  let i = 0;
  while (i < command.length) {
    if (command.startsWith('$(', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command.startsWith('$(', j)) {
          depth += 1;
          j += 2;
          continue;
        }
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') depth -= 1;
        j += 1;
      }
      if (depth !== 0) return null;
      lifted.push(command.slice(i + 2, j - 1));
      out += ` ${SUBST} `;
      i = j;
      continue;
    }
    if (command[i] === '`') {
      const j = command.indexOf('`', i + 1);
      if (j === -1) return null;
      lifted.push(command.slice(i + 1, j));
      out += ` ${SUBST} `;
      i = j + 1;
      continue;
    }
    out += command[i];
    i += 1;
  }
  return out;
}

/**
 * Split on `;`, `|`, `||`, `&&`, `&` and newlines that sit outside quotes.
 * A backslash inside double quotes or outside any quote escapes the next
 * character. Returns null on an unbalanced quote.
 */
function splitOutsideQuotes(command: string): string[] | null {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        cur += command[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      cur += ch + command[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    // `2>&1`, `&>file` and `<&3` are redirections, not a background `&`.
    if (ch === '&' && (cur.endsWith('>') || cur.endsWith('<') || command[i + 1] === '>')) {
      cur += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      parts.push(cur);
      cur = '';
      // `||` and `&&` are one separator; the second character is skipped.
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i += 1;
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur);
  return parts;
}

export const READONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'glob', 'grep']);
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'shell', 'run', 'exec_command']);

const TWO_WORD_COMMANDS = new Set(['git', 'npm', 'pnpm', 'npx', 'node', 'yarn', 'cargo', 'go', 'make', 'docker']);

/**
 * The rule a person most likely wants after approving this request by hand.
 * Read-only tools and in-project writes map to their matcher; a shell
 * command maps to its first one or two words (`git status`, `node --test`,
 * `ls`).
 */
export function suggestRuleFor(
  tool: string,
  args: Record<string, unknown>,
): Omit<ApprovalRuleInput, 'scope' | 'projectId'> | null {
  const t = tool.toLowerCase();
  if (READONLY_TOOLS.has(t)) return { tool: '*', match: 'readonly_tool', decision: 'allow' };
  if (WRITE_TOOLS.has(t)) return { tool: '*', match: 'write_inside_root', decision: 'allow' };
  if (SHELL_TOOLS.has(t) && typeof args.command === 'string') {
    const first = shellSegments(args.command)[0] ?? '';
    const words = first.split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const head = words[0]!;
    const prefix = TWO_WORD_COMMANDS.has(head) && words[1] ? `${head} ${words[1]}` : head;
    return { tool: 'Bash', match: 'command_prefix', value: prefix, decision: 'allow' };
  }
  return null;
}

/** One line a person can read on a card, in a list, or in the ledger. */
export function describeRule(
  rule: Pick<ApprovalRule, 'tool' | 'match' | 'value' | 'decision' | 'scope'>,
): string {
  const verb = rule.decision === 'allow' ? 'allow' : 'refuse';
  const where = rule.scope === 'project' ? ' in this project' : '';
  switch (rule.match) {
    case 'readonly_tool':
      return `${verb} read-only tools${where}`;
    case 'write_inside_root':
      return `${verb} ${rule.tool === '*' ? 'file writes' : rule.tool} inside the project${where}`;
    case 'command_prefix':
      return `${verb} shell commands starting with \`${rule.value}\`${where}`;
    case 'command_regex':
      return `${verb} shell commands matching /${rule.value}/${where}`;
  }
}
