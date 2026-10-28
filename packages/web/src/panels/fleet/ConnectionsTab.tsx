import { useEffect, useState } from 'react';
import type { Connection, Notifier, NotifyEvent } from '@solix/shared';
import { Button } from '../../ui/Button.js';
import { ListPlaceholder, type LoadState } from '../../ui/LoadState.js';

/**
 * POST/DELETE and say what went wrong, or null when it worked.
 *
 * Every write in this file was `fetch(...).catch(() => {})` with no `res.ok`
 * check — six of them. This is a **credential store** whose secret values are
 * write-only by design, so a write that silently failed was both invisible
 * and unrecoverable: the input cleared, the key never appeared, and nothing
 * said why.
 */
async function write(
  url: string,
  init: RequestInit,
): Promise<string | null> {
  try {
    const res = await fetch(url, init);
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error ?? `The server refused that (HTTP ${res.status}).`;
  } catch {
    return 'Not connected — that did not reach the Solix server.';
  }
}

interface Props {
  open: boolean;
}

/**
 * Scoped credential store. Add a connection, set secrets (write-only — values
 * are never shown or returned), and grant it to advisor roles / plan ids / '*'.
 * A granted connection's secrets are injected (least-privilege) into matching
 * Maestro workers at dispatch. Self-contained: talks to /api/connections.
 *
 * A Fleet tab: FleetPanel owns the dock shell, header and close button, so this
 * returns only its own scroller.
 */
export function ConnectionsTab({ open }: Props): JSX.Element | null {
  const [conns, setConns] = useState<Connection[]>([]);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'env' | 'mcp'>('env');
  const [busy, setBusy] = useState(false);

  const [state, setState] = useState<LoadState>('loading');
  const [writeError, setWriteError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    // This swallowed the failure and left `conns` at [], so an unreachable
    // server rendered "No connections yet. Add one above." — telling you to
    // create something you may already have.
    try {
      const r = await fetch('/api/connections');
      if (!r.ok) throw new Error(String(r.status));
      setConns((await r.json()) as Connection[]);
      setState('ready');
    } catch {
      setState('error');
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  if (!open) return null;

  const addConnection = async (): Promise<void> => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    setWriteError(null);
    // Was fire-and-forget with no res.ok check, so a rejected name or an
    // unreachable server cleared the field and looked like success.
    const err = await write('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), kind: newKind }),
    });
    setBusy(false);
    if (err) {
      setWriteError(err);
      return;
    }
    setNewName('');
    await refresh();
  };

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* New connection */}
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            New connection
          </div>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. GitHub"
              className="flex-1 text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
            />
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as 'env' | 'mcp')}
              className="text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 focus:outline-none focus:border-solix-accent"
            >
              <option value="env">env</option>
              <option value="mcp">mcp</option>
            </select>
            <Button
              variant="primary"
              onClick={() => void addConnection()}
              disabled={!newName.trim()}
              busy={busy}
            >
              Add connection
            </Button>
          </div>
        </div>

        {writeError && (
          <div className="text-[11px] text-solix-danger">{writeError}</div>
        )}

        {conns.length === 0 ? (
          <ListPlaceholder
            state={state}
            label="connections"
            onRetry={() => void refresh()}
            empty={
              <>
                No connections yet. Add one above (or use{' '}
                <code className="bg-black/40 px-1 rounded">solix connect</code>
                ).
              </>
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">
              Connections · {conns.length}
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {conns.map((c) => (
                <ConnectionCard key={c.id} conn={c} onChanged={refresh} />
              ))}
            </div>
          </div>
        )}

      <div className="border-t border-solix-border pt-4">
        <NotifiersSection open={open} />
      </div>
    </div>
  );
}

const NOTIFY_EVENTS: { value: NotifyEvent; label: string }[] = [
  { value: 'plan_completed', label: 'Plan completed' },
  { value: 'plan_failed', label: 'Plan failed' },
  { value: 'task_escalated', label: 'Task escalated' },
  { value: 'budget_alert', label: 'Budget alert' },
];

/** Chat notifiers (P3 #11) — post fleet events to Slack/Telegram. Self-contained;
 *  talks to /api/notifiers. Credentials are write-only (never returned). */
