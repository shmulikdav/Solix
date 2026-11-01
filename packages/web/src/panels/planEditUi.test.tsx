// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Plan, PlanStatus, PlanTask, PlanTaskStatus } from '@solix/shared';

import { AddTask, TaskEditor, TaskRow } from './PlanPanel.js';
import { useSolixStore } from '../store/index.js';

/**
 * The visible half of plan editing.
 *
 * The brief has disclosed for weeks that "you cannot reorder, retitle,
 * retarget a model, drop a task or add one. The server endpoints for all of
 * that ship; the frontend calls two of them." These are the controls that
 * close it.
 *
 * The behaviour worth pinning is not that the buttons exist — it is what they
 * do when the plan's state forbids the edit. They stay rendered and go
 * disabled, carrying the server's own sentence in the tooltip, rather than
 * disappearing or failing on click. A control that vanishes sends people
 * hunting for a feature; one that fails teaches them not to trust controls.
 * Both are worse than a greyed button that says why.
 */
afterEach(cleanup);

function plan(status: PlanStatus): Plan {
  return {
    id: 'p1',
    name: 'ship it',
    goalPrompt: 'ship it',
    cwd: '/tmp/x',
    status,
    autoMode: false,
    createdAt: 1,
    updatedAt: 1,
  } as Plan;
}

function task(id: string, orderIndex: number, status: PlanTaskStatus = 'pending'): PlanTask {
  return {
    id,
    planId: 'p1',
    title: `task ${id}`,
    prompt: 'do it',
    acceptanceCriteria: 'it is done',
    status,
    dependsOn: [],
    orderIndex,
    attempts: 0,
    maxAttempts: 2,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Seed the store so TaskRow can find its plan and siblings. */
function seed(planStatus: PlanStatus, tasks: PlanTask[]): void {
  useSolixStore.setState({
    plans: { p1: plan(planStatus) },
    planTasks: Object.fromEntries(tasks.map((t) => [t.id, t])),
  });
}

describe('task row controls', () => {
  beforeEach(() => {
    seed('awaiting_approval', [task('a', 0), task('b', 1), task('c', 2)]);
  });

  it('offers edit, move and remove on a drafted task', () => {
    render(<TaskRow task={task('b', 1)} />);
    expect(screen.getByLabelText('Edit task').hasAttribute('disabled')).toBe(false);
    expect(screen.getByLabelText('Remove task').hasAttribute('disabled')).toBe(false);
    expect(screen.getByLabelText('Move task earlier').hasAttribute('disabled')).toBe(false);
  });

  it('disables move at each end, and says which end', () => {
    const { unmount } = render(<TaskRow task={task('a', 0)} />);
    const up = screen.getByLabelText('Move task earlier');
    expect(up.hasAttribute('disabled')).toBe(true);
    expect(up.getAttribute('title')).toBe('Already first');
    unmount();

    render(<TaskRow task={task('c', 2)} />);
    const down = screen.getByLabelText('Move task later');
    expect(down.hasAttribute('disabled')).toBe(true);
    expect(down.getAttribute('title')).toBe('Already last');
  });

  const IN_FLIGHT: PlanTaskStatus[] = ['dispatched', 'verifying'];
  for (const status of IN_FLIGHT) {
    it(`disables every control while the task is ${status}, with the reason`, () => {
      seed('running', [task('a', 0, status), task('b', 1)]);
      render(<TaskRow task={task('a', 0, status)} />);

      for (const label of ['Edit task', 'Remove task', 'Move task later']) {
        const el = screen.getByLabelText(label);
        expect(el.hasAttribute('disabled'), label).toBe(true);
        expect(el.getAttribute('title'), label).toMatch(/an agent is working on it/);
      }
    });
  }

  it('disables them on a verified task, naming the reason', () => {
    seed('running', [task('a', 0, 'completed'), task('b', 1)]);
    render(<TaskRow task={task('a', 0, 'completed')} />);
    const edit = screen.getByLabelText('Edit task');
    // Both halves asserted on purpose. An earlier version of this test
    // checked only the tooltip, and still passed when the rule was bypassed
    // and every control left enabled.
    expect(edit.hasAttribute('disabled')).toBe(true);
    expect(edit.getAttribute('title')).toMatch(/already verified/);
  });

  it('disables them once the plan is a record', () => {
    seed('completed', [task('a', 0)]);
    render(<TaskRow task={task('a', 0)} />);
    const remove = screen.getByLabelText('Remove task');
    expect(remove.hasAttribute('disabled')).toBe(true);
    expect(remove.getAttribute('title')).toMatch(/a record now/);
  });

  it('still offers them for a pending task inside a running plan', () => {
    // The case the whole feature is for: spotting a mistake mid-plan and
    // fixing the task that has not started.
    seed('running', [task('a', 0, 'completed'), task('b', 1, 'pending')]);
    render(<TaskRow task={task('b', 1, 'pending')} />);
    expect(screen.getByLabelText('Edit task').hasAttribute('disabled')).toBe(false);
  });

  it('shows the refusal in the row when a move is rejected', async () => {
    const movePlanTask = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'this task is verifying' });
    useSolixStore.setState({ movePlanTask });

    render(<TaskRow task={task('b', 1)} />);
    fireEvent.click(screen.getByLabelText('Move task earlier'));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'this task is verifying',
    );
  });
});

