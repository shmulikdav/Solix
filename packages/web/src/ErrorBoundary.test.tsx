// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.js';

/**
 * Guards the exact failure that blanked the whole UI: a texture loader throwing
 * inside a <Suspense> whose fallback was meant to be the graceful degradation.
 * Suspense does not catch errors — only the pending state — so without a
 * boundary the error unmounted the entire React tree.
 */
function Boom(): JSX.Element {
  throw new Error('Could not load /textures/earth.jpg');
}

function Suspending(): JSX.Element {
  throw new Promise(() => {}); // never resolves → stays pending
}

afterEach(cleanup);

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary fallback={<span>fallback</span>}>
        <span>content</span>
      </ErrorBoundary>,
    );
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('swaps in the fallback when a child throws, instead of propagating', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {}); // React noise
    expect(() =>
      render(
        <ErrorBoundary label="texture" fallback={<span>procedural</span>}>
          <Boom />
        </ErrorBoundary>,
      ),
    ).not.toThrow();
    expect(screen.getByText('procedural')).toBeTruthy();
    expect(warn).toHaveBeenCalled(); // degraded loudly, not silently
    err.mockRestore();
    warn.mockRestore();
  });

  it('does not swallow a suspending child — Suspense still handles pending', () => {
    // The boundary must not mistake a thrown promise for a failure.
    render(
      <ErrorBoundary fallback={<span>error-fallback</span>}>
        <Suspense fallback={<span>loading</span>}>
          <Suspending />
        </Suspense>
      </ErrorBoundary>,
    );
    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByText('error-fallback')).toBeNull();
  });

  it('a sibling outside the boundary keeps rendering (the HUD survives)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <span>hud</span>
        <ErrorBoundary fallback={<span>scene-unavailable</span>}>
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText('hud')).toBeTruthy();
    expect(screen.getByText('scene-unavailable')).toBeTruthy();
    err.mockRestore();
    warn.mockRestore();
  });
});
