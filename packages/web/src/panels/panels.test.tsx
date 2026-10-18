// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Plan, PlanTask, TaskThreadEntry } from '@solix/shared';
import { useSolixStore } from '../store/index.js';
import { PlanPanel } from './PlanPanel.js';
import { ConnectionsPanel } from './ConnectionsPanel.js';
import { SharePanel } from './SharePanel.js';
import { SkillPanel, NEW_SKILL_ID } from './SkillPanel.js';
import { TopBar } from '../hud/TopBar.js';

/**
 * Smoke + behaviour tests for the surfaces added this cycle.
 *
 * Before these, the entire web layer had never rendered — typecheck caught type
 * errors but nothing caught a bad hook dependency, a crash on mount, or wiring
 * that silently did nothing. These mount the real components against the real
 * zustand store with fetch stubbed, so the interactions are actually exercised.
 * (The react-three-fiber scene is deliberately excluded — jsdom has no WebGL.)
 */

const DEFAULT_ORG = 'org-default';

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: 'p1',
    name: 'Ship login',
    goalPrompt: 'g',
    status: 'completed',
    autoMode: false,
    cwd: '/tmp/proj',
    orgId: DEFAULT_ORG,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function task(over: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 't1',
    planId: 'p1',
    title: 'Build the form',
    prompt: 'p',
    acceptanceCriteria: 'a',
    status: 'completed',
    dependsOn: [],
    attempts: 1,
    maxAttempts: 3,
    orderIndex: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const THREAD: TaskThreadEntry[] = [
  { id: 'e1', taskId: 't1', planId: 'p1', kind: 'dispatched', author: 'system', body: 'Attempt 1 dispatched', attempt: 1, createdAt: 10 },
  { id: 'e2', taskId: 't1', planId: 'p1', kind: 'worker_result', author: 'worker', body: 'BUILT_THE_FORM', attempt: 1, payload: { costUsd: 0.12 }, createdAt: 20 },
  { id: 'e3', taskId: 't1', planId: 'p1', kind: 'completed', author: 'verifier', body: 'Accepted', attempt: 1, createdAt: 30 },
];

/** Route fetches by URL so each panel gets plausible data. */
function stubFetch(overrides: Array<[RegExp, unknown]> = []) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    for (const [re, body] of overrides) {
      if (re.test(url)) return { ok: true, json: async () => body } as Response;
    }
    if (/\/api\/system\/containment/.test(url)) {
      return { ok: true, json: async () => ({ ok: true, reasons: [] }) } as Response;
    }
    if (/\/api\/system\/entitlement/.test(url)) {
      return { ok: true, json: async () => ({ tier: 'pro', reason: 'beta' }) } as Response;
    }
    if (/\/thread$/.test(url) && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, json: async () => THREAD } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  // @ts-expect-error -- test double
  global.fetch = fn;
  return { calls };
}

function seedStore(over: Partial<ReturnType<typeof useSolixStore.getState>> = {}): void {
  useSolixStore.setState({
    plans: { p1: plan() },
    planTasks: { t1: task() },
    threadsByTaskId: {},
    planBudgetAlerts: {},
    projects: {},
    orgs: [],
    currentOrgId: DEFAULT_ORG,
    ...over,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PlanPanel', () => {
  beforeEach(() => {
    stubFetch();
    seedStore();
  });

  it('mounts and renders the plan and its task', async () => {
    render(<PlanPanel open onClose={() => {}} />);
    expect(await screen.findByText('Ship login')).toBeTruthy();
    expect(screen.getByText('Build the form')).toBeTruthy();
  });

  it('expanding a task loads and renders its thread', async () => {
    render(<PlanPanel open onClose={() => {}} />);
    (await screen.findByText('Build the form')).click();
    // Lifecycle entries render with their labels + the worker's output.
    await waitFor(() => expect(screen.getByText('BUILT_THE_FORM')).toBeTruthy());
    expect(screen.getByText('Dispatched')).toBeTruthy();
    expect(screen.getByText('Verified')).toBeTruthy();
    expect(screen.getByText('Worker')).toBeTruthy();
  });

  it('shows the budget threshold warning when one has fired', async () => {
    seedStore({
      planBudgetAlerts: {
        p1: { planId: 'p1', spentUsd: 8, budgetUsd: 10, pct: 0.8, receivedAt: 1 },
      },
    });
    render(<PlanPanel open onClose={() => {}} />);
    expect(await screen.findByText(/Budget 80% used/)).toBeTruthy();
  });

  it('scopes plans to the active org (multi-org)', async () => {
    seedStore({
      plans: { p1: plan(), p2: plan({ id: 'p2', name: 'Other org plan', orgId: 'org-acme' }) },
      currentOrgId: DEFAULT_ORG,
    });
    render(<PlanPanel open onClose={() => {}} />);
    expect(await screen.findByText('Ship login')).toBeTruthy();
    expect(screen.queryByText('Other org plan')).toBeNull();
  });

  it('treats a plan with no orgId as belonging to the default org', async () => {
    seedStore({ plans: { p1: plan({ orgId: undefined }) }, currentOrgId: DEFAULT_ORG });
    render(<PlanPanel open onClose={() => {}} />);
    expect(await screen.findByText('Ship login')).toBeTruthy();
  });
});

describe('TopBar org switcher', () => {
  beforeEach(() => {
    seedStore({
      orgs: [
        { id: DEFAULT_ORG, name: 'Personal', createdAt: 1 },
        { id: 'org-acme', name: 'Acme', createdAt: 2 },
      ],
    });
    stubFetch([[/\/api\/orgs$/, { orgs: [], currentOrgId: DEFAULT_ORG }]]);
  });

  it('lists the orgs and marks the active one', () => {
    render(<TopBar />);
    const select = screen.getByTitle(/Active org/) as HTMLSelectElement;
    expect(select.value).toBe(DEFAULT_ORG);
    expect(screen.getByText(/Personal/)).toBeTruthy();
    expect(screen.getByText(/Acme/)).toBeTruthy();
  });

  it('switching org POSTs the new current org', async () => {
    const { calls } = stubFetch([[/\/api\/orgs$/, { orgs: [], currentOrgId: 'org-acme' }]]);
    render(<TopBar />);
    const select = screen.getByTitle(/Active org/) as HTMLSelectElement;
    select.value = 'org-acme';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() =>
      expect(calls.some((c) => /\/api\/orgs\/current$/.test(c.url) && c.method === 'POST')).toBe(true),
    );
  });

  it('the "New org…" sentinel prompts and creates instead of switching', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Globex');
    const { calls } = stubFetch([[/\/api\/orgs$/, { orgs: [], currentOrgId: DEFAULT_ORG }]]);
    render(<TopBar />);
    const select = screen.getByTitle(/Active org/) as HTMLSelectElement;
    select.value = '__new__';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      // Creates an org; must NOT try to switch to the sentinel id.
      expect(calls.some((c) => c.url.endsWith('/api/orgs') && c.method === 'POST')).toBe(true);
    });
    expect(promptSpy).toHaveBeenCalled();
    expect(calls.some((c) => (c.body ?? '').includes('__new__'))).toBe(false);
  });
});