describe('TaskEditor', () => {
  beforeEach(() => {
    seed('awaiting_approval', [task('a', 0)]);
  });

  it('sends only the fields that changed', async () => {
    // So editing a title cannot quietly re-send a prompt someone else just
    // changed from another tab.
    const updatePlanTask = vi.fn().mockResolvedValue({ ok: true });
    useSolixStore.setState({ updatePlanTask });

    render(
      <TaskEditor task={task('a', 0)} plan={plan('awaiting_approval')} onDone={vi.fn()} />,
    );
    fireEvent.change(screen.getByDisplayValue('task a'), {
      target: { value: 'renamed' },
    });
    fireEvent.click(screen.getByText('Save'));

    await vi.waitFor(() =>
      expect(updatePlanTask).toHaveBeenCalledWith('p1', 'a', { title: 'renamed' }),
    );
  });

  it('cannot be saved until something changes', () => {
    render(
      <TaskEditor task={task('a', 0)} plan={plan('awaiting_approval')} onDone={vi.fn()} />,
    );
    expect(screen.getByText('Save').hasAttribute('disabled')).toBe(true);
  });

  it('shows the server refusal and stays open', async () => {
    const onDone = vi.fn();
    useSolixStore.setState({
      updatePlanTask: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'this plan is failed' }),
    });

    render(
      <TaskEditor task={task('a', 0)} plan={plan('awaiting_approval')} onDone={onDone} />,
    );
    fireEvent.change(screen.getByDisplayValue('task a'), {
      target: { value: 'renamed' },
    });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'this plan is failed',
    );
    // Closing on failure would discard what they typed.
    expect(onDone).not.toHaveBeenCalled();
  });

  it('labels the two prompts by who reads them', () => {
    // A worker is handed the prompt; the verifier checks the criteria. Getting
    // those the wrong way round is the mistake this feature makes possible.
    render(
      <TaskEditor task={task('a', 0)} plan={plan('awaiting_approval')} onDone={vi.fn()} />,
    );
    expect(screen.getByText(/what the worker is told/i)).toBeTruthy();
    expect(screen.getByText(/what the verifier checks/i)).toBeTruthy();
  });
});

describe('AddTask', () => {
  beforeEach(() => {
    seed('awaiting_approval', []);
  });

  it('stays collapsed until asked for', () => {
    render(<AddTask planId="p1" nextIndex={0} />);
    expect(screen.getByText('＋ Add a task')).toBeTruthy();
    expect(screen.queryByLabelText('New task prompt')).toBeNull();
  });

  it('requires a prompt as well as a title', () => {
    // A task with only a title would dispatch an agent with nothing to do.
    render(<AddTask planId="p1" nextIndex={0} />);
    fireEvent.click(screen.getByText('＋ Add a task'));
    fireEvent.change(screen.getByLabelText('New task title'), {
      target: { value: 'something' },
    });
    const add = screen.getByText('Add');
    expect(add.hasAttribute('disabled')).toBe(true);
    expect(add.getAttribute('title')).toMatch(/title and a prompt are required/);
  });

  it('defaults the acceptance criteria to the title rather than sending blank', async () => {
    // A blank criteria string would pass anything the verifier looked at.
    const addPlanTask = vi.fn().mockResolvedValue({ ok: true, taskId: 'n1' });
    useSolixStore.setState({ addPlanTask });

    render(<AddTask planId="p1" nextIndex={3} />);
    fireEvent.click(screen.getByText('＋ Add a task'));
    fireEvent.change(screen.getByLabelText('New task title'), {
      target: { value: 'write docs' },
    });
    fireEvent.change(screen.getByLabelText('New task prompt'), {
      target: { value: 'write the README' },
    });
    fireEvent.click(screen.getByText('Add'));

    await vi.waitFor(() =>
      expect(addPlanTask).toHaveBeenCalledWith('p1', {
        title: 'write docs',
        prompt: 'write the README',
        acceptanceCriteria: 'write docs',
        orderIndex: 3,
      }),
    );
  });
});
