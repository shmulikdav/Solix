import { describe, expect, it } from 'vitest';
import type { ApprovalRule } from '@solix/shared';
import {
  DEFAULT_ALLOW_PREFIXES,
  defaultRuleInputs,
  describeRule,
  evaluateRules,
  parseRuleInput,
  shellSegments,
  suggestRuleFor,
} from './rules.js';
import { UNCOVERABLE } from '@solix/shared';

/**
 * The matcher, with no database. Each case is a way an allow rule could end
 * up covering more than the person who wrote it meant.
 */
const ROOT = '/home/me/project';

let seq = 0;
function rule(over: Partial<ApprovalRule>): ApprovalRule {
  seq += 1;
  return {
    id: `r${seq}`,
    scope: 'global',
    tool: '*',
    match: 'readonly_tool',
    decision: 'allow',
    enabled: true,
    hits: 0,
    createdAt: 0,
    ...over,
  };
}

const prefix = (value: string, decision: 'allow' | 'deny' = 'allow') =>
  rule({ tool: 'Bash', match: 'command_prefix', value, decision });

const cmd = (command: string) => ({ tool: 'Bash', args: { command }, root: ROOT });

describe('shellSegments', () => {
  it('splits on the separators a shell would', () => {
    expect(shellSegments('ls -la && git status; echo done | wc -l')).toEqual([
      'ls -la',
      'git status',
      'echo done',
      'wc -l',
    ]);
  });

  it('judges a subshell or an env assignment by the command it runs', () => {
    expect(shellSegments('(cd src && ls)')).toEqual(['cd src', 'ls']);
    expect(shellSegments('FOO=1 BAR=2 ls')).toEqual(['ls']);
  });

  it('does not split inside balanced quotes', () => {
    expect(shellSegments('echo "a && b"')).toEqual(['echo "a && b"']);
    expect(shellSegments(`node -e "const p = 1; console.log(p)"`)).toEqual([`node -e "const p = 1; console.log(p)"`]);
  });

  /** An unbalanced quote is a shell error; it is refused, not guessed at. */
  it('marks an unbalanced quote as uncoverable', () => {
    expect(shellSegments('ls "; rm -rf /')).toEqual([UNCOVERABLE]);
  });

  it('drops a heredoc body, which is data for the command that reads it', () => {
    expect(shellSegments("git commit -F - <<'EOF'\nmsg line\nEOF\necho done")).toEqual(['git commit -F - <<\'EOF\'', 'echo done']);
  });

  /** `echo "$(git push)"` runs git push. The inside is a segment of its own. */
  it('lifts command substitutions out as segments that must be covered too', () => {
    expect(shellSegments('echo "$(git push --force)"')).toEqual(['echo " __solix_subst__ "', 'git push --force']);
    expect(shellSegments('out=$(printf "a" | node bin/tally.js); echo "[$out]"')).toEqual(['echo "[$out]"', 'printf "a"', 'node bin/tally.js']);
    expect(shellSegments('echo `id`')).toEqual(['echo __solix_subst__', 'id']);
  });
});

