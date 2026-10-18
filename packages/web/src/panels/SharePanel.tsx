import { useEffect, useState } from 'react';
import type {
  AuditEvent,
  AuditKind,
  GalaxyManifest,
  GalaxyManifestDiff,
  GalaxyVersion,
  TeamTemplate,
} from '@solix/shared';
import { diffManifests } from '@solix/shared';
import { useSolixStore } from '../store/index.js';
import { RightDock, TabButton } from './RightDock.js';

interface ImportResponse {
  ok: boolean;
  advisorsEnabled: number;
  advisorsDisabled: number;
  projectsHinted: number;
  error?: string;
}

interface SharePanelProps {
  open: boolean;
  onClose: () => void;
}

type Tab = 'share' | 'teams' | 'versions' | 'audit';

export function SharePanel({
  open,
  onClose,
}: SharePanelProps): JSX.Element | null {
  const [tab, setTab] = useState<Tab>('share');
  const [name, setName] = useState('My Galaxy');
  const [importText, setImportText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Two-step import: first click *previews* the diff (when possible) and
  // sets pendingImport; second click in PendingImportPanel actually
  // applies it. Closes the silent-overwrite hole.
  const [pendingImport, setPendingImport] = useState<{
    body: BodyInit;
    label: string;
    diff?: GalaxyManifestDiff;
    manifest?: GalaxyManifest;
  } | null>(null);
  const sessionsCount = useSolixStore(
    (s) => Object.keys(s.sessions).length,
  );
  const advisorsEnabledCount = useSolixStore(
    (s) => Object.values(s.advisors).filter((a) => a.enabled).length,
  );
  const skillsCount = useSolixStore((s) => Object.keys(s.skills).length);

  if (!open) return null;

  const onExport = async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const params = new URLSearchParams({ name });
      const res = await fetch(`/api/galaxy/export?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();
      const blob = new Blob([JSON.stringify(manifest, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.toLowerCase().replace(/\s+/g, '-')}.galaxy.json`;
      a.click();
      URL.revokeObjectURL(url);
      setResult('Downloaded.');
    } catch (err) {
      setResult(`Export failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const submitImport = async (body: BodyInit): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/galaxy/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = (await res.json()) as ImportResponse;
      if (data.ok) {
        setResult(
          `Imported: ${data.advisorsEnabled} enabled, ${data.advisorsDisabled} disabled, ${data.projectsHinted} projects.`,
        );
        setImportText('');
        setImportUrl('');
      } else {
        setResult(`Import failed: ${data.error ?? 'unknown'}`);
      }
    } catch (err) {
      setResult(`Import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const stageImport = async (
    body: BodyInit,
    label: string,
    incoming?: GalaxyManifest,
  ): Promise<void> => {
    setResult(null);
    let diff: GalaxyManifestDiff | undefined;
    let manifest = incoming;
    if (manifest) {
      try {
        const res = await fetch('/api/galaxy/export?preview=1');
        if (res.ok) {
          const current = (await res.json()) as GalaxyManifest;
          diff = diffManifests(current, manifest);
        }
      } catch {
        // Diff is best-effort — falling through to a plain confirm is fine.
      }
    }
    setPendingImport({ body, label, diff, manifest });
  };

  const onImportText = (): void => {
    let parsed: GalaxyManifest | undefined;
    try {
      parsed = JSON.parse(importText) as GalaxyManifest;
    } catch {
      setResult('Could not parse JSON.');
      return;
    }
    void stageImport(importText, 'pasted manifest', parsed);
  };

  const onImportUrl = (): void => {
    void stageImport(
      JSON.stringify({ url: importUrl }),
      `URL: ${importUrl}`,
      undefined,
    );
  };

  const confirmPendingImport = (): void => {
    if (!pendingImport) return;
    const body = pendingImport.body;
    setPendingImport(null);
    void submitImport(body);
  };

  const cancelPendingImport = (): void => {
    setPendingImport(null);
  };

  return (
    <RightDock>
      <div className="px-4 py-3 border-b border-solix-border flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-solix-accent">
            Galaxy
          </div>
          <div className="text-lg font-semibold">Share your space</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {advisorsEnabledCount} advisors · {skillsCount} skills ·{' '}
            {sessionsCount} sessions
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

      <div className="flex border-b border-solix-border text-xs">
        <TabButton active={tab === 'share'} onClick={() => setTab('share')}>
          Sharing
        </TabButton>
        <TabButton active={tab === 'teams'} onClick={() => setTab('teams')}>
          Teams
        </TabButton>
        <TabButton
          active={tab === 'versions'}
          onClick={() => setTab('versions')}
        >
          Versions
        </TabButton>
        <TabButton active={tab === 'audit'} onClick={() => setTab('audit')}>
          Audit
        </TabButton>
      </div>

      {tab === 'audit' ? (
        <AuditTab open={open} />
      ) : tab === 'teams' ? (
        <TeamsTab open={open} />
      ) : tab === 'versions' ? (
        <VersionsTab open={open} />
      ) : (
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <section>
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
            Export
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Galaxy name"
            className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
          />
          <button
            onClick={() => void onExport()}
            disabled={busy}
            className="mt-2 w-full py-2 rounded bg-solix-accent/20 border border-solix-accent text-solix-accent text-sm hover:bg-solix-accent/30 disabled:opacity-50"
          >
            Download manifest (.galaxy.json)
          </button>
        </section>

        <section>
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
            Import from URL
          </div>
          <input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://… or local server URL"
            className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
          />
          <button
            onClick={onImportUrl}
            disabled={busy || !importUrl.trim()}
            className="mt-2 w-full py-2 rounded bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 text-sm hover:bg-cyan-500/25 disabled:opacity-50"
          >
            Pull and import
          </button>
        </section>

        <section>
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
            Import from JSON
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste a galaxy manifest JSON here…"
            rows={10}
            className="w-full text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent font-mono resize-none"
          />
          <button
            onClick={onImportText}
            disabled={busy || !importText.trim()}
            className="mt-2 w-full py-2 rounded bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 text-sm hover:bg-cyan-500/25 disabled:opacity-50"
          >
            Apply manifest
          </button>
        </section>

        {pendingImport && (
          <PendingImportPanel
            label={pendingImport.label}
            diff={pendingImport.diff}
            manifest={pendingImport.manifest}
            busy={busy}
            onConfirm={confirmPendingImport}
            onCancel={cancelPendingImport}
          />
        )}

        {result && (
          <div className="text-xs text-slate-300 border border-solix-border rounded p-2 bg-black/30">
            {result}
          </div>
        )}
      </div>
      )}

      <div className="px-4 py-3 border-t border-solix-border text-xs text-slate-500">
        {tab === 'audit'
          ? 'Append-only history. Read-only.'
          : tab === 'versions'
            ? 'Each export snapshots a version. Identical re-exports are deduped.'
            : "Imports never spawn pinned advisors or run shell commands. You're in control."}
      </div>
    </RightDock>
  );
}

/** Plain-language statement of what a template's routines will actually do —
 *  an interval routine launches a real agent session on a cadence and spends
 *  money on every run, which is easy to miss in a one-click install. */
function describeRoutineCost(t: TeamTemplate): string {
  const interval = t.routines.filter((r) => (r.trigger ?? 'interval') === 'interval');
  const webhook = t.routines.filter((r) => r.trigger === 'webhook');
  const manual = t.routines.filter((r) => r.trigger === 'manual');
  const parts: string[] = [];
  if (interval.length) {
    const cadences = [...new Set(interval.map((r) => r.cadence ?? '1h'))].join(', ');
    parts.push(
      `${interval.length} runs automatically every ${cadences} — each run starts a real agent session and costs money.`,
    );
  }
  if (webhook.length) parts.push(`${webhook.length} fires only when its webhook URL is called.`);
  if (manual.length) parts.push(`${manual.length} runs only when you trigger it.`);
  return parts.join(' ');
}

/** P2 #7 — ready-made team templates: pick a project, install an advisor+skill+
 *  routine bundle in one click. */
function TeamsTab({ open }: { open: boolean }): JSX.Element {
  const projects = useSolixStore((s) => s.projects);
  const installTeamTemplate = useSolixStore((s) => s.installTeamTemplate);
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // Routines are the only part of a team install with an ongoing effect, so
  // they're an explicit, declinable choice rather than a silent side effect.
  const [includeRoutines, setIncludeRoutines] = useState(true);

  const projectList = Object.values(projects).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );
  const effectiveCwd = cwd || projectList[0]?.cwd || '';

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetch('/api/teams/templates')
      .then((r) => r.json())
      .then((list: TeamTemplate[]) => {
        if (live) setTemplates(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open]);

  const onInstall = async (id: string): Promise<void> => {
    if (!effectiveCwd.trim()) {
      setNote({ ok: false, text: 'Pick or type a project first.' });
      return;
    }
    setBusy(id);
    setNote(null);
    const res = await installTeamTemplate(id, effectiveCwd.trim(), includeRoutines);
    setBusy(null);
    if (res.ok) {
      const warns = res.warnings?.length ? ` (${res.warnings.length} skipped)` : '';
      setNote({ ok: true, text: `Installed "${id}"${warns}.` });
    } else {
      setNote({ ok: false, text: res.error ?? 'Install failed.' });
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">
          Install into project
        </div>
        {projectList.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && setCwd(e.target.value)}
            className="w-full text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 mb-2 focus:outline-none focus:border-solix-accent"
          >
            <option value="">Choose a project…</option>
            {projectList.map((p) => (
              <option key={p.id} value={p.cwd}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input
          value={effectiveCwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="/path/to/project"
          className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
        />
      </div>

      {note && (
        <div
          className={`text-[11px] rounded px-2 py-1 border ${
            note.ok
              ? 'text-solix-ok border-solix-ok/40 bg-solix-ok/10'
              : 'text-solix-danger border-solix-danger/40 bg-solix-danger/10'
          }`}
        >
          {note.text}
        </div>
      )}

      <div className="space-y-3">
        {templates.map((t) => (
          <div key={t.id} className="rounded border border-solix-border bg-black/20 p-3">
            <div className="text-sm font-semibold text-slate-100">{t.name}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">{t.description}</div>
            <div className="text-[10px] text-slate-500 mt-1.5 space-y-0.5">
              <div>advisors · {t.advisors.join(', ') || '—'}</div>
              {t.skills.length > 0 && <div>skills · {t.skills.join(', ')}</div>}
              {t.routines.length > 0 && (
                <div>routines · {t.routines.map((r) => r.name).join(', ')}</div>
              )}
            </div>
            {t.routines.length > 0 && (
              <label className="mt-2 flex items-start gap-2 text-[10px] rounded px-2 py-1.5 border border-solix-warn/40 bg-solix-warn/10 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeRoutines}
                  onChange={(e) => setIncludeRoutines(e.target.checked)}
                  className="mt-0.5 accent-amber-400"
                />
                <span className="text-slate-300">
                  Also create {t.routines.length} routine
                  {t.routines.length === 1 ? '' : 's'}.{' '}
                  {describeRoutineCost(t)}
                </span>
              </label>
            )}
            <button
              onClick={() => void onInstall(t.id)}
              disabled={busy === t.id}
              className="mt-2 w-full py-1.5 rounded bg-amber-500/20 border border-amber-400/60 text-amber-100 text-xs hover:bg-amber-500/30 disabled:opacity-40"
            >
              {busy === t.id ? 'Installing…' : 'Install team'}
            </button>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="text-xs text-slate-500 italic">No team templates.</div>
        )}
      </div>
    </div>
  );
}

const ALL_KINDS: AuditKind[] = [
  'permission_approved',
  'permission_denied',
  'advisor_invoked',
  'advisor_pinned',
  'advisor_unpinned',
  'galaxy_imported',
];

function AuditTab({ open }: { open: boolean }): JSX.Element {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filter, setFilter] = useState<AuditKind | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `/api/audit${filter === 'all' ? '' : `?kind=${filter}`}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((rows: AuditEvent[]) => {
        if (!cancelled) setEvents(rows);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, filter]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        <FilterChip
          label="all"
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        {ALL_KINDS.map((k) => (
          <FilterChip
            key={k}
            label={shortKind(k)}
            active={filter === k}
            onClick={() => setFilter(k)}
          />
        ))}
      </div>

      {loading && (
        <div className="text-xs text-slate-500 italic">Loading…</div>
      )}
      {error && (
        <div className="text-xs text-solix-danger italic">
          Could not load audit events: {error}
        </div>
      )}

      {!loading && events.length === 0 && (
        <div className="text-xs text-slate-500 italic">
          No audit events yet. Approve a permission or invoke an advisor and
          they'll start appearing here.
        </div>
      )}

      <ul className="space-y-1.5">
        {events.map((ev) => (
          <li
            key={ev.id}
            className="rounded border border-solix-border bg-black/20 p-2"
          >
            <div className="flex items-center justify-between text-[10px]">
              <span className={`uppercase tracking-wide ${kindColor(ev.kind)}`}>
                {shortKind(ev.kind)}
              </span>
              <span className="text-slate-500 font-mono">
                {new Date(ev.ts).toLocaleString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </div>
            <div className="text-[12px] text-slate-100 mt-1 leading-snug">
              {ev.summary}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-2 py-0.5 rounded border ${
        active
          ? 'bg-solix-accent/15 border-solix-accent text-solix-accent'
          : 'border-solix-border text-slate-400 hover:text-slate-200'
      }`}
    >
      {label}
    </button>
  );
}

function shortKind(k: AuditKind | 'all'): string {
  if (k === 'all') return 'all';
  return k.replace(/_/g, ' ');
}

function kindColor(k: AuditKind): string {
  if (k === 'permission_approved') return 'text-solix-ok';
  if (k === 'permission_denied') return 'text-solix-danger';
  if (k === 'galaxy_imported') return 'text-cyan-300';
  if (k.startsWith('advisor_')) return 'text-amber-300';
  return 'text-slate-300';
}

interface DiffPayload {
  from: { id: string; ordinal: number; ts: number };
  to: { id: string; ordinal: number; ts: number };
  diff: GalaxyManifestDiff;
}

function VersionsTab({ open }: { open: boolean }): JSX.Element {
  const [versions, setVersions] = useState<GalaxyVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two clicks to compare: first sets `from`, second sets `to`.
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch('/api/galaxy/versions')
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((rows: GalaxyVersion[]) => {
        if (!cancelled) setVersions(rows);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!fromId || !toId) {
      setDiff(null);
      return;
    }
    if (fromId === toId) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    fetch(`/api/galaxy/diff?from=${fromId}&to=${toId}`)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((d: DiffPayload) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDiff(null);
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fromId, toId]);

  const onPick = (id: string): void => {
    if (!fromId) {
      setFromId(id);
    } else if (!toId && id !== fromId) {
      setToId(id);
    } else {
      // Reset selection — start over from this version.
      setFromId(id);
      setToId(null);
      setDiff(null);
    }
  };

  const clearSelection = (): void => {
    setFromId(null);
    setToId(null);
    setDiff(null);
  };

  const promptKey = (v: GalaxyVersion): 'from' | 'to' | null =>
    v.id === fromId ? 'from' : v.id === toId ? 'to' : null;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {(fromId || toId) && (
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <div>
            {fromId && !toId && 'Pick a second version to diff…'}
            {fromId && toId && diffLoading && 'Computing diff…'}
            {fromId && toId && !diffLoading && diff && (
              <>
                v{diff.from.ordinal} → v{diff.to.ordinal}
              </>
            )}
          </div>
          <button
            onClick={clearSelection}
            className="text-slate-500 hover:text-slate-100"
          >
            clear
          </button>
        </div>
      )}

      {diff && <DiffView diff={diff.diff} />}

      {loading && (
        <div className="text-xs text-slate-500 italic">Loading…</div>
      )}
      {error && (
        <div className="text-xs text-solix-danger italic">
          Could not load versions: {error}
        </div>
      )}
      {!loading && versions.length === 0 && (
        <div className="text-xs text-slate-500 italic">
          No versions yet. Hit "Download manifest" on the Sharing tab to
          create one.
        </div>
      )}

      <ul className="space-y-1.5">
        {versions.map((v) => {
          const role = promptKey(v);
          return (
            <li key={v.id}>
              <button
                onClick={() => onPick(v.id)}
                className={`w-full text-left rounded border p-2 ${
                  role === 'from'
                    ? 'border-solix-accent bg-solix-accent/10'
                    : role === 'to'
                      ? 'border-cyan-400 bg-cyan-400/10'
                      : 'border-solix-border bg-black/20 hover:bg-solix-border/30'
                }`}
              >
                <div className="flex items-center justify-between text-[10px]">
                  <span className="uppercase tracking-wide text-slate-400">
                    v{v.ordinal} · {v.name}
                  </span>
                  <span className="text-slate-500 font-mono">
                    {new Date(v.ts).toLocaleString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                <div className="text-[11px] text-slate-300 mt-1">
                  {v.manifest.advisors.length} advisors ·{' '}
                  {v.manifest.skills.length} skills ·{' '}
                  {v.manifest.projects.length} projects
                  {role && (
                    <span className="ml-2 text-[9px] uppercase tracking-wider text-slate-400">
                      [{role}]
                    </span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DiffView({ diff }: { diff: GalaxyManifestDiff }): JSX.Element {
  const empty =
    diff.advisors.added.length === 0 &&
    diff.advisors.removed.length === 0 &&
    diff.advisors.pinChanged.length === 0 &&
    diff.skills.added.length === 0 &&
    diff.skills.removed.length === 0 &&
    diff.projects.added.length === 0 &&
    diff.projects.removed.length === 0;
  if (empty) {
    return (
      <div className="text-xs text-slate-500 italic border border-solix-border rounded p-2 bg-black/20">
        No changes between these versions.
      </div>
    );
  }
  return (
    <div className="rounded border border-solix-border bg-black/30 p-2 space-y-2 text-xs">
      <DiffSection
        label="Advisors"
        added={diff.advisors.added}
        removed={diff.advisors.removed}
      />
      {diff.advisors.pinChanged.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">
            Advisor pin changes
          </div>
          <ul className="mt-1 space-y-0.5">
            {diff.advisors.pinChanged.map((c) => (
              <li key={c.role} className="text-slate-200">
                <span className="font-mono">{c.role}</span>:{' '}
                {c.from ? 'pinned' : 'unpinned'} →{' '}
                {c.to ? 'pinned' : 'unpinned'}
              </li>
            ))}
          </ul>
        </div>
      )}
      <DiffSection
        label="Skills"
        added={diff.skills.added}
        removed={diff.skills.removed}
      />
      <DiffSection
        label="Projects"
        added={diff.projects.added}
        removed={diff.projects.removed}
      />
    </div>
  );
}

/**
 * Confirmation step shown after the user clicks "Apply manifest" or
 * "Pull and import." Renders the diff against the current galaxy when
 * we have the incoming manifest in-hand (paste path); for the URL path
 * we skip the diff and show a simple "fetch + apply" confirmation
 * instead — the server will resolve the URL.
 */
function PendingImportPanel({
  label,
  diff,
  manifest,
  busy,
  onConfirm,
  onCancel,
}: {
  label: string;
  diff?: GalaxyManifestDiff;
  manifest?: GalaxyManifest;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div className="rounded border border-amber-300/60 bg-amber-500/10 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-amber-200">
          confirm import
        </div>
        <div className="text-[10px] text-slate-400 font-mono truncate max-w-[55%]">
          {label}
        </div>
      </div>
      {manifest && (
        <div className="text-xs text-slate-200">
          <span className="font-semibold">{manifest.name}</span>
          {manifest.author && (
            <span className="text-slate-400"> · by {manifest.author}</span>
          )}
        </div>
      )}
      {diff ? (
        <DiffView diff={diff} />
      ) : manifest ? (
        <div className="text-xs text-slate-400 italic">
          Could not compute a diff against the current galaxy. Apply will
          still proceed if you confirm.
        </div>
      ) : (
        <div className="text-xs text-slate-300">
          Solix will fetch the manifest from this URL and apply it. Diff
          preview is only available for pasted JSON.
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          disabled={busy}
          className="flex-1 py-1.5 rounded bg-amber-500/20 border border-amber-300 text-amber-100 text-xs hover:bg-amber-500/30 disabled:opacity-50"
        >
          Apply
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-1.5 rounded border border-solix-border text-slate-300 text-xs hover:text-white disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DiffSection({
  label,
  added,
  removed,
}: {
  label: string;
  added: string[];
  removed: string[];
}): JSX.Element | null {
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <ul className="mt-1 space-y-0.5">
        {added.map((id) => (
          <li key={`+${id}`} className="text-solix-ok">
            + {id}
          </li>
        ))}
        {removed.map((id) => (
          <li key={`-${id}`} className="text-solix-danger">
            − {id}
          </li>
        ))}
      </ul>
    </div>
  );
}
