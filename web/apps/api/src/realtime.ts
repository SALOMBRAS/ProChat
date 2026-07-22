import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@chatpro/contracts';
import { log } from './logging.js';

export type RealtimeSocket = { readyState: number; send(data: string): void };
export class RealtimeHub {
  private readonly sockets = new Map<RealtimeSocket, string>();
  add(socket: RealtimeSocket, workspaceId: string): void { this.sockets.set(socket, workspaceId); log('info', 'Realtime listener registered', { workspaceId, listenersActive: this.listenersFor(workspaceId), listenersTotal: this.sockets.size }); }
  remove(socket: RealtimeSocket): void { const workspaceId = this.sockets.get(socket); this.sockets.delete(socket); log('info', 'Realtime listener removed', { workspaceId: workspaceId ?? null, listenersActive: workspaceId ? this.listenersFor(workspaceId) : 0, listenersTotal: this.sockets.size }); }
  publish(workspaceId: string, eventType: EventEnvelope['eventType'], payload: Record<string, unknown>, correlationId = randomUUID()): void {
    const event: EventEnvelope = { eventId: randomUUID(), eventType, workspaceId, timestamp: new Date().toISOString(), correlationId, payload };
    log('info', 'Realtime event emitted', { correlationId, workspaceId, eventId: event.eventId, eventType, listenersActive: this.listenersFor(workspaceId), listenersTotal: this.sockets.size });
    for (const [socket, audience] of this.sockets) if (audience === workspaceId && socket.readyState === 1) socket.send(JSON.stringify(event));
  }
  private listenersFor(workspaceId: string): number { return [...this.sockets].filter(([socket, audience]) => audience === workspaceId && socket.readyState === 1).length; }
}
