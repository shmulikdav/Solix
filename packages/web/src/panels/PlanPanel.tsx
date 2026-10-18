import { useEffect, useMemo, useState } from 'react';
import type {
  Plan,
  PlanReview,
  PlanTask,
  PlanTaskStatus,
  TaskThreadEntry,
} from '@solix/shared';
import {
  selectPlansArray,
  selectPlanTasks,
  selectTaskThread,
  useSolixStore,
} from '../store/index.js';
import { RightDock } from './RightDock.js';

interface PlanPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * v2 Maestro — the conductor's panel. Type a goal → the orchestrator runs a
 * planner session and returns a task DAG parked at `awaiting_approval`; you
 * review it and approve (dispatch is Phase 2). Right-docked, same archetype as
 * WorkspacePanel / SharePanel.
 */
const TEMPLATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'empty', label: 'Empty' },
  { value: 'node', label: 'Node' },
  { value: 'web', label: 'Web (HTML/CSS)' },
  { value: 'python', label: 'Python' },
];

export function PlanPanel({ open, onClose }: PlanPanelProps): JSX.Element | null {
  const plans = useSolixStore(selectPlansArray);
  const projects = useSolixStore((s) => s.projects);
  const createPlanFromGoal = useSolixStore((s) => s.createPlanFromGoal);
  const createProject = useSolixStore((s) => s.createProject);

  const { managed, observed, defaultCwd } = useMemo(() => {
    const all = Object.values(projects).sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
    const managed = all.filter((p) => p.managed);
    const observed = all.filter((p) => !p.managed);
    return { managed, observed, defaultCwd: (managed[0] ?? all[0])?.cwd ?? '' };
  }, [projects]);

  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState('');
  const [budget, setBudget] = useState(''); // optional plan-wide USD cap
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Full-auto (no approval gate) — only offered when containment is in place.
  const [autoMode, setAutoMode] = useState(false);
  const [containment, setContainment] = useState<{
    ok: boolean;
    reasons: string[];
  } | null>(null);
  const [entitlement, setEntitlement] = useState<{
    tier: 'pro' | 'community';
    reason: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetch('/api/system/containment')
      .then((r) => r.json())
      .then((s: { ok: boolean; reasons: string[] }) => {
        if (live) setContainment(s);
      })
      .catch(() => {
        if (live) setContainment({ ok: false, reasons: ['status unavailable'] });
      });
    void fetch('/api/system/entitlement')
      .then((r) => r.json())
      .then((e: { tier: 'pro' | 'community'; reason: string }) => {
        if (live) setEntitlement(e);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open]);

  // Inline "New project" creator.
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('empty');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  if (!open) return null;

  const effectiveCwd = cwd || defaultCwd;

  const onCreateProject = async (): Promise<void> => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    const res = await createProject(name, { template: newTemplate });
    setCreating(false);
    if (res.ok && res.project) {
      setCwd(res.project.cwd); // build into the project we just made
      setShowNew(false);
      setNewName('');
    } else {
      setCreateError(res.error ?? 'Could not create the project.');
    }
  };

  const onPlan = async (): Promise<void> => {
    const g = goal.trim();
    if (!g || !effectiveCwd.trim() || busy) return;
    setBusy(true);
    setErrors([]);
    setWarnings([]);
    const canAuto =
      autoMode && (containment?.ok ?? false) && entitlement?.tier === 'pro';
    const budgetUsd = Number.parseFloat(budget);
    const res = await createPlanFromGoal(g, effectiveCwd.trim(), {
      autoMode: canAuto,
      ...(Number.isFinite(budgetUsd) && budgetUsd > 0 ? { budgetUsd } : {}),
    });
    setBusy(false);
    if (res.ok) {
      setGoal('');
      setWarnings(res.warnings ?? []);
    } else setErrors(res.errors ?? ['Planning failed.']);
  };

  return (
    <RightDock>
      <div className="px-5 py-4 border-b border-solix-border flex items-start justify-between shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-xs uppercase tracking-widest text-amber-300">
              maestro
            </div>
            {entitlement && (
              <span
                className={`text-[9px] uppercase tracking-wider rounded px-1.5 py-0.5 border ${
                  entitlement.tier === 'pro'
                    ? 'text-amber-200 border-amber-400/50'
                    : 'text-slate-400 border-slate-600'
                }`}
                title={`Entitlement: ${entitlement.reason}`}
              >
                {entitlement.tier === 'pro'
                  ? entitlement.reason === 'beta'
                    ? 'Pro · beta'
                    : 'Pro'
                  : 'Community'}
              </span>
            )}
          </div>
          <div className="text-lg font-semibold mt-0.5">Plan a build</div>
          <div className="text-xs text-slate-400 mt-1 leading-snug">
            Create or pick a project, describe a goal, and Maestro breaks it into
            a task plan you approve — then it dispatches the fleet, verifies each
            step, and drives the build to done.
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
        {/* Project chooser + inline creator */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Project
            </div>
            <button
              onClick={() => setShowNew((v) => !v)}
              className="text-[11px] text-solix-accent hover:text-solix-accent/80"
            >
              {showNew ? 'Cancel' : '＋ New project'}
            </button>
          </div>

          {showNew && (
            <div className="rounded border border-solix-border bg-black/20 p-2 space-y-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Project name"
                className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
              />
              <div className="flex gap-2">
                <select
                  value={newTemplate}
                  onChange={(e) => setNewTemplate(e.target.value)}
                  className="flex-1 text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 focus:outline-none focus:border-solix-accent"
                >
                  {TEMPLATE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => void onCreateProject()}
                  disabled={creating || !newName.trim()}
                  className="px-3 rounded bg-solix-accent/20 border border-solix-accent/60 text-solix-accent text-xs hover:bg-solix-accent/30 disabled:opacity-40"
                >
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
              {createError && (
                <div className="text-[11px] text-solix-danger">{createError}</div>
              )}
            </div>
          )}

          {(managed.length > 0 || observed.length > 0) && (
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) setCwd(e.target.value);
              }}
              className="w-full text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-200 focus:outline-none focus:border-solix-accent"
            >
              <option value="">Choose an existing project…</option>
              {managed.length > 0 && (
                <optgroup label="Your projects">
                  {managed.map((p) => (
                    <option key={p.id} value={p.cwd}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {observed.length > 0 && (
                <optgroup label="Observed">
                  {observed.map((p) => (
                    <option key={p.id} value={p.cwd}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}

          <input
            value={effectiveCwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/project"
            className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
          />
        </div>

        {/* Goal composer */}
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">
            Goal
          </div>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Add a login page with email + password and tests"
            rows={3}
            className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent resize-none"
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">
              Budget cap
            </span>
            <div className="relative flex-1">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                $
              </span>
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                inputMode="decimal"
                placeholder="optional — pauses the plan when spend hits this"
                className="w-full text-xs bg-black/40 border border-solix-border rounded p-2 pl-5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
              />
            </div>
          </div>
          {errors.length > 0 && (
            <div className="text-[11px] text-solix-danger border border-solix-danger/40 bg-solix-danger/10 rounded px-2 py-1 space-y-0.5">
              {errors.map((e) => (
                <div key={e}>· {e}</div>
              ))}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="text-[11px] text-amber-300 border border-amber-400/40 bg-amber-500/10 rounded px-2 py-1 space-y-0.5">
              {warnings.map((w) => (
                <div key={w}>· {w}</div>
              ))}
            </div>
          )}

          {/* Full-auto toggle — gated on worker containment AND a Pro license
              (the server refuses it otherwise, so gate it here to avoid a wasted
              planner run). */}
          {(() => {
            const isPro = entitlement?.tier === 'pro';
            const canFullAuto = (containment?.ok ?? false) && isPro;
            return (
              <label
                className={`flex items-start gap-2 text-[11px] rounded px-2 py-1.5 border ${
                  canFullAuto
                    ? 'border-solix-border bg-black/20 cursor-pointer'
                    : 'border-solix-border/50 bg-black/10 opacity-70'
                }`}
                title={
                  canFullAuto
                    ? 'Skip the approval gate and dispatch immediately.'
                    : !isPro
                      ? 'Full-auto is a Pro feature.'
                      : 'Full-auto needs worker containment enabled first.'
                }
              >
                <input
                  type="checkbox"
                  checked={autoMode && canFullAuto}
                  disabled={!canFullAuto}
                  onChange={(e) => setAutoMode(e.target.checked)}
                  className="mt-0.5 accent-amber-400"
                />
                <span>
                  <span className="text-slate-200">⚡ Full-auto</span>
                  <span className="text-slate-500">
                    {' '}
                    — dispatch without approving the plan.
                  </span>
                  {!isPro && (
                    <span className="block text-slate-500 mt-0.5">
                      Pro feature.
                    </span>
                  )}
                  {isPro && containment && !containment.ok && (
                    <span className="block text-slate-500 mt-0.5">
                      Unavailable: {containment.reasons.join('; ')}.
                    </span>
                  )}
                </span>
              </label>
            );
          })()}

          <div className="text-[10px] text-slate-500 leading-snug">
            Workers are governed by a command denylist and confined to the
            project. That's a guardrail, not a jail — for hard isolation, run
            Solix with an OS sandbox (<span className="font-mono">SOLIX_SANDBOX_CMD</span>).
            Use full-auto for trusted goals.
          </div>

          <button
            onClick={() => void onPlan()}
            disabled={busy || !goal.trim() || !effectiveCwd.trim()}
            className="w-full py-2 rounded bg-solix-warn/20 border border-solix-warn/60 text-solix-warn text-sm hover:bg-solix-warn/30 disabled:opacity-40"
          >
            {busy
              ? 'Planning…'
              : autoMode && containment?.ok
                ? '⚡ Plan & run (full-auto)'
                : '✷ Plan it'}
          </button>
        </div>

        {/* Existing plans */}
        {plans.length === 0 ? (
          <div className="text-xs text-slate-500 italic">
            No plans yet. Describe a goal above to create one.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">
              Plans · {plans.length}
            </div>
            {plans.map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
          </div>
        )}
      </div>
    </RightDock>
  );
}

const PLAN_STATUS_COLOR: Record<Plan['status'], string> = {
  draft: 'text-slate-400 border-slate-600',
  awaiting_approval: 'text-amber-300 border-amber-400/50',
  running: 'text-solix-accent border-solix-accent/50',
  paused: 'text-slate-300 border-slate-500',
  completed: 'text-solix-ok border-solix-ok/50',
  failed: 'text-solix-danger border-solix-danger/50',
};

function PlanCard({ plan }: { plan: Plan }): JSX.Element {
  const tasks = useSolixStore((s) => selectPlanTasks(s, plan.id));
  const budgetAlert = useSolixStore((s) => s.planBudgetAlerts[plan.id]);
  const approvePlan = useSolixStore((s) => s.approvePlan);
  const abortPlan = useSolixStore((s) => s.abortPlan);
  const resumePlan = useSolixStore((s) => s.resumePlan);
  const createPlanFromGoal = useSolixStore((s) => s.createPlanFromGoal);
  const activateLicense = useSolixStore((s) => s.activateLicense);
  const [busy, setBusy] = useState(false);
  const [refine, setRefine] = useState('');
  const [refining, setRefining] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showActivate, setShowActivate] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [activateError, setActivateError] = useState<string | null>(null);

  const finished =
    plan.status === 'completed' ||
    plan.status === 'failed' ||
    plan.status === 'paused';

  const onApprove = async (): Promise<void> => {
    setBusy(true);
    setRunError(null);
    setShowActivate(false);
    const res = await approvePlan(plan.id);
    setBusy(false);
    if (!res.ok) {
      setRunError(res.error ?? 'Could not run the plan.');
      setShowActivate(Boolean(res.upsell)); // only Pro-gated failures offer a key
    }
  };

  const onResume = async (): Promise<void> => {
    setBusy(true);
    setRunError(null);
    setShowActivate(false);
    const res = await resumePlan(plan.id);
    setBusy(false);
    if (!res.ok) {
      setRunError(res.error ?? 'Could not resume the plan.');
      setShowActivate(Boolean(res.upsell));
    }
  };

  const onActivate = async (): Promise<void> => {
    const key = licenseKey.trim();
    if (!key) return;
    setActivateError(null);
    const res = await activateLicense(key);
    if (res.ok) {
      setRunError(null);
      setShowActivate(false);
      setLicenseKey('');
      await onApprove(); // retry the run now that we're Pro
    } else {
      setActivateError(res.error ?? 'Activation failed.');
    }
  };

  const onAbort = async (): Promise<void> => {
    setBusy(true);
    await abortPlan(plan.id);
    setBusy(false);
  };

  const onRefine = async (): Promise<void> => {
    const g = refine.trim();
    if (!g || refining) return;
    setRefining(true);
    // Iterate: a follow-up goal against the SAME project → a fresh plan.
    const res = await createPlanFromGoal(g, plan.cwd);
    setRefining(false);
    if (res.ok) setRefine('');
  };

  return (
    <div className="rounded border border-solix-border bg-black/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-100 truncate">
            {plan.name}
          </div>
          <div className="text-[10px] text-slate-500 truncate">{plan.cwd}</div>
        </div>
        <span
          className={`shrink-0 text-[9px] uppercase tracking-wider border rounded px-1.5 py-0.5 ${
            PLAN_STATUS_COLOR[plan.status] ?? 'text-slate-400 border-slate-600'
          }`}
        >
          {plan.status.replace('_', ' ')}
        </span>
      </div>

      {budgetAlert && plan.status !== 'paused' && (
        <div className="mt-2 text-[10px] text-solix-warn border border-solix-warn/40 bg-solix-warn/10 rounded px-2 py-1">
          ⚠ Budget {Math.round(budgetAlert.pct * 100)}% used — $
          {budgetAlert.spentUsd.toFixed(2)} of ${budgetAlert.budgetUsd.toFixed(2)}.
          The plan pauses at the cap.
        </div>
      )}

      {tasks.length > 0 && (
        <ol className="mt-2 space-y-1">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ol>
      )}

      {plan.status === 'awaiting_approval' && (
        <>
          <button
            onClick={() => void onApprove()}
            disabled={busy}
            className="mt-3 w-full py-1.5 rounded bg-solix-warn/20 border border-solix-warn text-solix-warn text-xs hover:bg-solix-warn/30 disabled:opacity-40"
          >
            {busy ? 'Approving…' : 'Approve & run'}
          </button>
          <div className="mt-1 text-[10px] text-solix-warn/80 leading-snug">
            Starts {tasks.length === 1 ? 'an agent' : `${tasks.length} agents`},
            one per task. Each run costs money
            {plan.budgetUsd
              ? `, capped at $${plan.budgetUsd.toFixed(2)}.`
              : ' and there is no budget cap on this plan.'}
          </div>
        </>
      )}

      {plan.status === 'paused' && (
        <button
          onClick={() => void onResume()}
          disabled={busy}
          className="mt-3 w-full py-1.5 rounded bg-solix-warn/15 border border-solix-warn/60 text-solix-warn text-xs hover:bg-solix-warn/25 disabled:opacity-40"
        >
          {busy ? 'Resuming…' : 'Resume run'}
        </button>
      )}

      {runError && (
        <div
          className={`mt-2 rounded border p-2 space-y-2 ${
            showActivate
              ? 'border-amber-400/50 bg-amber-500/10'
              : 'border-solix-danger/40 bg-solix-danger/10'
          }`}
        >
          <div
            className={`text-[11px] ${showActivate ? 'text-amber-200' : 'text-solix-danger'}`}
          >
            {runError}
          </div>
          {showActivate && (
            <>
              <div className="flex gap-2">
                <input
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  placeholder="Paste your Pro license key"
                  className="flex-1 text-[11px] font-mono bg-black/40 border border-solix-border rounded p-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-400"
                />
                <button
                  onClick={() => void onActivate()}
                  disabled={!licenseKey.trim()}
                  className="px-3 rounded bg-solix-accent/20 border border-solix-accent/60 text-solix-accent text-[11px] hover:bg-solix-accent/30 disabled:opacity-40"
                >
                  Activate
                </button>
              </div>
              {activateError && (
                <div className="text-[10px] text-solix-danger">{activateError}</div>
              )}
            </>
          )}
        </div>
      )}

      {plan.status === 'running' && (
        <button
          onClick={() => void onAbort()}
          disabled={busy}
          className="mt-3 w-full py-1.5 rounded bg-solix-danger/15 border border-solix-danger/60 text-solix-danger text-xs hover:bg-solix-danger/25 disabled:opacity-40"
        >
          {busy ? 'Stopping…' : 'Abort run (stop agents)'}
        </button>
      )}

      {plan.status !== 'draft' && plan.status !== 'awaiting_approval' && (
        <PlanReviewSection planId={plan.id} />
      )}

      {finished && (
        <div className="mt-2 space-y-2">
          <button
            onClick={() =>
              window.open(
                `/api/plans/${encodeURIComponent(plan.id)}/preview/`,
                '_blank',
                'noopener',
              )
            }
            className="w-full py-1.5 rounded bg-solix-accent/15 border border-solix-accent/50 text-solix-accent text-xs hover:bg-solix-accent/25"
          >
            Open preview ↗
          </button>

          {/* Iterate: describe a follow-up and Maestro plans the next build. */}
          <div className="flex gap-2">
            <input
              value={refine}
              onChange={(e) => setRefine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onRefine();
              }}
              placeholder="Refine or add a follow-up goal…"
              className="flex-1 text-xs bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
            />
            <button
              onClick={() => void onRefine()}
              disabled={refining || !refine.trim()}
              className="px-3 rounded bg-solix-warn/20 border border-solix-warn/60 text-solix-warn text-xs hover:bg-solix-warn/30 disabled:opacity-40"
            >
              {refining ? '…' : 'Plan'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** On-demand "what did the fleet change?" — fetches the git diff of the plan's
 *  working tree against the baseline captured when it started running. */
function PlanReviewSection({ planId }: { planId: string }): JSX.Element {
  const [review, setReview] = useState<PlanReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(planId)}/review`,
      );
      setReview((await res.json()) as PlanReview);
      setOpen(true);
    } catch {
      setReview({ ok: false, error: 'Could not load the diff.', files: [], diff: '' });
      setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3">
      <button
        onClick={() => (open ? setOpen(false) : void load())}
        disabled={loading}
        className="w-full py-1.5 rounded bg-black/30 border border-solix-border text-slate-300 text-xs hover:bg-black/50 disabled:opacity-40"
      >
        {loading ? 'Loading diff…' : open ? 'Hide changes' : 'Review changes'}
      </button>

      {open && review && (
        <div className="mt-2 space-y-2">
          {review.notARepo ? (
            <div className="text-[11px] text-slate-500 italic">
              This project isn’t a git repo, so there’s nothing to diff.
            </div>
          ) : review.error ? (
            <div className="text-[11px] text-solix-danger">{review.error}</div>
          ) : review.files.length === 0 ? (
            <div className="text-[11px] text-slate-500 italic">
              No file changes since the plan started.
            </div>
          ) : (
            <>
              <ul className="space-y-0.5">
                {review.files.map((f) => (
                  <FileReviewRow
                    key={f.path}
                    planId={planId}
                    file={f}
                    hunk={sliceFileDiff(review.diff, f.path)}
                  />
                ))}
              </ul>
              <DiffView diff={review.diff} truncated={review.truncated} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Best-effort slice of a single file's section out of a combined unified diff,
 *  so a comment on that file carries just the relevant hunk as context. */
function sliceFileDiff(diff: string, path: string): string | undefined {
  if (!diff) return undefined;
  const parts = diff.split(/\n(?=diff --git )/);
  const hit = parts.find((p) => p.includes(` a/${path}`) || p.includes(` b/${path}`) || p.includes(path));
  return hit?.trim() || undefined;
}

/** One changed-file row with an inline "comment → follow-up task" affordance
 *  (comment-on-passage, P1 #4). Posting turns the note into a worker task that
 *  re-runs the plan to address it. */
function FileReviewRow({
  planId,
  file,
  hunk,
}: {
  planId: string;
  file: PlanReview['files'][number];
  hunk?: string;
}): JSX.Element {
  const addFollowUp = useSolixStore((s) => s.addFollowUp);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const onSubmit = async (): Promise<void> => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote(null);
    const res = await addFollowUp(planId, { body: text, file: file.path, hunk });
    setBusy(false);
    if (res.ok && !res.upsell) {
      setBody('');
      setOpen(false);
      setNote({ ok: true, text: 'Follow-up task queued — the plan will address it.' });
    } else if (res.upsell) {
      setNote({ ok: false, text: res.error ?? 'Re-running this plan needs Pro.' });
    } else {
      setNote({ ok: false, text: res.error ?? 'Could not add the follow-up.' });
    }
  };

  return (
    <li className="text-[11px] font-mono">
      <div className="flex items-center gap-2">
        <span
          className={
            file.status === 'added'
              ? 'text-solix-ok'
              : file.status === 'deleted'
                ? 'text-solix-danger'
                : 'text-amber-300'
          }
          title={file.status}
        >
          {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
        </span>
        <span className="text-slate-300 truncate flex-1">{file.path}</span>
        {file.additions > 0 && (
          <span className="text-solix-ok">+{file.additions}</span>
        )}
        {file.deletions > 0 && (
          <span className="text-solix-danger">−{file.deletions}</span>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 text-slate-500 hover:text-slate-200"
          title="Comment on this file → follow-up task"
          aria-label="Comment on this file"
        >
          🗨
        </button>
      </div>
      {open && (
        <div className="mt-1 flex gap-1.5 font-sans">
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSubmit();
            }}
            placeholder={`What should change in ${file.path.split('/').pop()}?`}
            className="flex-1 text-[11px] bg-black/40 border border-solix-border rounded p-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-amber-400"
          />
          <button
            onClick={() => void onSubmit()}
            disabled={busy || !body.trim()}
            className="px-2.5 rounded bg-solix-warn/20 border border-solix-warn/60 text-solix-warn text-[11px] hover:bg-solix-warn/30 disabled:opacity-40"
          >
            {busy ? '…' : 'Fix it'}
          </button>
        </div>
      )}
      {note && (
        <div
          className={`mt-1 text-[10px] font-sans ${note.ok ? 'text-solix-ok' : 'text-amber-300'}`}
        >
          {note.text}
        </div>
      )}
    </li>
  );
}

/** Minimal unified-diff renderer: red/green lines in a scrollable monospace box. */
function DiffView({
  diff,
  truncated,
}: {
  diff: string;
  truncated?: boolean;
}): JSX.Element | null {
  if (!diff.trim()) return null;
  const lines = diff.split('\n');
  return (
    <div className="max-h-64 overflow-auto rounded border border-solix-border bg-black/40 p-2">
      <pre className="text-[10px] leading-tight font-mono whitespace-pre">
        {lines.map((l, i) => {
          const color = l.startsWith('+') && !l.startsWith('+++')
            ? 'text-solix-ok'
            : l.startsWith('-') && !l.startsWith('---')
              ? 'text-solix-danger'
              : l.startsWith('@@')
                ? 'text-solix-accent'
                : l.startsWith('diff ') || l.startsWith('index ')
                  ? 'text-slate-500'
                  : 'text-slate-400';
          return (
            <div key={i} className={color}>
              {l || ' '}
            </div>
          );
        })}
      </pre>
      {truncated && (
        <div className="text-[10px] text-slate-500 mt-1">
          Diff truncated — open the project to see the rest.
        </div>
      )}
    </div>
  );
}

const TASK_STATUS_COLOR: Record<PlanTaskStatus, string> = {
  pending: 'bg-slate-600',
  ready: 'bg-solix-accent',
  dispatched: 'bg-solix-accent solix-pulse',
  verifying: 'bg-amber-400 solix-pulse',
  completed: 'bg-solix-ok',
  failed: 'bg-solix-warn',
  escalated: 'bg-solix-danger',
  blocked: 'bg-slate-700',
  skipped: 'bg-slate-700',
};

function TaskRow({ task }: { task: PlanTask }): JSX.Element {
  // Surface the rejection reason once a task needs a human (escalated) or is
  // mid-retry (failed) so the operator sees *why* without opening a session.
  const showError =
    task.lastError && (task.status === 'escalated' || task.status === 'failed');
  const thread = useSolixStore((s) => selectTaskThread(s, task.id));
  const [open, setOpen] = useState(false);
  return (
    <li className="text-xs">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-slate-500 hover:text-slate-200 shrink-0 w-3 text-center"
          title={open ? 'Hide thread' : 'Show thread'}
          aria-label={open ? 'Hide thread' : 'Show thread'}
        >
          {open ? '▾' : '▸'}
        </button>
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${
            TASK_STATUS_COLOR[task.status] ?? 'bg-slate-600'
          }`}
          title={task.status}
        />
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-slate-200 truncate flex-1 text-left hover:text-white"
        >
          {task.title}
        </button>
        {thread.length > 0 && (
          <span
            className="text-[9px] text-slate-500 shrink-0"
            title={`${thread.length} thread ${thread.length === 1 ? 'entry' : 'entries'}`}
          >
            💬{thread.length}
          </span>
        )}
        {task.attempts > 1 && (
          <span
            className="text-[9px] text-slate-500 shrink-0"
            title={`${task.attempts} of ${task.maxAttempts} attempts`}
          >
            ×{task.attempts}
          </span>
        )}
        {task.assignedAdvisorRole && (
          <span className="text-[9px] uppercase tracking-wide text-slate-500 shrink-0">
            {task.assignedAdvisorRole}
          </span>
        )}
        {task.dependsOn.length > 0 && (
          <span
            className="text-[9px] text-slate-600 shrink-0"
            title={`depends on ${task.dependsOn.join(', ')}`}
          >
            ↳{task.dependsOn.length}
          </span>
        )}
      </div>
      {showError && !open && (
        <div className="mt-0.5 ml-5 text-[10px] text-solix-danger/80 line-clamp-2">
          {task.lastError}
        </div>
      )}
      {open && <TaskThread task={task} />}
    </li>
  );
}

const THREAD_KIND_META: Record<
  string,
  { icon: string; color: string; label: string }
> = {
  dispatched: { icon: '→', color: 'text-solix-accent', label: 'Dispatched' },
  worker_result: { icon: '⚙', color: 'text-slate-300', label: 'Worker' },
  completed: { icon: '✓', color: 'text-solix-ok', label: 'Verified' },
  retry: { icon: '↻', color: 'text-solix-warn', label: 'Retry' },
  escalated: { icon: '⚠', color: 'text-solix-danger', label: 'Escalated' },
  aborted: { icon: '■', color: 'text-slate-400', label: 'Aborted' },
  comment: { icon: '🗨', color: 'text-amber-200', label: 'You' },
  follow_up: { icon: '＋', color: 'text-amber-300', label: 'Follow-up' },
  delegated: { icon: '⑂', color: 'text-cyan-300', label: 'Delegated' },
};

/** The task's run history + conversation — lifecycle entries interleaved with
 *  human comments. Loaded on expand; live-appended over the WS. */
function TaskThread({ task }: { task: PlanTask }): JSX.Element {
  const thread = useSolixStore((s) => selectTaskThread(s, task.id));
  const fetchTaskThread = useSolixStore((s) => s.fetchTaskThread);
  const postTaskComment = useSolixStore((s) => s.postTaskComment);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchTaskThread(task.planId, task.id);
  }, [task.planId, task.id, fetchTaskThread]);

  const onSend = async (): Promise<void> => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    const res = await postTaskComment(task.planId, task.id, text);
    setSending(false);
    if (res.ok) setComment('');
    else setError(res.error ?? 'Could not post the comment.');
  };

  return (
    <div className="mt-1 ml-5 rounded border border-solix-border/60 bg-black/20 p-2 space-y-2">
      {thread.length === 0 ? (
        <div className="text-[10px] text-slate-500 italic">
          No activity yet. Dispatch events and your comments will show here.
        </div>
      ) : (
        <ol className="space-y-1.5">
          {thread.map((e) => (
            <ThreadEntryRow key={e.id} entry={e} />
          ))}
        </ol>
      )}
      <div className="flex gap-1.5">
        <input
          value={comment}
          onChange={(ev) => setComment(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void onSend();
          }}
          placeholder="Add a comment…"
          className="flex-1 text-[11px] bg-black/40 border border-solix-border rounded p-1.5 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
        />
        <button
          onClick={() => void onSend()}
          disabled={sending || !comment.trim()}
          className="px-2.5 rounded bg-solix-warn/20 border border-solix-warn/60 text-solix-warn text-[11px] hover:bg-solix-warn/30 disabled:opacity-40"
        >
          {sending ? '…' : 'Post'}
        </button>
      </div>
      {error && <div className="text-[10px] text-solix-danger">{error}</div>}
    </div>
  );
}

function ThreadEntryRow({ entry }: { entry: TaskThreadEntry }): JSX.Element {
  const meta = THREAD_KIND_META[entry.kind] ?? {
    icon: '·',
    color: 'text-slate-400',
    label: entry.kind,
  };
  const when = new Date(entry.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const cost =
    typeof entry.payload?.costUsd === 'number'
      ? `$${(entry.payload.costUsd as number).toFixed(3)}`
      : null;
  return (
    <li className="flex gap-2">
      <span className={`shrink-0 ${meta.color}`} title={meta.label}>
        {meta.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[9px] text-slate-500">
          <span className={meta.color}>{meta.label}</span>
          {entry.attempt != null && <span>· attempt {entry.attempt}</span>}
          {cost && <span>· {cost}</span>}
          <span>· {when}</span>
        </div>
        <div className="text-[11px] text-slate-300 whitespace-pre-wrap break-words line-clamp-6">
          {entry.body}
        </div>
      </div>
    </li>
  );
}
