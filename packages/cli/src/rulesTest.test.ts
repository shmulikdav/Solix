import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `solix rules test` against the commands that a real `solix gate` run on
 * 2026-11-03 refused one at a time. Each is answered here without an agent,
 * naming the part that was not covered. (`CLAIM-RULES-TEST-IS-THE-GATE` is held
 * by `explainRules` in rules.test.ts; this is the command people run.)
 */
let home: string;
let project: string;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function run(words: string[], opts: Record<string, string> = {}) {
  vi.resetModules();
  const m = await import('./rulesTest.js');
  const lines: string[] = [];
  const code = m.rulesTest(words, { cwd: project, ...opts }, (l) => lines.push(strip(l)));
  return { code, text: lines.join('\n') };
}

function policyFile(body: unknown): string {
  const f = join(home, 'policy.json');
  writeFileSync(f, JSON.stringify(body));
  return f;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rules-test-home-'));
  project = mkdtempSync(join(tmpdir(), 'rules-test-proj-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SOLIX_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('solix rules test', () => {
  const firstPolicy = () =>
    policyFile([
      { match: 'readonly_tool' },
      ...['ls', 'cat', 'echo', 'cd', 'npm whoami'].map((value) => ({ tool: 'Bash', match: 'command_prefix', value })),
      { tool: 'Bash', match: 'command_regex', value: '^npm (pack|publish) --dry-run$' },
    ]);

  it('names the one segment no rule covers — the missing `head`', async () => {
    const r = await run(['cd packages/cli && ls -la && cat package.json | head -60'], { rules: firstPolicy() });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/✗ head -60\s+no rule covers this/);
    expect(r.text).toMatch(/✓ cat package\.json/);
    expect(r.text).toMatch(/NOT COVERED\. Under `solix gate` it is refused at once/);
  });

  it('allows the dry run with `2>&1` that the anchored regex used to refuse', async () => {
    const r = await run(['npm publish --dry-run 2>&1 | tail -80'], {
      rules: policyFile({ extends: 'defaults', rules: [{ tool: 'Bash', match: 'command_regex', value: '^npm (pack|publish) --dry-run$' }] }),
    });
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/ALLOWED by rule/);
  });

  it('says when a rule matched but a path outside the project kept it out', async () => {
    const r = await run(['cat /etc/hostname'], { rules: 'defaults' });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/starting with `cat` matches, but \/etc\/hostname is outside the project/);
  });

  it('reports a deny rule by name', async () => {
    const r = await run(['git push --force'], {
      rules: policyFile({ extends: 'defaults', rules: [{ tool: 'Bash', match: 'command_prefix', value: 'git push', decision: 'deny' }] }),
    });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/REFUSED by rule: refuse shell commands starting with `git push`/);
  });

  it('reports the denylist first, which no rule can override', async () => {
    const r = await run(['rm -rf ~'], { rules: policyFile([{ tool: 'Bash', match: 'command_regex', value: '.*' }]) });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/BLOCKED by the denylist/);
  });

  it('tests a file tool with --file', async () => {
    expect((await run([], { rules: 'defaults', file: 'src/a.ts' })).code).toBe(0);
    expect((await run([], { rules: 'defaults', file: '/etc/hosts' })).code).toBe(1);
  });

  it('exits 2 for a policy that does not load, and for nothing to test', async () => {
    expect((await run(['ls'], { rules: join(home, 'missing.json') })).code).toBe(2);
    expect((await run([], { rules: 'defaults' })).code).toBe(2);
  });

  it('without --rules, uses the rules in force on this machine', async () => {
    const before = await run(['ls']);
    expect(before.code).toBe(1);
    expect(before.text).toMatch(/0 rules from the rules in force/);
    const { getDb } = await import('@solix/server/db');
    const { installDefaultRules } = await import('@solix/server/rules');
    installDefaultRules(getDb());
    const after = await run(['ls']);
    expect(after.code).toBe(0);
  });

  it('shows a lifted substitution as ( … ), and judges its command on its own line', async () => {
    const r = await run(['cat <(rm -rf ./src)'], { rules: 'defaults' });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/✓ cat \( … \)/);
    expect(r.text).toMatch(/✗ rm -rf \.\/src\s+no rule covers this/);
    expect(r.text).not.toContain('__solix_subst__');
  });
});
