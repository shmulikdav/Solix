import { useMemo, useState } from 'react';
import type { Advisor, Mission, Project, Session } from '@solix/shared';
import {
  selectAdvisorPlanets,
  selectPlanets,
  useSolixStore,
} from '../store/index.js';
import { modelColor, statusLabel } from '../scene/colors.js';
import { computeHealth, healthColor } from '../health.js';
import { GLOSSARY } from '../glossary.js';

type SortKey =
  | 'name'
  | 'status'
  | 'progress'
  | 'context'
  | 'lastActivity'
  | 'needs'
  | 'health'
  | 'cost';

interface Row {
  session: Session;
  project?: Project;
  mission?: Mission;
  needsAttention: boolean;
  health: number;
  healthReasons: string[];
}

const STATUS_PRIORITY: Record<string, number> = {
  awaiting_permission: 0,
  awaiting_input: 1,
  plan_review: 2,
  error: 3,
  active: 4,
  spawning: 5,
  idle: 6,
  terminated: 7,
};

/**
 * Tabular fallback view that scales past ~10 agents where the solar-system
 * metaphor breaks down. Toggled from the TopBar (or pressing V).
 *
 * Rows = every visible session (user planet + pinned advisor session).
 * Subagent moons hide here — they're tied to a parent's mission.
 *
 * Grouped by project so a team running multiple repos sees them as
 * separate sections. Within each group, columns are click-to-sort.
 */
