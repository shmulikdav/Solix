import { beforeEach, describe, expect, it } from 'vitest';

import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { ensureProject } from './state/projects.js';
import { getSession, setSessionStatus, upsertSession } from './state/sessions.js';
import type { HookEvent, ServerMessage } from '@solix/shared';

/**
 * Pending permission requests live in memory; the session's *status* lives in
 * SQLite. So a restart leaves rows marked `awaiting_permission` with nothing
 * behind them — the agent that was waiting died with the old process.
 *
 * Those ghosts count toward "need you", badge the Galaxy, and open an empty
 * Decisions panel. In the session that found this, the top bar read
 * "2 need you" for an entire day while Decisions correctly said "Nothing
 * waiting", and the obvious conclusion was that Decisions was broken.
 *
 * A permanently-wrong attention badge is worse than no badge: it trains
 * people to ignore the one signal that has to be believed when it is real.
 */
function seed(db: DB, id: string, status: 'awaiting_permission' | 'active' | 'idle'): void {
  const project = ensureProject(db, '/tmp/ghosts');
  upsertSession(db, {
    id,
    pid: 0,
    projectId: project.id,
    cwd: '/tmp/ghosts',
    origin: 'external',
    model: 'default',
    kind: 'user',
  });
  setSessionStatus(db, id, status);
}

describe('stale permission holds are cleared at startup', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('clears a session left awaiting_permission by a previous process', () => {
    seed(db, 'ghost', 'awaiting_permission');
    expect(getSession(db, 'ghost')?.status).toBe('awaiting_permission');

    new EventRouter(db, new Broadcaster());

    expect(getSession(db, 'ghost')?.status).toBe('idle');
  });

  it('clears every one of them, not just the first', () => {
    for (const id of ['g1', 'g2', 'g3']) seed(db, id, 'awaiting_permission');

    new EventRouter(db, new Broadcaster());

    for (const id of ['g1', 'g2', 'g3']) {
      expect(getSession(db, id)?.status).toBe('idle');
    }
  });

  it('leaves active and idle sessions alone', () => {
    seed(db, 'busy', 'active');
    seed(db, 'resting', 'idle');

    new EventRouter(db, new Broadcaster());

    expect(getSession(db, 'busy')?.status).toBe('active');
    expect(getSession(db, 'resting')?.status).toBe('idle');
  });

  it('tells connected browsers, so an open tab stops showing the badge', () => {
    seed(db, 'ghost', 'awaiting_permission');
    const sent: ServerMessage[] = [];
    const broadcaster = new Broadcaster();
    broadcaster.broadcast = (m: ServerMessage): void => {
      sent.push(m);
    };

    new EventRouter(db, broadcaster);

    const upsert = sent.find(
      (m) => m.type === 'session_upsert' && m.session.id === 'ghost',
    );
    expect(upsert).toBeDefined();
  });

  /**
   * A hold registered by THIS process must survive — the sweep runs in the
   * constructor, before any hook can arrive, so it can only ever see ghosts.
   */
  it('does not touch a hold created after startup', async () => {
    const router = new EventRouter(db, new Broadcaster());
    seed(db, 's1', 'active');

    const pending = router.requestPermission({
      event: 'pre_tool_bash',
      pid: 1234,
      cwd: '/tmp/ghosts',
      ts: Date.now(),
      payload: {
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'git push' },
      },
    } as HookEvent);

    await new Promise((r) => setTimeout(r, 30));
    expect(router.pendingPermissions()).toHaveLength(1);
    expect(getSession(db, 's1')?.status).toBe('awaiting_permission');

    const [req] = router.pendingPermissions();
    router.resolvePermission(req!.requestId, true);
    await pending;
  });
});
