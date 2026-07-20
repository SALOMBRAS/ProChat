import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { historyRecord, messagePreview, webhookRecord } from '../src/services/waha-webhook.service.js';
import { createWorkerTransportHandler, listenInternalTransport } from '../../worker/src/internal-transport-server.js';
import type { WhatsAppWorkerPort } from '../../worker/src/ports.js';

const directories: string[] = []; const applications: Array<Awaited<ReturnType<typeof createApp>>> = []; const workerServers: Array<{ close: () => Promise<void> }> = [];
const key = 'webhook-test-secret';
const signed = (body: unknown) => { const raw = JSON.stringify(body); return { raw, hmac: createHmac('sha512', key).update(raw).digest('hex'), timestamp: String(Date.now()) }; };
const appFor = async (workerTransportUrl = 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs = 20) => { const directory = mkdtempSync(join(tmpdir(), 'chatpro-waha-webhook-')); directories.push(directory); const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl, workerTransportTimeoutMs, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), wahaWebhookHmacKey: key, wahaWebhookWorkspaceId: 'workspace-a', developmentUserId: '00000000-0000-4000-8000-000000000001' }); const timestamp = new Date().toISOString(); app.locals.persistenceDatabase.sqlite.prepare('INSERT INTO workspace_users (id,workspaceId,email,displayName,avatarUrl,role,status,createdAt,updatedAt,lastSeenAt) VALUES (?,?,?,?,?,?,?,?,?,?)').run('00000000-0000-4000-8000-000000000002', 'workspace-a', 'teammate@chatpro.local', 'Teammate', null, 'agent', 'active', timestamp, timestamp, null); applications.push(app); return app; };
afterEach(async () => { applications.splice(0).forEach(app => app.locals.persistenceDatabase?.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); await Promise.all(workerServers.splice(0).map(server => server.close())); });

