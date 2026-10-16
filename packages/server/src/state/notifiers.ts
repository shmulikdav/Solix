import { nanoid } from 'nanoid';
import type {
  Notifier,
  NotifierProvider,
  NotifyEvent,
  ServerMessage,
} from '@solix/shared';
import type { DB } from '../db.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { getPlan } from './plans.js';
import { now } from '../util.js';

// ── Chat notifiers (P3 #11) ────────────────────────────────────────────
// CRUD for Slack/Telegram destinations + the pure event→message mapping and an
// injectable-transport delivery. Provider credentials are AES-GCM encrypted at
// rest and never leave the server — getNotifierConfig is internal-only.

export interface SlackConfig {
  webhookUrl: string;
}
export interface TelegramConfig {
  botToken: string;
  chatId: string;
}
export type NotifierConfig = SlackConfig | TelegramConfig;

interface NotifierRow {
  id: string;
  provider: string;
  name: string;
  config_enc: string;
  events_json: string;
  enabled: number;
  created_at: number;
}

function rowToNotifier(row: NotifierRow): Notifier {
  let events: NotifyEvent[] = [];
  try {
    events = JSON.parse(row.events_json) as NotifyEvent[];
  } catch {
    events = [];
  }
  return {
    id: row.id,
    provider: row.provider as NotifierProvider,
    name: row.name,
    events,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
  };
}

export function createNotifier(
  db: DB,
  input: {
    provider: NotifierProvider;
    name: string;
    config: NotifierConfig;
    events: NotifyEvent[];
  },
): Notifier {
  const id = nanoid(10);
  const ts = now();
  db.prepare(
    `INSERT INTO notifiers (id, provider, name, config_enc, events_json, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    input.provider,
    input.name,
    encryptSecret(JSON.stringify(input.config)),
    JSON.stringify(input.events ?? []),
    ts,
  );
  return getNotifier(db, id)!;
}

export function getNotifier(db: DB, id: string): Notifier | null {
  const row = db.prepare('SELECT * FROM notifiers WHERE id = ?').get(id) as
    | NotifierRow
    | undefined;
  return row ? rowToNotifier(row) : null;
}

export function listNotifiers(db: DB): Notifier[] {
  const rows = db
    .prepare('SELECT * FROM notifiers ORDER BY created_at ASC')
    .all() as NotifierRow[];
  return rows.map(rowToNotifier);
}

export function setNotifierEnabled(
  db: DB,
  id: string,
  enabled: boolean,
): Notifier | null {
  db.prepare('UPDATE notifiers SET enabled = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    id,
  );
  return getNotifier(db, id);
}

export function deleteNotifier(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM notifiers WHERE id = ?').run(id).changes > 0;
}

/** Internal-only: decrypt a notifier's provider config. Never exposed via API. */
export function getNotifierConfig(db: DB, id: string): NotifierConfig | null {
  const row = db.prepare('SELECT config_enc FROM notifiers WHERE id = ?').get(id) as
    | { config_enc: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(decryptSecret(row.config_enc)) as NotifierConfig;
  } catch {
    return null;
  }
}

// ── Event → message mapping (pure) ─────────────────────────────────────

export interface ClassifiedEvent {
  event: NotifyEvent;
  text: string;
  /** A stable key so the dispatcher can fire each event at most once. */
  dedupeKey: string;
}

/**
 * Map a broadcast ServerMessage to a notifiable event, or null if it isn't one.
 * Pure — the dispatcher owns dedupe + delivery. `planName` resolves a plan id to
 * a human name when available.
 */
export function classifyEvent(
  msg: ServerMessage,
  planName: (planId: string) => string,
): ClassifiedEvent | null {
  if (msg.type === 'plan_upsert') {
    if (msg.plan.status === 'completed') {
      return {
        event: 'plan_completed',
        text: `✅ Plan "${msg.plan.name}" completed.`,
        dedupeKey: `plan_completed:${msg.plan.id}`,
      };
    }
    if (msg.plan.status === 'failed') {
      return {
        event: 'plan_failed',
        text: `❌ Plan "${msg.plan.name}" failed.`,
        dedupeKey: `plan_failed:${msg.plan.id}`,
      };
    }
    return null;
  }
  if (msg.type === 'plan_task_upsert' && msg.task.status === 'escalated') {
    return {
      event: 'task_escalated',
      text: `⚠ Task "${msg.task.title}" in "${planName(msg.task.planId)}" needs a human${msg.task.lastError ? `: ${msg.task.lastError}` : '.'}`,
      dedupeKey: `task_escalated:${msg.task.id}:${msg.task.attempts}`,
    };
  }
  if (msg.type === 'plan_budget_alert') {
    return {
      event: 'budget_alert',
      text: `💸 "${planName(msg.planId)}" is at ${Math.round(msg.pct * 100)}% of its budget ($${msg.spentUsd.toFixed(2)}/$${msg.budgetUsd.toFixed(2)}).`,
      dedupeKey: `budget_alert:${msg.planId}`,
    };
  }
  return null;
}

// ── Delivery (injectable transport) ────────────────────────────────────

export type NotifyTransport = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean }>;

const defaultTransport: NotifyTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok };
};

/** Build the HTTP request for a provider + message (pure). */
export function buildDelivery(
  provider: NotifierProvider,
  config: NotifierConfig,
  text: string,
): { url: string; body: string } | null {
  if (provider === 'slack') {
    const c = config as SlackConfig;
    if (!c.webhookUrl) return null;
    return { url: c.webhookUrl, body: JSON.stringify({ text }) };
  }
  if (provider === 'telegram') {
    const c = config as TelegramConfig;
    if (!c.botToken || !c.chatId) return null;
    return {
      url: `https://api.telegram.org/bot${c.botToken}/sendMessage`,
      body: JSON.stringify({ chat_id: c.chatId, text }),
    };
  }
  return null;
}

