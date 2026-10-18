/**
 * First-run state and the getting-started checklist.
 *
 * The old onboarding had one flag and two gates, and the second gate destroyed
 * it: the modal only rendered when `sessionCount === 0`, while the README's
 * first suggested command — `solix demo` — seeds about thirty sessions. Anyone
 * who followed the quick start never saw onboarding again, and there was no
 * other path back to it.
 *
 * So: one flag, read synchronously (an effect-hydrated flag flashes the modal
 * at returning users for a frame), and the checklist derives from real state
 * rather than from a second flag that could disagree with it.
 */

const DISMISSED_KEY = 'solix.welcome.dismissed.v1';
const SUN_HINT_KEY = 'solix.hint.sun.v1';

export function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    // Private window, blocked site data: treat as "not yet dismissed". Showing
    // onboarding one extra time is the harmless direction.
    return false;
  }
}

export function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    /* nothing to do; the modal will show again next load */
  }
}

/** Whether the one-time "the sun is clickable" hint has already been shown. */
export function readSunHintSeen(): boolean {
  try {
    return localStorage.getItem(SUN_HINT_KEY) === '1';
  } catch {
    // Blocked storage: treat as seen. Showing a hint twice is worse than not
    // showing it, and unlike onboarding there is no way back to this one.
    return true;
  }
}

export function writeSunHintSeen(): void {
  try {
    localStorage.setItem(SUN_HINT_KEY, '1');
  } catch {
    /* nothing to do */
  }
}

export interface ChecklistItem {
  id: string;
  label: string;
  hint: string;
  done: boolean;
}