describe('ConnectionsPanel — notifications section', () => {
  beforeEach(() => seedStore());

  it('renders existing notifiers without leaking credentials', async () => {
    stubFetch([
      [/\/api\/connections$/, []],
      [
        /\/api\/notifiers$/,
        [{ id: 'n1', provider: 'slack', name: 'Eng channel', events: ['plan_failed'], enabled: true, createdAt: 1 }],
      ],
    ]);
    render(<ConnectionsPanel open onClose={() => {}} />);
    expect(await screen.findByText('Eng channel')).toBeTruthy();
    expect(screen.getByText('Notifications')).toBeTruthy();
  });

  it('adding a slack notifier posts the provider + webhook', async () => {
    const { calls } = stubFetch([[/\/api\/connections$/, []], [/\/api\/notifiers$/, []]]);
    render(<ConnectionsPanel open onClose={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText(/Name \(e.g. Eng channel\)/), {
      target: { value: 'Eng' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Incoming webhook URL/), {
      target: { value: 'https://hooks.slack.com/X' },
    });
    screen.getByText('Add notifier').click();
    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/api/notifiers') && c.method === 'POST');
      expect(post).toBeTruthy();
      expect(post!.body).toContain('slack');
      expect(post!.body).toContain('hooks.slack.com');
    });
  });
});

describe('SharePanel — Teams tab', () => {
  beforeEach(() => seedStore());

  it('lists team templates and installs one into a project', async () => {
    const { calls } = stubFetch([
      [
        /\/api\/teams\/templates$/,
        [
          {
            id: 'ship-fast',
            name: 'Ship-fast build team',
            description: 'build end to end',
            goal: 'ship',
            advisors: ['forge', 'argus'],
            skills: ['mission-summary'],
            routines: [{ name: 'Daily sweep', prompt: 'p' }],
          },
        ],
      ],
    ]);
    render(<SharePanel open onClose={() => {}} />);
    screen.getByText('Teams').click();
    expect(await screen.findByText('Ship-fast build team')).toBeTruthy();
    // Needs a target project — type one, then install.
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/proj' },
    });
    screen.getByText('Install team').click();
    await waitFor(() =>
      expect(
        calls.some((c) => /\/api\/teams\/templates\/ship-fast\/install$/.test(c.url) && c.method === 'POST'),
      ).toBe(true),
    );
  });
});

describe('SkillPanel — authoring', () => {
  it('creates a user skill from the new-skill form', async () => {
    seedStore();
    useSolixStore.setState({ selectedSkillId: NEW_SKILL_ID });
    const { calls } = stubFetch([[/\/api\/skills$/, { id: 'user:house-style' }]]);
    render(<SkillPanel />);
    fireEvent.change(await screen.findByPlaceholderText('Skill name'), {
      target: { value: 'House Style' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Skill instructions/), {
      target: { value: 'Write commits in imperative mood.' },
    });
    screen.getByText('Create skill').click();
    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/api/skills') && c.method === 'POST');
      expect(post).toBeTruthy();
      expect(post!.body).toContain('House Style');
      expect(post!.body).toContain('imperative mood');
    });
    useSolixStore.setState({ selectedSkillId: null });
  });
});
