import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@chatpro/contracts';

export type RealtimeSocket = { readyState: number; send(data: string): void };
export class RealtimeHub {
  private readonly sockets = new Map<RealtimeSocket, string>();
  add(socket: RealtimeSocket, workspaceId: string): void { this.sockets.set(socket, workspaceId); }
  remove(socket: RealtimeSocket): void { this.sockets.delete(socket); }
  publish(workspaceId: string, eventType: EventEnvelope['eventType'], payload: Record<string, unknown>, correlationId = randomUUID()): void {
    const event: EventEnvelope = { eventId: randomUUID(), eventType, workspaceId, timestamp: new Date().toISOString(), correlationId, payload };
    for (const [socket, audience] of this.sockets) if (audience === workspaceId && socket.readyState === 1) socket.send(JSON.stringify(event));
  }
}
