import type { ClientMessage, ServerMessage } from '@solix/shared';
import { useSolixStore } from '../store/index.js';

/** How long the client waits before retrying a dropped socket. Exported so the
 *  connection indicator can tell the user how often it is retrying instead of
 *  restating the number. */
export const RECONNECT_DELAY_MS = 1500;

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function startWsClient(): void {
  let socket: WebSocket | null = null;
  let stopped = false;

  /**
   * Returns false when the message did not go out.
   *
   * This returned void, so every caller assumed success. The socket drops on
   * any server restart — which is every upgrade — and for the ~1.5s until it
   * reconnects, approvals, launches, prompts and terminations were discarded
   * in silence while the UI reported them as done.
   */
  const send = (msg: ClientMessage): boolean => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      // A socket can report OPEN and still throw on send.
      return false;
    }
  };

  useSolixStore.getState().attachSocket(send);

  const connect = (): void => {
    if (stopped) return;
    socket = new WebSocket(wsUrl());

    socket.onopen = () => {
      useSolixStore.getState().setConnected(true);
    };

    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        useSolixStore.getState().applyMessage(msg);
      } catch (err) {
        console.warn('[ws] bad message', err);
      }
    };

    const reconnect = (): void => {
      useSolixStore.getState().setConnected(false);
      if (!stopped) setTimeout(connect, RECONNECT_DELAY_MS);
    };

    socket.onclose = reconnect;
    socket.onerror = () => socket?.close();
  };

  connect();

  window.addEventListener('beforeunload', () => {
    stopped = true;
    socket?.close();
  });
}
