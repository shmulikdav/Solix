// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { PlanReview } from '@solix/shared';

import { BaseRefNote } from './PlanPanel.js';

/**
 * "Review changes" asks "what did the fleet change?". When a plan has no
 * usable base — which is every plan that failed before approval, since the
 * base is captured at approve time — the server falls back to diffing the
 * working tree against HEAD, and the answer became *the user's own
 * uncommitted edits*, presented as the fleet's work.
 *
 * The server had always said so: `baseRef` undefined means it fell back.
 * Nothing in the client read it. These pin the three states apart, because
 * "its base is gone" and "it never had one" are different kinds of wrong and
 * a reader deserves to know which.
 */
function review(over: Partial<PlanReview> = {}): PlanReview {
  return { ok: true, files: [], diff: '', ...over };
}

afterEach(cleanup);

describe('BaseRefNote', () => {
  it('warns when there is no base at all', () => {
    render(<BaseRefNote review={review()} />);
    expect(screen.getByText(/may not be the fleet's changes/i)).toBeTruthy();
    expect(screen.getByText(/never recorded a starting commit/i)).toBeTruthy();
  });

  it('tells you to check git status, because that is the actual remedy', () => {
    render(<BaseRefNote review={review()} />);
    expect(screen.getByText(/git status/)).toBeTruthy();
  });

  it('says when the base existed but is gone, and names it', () => {
    render(
      <BaseRefNote review={review({ requestedBaseRef: 'deadbeefcafe1234' })} />,
    );
    expect(screen.getByText(/no longer in this repo/i)).toBeTruthy();
    expect(screen.getByText('deadbeefcafe')).toBeTruthy();
  });

  /** The honest case should be legible too, not merely unwarned. */
  it('names the base when there is a good one, and does not warn', () => {
    render(<BaseRefNote review={review({ baseRef: 'abc123def456789' })} />);
    expect(screen.getByText('abc123def456')).toBeTruthy();
    expect(screen.queryByText(/may not be the fleet's changes/i)).toBeNull();
  });

  it('is announced, since it changes what the diff below means', () => {
    const { container } = render(<BaseRefNote review={review()} />);
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });
});
