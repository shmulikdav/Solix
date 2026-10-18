import { useEffect, useState } from 'react';
import type { TeamTemplate } from '@solix/shared';
import { useSolixStore } from '../../store/index.js';
import { ProjectPicker } from '../ProjectPicker.js';
import { describeRoutineCost } from './routineCost.js';
import { Button } from '../../ui/Button.js';

/** P2 #7 — ready-made team templates: pick a project, install an advisor+skill+
 *  routine bundle in one click. */
export function TeamsTab({ open }: { open: boolean }): JSX.Element {
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
        <ProjectPicker
          projects={projectList}
          value={effectiveCwd}
          onChange={setCwd}
          placeholder="Choose a project…"
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
            <Button
              onClick={() => void onInstall(t.id)}
              variant="warn"
              block
              className="mt-2"
              busy={busy === t.id}
              busyLabel="Installing…"
            >
              Install team
            </Button>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="text-xs text-slate-500 italic">No team templates.</div>
        )}
      </div>
    </div>
  );
}