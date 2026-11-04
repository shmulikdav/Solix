import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import { createPlan, createPlanTask, getPlan, getPlanTask, updatePlan } from '../state/plans.js';
import { ensureProject } from '../state/projects.js';
import { gitHead } from '../state/git.js';
import { Orchestrator } from './index.js';
import type { RunOnceOpts, RunOnceResult, SessionRunner } from './runner.js';

/**
 * CLAIM-PARALLEL-INTEGRATES (and the limit from CLAIM-PARALLEL-LIMIT-ENFORCED).
 *
 * 1.20 turns parallel Maestro on: a planner-marked **isolated** task runs in
 * its own git worktree, concurrently with its siblings, and its changes are
 * integrated back into the plan checkout — where the review diffs — one at a
 * time. A conflict (two tasks that were not really disjoint) is escalated to a
 * person, never silently merged. These run against a **real temp git repo**,
 * because the whole mechanism is git worktrees + `git apply`.
 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A worker that writes/append to files in its own cwd (the worktree) per a
 * directive in its prompt, holding briefly so siblings overlap. The verifier
 * always passes — this test is about dispatch + integration, not judgement.
 */
class FileWritingRunner implements SessionRunner {
  live = 0;
  peak = 0;
  async runOnce(opts: RunOnceOpts): Promise<RunOnceResult> {
    if (opts.role === 'worker') {
      this.live += 1;
      this.peak = Math.max(this.peak, this.live);
      const write = /__WRITE__ (\S+) ([\s\S]*?) __END__/.exec(opts.prompt);
      if (write) {
        const p = join(opts.cwd, write[1]!);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, write[2]!);
      }
      const append = /__APPEND__ (\S+) ([\s\S]*?) __END__/.exec(opts.prompt);
      if (append) appendFileSync(join(opts.cwd, append[1]!), append[2]!);
      await delay(25); // hold so a sibling worker overlaps
      this.live -= 1;
      return { ok: true, output: 'wrote the files' };
    }
    if (opts.role === 'verifier') {
      return { ok: true, output: JSON.stringify({ pass: true, reason: 'ok' }) };
    }
    return { ok: true, output: '{}' };
  }
}

let home: string;
let repo: string;

