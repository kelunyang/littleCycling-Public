/**
 * WebSocket relay — broadcasts live sensor data to all connected clients.
 */

import type { WebSocket } from 'ws';
import type { WsMessage } from '@littlecycling/shared';

export class WsRelay {
  private clients = new Set<WebSocket>();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
