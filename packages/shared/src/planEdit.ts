import type { Plan, PlanTask } from './types.js';

/**
 * Whether a human may still edit this task, and in plain words why not.
 *
 * It lives in `shared` rather than on the server because both sides need the
 * same answer and for different reasons: the route has to refuse, and the
 * panel has to grey the button out and say what it would have said. Two
 * copies of a rule like this drift, and the drift shows up as a button that
 * looks available and then fails.
 *
 * The rule exists because `PATCH /api/plans/:planId/tasks/:taskId` used to
 * pass its whole body to the database, `status` included, with no regard for
 * what the plan was doing. The plan's own PATCH has stripped `status` and
 * `autoMode` since 1.17 — "a generic PATCH must not flip a plan to running
 * behind the orchestrator's back" — and the task route never got the same
 * treatment, so it could:
 *
 *   - mark a task `completed` without it ever having run;
 *   - rewrite the prompt of a task a worker was already executing;
 *   - rewrite the acceptance criteria of a task already verified, which
 *     retroactively changes what "verified against its acceptance criteria"
 *     meant — and that is Maestro's central claim.
 *
 * Only a loopback origin can reach the route, so none of it was remotely
 * exploitable. But plan editing turns it into a text field, and a footgun
 * with a label on it is worse than one nobody can find.
 *
 * Three refusals, and everything else is editable — including a `pending`
 * task inside a `running` plan, which is exactly what you want to fix when
 * you spot a mistake while the plan is under way.
 */
export function taskEditRefusal(
  plan: Pick<Plan, 'status'> | null | undefined,
  task: Pick<PlanTask, 'status'> | null | undefined,
): string | null {
  if (!plan || !task) return 'not found';
  if (plan.status === 'completed' || plan.status === 'failed') {
    return `this plan is ${plan.status} — it is a record now, not a draft`;
  }
  if (task.status === 'dispatched' || task.status === 'verifying') {
    return (
      `this task is ${task.status} — an agent is working on it. ` +
      'Abort the plan or wait for it to settle'
    );
  }
  if (task.status === 'completed') {
    return (
      'this task is already verified — changing what it asked for would ' +
      'change what "verified" meant. Add a follow-up task instead'
    );
  }
  return null;
}

/** The same answer as a boolean, for disabling a control. */
export function canEditTask(
  plan: Pick<Plan, 'status'> | null | undefined,
  task: Pick<PlanTask, 'status'> | null | undefined,
): boolean {
  return taskEditRefusal(plan, task) === null;
}
