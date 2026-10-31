import { nanoid } from 'nanoid';
import type { Model, Plan, PlanStatus, PlanTask, PlanTaskStatus } from '@solix/shared';
import type { DB } from '../db.js';
import { now } from '../util.js';
import {
  deleteThreadEntriesForPlan,
  deleteThreadEntriesForTask,
} from './threads.js';
import { DEFAULT_ORG_ID, getCurrentOrgId } from './orgs.js';

// ── Plans ────────────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  name: string;
  goal_prompt: string;
  status: string;
  auto_mode: number;
  goal_id: string | null;
  cwd: string;
  budget_usd: number | null;
  base_ref: string | null;
  budget_warned: number | null;
  org_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    goalPrompt: row.goal_prompt,
    status: row.status as PlanStatus,
    autoMode: row.auto_mode === 1,
    goalId: row.goal_id ?? undefined,
    cwd: row.cwd,
    budgetUsd: row.budget_usd ?? undefined,
    baseRef: row.base_ref ?? undefined,
    budgetWarned: row.budget_warned === 1,
    orgId: row.org_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPlan(
  db: DB,
  input: {
    name: string;
    goalPrompt: string;
    cwd: string;
    status?: PlanStatus;
    autoMode?: boolean;
    goalId?: string;
    budgetUsd?: number;
    orgId?: string;
  },
): Plan {
  const id = nanoid(8);
  const ts = now();
  // Stamp the owning org (default: whatever's current) so a Team edition can
  // isolate plans. getCurrentOrgId self-heals to the default org.
  const orgId = input.orgId ?? getCurrentOrgId(db);
  db.prepare(
    `INSERT INTO plans
       (id, name, goal_prompt, status, auto_mode, goal_id, cwd, budget_usd, org_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.goalPrompt,
    input.status ?? 'draft',
    input.autoMode ? 1 : 0,
    input.goalId ?? null,
    input.cwd,
    input.budgetUsd ?? null,
    orgId,
    ts,
    ts,
  );
  return getPlan(db, id)!;
}

export function listPlans(db: DB): Plan[] {
  const rows = db
    .prepare('SELECT * FROM plans ORDER BY created_at DESC')
    .all() as PlanRow[];
  return rows.map(rowToPlan);
}

/** Plans owned by one org (P3 #10). Rows with a NULL org_id (pre-migration) are
 *  treated as belonging to the default org. */
export function listPlansForOrg(db: DB, orgId: string): Plan[] {
  const rows =
    orgId === DEFAULT_ORG_ID
      ? (db
          .prepare(
            'SELECT * FROM plans WHERE org_id = ? OR org_id IS NULL ORDER BY created_at DESC',
          )
          .all(orgId) as PlanRow[])
      : (db
          .prepare('SELECT * FROM plans WHERE org_id = ? ORDER BY created_at DESC')
          .all(orgId) as PlanRow[]);
  return rows.map(rowToPlan);
}

export function getPlan(db: DB, id: string): Plan | null {
  const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as
    | PlanRow
    | undefined;
  return row ? rowToPlan(row) : null;
}

export function updatePlan(
  db: DB,
  id: string,
  patch: Partial<
    Pick<
      Plan,
      | 'name'
      | 'status'
      | 'autoMode'
      | 'goalId'
      | 'cwd'
      | 'budgetUsd'
      | 'baseRef'
      | 'budgetWarned'
    >
  >,
): Plan | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    vals.push(patch.status);
  }
  if (patch.autoMode !== undefined) {
    sets.push('auto_mode = ?');
    vals.push(patch.autoMode ? 1 : 0);
  }
  if (patch.goalId !== undefined) {
    sets.push('goal_id = ?');
    vals.push(patch.goalId ?? null);
  }
  if (patch.cwd !== undefined) {
    sets.push('cwd = ?');
    vals.push(patch.cwd);
  }
  if (patch.budgetUsd !== undefined) {
    sets.push('budget_usd = ?');
    vals.push(patch.budgetUsd ?? null);
  }
  if (patch.baseRef !== undefined) {
    sets.push('base_ref = ?');
    vals.push(patch.baseRef ?? null);
  }
  if (patch.budgetWarned !== undefined) {
    sets.push('budget_warned = ?');
    vals.push(patch.budgetWarned ? 1 : 0);
  }
  if (sets.length === 0) return getPlan(db, id);
  sets.push('updated_at = ?');
  vals.push(now());
  vals.push(id);
  db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getPlan(db, id);
}

/**
 * Total spend across every session (worker + verifier, all attempts) that
 * belongs to a plan. Keyed off `sessions.plan_id` — NOT `plan_tasks.session_id`,
 * which a retry overwrites — so retried attempts still count toward the budget.
 */
export function getPlanSpendUsd(db: DB, planId: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM sessions WHERE plan_id = ?',
    )
    .get(planId) as { total: number };
  return row.total ?? 0;
}

export function deletePlan(db: DB, id: string): boolean {
  deleteThreadEntriesForPlan(db, id);
  db.prepare('DELETE FROM plan_tasks WHERE plan_id = ?').run(id);
  const res = db.prepare('DELETE FROM plans WHERE id = ?').run(id);
  return res.changes > 0;
}

// ── Plan tasks ───────────────────────────────────────────────────────────

interface PlanTaskRow {
  id: string;
  plan_id: string;
  title: string;
  prompt: string;
  acceptance_criteria: string;
  status: string;
  depends_on_json: string;
  assigned_advisor_role: string | null;
  cwd: string | null;
  model: string | null;
  runtime: string | null;
  budget_usd: number | null;
  session_id: string | null;
  mission_id: string | null;
  verifier_session_id: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result_summary: string | null;
  order_index: number;
  delegation_depth: number | null;
  created_at: number;
  updated_at: number;
}

function rowToPlanTask(row: PlanTaskRow): PlanTask {
  let dependsOn: string[] = [];
  try {
    dependsOn = JSON.parse(row.depends_on_json) as string[];
  } catch {
    dependsOn = [];
  }
  return {
    id: row.id,
    planId: row.plan_id,
    title: row.title,
    prompt: row.prompt,
    acceptanceCriteria: row.acceptance_criteria,
    status: row.status as PlanTaskStatus,
    dependsOn,
    assignedAdvisorRole: row.assigned_advisor_role ?? undefined,
    cwd: row.cwd ?? undefined,
    model: (row.model as Model | null) ?? undefined,
    runtime: (row.runtime as import('@solix/shared').AgentRuntime | null) ?? undefined,
    budgetUsd: row.budget_usd ?? undefined,
    sessionId: row.session_id ?? undefined,
    missionId: row.mission_id ?? undefined,
    verifierSessionId: row.verifier_session_id ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error ?? undefined,
    resultSummary: row.result_summary ?? undefined,
    orderIndex: row.order_index,
    delegationDepth: row.delegation_depth ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPlanTask(
  db: DB,
  input: {
    planId: string;
    title: string;
    prompt: string;
    acceptanceCriteria?: string;
    status?: PlanTaskStatus;
    dependsOn?: string[];
    assignedAdvisorRole?: string;
    cwd?: string;
    model?: Model;
    runtime?: import('@solix/shared').AgentRuntime;
    budgetUsd?: number;
    maxAttempts?: number;
    orderIndex?: number;
    delegationDepth?: number;
  },
): PlanTask {
  const id = nanoid(8);
  const ts = now();
  db.prepare(
    `INSERT INTO plan_tasks
       (id, plan_id, title, prompt, acceptance_criteria, status, depends_on_json,
        assigned_advisor_role, cwd, model, runtime, budget_usd, session_id, mission_id,
        verifier_session_id, attempts, max_attempts, order_index, delegation_depth,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.planId,
    input.title,
    input.prompt,
    input.acceptanceCriteria ?? '',
    input.status ?? 'pending',
    JSON.stringify(input.dependsOn ?? []),
    input.assignedAdvisorRole ?? null,
    input.cwd ?? null,
    input.model ?? null,
    input.runtime ?? null,
    input.budgetUsd ?? null,
    input.maxAttempts ?? 3,
    input.orderIndex ?? 0,
    input.delegationDepth ?? 0,
    ts,
    ts,
  );
  return getPlanTask(db, id)!;
}

export function getPlanTask(db: DB, id: string): PlanTask | null {
  const row = db.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(id) as
    | PlanTaskRow
    | undefined;
  return row ? rowToPlanTask(row) : null;
}

/** All tasks, optionally filtered to one plan, ordered for display. */
export function listPlanTasks(db: DB, planId?: string): PlanTask[] {
  const rows = (
    planId
      ? db
          .prepare(
            'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY order_index ASC, created_at ASC',
          )
          .all(planId)
      : db
          .prepare(
            'SELECT * FROM plan_tasks ORDER BY order_index ASC, created_at ASC',
          )
          .all()
  ) as PlanTaskRow[];
  return rows.map(rowToPlanTask);
}

/**
 * Whether a human may still edit this task's content, and why not.
 *
 * `PATCH /api/plans/:planId/tasks/:taskId` passed its whole body through to
 * `updatePlanTask`, including `status`, with no regard for what the plan was
 * doing. One level up, the plan's own PATCH has stripped `status` and
 * `autoMode` since 1.17 precisely so "a generic PATCH must not flip a plan to
 * `running` behind the orchestrator's back" — the task route never got the
 * same treatment, so it could:
 *
 *   - mark a task `completed` without it ever having run, or `dispatched`
 *     while the orchestrator believed otherwise;
 *   - rewrite `prompt` or `acceptanceCriteria` of a task that is *mid-flight*,
 *     changing what a worker was told after it was told it;
 *   - rewrite the acceptance criteria of a task already `completed`, which
 *     retroactively changes what "verified against its acceptance criteria"
 *     meant. That is the product's central claim about Maestro.
 *
 * Only a loopback origin can reach the route, so this was never remotely
 * exploitable — but the plan-editing UI is about to make it a button, and a
 * footgun with a label on it is worse than one nobody can find.
 *
 * The rule, in one place so the UI and the route agree: a finished plan is a
 * record, a task in flight belongs to the orchestrator, and a verified task's
 * terms do not change after the fact. Everything else is yours to edit —
 * including a `pending` task inside a running plan, which has not started.
 */
export function taskEditRefusal(
  plan: Plan | null,
  task: PlanTask | null,
): string | null {
  if (!plan || !task) return 'not found';
  if (plan.status === 'completed' || plan.status === 'failed') {
    return `this plan is ${plan.status} — it is a record now, not a draft`;
  }
  if (task.status === 'dispatched' || task.status === 'verifying') {
    return `this task is ${task.status} — an agent is working on it. Abort the plan or wait for it to settle`;
  }
  if (task.status === 'completed') {
    return 'this task is already verified — changing what it asked for would ' +
      'change what "verified" meant. Add a follow-up task instead';
  }
  return null;
}

export function updatePlanTask(
  db: DB,
  id: string,
  patch: Partial<
    Pick<
      PlanTask,
      | 'title'
      | 'prompt'
      | 'acceptanceCriteria'
      | 'status'
      | 'dependsOn'
      | 'assignedAdvisorRole'
      | 'cwd'
      | 'model'
      | 'budgetUsd'
      | 'sessionId'
      | 'missionId'
      | 'verifierSessionId'
      | 'attempts'
      | 'maxAttempts'
      | 'lastError'
      | 'resultSummary'
      | 'orderIndex'
    >
  >,
): PlanTask | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown): void => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.title !== undefined) put('title', patch.title);
  if (patch.prompt !== undefined) put('prompt', patch.prompt);
  if (patch.acceptanceCriteria !== undefined)
    put('acceptance_criteria', patch.acceptanceCriteria);
  if (patch.status !== undefined) put('status', patch.status);
  if (patch.dependsOn !== undefined)
    put('depends_on_json', JSON.stringify(patch.dependsOn));
  if (patch.assignedAdvisorRole !== undefined)
    put('assigned_advisor_role', patch.assignedAdvisorRole ?? null);
  if (patch.cwd !== undefined) put('cwd', patch.cwd ?? null);
  if (patch.model !== undefined) put('model', patch.model ?? null);
  if (patch.budgetUsd !== undefined) put('budget_usd', patch.budgetUsd ?? null);
  if (patch.sessionId !== undefined) put('session_id', patch.sessionId ?? null);
  if (patch.missionId !== undefined) put('mission_id', patch.missionId ?? null);
  if (patch.verifierSessionId !== undefined)
    put('verifier_session_id', patch.verifierSessionId ?? null);
  if (patch.attempts !== undefined) put('attempts', patch.attempts);
  if (patch.maxAttempts !== undefined) put('max_attempts', patch.maxAttempts);
  if (patch.lastError !== undefined) put('last_error', patch.lastError ?? null);
  if (patch.resultSummary !== undefined)
    put('result_summary', patch.resultSummary ?? null);
  if (patch.orderIndex !== undefined) put('order_index', patch.orderIndex);
  if (sets.length === 0) return getPlanTask(db, id);
  put('updated_at', now());
  vals.push(id);
  db.prepare(`UPDATE plan_tasks SET ${sets.join(', ')} WHERE id = ?`).run(
    ...vals,
  );
  return getPlanTask(db, id);
}

export function deletePlanTask(db: DB, id: string): boolean {
  deleteThreadEntriesForTask(db, id);
  const res = db.prepare('DELETE FROM plan_tasks WHERE id = ?').run(id);
  return res.changes > 0;
}
