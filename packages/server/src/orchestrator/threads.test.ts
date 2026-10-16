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