describe('WAHA webhook ingress', () => {
  it('formats media conversation previews without falling back to text-only placeholders', () => {
    expect(messagePreview({ messageType: 'image', body: null, mediaFilename: null })).toBe('Foto');
    expect(messagePreview({ messageType: 'image', body: 'Confira', mediaFilename: null })).toBe('Foto: Confira');
    expect(messagePreview({ messageType: 'document', body: null, mediaFilename: 'invoice.pdf' })).toBe('Documento: invoice.pdf');
    expect(messagePreview({ messageType: 'audio', body: null, mediaFilename: null })).toBe('Áudio');
    expect(messagePreview({ messageType: 'sticker', body: null, mediaFilename: null })).toBe('Sticker');
  });
  it('preserves ISO and millisecond timestamps from historical WAHA messages', () => {
    expect(historyRecord('workspace-a', 'waha-a', { id: 'history-iso', timestamp: '2024-01-02T03:04:05.000Z' })?.occurredAt).toBe('2024-01-02T03:04:05.000Z');
    expect(historyRecord('workspace-a', 'waha-a', { id: 'history-ms', timestamp: '1704164645000' })?.occurredAt).toBe('2024-01-02T03:04:05.000Z');
  });
  it('prefers the original payload timestamp over a delayed webhook delivery timestamp', () => {
    const event = { id: 'evt-delayed', timestamp: Date.parse('2026-07-20T14:00:00.000Z'), event: 'message', session: 'waha-a', payload: { id: 'message-delayed', chatId: '5511999990000@c.us', timestamp: 1704164645 } };
    expect(webhookRecord(event as any, 'workspace-a').occurredAt).toBe('2024-01-02T03:04:05.000Z');
  });
  it('does not create an Inbox conversation for status broadcasts', async () => {
    const app = await appFor(); const body = { id: 'evt-status', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'status-message', chatId: 'status@broadcast', body: 'Status' } }; const requestBody = signed(body);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202);
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM conversations').get()).toMatchObject({ total: 0 });
  });
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
  it('keeps an outbound WAHA confirmation in the recipient conversation when chatId differs', async () => {
    const app = await appFor(); const contactA = '5511999990000@c.us'; const contactB = '5511888880000@c.us';
    const inbound = { id: 'evt-contact-a', timestamp: Date.now() - 1_000, event: 'message' as const, session: 'waha-a', payload: { id: 'message-contact-a', chatId: contactA, body: 'Oi' } };
    const outbound = { id: 'evt-outbound-a', timestamp: Date.now(), event: 'message.any' as const, session: 'waha-a', payload: { id: 'message-outbound-a', chatId: contactB, to: contactA, fromMe: true, body: 'Resposta para A' } };
    for (const body of [inbound, outbound]) { const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    const database = app.locals.persistenceDatabase.sqlite;
    expect(database.prepare('SELECT chatId FROM whatsapp_messages WHERE externalMessageId = ?').get('message-outbound-a')).toEqual({ chatId: contactA });
    expect(database.prepare('SELECT count(*) AS total FROM conversations WHERE chatId = ?').get(contactA)).toEqual({ total: 1 });
    expect(database.prepare('SELECT count(*) AS total FROM conversations WHERE chatId = ?').get(contactB)).toEqual({ total: 0 });
  });
  it('merges a direct @lid alias into its @c.us canonical conversation and keeps outbound delivery there', async () => {
    const lid = '100000000000001@lid'; const canonical = '5511999990000@c.us';
    const worker: WhatsAppWorkerPort = { execute: async (_context, command) => { if (command.type !== 'syncIdentity') throw new Error('unexpected command'); return { identity: { whatsappId: lid, canonicalWhatsappId: canonical, phone: '5511999990000', name: 'Pessoa A', pushName: 'Pessoa A', shortName: 'A', profilePictureUrl: null }, group: null }; } };
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(worker)); workerServers.push(runtime); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing worker address'); const app = await appFor(`http://127.0.0.1:${address.port}/internal/transport`, 1_000);
    for (const body of [{ id: 'evt-lid', timestamp: Date.now() - 1_000, event: 'message' as const, session: 'waha-a', payload: { id: 'message-lid', chatId: lid, body: 'Oi pelo LID' } }]) { const signedBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedBody.timestamp).send(signedBody.raw).expect(202); }
    const database = app.locals.persistenceDatabase.sqlite; for (let attempt = 0; attempt < 30 && !(database.prepare('SELECT id FROM whatsapp_identities WHERE whatsappId = ?').get(lid)); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    for (const body of [{ id: 'evt-canonical', timestamp: Date.now(), event: 'message.any' as const, session: 'waha-a', payload: { id: 'message-canonical', chatId: canonical, to: canonical, fromMe: true, body: 'Resposta pelo C.US' } }]) { const signedBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedBody.timestamp).send(signedBody.raw).expect(202); }
    expect(database.prepare("SELECT count(*) AS total FROM conversations WHERE conversationType = 'direct'").get()).toEqual({ total: 1 });
    expect(database.prepare('SELECT chatId, deliveryChatId FROM conversations').get()).toEqual({ chatId: canonical, deliveryChatId: canonical });
    expect(database.prepare('SELECT chatId FROM whatsapp_messages ORDER BY occurredAt ASC').all()).toEqual([{ chatId: canonical }, { chatId: canonical }]);
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
    const conversations = await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200); const conversation = conversations.body.items[0];
    expect(conversation).toMatchObject({ chatId: group, conversationType: 'group' });
    await request(app).get(`/api/v1/inbox/conversations/${conversation.id}/messages`).set('x-workspace-id', 'workspace-a').expect(200).expect(response => expect(response.body.items.map((item: { senderWhatsappId?: string }) => item.senderWhatsappId)).toEqual(['5511999990000@c.us', '5511888880000@c.us']));
  });
  it('persists media metadata from WAHA without downloading it in the webhook', async () => {
    const app = await appFor(); const body = { id: 'evt-media', timestamp: Date.now(), event: 'message' as const, session: 'waha-a', payload: { id: 'media-image-1', chatId: '5511999990000@c.us', body: 'Foto', type: 'image', hasMedia: true, media: { url: 'https://waha.example.test/api/files/photo.jpg', mimetype: 'image/jpeg', filename: 'photo.jpg', size: 1234 } } }; const requestBody = signed(body);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202);
    const conversation = (await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200)).body.items[0];
    await request(app).get(`/api/v1/inbox/conversations/${conversation.id}/messages`).set('x-workspace-id', 'workspace-a').expect(200).expect(response => expect(response.body.items[0]).toMatchObject({ messageType: 'image', mediaUrl: 'https://waha.example.test/api/files/photo.jpg', mediaMimeType: 'image/jpeg', mediaFilename: 'photo.jpg', mediaSize: 1234 }));
  });
  it('persists WAHA identity and group data after acknowledging the webhook', async () => {
    const worker: WhatsAppWorkerPort = { execute: async (_context, command) => {
      if (command.type !== 'syncIdentity') throw new Error('unexpected command');
      return { identity: { whatsappId: '5511999990000@c.us', canonicalWhatsappId: '5511999990000@c.us', phone: '5511999990000', name: 'João', pushName: 'João Silva', shortName: 'João', profilePictureUrl: null }, group: { chatId: '120363363444637332@g.us', name: 'Família', pictureUrl: null, metadata: { description: 'Casa' }, participants: [{ whatsappId: '5511999990000@c.us', role: 'admin' }] } };
    } };
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(worker)); workerServers.push(runtime); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing worker address');
    const app = await appFor(`http://127.0.0.1:${address.port}/internal/transport`, 1_000); const body = { id: 'evt-enrich', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'message-enrich', chatId: '120363363444637332@g.us', participant: '5511999990000@c.us', body: 'Oi' } }; const requestBody = signed(body);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202);
    const database = app.locals.persistenceDatabase.sqlite;
    for (let attempt = 0; attempt < 20 && !(database.prepare('SELECT id FROM whatsapp_groups').get()); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    expect(database.prepare('SELECT whatsappId, name, pushName FROM whatsapp_identities').get()).toMatchObject({ whatsappId: '5511999990000@c.us', name: 'João', pushName: 'João Silva' });
    expect(database.prepare('SELECT chatId, name FROM whatsapp_groups').get()).toMatchObject({ chatId: '120363363444637332@g.us', name: 'Família' });
    expect(database.prepare('SELECT participantWhatsappId, role FROM whatsapp_group_participants').get()).toMatchObject({ participantWhatsappId: '5511999990000@c.us', role: 'admin' });
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
  it('keeps one outbound message when manual send and message.any overlap', async () => {
    const worker: WhatsAppWorkerPort = { execute: async (_context, command) => { if (command.type === 'sendMessage') return { id: 'outbound-race', timestamp: '2026-07-16T18:00:00.000Z' }; throw new Error('unexpected command'); } };
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(worker)); workerServers.push(runtime); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing worker address'); const app = await appFor(`http://127.0.0.1:${address.port}/internal/transport`, 1_000);
    const source = { id: 'evt-race-source', timestamp: Date.now() - 1_000, event: 'message' as const, session: 'waha-a', payload: { id: 'source-race', chatId: '5511999990000@c.us', body: 'Oi' } }; const signedSource = signed(source);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedSource.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedSource.timestamp).send(signedSource.raw).expect(202);
    const conversation = (await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200)).body.items[0]; const webhook = { id: 'evt-race-outbound', timestamp: Date.now(), event: 'message.any' as const, session: 'waha-a', payload: { id: 'outbound-race', to: '5511999990000@c.us', fromMe: true, body: 'Resposta' } }; const signedWebhook = signed(webhook);
    await Promise.all([request(app).post(`/api/v1/inbox/conversations/${conversation.id}/messages`).set('x-workspace-id', 'workspace-a').send({ text: 'Resposta' }).expect(201), request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedWebhook.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedWebhook.timestamp).send(signedWebhook.raw).expect(202)]);
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM whatsapp_messages WHERE externalMessageId = ?').get('outbound-race')).toEqual({ total: 1 });
  });
  it('isolates context by workspace and conversation for direct chats and groups', async () => {
    const app = await appFor(); const direct = '5511999990000@c.us'; const group = '120363363444637332@g.us';
    for (const body of [{ id: 'evt-context-direct', timestamp: Date.now() - 1_000, event: 'message', session: 'waha-a', payload: { id: 'message-context-direct', chatId: direct, body: 'Oi' } }, { id: 'evt-context-group', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'message-context-group', chatId: group, body: 'Olá grupo' } }]) { const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    const conversations = (await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200)).body.items;
    const directConversation = conversations.find((item: { chatId: string }) => item.chatId === direct); const groupConversation = conversations.find((item: { chatId: string }) => item.chatId === group);
    await request(app).patch(`/api/v1/inbox/conversations/${directConversation.id}/context`).set('x-workspace-id', 'workspace-a').send({ notes: 'Somente contato', tags: ['VIP'] }).expect(200);
    await request(app).get(`/api/v1/inbox/conversations/${groupConversation.id}/context`).set('x-workspace-id', 'workspace-a').expect(200).expect(response => expect(response.body).toMatchObject({ notes: null, tags: [] }));
    await request(app).get(`/api/v1/inbox/conversations/${directConversation.id}/context`).set('x-workspace-id', 'workspace-b').expect(404);
  });
  it('keeps different group participants as authors in one conversation', async () => {
    const app = await appFor(); const group = '120363000000@g.us';
    for (const [id, participant] of [['group-a', '5511999990001@c.us'], ['group-b', '5511999990002@c.us']] as const) { const body = { id: `evt-${id}`, timestamp: Date.now(), event: 'message' as const, session: 'waha-a', payload: { id, chatId: group, participant, body: 'grupo' } }; const requestBody = signed(body); await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', requestBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', requestBody.timestamp).send(requestBody.raw).expect(202); }
    const conversations = await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200);
    expect(conversations.body).toMatchObject({ total: 1, items: [{ chatId: group, conversationType: 'group' }] });
    const messages = await request(app).get(`/api/v1/inbox/conversations/${conversations.body.items[0].id}/messages`).set('x-workspace-id', 'workspace-a').expect(200);
    expect(messages.body.items.map((item: { senderWhatsappId: string }) => item.senderWhatsappId).sort()).toEqual(['5511999990001@c.us', '5511999990002@c.us']);
  });
  it('manages assignment, status, priority, activity and realtime updates without changing message ingestion', async () => {
    const app = await appFor(); const actor = '00000000-0000-4000-8000-000000000001'; const teammate = '00000000-0000-4000-8000-000000000002'; const source = { id: 'evt-management', timestamp: Date.now(), event: 'message' as const, session: 'waha-a', payload: { id: 'message-management', chatId: '5511999990000@c.us', body: 'Preciso de ajuda' } }; const signedSource = signed(source);
    await request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedSource.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedSource.timestamp).send(signedSource.raw).expect(202);
    const conversation = (await request(app).get('/api/v1/inbox/conversations').set('x-workspace-id', 'workspace-a').expect(200)).body.items[0];
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } }; app.locals.realtimeHub.add(socket, 'workspace-a');
    const agent = (path: string) => { const patch = path.startsWith('PATCH '); const endpoint = `/api/v1${patch ? path.slice(6) : path}`; return (patch ? request(app).patch(endpoint) : request(app).post(endpoint)).set('x-workspace-id', 'workspace-a').set('x-user-id', actor); };
    await agent(`/inbox/conversations/${conversation.id}/assign`).send({ userId: actor }).expect(200).expect(response => expect(response.body.conversation).toMatchObject({ assignedUserId: actor, status: 'open', priority: 'normal' }));
    await agent(`/inbox/conversations/${conversation.id}/assign`).send({ userId: teammate }).expect(200).expect(response => expect(response.body.event).toMatchObject({ action: 'assigned', previousValue: actor, newValue: teammate }));
    await agent(`PATCH /inbox/conversations/${conversation.id}/status`).send({ status: 'in_progress' }).expect(200);
    await agent(`PATCH /inbox/conversations/${conversation.id}/priority`).send({ priority: 'urgent' }).expect(200).expect(response => expect(response.body.conversation.priority).toBe('urgent'));
    await agent(`/inbox/conversations/${conversation.id}/unassign`).send({}).expect(200).expect(response => expect(response.body.event.action).toBe('unassigned'));
    await agent(`PATCH /inbox/conversations/${conversation.id}/status`).send({ status: 'waiting_customer' }).expect(200);
    await agent(`PATCH /inbox/conversations/${conversation.id}/status`).send({ status: 'resolved' }).expect(200);
    await agent(`PATCH /inbox/conversations/${conversation.id}/status`).send({ status: 'archived' }).expect(200);
    await agent(`PATCH /inbox/conversations/${conversation.id}/status`).send({ status: 'open' }).expect(200).expect(response => expect(response.body.event.action).toBe('reopened'));
    await agent(`PATCH /inbox/conversations/${conversation.id}/status`).send({ status: 'resolved' }).expect(409);
    await request(app).get(`/api/v1/inbox/conversations/${conversation.id}/activity`).set('x-workspace-id', 'workspace-a').expect(200).expect(response => expect(response.body.map((event: { action: string }) => event.action)).toEqual(expect.arrayContaining(['assigned', 'unassigned', 'priority_changed', 'status_changed', 'archived', 'reopened'])));
    expect(socket.messages.map(message => JSON.parse(message).eventType)).toContain('conversation.management.updated');
  });
});
