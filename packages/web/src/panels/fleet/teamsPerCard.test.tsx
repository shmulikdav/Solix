// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TeamsTab } from './TeamsTab.js';
import { useSolixStore } from '../../store/index.js';

/**
 * The checkbox that decides whether recurring spend starts was one variable
 * for every card: `includeRoutines` was declared at tab level and rendered
 * inside `templates.map`, so unchecking "Also create N routines" on one
 * template unchecked it on all of them.
 *
 * Each of these templates bills on a cadence once installed, so answering
 * for one team must not answer for another.
 */
const TEMPLATES = [
  {
    id: 'ship-fast',
    name: 'Ship-fast build team',
    description: 'builders',
    advisors: [],
    skills: [],
    routines: [{ name: 'nightly-build', prompt: 'build', cadence: '1d' }],
  },
  {
    id: 'audit',
    name: 'Audit team',
    description: 'reviewers',
    advisors: [],
    skills: [],
    routines: [{ name: 'weekly-audit', prompt: 'audit', cadence: '7d' }],
  },
];

function stubFetch(installResult: unknown = { ok: true }) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (/\/api\/teams\/templates$/.test(url)) {
      return { ok: true, json: async () => TEMPLATES } as Response;
    }
    return { ok: true, json: async () => installResult } as Response;
  });
  // @ts-expect-error -- test double
  global.fetch = fn;
  return { calls };
}

beforeEach(() => {
  // Install short-circuits on "Pick or type a project first" without one:
  // effectiveCwd falls back to projectList[0]?.cwd.
  useSolixStore.setState({
    projects: {
      p1: { id: 'p1', name: 'proj', cwd: '/tmp/proj', lastActiveAt: 1 },
    },
    currentOrgId: 'org-default',
  } as never);
});
afterEach(cleanup);

describe('the routines checkbox', () => {
  function boxes(): HTMLInputElement[] {
    return screen.getAllByRole('checkbox') as HTMLInputElement[];
  }

  it('starts checked on every card', async () => {
    stubFetch();
    render(<TeamsTab open />);
    await screen.findByText('Ship-fast build team');
    expect(boxes()).toHaveLength(2);
    expect(boxes().every((b) => b.checked)).toBe(true);
  });

  /** The bug: one click used to answer for both teams. */
  it('unchecking one leaves the other alone', async () => {
    stubFetch();
    render(<TeamsTab open />);
    await screen.findByText('Ship-fast build team');

    fireEvent.click(boxes()[0]!);

    expect(boxes()[0]!.checked).toBe(false);
    expect(boxes()[1]!.checked).toBe(true);
  });

  it('sends each card its own answer', async () => {
    const { calls } = stubFetch();
    render(<TeamsTab open />);
    await screen.findByText('Ship-fast build team');

    fireEvent.click(boxes()[0]!); // decline routines for ship-fast only
    fireEvent.click(screen.getAllByText('Install team')[1]!); // install audit

    await waitFor(() => {
      const post = calls.find((c) => /audit\/install$/.test(c.url));
      expect(post?.body).toContain('"includeRoutines":true');
    });
  });
});

describe('what the install says afterwards', () => {
  it('names what was skipped instead of counting it', async () => {
    stubFetch({ ok: true, warnings: ['advisor "security-auditor" not found — skipped'] });
    render(<TeamsTab open />);
    await screen.findByText('Ship-fast build team');

    fireEvent.click(screen.getAllByText('Install team')[0]!);
    expect(await screen.findByText(/security-auditor/)).toBeTruthy();
  });

  /** Every cause used to render the same bare "Install failed." */
  it('gives the server reason for a failure', async () => {
    stubFetch({ ok: false, warnings: ['a working directory (cwd) is required'] });
    render(<TeamsTab open />);
    await screen.findByText('Ship-fast build team');

    fireEvent.click(screen.getAllByText('Install team')[0]!);
    expect(await screen.findByText(/working directory/)).toBeTruthy();
  });
});
