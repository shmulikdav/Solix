import { cadenceToMs, cadenceHelp } from './cadence.js';
import type { TriggerKind } from './types.js';

/**
 * What a routine edit may change, and what it must refuse.
 *
 * Routines could be created and deleted and nothing else. The Routines tab
 * said why: "there is no edit: the server has no PATCH for a routine, and
 * recreating one would drop its run history and rotate its webhook token,
 * silently breaking any webhook already pointed at it." So a typo in a cadence
 * cost you the routine's history and any URL pointed at it — on the surface
 * whose whole purpose is making recurring spend controllable.
 *
 * A patch is the fix, and it has to keep the two things a recreate destroyed:
 * the run history and the token. Neither is reachable from here, which is the
 * point — this says what may move, and the route strips the rest.
 *
 * Shared so the panel can grey a field with the same sentence the route would
 * answer with. Two copies drift, and the drift shows up as a control that
 * looks available and then fails.
 */
export interface RoutinePatch {
  name?: string | null;
  prompt?: string;
  cadence?: string;
  owner?: string | null;
  cwd?: string;
}

/** Fields a PATCH may never set, whatever the caller sends. */
export const ROUTINE_READONLY_FIELDS = [
  // `enabled` has its own route, and a generic PATCH must not start a routine
  // spending money behind the toggle's back — the same rule the plan PATCH has
  // followed since 1.17.
  'enabled',
  // The token is the capability. Rotating it on an edit is precisely the
  // breakage this feature exists to avoid.
  'webhookToken',
  'id',
  'projectId',
  'lastRunAt',
  'nextRunAt',
] as const;

export function routineEditRefusal(
  routine: { trigger?: TriggerKind } | null | undefined,
  patch: RoutinePatch & { trigger?: TriggerKind },
): string | null {
  if (!routine) return 'not found';
  const trigger: TriggerKind = routine.trigger ?? 'interval';

  // Echoing the routine's own trigger back is a no-op, which matters because
  // a UI that sends the whole object is the obvious thing to write.
  if (patch.trigger !== undefined && patch.trigger !== trigger) {
    return (
      `a routine's trigger cannot be changed — a webhook routine's URL is ` +
      `bound to its kind. Create the new one, then delete this one`
    );
  }

  if (patch.cadence !== undefined) {
    if (trigger !== 'interval') {
      return `only an interval routine has a cadence — this one fires ${
        trigger === 'webhook' ? 'on its webhook' : 'only when you trigger it'
      }`;
    }
    if (cadenceToMs(patch.cadence) === null) return cadenceHelp(patch.cadence);
  }

  if (patch.prompt !== undefined && patch.prompt.trim() === '') {
    return 'a routine with no prompt would start an agent with nothing to do';
  }

  if (patch.cwd !== undefined && patch.cwd.trim() === '') {
    return 'a routine needs a directory to run in';
  }

  return null;
}

export function canEditRoutine(
  routine: { trigger?: TriggerKind } | null | undefined,
  patch: RoutinePatch & { trigger?: TriggerKind },
): boolean {
  return routineEditRefusal(routine, patch) === null;
}
