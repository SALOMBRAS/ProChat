import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';

const secret = 'gowa-webhook-test-secret';
const directories: string[] = [];
const applications: Array<Awaited<ReturnType<typeof createApp>>> = [];
const workspaceA = 'workspace-a';
const workspaceB = 'workspace-b';
const providerSessionA = 'chatpro-gowa-device-a';

const signed = (body: unknown) => {
  const raw = JSON.stringify(body);
  return { raw, signature: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` };
};

const event = (type: string, payload: Record<string, unknown> = {}, sessionId = providerSessionA) => ({
  event: type,
  // This is a WhatsApp JID in GOWA. Tests deliberately make sure it is not
  // persisted or returned by the ingress.
  device_id: '5511999999999@s.whatsapp.net',
  session_id: sessionId,
  timestamp: '2026-08-07T12:00:00.000Z',
  payload,
});

const appFor = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-gowa-webhook-'));
  directories.push(directory);
  const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), gowaWebhookSecret: secret, developmentUserId: '00000000-0000-4000-8000-000000000001' });
  applications.push(app);
  const db = app.locals.persistenceDatabase.sqlite;
  const insert = (workspaceId: string, sessionId: string, providerDeviceId: string, status = 'waiting_qr') => db.prepare("INSERT INTO whatsapp_provider_sessions (id,workspaceId,provider,sessionId,sessionName,providerDeviceId,providerStatus,chatproStatus,capabilitiesJson,providerMetadataJson,reconciliationState,createdAt,updatedAt,lastReconciledAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`row-${sessionId}`, workspaceId, 'gowa', sessionId, sessionId, providerDeviceId, 'unknown', status, '[]', '{}', 'unverified', '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z', null);
  insert(workspaceA, 'session-a', providerSessionA);
  insert(workspaceB, 'session-b', 'chatpro-gowa-device-b');
  return app;
};

const post = (app: Awaited<ReturnType<typeof createApp>>, body: unknown) => {
  const requestBody = signed(body);
  return request(app).post('/api/v1/webhooks/gowa').set('content-type', 'application/json').set('x-hub-signature-256', requestBody.signature).send(requestBody.raw);
};

afterEach(() => {
  applications.splice(0).forEach(app => app.locals.persistenceDatabase?.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('GOWA webhook ingress', () => {
  it('persists an inbound private text through the shared Inbox pipeline', async () => {
    const app = await appFor();
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspaceA);

    await post(app, event('message', { id: 'inbound-private', chat_id: '5511999990001@s.whatsapp.net', from: '5511999990001@s.whatsapp.net', is_from_me: false, sender_display_name: 'Ana Perfil', from_name: 'Ana Push', body: 'Olá, preciso de ajuda.' })).expect(202);

    const db = app.locals.persistenceDatabase.sqlite;
    expect(db.prepare('SELECT displayName,phoneNumber FROM contacts WHERE workspaceId=?').get(workspaceA)).toEqual({ displayName: 'Ana Perfil', phoneNumber: '5511999990001' });
    expect(db.prepare('SELECT chatId,conversationType,contactId,lastMessage FROM conversations WHERE workspaceId=?').get(workspaceA)).toMatchObject({ chatId: '5511999990001@c.us', conversationType: 'direct', contactId: expect.any(String), lastMessage: 'Olá, preciso de ajuda.' });
    expect(db.prepare('SELECT externalMessageId,direction,messageType,body,chatId FROM whatsapp_messages WHERE workspaceId=?').get(workspaceA)).toEqual({ externalMessageId: 'inbound-private', direction: 'inbound', messageType: 'text', body: 'Olá, preciso de ajuda.', chatId: '5511999990001@c.us' });
    expect(socket.messages.map(message => JSON.parse(message).eventType)).toEqual(expect.arrayContaining(['message.received', 'conversation.updated']));
    expect(JSON.stringify(socket.messages)).not.toContain('@s.whatsapp.net');
  });

  it('reuses the resolved contact and conversation for a later private message', async () => {
    const app = await appFor();
    const base = { chat_id: '5511999990002@s.whatsapp.net', from: '5511999990002@s.whatsapp.net', is_from_me: false, sender_display_name: 'Contato Existente' };
    await post(app, event('message', { ...base, id: 'existing-contact-first', body: 'Primeira mensagem' })).expect(202);
    await post(app, event('message', { ...base, id: 'existing-contact-second', body: 'Segunda mensagem' })).expect(202);

    const db = app.locals.persistenceDatabase.sqlite;
    expect(db.prepare('SELECT count(*) AS total FROM contacts WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 1 });
    expect(db.prepare('SELECT count(*) AS total FROM conversations WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 1 });
    expect(db.prepare('SELECT count(*) AS total FROM whatsapp_messages WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 2 });
  });

  it('keeps a group message in one group conversation and never creates its participant as a contact', async () => {
    const app = await appFor();
    await post(app, event('message', { id: 'group-message', chat_id: '120363012345678901@g.us', from: '5511999990003@s.whatsapp.net', is_from_me: false, sender_display_name: 'Participante do Grupo', body: 'Bom dia, pessoal.' })).expect(202);

    const db = app.locals.persistenceDatabase.sqlite;
    expect(db.prepare('SELECT chatId,conversationType,contactId FROM conversations WHERE workspaceId=?').get(workspaceA)).toEqual({ chatId: '120363012345678901@g.us', conversationType: 'group', contactId: null });
    expect(db.prepare('SELECT chatId,senderWhatsappId FROM whatsapp_messages WHERE workspaceId=?').get(workspaceA)).toEqual({ chatId: '120363012345678901@g.us', senderWhatsappId: '5511999990003@c.us' });
    expect(db.prepare('SELECT count(*) AS total FROM contacts WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 0 });
    expect(db.prepare("SELECT count(*) AS total FROM conversations WHERE workspaceId=? AND chatId='5511999990003@c.us'").get(workspaceA)).toEqual({ total: 0 });
  });

  it('uses a safe profile name for a LID identity and never sends the raw identifier through realtime', async () => {
    const app = await appFor();
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspaceA);
    await post(app, event('message', { id: 'lid-message', chat_id: '200339068317777@lid', from: '200339068317777@lid', is_from_me: false, sender_display_name: 'Pessoa Identificada', body: 'Mensagem por LID' })).expect(202);

    const conversation = await app.locals.wahaWebhookStore.getConversation(workspaceA, (app.locals.persistenceDatabase.sqlite.prepare('SELECT id FROM conversations WHERE workspaceId=?').get(workspaceA) as { id: string }).id);
    expect(conversation?.identity).toMatchObject({ displayName: 'Pessoa Identificada', profileName: 'Pessoa Identificada', phone: null });
    expect(JSON.stringify(conversation?.identity)).not.toContain('200339068317777');
    expect(JSON.stringify(socket.messages)).not.toContain('200339068317777');
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM contacts WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 0 });
  });

  it('persists a repeated inbound webhook only once', async () => {
    const app = await appFor();
    const body = event('message', { id: 'duplicate-inbound', chat_id: '5511999990004@s.whatsapp.net', from: '5511999990004@s.whatsapp.net', is_from_me: false, sender_display_name: 'Duplicidade', body: 'Não duplicar' });
    await post(app, body).expect(202);
    await post(app, body).expect(200).expect(response => expect(response.body).toEqual({ accepted: true, duplicate: true }));
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM whatsapp_messages WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 1 });
  });

  it('acknowledges media payloads without letting them enter the text Inbox path', async () => {
    const app = await appFor();
    await post(app, event('message', { id: 'unsupported-media', chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, body: 'Legenda', media: { url: 'https://gowa.invalid/media' } })).expect(202);
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM whatsapp_messages WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 0 });
  });

  it('logs every discarded inbound message without leaking JID, URL, caption or device id', async () => {
    const app = await appFor();
    const lines: string[] = [];
    const console_log = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
    try {
      await post(app, event('message', { id: 'dropped-image', chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, body: 'Legenda secreta', type: 'image', mime_type: 'IMAGE/JPEG', media: { url: 'https://gowa.invalid/media?token=abc123' } })).expect(202);
    } finally { console_log.mockRestore(); }

    const discard = lines.map(line => JSON.parse(line)).find(entry => entry.message === 'GOWA inbound message discarded before the Inbox');
    expect(discard).toMatchObject({ level: 'info', workspaceId: workspaceA, sessionId: 'session-a', reason: 'unsupported_media', declaredType: 'image', mediaMimeType: 'image/jpeg', hasMediaField: true, chatKind: 'direct' });

    // The whole point of the log is that it can be shipped anywhere.
    const serialized = JSON.stringify(discard);
    for (const secret of ['5511999990005', '@s.whatsapp.net', 'gowa.invalid', 'token=abc123', 'Legenda secreta', 'chatpro-gowa-device-a', 'dropped-image']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('separates a discarded inbound from an event that was never an inbound message', async () => {
    const app = await appFor();
    const lines: string[] = [];
    const console_log = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
    try {
      // A group text with no body is a discard: it was inbound and got dropped.
      await post(app, event('message', { id: 'empty-group', chat_id: '120363000000000001@g.us', from: '5511999990006@s.whatsapp.net', is_from_me: false })).expect(202);
      // An outgoing echo is not a discard and must stay out of the counter.
      await post(app, event('message', { id: 'our-own-send', chat_id: '5511999990007@s.whatsapp.net', is_from_me: true })).expect(202);
    } finally { console_log.mockRestore(); }

    const discards = lines.map(line => JSON.parse(line)).filter(entry => entry.message === 'GOWA inbound message discarded before the Inbox');
    expect(discards).toHaveLength(1);
    expect(discards[0]).toMatchObject({ reason: 'invalid_envelope', chatKind: 'group', hasMediaField: false, declaredType: null, mediaMimeType: null });
  });

  it('normalizes a connected session without exposing GOWA identifiers', async () => {
    const app = await appFor();
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspaceA);

    await post(app, event('session.connected')).expect(202).expect(response => expect(response.body).toEqual({ accepted: true, duplicate: false }));

    const row = app.locals.persistenceDatabase.sqlite.prepare('SELECT providerStatus,chatproStatus,reconciliationState,lastReconciledAt FROM whatsapp_provider_sessions WHERE workspaceId=? AND sessionId=?').get(workspaceA, 'session-a');
    expect(row).toMatchObject({ providerStatus: 'connected', chatproStatus: 'connected', reconciliationState: 'healthy', lastReconciledAt: '2026-08-07T12:00:00.000Z' });
    expect(JSON.parse(socket.messages[0]!)).toMatchObject({ eventType: 'session.status.changed', workspaceId: workspaceA, payload: { sessionId: 'session-a', status: 'connected', previousStatus: 'waiting_qr', changedAt: '2026-08-07T12:00:00.000Z' } });
    expect(JSON.stringify(socket.messages)).not.toContain('5511999999999');
  });

  it('normalizes a disconnected session and persists its last observation', async () => {
    const app = await appFor();
    await post(app, event('session.disconnected')).expect(202);
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT providerStatus,chatproStatus,reconciliationState,lastReconciledAt FROM whatsapp_provider_sessions WHERE workspaceId=? AND sessionId=?').get(workspaceA, 'session-a')).toMatchObject({ providerStatus: 'disconnected', chatproStatus: 'disconnected', reconciliationState: 'healthy', lastReconciledAt: '2026-08-07T12:00:00.000Z' });
  });

  it('normalizes GOWA outgoing messages and delivery/read receipts without creating Inbox data', async () => {
    const app = await appFor();
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspaceA);

    await post(app, event('message', { id: 'message-sent', is_from_me: true })).expect(202);
    await post(app, event('message.ack', { ids: ['message-delivered'], receipt_type: 'delivered' })).expect(202);
    await post(app, event('message.ack', { ids: ['message-read'], receipt_type: 'read' })).expect(202);

    expect(socket.messages.map(message => JSON.parse(message).payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-a', messageId: 'message-sent', status: 'sent' }),
      expect.objectContaining({ sessionId: 'session-a', messageId: 'message-delivered', status: 'delivered' }),
      expect.objectContaining({ sessionId: 'session-a', messageId: 'message-read', status: 'read' }),
    ]));
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM conversations').get()).toEqual({ total: 0 });
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM whatsapp_messages').get()).toEqual({ total: 0 });
  });

  it('rejects a signed event whose GOWA session is not mapped', async () => {
    const app = await appFor();
    await post(app, event('message', { id: 'message', is_from_me: true }, 'unknown-provider-session')).expect(404).expect(response => expect(JSON.stringify(response.body)).not.toContain('unknown-provider-session'));
  });

  it('rejects invalid or unsigned payloads before doing any work', async () => {
    const app = await appFor();
    await request(app).post('/api/v1/webhooks/gowa').send(event('message')).expect(401);
    await post(app, { event: 'message', payload: {} }).expect(400);
  });

  it('makes an exact retry a no-op', async () => {
    const app = await appFor();
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspaceA);
    const body = event('session.connected');
    await post(app, body).expect(202);
    await post(app, body).expect(200).expect(response => expect(response.body).toEqual({ accepted: true, duplicate: true }));
    expect(socket.messages).toHaveLength(1);
  });

  it('derives workspace from the persisted provider mapping, never from a webhook field', async () => {
    const app = await appFor();
    await post(app, { ...event('session.connected'), workspace_id: workspaceB }).expect(202);
    const db = app.locals.persistenceDatabase.sqlite;
    expect(db.prepare('SELECT chatproStatus FROM whatsapp_provider_sessions WHERE workspaceId=? AND sessionId=?').get(workspaceA, 'session-a')).toEqual({ chatproStatus: 'connected' });
    expect(db.prepare('SELECT chatproStatus FROM whatsapp_provider_sessions WHERE workspaceId=? AND sessionId=?').get(workspaceB, 'session-b')).toEqual({ chatproStatus: 'waiting_qr' });
  });
});
