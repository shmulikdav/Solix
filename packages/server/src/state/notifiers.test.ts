import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import {
  MAX_DEDUPE_KEYS,
  buildDelivery,
  classifyEvent,
  createNotifier,
  deleteNotifier,
  deliverNotification,
  getNotifierConfig,
  listNotifiers,
  setNotifierEnabled,
  rememberDedupeKey,
  startNotificationDispatcher,
  type NotifyTransport,
} from './notifiers.js';

const planName = (): string => 'My Plan';

describe('notifiers (P3 #11)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('stores config encrypted and never returns it in the listing', () => {
    const n = createNotifier(db, {
      provider: 'slack',
      name: 'Eng channel',
      config: { webhookUrl: 'https://hooks.slack.com/SECRET' },
      events: ['plan_completed'],
    });
    const listed = listNotifiers(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider).toBe('slack');
    expect(listed[0]!.events).toEqual(['plan_completed']);
    // The webhook URL is nowhere in the client-facing shape.
    expect(JSON.stringify(listed)).not.toContain('SECRET');
    // …but is decryptable server-side.
    expect(getNotifierConfig(db, n.id)).toEqual({
      webhookUrl: 'https://hooks.slack.com/SECRET',
    });
  });

  it('toggles and deletes', () => {
    const n = createNotifier(db, {
      provider: 'telegram',
      name: 't',
      config: { botToken: 'x', chatId: '1' },
      events: [],
    });
    expect(setNotifierEnabled(db, n.id, false)!.enabled).toBe(false);
    expect(deleteNotifier(db, n.id)).toBe(true);
    expect(listNotifiers(db)).toHaveLength(0);
  });

  it('classifies notifiable events and ignores the rest', () => {
    const completed = classifyEvent(
      { type: 'plan_upsert', plan: { id: 'p1', name: 'P', status: 'completed' } as never },
      planName,
    );
    expect(completed?.event).toBe('plan_completed');
    const running = classifyEvent(
      { type: 'plan_upsert', plan: { id: 'p1', name: 'P', status: 'running' } as never },
      planName,
    );
    expect(running).toBeNull();
    const esc = classifyEvent(
      { type: 'plan_task_upsert', task: { id: 't1', planId: 'p1', title: 'T', status: 'escalated', attempts: 3 } as never },
      planName,
    );
    expect(esc?.event).toBe('task_escalated');
    const budget = classifyEvent(
      { type: 'plan_budget_alert', planId: 'p1', spentUsd: 8, budgetUsd: 10, pct: 0.8 },
      planName,
    );
    expect(budget?.event).toBe('budget_alert');
    expect(classifyEvent({ type: 'tool_call' } as ServerMessage, planName)).toBeNull();
  });

  it('builds provider-specific delivery payloads', () => {
    expect(buildDelivery('slack', { webhookUrl: 'https://h' }, 'hi')).toEqual({
      url: 'https://h',
      body: JSON.stringify({ text: 'hi' }),
    });
    const tg = buildDelivery('telegram', { botToken: 'TOK', chatId: '42' }, 'hi')!;
    expect(tg.url).toContain('/botTOK/sendMessage');
    expect(tg.body).toContain('"chat_id":"42"');
    expect(buildDelivery('slack', { webhookUrl: '' }, 'x')).toBeNull();
  });

  it('delivers through an injected transport', async () => {
    const calls: string[] = [];
    const transport: NotifyTransport = async (url) => {
      calls.push(url);
      return { ok: true };
    };
    const ok = await deliverNotification('slack', { webhookUrl: 'https://h' }, 'hi', transport);
    expect(ok).toBe(true);
    expect(calls).toEqual(['https://h']);
  });

  it('dispatches a tapped event once to subscribed notifiers only', async () => {
    const sent: string[] = [];
    const transport: NotifyTransport = async (_url, init) => {
      sent.push(init.body);
      return { ok: true };
    };
    createNotifier(db, {
      provider: 'slack',
      name: 'subscribed',
      config: { webhookUrl: 'https://h' },
      events: ['plan_completed'],
    });
    createNotifier(db, {
      provider: 'slack',
      name: 'unsubscribed',
      config: { webhookUrl: 'https://h2' },
      events: ['plan_failed'],
    });

    let tapped: ((m: ServerMessage) => void) | null = null;
    const broadcaster = {
      tap: (fn: (m: ServerMessage) => void) => {
        tapped = fn;
        return () => {};
      },
    };
    startNotificationDispatcher(db, broadcaster, { transport });

    const msg: ServerMessage = {
      type: 'plan_upsert',
      plan: { id: 'p1', name: 'My Plan', status: 'completed' } as never,
    };
    tapped!(msg);
    tapped!(msg); // duplicate — must not double-send
    await new Promise((r) => setImmediate(r));

    // Only the subscribed notifier fired, exactly once.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('completed');
  });

  it('bounds the dedupe set so a long-lived server does not leak', () => {
    // Unbounded, this grew one key per event for the life of the process.
    const seen = new Set<string>();
    for (let i = 0; i < MAX_DEDUPE_KEYS + 200; i++) {
      expect(rememberDedupeKey(seen, `k${i}`)).toBe(true);
    }
    expect(seen.size).toBeLessThanOrEqual(MAX_DEDUPE_KEYS);
    // Recent keys are still deduped (only the oldest are evicted).
    expect(rememberDedupeKey(seen, `k${MAX_DEDUPE_KEYS + 199}`)).toBe(false);
  });
});
