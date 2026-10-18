// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSolixStore } from '../store/index.js';
import { ConnectionDot } from './ConnectionDot.js';

/**
 * The chip this replaced looked like a button and was not one. These keep the
 * replacement honest: the state must survive without colour vision, and the
 * detail must be reachable without a mouse.
 */
afterEach(cleanup);

describe('ConnectionDot', () => {
  it('no longer renders the shouty chip wording', () => {
    useSolixStore.setState({ connected: true });
    render(<ConnectionDot />);
    expect(screen.queryByText('CONNECTED')).toBeNull();
    expect(screen.queryByText('OFFLINE')).toBeNull();
  });

  // Dropping the label entirely was an over-correction: the chip looked like
  // a button, so it became a bare dot that said nothing. A dot plus one word
  // is readable without being button-shaped.
  it('labels the state in a word', () => {
    useSolixStore.setState({ connected: true });
    render(<ConnectionDot />);
    expect(screen.getByText('Live')).toBeTruthy();
    cleanup();
    useSolixStore.setState({ connected: false });
    render(<ConnectionDot />);
    expect(screen.getByText('Offline')).toBeTruthy();
  });

  it('carries the full state in an aria-label when connected', () => {
    useSolixStore.setState({ connected: true });
    render(<ConnectionDot />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(
      'Connected — live updates are flowing.',
    );
  });

  // The chip said only "OFFLINE". It never said the client retries by itself,
  // or that what is on screen is stale until it succeeds.
  it('explains the retry and the staleness when offline', () => {
    useSolixStore.setState({ connected: false });
    render(<ConnectionDot />);
    const label = screen.getByRole('status').getAttribute('aria-label') ?? '';
    expect(label).toContain('Retrying every 1.5s');
    expect(label).toContain('stale');
  });

  // Hue alone is not a channel. Offline is hollow and pulsing; connected is
  // solid and still.
  it('distinguishes the states by more than colour', () => {
    useSolixStore.setState({ connected: false });
    const { container: offline } = render(<ConnectionDot />);
    const offlineDot = offline.querySelectorAll('[aria-hidden="true"]')[0]!;
    expect(offlineDot.className).toContain('solix-pulse');
    expect(offlineDot.className).toContain('border');
    expect(offlineDot.className).not.toContain('bg-solix');

    cleanup();
    useSolixStore.setState({ connected: true });
    const { container: online } = render(<ConnectionDot />);
    const onlineDot = online.querySelectorAll('[aria-hidden="true"]')[0]!;
    expect(onlineDot.className).toContain('bg-solix-ok');
    expect(onlineDot.className).not.toContain('solix-pulse');
  });

  it('shows the tooltip on hover', () => {
    useSolixStore.setState({ connected: true });
    render(<ConnectionDot />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('status'));
    expect(screen.getByRole('tooltip').textContent).toContain('live updates');
  });

  // A dot with no label is unusable if the only way to read it is hovering.
  it('shows the tooltip on keyboard focus too', () => {
    useSolixStore.setState({ connected: false });
    render(<ConnectionDot />);
    const dot = screen.getByRole('status');
    expect(dot.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(dot);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toContain('Retrying');
    expect(dot.getAttribute('aria-describedby')).toBe(tip.id);
  });
});
