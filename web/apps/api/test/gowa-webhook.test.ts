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

  it('persiste cada tipo de mídia com o tipo canônico e a URL, pelo pipeline existente', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;
    const cases = [
      ['image', { image: { url: 'https://gowa.invalid/a.jpg', mime_type: 'image/jpeg', caption: 'Legenda' } }, 'image', 'Legenda'],
      ['video', { video: { url: 'https://gowa.invalid/a.mp4', mime_type: 'video/mp4' } }, 'video', null],
      ['audio', { audio: { url: 'https://gowa.invalid/a.ogg', mime_type: 'audio/ogg' } }, 'audio', null],
      ['ptt', { audio: { url: 'https://gowa.invalid/v.ogg', mime_type: 'audio/ogg', ptt: true } }, 'ptt', null],
      ['document', { document: { url: 'https://gowa.invalid/a.pdf', mime_type: 'application/pdf', filename: 'a.pdf' } }, 'document', null],
      ['sticker', { sticker: { url: 'https://gowa.invalid/a.webp', mime_type: 'image/webp' } }, 'sticker', null],
    ] as const;

    for (const [name, payload, expectedType, expectedBody] of cases) {
      await post(app, event('message', { id: `media-${name}`, chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, ...payload })).expect(202);
      const row = db.prepare('SELECT messageType, mediaUrl, mediaMimeType, body FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, `media-${name}`) as { messageType: string; mediaUrl: string | null; mediaMimeType: string | null; body: string | null };
      expect(row, name).toBeDefined();
      expect(row.messageType, name).toBe(expectedType);
      expect(row.mediaUrl, name).toMatch(/^https:\/\/gowa\.invalid\//);
      expect(row.body, name).toBe(expectedBody);
    }
  });

  it('persiste a mensagem de mídia mesmo sem URL, para a conversa não perder o evento', async () => {
    const app = await appFor();
    // Com auto-download ligado o GOWA reporta um caminho do servidor dele. O
    // caminho nunca é lido, mas a mensagem precisa existir na Inbox.
    await post(app, event('message', { id: 'media-sem-url', chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, image: 'statics/media/deadbeef.jpg' })).expect(202);

    const row = app.locals.persistenceDatabase.sqlite.prepare('SELECT messageType, mediaUrl, payloadJson FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'media-sem-url') as { messageType: string; mediaUrl: string | null; payloadJson: string };
    expect(row.messageType).toBe('image');
    expect(row.mediaUrl).toBeNull();
    expect(row.payloadJson).not.toContain('statics/media');
  });

  it('recusa forma de mídia não tipada em vez de gravá-la como texto', async () => {
    const app = await appFor();
    // `media` genérico não é uma das chaves que o GOWA documenta. Cair no ramo
    // de texto gravaria uma foto como mensagem de texto com a legenda no corpo.
    await post(app, event('message', { id: 'media-generica', chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, body: 'Legenda', media: { url: 'https://gowa.invalid/media' } })).expect(202);
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM whatsapp_messages WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 0 });
  });

  it('persiste localização e cartão de contato pelos mesmos tipos da Inbox', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;

    await post(app, event('message', { id: 'loc-1', chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, location: { latitude: -23.5, longitude: -46.6, name: 'Loja Centro' } })).expect(202);
    await post(app, event('message', { id: 'card-1', chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, contacts: [{ name: 'Ana', phone: '5511999990009' }] })).expect(202);

    const location = db.prepare('SELECT messageType, body FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'loc-1') as { messageType: string; body: string | null };
    const card = db.prepare('SELECT messageType FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'card-1') as { messageType: string };
    expect(location.messageType).toBe('location');
    // O texto visível de uma localização é o nome do lugar, nunca a miniatura.
    expect(location.body).toBe('Loja Centro');
    expect(card.messageType).toBe('vcard');
  });

  it('logs every discarded inbound message without leaking JID, URL, caption or device id', async () => {
    const app = await appFor();
    const lines: string[] = [];
    const console_log = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)); });
    try {
      await post(app, event('message', { id: 'dropped-image', chat_id: '5511999990005@s.whatsapp.net', from: '5511999990005@s.whatsapp.net', is_from_me: false, body: 'Legenda secreta', type: 'image', mime_type: 'IMAGE/JPEG', media: { url: 'https://gowa.invalid/media?token=abc123' }, mimetype: 'image/jpeg' })).expect(202);
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

  it('converte call.offer no mesmo call_log que a WAHA produz, com não-lida e realtime', async () => {
    const app = await appFor();
    const socket = { readyState: 1, messages: [] as string[], send(data: string) { this.messages.push(data); } };
    app.locals.realtimeHub.add(socket, workspaceA);

    await post(app, event('call.offer', { from: '5511999990010@s.whatsapp.net', call_id: 'call-abc' })).expect(202);

    const db = app.locals.persistenceDatabase.sqlite;
    const row = db.prepare('SELECT messageType, chatId FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'call-abc') as { messageType: string; chatId: string };
    expect(row.messageType).toBe('call_log');
    expect(row.chatId).toBe('5511999990010@c.us');
    // Uma chamada perdida é pedido de contato: abre conversa e conta não-lida.
    const conversation = db.prepare('SELECT unreadCount FROM conversations WHERE workspaceId=? AND chatId=?').get(workspaceA, '5511999990010@c.us') as { unreadCount: number };
    expect(conversation.unreadCount).toBe(1);
    expect(socket.messages.join(' ')).toContain('message.received');
  });

  it('faz de uma chamada repetida um no-op, mesmo sem id de mensagem', async () => {
    const app = await appFor();
    const call = { from: '5511999990011@s.whatsapp.net' };

    await post(app, event('call.offer', call)).expect(202);
    await post(app, event('call.offer', call)).expect(200);

    expect(app.locals.persistenceDatabase.sqlite.prepare("SELECT count(*) AS total FROM whatsapp_messages WHERE workspaceId=? AND messageType='call_log'").get(workspaceA)).toEqual({ total: 1 });
  });

  it('nunca aceita grupo como origem de chamada', async () => {
    const app = await appFor();
    await post(app, event('call.offer', { from: '120363000000000001@g.us', call_id: 'call-grupo' })).expect(202);
    expect(app.locals.persistenceDatabase.sqlite.prepare('SELECT count(*) AS total FROM whatsapp_messages WHERE workspaceId=?').get(workspaceA)).toEqual({ total: 0 });
  });

  it('persiste sent, delivered e read, e sobrevive ao reload', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;
    const status = () => (db.prepare('SELECT status FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'ack-1') as { status: string } | undefined)?.status;

    await post(app, event('message', { id: 'ack-1', chat_id: '5511999990020@s.whatsapp.net', from: '5511999990020@s.whatsapp.net', is_from_me: false, body: 'oi' })).expect(202);
    expect(status()).toBe('received');

    await post(app, event('message.ack', { ids: ['ack-1'], chat_id: '5511999990020@s.whatsapp.net', receipt_type: 'delivered' })).expect(202);
    expect(status()).toBe('delivered');

    await post(app, event('message.ack', { ids: ['ack-1'], chat_id: '5511999990020@s.whatsapp.net', receipt_type: 'read' })).expect(202);
    expect(status()).toBe('read');
  });

  it('nunca rebaixa um read por um delivered atrasado', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;
    await post(app, event('message', { id: 'ack-2', chat_id: '5511999990021@s.whatsapp.net', from: '5511999990021@s.whatsapp.net', is_from_me: false, body: 'oi' })).expect(202);
    await post(app, event('message.ack', { ids: ['ack-2'], chat_id: '5511999990021@s.whatsapp.net', receipt_type: 'read' })).expect(202);

    // Recibos chegam fora de ordem; o estado avança, nunca retrocede.
    await post(app, event('message.ack', { ids: ['ack-2'], chat_id: '5511999990021@s.whatsapp.net', receipt_type: 'delivered', timestamp: '2026-08-07T12:00:01.000Z' })).expect(202);

    expect((db.prepare('SELECT status FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'ack-2') as { status: string }).status).toBe('read');
  });

  it('não grava recibo na mensagem de mesmo id de outra sessão', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;
    // Mesmo externalMessageId, sessão diferente — o caso WAHA/GOWA msg-123.
    db.prepare("INSERT INTO waha_webhook_events (workspaceId,wahaSession,externalEventId,eventType,occurredAt,payloadJson,receivedAt) VALUES (?,?,?,?,?,?,?)").run(workspaceA, 'outra-sessao', 'ev-x', 'message', '2026-08-07T00:00:00.000Z', '{}', '2026-08-07T00:00:00.000Z');
    db.prepare("INSERT INTO whatsapp_messages (workspaceId,wahaSession,externalMessageId,externalEventId,chatId,direction,messageType,body,occurredAt,payloadJson,receivedAt,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(workspaceA, 'outra-sessao', 'colide-1', 'ev-x', '5511999990022@c.us', 'outbound', 'text', 'x', '2026-08-07T00:00:00.000Z', '{}', '2026-08-07T00:00:00.000Z', 'sent');

    await post(app, event('message.ack', { ids: ['colide-1'], chat_id: '5511999990022@s.whatsapp.net', receipt_type: 'read' })).expect(202);

    expect((db.prepare('SELECT status FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'colide-1') as { status: string }).status).toBe('sent');
  });

  it('grava providerSessionId em evento, mensagem e conversa — texto, mídia, grupo e call_log', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;
    const esperado = 'row-session-a';

    await post(app, event('message', { id: 'ps-texto', chat_id: '5511999990030@s.whatsapp.net', from: '5511999990030@s.whatsapp.net', is_from_me: false, body: 'oi' })).expect(202);
    await post(app, event('message', { id: 'ps-midia', chat_id: '5511999990030@s.whatsapp.net', from: '5511999990030@s.whatsapp.net', is_from_me: false, image: { url: 'https://gowa.invalid/a.jpg', mime_type: 'image/jpeg' } })).expect(202);
    await post(app, event('message', { id: 'ps-grupo', chat_id: '120363000000000009@g.us', from: '5511999990031@s.whatsapp.net', is_from_me: false, body: 'no grupo' })).expect(202);
    await post(app, event('call.offer', { from: '5511999990032@s.whatsapp.net', call_id: 'ps-call' })).expect(202);

    for (const id of ['ps-texto', 'ps-midia', 'ps-grupo', 'ps-call']) {
      const message = db.prepare('SELECT providerSessionId FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, id) as { providerSessionId: string | null };
      expect(message.providerSessionId, id).toBe(esperado);
    }
    // Evento e conversa também deixam de nascer com NULL.
    const evento = db.prepare('SELECT providerSessionId FROM waha_webhook_events WHERE workspaceId=? AND externalEventId=?').get(workspaceA, 'gowa:ps-texto') as { providerSessionId: string | null };
    const conversas = db.prepare('SELECT count(*) AS total FROM conversations WHERE workspaceId=? AND providerSessionId=?').get(workspaceA, esperado) as { total: number };
    expect(evento.providerSessionId).toBe(esperado);
    expect(conversas.total).toBeGreaterThanOrEqual(3);
  });

  it('grava o providerSessionId do workspace certo, sem vazar entre workspaces', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;

    await post(app, event('message', { id: 'ws-a', chat_id: '5511999990040@s.whatsapp.net', from: '5511999990040@s.whatsapp.net', is_from_me: false, body: 'a' })).expect(202);
    await post(app, event('message', { id: 'ws-b', chat_id: '5511999990041@s.whatsapp.net', from: '5511999990041@s.whatsapp.net', is_from_me: false, body: 'b' }, 'chatpro-gowa-device-b')).expect(202);

    expect((db.prepare('SELECT workspaceId, providerSessionId FROM whatsapp_messages WHERE externalMessageId=?').get('ws-a') as { workspaceId: string; providerSessionId: string })).toEqual({ workspaceId: workspaceA, providerSessionId: 'row-session-a' });
    expect((db.prepare('SELECT workspaceId, providerSessionId FROM whatsapp_messages WHERE externalMessageId=?').get('ws-b') as { workspaceId: string; providerSessionId: string })).toEqual({ workspaceId: workspaceB, providerSessionId: 'row-session-b' });
  });

  it('linha antiga com providerSessionId NULL continua legível e recebe recibo pelo fallback', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;
    // Linha histórica: gravada antes da coluna existir.
    db.prepare("INSERT INTO waha_webhook_events (workspaceId,wahaSession,externalEventId,eventType,occurredAt,payloadJson,receivedAt) VALUES (?,?,?,?,?,?,?)").run(workspaceA, 'session-a', 'ev-legado', 'message', '2026-08-07T00:00:00.000Z', '{}', '2026-08-07T00:00:00.000Z');
    db.prepare("INSERT INTO whatsapp_messages (workspaceId,wahaSession,externalMessageId,externalEventId,chatId,direction,messageType,body,occurredAt,payloadJson,receivedAt,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(workspaceA, 'session-a', 'legado-1', 'ev-legado', '5511999990050@c.us', 'outbound', 'text', 'x', '2026-08-07T00:00:00.000Z', '{}', '2026-08-07T00:00:00.000Z', 'sent');

    await post(app, event('message.ack', { ids: ['legado-1'], chat_id: '5511999990050@s.whatsapp.net', receipt_type: 'read' })).expect(202);

    const row = db.prepare('SELECT status, providerSessionId FROM whatsapp_messages WHERE workspaceId=? AND externalMessageId=?').get(workspaceA, 'legado-1') as { status: string; providerSessionId: string | null };
    expect(row.status).toBe('read');
    // O fallback lê a linha antiga sem reescrever seu escopo: nada de backfill implícito.
    expect(row.providerSessionId).toBeNull();
  });

  it('grava providerSessionId também na identidade WhatsApp', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;

    await post(app, event('message', { id: 'id-1', chat_id: '5511999990060@s.whatsapp.net', from: '5511999990060@s.whatsapp.net', is_from_me: false, body: 'oi', sender_display_name: 'Ana' })).expect(202);

    const identity = db.prepare('SELECT providerSessionId, phone FROM whatsapp_identities WHERE workspaceId=? AND whatsappId=?').get(workspaceA, '5511999990060@c.us') as { providerSessionId: string | null; phone: string | null };
    expect(identity.providerSessionId).toBe('row-session-a');
    expect(identity.phone).toBe('5511999990060');
  });

  it('identidade por LID não ganha telefone e mantém o escopo da conexão', async () => {
    const app = await appFor();
    const db = app.locals.persistenceDatabase.sqlite;

    await post(app, event('message', { id: 'id-lid', chat_id: '251556368777322@lid', from: '251556368777322@lid', is_from_me: false, body: 'oi' })).expect(202);

    const identity = db.prepare('SELECT providerSessionId, phone FROM whatsapp_identities WHERE workspaceId=? AND whatsappId=?').get(workspaceA, '251556368777322@lid') as { providerSessionId: string | null; phone: string | null };
    expect(identity.providerSessionId).toBe('row-session-a');
    // Os dígitos de um LID nunca são telefone.
    expect(identity.phone).toBeNull();
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