describe('command_prefix', () => {
  it('allows a command that starts with the prefix at a word boundary', () => {
    expect(evaluateRules([prefix('git status')], cmd('git status --short'))?.decision).toBe('allow');
    expect(evaluateRules([prefix('ls')], cmd('ls -la'))?.decision).toBe('allow');
  });

  it('does not treat lsblk as an ls, nor git statusx as git status', () => {
    expect(evaluateRules([prefix('ls')], cmd('lsblk'))).toBeNull();
    expect(evaluateRules([prefix('git status')], cmd('git statusx'))).toBeNull();
  });

  /** A compound command is covered only when every segment is. */
  it('requires every segment of a compound command to be covered', () => {
    expect(evaluateRules([prefix('ls')], cmd('ls && git push --force'))).toBeNull();
    expect(evaluateRules([prefix('ls')], cmd('ls; rm -rf build'))).toBeNull();
    expect(evaluateRules([prefix('ls')], cmd('ls | grep x'))).toBeNull();
    // …and is covered once every segment has a rule of its own.
    expect(evaluateRules([prefix('ls'), prefix('grep')], cmd('ls | grep x'))?.decision).toBe('allow');
  });

  it('does not let an allowed cat read outside the project', () => {
    expect(evaluateRules([prefix('cat')], cmd('cat README.md'))?.decision).toBe('allow');
    expect(evaluateRules([prefix('cat')], cmd(`cat ${ROOT}/src/index.ts`))?.decision).toBe('allow');
    expect(evaluateRules([prefix('cat')], cmd('cat /etc/hostname'))).toBeNull();
    expect(evaluateRules([prefix('cat')], cmd('cat ~/.config/secret'))).toBeNull();
    expect(evaluateRules([prefix('cat')], cmd('cat "/etc/hostname"'))).toBeNull();
  });

  /** The hole the naive splitter had: an allowed prefix carrying any command behind it. */
  it('does not let a substitution smuggle a command past an allowed prefix', () => {
    expect(evaluateRules([prefix('echo')], cmd('echo "$(git push --force)"'))).toBeNull();
    expect(evaluateRules([prefix('echo')], cmd('echo `git push --force`'))).toBeNull();
    expect(evaluateRules([prefix('echo'), prefix('git status')], cmd('echo "$(git status)"'))?.decision).toBe('allow');
  });

  it('judges a quoted script as one command', () => {
    expect(evaluateRules([prefix('node')], cmd(`node -e "const p = require('./x'); console.log(p)"`))?.decision).toBe('allow');
    expect(evaluateRules([prefix('ls')], cmd('ls "; rm -rf /'))).toBeNull();
  });

  it('allows the var=$(cmd) idiom when the inner command is allowed', () => {
    expect(evaluateRules([prefix('printf'), prefix('node'), prefix('echo')], cmd('out=$(printf "a" | node bin/tally.js); echo "[$out]"'))?.decision).toBe('allow');
  });

  it('lets a deny rule fire on any one segment', () => {
    const rules = [prefix('ls'), prefix('git push', 'deny')];
    expect(evaluateRules(rules, cmd('ls && git push'))?.decision).toBe('deny');
  });

  it('only applies to shell tools', () => {
    expect(evaluateRules([prefix('ls')], { tool: 'Read', args: { file_path: 'ls' }, root: ROOT })).toBeNull();
  });
});

describe('readonly_tool and write_inside_root', () => {
  it('covers Read, Glob and Grep and nothing else', () => {
    const r = [rule({ match: 'readonly_tool' })];
    for (const tool of ['Read', 'Glob', 'Grep']) {
      expect(evaluateRules(r, { tool, args: {}, root: ROOT })?.decision).toBe('allow');
    }
    expect(evaluateRules(r, { tool: 'Write', args: { file_path: `${ROOT}/a` }, root: ROOT })).toBeNull();
    expect(evaluateRules(r, cmd('ls'))).toBeNull();
  });

  it('covers a write inside the project and refuses to cover one outside', () => {
    const r = [rule({ match: 'write_inside_root' })];
    expect(evaluateRules(r, { tool: 'Write', args: { file_path: `${ROOT}/src/a.ts` }, root: ROOT })?.decision).toBe('allow');
    expect(evaluateRules(r, { tool: 'Edit', args: { file_path: `${ROOT}/../other/a.ts` }, root: ROOT })).toBeNull();
    expect(evaluateRules(r, { tool: 'Write', args: { file_path: '/etc/hosts' }, root: ROOT })).toBeNull();
    expect(evaluateRules(r, { tool: 'Write', args: {}, root: ROOT })).toBeNull();
  });
});

describe('precedence and state', () => {
  it('a deny rule beats an allow rule', () => {
    const r = [rule({ match: 'readonly_tool', decision: 'allow' }), rule({ match: 'readonly_tool', decision: 'deny' })];
    expect(evaluateRules(r, { tool: 'Read', args: {}, root: ROOT })?.decision).toBe('deny');
  });

  it('a disabled rule is not consulted', () => {
    expect(evaluateRules([rule({ match: 'readonly_tool', enabled: false })], { tool: 'Read', args: {}, root: ROOT })).toBeNull();
  });

  it('a rule for one tool does not answer for another', () => {
    expect(evaluateRules([rule({ tool: 'Read', match: 'readonly_tool' })], { tool: 'Grep', args: {}, root: ROOT })).toBeNull();
  });

  it('a regex rule applies to the whole command', () => {
    const r = [rule({ tool: 'Bash', match: 'command_regex', value: '^npm (test|run test)', decision: 'allow' })];
    expect(evaluateRules(r, cmd('npm test'))?.decision).toBe('allow');
    expect(evaluateRules(r, cmd('npm publish'))).toBeNull();
  });
});

