import { useEffect, useState } from 'react';
import { Button } from '../ui/Button.js';
import { useSolixStore } from '../store/index.js';

const ISSUE_URL = 'https://github.com/shmulikdav/Solix/issues/new';

interface Diagnostics {
  version: string;
  node: string;
  platform: string;
  arch: string;
  hooks: {
    installed: boolean;
    upToDate: boolean;
    stampedVersion: string | null;
    claudeCodePresent: boolean;
    supported: boolean;
  } | null;
  sessions: { total: number; byStatus: Record<string, number> };
  uptimeSec: number;
}

/** The issue form's `os` dropdown only accepts these four. */
function osOption(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows (native)';
  return 'Linux';
}

/**
 * Renders the same information `solix doctor` prints, as text a human can
 * read before it goes anywhere.
 */
function format(d: Diagnostics, view: string): string {
  const h = d.hooks;
  const counts = Object.entries(d.sessions.byStatus)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return [
    `solix       ${d.version}`,
    `node        ${d.node}`,
    `platform    ${d.platform}/${d.arch}`,
    h
      ? `hooks       installed=${h.installed} upToDate=${h.upToDate} stamped=${h.stampedVersion ?? 'none'}`
      : 'hooks       unknown (server started without the CLI)',
    h ? `claude code ${h.claudeCodePresent ? 'detected' : 'not detected'}` : '',
    `sessions    ${d.sessions.total}${counts ? ` (${counts})` : ''}`,
    `uptime      ${d.uptimeSec}s`,
    `screen      ${view}`,
    `browser     ${navigator.userAgent}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * "Report a problem".
 *
 * A beta tester who hits something has, today, no path at all: they would
 * have to find the GitHub repo themselves, run `solix doctor` in a terminal,
 * work out which parts matter and paste them. Most will just quietly stop
 * using it, and the bug never reaches you — which is the expensive failure
 * in a beta, because the whole point is learning what breaks.
 *
 * It shows the payload before sending. Solix's claim is that nothing leaves
 * your machine, so the one place that offers to send something outward owes
 * you a look at it first — and the content is deliberately counts, versions
 * and hook state, never a path, a project name or a prompt.
 */
export function ReportProblem({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const viewMode = useSolixStore((s) => s.viewMode);
  const surface = useSolixStore((s) => s.workspaceSurface);
  const activePanel = useSolixStore((s) => s.activePanel);

  const where = [
    surface ? `${surface.kind}${surface.kind === 'fleet' ? `/${surface.tab}` : ''}` : viewMode,
    activePanel ? `+${activePanel}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Every other modal here closes on Escape; this one did not, which is the
  // sort of inconsistency that makes a dialog feel like a trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFailed(false);
    fetch('/api/diagnostics')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('bad status'))))
      .then((d: Diagnostics) => {
        if (!cancelled) setDiag(d);
      })
      .catch(() => {
        // The server being unreachable is itself worth reporting, so this
        // must still let you file — just without the detail.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const body = diag
    ? format(diag, where)
    : 'Could not reach the Solix server to collect diagnostics.';

  const href = (() => {
    const p = new URLSearchParams({
      template: 'bug_report.yml',
      labels: 'bug',
      doctor: body,
    });
    if (diag) {
      p.set('solix-version', diag.version);
      p.set('node', diag.node);
      p.set('os', osOption(diag.platform));
    }
    return `${ISSUE_URL}?${p.toString()}`;
  })();

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Report a problem"
    >
      <div className="absolute inset-0 bg-black/75" onClick={onClose} />
      <div className="relative z-10 mx-4 w-full max-w-lg rounded-xl border border-solix-border bg-solix-panel shadow-2xl">
        <div className="flex items-start justify-between border-b border-solix-border px-5 py-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-solix-accent">
              report
            </div>
            <div className="mt-0.5 text-lg font-semibold">
              Report a problem
            </div>
            <div className="mt-1 text-xs leading-snug text-slate-400">
              Opens a GitHub issue with the details below already filled in.
              You write what went wrong.
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-slate-400 hover:text-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
            What gets attached
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-solix-border bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
            {body}
          </pre>
          <div className="mt-2 text-[11px] leading-snug text-slate-500">
            No file paths, project names, prompts or anything from your code —
            versions, counts and hook state only.
            {failed && (
              <span className="block text-solix-warn">
                The Solix server did not answer, so the detail is missing. File
                it anyway — that is worth knowing about.
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-solix-border px-5 py-3">
          <Button
            variant="primary"
            onClick={() => {
              window.open(href, '_blank', 'noopener,noreferrer');
              onClose();
            }}
          >
            Open a GitHub issue
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(body)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? 'Copied' : 'Copy details'}
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
