import { createServer } from 'node:http';
import { createApp } from '../apps/api/src/app.js';
import { createInternalTransportServer } from '../apps/worker/src/internal-transport-server.js';

const sessions = new Map<string, Record<string, unknown>>();
const worker = createInternalTransportServer(async request => {
  const key = (id: string) => `${request.workspaceId}:${id}`;
  const command = request.command;
  if (command.type === 'session.list') return { success: true, correlationId: request.correlationId, workspaceId: request.workspaceId, data: { sessions: [...sessions.values()].filter(session => session.workspaceId === request.workspaceId) } } as const;
  if (command.type === 'session.create') { const now = new Date().toISOString(); const session = { id: command.payload.sessionId, workspaceId: request.workspaceId, name: command.payload.name ?? command.payload.sessionId, status: 'disconnected' as const, createdAt: now, updatedAt: now }; sessions.set(key(session.id), session); return { success: true, correlationId: request.correlationId, workspaceId: request.workspaceId, data: { session } } as const; }
  if (command.type === 'transport.ping') return { success: true, correlationId: request.correlationId, workspaceId: request.workspaceId, data: { message: command.payload.message } } as const;
  const session = sessions.get(key(command.payload.sessionId));
  if (!session) return { success: false, correlationId: request.correlationId, workspaceId: request.workspaceId, error: { code: 'NOT_FOUND' as const, message: 'Session not found', details: {} } };
  if (command.type === 'session.status') return { success: true, correlationId: request.correlationId, workspaceId: request.workspaceId, data: { session } } as const;
  if (command.type === 'session.qr') return { success: true, correlationId: request.correlationId, workspaceId: request.workspaceId, data: { qr: { sessionId: session.id as string, workspaceId: request.workspaceId, qr: 'controlled-qr', expiresAt: new Date(Date.now() + 60_000).toISOString() } } } as const;
  if (command.type === 'session.connect') session.status = 'waiting_qr';
  if (command.type === 'session.stop') session.status = 'stopped';
  if (command.type === 'session.logout') session.status = 'disconnected';
  if (command.type === 'session.remove') sessions.delete(key(command.payload.sessionId));
  return { success: true, correlationId: request.correlationId, workspaceId: request.workspaceId, data: command.type === 'session.remove' ? { removed: true } : { completed: true } } as const;
});
await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
const workerAddress = worker.address(); if (!workerAddress || typeof workerAddress === 'string') throw new Error('Worker did not bind');
const api = createServer(createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: `http://127.0.0.1:${workerAddress.port}/internal/transport`, workerTransportTimeoutMs: 500 }));
await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
const apiAddress = api.address(); if (!apiAddress || typeof apiAddress === 'string') throw new Error('API did not bind');
const base = `http://127.0.0.1:${apiAddress.port}/api/v1/sessions`; const headers = { 'content-type': 'application/json', 'x-workspace-id': 'smoke-workspace', 'x-user-id': 'smoke-user' };
async function call(url: string, method = 'GET', body?: unknown) { const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); if (!response.ok) throw new Error(`Smoke route failed: ${method} ${url} (${response.status})`); return response.status === 204 ? undefined : response.json() as Promise<Record<string, unknown>>; }
try {
  const session = await call(base, 'POST', { name: 'Controlled smoke' }); const id = session.id as string;
  await call(base); await call(`${base}/${id}/connect`, 'POST', {}); await call(`${base}/${id}/status`); await call(`${base}/${id}/qr`); await call(`${base}/${id}/stop`, 'POST', {}); await call(`${base}/${id}/logout`, 'POST', {}); await call(`${base}/${id}`, 'DELETE');
  process.stdout.write('All session routes passed using a controlled worker; no WhatsApp connection was opened.\n');
} finally { await new Promise<void>(resolve => api.close(() => resolve())); await new Promise<void>(resolve => worker.close(() => resolve())); }
