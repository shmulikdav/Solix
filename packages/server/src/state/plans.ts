import { nanoid } from 'nanoid';
import type { Model, Plan, PlanStatus, PlanTask, PlanTaskStatus } from '@solix/shared';
import type { DB } from '../db.js';
import { now } from '../util.js';

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
  },
): Plan {
  const id = nanoid(8);
  const ts = now();
  db.prepare(
    `INSERT INTO plans
       (id, name, goal_prompt, status, auto_mode, goal_id, cwd, budget_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.goalPrompt,
    input.status ?? 'draft',
    input.autoMode ? 1 : 0,
    input.goalId ?? null,
    input.cwd,
    input.budgetUsd ?? null,
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
      'name' | 'status' | 'autoMode' | 'goalId' | 'cwd' | 'budgetUsd' | 'baseRef'
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
  budget_usd: number | null;
  session_id: string | null;
  mission_id: string | null;
  verifier_session_id: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result_summary: string | null;
  order_index: number;
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
    budgetUsd: row.budget_usd ?? undefined,
    sessionId: row.session_id ?? undefined,
    missionId: row.mission_id ?? undefined,
    verifierSessionId: row.verifier_session_id ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error ?? undefined,
    resultSummary: row.result_summary ?? undefined,
    orderIndex: row.order_index,
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
    budgetUsd?: number;
    maxAttempts?: number;
    orderIndex?: number;
  },
): PlanTask {
  const id = nanoid(8);
  const ts = now();
  db.prepare(
    `INSERT INTO plan_tasks
       (id, plan_id, title, prompt, acceptance_criteria, status, depends_on_json,
        assigned_advisor_role, cwd, model, budget_usd, session_id, mission_id,
        verifier_session_id, attempts, max_attempts, order_index, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?)`,
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
    input.budgetUsd ?? null,
    input.maxAttempts ?? 3,
    input.orderIndex ?? 0,
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
  const res = db.prepare('DELETE FROM plan_tasks WHERE id = ?').run(id);
  return res.changes > 0;
}
