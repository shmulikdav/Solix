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
import { ensureProject } from '../state/projects.js';
import { upsertSession } from '../state/sessions.js';
import { recordAudit } from '../state/audit.js';
import { Orchestrator } from './index.js';
import type { RunOnceOpts, RunOnceResult, SessionRunner } from './runner.js';

/**
 * CLAIM-DENY-STOPS-RETRY and CLAIM-RESTART-PAUSES-ON-HOLD.
 *
 * Measured on 1.18.3: a worker was denied a command, the verifier rejected
 * the task for not doing it, and the orchestrator retried — re-posing to the
 * person a question already answered, three times over. And a plan with a
 * decision still open when Solix stopped resumed itself on restart, deciding
 * the held command by default. A denial is a decision; an open decision is
 * not consent.
 */
const CWD = '/tmp/sticky-orch';

/** A runner that denies the worker its command, then rejects at verification. */
class DenyingRunner implements SessionRunner {
  runOnce(opts: RunOnceOpts): Promise<RunOnceResult> {
    return Promise.resolve(this.answer(opts));
  }
  private answer(opts: RunOnceOpts): RunOnceResult {
    if (opts.role === 'worker' && opts.sessionId) {
      // The gate held the delete and a person pressed Deny.
      recordAudit(globalDb, {
        kind: 'permission_denied',
        sessionId: opts.sessionId,
        summary: 'Denied Bash',
        payload: { tool: 'Bash', args: { command: 'rm -rf build' } },
      });
      return { ok: true, output: 'I was refused the delete and could not finish.' };
    }
    if (opts.role === 'verifier') {
      return { ok: true, output: JSON.stringify({ pass: false, reason: 'build dir still present' }) };
    }
    return { ok: true, output: '{}' };
  }
}

/** A runner that just fails verification every time, with nobody denying. */
class RejectingRunner implements SessionRunner {
  runOnce(opts: RunOnceOpts): Promise<RunOnceResult> {
    if (opts.role === 'verifier') {
      return Promise.resolve({ ok: true, output: JSON.stringify({ pass: false, reason: 'nope' }) });
    }
    return Promise.resolve({ ok: true, output: 'did a thing' });
  }
}

let globalDb: DB;

function orchestrator(db: DB, runner: SessionRunner, sent: ServerMessage[]) {
  return new Orchestrator({
    db,
    runner,
    broadcast: (m: ServerMessage) => sent.push(m),
    getKnownAdvisorRoles: () => ['forge'],
    knownModels: ['default'],
    getMaestroPrompt: () => '',
  });
}

function seedRunningPlanWithOneTask(db: DB) {
  ensureProject(db, CWD);
  const plan = createPlan(db, { name: 'p', goalPrompt: 'g', cwd: CWD, status: 'running' });
  const task = createPlanTask(db, {
    planId: plan.id,
    title: 'Clean build',
    prompt: 'Remove build artifacts',
    acceptanceCriteria: 'build/ is gone',
    status: 'ready',
  });
  return { plan, task };
}

describe('a human denial stops the retry loop', () => {
  let db: DB;
  let sent: ServerMessage[];
  beforeEach(() => {
    db = resetDbForTests();
    globalDb = db;
    sent = [];
  });

  it('escalates at once instead of retrying a question already answered', async () => {
    const orch = orchestrator(db, new DenyingRunner(), sent);
    const { plan, task } = seedRunningPlanWithOneTask(db);
    await orch.advance(plan.id);

    const settled = getPlanTask(db, task.id)!;
    expect(settled.status).toBe('escalated');
    // The point: it did NOT burn the retry budget (maxAttempts 3) re-asking.
    expect(settled.attempts).toBe(1);
    expect(settled.lastError).toMatch(/denied `rm -rf build`/);
    expect(getPlan(db, plan.id)!.status).toBe('failed');
  });

  it('a plain verification failure still retries to the ceiling', async () => {
    // The control: without a human denial, the same rejection retries as before.
    const orch = orchestrator(db, new RejectingRunner(), sent);
    const { plan, task } = seedRunningPlanWithOneTask(db);
    await orch.advance(plan.id);

    const settled = getPlanTask(db, task.id)!;
    expect(settled.status).toBe('escalated');
    expect(settled.attempts).toBe(3); // retried, unlike the denial case
  });
});

describe('a restart does not resume a plan with a decision still open', () => {
  let db: DB;
  let sent: ServerMessage[];
  beforeEach(() => {
    db = resetDbForTests();
    globalDb = db;
    sent = [];
  });

  it('reconcile pauses a plan whose held request was dropped on shutdown', async () => {
    const orch = orchestrator(db, new RejectingRunner(), sent);
    const { plan, task } = seedRunningPlanWithOneTask(db);
    const project = ensureProject(db, CWD);
    // A worker that was mid-hold when Solix stopped: dispatched, with an
    // abandoned permission_denied recorded by abandonAllPending.
    const workerId = 'worker-held';
    upsertSession(db, {
      id: workerId,
      pid: 0,
      projectId: project.id,
      cwd: CWD,
      origin: 'internal',
      sessionRole: 'worker',
      planId: plan.id,
      planTaskId: task.id,
    });
    updatePlanTask(db, task.id, { status: 'dispatched', sessionId: workerId, attempts: 1 });
    recordAudit(db, {
      kind: 'permission_denied',
      sessionId: workerId,
      summary: 'Shutting down: Bash was refused',
      payload: { tool: 'Bash', args: { command: 'rm -rf build' }, abandoned: true },
    });

    await orch.reconcile();

    // Paused, not resumed; the task is back to pending for a person to review.
    expect(getPlan(db, plan.id)!.status).toBe('paused');
    expect(getPlanTask(db, task.id)!.status).toBe('pending');
  });

  it('a plain orphan with no open decision resumes as before', async () => {
    const orch = orchestrator(db, new RejectingRunner(), sent);
    const { plan, task } = seedRunningPlanWithOneTask(db);
    const project = ensureProject(db, CWD);
    const workerId = 'worker-orphan';
    upsertSession(db, {
      id: workerId,
      pid: 0,
      projectId: project.id,
      cwd: CWD,
      origin: 'internal',
      sessionRole: 'worker',
      planId: plan.id,
      planTaskId: task.id,
    });
    updatePlanTask(db, task.id, { status: 'dispatched', sessionId: workerId, attempts: 1 });

    await orch.reconcile();

    // No open decision → it ran: the RejectingRunner drives it to escalation,
    // so the plan ends failed, not paused. The point is reconcile did NOT pause.
    expect(getPlan(db, plan.id)!.status).not.toBe('paused');
  });
});
