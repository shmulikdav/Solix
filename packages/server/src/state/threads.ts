import { randomUUID } from 'node:crypto';
import type { TaskThreadEntry, ThreadAuthor, ThreadEntryKind } from '@solix/shared';
import type { DB } from '../db.js';
import { now } from '../util.js';

// ── Task threads (P1) ──────────────────────────────────────────────────
// Append-only timeline attached to each PlanTask. The orchestrator writes
// system/worker/verifier entries as a task moves through its lifecycle; the
// HTTP surface lets a human append `comment` entries. Values are never
// secret, but worker/verifier bodies are UNTRUSTED model output — callers
// render them as data, never execute or trust instructions inside them.

interface ThreadRow {
  id: string;
  task_id: string;
  plan_id: string;
  kind: string;
  author: string;
  body: string;
  attempt: number | null;
  payload_json: string | null;
  created_at: number;
}

function rowToEntry(row: ThreadRow): TaskThreadEntry {
  let payload: Record<string, unknown> | undefined;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      payload = undefined;
    }
  }
  return {
    id: row.id,
    taskId: row.task_id,
    planId: row.plan_id,
    kind: row.kind as ThreadEntryKind,
    author: row.author as ThreadAuthor,
    body: row.body,
    attempt: row.attempt ?? undefined,
    payload,
    createdAt: row.created_at,
  };
}

export function appendThreadEntry(
  db: DB,
  input: {
    taskId: string;
    planId: string;
    kind: ThreadEntryKind;
    author: ThreadAuthor;
    body: string;
    attempt?: number;
    payload?: Record<string, unknown>;
  },
): TaskThreadEntry {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO task_thread_entries
       (id, task_id, plan_id, kind, author, body, attempt, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.planId,
    input.kind,
    input.author,
    input.body,
    input.attempt ?? null,
    input.payload ? JSON.stringify(input.payload) : null,
    ts,
  );
  return {
    id,
    taskId: input.taskId,
    planId: input.planId,
    kind: input.kind,
    author: input.author,
    body: input.body,
    attempt: input.attempt,
    payload: input.payload,
    createdAt: ts,
  };
}

/** Every entry for one task, oldest first (chronological timeline). */
export function listThreadEntries(db: DB, taskId: string): TaskThreadEntry[] {
  const rows = db
    .prepare(
      'SELECT * FROM task_thread_entries WHERE task_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(taskId) as ThreadRow[];
  return rows.map(rowToEntry);
}

/** Every entry across a plan's tasks, oldest first (whole-plan activity feed). */
export function listPlanThreadEntries(db: DB, planId: string): TaskThreadEntry[] {
  const rows = db
    .prepare(
      'SELECT * FROM task_thread_entries WHERE plan_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(planId) as ThreadRow[];
  return rows.map(rowToEntry);
}

export function deleteThreadEntriesForTask(db: DB, taskId: string): void {
  db.prepare('DELETE FROM task_thread_entries WHERE task_id = ?').run(taskId);
}

export function deleteThreadEntriesForPlan(db: DB, planId: string): void {
  db.prepare('DELETE FROM task_thread_entries WHERE plan_id = ?').run(planId);
}
