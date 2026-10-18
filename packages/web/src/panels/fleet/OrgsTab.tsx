import { useState } from 'react';
import { useSolixStore } from '../../store/index.js';
import { Button } from '../../ui/Button.js';

const DEFAULT_ORG_ID = 'org-default';

/**
 * Orgs — the tenancy boundary that scopes which plans you see.
 *
 * This was a bare <select> in the top bar whose "New org…" option called
 * window.prompt(). The switcher stays discoverable via a non-interactive chip
 * in the bar (the active org genuinely changes what PlanPanel shows, so hiding
 * it entirely would be a comprehensibility regression), but creating, switching
 * and deleting happen here, with an inline form rather than a browser prompt.
 *
 * Note for later: routines are NOT org-scoped — ScheduledTask has no orgId,
 * unlike Plan. Putting Routines and Orgs behind the same door makes that
 * conspicuous, but fixing tenancy belongs in a server change, not here.
 */
export function OrgsTab(): JSX.Element {
  const orgs = useSolixStore((s) => s.orgs);
  const currentOrgId = useSolixStore((s) => s.currentOrgId);
  const setCurrentOrg = useSolixStore((s) => s.setCurrentOrg);
  const createOrg = useSolixStore((s) => s.createOrg);
  const deleteOrg = useSolixStore((s) => s.deleteOrg);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    const res = await createOrg(name.trim());
    setBusy(false);
    if (!res.ok) {
      setErr(res.error ?? 'Could not create the org.');
      return;
    }
    setName('');
    setAdding(false);
  };

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
      <div className="text-xs text-slate-400 leading-snug">
        An org scopes which plans you see. Everything stays on this machine —
        orgs are a way to keep separate work separate, not a login.
      </div>

      <div className="space-y-2">
        {orgs.length === 0 ? (
          <div className="text-xs text-slate-500">No orgs yet.</div>
        ) : (
          orgs.map((o) => {
            const active = o.id === currentOrgId;
            return (
              <div
                key={o.id}
                className={`rounded border px-3 py-2 flex items-center justify-between gap-2 ${
                  active
                    ? 'border-solix-accent/50 bg-solix-accent/10'
                    : 'border-solix-border bg-solix-border/10'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm truncate">
                    {o.name}
                    {active && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-solix-accent">
                        active
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {!active && (
                    <Button variant="ghost" size="sm" onClick={() => void setCurrentOrg(o.id)}>
                      Switch to it
                    </Button>
                  )}
                  {o.id !== DEFAULT_ORG_ID &&
                    (confirmDelete === o.id ? (
                      <>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => {
                            setConfirmDelete(null);
                            void deleteOrg(o.id).then((res) => {
                              if (!res.ok) {
                                setErr(res.error ?? 'Could not delete it.');
                              }
                            });
                          }}
                        >
                          Delete for good
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDelete(o.id)}
                        className="hover:!text-solix-danger"
                      >
                        Delete
                      </Button>
                    ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      {err && <div className="text-[11px] text-solix-danger">{err}</div>}

      <div className="border-t border-solix-border pt-4">
        {adding ? (
          <div className="space-y-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
              placeholder="Org name"
              autoFocus
              className="w-full px-2 py-1.5 rounded bg-black/30 border border-solix-border text-sm focus:outline-none focus:border-solix-accent/60"
            />
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => void submit()}
                disabled={!name.trim()}
                busy={busy}
                busyLabel="Creating…"
              >
                Create org
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setName('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" onClick={() => setAdding(true)}>
            New org
          </Button>
        )}
      </div>
    </div>
  );
}
