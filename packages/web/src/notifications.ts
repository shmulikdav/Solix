// Browser notifications + sound on attention-needed events.
//
// Behavior:
//   - Permission is requested from a user gesture, never from notify().
//   - A notification fires only when the tab is hidden — when the user is
//     looking at Solix, the red flare and the Decision Queue are enough.
//   - User can opt out via the SOLIX_NOTIFICATIONS=off localStorage key.
//
// The first bullet used to read "the first time a permission_request comes
// in while the tab is hidden, we ask for Notification permission (it's a
// no-op if the user never has the tab in the background)". That is a
// contradiction, and the parenthesis is the tell: the only moment it asked
// was the one moment it could not. Browsers require transient user
// activation for Notification.requestPermission(), and Chrome will not
// prompt a hidden tab — so the request silently resolved to 'default',
// `permissionAsked` latched, and nothing was ever asked again that page
// load. Every caller passes whenHidden: true, so there was no other path.
//
// The effect was that the one signal the product exists to deliver — an
// agent is blocked and waiting for you — never reached anyone who had
// tabbed away, which is precisely the problem the landing page sells
// against.
//
// Kept separate from the store so it has zero React dependency.

const PREF_KEY = 'solix.notifications.v1';

type Pref = 'on' | 'off';

function readPref(): Pref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'off' ? 'off' : 'on';
  } catch {
    return 'on';
  }
}

export function setNotificationsPref(pref: Pref): void {
  try {
    localStorage.setItem(PREF_KEY, pref);
  } catch {
    /* ignore */
  }
}

export function notificationsPref(): Pref {
  return readPref();
}

/** 'unsupported' when the browser has no Notification API at all. */
export type NotifyState = NotificationPermission | 'unsupported';

/** What the browser currently allows. Safe to call during render. */
export function notificationState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Ask the browser for permission. **Call this from a click handler.**
 *
 * Browsers require transient user activation, so calling it from a
 * background event — which is what `notify()` used to do — cannot work.
 */
export async function requestPermission(): Promise<NotifyState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

interface NotifyOptions {
  title: string;
  body: string;
  /**
   * Tag the notification so newer ones replace older ones with the same
   * tag (e.g., a second permission request from the same session). This
   * keeps the notification tray tidy.
   */
  tag?: string;
  /**
   * If true, only fire when document is hidden. The Decision Queue +
   * red flare cover the case where the user is looking at the page.
   */
  whenHidden?: boolean;
}

export async function notify(opts: NotifyOptions): Promise<void> {
  if (readPref() === 'off') return;
  if (typeof Notification === 'undefined') return;
  if (
    opts.whenHidden &&
    typeof document !== 'undefined' &&
    !document.hidden
  ) {
    return;
  }
  // Only check. Asking from here is what made this never work: see the
  // note at the top of the file.
  if (Notification.permission !== 'granted') return;
  try {
    new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      // Use the Solix favicon if any; safe to omit.
    });
  } catch {
    /* ignore — permissions can change between check and create */
  }
}

// Optional sound chime — kept off by default. Set
// localStorage["solix.sound"] = "on" to enable.
const SOUND_KEY = 'solix.sound.v1';
let audioCtx: AudioContext | null = null;

export function chime(): void {
  try {
    if (localStorage.getItem(SOUND_KEY) !== 'on') return;
    if (typeof window === 'undefined') return;
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.0001;
    const now = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.4);
  } catch {
    /* ignore — autoplay-policy etc. */
  }
}
