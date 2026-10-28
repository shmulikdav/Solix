// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

import { ConnectionsTab } from './ConnectionsTab.js';
import { ListPlaceholder } from '../../ui/LoadState.js';

/**
 * Connections is a credential store whose secret values are write-only by
 * design — "values are never shown or returned". Every write in it was
 * `fetch(...).catch(() => {})` with no `res.ok` check: six of them, covering
 * adding a connection, adding/toggling/deleting a notifier, setting a secret
 * or granting a scope, and the Test button.
 *
 * So a write that failed was both invisible and unrecoverable: the input
 * cleared, the key never appeared, and nothing said why. And `refresh()`
 * swallowed its failure too, leaving the list `[]` — so an unreachable
 * server rendered "No connections yet. Add one above", telling you to create
 * something you may already have.
 */
const NOTIFIER = {
  id: 'n1',
  provider: 'slack' as const,
  name: 'Eng channel',
  events: ['plan_failed'],
  enabled: true,
  createdAt: 1,
};

/** Routes by regex; anything unmatched is a network failure. */
function stubFetch(routes: Array<[RegExp, { ok?: boolean; body?: unknown }]>) {
  const fn = vi.fn(async (url: string) => {
    for (const [re, res] of routes) {
      if (re.test(url)) {
        if (res.ok === false) {
          return {
            ok: false,
            status: 500,
            json: async () => res.body ?? {},
          } as Response;
        }
        return { ok: true, json: async () => res.body ?? {} } as Response;
      }
    }
    throw new Error('network down');
  });
  // @ts-expect-error -- test double
  global.fetch = fn;
  return fn;
}

afterEach(cleanup);

describe('the Test button', () => {
  const base: Array<[RegExp, { ok?: boolean; body?: unknown }]> = [
    [/\/api\/connections$/, { body: [] }],
    [/\/api\/notifiers$/, { body: [NOTIFIER] }],
  ];

  /** It rendered nothing either way — indistinguishable from a dead button. */
  it('says so when the message was delivered', async () => {
    stubFetch([...base, [/\/notifiers\/n1\/test$/, { body: { ok: true } }]]);
    render(<ConnectionsTab open />);

    fireEvent.click(await screen.findByText('Test'));
    expect(await screen.findByText(/delivered/i)).toBeTruthy();
  });

  /**
   * The server answers `{ ok: false }` with HTTP 200 when the webhook itself
   * rejected it — a successful request about a failed delivery. Saying
   * nothing here is the worst case: the credential is wrong and you think it
   * works.
   */
  it('says so when the server could not deliver it', async () => {
    stubFetch([...base, [/\/notifiers\/n1\/test$/, { body: { ok: false } }]]);
    render(<ConnectionsTab open />);

    fireEvent.click(await screen.findByText('Test'));
    expect(await screen.findByText(/could not deliver/i)).toBeTruthy();
  });

  it('says so when the request never left', async () => {
    stubFetch(base); // /test is unmatched → throws
    render(<ConnectionsTab open />);

    fireEvent.click(await screen.findByText('Test'));
    expect(await screen.findByText(/not connected/i)).toBeTruthy();
  });
});

describe('a write that failed', () => {
  it('reports it instead of clearing the field and looking fine', async () => {
    stubFetch([
      [/\/api\/connections$/, { ok: false, body: { error: 'name already taken' } }],
      [/\/api\/notifiers$/, { body: [] }],
    ]);
    render(<ConnectionsTab open />);

    const input = await screen.findByPlaceholderText('e.g. GitHub');
    fireEvent.change(input, { target: { value: 'GitHub' } });
    fireEvent.click(screen.getByText('Add connection'));

    expect(await screen.findByText('name already taken')).toBeTruthy();
    // And what was typed survives, so it can be corrected.
    expect((input as HTMLInputElement).value).toBe('GitHub');
  });
});

describe('an unreachable list', () => {
  /** "You have none" and "I could not ask" are different facts. */
  it('does not claim you have no connections', async () => {
    stubFetch([[/\/api\/notifiers$/, { body: [] }]]); // /connections throws
    render(<ConnectionsTab open />);

    expect(await screen.findByText(/could not load connections/i)).toBeTruthy();
    expect(screen.queryByText(/No connections yet/i)).toBeNull();
  });

  it('offers a retry, and retrying refetches', async () => {
    const fetchMock = stubFetch([[/\/api\/notifiers$/, { body: [] }]]);
    render(<ConnectionsTab open />);

    fireEvent.click(await screen.findByText('Try again'));
    await waitFor(() => {
      const tries = fetchMock.mock.calls.filter((c) =>
        /\/api\/connections$/.test(c[0] as string),
      );
      expect(tries.length).toBeGreaterThan(1);
    });
  });

  it('still says the empty thing when the list really is empty', async () => {
    stubFetch([
      [/\/api\/connections$/, { body: [] }],
      [/\/api\/notifiers$/, { body: [] }],
    ]);
    render(<ConnectionsTab open />);
    expect(await screen.findByText(/No connections yet/i)).toBeTruthy();
  });
});

describe('ListPlaceholder', () => {
  it('distinguishes all three states', () => {
    const { rerender, container } = render(
      <ListPlaceholder
        state="loading"
        label="things"
        empty="None yet."
        onRetry={() => {}}
      />,
    );
    expect(container.textContent).toMatch(/loading/i);

    rerender(
      <ListPlaceholder
        state="error"
        label="things"
        empty="None yet."
        onRetry={() => {}}
      />,
    );
    expect(container.textContent).toMatch(/could not load things/i);
    expect(container.textContent).toMatch(/not the same as having none/i);

    rerender(
      <ListPlaceholder
        state="ready"
        label="things"
        empty="None yet."
        onRetry={() => {}}
      />,
    );
    expect(container.textContent).toBe('None yet.');
  });
});
