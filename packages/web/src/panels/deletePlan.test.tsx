// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DeletePlanButton } from './PlanPanel.js';

/**
 * `DELETE /api/plans/:id` shipped and nothing called it, so a planner
 * failure left a permanent zero-task `failed` card — and three attempts at
 * one goal left three dead cards that could never be cleared.
 *
 * Two-step rather than `window.confirm`: NewTaskModal already rejected
 * browser dialogs for looking like the browser talking rather than the app,
 * and this is irreversible.
 */
afterEach(cleanup);

describe('DeletePlanButton', () => {
  it('does not delete on the first click', () => {
    const onDelete = vi.fn();
    render(<DeletePlanButton onDelete={onDelete} busy={false} />);

    fireEvent.click(screen.getByText('Delete this plan'));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('says it cannot be undone before it does it', () => {
    render(<DeletePlanButton onDelete={vi.fn()} busy={false} />);
    fireEvent.click(screen.getByText('Delete this plan'));
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  });

  it('deletes on the confirming click', () => {
    const onDelete = vi.fn();
    render(<DeletePlanButton onDelete={onDelete} busy={false} />);

    fireEvent.click(screen.getByText('Delete this plan'));
    fireEvent.click(screen.getByText(/cannot be undone/i));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('lets you back out', () => {
    const onDelete = vi.fn();
    render(<DeletePlanButton onDelete={onDelete} busy={false} />);

    fireEvent.click(screen.getByText('Delete this plan'));
    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.getByText('Delete this plan')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('is disabled while something else is in flight', () => {
    render(<DeletePlanButton onDelete={vi.fn()} busy={true} />);
    expect(
      (screen.getByText('Delete this plan') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
