// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ScheduledTask, TriggerKind } from '@solix/shared';

import { RoutineCard, RoutineEditor } from './RoutinesTab.js';
import { useSolixStore } from '../../store/index.js';

/**
 * The visible half of routine editing.
 *
 * The brief has disclosed this for weeks: "Routines cannot be edited. A typo
 * in a cadence means delete and recreate, which loses the run history and
 * rotates the webhook token." The parenthetical after it — "(Bad cadences are
 * at least now refused rather than silently firing hourly.)" — is the part
 * that made this urgent: the release that started refusing bad cadences could
 * do nothing for anyone who already had one.
 *
 * What is pinned here is not that the fields exist. It is that the cadence is
 * validated with the server's own parser before anything is sent, that a
 * refusal leaves the editor open with what you typed, and that the control for
 * an edit which cannot be done is disabled with the reason rather than hidden.
 */
afterEach(cleanup);

function routine(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'r1',
    projectId: 'p1',
    cwd: '/srv/app',
    name: 'nightly sweep',
    prompt: 'sweep the logs',
    cron: '1h',
    enabled: true,
    nextRunAt: Date.now() + 3_600_000,
    trigger: 'interval' as TriggerKind,
    ...over,
  };
}

function seed(r: ScheduledTask): void {
  useSolixStore.setState({ schedules: { [r.id]: r }, projects: {} });
}

beforeEach(() => {
  seed(routine());
});

describe('CLAIM-ROUTINE-EDIT-KEEPS-HISTORY · RoutineEditor', () => {
  it('sends only the fields that changed', async () => {
    const updateSchedule = vi.fn().mockResolvedValue({ ok: true });
    useSolixStore.setState({ updateSchedule });

    render(<RoutineEditor routine={routine()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Routine cadence'), {
      target: { value: '30m' },
    });
    fireEvent.click(screen.getByText('Save'));

    await vi.waitFor(() =>
      expect(updateSchedule).toHaveBeenCalledWith('r1', { cadence: '30m' }),
    );
  });

  it('cannot be saved until something changes', () => {
    render(<RoutineEditor routine={routine()} onDone={vi.fn()} />);
    const save = screen.getByText('Save');
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(save.getAttribute('title')).toMatch(/Nothing has changed/);
  });

  it('refuses a cadence the server could not read, before sending it', async () => {
    // `1w` is the one that shipped: plausible, unparseable, parked an hour out
    // by the scheduler's fallback. Catching it here means the same sentence
    // whether or not the request is made.
    const updateSchedule = vi.fn().mockResolvedValue({ ok: true });
    useSolixStore.setState({ updateSchedule });

    render(<RoutineEditor routine={routine()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Routine cadence'), {
      target: { value: '1w' },
    });

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('use 7d') as unknown as string,
    );
    const save = screen.getByText('Save');
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(save);
    expect(updateSchedule).not.toHaveBeenCalled();
  });

  it('states the new spend before the button that commits to it', () => {
    // Changing a cadence changes how often money is spent, so the editor says
    // so in the same breath as the team installer and the create form.
    render(<RoutineEditor routine={routine()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Routine cadence'), {
      target: { value: '10m' },
    });
    expect(screen.getByText(/every 10m instead of\s+every 1h/)).toBeTruthy();
  });

  it('disables the cadence on a webhook routine and says why', () => {
    // Accepting one would be a lie — non-interval routines ignore it entirely.
    const r = routine({ trigger: 'webhook', webhookToken: 'tok', cron: 'webhook' });
    seed(r);
    render(<RoutineEditor routine={r} onDone={vi.fn()} />);
    const field = screen.getByLabelText('Routine cadence');
    expect(field.hasAttribute('disabled')).toBe(true);
    expect(field.getAttribute('title')).toMatch(/fires on its webhook/);
  });

  it('shows the server refusal and stays open', async () => {
    const onDone = vi.fn();
    useSolixStore.setState({
      updateSchedule: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'could not reach the server' }),
    });

    render(<RoutineEditor routine={routine()} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('Routine prompt'), {
      target: { value: 'sweep the logs twice' },
    });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'could not reach the server',
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('says what is kept, because losing it was the old cost of editing', () => {
    const r = routine({ trigger: 'webhook', webhookToken: 'tok' });
    seed(r);
    const { unmount } = render(<RoutineEditor routine={r} onDone={vi.fn()} />);
    expect(screen.getByText(/run history and webhook URL are kept/)).toBeTruthy();
    unmount();

    render(<RoutineEditor routine={routine()} onDone={vi.fn()} />);
    expect(screen.getByText(/run history and schedule node are kept/)).toBeTruthy();
  });

  it('closes on a successful save', async () => {
    const onDone = vi.fn();
    useSolixStore.setState({ updateSchedule: vi.fn().mockResolvedValue({ ok: true }) });

    render(<RoutineEditor routine={routine()} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText('Routine name'), {
      target: { value: 'renamed' },
    });
    fireEvent.click(screen.getByText('Save'));

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});

describe('CLAIM-ROUTINE-EDIT-KEEPS-HISTORY · RoutineCard', () => {
  it('offers Edit, and opens the editor on the routine', () => {
    render(<RoutineCard routine={routine()} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Routine prompt')).toHaveProperty(
      'value',
      'sweep the logs',
    );
  });

  it('warns that deleting is still the destructive option', () => {
    // Edit exists now, so Delete's tooltip has to stay honest about the
    // difference: the history and the URL go with it.
    render(<RoutineCard routine={routine()} />);
    expect(screen.getByText('Delete').getAttribute('title')).toMatch(
      /run history and its webhook URL/,
    );
  });
});