describe('the defaults', () => {
  it('contain nothing that deletes, pushes, escalates, downloads or evaluates code', () => {
    const forbidden = /\brm\b|push|sudo|curl|wget|\beval\b|chmod -R|\bdd\b|^npx$/;
    for (const p of DEFAULT_ALLOW_PREFIXES) expect(p).not.toMatch(forbidden);
  });

  it('are project-scoped when a project is given, global otherwise', () => {
    expect(new Set(defaultRuleInputs('p1').map((r) => r.scope))).toEqual(new Set(['project']));
    expect(new Set(defaultRuleInputs().map((r) => r.scope))).toEqual(new Set(['global']));
  });

  /** The tally plan's thirty holds, replayed against the defaults. */
  it('cover the ordinary commands a worker issues and not the ones that need a person', () => {
    const rules = defaultRuleInputs().map((i, n) => ({ ...i, id: `d${n}`, enabled: true, hits: 0, createdAt: 0 }));
    const allowed = [
      cmd('ls -la /home/me/project; node --version'),
      cmd('node --test 2>&1 | tail -12'),
      cmd('git add -A && git commit -q -m "Implement tally"'),
      cmd('chmod +x bin/tally.js && test -x bin/tally.js'),
      cmd("printf 'a b\\nc' | node bin/tally.js | od -c"),
      cmd('node -e "import(\'./src/count.js\').then(m => console.log(m.count(\'a b\')))"'),
      { tool: 'Read', args: { file_path: `${ROOT}/SPEC.md` }, root: ROOT },
      { tool: 'Write', args: { file_path: `${ROOT}/src/count.js` }, root: ROOT },
    ];
    for (const s of allowed) expect(evaluateRules(rules, s)?.decision, JSON.stringify(s.args)).toBe('allow');
    const held = [
      cmd('git rm -r canary'),
      cmd('npx some-package'),
      cmd('cat ~/.config/secret'),
      cmd('ls && git push --force'),
      cmd('git push origin main'),
    ];
    for (const s of held) expect(evaluateRules(rules, s), JSON.stringify(s.args)).toBeNull();
  });
});

describe('suggestRuleFor', () => {
  it('maps a request to the rule a person probably wants', () => {
    expect(suggestRuleFor('Read', { file_path: 'x' })).toMatchObject({ match: 'readonly_tool' });
    expect(suggestRuleFor('Edit', { file_path: 'x' })).toMatchObject({ match: 'write_inside_root' });
    expect(suggestRuleFor('Bash', { command: 'git status --short && ls' })).toMatchObject({ match: 'command_prefix', value: 'git status' });
    expect(suggestRuleFor('Bash', { command: 'ls -la' })).toMatchObject({ value: 'ls' });
    expect(suggestRuleFor('Bash', { command: '' })).toBeNull();
    expect(suggestRuleFor('WebFetch', { url: 'x' })).toBeNull();
  });
});

describe('parseRuleInput', () => {
  it('accepts a well-formed rule and fills the defaults', () => {
    const r = parseRuleInput({ match: 'command_prefix', value: 'git status' });
    expect(r).toMatchObject({ ok: true, input: { scope: 'global', tool: '*', decision: 'allow', value: 'git status' } });
  });

  it('refuses what it cannot evaluate', () => {
    expect(parseRuleInput(null)).toMatchObject({ ok: false });
    expect(parseRuleInput({ match: 'nope' })).toMatchObject({ ok: false });
    expect(parseRuleInput({ match: 'command_prefix' })).toMatchObject({ ok: false, error: expect.stringContaining('value') });
    expect(parseRuleInput({ match: 'command_regex', value: '(' })).toMatchObject({ ok: false, error: expect.stringContaining('regular expression') });
    expect(parseRuleInput({ scope: 'project', match: 'readonly_tool' })).toMatchObject({ ok: false, error: expect.stringContaining('projectId') });
    expect(parseRuleInput({ match: 'readonly_tool', decision: 'maybe' })).toMatchObject({ ok: false });
  });
});

