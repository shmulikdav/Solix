import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import { createPlan, createPlanTask, getPlan } from '../state/plans.js';
import { ensureProject } from '../state/projects.js';
import { Orchestrator } from './index.js';
import type { RunOnceOpts, RunOnceResult, SessionRunner } from './runner.js';

/**
 * CLAIM-PARALLEL-LIMIT-ENFORCED.
 *
 * The review flagged `withinParallelLimit` as unit-tested but never called, so
 * Maestro ran one task at a time regardless. It is now the real gate on a
 * per-plan `parallelLimit`. Default 1 is the historical serial behaviour. A
 * higher limit co-dispatches only *isolated* tasks — each in its own cwd —
 * because the shared checkout is why dispatch was serial; two writers in one
 * directory would race. These pin all three.
 */
class ConcurrencyRunner implements SessionRunner {
  live = 0;
  peak = 0;
  async runOnce(opts: RunOnceOpts): Promise<RunOnceResult> {
    if (opts.role === 'worker') {
      this.live += 1;
      this.peak = Math.max(this.peak, this.live);
      await new Promise((r) => setTimeout(r, 20)); // hold so a sibling can overlap
      this.live -= 1;
      return { ok: true, output: 'did the work' };
    }
    if (opts.role === 'verifier') {
      return { ok: true, output: JSON.stringify({ pass: true, reason: 'ok' }) };
    }
    return { ok: true, output: '{}' };
  }
}

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

/** Two independent ready tasks, each optionally in its own cwd. */
function seedTwoIndependentTasks(db: DB, planCwd: string, parallelLimit: number, cwds: [string?, string?]) {
  ensureProject(db, planCwd);
  const plan = createPlan(db, { name: 'p', goalPrompt: 'g', cwd: planCwd, status: 'running', parallelLimit });
  for (const [i, cwd] of cwds.entries()) {
    if (cwd) ensureProject(db, cwd);
    createPlanTask(db, {
      planId: plan.id,
      title: `task ${i}`,
      prompt: 'do it',
      acceptanceCriteria: 'done',
      status: 'ready',
      cwd,
    });
  }
  return plan;
}

describe('per-plan parallel limit', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('defaults to serial: two tasks never overlap at limit 1', async () => {
    const runner = new ConcurrencyRunner();
    const plan = seedTwoIndependentTasks(db, '/tmp/par', 1, ['/tmp/par/a', '/tmp/par/b']);
    await orchestrator(db, runner).advance(plan.id);
    expect(runner.peak).toBe(1);
    expect(getPlan(db, plan.id)!.status).toBe('completed');
  });

  it('runs two isolated tasks at once when the limit allows it', async () => {
    const runner = new ConcurrencyRunner();
    // Distinct cwds, both different from the plan cwd → isolated.
    const plan = seedTwoIndependentTasks(db, '/tmp/par', 2, ['/tmp/par/a', '/tmp/par/b']);
    await orchestrator(db, runner).advance(plan.id);
    expect(runner.peak).toBe(2);
    expect(getPlan(db, plan.id)!.status).toBe('completed');
  });

  it('keeps shared-checkout tasks serial even above the limit', async () => {
    const runner = new ConcurrencyRunner();
    // Both tasks run in the plan cwd (no own cwd) → not isolated → serial.
    const plan = seedTwoIndependentTasks(db, '/tmp/par', 2, [undefined, undefined]);
    await orchestrator(db, runner).advance(plan.id);
    expect(runner.peak).toBe(1);
    expect(getPlan(db, plan.id)!.status).toBe('completed');
  });
});
