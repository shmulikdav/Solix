import { useSolixStore } from '../store/index.js';

/**
 * Every error the product raises arrives here, and none of it reached a
 * screen reader: there was no `aria-live`, no `role`, no icon and no text
 * prefix. Level was carried by hue alone — `text-solix-danger` versus
 * `text-solix-warn` versus slate — so a colour-blind user could not tell an
 * error from a status ping, and anyone using a screen reader got nothing at
 * all. They auto-dismiss after five seconds, so there is no second chance.
 *
 * ConnectionDot, one file over, already solved this: it carries its state in
 * fill *and* motion *and* a word. So do these now.
 */
const LEVEL = {
  error: { word: 'Error', glyph: '✕', live: 'assertive' as const },
  warn: { word: 'Warning', glyph: '!', live: 'polite' as const },
  info: { word: '', glyph: 'i', live: 'polite' as const },
};

export function Toasts(): JSX.Element {
  const toasts = useSolixStore((s) => s.toasts);
  const dismiss = useSolixStore((s) => s.dismissToast);

  return (
    <div
      className="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col gap-2 z-30"
      // Errors interrupt; everything else waits its turn.
      aria-live="assertive"
      aria-atomic="false"
      role="log"
    >
      {toasts.map((t) => {
        const level = LEVEL[t.level] ?? LEVEL.info;
        return (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            // Says what it is in text, not only in colour, and says that
            // clicking does something — it looked interactive and its only
            // behaviour was to disappear sooner.
            aria-label={`${level.word ? `${level.word}: ` : ''}${t.message}. Dismiss.`}
            title="Dismiss"
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2 rounded text-xs border max-w-md text-left ${
              t.level === 'error'
                ? 'bg-solix-danger/10 border-solix-danger text-solix-danger'
                : t.level === 'warn'
                  ? 'bg-solix-warn/10 border-solix-warn text-solix-warn'
                  : 'bg-solix-panel border-solix-border text-slate-200'
            }`}
          >
            <span
              aria-hidden="true"
              className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[9px] font-bold leading-none"
            >
              {level.glyph}
            </span>
            <span>
              {level.word && <span className="font-semibold">{level.word}: </span>}
              {t.message}
            </span>
          </button>
        );
      })}
    </div>
  );
}