describe('describeRule', () => {
  it('reads as a sentence on a card', () => {
    expect(describeRule({ tool: 'Bash', match: 'command_prefix', value: 'git status', decision: 'allow', scope: 'project' })).toBe(
      'allow shell commands starting with `git status` in this project',
    );
    expect(describeRule({ tool: '*', match: 'readonly_tool', decision: 'deny', scope: 'global' })).toBe('refuse read-only tools');
  });
});

/**
 * CLAIM-SCRATCHPAD-COVERED. A worker's own session scratchpad is inside its
 * confinement for coverage, so the default rules decide its scratch commands
 * rather than holding each one — the residual holds the 1.19 eval still had.
 * Every other outside-root path stays held, and nothing destructive is covered.
 */
const SCRATCH = '/tmp/claude-0/-home-me-project/sess-123/scratchpad';
const cmdScratch = (command: string) => ({ tool: 'Bash', args: { command }, root: ROOT, scratchpad: SCRATCH });

describe('the session scratchpad is inside confinement', () => {
  it('covers a prefixed command that touches the scratchpad, once the scratchpad is known', () => {
    expect(evaluateRules([prefix('mkdir -p')], cmdScratch(`mkdir -p ${SCRATCH}/ex`))?.decision).toBe('allow');
    expect(evaluateRules([prefix('cat')], cmdScratch(`cat ${SCRATCH}/notes.txt`))?.decision).toBe('allow');
    // Without the scratchpad, the same command is held — that absolute path is
    // outside the project root. This is the bug the claim guards.
    expect(evaluateRules([prefix('mkdir -p')], cmd(`mkdir -p ${SCRATCH}/ex`))).toBeNull();
  });

  it('still holds a path that is neither the project nor the scratchpad', () => {
    expect(evaluateRules([prefix('cat')], cmdScratch('cat /etc/hostname'))).toBeNull();
    expect(evaluateRules([prefix('mkdir -p')], cmdScratch('mkdir -p /other/dir'))).toBeNull();
    expect(evaluateRules([prefix('cat')], cmdScratch('cat ~/.ssh/id_rsa'))).toBeNull();
  });

  it('never covers a destructive command, scratchpad or not', () => {
    // `rm` is not a prefix, so even inside the scratchpad it is held — and the
    // containment denylist refuses it outright before rules in the real router.
    expect(evaluateRules([prefix('mkdir -p')], cmdScratch(`rm -rf ${SCRATCH}`))).toBeNull();
  });

  it('allows `cd` into the scratchpad and the command after it', () => {
    const rules = [prefix('cd'), prefix('node')];
    expect(evaluateRules(rules, cmdScratch(`cd ${SCRATCH} && node ${SCRATCH}/s.js`))?.decision).toBe('allow');
    // `cd` into an outside path stays held.
    expect(evaluateRules([prefix('cd')], cmdScratch('cd /etc'))).toBeNull();
  });

  it('treats a leading variable assignment as covering nothing, not as a block', () => {
    const rules = [prefix('mkdir -p')];
    // `S=<scratchpad>; mkdir -p $S` — the assignment is benign (its path is in
    // confinement) and `$S` is not an absolute token, so the whole thing covers.
    expect(evaluateRules(rules, cmdScratch(`S=${SCRATCH}; mkdir -p $S/ex`))?.decision).toBe('allow');
    // An assignment to an outside path is not benign — still held.
    expect(evaluateRules(rules, cmdScratch('S=/etc; mkdir -p $S/ex'))).toBeNull();
    // Only assignments, no command: nothing runs, but nothing names a rule, so
    // it falls through to a person rather than being silently allowed.
    expect(evaluateRules(rules, cmdScratch(`S=${SCRATCH}`))).toBeNull();
  });

  it('ships `cd` in the default prefixes', () => {
    expect(DEFAULT_ALLOW_PREFIXES).toContain('cd');
  });
});
