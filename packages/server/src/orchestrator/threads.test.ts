import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import { listThreadEntries } from '../state/threads.js';
import { Orchestrator } from './index.js';
import type { RunOnceOpts, RunOnceResult, SessionRunner } from './runner.js';

const SINGLE = JSON.stringify({
  name: 'One',
  tasks: [
    {
      id: 't1',
      title: 'Only',
      prompt: 'do the thing',
      acceptanceCriteria: 'the thing is done',
      dependsOn: [],
    },
  ],
});

class RoleRunner implements SessionRunner {
  constructor(private cfg: { verifierPass: boolean }) {}
  runOnce(o: RunOnceOpts): Promise<RunOnceResult> {
    if (o.role === 'planner') return Promise.resolve({ ok: true, output: SINGLE });
    if (o.role === 'verifier')
      return Promise.resolve({
        ok: true,
        output: JSON.stringify({ pass: this.cfg.verifierPass, reason: 'because' }),
      });
    return Promise.resolve({ ok: true, output: 'WORKER_OUTPUT', costUsd: 0.05 });
  }
}

function build(db: DB, verifierPass: boolean) {
  const msgs: ServerMessage[] = [];
  const orch = new Orchestrator({
    db,
    runner: new RoleRunner({ verifierPass }),
    broadcast: (m) => msgs.push(m),
    getKnownAdvisorRoles: () => ['forge'],
    knownModels: ['opus', 'sonnet', 'haiku', 'default'],
    getMaestroPrompt: () => 'MAESTRO',
    fullAutoStatus: () => ({ ok: true, reasons: [] }),
  });
  return { orch, msgs };
}

describe('Orchestrator task-thread wiring', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('records dispatched → worker_result → completed on a passing task', async () => {
    const { orch, msgs } = build(db, true);
    const { planId } = await orch.createPlanFromGoal({ goal: 'g', cwd: '/tmp/p' });
    orch.approvePlan(planId!);
    await orch.advance(planId!);

    const task = orch.getPlanWithTasks(planId!)!.tasks[0]!;
    const entries = listThreadEntries(db, task.id);
    expect(entries.map((e) => e.kind)).toEqual([
      'dispatched',
      'worker_result',
      'completed',
    ]);
    // The worker entry carries its output + cost; it's untrusted → author 'worker'.
    const result = entries.find((e) => e.kind === 'worker_result')!;
    expect(result.author).toBe('worker');
    expect(result.body).toContain('WORKER_OUTPUT');
    expect(result.payload?.costUsd).toBe(0.05);
    // The verifier authored the completion.
    expect(entries.find((e) => e.kind === 'completed')!.author).toBe('verifier');
    // Each append was also broadcast live.
    expect(msgs.filter((m) => m.type === 'thread_entry_append')).toHaveLength(3);
  });

  it('records a retry per rejection and a final escalation', async () => {
    const { orch } = build(db, false); // verifier always rejects
    const { planId } = await orch.createPlanFromGoal({ goal: 'g', cwd: '/tmp/p' });
    orch.approvePlan(planId!);
    await orch.advance(planId!);

    const task = orch.getPlanWithTasks(planId!)!.tasks[0]!;
    expect(task.status).toBe('escalated');
    const kinds = listThreadEntries(db, task.id).map((e) => e.kind);
    // 3 attempts: dispatched+worker_result each, 2 retries, 1 escalation.
    expect(kinds.filter((k) => k === 'dispatched')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'retry')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'escalated')).toHaveLength(1);
    // The rejection reason is carried into the thread.
    const esc = listThreadEntries(db, task.id).find((e) => e.kind === 'escalated')!;
    expect(esc.body).toContain('because');
  });
});

describe('Orchestrator.addFollowUpTask (comment-on-passage)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('appends a follow-up task to a completed plan, reopens it, and runs it', async () => {
    const { orch } = build(db, true);
    const { planId } = await orch.createPlanFromGoal({ goal: 'g', cwd: '/tmp/p' });
    orch.approvePlan(planId!);
    await orch.advance(planId!);
    const before = orch.getPlanWithTasks(planId!)!;
    expect(before.plan.status).toBe('completed');
    const sourceTaskId = before.tasks[0]!.id;

    const res = orch.addFollowUpTask(planId!, {
      body: 'tighten the button copy',
      file: 'src/app.ts',
      hunk: '@@ -1 +1 @@\n-old\n+new',
      sourceTaskId,
    });
    expect(res.ok).toBe(true);
    expect(res.run).toBe(true);
    // The plan reopened to run the new task.
    expect(db.prepare('SELECT status FROM plans WHERE id=?').get(planId!)).toMatchObject(
      { status: 'running' },
    );

    await orch.advance(planId!); // drive the follow-up to completion

    const after = orch.getPlanWithTasks(planId!)!;
    expect(after.plan.status).toBe('completed');
    expect(after.tasks).toHaveLength(before.tasks.length + 1);
    const follow = after.tasks.find((t) => t.id === res.taskId)!;
    expect(follow.status).toBe('completed');
    expect(follow.prompt).toContain('tighten the button copy');
    expect(follow.prompt).toContain('src/app.ts');
    // Lineage: a follow_up entry on the new task AND on the source task.
    expect(listThreadEntries(db, res.taskId!).some((e) => e.kind === 'follow_up')).toBe(true);
    const srcFollow = listThreadEntries(db, sourceTaskId).find((e) => e.kind === 'follow_up');
    expect(srcFollow?.payload?.followUpTaskId).toBe(res.taskId);
  });

  /**
   * Follow-ups used to stop re-opening a settled plan once it crossed the
   * free three-task cap. The cap is gone; this asserts a fourth follow-up
   * still runs, so nothing quietly reintroduces it.
   */
  it('re-opens a settled plan for a follow-up past the old three-task cap', async () => {
    const msgs: ServerMessage[] = [];
    const orch = new Orchestrator({
      db,
      runner: new RoleRunner({ verifierPass: true }),
      broadcast: (m) => msgs.push(m),
      getKnownAdvisorRoles: () => ['forge'],
      knownModels: ['opus', 'sonnet', 'haiku', 'default'],
      getMaestroPrompt: () => 'MAESTRO',
      fullAutoStatus: () => ({ ok: true, reasons: [] }),
    });
    // SINGLE has 1 task; run it, then add three follow-ups — the last of which
    // would have been the 4th task, one past the old cap.
    const { planId } = await orch.createPlanFromGoal({ goal: 'g', cwd: '/tmp/p' });
    orch.approvePlan(planId!);
    await orch.advance(planId!);
    expect(orch.addFollowUpTask(planId!, { body: 'a' }).run).toBe(true);
    await orch.advance(planId!);
    expect(orch.addFollowUpTask(planId!, { body: 'b' }).run).toBe(true);
    await orch.advance(planId!);
    const res = orch.addFollowUpTask(planId!, { body: 'c' });
    expect(res.ok).toBe(true);
    expect(res.run).toBe(true);
    expect(db.prepare('SELECT status FROM plans WHERE id=?').get(planId!)).toMatchObject(
      { status: 'running' },
    );
  });

  it('errors on an unknown plan', () => {
    const { orch } = build(db, true);
    expect(orch.addFollowUpTask('nope', { body: 'x' }).ok).toBe(false);
  });
});
