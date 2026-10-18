import { useEffect, useMemo, useRef, useState } from 'react';
import { selectPlanets, useSolixStore } from '../store/index.js';
import {
  FLEET_SECTIONS,
  type FleetTabId,
  type WorkspaceSurface,
} from './surfaces.js';

/**
 * ⌘K — one way to reach anything.
 *
 * The rail holds eleven destinations and Fleet adds six more underneath it.
 * That is a reasonable amount of navigation to *see*, but a poor amount to
 * *traverse* when you know where you are going — and it says nothing at all
 * about the twenty-odd agents, which are only reachable by finding the right
 * dot in a 3D scene or scrolling the List view.
 *
 * Deliberately absent: anything that spends money or resolves a permission.
 * "Approve the top decision" was on the original list and is exactly the B1
 * failure — acting on a tool call the user cannot see — so the palette offers
 * "Go to Decisions" instead and the approval happens where the command is on
 * screen. Same reasoning for starting a routine.
 */
interface Command {
  id: string;
  label: string;
  group: string;
  detail?: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onNewTask,
  onOpenTimeline,
  onOpenHelp,
}: {
  open: boolean;
  onClose: () => void;
  onNewTask: () => void;
  onOpenTimeline: () => void;
  onOpenHelp: () => void;
}): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const setViewMode = useSolixStore((s) => s.setViewMode);
  const openPanel = useSolixStore((s) => s.openPanel);
  const closePanel = useSolixStore((s) => s.closePanel);
  const openSurface = useSolixStore((s) => s.openSurface);
  const closeSurface = useSolixStore((s) => s.closeSurface);
  const selectSession = useSolixStore((s) => s.selectSession);
  const toggleMotion = useSolixStore((s) => s.toggleMotion);
  const planets = useSolixStore(selectPlanets);

  const commands = useMemo<Command[]>(() => {
    const goSurface = (s: WorkspaceSurface) => () => {
      closePanel();
      openSurface(s);
    };
    const goView = (v: 'galaxy' | 'list' | 'missions') => () => {
      closePanel();
      closeSurface();
      setViewMode(v);
    };

    const out: Command[] = [
      { id: 'v-galaxy', label: 'Galaxy', group: 'Go to', hint: 'V', run: goView('galaxy') },
      { id: 'v-list', label: 'List', group: 'Go to', run: goView('list') },
      { id: 'v-missions', label: 'Missions', group: 'Go to', hint: 'M', run: goView('missions') },
      {
        id: 'p-decisions',
        label: 'Decisions',
        group: 'Go to',
        detail: 'approve or deny what agents are blocked on',
        run: () => {
          closeSurface();
          openPanel('decisions');
        },
      },
      { id: 's-plan', label: 'Maestro', group: 'Go to', hint: 'P', run: goSurface({ kind: 'plan' }) },
      {
        id: 's-overview',
        label: 'Mission Control',
        group: 'Go to',
        hint: 'W',
        run: goSurface({ kind: 'overview' }),
      },
      { id: 's-share', label: 'Share', group: 'Go to', hint: 'G', run: goSurface({ kind: 'share' }) },
      ...FLEET_SECTIONS.map((sec) => ({
        id: `s-fleet-${sec.id}`,
        label: `Fleet › ${sec.label}`,
        group: 'Go to',
        run: goSurface({ kind: 'fleet', tab: sec.id as FleetTabId }),
      })),
      { id: 'a-task', label: 'New task', group: 'Actions', hint: 'L', run: onNewTask },
      { id: 'a-timeline', label: 'Timeline', group: 'Actions', hint: 'T', run: onOpenTimeline },
      { id: 'a-motion', label: 'Play / pause orbits', group: 'Actions', hint: 'Space', run: toggleMotion },
      { id: 'a-help', label: 'Help', group: 'Actions', hint: '?', run: onOpenHelp },
    ];

    // Agents by name. Twenty idle planets are effectively unreachable
    // otherwise — you have to find the right dot or scroll the list.
    for (const p of planets) {
      out.push({
        id: `agent-${p.id}`,
        label: p.name ?? p.id.slice(0, 8),
        group: 'Agents',
        detail: `${p.status} · ${p.cwd}`,
        run: () => {
          closeSurface();
          selectSession(p.id);
        },
      });
    }
    return out;
  }, [
    planets,
    closePanel,
    closeSurface,
    openPanel,
    openSurface,
    selectSession,
    setViewMode,
    toggleMotion,
    onNewTask,
    onOpenTimeline,
    onOpenHelp,
  ]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.detail ?? ''}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Reset when reopened, and keep the cursor inside the (shrinking) results.
  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  useEffect(() => {
    // Optional-called: scrollIntoView is absent in jsdom and is a nicety
    // here, not a requirement. Keeping the selection visible must never be
    // the reason the palette throws.
    const active = listRef.current?.querySelector('[data-active="true"]');
    if (active instanceof HTMLElement) {
      active.scrollIntoView?.({ block: 'nearest' });
    }
  }, [index]);

  if (!open) return null;

  const run = (c: Command | undefined): void => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (i + 1) % Math.max(1, matches.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i - 1 + matches.length) % Math.max(1, matches.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(matches[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup = '';

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        data-command-palette=""
        className="relative z-10 w-full max-w-xl mx-4 rounded-xl border border-solix-border bg-solix-panel shadow-2xl overflow-hidden"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Go to a surface, or find an agent by name…"
          aria-label="Search commands"
          className="w-full bg-transparent px-4 py-3 text-sm text-slate-100 placeholder-slate-600 outline-none border-b border-solix-border"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {matches.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-500">
              Nothing matches “{query}”.
            </div>
          )}
          {matches.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            const active = i === index;
            return (
              <div key={c.id}>
                {header && (
                  <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-[0.2em] text-slate-600">
                    {header}
                  </div>
                )}
                <button
                  data-active={active}
                  onClick={() => run(c)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-baseline gap-3 px-4 py-1.5 text-left text-sm ${
                    active ? 'bg-solix-accent/15 text-slate-50' : 'text-slate-300'
                  }`}
                >
                  <span className="truncate">{c.label}</span>
                  {c.detail && (
                    <span className="truncate text-[11px] text-slate-600">
                      {c.detail}
                    </span>
                  )}
                  <span className="flex-1" />
                  {c.hint && (
                    <kbd className="shrink-0 text-[10px] font-mono text-slate-600">
                      {c.hint}
                    </kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
