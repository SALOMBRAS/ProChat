import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createWorkerTransportHandler, listenInternalTransport } from '../../worker/src/internal-transport-server.js';
import type { WhatsAppWorkerPort, WorkerCommand } from '../../worker/src/ports.js';

const directories: string[] = []; const applications: Array<Awaited<ReturnType<typeof createApp>>> = []; const workerServers: Array<{ close: () => Promise<void> }> = [];
const key = 'webhook-test-secret';
const signed = (body: unknown) => { const raw = JSON.stringify(body); return { raw, hmac: createHmac('sha512', key).update(raw).digest('hex'), timestamp: String(Date.now()) }; };
const appFor = async (workerTransportUrl = 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs = 20) => { const directory = mkdtempSync(join(tmpdir(), 'chatpro-group-participants-')); directories.push(directory); const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl, workerTransportTimeoutMs, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), wahaWebhookHmacKey: key, wahaWebhookWorkspaceId: 'workspace-a', developmentUserId: '00000000-0000-4000-8000-000000000001' }); applications.push(app); return app; };
afterEach(async () => { applications.splice(0).forEach(app => app.locals.persistenceDatabase?.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); await Promise.all(workerServers.splice(0).map(server => server.close())); });

const workspace = { 'x-workspace-id': 'workspace-a' };
const group = '120363363444637332@g.us';
const post = (app: Awaited<ReturnType<typeof createApp>>, body: unknown) => { const signedBody = signed(body); return request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedBody.timestamp).send(signedBody.raw); };
const groupMessage = (id: string, participant: string, body: string, timestamp: number) => ({ id: `evt-${id}`, timestamp, event: 'message' as const, session: 'waha-a', payload: { id, chatId: group, from: group, participant, body } });
const conversationId = (app: Awaited<ReturnType<typeof createApp>>, chatId: string) => (app.locals.persistenceDatabase.sqlite.prepare('SELECT id FROM conversations WHERE workspaceId = ? AND chatId = ?').get('workspace-a', chatId) as { id: string }).id;
const seedGroupRows = (app: Awaited<ReturnType<typeof createApp>>, participants: Array<{ whatsappId: string; role: string | null }>) => { const db = app.locals.persistenceDatabase.sqlite; const now = new Date().toISOString(); db.prepare("INSERT INTO whatsapp_groups (id, workspaceId, wahaSession, chatId, name, pictureUrl, metadataJson, createdAt, updatedAt) VALUES ('group-row-1', 'workspace-a', 'waha-a', ?, 'Família', NULL, NULL, ?, ?)").run(group, now, now); for (const [index, participant] of participants.entries()) db.prepare('INSERT INTO whatsapp_group_participants (id, groupId, participantWhatsappId, role, createdAt) VALUES (?, ?, ?, ?, ?)').run(`participant-row-${index}`, 'group-row-1', participant.whatsappId, participant.role, now); };
const seedIdentity = (app: Awaited<ReturnType<typeof createApp>>, whatsappId: string, name: string | null, phone: string | null) => { const now = new Date().toISOString(); app.locals.persistenceDatabase.sqlite.prepare('INSERT INTO whatsapp_identities (id, workspaceId, wahaSession, whatsappId, canonicalWhatsappId, phone, name, pushName, shortName, profilePictureUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)').run(`identity-${whatsappId}`, 'workspace-a', 'waha-a', whatsappId, whatsappId, phone, name, now, now); };
const sendingWorker = (sent: Array<Extract<WorkerCommand, { type: 'sendMessage' }>>): WhatsAppWorkerPort => ({ execute: async (_context, command) => { if (command.type === 'sendMessage') { sent.push(command); return { id: `sent-${sent.length}`, timestamp: new Date().toISOString() }; } throw new Error('unexpected command'); } });
const appWithWorker = async (worker: WhatsAppWorkerPort) => { const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(worker)); workerServers.push(runtime); const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('missing worker address'); return appFor(`http://127.0.0.1:${address.port}/internal/transport`, 1_000); };