export function ListView(): JSX.Element {
  const planets = useSolixStore(selectPlanets);
  const advisorPlanets = useSolixStore(selectAdvisorPlanets);
  const projects = useSolixStore((s) => s.projects);
  const missions = useSolixStore((s) => s.missions);
  const pendingPermissions = useSolixStore((s) => s.pendingPermissions);
  const selectSession = useSolixStore((s) => s.selectSession);
  const selectedSessionIds = useSolixStore((s) => s.selectedSessionIds);
  const toggleSessionSelection = useSolixStore(
    (s) => s.toggleSessionSelection,
  );
  const clearSessionSelection = useSolixStore(
    (s) => s.clearSessionSelection,
  );
  const terminateSessions = useSolixStore((s) => s.terminateSessions);

  const [sortKey, setSortKey] = useState<SortKey>('needs');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const allRows = useMemo<Row[]>(() => {
    const sessionsToRow = [...planets, ...advisorPlanets];
    const sessionsWithPermission = new Set(
      Object.values(pendingPermissions).map((p) => p.sessionId),
    );
    return sessionsToRow.map((s) => {
      const mission = s.currentMissionId
        ? missions[s.currentMissionId]
        : undefined;
      const pendingForSession = Object.values(pendingPermissions).filter(
        (p) => p.sessionId === s.id,
      ).length;
      const { score, reasons } = computeHealth(s, mission, pendingForSession);
      return {
        session: s,
        project: projects[s.projectId],
        mission,
        needsAttention:
          sessionsWithPermission.has(s.id) ||
          s.status === 'awaiting_permission' ||
          s.status === 'awaiting_input' ||
          s.status === 'plan_review',
        health: score,
        healthReasons: reasons,
      };
    });
  }, [planets, advisorPlanets, projects, missions, pendingPermissions]);

  const groups = useMemo(() => {
    const map = new Map<string, { project?: Project; rows: Row[] }>();
    for (const row of allRows) {
      const id = row.project?.id ?? '_';
      const existing = map.get(id);
      if (existing) existing.rows.push(row);
      else map.set(id, { project: row.project, rows: [row] });
    }
    return [...map.values()].sort(
      (a, b) =>
        (b.project?.lastActiveAt ?? 0) - (a.project?.lastActiveAt ?? 0),
    );
  }, [allRows]);

  const cmp = (a: Row, b: Row): number => {
    const dir = sortDir === 'asc' ? 1 : -1;
    switch (sortKey) {
      case 'name':
        return ((a.session.name ?? a.session.id) >
        (b.session.name ?? b.session.id)
          ? 1
          : -1) * dir;
      case 'status':
        return (
          ((STATUS_PRIORITY[a.session.status] ?? 99) -
            (STATUS_PRIORITY[b.session.status] ?? 99)) *
          dir
        );
      case 'progress':
        return (
          ((a.mission?.metrics.toolCallCount ?? 0) -
            (b.mission?.metrics.toolCallCount ?? 0)) *
          dir
        );
      case 'context':
        return (a.session.contextUsagePct - b.session.contextUsagePct) * dir;
      case 'lastActivity':
        return (a.session.updatedAt - b.session.updatedAt) * dir;
      case 'needs':
        // True first when ascending — that's "needs attention at top".
        if (a.needsAttention === b.needsAttention) return 0;
        return a.needsAttention ? -1 * dir : 1 * dir;
      case 'health':
        return (a.health - b.health) * dir;
      case 'cost':
        return (a.session.costUsd - b.session.costUsd) * dir;
    }
  };

  const onSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'lastActivity' ? 'desc' : 'asc');
    }
  };

  const sortIndicator = (key: SortKey): string =>
    sortKey !== key ? '' : sortDir === 'asc' ? ' ▲' : ' ▼';

  const selectedCount = selectedSessionIds.size;

  return (
    <div className="absolute inset-0 overflow-y-auto bg-solix-bg pt-20 pb-20 px-6 z-0">
      {selectedCount > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
          <div className="rounded-full border border-solix-accent/60 bg-solix-panel/95 backdrop-blur shadow-2xl px-4 py-2 flex items-center gap-3">
            <span className="text-xs text-slate-200 font-mono">
              {selectedCount} selected
            </span>
            <button
              onClick={() =>
                terminateSessions([...selectedSessionIds])
              }
              className="text-xs px-3 py-1 rounded border border-solix-danger text-solix-danger hover:bg-solix-danger/15"
            >
              Terminate
            </button>
            <button
              onClick={clearSessionSelection}
              className="text-xs text-slate-400 hover:text-slate-200"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto">
        <div className="text-xs text-slate-500 uppercase tracking-widest mb-3">
          List view · {allRows.length} agent{allRows.length === 1 ? '' : 's'}
        </div>

        {allRows.length === 0 ? (
          <div className="text-sm text-slate-500 italic py-12 text-center border border-solix-border rounded">
            No agents yet. Run <code>claude</code> in any terminal — a row
            will appear here within a second.
          </div>
        ) : (
          groups.map(({ project, rows }) => {
            const sorted = [...rows].sort(cmp);
            const projectName = project?.name ?? '(unassigned)';
            return (
              <section
                key={project?.id ?? '_'}
                className="mb-8 rounded border border-solix-border overflow-hidden"
              >
                <header className="bg-solix-panel/60 px-4 py-2 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-semibold text-slate-100">
                      {projectName}
                    </span>
                    <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-500">
                      {rows.length} agent{rows.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {project?.cwd && (
                    <span className="text-[10px] font-mono text-slate-500 truncate max-w-[55%]">
                      {project.cwd}
                    </span>
                  )}
                </header>

                <table className="w-full text-sm">
                  <thead className="bg-black/30 text-[10px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <Th>
                        <input
                          type="checkbox"
                          aria-label="Select all in project"
                          checked={
                            sorted.length > 0 &&
                            sorted.every((r) =>
                              selectedSessionIds.has(r.session.id),
                            )
                          }
                          onChange={(e) => {
                            e.stopPropagation();
                            const allSelected = sorted.every((r) =>
                              selectedSessionIds.has(r.session.id),
                            );
                            for (const r of sorted) {
                              const isSel = selectedSessionIds.has(r.session.id);
                              if (allSelected && isSel) {
                                toggleSessionSelection(r.session.id);
                              } else if (!allSelected && !isSel) {
                                toggleSessionSelection(r.session.id);
                              }
                            }
                          }}
                          className="cursor-pointer"
                        />
                      </Th>
                      <Th onClick={() => onSort('needs')}>
                        ● {sortIndicator('needs')}
                      </Th>
                      <Th onClick={() => onSort('name')}>
                        Agent{sortIndicator('name')}
                      </Th>
                      <Th>Advisor</Th>
                      <Th onClick={() => onSort('status')}>
                        Status{sortIndicator('status')}
                      </Th>
                      <Th onClick={() => onSort('health')} numeric>
                        Health{sortIndicator('health')}
                      </Th>
                      <Th onClick={() => onSort('progress')}>
                        Mission · tools{sortIndicator('progress')}
                      </Th>
                      <Th onClick={() => onSort('context')} numeric>
                        Context{sortIndicator('context')}
                      </Th>
                      <Th onClick={() => onSort('cost')} numeric>
                        Cost{sortIndicator('cost')}
                      </Th>
                      <Th onClick={() => onSort('lastActivity')} numeric>
                        Last activity{sortIndicator('lastActivity')}
                      </Th>
                      <Th numeric>Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((row) => (
                      <tr
                        key={row.session.id}
                        onClick={() => selectSession(row.session.id)}
                        className={`group border-t border-solix-border hover:bg-solix-border/20 cursor-pointer ${
                          row.needsAttention ? 'bg-solix-danger/5' : ''
                        } ${
                          selectedSessionIds.has(row.session.id)
                            ? 'bg-solix-accent/5'
                            : ''
                        }`}
                      >
                        <td
                          className="px-3 py-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label="Select agent"
                            checked={selectedSessionIds.has(row.session.id)}
                            onChange={() =>
                              toggleSessionSelection(row.session.id)
                            }
                            className="cursor-pointer"
                          />
                        </td>
                        <td className="px-3 py-2">
                          {row.needsAttention ? (
                            <span className="inline-block w-2 h-2 rounded-full bg-solix-danger solix-pulse" />
                          ) : row.session.status === 'active' ? (
                            <span className="inline-block w-2 h-2 rounded-full bg-solix-ok" />
                          ) : (
                            <span className="inline-block w-2 h-2 rounded-full bg-slate-600" />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-block w-2 h-2 rounded-full"
                              style={{
                                background: modelColor(row.session.model),
                              }}
                              title={String(row.session.model)}
                            />
                            <span className="text-slate-100 font-medium">
                              {row.session.name ??
                                row.session.id.slice(0, 8)}
                            </span>
                            {row.session.kind === 'advisor' && (
                              <span className="text-[9px] uppercase tracking-wide text-amber-300">
                                advisor
                              </span>
                            )}
                            {row.session.runtime === 'codex' && (
                              <span
                                className="text-[9px] uppercase tracking-wide text-emerald-300"
                                title="OpenAI Codex session"
                              >
                                codex
                              </span>
                            )}
                            {row.session.origin === 'agentview' && (
                              <span
                                className="text-[9px] uppercase tracking-wide text-cyan-300"
                                title="Background session managed by Anthropic's Agent View"
                              >
                                agent
                              </span>
                            )}
                            {row.session.wrapperSocketPath && (
                              <span
                                className="text-[9px] uppercase tracking-wide text-solix-accent"
                                title="Wrapped by `solix run` — UI composer is enabled"
                              >
                                wrapped
                              </span>
                            )}
                            {row.session.worktreePath && (
                              <span
                                className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-solix-accent/40 text-solix-accent"
                                title={row.session.worktreePath}
                              >
                                ⌥{branchLabel(row.session.worktreePath)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <AdvisorCell
                            session={row.session}
                            mission={row.mission}
                          />
                        </td>
                        <td
                          className="px-3 py-2 text-xs text-slate-300"
                          title={GLOSSARY[row.session.status] ?? undefined}
                        >
                          {statusLabel(row.session.status)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <HealthBar
                            score={row.health}
                            reasons={row.healthReasons}
                          />
                        </td>
                        <td
                          className="px-3 py-2 text-xs text-slate-300 truncate max-w-xs"
                          title={
                            row.session.agentViewSummary ??
                            row.mission?.shortName ??
                            undefined
                          }
                        >
                          {row.session.agentViewSummary ? (
                            <span className="text-slate-100 italic">
                              {row.session.agentViewSummary}
                            </span>
                          ) : row.mission ? (
                            <>
                              <span className="text-slate-100">
                                {row.mission.shortName}
                              </span>
                              <span className="text-slate-500 ml-1">
                                · {row.mission.metrics.toolCallCount} tools
                              </span>
                            </>
                          ) : (
                            <span className="text-slate-500 italic">
                              idle
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <ContextBar pct={row.session.contextUsagePct} />
                        </td>
                        <td className="px-3 py-2 text-right text-[11px] font-mono">
                          <span
                            className={
                              row.session.costUsd > 0
                                ? 'text-slate-200'
                                : 'text-slate-600'
                            }
                            title="Estimated spend for this agent (from transcript tokens × model pricing)"
                          >
                            ${row.session.costUsd.toFixed(2)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-[11px] text-slate-500 font-mono">
                          {relativeTime(row.session.updatedAt)}
                        </td>
                        <td
                          className="px-3 py-2 text-right"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => terminateSessions([row.session.id])}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-[10px] px-2 py-0.5 rounded border border-solix-danger/50 text-solix-danger hover:bg-solix-danger/15"
                            title="Terminate this agent"
                          >
                            Terminate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * Worktree paths follow `~/.solix/worktrees/<repo>-<branch>`. The chip
 * shows `<repo>-<branch>` (the basename) — short, descriptive, no need
 * to re-shell git for the actual branch name.
 */
function branchLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Resolves which advisor (if any) a session is associated with and renders
 * a compact chip. Two paths:
 *   - session.kind === 'advisor' → look up by advisorRole
 *   - regular user session whose latest mission's prompt was prefixed by
 *     NewTaskModal's `[Acting as <Codename> — ...]` (Sprint F)
 */
const ADVISOR_PROMPT_PREFIX = /^\[Acting as ([^\s—]+)/;

function AdvisorCell({
  session,
  mission,
}: {
  session: Session;
  mission?: Mission;
}): JSX.Element {
  const advisors = useSolixStore((s) => s.advisors);

  let advisor: Advisor | undefined;
  let muted = false;
  if (session.advisorRole) {
    advisor = Object.values(advisors).find(
      (a) => a.id === session.advisorRole,
    );
  } else if (mission?.prompt) {
    const m = mission.prompt.match(ADVISOR_PROMPT_PREFIX);
    const codename = m?.[1]?.toLowerCase();
    if (codename) {
      advisor = Object.values(advisors).find(
        (a) => a.codename.toLowerCase() === codename,
      );
      muted = true;
    }
  }

  if (!advisor) {
    return <span className="text-slate-700">—</span>;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 ${
        muted ? 'opacity-60' : ''
      }`}
      title={advisor.description}
    >
      <span style={{ color: advisor.color }}>{advisor.glyph}</span>
      <span className="text-slate-200">{advisor.codename}</span>
    </span>
  );
}

function Th({
  children,
  onClick,
  numeric,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  numeric?: boolean;
}): JSX.Element {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 select-none ${
        numeric ? 'text-right' : 'text-left'
      } ${onClick ? 'cursor-pointer hover:text-slate-300' : ''}`}
    >
      {children}
    </th>
  );
}

function HealthBar({
  score,
  reasons,
}: {
  score: number;
  reasons: string[];
}): JSX.Element {
  const color = healthColor(score);
  return (
    <div className="relative inline-flex items-center gap-2 group">
      <span
        className="text-[11px] font-mono font-bold"
        style={{ color }}
      >
        {score}
      </span>
      <div className="w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className="h-full"
          style={{
            width: `${Math.max(2, score)}%`,
            background: color,
          }}
        />
      </div>
      <div className="pointer-events-none absolute right-0 top-full mt-1 z-50 hidden group-hover:block w-64 rounded border border-solix-border bg-solix-panel/95 backdrop-blur p-2 text-left shadow-xl">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wide text-slate-400">
            Health
          </span>
          <span className="text-xs font-bold" style={{ color }}>
            {score}/100
          </span>
        </div>
        {reasons.length === 0 ? (
          <div className="text-[11px] text-slate-400 italic">
            All four bands healthy: stable status, no pending decisions,
            context budget, mission progress.
          </div>
        ) : (
          <ul className="space-y-0.5">
            {reasons.map((r) => (
              <li key={r} className="text-[11px] text-slate-200 leading-snug">
                · {r}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ContextBar({ pct }: { pct: number }): JSX.Element {
  const color =
    pct >= 90
      ? 'bg-solix-danger'
      : pct >= 80
        ? 'bg-solix-warn'
        : 'bg-solix-accent';
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[11px] text-slate-400 font-mono">
        {pct.toFixed(0)}%
      </span>
      <div className="w-20 h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div
          className={`h-full ${color}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function relativeTime(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 0) return 'now';
  const sec = Math.floor(dt / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return new Date(ts).toLocaleDateString();
}
