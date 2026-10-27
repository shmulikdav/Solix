import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { Launcher } from './launcher.js';
import { setGovernanceLevel } from './state/governance.js';
import type { ServerMessage } from '@solix/shared';

/**
 * A New task launched from the UI was never gated, at any level. It carried
 * no `SOLIX_GATE_ENABLED`, so its hook never blocked and no decision was ever
 * raised — while the front page promised that a task Solix launched had its
 * commands held. The smoke-test doc listed it as gated too, which is why
 * Suite E was first run against the one path with no gate at all.
 *
 * `SOLIX_FAKE_CLAUDE=1` makes the launcher report what it would do instead of
 * spawning, so these assert the decision without needing a real `claude`.
 */
describe('New task and the gate', () => {
  let db: DB;
  let broadcaster: Broadcaster;
  let sent: ServerMessage[];

  beforeEach(() => {
    db = resetDbForTests();
    sent = [];
    broadcaster = new Broadcaster();
    broadcaster.broadcast = (m: ServerMessage): void => {
      sent.push(m);
    };
    vi.stubEnv('SOLIX_FAKE_CLAUDE', '1');
  });

  function launch(useAgentView: boolean): ReturnType<Launcher['launch']> {
    const launcher = new Launcher(db, broadcaster);
    return launcher.launch({
      cwd: '/tmp/newtask',
      initialPrompt: 'delete the canary',
      useAgentView,
    });
  }

  /**
   * `claude --bg` hands the session to the Agent View supervisor. If that
   * daemon is already running it does NOT inherit the env we set, so the gate
   * would apply or not depending on whether something else happened to start
   * it first. A guarantee that holds nondeterministically is worse than one
   * that is plainly absent — so when the gate is on, we take the path we
   * control and say so.
   */
  it('declines Agent View while the gate is on, and says why', () => {
    launch(true);

    const toast = sent.find(
      (m) => m.type === 'toast' && /without Agent View/i.test(m.message),
    );
    expect(toast).toBeDefined();
    expect((toast as { message: string }).message).toMatch(/held for you/i);
    // And it names the way back, rather than just taking something away.
    expect((toast as { message: string }).message).toMatch(/observe/);
  });

  it('uses Agent View at `observe`, where nothing is held anyway', () => {
    setGovernanceLevel(db, 'observe');
    launch(true);

    const toast = sent.find(
      (m) => m.type === 'toast' && /without Agent View/i.test(m.message),
    );
    // No downgrade notice, because nothing was downgraded.
    expect(toast).toBeUndefined();
  });

  it('does not announce a downgrade when Agent View was not asked for', () => {
    launch(false);
    const toast = sent.find(
      (m) => m.type === 'toast' && /without Agent View/i.test(m.message),
    );
    expect(toast).toBeUndefined();
  });
});
