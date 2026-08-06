import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestContext, WhatsAppSession } from '@chatpro/contracts';
import { createWorkerTransportHandler, listenInternalTransport } from '../../worker/src/internal-transport-server.js';
import type { WhatsAppWorkerPort, WorkerCommand } from '../../worker/src/ports.js';
import { createApp } from '../src/app.js';

class ControlledWorker implements WhatsAppWorkerPort {
  readonly sessions = new Map<string, WhatsAppSession>();
  externalConnections = 0;
  async execute(context: RequestContext, command: WorkerCommand) {
    const key = (id: string) => `${context.workspaceId}:${id}`;
    if (command.type === 'listSessions') return [...this.sessions.values()].filter(session => session.workspaceId === context.workspaceId);
    if (command.type === 'createSession') {
      if (this.sessions.has(key(command.sessionId))) { const error = Object.assign(new Error('Session already exists'), { response: { error: { code: 'CONFLICT', message: 'Session already exists' } } }); throw error; }
      const now = new Date().toISOString(); const session = { id: command.sessionId, workspaceId: context.workspaceId, name: command.input.name ?? command.sessionId, status: 'disconnected' as const, createdAt: now, updatedAt: now }; this.sessions.set(key(command.sessionId), session); return session;
    }
    if (command.type === 'sendMessage' || command.type === 'sendAttachment' || command.type === 'sendContent') return { id: 'controlled-message', timestamp: new Date().toISOString() };
    if (command.type === 'sendReaction') return { timestamp: new Date().toISOString() };
    if (command.type === 'syncIdentity') return { identity: null, group: null };
    if (command.type === 'historyPage') return { kind: command.chatId ? 'messages' as const : 'chats' as const, items: [], unsupported: [], hasMore: false };
    if (command.type === 'contactsPage') return { items: [], unsupported: [], hasMore: false };
    if (command.type === 'lidsPage') return { items: [], unsupported: [], hasMore: false };
    const session = this.sessions.get(key(command.sessionId));
    if (!session) { const error = Object.assign(new Error('Session not found'), { response: { error: { code: 'NOT_FOUND', message: 'Session not found' } } }); throw error; }
    if (command.type === 'getSession') return session;
    if (command.type === 'getQr') return { sessionId: session.id, workspaceId: session.workspaceId, qr: 'controlled-temporary-qr', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (command.type === 'connectSession') { session.status = 'waiting_qr'; return; }
    if (command.type === 'disconnectSession') { session.status = 'stopped'; return; }
    if (command.type === 'logoutSession') { session.status = 'disconnected'; return; }
    this.sessions.delete(key(command.sessionId));
  }
}

describe('session API transport integration', () => {
  let server: Server; let app: Awaited<ReturnType<typeof createApp>>; let worker: ControlledWorker;
  beforeEach(async () => { worker = new ControlledWorker(); const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(worker)); server = runtime.server; const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address'); app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: `http://127.0.0.1:${address.port}/internal/transport`, workerTransportTimeoutMs: 1_000 }); });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const headers = { 'x-workspace-id': 'workspace-a', 'x-user-id': 'user-a' };

  /** The attachment route is multipart, so `voiceNote` arrives as the STRING
   *  "false", not the boolean. A plain `z.boolean()` would reject it and the
   *  operator's music file would silently keep leaving as a voice note.
   *
   *  The two outcomes below are what separate "parsed" from "rejected" without
   *  needing storage: a well-formed request gets past the body schema and dies at
   *  the conversation lookup (404), while a malformed one never gets that far
   *  (400). Storage is deliberately not involved — on SQLite it is unavailable. */
  const conversationId = '00000000-0000-4000-8000-0000000000ff';
  const postAudio = (value: string) => request(app).post(`/api/v1/inbox/conversations/${conversationId}/attachments`).set(headers).field('clientRequestId', '00000000-0000-4000-8000-0000000000aa').field('voiceNote', value).attach('file', Buffer.from('ID3\u0003\u0000\u0000\u0000'), { filename: 'musica.mp3', contentType: 'audio/mpeg' });

  it('accepts the multipart string form of voiceNote and rejects a value that is neither', async () => {
    await postAudio('false').expect(404);
    await postAudio('true').expect(404);
    await postAudio('sim').expect(400).expect(response => expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR' }));
  });

  it('activates the session lifecycle through the controlled loopback worker', async () => {
    const created = await request(app).post('/api/v1/sessions').set(headers).send({ name: 'Primary' }).expect(201);
    const id = created.body.id;
    await request(app).get('/api/v1/sessions').set(headers).expect(200).expect(response => expect(response.body).toHaveLength(1));
    await request(app).post(`/api/v1/sessions/${id}/connect`).set(headers).send({}).expect(204);
    await request(app).get(`/api/v1/sessions/${id}/status`).set(headers).expect(200).expect(response => expect(response.body.status).toBe('waiting_qr'));
    await request(app).get(`/api/v1/sessions/${id}/qr`).set(headers).expect(200).expect(response => expect(response.body.qr).toBe('controlled-temporary-qr'));
    await request(app).post(`/api/v1/sessions/${id}/stop`).set(headers).expect(204);
    await request(app).post(`/api/v1/sessions/${id}/logout`).set(headers).expect(204);
    await request(app).delete(`/api/v1/sessions/${id}`).set(headers).expect(204);
    await request(app).get(`/api/v1/sessions/${id}/status`).set(headers).expect(404);
    expect(worker.externalConnections).toBe(0);
  });

  it('keeps list operations isolated by workspace and validates inputs', async () => {
    await request(app).post('/api/v1/sessions').set(headers).send({}).expect(201);
    await request(app).get('/api/v1/sessions').set({ ...headers, 'x-workspace-id': 'workspace-b' }).expect(200).expect(response => expect(response.body).toEqual([]));
    await request(app).post('/api/v1/sessions').set(headers).send({ name: '' }).expect(400);
  });

  it('returns typed unavailability when the worker is offline', async () => {
    const offline = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20 });
    await request(offline).get('/api/v1/sessions').set(headers).expect(503).expect(response => expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE'));
  });
});
