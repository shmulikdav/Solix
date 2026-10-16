import type { ServerMessage } from '@solix/shared';
import type { WebSocket } from 'ws';

export class Broadcaster {
  private clients = new Set<WebSocket>();
  // Server-side observers of every outgoing message (e.g. the chat-notification
  // dispatcher, P3 #11). Taps never affect WS delivery and their throws are
  // swallowed so a bad listener can't break broadcasting.
  private taps = new Set<(msg: ServerMessage) => void>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
  }

  remove(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /** Observe every broadcast message. Returns an unsubscribe. */
  tap(fn: (msg: ServerMessage) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
    for (const tap of this.taps) {
      try {
        tap(msg);
      } catch {
        /* a tap must never break broadcasting */
      }
    }
  }

  size(): number {
    return this.clients.size;
  }
}
