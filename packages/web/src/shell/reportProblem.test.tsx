// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useSolixStore } from '../store/index.js';
import { ReportProblem } from './ReportProblem.js';

/**
 * Solix's central claim is that nothing leaves your machine. This is the one
 * control that offers to send something outward, so what it sends is tested
 * rather than trusted: versions, counts and hook state, never a path, a
 * project name or a prompt.
 */
const DIAG = {
  version: '1.12.0',
  node: 'v22.1.0',
  platform: 'darwin',
  arch: 'arm64',
  hooks: {
    installed: true,
    upToDate: false,
    stampedVersion: '1.11.8',
    claudeCodePresent: true,
    supported: true,
  },
  sessions: { total: 3, byStatus: { active: 1, idle: 2 } },
  uptimeSec: 42,
};

/** Releases the gated fetch below. Set by `stub()`. */
let land: () => void;

function stub(diag: unknown = DIAG, ok = true) {
  // The response lands only when a test says so, rather than after a delay.
  //
  // A real fetch never resolves inside the first render, and the <pre> is on
  // screen before it does, holding the "could not reach" fallback. A test that
  // waits on the ELEMENT rather than its content therefore reads the fallback:
  // that failed outright on a loaded machine, and — worse — made the leak
  // assertions below pass against a string containing no diagnostics at all.
  //
  // A timed stub does not pin this down: a `setTimeout(0)` is flushed by
  // React Testing Library's act wrapper before `waitFor` first looks, so the
  // broken form still passed. Gating on an explicit signal makes the real
  // ordering the only ordering, on every machine, with no timing involved.
  const gate = new Promise<void>((resolve) => {
    land = resolve;
  });
  // @ts-expect-error -- test double
  global.fetch = vi.fn(async () => {
    await gate;
    return { ok, json: async () => diag };
  });
}

/** Lets the response land, then returns the diagnostics actually rendered. */
async function diagnostics(): Promise<string> {
  land();
  await waitFor(() =>
    expect(document.querySelector('pre')?.textContent).toMatch(/^solix\s+\d/m),
  );
  return document.querySelector('pre')!.textContent ?? '';
}

beforeEach(() => {
  stub();
  useSolixStore.setState({
    viewMode: 'galaxy',
    workspaceSurface: null,
    activePanel: null,
  });
});
afterEach(cleanup);

describe('ReportProblem', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <ReportProblem open={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the payload before anything is sent', async () => {
    render(<ReportProblem open onClose={() => {}} />);
    const pre = await diagnostics();
    expect(pre).toContain('solix       1.12.0');
    expect(pre).toContain('node        v22.1.0');
    expect(pre).toContain('platform    darwin/arm64');
    // The thing a maintainer needs first: are the hooks even current?
    expect(pre).toContain('upToDate=false');
    expect(pre).toContain('stamped=1.11.8');
  });

  /**
   * The property that matters. A tester pasting diagnostics into a public
   * issue must not be publishing their directory layout or client names.
   */
  it('leaks no paths, project names or prompts', async () => {
    useSolixStore.setState({
      workspaceSurface: { kind: 'fleet', tab: 'crew' },
      sessions: {
        s1: {
          id: 's1',
          name: 'acme-client-migration',
          cwd: '/Users/me/work/acme-secret-project',
        } as never,
      },
    });
    render(<ReportProblem open onClose={() => {}} />);
    // Must be the real payload — asserting absence against the fallback
    // string would prove nothing.
    const pre = await diagnostics();
    expect(pre).not.toContain('/Users/');
    expect(pre).not.toContain('acme');
    // Counts are fine — they say nothing about what the work is.
    expect(pre).toContain('sessions    3');
  });

  it('records which screen you were on, by kind not by name', async () => {
    useSolixStore.setState({
      workspaceSurface: { kind: 'fleet', tab: 'routines' },
      activePanel: 'session',
    });
    render(<ReportProblem open onClose={() => {}} />);
    expect(await diagnostics()).toContain('fleet/routines +session');
  });

  // A server that will not answer is itself the bug worth reporting, so this
  // must degrade rather than block.
  it('still lets you file when the server is unreachable', async () => {
    stub(null, false);
    render(<ReportProblem open onClose={() => {}} />);
    land();
    await waitFor(() =>
      expect(screen.getByText(/did not answer/)).toBeTruthy(),
    );
    expect(screen.getByText('Open a GitHub issue')).toBeTruthy();
  });

  it('closes on Escape, like every other modal', async () => {
    const onClose = vi.fn();
    render(<ReportProblem open onClose={onClose} />);
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy());
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * Reads the anchor's href rather than spying on window.open.
   *
   * This used to be `window.open(href, '_blank', 'noopener,noreferrer')`,
   * where the third argument is the only way that API grants noopener — and
   * also the thing that makes the browser open a chromeless popup, with no
   * address bar and no back button. On a page whose destination is
   * github.com, and which the user is about to type a bug report into,
   * hiding the address is the wrong thing to take away. An anchor gets a
   * real tab and noopener both.
   */
  it('prefills the issue form fields it has', async () => {
    render(<ReportProblem open onClose={() => {}} />);
    await diagnostics();

    const link = screen.getByText('Open a GitHub issue') as HTMLAnchorElement;
    const url = link.href;
    expect(url).toContain('template=bug_report.yml');
    expect(url).toContain('solix-version=1.12.0');
    expect(url).toContain(encodeURIComponent('v22.1.0'));
    // darwin maps onto the dropdown's wording, not the raw platform string.
    expect(url).toContain(encodeURIComponent('macOS'));
  });

  it('opens a real tab, not a chromeless popup', async () => {
    render(<ReportProblem open onClose={() => {}} />);
    await diagnostics();

    const link = screen.getByText('Open a GitHub issue') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });
});