function NotifiersSection({ open }: { open: boolean }): JSX.Element {
  const [list, setList] = useState<Notifier[]>([]);
  const [provider, setProvider] = useState<'slack' | 'telegram'>('slack');
  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [events, setEvents] = useState<NotifyEvent[]>(['plan_completed', 'plan_failed']);
  const [busy, setBusy] = useState(false);

  const [state, setState] = useState<LoadState>('loading');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const r = await fetch('/api/notifiers');
      if (!r.ok) throw new Error(String(r.status));
      setList((await r.json()) as Notifier[]);
      setState('ready');
    } catch {
      setState('error');
    }
  };
  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const add = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    const config =
      provider === 'slack' ? { webhookUrl: webhookUrl.trim() } : { botToken: botToken.trim(), chatId: chatId.trim() };
    setBusy(true);
    setNote(null);
    const err = await write('/api/notifiers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, name: name.trim(), config, events }),
    });
    setBusy(false);
    if (err) {
      // Keep what was typed — a webhook URL is not something to retype.
      setNote({ ok: false, text: err });
      return;
    }
    setName('');
    setWebhookUrl('');
    setBotToken('');
    setChatId('');
    await refresh();
  };

  const toggle = async (n: Notifier): Promise<void> => {
    setNote(null);
    const err = await write(`/api/notifiers/${n.id}/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !n.enabled }),
    });
    if (err) setNote({ ok: false, text: err });
    await refresh();
  };

  const remove = async (id: string): Promise<void> => {
    setNote(null);
    const err = await write(`/api/notifiers/${id}`, { method: 'DELETE' });
    if (err) setNote({ ok: false, text: err });
    await refresh();
  };

  /**
   * Actually test it, and say what happened.
   *
   * This was `fetch(...).catch(() => {})` — the server computes a real
   * answer (`deliverNotification` → `{ ok }`) and the client threw it away,
   * so a button labelled "Test" rendered nothing either way and was
   * indistinguishable from a dead one.
   */
  const test = async (id: string): Promise<void> => {
    setNote(null);
    try {
      const res = await fetch(`/api/notifiers/${id}/test`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setNote({ ok: false, text: data.error ?? 'Could not send the test.' });
        return;
      }
      setNote(
        data.ok === true
          ? { ok: true, text: 'Test message delivered — check the channel.' }
          : {
              ok: false,
              text: 'The server could not deliver it. Check the webhook URL or token.',
            },
      );
    } catch {
      setNote({ ok: false, text: 'Not connected — no test was sent.' });
    }
  };

  const toggleEvent = (e: NotifyEvent): void =>
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  return (
    <div className="space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">
        Notifications
      </div>
      <div className="text-[11px] text-slate-500 leading-snug">
        Post fleet events to Slack or Telegram. Combined with webhook routines,
        you can drive and monitor Solix from your phone.
      </div>

      <div className="rounded border border-solix-border bg-black/20 p-2 space-y-2">
        <div className="flex gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as 'slack' | 'telegram')}
            className="text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 focus:outline-none focus:border-solix-accent"
          >
            <option value="slack">Slack</option>
            <option value="telegram">Telegram</option>
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Eng channel)"
            className="flex-1 text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
          />
        </div>
        {provider === 'slack' ? (
          <input
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="Incoming webhook URL"
            className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
          />
        ) : (
          <div className="flex gap-2">
            <input
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="Bot token"
              className="flex-1 text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
            />
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="Chat id"
              className="w-28 text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
            />
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {NOTIFY_EVENTS.map((e) => (
            <button
              key={e.value}
              onClick={() => toggleEvent(e.value)}
              className={`text-[10px] px-1.5 py-0.5 rounded border ${
                events.includes(e.value)
                  ? 'border-solix-accent/60 text-solix-accent bg-solix-accent/10'
                  : 'border-solix-border text-slate-400'
              }`}
            >
              {e.label}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          block
          onClick={() => void add()}
          disabled={!name.trim()}
          busy={busy}
        >
          Add notifier
        </Button>
      </div>

      {note && (
        <div
          role="status"
          className={`text-[11px] ${note.ok ? 'text-solix-ok' : 'text-solix-danger'}`}
        >
          {note.text}
        </div>
      )}

      {list.length === 0 && (
        <ListPlaceholder
          state={state}
          label="notifiers"
          onRetry={() => void refresh()}
          empty="No notifiers yet. Add one above to get fleet events in Slack or Telegram."
        />
      )}

      {list.map((n) => (
        <div
          key={n.id}
          className="rounded border border-solix-border bg-black/20 p-2 flex items-center gap-2 text-xs"
        >
          <span className="text-slate-500">{n.provider === 'slack' ? '💬' : '✈'}</span>
          <div className="flex-1 min-w-0">
            <div className="text-slate-200 truncate">{n.name}</div>
            <div className="text-[10px] text-slate-500 truncate">
              {n.events.join(', ') || 'no events'}
            </div>
          </div>
          <button onClick={() => void test(n.id)} className="text-slate-400 hover:text-slate-100">
            Test
          </button>
          <button onClick={() => void toggle(n)} className="text-slate-400 hover:text-slate-100">
            {n.enabled ? 'On' : 'Off'}
          </button>
          <button onClick={() => void remove(n.id)} className="text-solix-danger/80 hover:text-solix-danger">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function ConnectionCard({
  conn,
  onChanged,
}: {
  conn: Connection;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [scope, setScope] = useState('');

  const [err, setErr] = useState<string | null>(null);

  /**
   * Setting a secret, granting a scope, revoking one, deleting the whole
   * connection — all of it went through here, and all of it was swallowed.
   * A 500 on a secret cleared the inputs and the key simply never appeared.
   * Secret values are write-only by design, so there is no way to notice
   * later that it did not land.
   */
  const call = async (
    path: string,
    body?: unknown,
    method = 'POST',
  ): Promise<boolean> => {
    setErr(null);
    const failure = await write(`/api/connections/${conn.id}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (failure) {
      setErr(failure);
      return false;
    }
    await onChanged();
    return true;
  };

  return (
    <div className="rounded border border-solix-border bg-black/20 p-3 space-y-2">
      {err && (
        <div role="status" className="text-[11px] text-solix-danger">
          {err}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-100">
          {conn.name}{' '}
          <span className="text-[9px] uppercase tracking-wide text-slate-500">
            {conn.kind}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void call('', undefined, 'DELETE')}
          className="!border-transparent !text-solix-danger/80 hover:!text-solix-danger"
        >
          Delete
        </Button>
      </div>

      <div className="text-[11px] text-slate-400">
        Secrets:{' '}
        {conn.secretKeys.length ? (
          conn.secretKeys.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 font-mono bg-black/40 rounded px-1.5 py-0.5 mr-1"
            >
              {k}
              <button
                onClick={() => void call(`/secrets/${encodeURIComponent(k)}`, undefined, 'DELETE')}
                className="text-slate-500 hover:text-solix-danger"
                aria-label={`remove ${k}`}
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-slate-600 italic">none</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="SECRET_KEY"
          className="flex-1 text-[11px] font-mono bg-black/40 border border-solix-border rounded p-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
          placeholder="value (write-only)"
          className="flex-1 text-[11px] bg-black/40 border border-solix-border rounded p-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
        />
        <Button variant="primary" size="sm"
          onClick={() => {
            if (key.trim() && value) {
              void call('/secrets', { key: key.trim(), value }).then(() => {
                setKey('');
                setValue('');
              });
            }
          }}
          disabled={!key.trim() || !value}
        >
          Set
        </Button>
      </div>

      <div className="text-[11px] text-slate-400">
        Granted to:{' '}
        {conn.grants.length ? (
          conn.grants.map((g) => (
            <span
              key={g}
              className="inline-flex items-center gap-1 bg-black/40 rounded px-1.5 py-0.5 mr-1"
            >
              {g}
              <button
                onClick={() => void call(`/grants/${encodeURIComponent(g)}`, undefined, 'DELETE')}
                className="text-slate-500 hover:text-solix-danger"
                aria-label={`revoke ${g}`}
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-solix-warn italic">nobody — no worker can use it</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder="advisor role, plan id, or *"
          className="flex-1 text-[11px] bg-black/40 border border-solix-border rounded p-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
        />
        <Button variant="ghost" size="sm"
          onClick={() => {
            if (scope.trim())
              void call('/grants', { scope: scope.trim() }).then(() => setScope(''));
          }}
          disabled={!scope.trim()}
        >
          Grant
        </Button>
      </div>
    </div>
  );
}
