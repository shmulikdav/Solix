import { useEffect, useState } from 'react';
import type { ScheduledTask, ScheduleRun, TriggerKind } from '@solix/shared';
import { selectSchedulesArray, useSolixStore } from '../../store/index.js';

/**
 * Routines — recurring, unsupervised agent runs.
 *
 * This tab exists because the product could create recurring spend but not stop
 * it: installing a team creates interval routines that launch a real agent
 * session on a cadence, and the only way to disable one was to leave the app
 * and run `solix schedules` in a terminal. One click in, no way out.
 *
 * Reads come from the websocket snapshot, which already carries schedules and
 * keeps them live via schedule_upsert / schedule_remove — the open-time fetch
 * is only a self-heal for a stale socket. Writes POST and let the broadcast
 * land, so nothing here is optimistic.
 *
 * There is no edit: the server has no PATCH for a routine, and recreating one
 * would drop its run history and rotate its webhook token, silently breaking
 * any webhook already pointed at it.
 */
export function RoutinesTab({ open }: { open: boolean }): JSX.Element {
  const routines = useSolixStore(selectSchedulesArray);
  const loadSchedules = useSolixStore((s) => s.loadSchedules);

  useEffect(() => {
    if (open) void loadSchedules();
  }, [open, loadSchedules]);

  const enabledInterval = routines.filter(
    (r) => r.enabled && (r.trigger ?? 'interval') === 'interval',
  );

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
      <div className="text-xs text-slate-400 leading-snug">
        A routine starts an agent session on its own, without asking. Interval
        routines keep doing that until you disable them.
      </div>

      {enabledInterval.length > 0 && (
        <div className="rounded border border-solix-warn/40 bg-solix-warn/10 px-3 py-2 text-xs text-solix-warn">
          {enabledInterval.length === 1
            ? '1 routine is running on a schedule and spending money on every run.'
            : `${enabledInterval.length} routines are running on a schedule and spending money on every run.`}
        </div>
      )}

      {routines.length === 0 ? (
        <div className="text-xs text-slate-500">
          No routines. Installing a team from the Teams tab creates them, or add
          one below.
        </div>
      ) : (
        <div className="space-y-2">
          {routines.map((r) => (
            <RoutineCard key={r.id} routine={r} />
          ))}
        </div>
      )}

      <div className="border-t border-solix-border pt-4">
        <NewRoutineForm />
      </div>
    </div>
  );
}

function cadenceLabel(r: ScheduledTask): string {
  const trigger = r.trigger ?? 'interval';
  if (trigger === 'interval') return `every ${r.cron}`;
  if (trigger === 'webhook') return 'on webhook';
  return 'manual only';
}

function whenLabel(ts: number | undefined): string {
  if (!ts) return 'never';
  const delta = ts - Date.now();
  const mins = Math.round(Math.abs(delta) / 60000);
  const unit =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / 1440)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

