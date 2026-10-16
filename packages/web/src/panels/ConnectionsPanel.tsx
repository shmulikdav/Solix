import { useEffect, useState } from 'react';
import type { Connection } from '@solix/shared';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Scoped credential store. Add a connection, set secrets (write-only — values
 * are never shown or returned), and grant it to advisor roles / plan ids / '*'.
 * A granted connection's secrets are injected (least-privilege) into matching
 * Maestro workers at dispatch. Self-contained: talks to /api/connections.
 */
export function ConnectionsPanel({ open, onClose }: Props): JSX.Element | null {
  const [conns, setConns] = useState<Connection[]>([]);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'env' | 'mcp'>('env');
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      const r = await fetch('/api/connections');
      setConns((await r.json()) as Connection[]);
    } catch {
      /* server not reachable */
    }
  };

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  if (!open) return null;

  const addConnection = async (): Promise<void> => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    await fetch('/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), kind: newKind }),
    }).catch(() => {});
    setBusy(false);
    setNewName('');
    await refresh();
  };

  return (
    <div className="absolute top-16 right-0 bottom-0 w-full sm:w-[480px] bg-solix-panel border-l border-solix-border backdrop-blur-md flex flex-col z-30">
      <div className="px-5 py-4 border-b border-solix-border flex items-start justify-between shrink-0">
        <div>
          <div className="text-xs uppercase tracking-widest text-solix-accent">
            connections
          </div>
          <div className="text-lg font-semibold mt-0.5">Secrets & access</div>
          <div className="text-xs text-slate-400 mt-1 leading-snug">
            Store API keys once, grant them to agents. A worker only ever sees the
            secrets it's granted — values are write-only and encrypted at rest.
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-100"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

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
            <button
              onClick={() => void addConnection()}
              disabled={busy || !newName.trim()}
              className="px-3 rounded bg-solix-accent/15 border border-solix-accent/50 text-solix-accent text-xs hover:bg-solix-accent/25 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>

        {conns.length === 0 ? (
          <div className="text-xs text-slate-500 italic">
            No connections yet. Add one above (or use{' '}
            <code className="bg-black/40 px-1 rounded">solix connect</code>).
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">
              Connections · {conns.length}
            </div>
            {conns.map((c) => (
              <ConnectionCard key={c.id} conn={c} onChanged={refresh} />
            ))}
          </div>
        )}
      </div>
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

  const call = async (path: string, body?: unknown, method = 'POST'): Promise<void> => {
    await fetch(`/api/connections/${conn.id}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => {});
    await onChanged();
  };

  return (
    <div className="rounded border border-solix-border bg-black/20 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-100">
          {conn.name}{' '}
          <span className="text-[9px] uppercase tracking-wide text-slate-500">
            {conn.kind}
          </span>
        </div>
        <button
          onClick={() => void call('', undefined, 'DELETE')}
          className="text-[10px] text-solix-danger/80 hover:text-solix-danger"
        >
          delete
        </button>
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
        <button
          onClick={() => {
            if (key.trim() && value) {
              void call('/secrets', { key: key.trim(), value }).then(() => {
                setKey('');
                setValue('');
              });
            }
          }}
          disabled={!key.trim() || !value}
          className="px-2 rounded bg-solix-accent/15 border border-solix-accent/50 text-solix-accent text-[11px] hover:bg-solix-accent/25 disabled:opacity-40"
        >
          set
        </button>
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
        <button
          onClick={() => {
            if (scope.trim())
              void call('/grants', { scope: scope.trim() }).then(() => setScope(''));
          }}
          disabled={!scope.trim()}
          className="px-2 rounded bg-black/30 border border-solix-border text-slate-300 text-[11px] hover:bg-black/50 disabled:opacity-40"
        >
          grant
        </button>
      </div>
    </div>
  );
}