export async function deliverNotification(
  provider: NotifierProvider,
  config: NotifierConfig,
  text: string,
  transport: NotifyTransport = defaultTransport,
): Promise<boolean> {
  const built = buildDelivery(provider, config, text);
  if (!built) return false;
  try {
    const res = await transport(built.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: built.body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wire the broadcaster → chat notifiers. Taps every outgoing message, maps it to
 * a notifiable event (deduped so each fires once), and posts to each enabled
 * notifier subscribed to that event. Returns an unsubscribe. `transport` is
 * injectable for tests.
 */
export const MAX_DEDUPE_KEYS = 2000;

/**
 * Remember a dedupe key, bounded. A long-lived server would otherwise grow this
 * set forever (one key per plan/task/alert, for the life of the process), which
 * is a slow leak. Sets iterate in insertion order, so once the cap is hit we
 * drop the oldest quarter — far older than any event still being deduped.
 * Returns false when the key was already seen.
 */
export function rememberDedupeKey(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > MAX_DEDUPE_KEYS) {
    const drop = Math.floor(MAX_DEDUPE_KEYS / 4);
    let i = 0;
    for (const k of seen) {
      seen.delete(k);
      if (++i >= drop) break;
    }
  }
  return true;
}

export function startNotificationDispatcher(
  db: DB,
  broadcaster: { tap: (fn: (m: ServerMessage) => void) => () => void },
  opts: { transport?: NotifyTransport } = {},
): () => void {
  const seen = new Set<string>();
  const planName = (id: string): string => getPlan(db, id)?.name ?? id;
  return broadcaster.tap((msg) => {
    const classified = classifyEvent(msg, planName);
    if (!classified) return;
    if (!rememberDedupeKey(seen, classified.dedupeKey)) return;
    for (const n of listNotifiers(db)) {
      if (!n.enabled || !n.events.includes(classified.event)) continue;
      const config = getNotifierConfig(db, n.id);
      if (config) {
        void deliverNotification(n.provider, config, classified.text, opts.transport);
      }
    }
  });
}
