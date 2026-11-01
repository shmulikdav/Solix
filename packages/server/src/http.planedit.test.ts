import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import {
  createPlan,
  createPlanTask,
  getPlanTask,
  updatePlan,
  updatePlanTask,
} from './state/plans.js';
import type { PlanStatus, PlanTaskStatus } from '@solix/shared';

/**
 * Editing a plan is about to become a feature, so the route behind it has to
 * be safe to point a button at.
 *
 * `PATCH /api/plans/:planId/tasks/:taskId` passed its whole body to
 * `updatePlanTask` — `status` included — with no regard for what the plan was
 * doing. One level up, the plan's own PATCH has stripped `status` and
 * `autoMode` since 1.17, because "a generic PATCH must not flip a plan to
 * running behind the orchestrator's back". The task route never got the same
 * treatment.
 *
 * The one that matters is acceptance criteria. Maestro's claim is that every
 * result is "verified against its acceptance criteria"; if those can be
 * rewritten while a verifier is checking them, or after a task has passed,
 * the claim is about nothing. Nobody could reach this remotely — the origin
 * guard covers every mutating route — but the UI would have made it a text
 * field.
 */
function makeApp(db: DB) {
  const broadcaster = new Broadcaster();
  const router = new EventRouter(db, broadcaster);
  const orchestrator = new Orchestrator({
    db,
    runner: { runOnce: () => Promise.resolve({ ok: true, output: '{}' }) },
    broadcast: () => {},
    getKnownAdvisorRoles: () => [],
    knownModels: ['default'],
    getMaestroPrompt: () => '',
  });
  return createHttpApp({ db, router, orchestrator });
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('editing a plan task', () => {
  let db: DB;
  let planId: string;
  let taskId: string;

  beforeEach(() => {
    db = resetDbForTests();
    const plan = createPlan(db, {
      name: 'ship it',
      goalPrompt: 'ship it',
      cwd: '/tmp/edit',
      status: 'awaiting_approval',
    });
    planId = plan.id;
    taskId = createPlanTask(db, {
      planId,
      title: 'write the thing',
      prompt: 'write it',
      acceptanceCriteria: 'it exists',
      orderIndex: 0,
    }).id;
  });

  async function patch(body: unknown): Promise<Response> {
    return makeApp(db).request(
      `/api/plans/${planId}/tasks/${taskId}`,
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) },
    );
  }

  it('lets you retitle, re-prompt, retarget and reorder a drafted task', () => {
    // The whole point of the feature: a plan waiting for approval is a draft.
    return patch({
      title: 'write the thing properly',
      prompt: 'write it properly',
      acceptanceCriteria: 'it exists and is tested',
      model: 'opus',
      orderIndex: 3,
    }).then(async (res) => {
      expect(res.status).toBe(200);
      const after = getPlanTask(db, taskId)!;
      expect(after.title).toBe('write the thing properly');
      expect(after.acceptanceCriteria).toBe('it exists and is tested');
      expect(after.model).toBe('opus');
      expect(after.orderIndex).toBe(3);
    });
  });

  it('refuses to set status, which belongs to the orchestrator', async () => {
    // Stripped rather than rejected, matching the plan route: the rest of the
    // edit still lands, so a client sending an extra field is not punished.
    const res = await patch({ title: 'renamed', status: 'completed' });
    expect(res.status).toBe(200);
    const after = getPlanTask(db, taskId)!;
    expect(after.title).toBe('renamed');
    expect(
      after.status,
      'a task was marked completed without ever running',
    ).not.toBe('completed');
  });

  const IN_FLIGHT: PlanTaskStatus[] = ['dispatched', 'verifying'];
  for (const status of IN_FLIGHT) {
    it(`refuses an edit while the task is ${status}`, async () => {
      updatePlanTask(db, taskId, { status });
      const res = await patch({ prompt: 'actually, do something else' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /an agent is working on it/,
      );
      expect(getPlanTask(db, taskId)!.prompt).toBe('write it');
    });
  }

  it('refuses to rewrite what a verified task was asked to do', async () => {
    // The soundness one. Moving the goalposts after the verifier has checked
    // them makes "verified against its acceptance criteria" meaningless.
    updatePlanTask(db, taskId, { status: 'completed' });
    const res = await patch({ acceptanceCriteria: 'anything at all' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /already verified/,
    );
    expect(getPlanTask(db, taskId)!.acceptanceCriteria).toBe('it exists');
  });

  const FINISHED: PlanStatus[] = ['completed', 'failed'];
  for (const status of FINISHED) {
    it(`refuses an edit once the plan is ${status}`, async () => {
      updatePlan(db, planId, { status });
      const res = await patch({ title: 'rewriting history' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /a record now/,
      );
    });
  }

  it('still allows editing a pending task inside a running plan', async () => {
    // Not everything in a running plan is off limits — a task that has not
    // started is exactly what you want to fix when you spot a mistake.
    updatePlan(db, planId, { status: 'running' });
    updatePlanTask(db, taskId, { status: 'pending' });
    const res = await patch({ prompt: 'fixed before it ran' });
    expect(res.status).toBe(200);
    expect(getPlanTask(db, taskId)!.prompt).toBe('fixed before it ran');
  });

  it('applies the same rule to deleting a task', async () => {
    updatePlanTask(db, taskId, { status: 'dispatched' });
    const res = await makeApp(db).request(
      `/api/plans/${planId}/tasks/${taskId}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(409);
    expect(
      getPlanTask(db, taskId),
      'a task was deleted out from under a running agent',
    ).not.toBeNull();
  });
});
