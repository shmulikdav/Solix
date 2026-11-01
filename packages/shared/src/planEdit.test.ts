import { describe, expect, it } from 'vitest';
import { canEditTask, taskEditRefusal } from './planEdit.js';
import type { PlanStatus, PlanTaskStatus } from './types.js';

/**
 * The rule the route and the panel both read.
 *
 * It lives in `shared` so there is one answer: the server refuses with it and
 * the UI greys the button out with it, showing the same sentence. Two copies
 * drift, and the drift shows up as a control that looks available and then
 * fails — which is worse than one that is plainly disabled with a reason.
 *
 * The table is written out rather than derived, because a table generated
 * from the predicate would agree with a wrong predicate.
 */
const PLAN_STATES: PlanStatus[] = [
  'draft',
  'awaiting_approval',
  'running',
  'paused',
  'completed',
  'failed',
];

const TASK_STATES: PlanTaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'verifying',
  'completed',
  'failed',
  'escalated',
  'blocked',
  'skipped',
];

describe('CLAIM-VERIFIED-TERMS-FIXED · taskEditRefusal', () => {
  it('allows editing a task in a plan that has not started', () => {
    expect(
      taskEditRefusal({ status: 'awaiting_approval' }, { status: 'pending' }),
    ).toBeNull();
    expect(taskEditRefusal({ status: 'draft' }, { status: 'ready' })).toBeNull();
  });

  it('allows editing a task that has not started inside a running plan', () => {
    // Deliberate: spotting a mistake mid-plan and fixing the task that has
    // not run yet is the main reason to want this feature at all.
    expect(
      taskEditRefusal({ status: 'running' }, { status: 'pending' }),
    ).toBeNull();
    expect(taskEditRefusal({ status: 'paused' }, { status: 'ready' })).toBeNull();
  });

  it('refuses while an agent is working on the task', () => {
    for (const status of ['dispatched', 'verifying'] as PlanTaskStatus[]) {
      const why = taskEditRefusal({ status: 'running' }, { status });
      expect(why, status).toMatch(/an agent is working on it/);
    }
  });

  it('refuses to change what a verified task was asked to do', () => {
    // The soundness one. Maestro's claim is that each result is verified
    // against its acceptance criteria; editing them afterwards makes the
    // claim vacuous.
    expect(
      taskEditRefusal({ status: 'running' }, { status: 'completed' }),
    ).toMatch(/already verified/);
  });

  it('refuses everything once the plan is finished', () => {
    for (const status of ['completed', 'failed'] as PlanStatus[]) {
      // Even a task that never ran: the plan is history.
      expect(taskEditRefusal({ status }, { status: 'pending' }), status).toMatch(
        /a record now/,
      );
    }
  });

  it('a finished plan outranks a task that would otherwise be editable', () => {
    // Order matters: the plan is checked first, so the message names the
    // plan rather than confusing someone with a task-level reason.
    expect(
      taskEditRefusal({ status: 'failed' }, { status: 'escalated' }),
    ).toMatch(/this plan is failed/);
  });

  it('refuses when either side is missing', () => {
    expect(taskEditRefusal(null, { status: 'pending' })).toBe('not found');
    expect(taskEditRefusal({ status: 'running' }, null)).toBe('not found');
    expect(taskEditRefusal(undefined, undefined)).toBe('not found');
  });

  it('covers every combination without throwing, and refuses exactly where expected', () => {
    // The whole surface, so a new plan or task status cannot slip in
    // unconsidered: it either lands in the editable set below or this fails.
    const refused: string[] = [];
    for (const plan of PLAN_STATES) {
      for (const task of TASK_STATES) {
        const why = taskEditRefusal({ status: plan }, { status: task });
        if (why) refused.push(`${plan}/${task}`);
        expect(canEditTask({ status: plan }, { status: task })).toBe(why === null);
      }
    }
    // 2 finished plan states × 9 task states, plus 3 in-flight-or-verified
    // task states across the 4 live plan states.
    expect(refused).toHaveLength(2 * 9 + 3 * 4);
  });
});
