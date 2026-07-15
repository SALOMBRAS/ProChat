import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { eventEnvelopeSchema } from '@chatpro/contracts';
import { log } from './logging.js';
export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/ws', 'http://localhost'); const workspaceId = url.searchParams.get('workspaceId'); const userId = url.searchParams.get('userId');
    if (!workspaceId || !userId) { socket.close(1008, 'workspaceId and userId are required only for temporary development context'); return; }
    const event = eventEnvelopeSchema.parse({ eventId: randomUUID(), eventType: 'system.connected', workspaceId, timestamp: new Date().toISOString(), correlationId: randomUUID(), payload: { userId, context: 'temporary-development-only' } });
    socket.send(JSON.stringify(event)); log('info', 'WebSocket connected', { workspaceId, userId, correlationId: event.correlationId });
  });
  return wss;
}
