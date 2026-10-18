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

function stub(diag: unknown = DIAG, ok = true) {
  // @ts-expect-error -- test double
  global.fetch = vi.fn(async () => ({ ok, json: async () => diag }));
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
    await waitFor(() => expect(screen.getByText(/solix\s+1\.12\.0/)).toBeTruthy());
    const pre = document.querySelector('pre')!.textContent ?? '';
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
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy());
    const pre = document.querySelector('pre')!.textContent ?? '';
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
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy());
    expect(document.querySelector('pre')!.textContent).toContain(
      'fleet/routines +session',
    );
  });

  // A server that will not answer is itself the bug worth reporting, so this
  // must degrade rather than block.
  it('still lets you file when the server is unreachable', async () => {
    stub(null, false);
    render(<ReportProblem open onClose={() => {}} />);
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

  it('prefills the issue form fields it has', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<ReportProblem open onClose={() => {}} />);
    await waitFor(() => expect(document.querySelector('pre')).toBeTruthy());
    screen.getByText('Open a GitHub issue').click();

    const url = String(open.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('template=bug_report.yml');
    expect(url).toContain('solix-version=1.12.0');
    expect(url).toContain(encodeURIComponent('v22.1.0'));
    // darwin maps onto the dropdown's wording, not the raw platform string.
    expect(url).toContain(encodeURIComponent('macOS'));
    vi.unstubAllGlobals();
  });
});
