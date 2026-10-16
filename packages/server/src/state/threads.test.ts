import { describe, it, expect, beforeEach } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import { createPlan, createPlanTask, deletePlan, deletePlanTask } from './plans.js';
import {
  appendThreadEntry,
  listPlanThreadEntries,
  listThreadEntries,
} from './threads.js';

function seedTask(db: DB) {
  const plan = createPlan(db, { name: 'P', goalPrompt: 'g', cwd: '/tmp/p' });
  const task = createPlanTask(db, {
    planId: plan.id,
    title: 'T',
    prompt: 'do it',
    acceptanceCriteria: 'done',
  });
  return { plan, task };
}

describe('task threads', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('appends and lists entries in chronological order', () => {
    const { plan, task } = seedTask(db);
    appendThreadEntry(db, {
      taskId: task.id,
      planId: plan.id,
      kind: 'dispatched',
      author: 'system',
      body: 'first',
      attempt: 1,
    });
    appendThreadEntry(db, {
      taskId: task.id,
      planId: plan.id,
      kind: 'worker_result',
      author: 'worker',
      body: 'second',
      attempt: 1,
      payload: { costUsd: 0.12 },
    });
    const entries = listThreadEntries(db, task.id);
    expect(entries.map((e) => e.body)).toEqual(['first', 'second']);
    expect(entries[0]!.kind).toBe('dispatched');
    expect(entries[0]!.attempt).toBe(1);
    expect(entries[1]!.payload).toEqual({ costUsd: 0.12 });
    expect(entries[1]!.id).not.toBe(entries[0]!.id);
  });

  it('round-trips the created entry shape from append()', () => {
    const { plan, task } = seedTask(db);
    const entry = appendThreadEntry(db, {
      taskId: task.id,
      planId: plan.id,
      kind: 'comment',
      author: 'human',
      body: 'please also add tests',
    });
    expect(entry.taskId).toBe(task.id);
    expect(entry.planId).toBe(plan.id);
    expect(entry.author).toBe('human');
    expect(entry.attempt).toBeUndefined();
    expect(entry.payload).toBeUndefined();
    expect(entry.createdAt).toBeGreaterThan(0);
    // The returned entry matches what a subsequent list reads back.
    expect(listThreadEntries(db, task.id)[0]).toEqual(entry);
  });

  it('scopes entries per task and aggregates per plan', () => {
    const plan = createPlan(db, { name: 'P', goalPrompt: 'g', cwd: '/tmp/p' });
    const a = createPlanTask(db, { planId: plan.id, title: 'A', prompt: 'p' });
    const b = createPlanTask(db, { planId: plan.id, title: 'B', prompt: 'p' });
    appendThreadEntry(db, { taskId: a.id, planId: plan.id, kind: 'comment', author: 'human', body: 'a1' });
    appendThreadEntry(db, { taskId: b.id, planId: plan.id, kind: 'comment', author: 'human', body: 'b1' });
    appendThreadEntry(db, { taskId: a.id, planId: plan.id, kind: 'comment', author: 'human', body: 'a2' });

    expect(listThreadEntries(db, a.id).map((e) => e.body)).toEqual(['a1', 'a2']);
    expect(listThreadEntries(db, b.id).map((e) => e.body)).toEqual(['b1']);
    // Whole-plan feed carries all three, still chronological.
    expect(listPlanThreadEntries(db, plan.id).map((e) => e.body)).toEqual([
      'a1',
      'b1',
      'a2',
    ]);
  });

  it('deleting a task removes its thread entries', () => {
    const { plan, task } = seedTask(db);
    appendThreadEntry(db, { taskId: task.id, planId: plan.id, kind: 'comment', author: 'human', body: 'x' });
    expect(listThreadEntries(db, task.id)).toHaveLength(1);
    deletePlanTask(db, task.id);
    expect(listThreadEntries(db, task.id)).toHaveLength(0);
  });

  it('deleting a plan removes every task thread in it', () => {
    const plan = createPlan(db, { name: 'P', goalPrompt: 'g', cwd: '/tmp/p' });
    const a = createPlanTask(db, { planId: plan.id, title: 'A', prompt: 'p' });
    appendThreadEntry(db, { taskId: a.id, planId: plan.id, kind: 'comment', author: 'human', body: 'x' });
    expect(listPlanThreadEntries(db, plan.id)).toHaveLength(1);
    deletePlan(db, plan.id);
    expect(listPlanThreadEntries(db, plan.id)).toHaveLength(0);
  });

  it('tolerates a corrupt payload_json without throwing', () => {
    const { plan, task } = seedTask(db);
    db.prepare(
      `INSERT INTO task_thread_entries (id, task_id, plan_id, kind, author, body, attempt, payload_json, created_at)
       VALUES ('bad', ?, ?, 'comment', 'human', 'b', NULL, '{not json', 1)`,
    ).run(task.id, plan.id);
    const entries = listThreadEntries(db, task.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toBeUndefined();
  });
});
