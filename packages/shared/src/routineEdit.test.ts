import { describe, expect, it } from 'vitest';
import {
  canEditRoutine,
  routineEditRefusal,
  ROUTINE_READONLY_FIELDS,
} from './routineEdit.js';
import type { TriggerKind } from './types.js';

/**
 * The rule the route and the panel both read.
 *
 * Routines were create-and-delete only, and the Routines tab said why:
 * recreating one drops its run history and rotates its webhook token. So the
 * refusals here are not the interesting part — keeping the id and the token is
 * — but they are what decides whether a control can be offered honestly.
 */
const TRIGGERS: TriggerKind[] = ['interval', 'webhook', 'manual'];

describe('CLAIM-ROUTINE-EDIT-KEEPS-HISTORY · routineEditRefusal', () => {
  it('allows the ordinary edits on an interval routine', () => {
    const r = { trigger: 'interval' as TriggerKind };
    expect(routineEditRefusal(r, { cadence: '30m' })).toBeNull();
    expect(routineEditRefusal(r, { prompt: 'sweep the logs' })).toBeNull();
    expect(routineEditRefusal(r, { name: 'nightly' })).toBeNull();
    expect(routineEditRefusal(r, { name: null })).toBeNull();
    expect(routineEditRefusal(r, { owner: 'argus' })).toBeNull();
    expect(routineEditRefusal(r, { cwd: '/srv/app' })).toBeNull();
  });

  it('allows a patch that echoes the routine back unchanged', () => {
    // A panel that PATCHes the whole object is the obvious thing to write,
    // and must not be rejected for including the trigger it already has.
    for (const trigger of TRIGGERS) {
      expect(routineEditRefusal({ trigger }, { trigger }), trigger).toBeNull();
    }
  });

  it('refuses to change the trigger, and says what to do instead', () => {
    const why = routineEditRefusal({ trigger: 'interval' }, { trigger: 'webhook' });
    expect(why).toMatch(/trigger cannot be changed/);
    expect(why).toMatch(/Create the new one/);
  });

  it('refuses a cadence on a routine that does not fire on one', () => {
    // Accepting it silently would be a lie: non-interval routines ignore the
    // cadence entirely, so the card would show a schedule nothing honours.
    expect(routineEditRefusal({ trigger: 'webhook' }, { cadence: '5m' })).toMatch(
      /fires on its webhook/,
    );
    expect(routineEditRefusal({ trigger: 'manual' }, { cadence: '5m' })).toMatch(
      /only when you trigger it/,
    );
  });

  it('refuses a cadence it cannot read, with the sentence that names the fix', () => {
    // `1w` is the one that shipped: plausible, unparseable, and parked an hour
    // out by the scheduler's fallback — 168x the agreed spend.
    const why = routineEditRefusal({ trigger: 'interval' }, { cadence: '1w' });
    expect(why).toContain('1w');
    expect(why).toMatch(/use 7d/);
    for (const bad of ['', '  ', 'hourly', '0m', '-5m', '5 minutes']) {
      expect(routineEditRefusal({ trigger: 'interval' }, { cadence: bad }), bad)
        .not.toBeNull();
    }
  });

  it('refuses to empty the prompt or the directory', () => {
    expect(routineEditRefusal({ trigger: 'interval' }, { prompt: '   ' })).toMatch(
      /nothing to do/,
    );
    expect(routineEditRefusal({ trigger: 'interval' }, { cwd: '' })).toMatch(
      /needs a directory/,
    );
  });

  it('treats a missing routine as not found', () => {
    expect(routineEditRefusal(null, { prompt: 'x' })).toBe('not found');
    expect(routineEditRefusal(undefined, {})).toBe('not found');
  });

  it('defaults an unset trigger to interval, as the row reader does', () => {
    // Legacy rows have a null trigger and are interval routines.
    expect(routineEditRefusal({}, { cadence: '15m' })).toBeNull();
    expect(routineEditRefusal({}, { trigger: 'webhook' })).not.toBeNull();
  });

  it('names the token and enabled among the fields a patch may never set', () => {
    // The two that make a recreate destructive, plus the keys that identify
    // the row. This list is what the route strips.
    expect(ROUTINE_READONLY_FIELDS).toContain('webhookToken');
    expect(ROUTINE_READONLY_FIELDS).toContain('enabled');
    expect(ROUTINE_READONLY_FIELDS).toContain('id');
  });

  it('canEditRoutine agrees with the refusal, across every trigger', () => {
    for (const trigger of TRIGGERS) {
      for (const patch of [
        {},
        { cadence: '1h' },
        { cadence: 'nope' },
        { prompt: '' },
        { prompt: 'go' },
        { trigger: 'manual' as TriggerKind },
      ]) {
        const why = routineEditRefusal({ trigger }, patch);
        expect(canEditRoutine({ trigger }, patch), `${trigger} ${JSON.stringify(patch)}`)
          .toBe(why === null);
      }
    }
  });
});
