import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import {
  createPlan,
  createPlanTask,
  getPlan,
  getPlanTask,
  updatePlanTask,
} from '../state/plans.js';
import { Orchestrator } from './index.js';

/**
 * There was no per-task retry anywhere in the product, and a `failed` plan
 * was terminal: `resumePlan` refuses anything not `paused`, and
 * `computePlanOutcome` rolls a plan to `failed` once its tasks escalate.
 *
 * The only routes back were a follow-up *goal* — which is not a retry at
 * all, but a new plan with new planner spend that abandons the task state —
 * or commenting on a changed file, which only exists if the plan ran far
 * enough to produce a diff. A plan that failed on its first task had no way
 * back whatsoever, and `DELETE /api/plans/:id` shipped uncalled, so the dead
 * card stayed forever.
 */
function makeOrchestrator(db: DB, sent: ServerMessage[]) {
  return new Orchestrator({
    db,
    runner: { runOnce: () => Promise.resolve({ ok: true, output: '{}' }) },
    broadcast: (m: ServerMessage) => sent.push(m),
    getKnownAdvisorRoles: () => ['forge'],
    knownModels: ['default'],
    getMaestroPrompt: () => '',
  });
}

describe('retryTask', () => {
  let db: DB;
  let sent: ServerMessage[];
  let orch: Orchestrator;

  beforeEach(() => {
    db = resetDbForTests();
    sent = [];
    orch = makeOrchestrator(db, sent);
  });

  function seed(
    planStatus: Parameters<typeof createPlan>[1]['status'] = 'running',
  ) {
    const plan = createPlan(db, {
      name: 'p',
      goalPrompt: 'g',
      cwd: '/tmp/p',
      status: planStatus,
    });
    const task = createPlanTask(db, {
      planId: plan.id,
      title: 't',
      prompt: 'do it',
      acceptanceCriteria: 'done',
      orderIndex: 0,
    });
    return { plan, task };
  }

  /**
   * The scheduler stops retrying at maxAttempts, so a task that exhausted
   * them would be re-escalated the moment it was picked up. Resetting the
   * count is what makes the retry a retry.
   */
  it('resets an escalated task to pending AND clears its attempts', () => {
    const { plan, task } = seed();
    updatePlanTask(db, task.id, { status: 'escalated', attempts: 3 });

    const res = orch.retryTask(plan.id, task.id);
    expect(res.ok).toBe(true);

    const after = getPlanTask(db, task.id)!;
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
  });

  it('retries a failed task too', () => {
    const { plan, task } = seed();
    updatePlanTask(db, task.id, { status: 'failed', attempts: 1 });
    expect(orch.retryTask(plan.id, task.id).ok).toBe(true);
    expect(getPlanTask(db, task.id)!.status).toBe('pending');
  });

  /** Retrying a live task would race the worker still running it. */
  it('refuses a task that has not stopped', () => {
    const { plan, task } = seed();
    updatePlanTask(db, task.id, { status: 'dispatched' });

    const res = orch.retryTask(plan.id, task.id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/dispatched/);
    expect(getPlanTask(db, task.id)!.status).toBe('dispatched');
  });

  it('refuses a completed task', () => {
    const { plan, task } = seed();
    updatePlanTask(db, task.id, { status: 'completed' });
    expect(orch.retryTask(plan.id, task.id).ok).toBe(false);
  });

  /** The case with no other way back: the plan itself had given up. */
  it('reopens a failed plan so the retry can actually run', () => {
    const { plan, task } = seed('failed');
    updatePlanTask(db, task.id, { status: 'escalated', attempts: 3 });

    const res = orch.retryTask(plan.id, task.id);
    expect(res.ok).toBe(true);
    expect(res.run).toBe(true);
    expect(getPlan(db, plan.id)!.status).toBe('running');
  });

  it('leaves a running plan running', () => {
    const { plan, task } = seed('running');
    updatePlanTask(db, task.id, { status: 'failed' });
    expect(orch.retryTask(plan.id, task.id).run).toBe(true);
    expect(getPlan(db, plan.id)!.status).toBe('running');
  });

  /** Don't auto-start a plan nobody has approved. */
  it('queues but does not run an unapproved plan', () => {
    const { plan, task } = seed('awaiting_approval');
    updatePlanTask(db, task.id, { status: 'failed' });

    const res = orch.retryTask(plan.id, task.id);
    expect(res.ok).toBe(true);
    expect(res.run).toBe(false);
    expect(getPlan(db, plan.id)!.status).toBe('awaiting_approval');
  });

  it('broadcasts the reset so open clients see it', () => {
    const { plan, task } = seed();
    updatePlanTask(db, task.id, { status: 'escalated' });
    sent.length = 0;
    orch.retryTask(plan.id, task.id);

    const upsert = sent.find((m) => m.type === 'plan_task_upsert');
    expect(upsert?.type === 'plan_task_upsert' && upsert.task.status).toBe(
      'pending',
    );
  });

  it('records the retry on the task thread', () => {
    const { plan, task } = seed();
    updatePlanTask(db, task.id, { status: 'escalated' });
    orch.retryTask(plan.id, task.id);

    const entry = sent.find((m) => m.type === 'thread_entry_append');
    expect(entry?.type === 'thread_entry_append' && entry.entry.kind).toBe(
      'retry',
    );
  });

  it('refuses a task that belongs to another plan', () => {
    const a = seed();
    const b = seed();
    updatePlanTask(db, b.task.id, { status: 'failed' });

    const res = orch.retryTask(a.plan.id, b.task.id);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it('refuses a plan it has never heard of', () => {
    expect(orch.retryTask('nope', 'also-nope').ok).toBe(false);
  });
});