function orchestrator(db: DB, runner: SessionRunner) {
  const sent: ServerMessage[] = [];
  const orch = new Orchestrator({
    db,
    runner,
    broadcast: (m: ServerMessage) => sent.push(m),
    getKnownAdvisorRoles: () => ['forge'],
    knownModels: ['default'],
    getMaestroPrompt: () => '',
  });
  return orch;
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

/** A plan rooted at the temp repo, with baseRef pinned to its HEAD. */
function seedPlan(db: DB, parallelLimit: number) {
  ensureProject(db, repo);
  const plan = createPlan(db, { name: 'p', goalPrompt: 'g', cwd: repo, status: 'running', parallelLimit });
  updatePlan(db, plan.id, { baseRef: gitHead(repo) ?? undefined });
  return getPlan(db, plan.id)!;
}

function task(
  db: DB,
  planId: string,
  title: string,
  directive: string,
  opts: { isolated?: boolean } = {},
) {
  return createPlanTask(db, {
    planId,
    title,
    prompt: directive,
    acceptanceCriteria: 'done',
    status: 'ready',
    dependsOn: [],
    isolated: opts.isolated ?? false,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'par-home-'));
  vi.stubEnv('HOME', home); // ensureWorktree puts worktrees under $HOME/.solix
  repo = mkdtempSync(join(tmpdir(), 'par-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'e@x'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'e'], { cwd: repo });
  writeFileSync(join(repo, 'seed.txt'), 'line one\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'seed']);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('parallel Maestro — worktrees + integrate', () => {
  it('runs two independent isolated tasks at once and integrates both into the plan checkout', async () => {
    const db = resetDbForTests();
    const runner = new FileWritingRunner();
    const plan = seedPlan(db, 2);
    task(db, plan.id, 'A', '__WRITE__ a.txt alpha __END__', { isolated: true });
    task(db, plan.id, 'B', '__WRITE__ b.txt bravo __END__', { isolated: true });

    await orchestrator(db, runner).advance(plan.id);

    expect(runner.peak).toBe(2); // they really overlapped
    expect(getPlan(db, plan.id)!.status).toBe('completed');
    // Both files landed in the plan checkout, where the review will see them.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('bravo');
    // No worktrees left behind.
    expect(existsSync(join(home, '.solix', 'worktrees'))
      ? execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' })
      : '').not.toMatch(/\.solix\/worktrees/);
  });

  it('integrates a change to a tracked file via git apply', async () => {
    const db = resetDbForTests();
    const runner = new FileWritingRunner();
    const plan = seedPlan(db, 2);
    task(db, plan.id, 'A', '__APPEND__ seed.txt line two\n __END__', { isolated: true });
    task(db, plan.id, 'B', '__WRITE__ b.txt bravo __END__', { isolated: true });

    await orchestrator(db, runner).advance(plan.id);

    expect(getPlan(db, plan.id)!.status).toBe('completed');
    expect(readFileSync(join(repo, 'seed.txt'), 'utf8')).toBe('line one\nline two\n');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('bravo');
  });

  it('escalates the task whose changes conflict, and keeps the plan checkout intact', async () => {
    const db = resetDbForTests();
    const runner = new FileWritingRunner();
    const plan = seedPlan(db, 2);
    // Both claim to be isolated but write the SAME new file with different
    // content — the planner was wrong. One integrates; the other must not
    // clobber it.
    const a = task(db, plan.id, 'A', '__WRITE__ clash.txt from-A __END__', { isolated: true });
    const b = task(db, plan.id, 'B', '__WRITE__ clash.txt from-B __END__', { isolated: true });

    await orchestrator(db, runner).advance(plan.id);

    const statuses = [getPlanTask(db, a.id)!.status, getPlanTask(db, b.id)!.status].sort();
    expect(statuses).toEqual(['completed', 'escalated']);
    // The winner's content is intact; nothing is half-merged.
    expect(['from-A', 'from-B']).toContain(readFileSync(join(repo, 'clash.txt'), 'utf8'));
    const escalated = [a, b].find((t) => getPlanTask(db, t.id)!.status === 'escalated')!;
    expect(getPlanTask(db, escalated.id)!.lastError).toMatch(/could not integrate|conflict/i);
  });

  it('a non-isolated plan still runs serially (peak 1), untouched by the limit', async () => {
    const db = resetDbForTests();
    const runner = new FileWritingRunner();
    const plan = seedPlan(db, 2);
    task(db, plan.id, 'A', '__WRITE__ a.txt alpha __END__'); // not isolated
    task(db, plan.id, 'B', '__WRITE__ b.txt bravo __END__'); // not isolated

    await orchestrator(db, runner).advance(plan.id);

    expect(runner.peak).toBe(1);
    expect(getPlan(db, plan.id)!.status).toBe('completed');
    // They ran in the plan checkout directly — still both present.
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('bravo');
  });

  it('at limit 1, even isolated tasks run one at a time', async () => {
    const db = resetDbForTests();
    const runner = new FileWritingRunner();
    const plan = seedPlan(db, 1);
    task(db, plan.id, 'A', '__WRITE__ a.txt alpha __END__', { isolated: true });
    task(db, plan.id, 'B', '__WRITE__ b.txt bravo __END__', { isolated: true });

    await orchestrator(db, runner).advance(plan.id);

    expect(runner.peak).toBe(1);
    expect(getPlan(db, plan.id)!.status).toBe('completed');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('bravo');
  });
});

/**
 * CLAIM-PARALLEL-LIMIT-ENFORCED states the default. It said "default 1" for a
 * release after the default became 2, because nothing pinned it. Now
 * something does.
 */
describe('CLAIM-PARALLEL-LIMIT-ENFORCED · the default parallel limit', () => {
  it('is 2 for a plan created without one, both on create and as stored', () => {
    const db = resetDbForTests();
    const plan = createPlan(db, { name: 'p', goalPrompt: 'g', cwd: '/tmp/default-limit', status: 'draft' });
    expect(plan.parallelLimit).toBe(2);
    expect(getPlan(db, plan.id)!.parallelLimit).toBe(2);
  });
});