describe('Group participants endpoint', () => {
  it('lists group participants with identity and contact names, recent activity first, excluding ex-members', async () => {
    const app = await appFor();
    await post(app, groupMessage('group-message-1', '5511999990002@c.us', 'Antiga', Date.now() - 1_000)).expect(202);
    await post(app, groupMessage('group-message-2', '5511999990001@c.us', 'Recente', Date.now())).expect(202);
    seedGroupRows(app, [{ whatsappId: '5511999990001@c.us', role: 'admin' }, { whatsappId: '5511999990002@c.us', role: 'participant' }, { whatsappId: '5511999990003@c.us', role: 'participant' }, { whatsappId: '5511999990004@c.us', role: 'left' }, { whatsappId: '5511999990005@c.us', role: null }]);
    seedIdentity(app, '5511999990001@c.us', 'Carlos', '5511999990001');
    seedIdentity(app, '5511999990003@c.us', 'Ana', '5511999990003');
    const now = new Date().toISOString();
    app.locals.persistenceDatabase.sqlite.prepare("INSERT INTO contacts (id, workspaceId, displayName, phoneNumber, email, company, createdAt, updatedAt) VALUES ('contact-1', 'workspace-a', 'Bruno', '5511999990005', NULL, NULL, ?, ?)").run(now, now);
    const response = await request(app).get(`/api/v1/inbox/conversations/${conversationId(app, group)}/participants`).set(workspace).expect(200);
    expect(response.body.items.map((item: { whatsappId: string }) => item.whatsappId)).toEqual(['5511999990001@c.us', '5511999990002@c.us', '5511999990003@c.us', '5511999990005@c.us']);
    expect(response.body.items[0]).toMatchObject({ whatsappId: '5511999990001@c.us', name: 'Carlos', phone: '5511999990001', role: 'admin' });
    expect(response.body.items[0].lastActiveAt).toBeTruthy();
    expect(response.body.items[1]).toMatchObject({ whatsappId: '5511999990002@c.us', name: null, phone: '5511999990002' });
    expect(response.body.items[2]).toMatchObject({ whatsappId: '5511999990003@c.us', name: 'Ana', lastActiveAt: null });
    expect(response.body.items[3]).toMatchObject({ whatsappId: '5511999990005@c.us', name: 'Bruno', lastActiveAt: null });
  });
  it('answers 404 for an unknown conversation and 400 for a direct conversation', async () => {
    const app = await appFor();
    await post(app, { id: 'evt-direct', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'direct-message', chatId: '5511999990000@c.us', body: 'Oi' } }).expect(202);
    await request(app).get('/api/v1/inbox/conversations/00000000-0000-4000-8000-000000000099/participants').set(workspace).expect(404);
    await request(app).get(`/api/v1/inbox/conversations/${conversationId(app, '5511999990000@c.us')}/participants`).set(workspace).expect(400);
  });
});

describe('Inbox send with mentions', () => {
  const seededGroupConversation = async (app: Awaited<ReturnType<typeof createApp>>, withParticipants = true) => { await post(app, groupMessage('group-message-1', '5511999990001@c.us', 'Oi', Date.now())).expect(202); if (withParticipants) seedGroupRows(app, [{ whatsappId: '5511999990001@c.us', role: 'participant' }]); return conversationId(app, group); };
  it('carries mentions through the worker command and persists them on the outbound message', async () => {
    const sent: Array<Extract<WorkerCommand, { type: 'sendMessage' }>> = [];
    const app = await appWithWorker(sendingWorker(sent));
    const id = await seededGroupConversation(app);
    const response = await request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set(workspace).send({ text: 'oi @5511999990001 tudo bem?', mentions: ['5511999990001@c.us'] }).expect(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chatId: group, text: 'oi @5511999990001 tudo bem?', mentions: ['5511999990001@c.us'] });
    expect(response.body.metadata).toMatchObject({ mentions: ['5511999990001@c.us'] });
    const persisted = app.locals.persistenceDatabase.sqlite.prepare("SELECT payloadJson FROM whatsapp_messages WHERE externalMessageId = 'sent-1'").get() as { payloadJson: string };
    expect(JSON.parse(persisted.payloadJson)).toMatchObject({ mentions: ['5511999990001@c.us'] });
  });
  it('rejects mentions on a direct conversation', async () => {
    const sent: Array<Extract<WorkerCommand, { type: 'sendMessage' }>> = [];
    const app = await appWithWorker(sendingWorker(sent));
    await post(app, { id: 'evt-direct', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'direct-message', chatId: '5511999990000@c.us', body: 'Oi' } }).expect(202);
    await request(app).post(`/api/v1/inbox/conversations/${conversationId(app, '5511999990000@c.us')}/messages`).set(workspace).send({ text: 'oi @5511999990001', mentions: ['5511999990001@c.us'] }).expect(400);
    expect(sent).toHaveLength(0);
  });
  it('rejects a mention outside the synchronized participant list', async () => {
    const sent: Array<Extract<WorkerCommand, { type: 'sendMessage' }>> = [];
    const app = await appWithWorker(sendingWorker(sent));
    const id = await seededGroupConversation(app);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set(workspace).send({ text: 'oi @5511999990999', mentions: ['5511999990999@c.us'] }).expect(400);
    expect(sent).toHaveLength(0);
  });
  it('allows mentions when the group was never synchronized (fail-open)', async () => {
    const sent: Array<Extract<WorkerCommand, { type: 'sendMessage' }>> = [];
    const app = await appWithWorker(sendingWorker(sent));
    const id = await seededGroupConversation(app, false);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set(workspace).send({ text: 'oi @5511999990001', mentions: ['5511999990001@c.us'] }).expect(201);
    expect(sent[0]?.mentions).toEqual(['5511999990001@c.us']);
  });
  it('drops mentions whose digits are no longer in the text', async () => {
    const sent: Array<Extract<WorkerCommand, { type: 'sendMessage' }>> = [];
    const app = await appWithWorker(sendingWorker(sent));
    const id = await seededGroupConversation(app);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set(workspace).send({ text: 'oi pessoal', mentions: ['5511999990001@c.us'] }).expect(201);
    expect(sent[0]?.mentions).toBeUndefined();
  });
  it('rejects malformed mention JIDs before any validation', async () => {
    const sent: Array<Extract<WorkerCommand, { type: 'sendMessage' }>> = [];
    const app = await appWithWorker(sendingWorker(sent));
    const id = await seededGroupConversation(app);
    await request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set(workspace).send({ text: 'oi @5511999990001', mentions: ['5511999990001@g.us'] }).expect(400);
    expect(sent).toHaveLength(0);
  });
});
