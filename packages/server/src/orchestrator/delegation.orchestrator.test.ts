import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import { listThreadEntries } from '../state/threads.js';
import { Orchestrator } from './index.js';
import { MAX_DELEGATION_DEPTH } from './delegation.js';
import type { RunOnceOpts, RunOnceResult, SessionRunner } from './runner.js';

const SINGLE = JSON.stringify({
  name: 'Root',
  tasks: [
    {
      id: 't1',
      title: 'Root task',
      prompt: 'do the root work',
      acceptanceCriteria: 'root done',
      dependsOn: [],
    },
  ],
});

function subtaskBlock(json: string): string {
  return `worker done\n<<<SOLIX_SUBTASKS\n${json}\nSOLIX_SUBTASKS>>>`;
}

/** Worker emits a subtask proposal only on its first call (the root task). */
class ProposeOnceRunner implements SessionRunner {
  private workerCalls = 0;
  constructor(private readonly subtasksJson: string) {}
  runOnce(o: RunOnceOpts): Promise<RunOnceResult> {
    if (o.role === 'planner') return Promise.resolve({ ok: true, output: SINGLE });
    if (o.role === 'verifier')
      return Promise.resolve({ ok: true, output: JSON.stringify({ pass: true, reason: 'ok' }) });
    this.workerCalls++;
    return Promise.resolve({
      ok: true,
      output: this.workerCalls === 1 ? subtaskBlock(this.subtasksJson) : 'subtask done',
    });
  }
}

/** Worker ALWAYS proposes one subtask — exercises the depth cap. */
class AlwaysProposeRunner implements SessionRunner {
  runOnce(o: RunOnceOpts): Promise<RunOnceResult> {
    if (o.role === 'planner') return Promise.resolve({ ok: true, output: SINGLE });
    if (o.role === 'verifier')
      return Promise.resolve({ ok: true, output: JSON.stringify({ pass: true, reason: 'ok' }) });
    return Promise.resolve({
      ok: true,
      output: subtaskBlock('[{"title":"child","prompt":"do child","acceptanceCriteria":"c"}]'),
    });
  }
}

function build(db: DB, runner: SessionRunner) {
  const msgs: ServerMessage[] = [];
  const orch = new Orchestrator({
    db,
    runner,
    broadcast: (m) => msgs.push(m),
    getKnownAdvisorRoles: () => ['forge'],
    knownModels: ['opus', 'sonnet', 'haiku', 'default'],
    getMaestroPrompt: () => 'MAESTRO',
    fullAutoStatus: () => ({ ok: true, reasons: [] }),
  });
  return { orch, msgs };
}

describe('Orchestrator agent delegation (P2 #8)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('appends worker-proposed subtasks, runs them, and records the delegation', async () => {
    const { orch } = build(
      db,
      new ProposeOnceRunner(
        '[{"title":"Sub A","prompt":"do a","acceptanceCriteria":"a"},{"title":"Sub B","prompt":"do b"}]',
      ),
    );
    const { planId } = await orch.createPlanFromGoal({ goal: 'g', cwd: '/tmp/p' });
    orch.approvePlan(planId!);
    await orch.advance(planId!);

    const b = orch.getPlanWithTasks(planId!)!;
    expect(b.plan.status).toBe('completed');
    // 1 root + 2 subtasks, all completed.
    expect(b.tasks).toHaveLength(3);
    expect(b.tasks.every((t) => t.status === 'completed')).toBe(true);

    const root = b.tasks.find((t) => t.title === 'Root task')!;
    const subs = b.tasks.filter((t) => t.title.startsWith('Sub '));
    expect(subs).toHaveLength(2);
    for (const s of subs) {
      expect(s.delegationDepth).toBe(1);
      expect(s.dependsOn).toEqual([root.id]); // flat batch, parent-only edge
    }
    // The parent task's thread records the delegation.
    expect(listThreadEntries(db, root.id).some((e) => e.kind === 'delegated')).toBe(true);
  });

  it('stops expanding at the depth cap', async () => {
    const { orch } = build(db, new AlwaysProposeRunner());
    const { planId } = await orch.createPlanFromGoal({ goal: 'g', cwd: '/tmp/p' });
    orch.approvePlan(planId!);
    await orch.advance(planId!);

    const b = orch.getPlanWithTasks(planId!)!;
    // depth 0 (root) → 1 → 2, then the depth-2 task's proposal is refused.
    const maxDepth = Math.max(...b.tasks.map((t) => t.delegationDepth ?? 0));
    expect(maxDepth).toBe(MAX_DELEGATION_DEPTH);
    expect(b.tasks).toHaveLength(MAX_DELEGATION_DEPTH + 1); // one chain, N=1
    expect(b.plan.status).toBe('completed');
    // The deepest task recorded that its proposal was ignored at the cap.
    const deepest = b.tasks.find((t) => (t.delegationDepth ?? 0) === MAX_DELEGATION_DEPTH)!;
    const entries = listThreadEntries(db, deepest.id);
    expect(entries.some((e) => e.kind === 'delegated' && /depth/i.test(e.body))).toBe(true);
  });

  /**
   * Delegation used to be re-gated on the resulting task count so it could not
   * bypass the free three-task cap. The cap is gone; a proposal that would
   * have taken the plan to five tasks must now be accepted in full.
   */
  it('accepts a proposal that would have exceeded the old task cap', async () => {
    const { orch } = build(
      db,
      new ProposeOnceRunner(
        JSON.stringify([1, 2, 3, 4].map((n) => ({ title: `S${n}`, prompt: 'p' }))),
      ),
    );
    const { planId } = await orch.createPlanFromGoal({ goal: 'g', cwd: '/tmp/p' });
    orch.approvePlan(planId!);
    await orch.advance(planId!);

    const b = orch.getPlanWithTasks(planId!)!;
    expect(b.tasks).toHaveLength(5); // root + 4 subtasks
    const root = b.tasks.find((t) => t.delegationDepth === 0)!;
    const entries = listThreadEntries(db, root.id);
    expect(entries.some((e) => e.kind === 'delegated' && /declined/i.test(e.body))).toBe(
      false,
    );
  });
});
