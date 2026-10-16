import type { PlanStatus, PlanTask, PlanTaskStatus } from '@solix/shared';

/**
 * Pure scheduling logic for the Maestro orchestrator — the DAG readiness,
 * blocked-propagation, retry/escalate, parallel-limit, and plan-rollup rules.
 *
 * Deliberately I/O-free: every function is a pure transform over plain task
 * objects, so the whole state machine is unit-testable with object literals and
 * with no DB, no launcher, and no real `claude`. The stateful Orchestrator
 * (orchestrator.ts) calls these to decide *what* to do; it owns *doing* it.
 */

/** The minimal task shape the scheduler reasons over (a subset of PlanTask). */
export type SchedulableTask = Pick<
  PlanTask,
  'id' | 'status' | 'dependsOn' | 'attempts' | 'maxAttempts'
>;

/** A dependency in this state means the dependent can proceed. */
function isDepSatisfied(status: PlanTaskStatus): boolean {
  return status === 'completed';
}

/**
 * A dependency in this state can NEVER be satisfied, so any dependent must be
 * blocked. Note `'failed'` is intentionally excluded — it's transient (the
 * orchestrator may still retry it), so a dependent stays waiting, not blocked.
 */
function isDepUnsatisfiable(status: PlanTaskStatus): boolean {
  return status === 'escalated' || status === 'blocked' || status === 'skipped';
}

/** Statuses that mean the task still has work in flight or ahead of it. */
function isActive(status: PlanTaskStatus): boolean {
  return (
    status === 'pending' ||
    status === 'ready' ||
    status === 'dispatched' ||
    status === 'verifying' ||
    status === 'failed' // transient — a retry is still owed
  );
}

/**
 * Tasks that are eligible to dispatch right now: `pending` and every dependency
 * `completed`. (A task with no dependencies is ready immediately.) Returns the
 * task ids so the caller can flip them to `ready`/dispatch them.
 */
export function computeReadyTasks(tasks: SchedulableTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const ready: string[] = [];
  for (const t of tasks) {
    if (t.status !== 'pending') continue;
    const allDepsDone = t.dependsOn.every((dep) => {
      const d = byId.get(dep);
      return d != null && isDepSatisfied(d.status);
    });
    if (allDepsDone) ready.push(t.id);
  }
  return ready;
}

/**
 * Tasks that should transition to `blocked`: currently `pending`/`ready` but
 * with at least one dependency that can never be satisfied (escalated / blocked
 * / skipped). Propagates transitively across a single pass; call until the
 * result is empty (the Orchestrator loops `advance()` to a fixed point).
 */
export function computeNewlyBlocked(tasks: SchedulableTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const blocked: string[] = [];
  for (const t of tasks) {
    if (t.status !== 'pending' && t.status !== 'ready') continue;
    const anyDead = t.dependsOn.some((dep) => {
      const d = byId.get(dep);
      // A dangling dependency (id not in the plan) is unsatisfiable too.
      return d == null || isDepUnsatisfiable(d.status);
    });
    if (anyDead) blocked.push(t.id);
  }
  return blocked;
}

/** After a task fails an attempt: retry if budget remains, else escalate. */
export function decideRetryOrEscalate(
  task: Pick<PlanTask, 'attempts' | 'maxAttempts'>,
): 'retry' | 'escalate' {
  return task.attempts < task.maxAttempts ? 'retry' : 'escalate';
}

/** Whether another worker may be dispatched without exceeding the cap. */
export function withinParallelLimit(inFlight: number, limit: number): boolean {
  return inFlight < limit;
}

/**
 * Whether a plan's spend has reached its budget cap. An undefined/absent budget
 * means no cap (returns false). Checked BEFORE each dispatch (Ledger): the next
 * worker only runs while spend is still under the ceiling, so a runaway plan
 * pauses instead of billing unboundedly.
 */
export function isBudgetExceeded(
  spentUsd: number,
  budgetUsd: number | undefined,
): boolean {
  return budgetUsd != null && spentUsd >= budgetUsd;
}

/**
 * Validate a plan's task graph before it runs. Catches the failure modes an LLM
 * planner can emit: a dependency on an id that doesn't exist, a self-dependency,
 * and cycles (via Kahn's algorithm). Returns all problems found (empty = valid).
 */
export function validatePlanGraph(tasks: SchedulableTask[]): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const ids = new Set(tasks.map((t) => t.id));

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) errors.push(`task ${t.id} depends on itself`);
      else if (!ids.has(dep))
        errors.push(`task ${t.id} depends on unknown task ${dep}`);
    }
  }

  // Kahn's algorithm over the intra-plan edges (ignore already-flagged
  // dangling/self edges so cycle detection reports cleanly).
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>(); // dep -> [dependents]
  for (const t of tasks) {
    indegree.set(t.id, 0);
    edges.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep !== t.id && ids.has(dep)) {
        indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
        edges.get(dep)!.push(t.id);
      }
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const next of edges.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited < tasks.length) {
    const inCycle = [...indegree.entries()]
      .filter(([, d]) => d > 0)
      .map(([id]) => id);
    errors.push(`dependency cycle among tasks: ${inCycle.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Roll a plan's task states up to a plan status. `running` while any task still
 * has work owed; otherwise `completed` if all succeeded/skipped, else `failed`
 * (something escalated or blocked with no way forward).
 */
export function computePlanOutcome(
  tasks: Pick<PlanTask, 'status'>[],
): Extract<PlanStatus, 'running' | 'completed' | 'failed'> {
  if (tasks.some((t) => isActive(t.status))) return 'running';
  if (tasks.some((t) => t.status === 'escalated' || t.status === 'blocked'))
    return 'failed';
  return 'completed';
}