function RoutineCard({ routine }: { routine: ScheduledTask }): JSX.Element {
  const setScheduleEnabled = useSolixStore((s) => s.setScheduleEnabled);
  const deleteSchedule = useSolixStore((s) => s.deleteSchedule);
  const fireSchedule = useSolixStore((s) => s.fireSchedule);
  const loadScheduleRuns = useSolixStore((s) => s.loadScheduleRuns);

  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [confirmFire, setConfirmFire] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trigger = routine.trigger ?? 'interval';

  const toggleRuns = async (): Promise<void> => {
    if (runs) {
      setRuns(null);
      return;
    }
    setRuns(await loadScheduleRuns(routine.id));
  };

  return (
    <div
      className={`rounded border px-3 py-2 ${
        routine.enabled
          ? 'border-solix-border bg-solix-border/10'
          : 'border-solix-border/50 bg-transparent opacity-70'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">
            {routine.name ?? routine.prompt.slice(0, 40)}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            {cadenceLabel(routine)}
            {routine.enabled && trigger === 'interval' && (
              <> · next {whenLabel(routine.nextRunAt)}</>
            )}
            {' · last '}
            {whenLabel(routine.lastRunAt)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 truncate">
            {routine.cwd}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-300 shrink-0 cursor-pointer">
          <input
            type="checkbox"
            checked={routine.enabled}
            onChange={(e) => {
              void setScheduleEnabled(routine.id, e.target.checked);
            }}
          />
          {routine.enabled ? 'On' : 'Off'}
        </label>
      </div>

      {err && <div className="text-[11px] text-solix-danger mt-1.5">{err}</div>}

      <div className="flex flex-wrap gap-1.5 mt-2">
        {/* Entry point #14 for spending money, and the only one that starts an
            unsupervised session with a single click, so it confirms. */}
        {confirmFire ? (
          <>
            <button
              onClick={() => {
                setConfirmFire(false);
                void fireSchedule(routine.id).then((res) => {
                  if (!res.ok) setErr(res.error ?? 'Could not start it.');
                });
              }}
              className="px-2 py-1 rounded bg-solix-warn/20 border border-solix-warn/50 text-solix-warn text-[11px]"
            >
              Run it now — this costs money
            </button>
            <button
              onClick={() => setConfirmFire(false)}
              className="px-2 py-1 rounded border border-solix-border text-slate-400 text-[11px]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              setErr(null);
              setConfirmFire(true);
            }}
            className="px-2 py-1 rounded bg-solix-warn/10 border border-solix-warn/30 text-solix-warn/90 text-[11px] hover:bg-solix-warn/20"
            title="Start this routine now, without waiting for its schedule"
          >
            Run now
          </button>
        )}

        <button
          onClick={() => void toggleRuns()}
          className="px-2 py-1 rounded border border-solix-border text-slate-300 text-[11px] hover:bg-solix-border/30"
        >
          {runs ? 'Hide history' : 'History'}
        </button>

        {confirmDelete ? (
          <>
            <button
              onClick={() => {
                setConfirmDelete(false);
                void deleteSchedule(routine.id);
              }}
              className="px-2 py-1 rounded bg-solix-danger/20 border border-solix-danger/50 text-solix-danger text-[11px]"
            >
              Delete for good
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-1 rounded border border-solix-border text-slate-400 text-[11px]"
            >
              Keep
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="px-2 py-1 rounded border border-solix-border text-slate-400 text-[11px] hover:text-solix-danger hover:border-solix-danger/40"
            title="Deleting also discards this routine's run history and its webhook URL"
          >
            Delete
          </button>
        )}
      </div>

      {trigger === 'webhook' && routine.webhookToken && (
        <div className="mt-2 text-[10px] text-slate-500 break-all">
          Fires on POST to /api/triggers/{routine.webhookToken}
        </div>
      )}

      {runs && (
        <div className="mt-2 border-t border-solix-border/60 pt-2 space-y-1">
          {runs.length === 0 ? (
            <div className="text-[11px] text-slate-500">Never run.</div>
          ) : (
            runs.slice(0, 8).map((run) => (
              <div
                key={run.id}
                className="text-[11px] text-slate-400 flex justify-between gap-2"
              >
                <span className="truncate">
                  {run.trigger} · {run.status}
                </span>
                <span className="shrink-0">{whenLabel(run.firedAt)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Creating a routine is creating recurring spend, so the consequence is stated
 *  before the button, in the same words the team installer uses. */
function NewRoutineForm(): JSX.Element {
  const createSchedule = useSolixStore((s) => s.createSchedule);
  const projects = useSolixStore((s) => s.projects);

  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cadence, setCadence] = useState('1h');
  const [trigger, setTrigger] = useState<TriggerKind>('interval');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const projectList = Object.values(projects);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    const res = await createSchedule({
      name: name.trim() || undefined,
      cwd: cwd.trim(),
      prompt: prompt.trim(),
      cadence: trigger === 'interval' ? cadence.trim() : undefined,
      trigger,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error ?? 'Could not create the routine.');
      return;
    }
    setName('');
    setPrompt('');
  };

  const consequence =
    trigger === 'interval'
      ? `This starts a real agent session every ${cadence || '—'} and costs money on every run, until you disable it.`
      : trigger === 'webhook'
        ? 'This runs only when its webhook URL is called — each call starts a real agent session and costs money.'
        : 'This runs only when you trigger it by hand.';

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">
        New routine
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="w-full px-2 py-1.5 rounded bg-black/30 border border-solix-border text-sm focus:outline-none focus:border-solix-accent/60"
      />
      <input
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        placeholder="/path/to/project"
        list="solix-routine-projects"
        className="w-full px-2 py-1.5 rounded bg-black/30 border border-solix-border text-sm focus:outline-none focus:border-solix-accent/60"
      />
      <datalist id="solix-routine-projects">
        {projectList.map((p) => (
          <option key={p.id} value={p.cwd} />
        ))}
      </datalist>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should the agent do on each run?"
        rows={2}
        className="w-full px-2 py-1.5 rounded bg-black/30 border border-solix-border text-sm focus:outline-none focus:border-solix-accent/60 resize-none"
      />
      <div className="flex gap-2">
        <select
          value={trigger}
          onChange={(e) => setTrigger(e.target.value as TriggerKind)}
          className="px-2 py-1.5 rounded bg-black/30 border border-solix-border text-sm focus:outline-none"
        >
          <option value="interval">On a schedule</option>
          <option value="webhook">On a webhook</option>
          <option value="manual">Only when I say</option>
        </select>
        {trigger === 'interval' && (
          <input
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            placeholder="30m / 2h / 1d"
            className="flex-1 min-w-0 px-2 py-1.5 rounded bg-black/30 border border-solix-border text-sm focus:outline-none focus:border-solix-accent/60"
          />
        )}
      </div>
      <div className="text-[11px] text-solix-warn/90 leading-snug">
        {consequence}
      </div>
      {err && <div className="text-[11px] text-solix-danger">{err}</div>}
      <button
        onClick={() => void submit()}
        disabled={busy || !cwd.trim() || !prompt.trim()}
        className="px-3 py-1.5 rounded bg-solix-warn/15 border border-solix-warn/40 text-solix-warn text-xs hover:bg-solix-warn/25 disabled:opacity-40"
      >
        {busy ? 'Creating…' : 'Create routine'}
      </button>
    </div>
  );
}
