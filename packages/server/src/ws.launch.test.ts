import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClientMessage } from '@solix/shared';
import { handleClientMessage, type WsContext } from './ws.js';

/**
 * `expandHome` was added to fix exactly this — typing `~/project` into New
 * Task and watching it fail — and was then wired into seven HTTP routes and
 * not into this one. The web app does not launch over HTTP: `launchTask`
 * sends a `launch_session` websocket message, which landed here and passed
 * `msg.cwd` through raw.
 *
 * So the fix shipped, the error message got better, and the thing the user
 * typed still did not work. That is the pattern worth a regression test: a
 * helper applied to the call sites someone happened to be looking at.
 */
function ctxWithSpy(): { ctx: WsContext; launch: ReturnType<typeof vi.fn> } {
  const launch = vi.fn();
  const terminate = vi.fn();
  const ctx = {
    router: {
      launchInternalSession: launch,
      terminateSession: terminate,
    },
  } as unknown as WsContext;
  return { ctx, launch };
}

function launchMsg(cwd: string): ClientMessage {
  return { type: 'launch_session', cwd, model: 'default' } as ClientMessage;
}

describe('launch_session over the websocket', () => {
  it('expands a leading ~ the way the HTTP routes do', () => {
    const { ctx, launch } = ctxWithSpy();
    handleClientMessage(ctx, {} as never, launchMsg('~/project'));
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: join(homedir(), 'project') }),
    );
  });

  it('leaves an absolute path alone', () => {
    const { ctx, launch } = ctxWithSpy();
    handleClientMessage(ctx, {} as never, launchMsg('/tmp/elsewhere'));
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp/elsewhere' }),
    );
  });

  /** ~user is someone else's home and we do not resolve it. */
  it('leaves ~user alone rather than guessing', () => {
    const { ctx, launch } = ctxWithSpy();
    handleClientMessage(ctx, {} as never, launchMsg('~someone/project'));
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '~someone/project' }),
    );
  });
});
