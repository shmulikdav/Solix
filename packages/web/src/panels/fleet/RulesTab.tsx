import { useCallback, useEffect, useState } from 'react';
import type { ApprovalRule } from '@solix/shared';
import { describeRule } from '@solix/shared';
import { Button } from '../../ui/Button.js';

/**
 * Fleet → Rules: the standing decisions at the gate.
 *
 * Measured on 1.18.3, a five-task Maestro plan at `standard` was held thirty
 * times for thirty tool calls — `Read SPEC.md` included — and the ledger
 * said "approved 4 times — worth a rule rather than a decision" with no rule
 * to make. This is where they are made and seen. Each row shows how often
 * the rule has decided, so a rule that never fires is visible too.
 *
 * Three load states, like the other tabs: loading, failed-with-retry, and
 * loaded — an empty list means there are no rules, not that the fetch failed.
 */
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; rules: ApprovalRule[] };

export function RulesTab(): JSX.Element {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/rules');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState({ kind: 'ready', rules: (await res.json()) as ApprovalRule[] });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, run: () => Promise<Response>, done: string): Promise<void> {
    setBusy(id);
    setNotice(null);
    try {
      const res = await run();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotice(done);
      await load();
    } catch (err) {
      setNotice(`That did not land: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const installDefaults = () =>
    act(
      'defaults',
      () => fetch('/api/rules/defaults', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      'Defaults installed: read-only tools, writes inside the project, and a short benign shell list.',
    );

  return (
    <div className="flex-1 overflow-y-auto p-3 text-sm" data-testid="rules-tab">
      {state.kind === 'loading' && <div className="text-slate-400">Loading rules…</div>}
      {state.kind === 'error' && (
        <div role="alert" className="text-solix-danger">
          Could not load rules ({state.message}).{' '}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          {notice && (
            <div role="status" className="mb-2 text-[11px] text-slate-400">
              {notice}
            </div>
          )}
          {state.rules.length === 0 ? (
            <div className="text-slate-400">
              <p>No rules. Every gated call is a decision for you.</p>
              <p className="mt-1 text-[11px]">
                The defaults allow reading, listing, testing and committing inside the project — nothing that deletes,
                pushes or escalates. The denylist runs first whatever the rules say.
              </p>
              <Button className="mt-2" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void installDefaults()}>
                Install the defaults
              </Button>
            </div>
          ) : (
            <ul className="space-y-1">
              {state.rules.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded border border-solix-border/60 px-2 py-1.5">
                  <span
                    className={
                      !r.enabled
                        ? 'text-slate-500'
                        : r.decision === 'allow'
                          ? 'text-solix-ok'
                          : 'text-solix-danger'
                    }
                    title={!r.enabled ? 'disabled' : r.decision}
                  >
                    {!r.enabled ? '○' : r.decision === 'allow' ? '✓' : '✗'}
                  </span>
                  <span className={`flex-1 truncate ${r.enabled ? 'text-slate-200' : 'text-slate-500'}`} title={describeRule(r)}>
                    {describeRule(r)}
                  </span>
                  <span className="text-[10px] text-slate-500 whitespace-nowrap" title="how many calls this rule has decided">
                    {r.hits} hit{r.hits === 1 ? '' : 's'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        r.id,
                        () =>
                          fetch(`/api/rules/${encodeURIComponent(r.id)}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ enabled: !r.enabled }),
                          }),
                        r.enabled ? 'Rule disabled — it stays listed and stops deciding.' : 'Rule enabled.',
                      )
                    }
                  >
                    {r.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        r.id,
                        () => fetch(`/api/rules/${encodeURIComponent(r.id)}`, { method: 'DELETE' }),
                        'Rule removed.',
                      )
                    }
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {state.rules.length > 0 && (
            <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
              <span>
                {state.rules.length} rule{state.rules.length === 1 ? '' : 's'}. The denylist is not a rule and no rule can override it.
              </span>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void installDefaults()}>
                Add the defaults
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
