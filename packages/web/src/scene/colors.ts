import type { Model, SessionStatus } from '@solix/shared';

export function modelColor(model: Model): string {
  // Substring match so pinned model ids (e.g. `claude-opus-5`) still map to
  // their tier color — same tier-detection approach as pricing.ts.
  const m = model.toLowerCase();
  if (m.includes('opus')) return '#a855f7'; // purple
  if (m.includes('sonnet')) return '#3b82f6'; // blue
  if (m.includes('haiku')) return '#06b6d4'; // cyan
  if (m.includes('fable')) return '#ec4899'; // pink — new tier
  return '#94a3b8'; // default / unknown — slate
}

export function statusEmissive(status: SessionStatus): {
  color: string;
  intensity: number;
} {
  // Sprint K.5: capped intensities so the planet body doesn't bloom
  // into a glowing ball under the v1.3.0 lighting (bloom intensity 1.5,
  // threshold 0.42). The atmosphere rim + pulse animations carry the
  // visual signal — the sphere itself stays a sphere.
  switch (status) {
    case 'active':
      return { color: '#fde68a', intensity: 0.30 };
    case 'awaiting_permission':
      // Slightly above bloom threshold so the red still flares through.
      return { color: '#ef4444', intensity: 0.50 };
    case 'awaiting_input':
      return { color: '#f59e0b', intensity: 0.25 };
    case 'plan_review':
      return { color: '#a78bfa', intensity: 0.20 };
    case 'error':
      return { color: '#dc2626', intensity: 0.30 };
    case 'spawning':
      return { color: '#ffffff', intensity: 0.20 };
    case 'unknown':
      // Not idle. A mirrored session whose reported state we do not
      // recognise gets its own muted violet rather than the idle slate,
      // because "we don't know" and "it is resting" are different facts and
      // the idle colour is the dimmest thing on screen.
      return { color: '#6b7280', intensity: 0.18 };
    case 'idle':
    default:
      return { color: '#1e293b', intensity: 0.05 };
  }
}

/**
 * Sprint M — color for the budget ring as spend approaches the cap.
 * Accent below 75%, amber 75–100%, red at/over the cap.
 */
export function costColor(pct: number): string {
  if (pct >= 100) return '#dc2626';
  if (pct >= 75) return '#f59e0b';
  return '#38bdf8';
}

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'awaiting_permission':
      return 'Permission';
    case 'awaiting_input':
      return 'Awaiting input';
    case 'plan_review':
      return 'Plan review';
    case 'error':
      return 'Error';
    case 'spawning':
      return 'Spawning';
    case 'terminated':
      return 'Terminated';
    case 'unknown':
      return 'Unknown';
    case 'idle':
    default:
      return 'Idle';
  }
}
