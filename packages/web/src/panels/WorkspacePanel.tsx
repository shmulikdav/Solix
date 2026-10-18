import { useEffect, useState } from 'react';
import type { AuditEvent } from '@solix/shared';
import { selectWorkspaceSummary, useSolixStore } from '../store/index.js';
import { RightDock } from './RightDock.js';

interface WorkspacePanelProps {
  open: boolean;
  onClose: () => void;
}

const usd = (n: number): string =>
  `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const compact = (n: number): string =>
  Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-solix-border bg-black/20 p-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-slate-100">
        {value}
      </div>
      {hint ? (
        <div className="text-[11px] text-slate-500 mt-0.5">{hint}</div>
      ) : null}
    </div>
  );
}

function Chip({
  n,
  label,
  color,
}: {
  n: number;
  label: string;
  color: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      <span className="tabular-nums font-medium text-slate-200">{n}</span>
      <span className="text-slate-500">{label}</span>
    </div>
  );
}

/**
 * Mission Control — the whole-workspace overview opened by clicking the sun.
 * All figures are real (derived by `selectWorkspaceSummary`); `interventions`
 * comes from the persisted audit log, fetched on open like SharePanel's Audit tab.
 */
export function WorkspacePanel({
  open,
  onClose,
}: WorkspacePanelProps): JSX.Element | null {
  const summary = useSolixStore(selectWorkspaceSummary);
  const selectSession = useSolixStore((s) => s.selectSession);
  const [interventions, setInterventions] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([
      fetch('/api/audit?kind=permission_approved').then(
        (r): Promise<AuditEvent[]> => (r.ok ? r.json() : Promise.resolve([])),
      ),
      fetch('/api/audit?kind=permission_denied').then(
        (r): Promise<AuditEvent[]> => (r.ok ? r.json() : Promise.resolve([])),
      ),
    ])
      .then(([approved, denied]) => {
        if (!cancelled) setInterventions(approved.length + denied.length);
      })
      .catch(() => {
        if (!cancelled) setInterventions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const m = summary.missions;
  const missionRows: [string, number][] = [
    ['done', m.completed],
    ['failed', m.failed],
    ['active', m.active],
    ['cancelled', m.cancelled],
  ];

  return (
    <RightDock>
      <div className="px-4 py-3 border-b border-solix-border flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-solix-accent">
            Mission Control
          </div>
          <div className="text-lg font-semibold">Your workspace</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {summary.sessionCount} sessions · {summary.projectCount} projects ·{' '}
            {summary.advisorCount} advisors · {summary.skillCount} skills
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

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* ROI tiles */}
        <div className="grid grid-cols-2 gap-2">
          <Tile label="Total spend" value={usd(summary.totalSpendUsd)} />
          <Tile label="Total tokens" value={compact(summary.totalTokens)} />
          <Tile
            label="Cost / mission"
            value={usd(summary.costPerCompletedMission)}
            hint={`${summary.completedMissions} completed`}
          />
          <Tile
            label="Interventions"
            value={interventions === null ? '—' : String(interventions)}
            hint={`${summary.pendingPermissions} pending now`}
          />
        </div>

        {/* Status */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
            Status
          </div>
          <div className="flex items-center gap-4 text-sm">
            <Chip n={summary.activeCount} label="active" color="bg-solix-ok" />
            <Chip
              n={summary.attentionCount}
              label="need you"
              color="bg-solix-danger"
            />
            <Chip n={summary.idleCount} label="idle" color="bg-slate-600" />
          </div>
        </div>

        {/* Missions */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
            Missions
          </div>
          <div className="grid grid-cols-4 gap-2 text-center">
            {missionRows.map(([label, n]) => (
              <div
                key={label}
                className="rounded border border-solix-border bg-black/20 py-2"
              >
                <div className="text-lg font-semibold tabular-nums">{n}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-500">
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Context pressure */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
            Context pressure
          </div>
          <div className="text-sm text-slate-300 tabular-nums">
            avg {Math.round(summary.contextAvgPct)}% · max{' '}
            <span
              className={
                summary.contextMaxPct >= 85
                  ? 'text-solix-danger font-medium'
                  : ''
              }
            >
              {Math.round(summary.contextMaxPct)}%
            </span>
            {summary.contextMaxPct >= 85 ? (
              <span className="text-solix-danger">
                {' '}
                — an agent is near its limit
              </span>
            ) : null}
          </div>
        </div>

        {/* Needs you */}
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
            Needs you ({summary.needsYou.length})
          </div>
          {summary.needsYou.length === 0 ? (
            <div className="text-sm text-slate-500">
              Nothing waiting — the fleet is running itself.
            </div>
          ) : (
            <div className="space-y-1.5">
              {summary.needsYou.map((s) => (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id)}
                  className="w-full text-left rounded border border-solix-danger/40 bg-solix-danger/5 px-3 py-2 hover:bg-solix-danger/10"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-100 truncate">
                      {s.name ?? s.id.slice(0, 8)}
                    </span>
                    <span className="text-[11px] uppercase tracking-wide text-solix-danger whitespace-nowrap">
                      {s.status.replace(/_/g, ' ')}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </RightDock>
  );
}
