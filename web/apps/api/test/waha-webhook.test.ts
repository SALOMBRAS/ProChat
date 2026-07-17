import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createWorkerTransportHandler, listenInternalTransport } from '../../worker/src/internal-transport-server.js';
import type { WhatsAppWorkerPort } from '../../worker/src/ports.js';

const directories: string[] = []; const applications: Array<Awaited<ReturnType<typeof createApp>>> = []; const workerServers: Array<{ close: () => Promise<void> }> = [];
const key = 'webhook-test-secret';
const signed = (body: unknown) => { const raw = JSON.stringify(body); return { raw, hmac: createHmac('sha512', key).update(raw).digest('hex'), timestamp: String(Date.now()) }; };
const appFor = async (workerTransportUrl = 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs = 20) => { const directory = mkdtempSync(join(tmpdir(), 'chatpro-waha-webhook-')); directories.push(directory); const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl, workerTransportTimeoutMs, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), wahaWebhookHmacKey: key, wahaWebhookWorkspaceId: 'workspace-a' }); applications.push(app); return app; };
afterEach(async () => { applications.splice(0).forEach(app => app.locals.persistenceDatabase?.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); await Promise.all(workerServers.splice(0).map(server => server.close())); });

describe('WAHA webhook ingress', () => {
  it('authenticates, sanitizes and persists a message idempotently', async () => {
    const app = await appFor(); const body = { id: 'evt-1', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'message-1', chatId: '5511999990000@c.us', body: 'Olá', type: 'text', apiKey: 'must-not-persist' } }; const requestBody = signed(body);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202).expect(response => expect(response.body).toEqual({ accepted: true, duplicate: false }));
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(200).expect(response => expect(response.body).toEqual({ accepted: true, duplicate: true }));
    const database = app.locals.persistenceDatabase.sqlite;
    expect(database.prepare('SELECT count(*) AS total FROM waha_webhook_events').get()).toMatchObject({ total: 1 });
    expect(database.prepare('SELECT chatId, direction, body, payloadJson FROM whatsapp_messages').get()).toMatchObject({ chatId: '5511999990000@c.us', direction: 'inbound', body: 'Olá', payloadJson: expect.stringContaining('[REDACTED]') });
  });
  it('rejects unsigned requests before reading the event', async () => { const app = await appFor(); await request(app).post('/api/v1/webhooks/waha').send({}).expect(401).expect(response => expect(response.body.error.code).toBe('UNAUTHORIZED')); });
  it('keeps separate WAHA events for the same message without duplicating the message', async () => {
    const app = await appFor(); const base = { timestamp: Date.now(), session: 'waha-a', payload: { id: 'message-1', chatId: '5511999990000@c.us', body: 'Olá' } };
    for (const body of [{ ...base, id: 'evt-message', event: 'message' }, { ...base, id: 'evt-message-any', event: 'message.any' }]) { const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    const database = app.locals.persistenceDatabase.sqlite; expect(database.prepare('SELECT count(*) AS total FROM waha_webhook_events').get()).toMatchObject({ total: 2 }); expect(database.prepare('SELECT count(*) AS total FROM whatsapp_messages').get()).toMatchObject({ total: 1 });
  });
  it('keeps a group as one conversation while storing each participant as the message author', async () => {
    const app = await appFor(); const group = '120363363444637332@g.us';
    const events = [
      { id: 'evt-group-1', timestamp: Date.now() - 1_000, event: 'message' as const, session: 'waha-a', payload: { id: 'group-message-1', chatId: group, from: group, participant: '5511999990000@c.us', body: 'Primeira pessoa' } },
      { id: 'evt-group-2', timestamp: Date.now(), event: 'message.any' as const, session: 'waha-a', payload: { id: 'group-message-2', chatId: group, from: group, participant: '5511888880000@c.us', body: 'Segunda pessoa' } },
    ];
    for (const body of events) { const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    const database = app.locals.persistenceDatabase.sqlite;
    expect(database.prepare("SELECT count(*) AS total FROM conversations WHERE chatId = ? AND conversationType = 'group'").get(group)).toMatchObject({ total: 1 });
    expect(database.prepare('SELECT senderWhatsappId FROM whatsapp_messages WHERE chatId = ? ORDER BY occurredAt ASC').all(group)).toEqual([{ senderWhatsappId: '5511999990000@c.us' }, { senderWhatsappId: '5511888880000@c.us' }]);
  });
  it('creates and updates a conversation that is available through the diagnostic API', async () => {
    const app = await appFor(); const first = { id: 'evt-conversation-1', timestamp: Date.now() - 1_000, event: 'message', session: 'waha-a', payload: { id: 'message-conversation-1', chatId: '5511999990000@c.us', body: 'Primeira', type: 'text' } }; const second = { id: 'evt-conversation-2', timestamp: Date.now(), event: 'message.any', session: 'waha-a', payload: { id: 'message-conversation-2', chatId: '5511999990000@c.us', body: 'Resposta', type: 'text', fromMe: true } };
    for (const body of [first, second]) { const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    await request(app).get('/api/v1/inbox/conversations?page=1&pageSize=10').set('x-workspace-id', 'workspace-a').expect(200).expect(response => expect(response.body).toMatchObject({ page: 1, pageSize: 10, total: 1, items: [{ whatsappSessionId: 'waha-a', chatId: '5511999990000@c.us', lastMessage: 'Resposta', unreadCount: 1 }] }));
  });
  it('returns chronological message history and marks only the workspace conversation as read', async () => {
    const app = await appFor(); const first = { id: 'evt-history-1', timestamp: Date.now() - 1_000, event: 'message', session: 'waha-a', payload: { id: 'message-history-1', chatId: '5511999990000@c.us', body: 'Primeira' } }; const second = { id: 'evt-history-2', timestamp: Date.now(), event: 'message.any', session: 'waha-a', payload: { id: 'message-history-2', chatId: '5511999990000@c.us', body: 'Resposta', fromMe: true } };
    for (const body of [first, second]) { const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    const conversations = await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200); const id = conversations.body.items[0].id;
    await request(app).get(`/api/v1/inbox/conversations/${id}/messages?page=1&pageSize=1`).set('x-workspace-id', 'workspace-a').expect(200).expect(response => expect(response.body).toMatchObject({ total: 2, items: [{ id: 'message-history-1', direction: 'inbound', content: 'Primeira', status: 'received' }] }));
    await request(app).post(`/api/v1/inbox/conversations/${id}/read`).set('x-workspace-id', 'workspace-a').expect(204);
    await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200).expect(response => expect(response.body.items[0].unreadCount).toBe(0));
    await request(app).get(`/api/v1/inbox/conversations/${id}/messages`).set('x-workspace-id', 'workspace-b').expect(404);
  });
  it('sends through the linked WAHA session and persists one outbound message', async () => {
    const worker: WhatsAppWorkerPort = { execute: async (_context, command) => { if (command.type === 'sendMessage') return { id: 'outbound-1', timestamp: '2026-07-16T18:00:00.000Z' }; throw new Error('unexpected command'); } };
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(worker)); workerServers.push(runtime); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing worker address');
    const app = await appFor(`http://127.0.0.1:${address.port}/internal/transport`, 1_000); const event = { id: 'evt-send-source', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'source-1', chatId: '5511999990000@c.us', body: 'Oi' } }; const signedEvent = signed(event);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedEvent.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedEvent.timestamp).send(signedEvent.raw).expect(202);
    const conversations = await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200); const id = conversations.body.items[0].id;
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set('x-workspace-id', 'workspace-a').send({ text: 'Resposta real' }).expect(201).expect(response => expect(response.body).toMatchObject({ id: 'outbound-1', direction: 'outbound', content: 'Resposta real', status: 'sent' }));
    expect(app.locals.persistenceDatabase.sqlite.prepare("SELECT count(*) AS total FROM whatsapp_messages WHERE direction = 'outbound'").get()).toMatchObject({ total: 1 });
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set('x-workspace-id', 'workspace-b').send({ text: 'Não pode' }).expect(404);
  });
});
