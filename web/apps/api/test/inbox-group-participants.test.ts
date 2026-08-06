import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createWorkerTransportHandler, listenInternalTransport } from '../../worker/src/internal-transport-server.js';
import type { WhatsAppWorkerPort, WorkerCommand } from '../../worker/src/ports.js';

/* T3 — menções em grupos: endpoint de participantes (autocomplete + painel de
 * membros) e as validações semânticas do envio com `mentions`. O harness é o
 * de message-reactions.test.ts: app real sobre SQLite temporário, webhook
 * assinado e, quando o envio entra em cena, um worker falso no transporte
 * interno capturando o comando. */
const directories: string[] = [];
const applications: Array<Awaited<ReturnType<typeof createApp>>> = [];
const workerServers: Array<{ close: () => Promise<void> }> = [];
const key = 'mentions-test-secret';
const workspace = 'workspace-a';
const groupChat = '120363012345678901@g.us';
const directChat = '5511999990000@c.us';
const ada = '5511999990001@c.us';
const bento = '123456789012345@lid';
const caio = '5511999990003@c.us';
const dora = '5511999990004@c.us';
const signed = (body: unknown) => { const raw = JSON.stringify(body); return { raw, hmac: createHmac('sha512', key).update(raw).digest('hex'), timestamp: String(Date.now()) }; };

const appFor = async (workerTransportUrl = 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs = 20) => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-mentions-'));
  directories.push(directory);
  const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl, workerTransportTimeoutMs, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), wahaWebhookHmacKey: key, wahaWebhookWorkspaceId: workspace, developmentUserId: '00000000-0000-4000-8000-000000000001' });
  applications.push(app);
  return app;
};
afterEach(async () => {
  applications.splice(0).forEach(app => app.locals.persistenceDatabase?.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
  await Promise.all(workerServers.splice(0).map(server => server.close()));
});

const post = (app: Awaited<ReturnType<typeof createApp>>, body: unknown) => {
  const signedBody = signed(body);
  return request(app).post('/api/v1/webhooks/waha').set('content-type', 'application/json').set('x-webhook-hmac', signedBody.hmac).set('x-webhook-hmac-algorithm', 'sha512').set('x-webhook-timestamp', signedBody.timestamp).send(signedBody.raw);
};
const seedGroupMessage = async (app: Awaited<ReturnType<typeof createApp>>, messageId: string, participant?: string, timestamp = '2026-08-01T10:00:00.000Z') => {
  await post(app, { id: `evt-${messageId}`, timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: messageId, chatId: groupChat, from: groupChat, ...(participant ? { participant } : {}), body: 'mensagem de grupo', timestamp } }).expect(202);
};
const conversationId = (app: Awaited<ReturnType<typeof createApp>>, chat: string) =>
  (app.locals.persistenceDatabase.sqlite.prepare('SELECT id FROM conversations WHERE chatId = ?').get(chat) as { id: string }).id;
/** Grupo sincronizado de mentira: Ada (nome + telefone), Bento (@lid, só
 *  pushName), Caio (admin) e Dora, que SAIU do grupo e não pode aparecer. */
const seedParticipants = (app: Awaited<ReturnType<typeof createApp>>) => {
  const sqlite = app.locals.persistenceDatabase.sqlite;
  const now = '2026-08-01T09:00:00.000Z';
  const identity = sqlite.prepare('INSERT INTO whatsapp_identities (id, workspaceId, wahaSession, whatsappId, phone, name, pushName, profilePictureUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  identity.run('id-ada', workspace, 'waha-a', ada, '5511999990001', 'Ada Lovelace', null, null, now, now);
  identity.run('id-bento', workspace, 'waha-a', bento, null, null, 'Bento', null, now, now);
  sqlite.prepare('INSERT INTO whatsapp_groups (id, workspaceId, wahaSession, chatId, name, pictureUrl, metadataJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('group-1', workspace, 'waha-a', groupChat, 'Grupo Teste', null, null, now, now);
  const participant = sqlite.prepare('INSERT INTO whatsapp_group_participants (id, groupId, participantWhatsappId, role, createdAt) VALUES (?, ?, ?, ?, ?)');
  participant.run('p-ada', 'group-1', ada, null, now);
  participant.run('p-bento', 'group-1', bento, null, now);
  participant.run('p-caio', 'group-1', caio, 'admin', now);
  participant.run('p-dora', 'group-1', dora, 'left', now);
};
const participants = (app: Awaited<ReturnType<typeof createApp>>, id: string) =>
  request(app).get(`/api/v1/inbox/conversations/${id}/participants`).set('x-workspace-id', workspace);

describe('group participants endpoint', () => {
  it('lists synced members with display fields, and never the member who left', async () => {
    const app = await appFor();
    await seedGroupMessage(app, 'msg-g1');
    seedParticipants(app);
    const response = await participants(app, conversationId(app, groupChat)).expect(200);
    const items = response.body.items as Array<{ whatsappId: string; name: string | null; phone: string | null; role: string | null }>;
    expect(items.map(item => item.whatsappId).sort()).toEqual([ada, bento, caio].sort());
    expect(items.find(item => item.whatsappId === ada)).toMatchObject({ name: 'Ada Lovelace', phone: '5511999990001' });
    // @lid é primeira classe: sem telefone garantido, o pushName segura o nome.
    expect(items.find(item => item.whatsappId === bento)).toMatchObject({ name: 'Bento', phone: null });
    expect(items.find(item => item.whatsappId === caio)).toMatchObject({ role: 'admin' });
    expect(items.some(item => item.whatsappId === dora)).toBe(false);
  });
  it('orders by recency: the member who spoke last in the group comes first', async () => {
    const app = await appFor();
    await seedGroupMessage(app, 'msg-g1');
    seedParticipants(app);
    await seedGroupMessage(app, 'msg-g2', caio, '2026-08-01T11:00:00.000Z');
    const response = await participants(app, conversationId(app, groupChat)).expect(200);
    expect((response.body.items as Array<{ whatsappId: string }>)[0].whatsappId).toBe(caio);
  });
  it('answers 400 for a direct conversation and 404 for one that does not exist', async () => {
    const app = await appFor();
    await post(app, { id: 'evt-d1', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'msg-d1', chatId: directChat, body: 'oi', timestamp: '2026-08-01T10:00:00.000Z' } }).expect(202);
    await participants(app, conversationId(app, directChat)).expect(400);
    await participants(app, '00000000-0000-4000-8000-000000000099').expect(404);
  });
});

describe('send message with mentions', () => {
  const workerWith = (captured: WorkerCommand[]): WhatsAppWorkerPort => ({
    execute: async (_context, command) => {
      if (command.type === 'listSessions') return [];
      if (command.type === 'sendMessage') { captured.push(command); return { id: 'sent-1', timestamp: new Date().toISOString() }; }
      throw new Error(`unexpected command: ${command.type}`);
    },
  });
  const appWithWorker = async (captured: WorkerCommand[]) => {
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(workerWith(captured)));
    workerServers.push(runtime);
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('missing worker address');
    return appFor(`http://127.0.0.1:${address.port}/internal/transport`, 1_000);
  };
  const sendText = (app: Awaited<ReturnType<typeof createApp>>, id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/inbox/conversations/${id}/messages`).set('x-workspace-id', workspace).set('x-user-id', '00000000-0000-4000-8000-000000000001').send(body);

  it('carries mentions to the worker and stores them in the message metadata', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedGroupMessage(app, 'msg-g1');
    seedParticipants(app);
    const response = await sendText(app, conversationId(app, groupChat), { text: 'olá @5511999990001 tudo bem?', mentions: [ada] }).expect(201);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ type: 'sendMessage', chatId: groupChat, text: 'olá @5511999990001 tudo bem?', mentions: [ada] });
    expect(response.body.metadata.mentions).toEqual([ada]);
  });
  it('rejects mentions in a direct conversation with 400', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await post(app, { id: 'evt-d1', timestamp: Date.now(), event: 'message', session: 'waha-a', payload: { id: 'msg-d1', chatId: directChat, body: 'oi', timestamp: '2026-08-01T10:00:00.000Z' } }).expect(202);
    await sendText(app, conversationId(app, directChat), { text: 'olá @5511999990001', mentions: [ada] }).expect(400);
    expect(captured).toHaveLength(0);
  });
  it('drops the mention whose @digits are not in the text instead of failing the send', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedGroupMessage(app, 'msg-g1');
    seedParticipants(app);
    await sendText(app, conversationId(app, groupChat), { text: 'olá pessoal', mentions: [ada] }).expect(201);
    expect(captured).toHaveLength(1);
    expect((captured[0] as { mentions?: string[] }).mentions).toBeUndefined();
  });
  it('rejects a mention of someone outside the synced participant list', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedGroupMessage(app, 'msg-g1');
    seedParticipants(app);
    // Dora está na tabela, mas como `left`: não é participante para mencionar.
    await sendText(app, conversationId(app, groupChat), { text: 'olá @5511999990004', mentions: [dora] }).expect(400);
    await sendText(app, conversationId(app, groupChat), { text: 'olá @5511999990099', mentions: ['5511999990099@c.us'] }).expect(400);
    expect(captured).toHaveLength(0);
  });
  it('is fail-open when the group was never synced: the send goes through', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedGroupMessage(app, 'msg-g1');
    await sendText(app, conversationId(app, groupChat), { text: 'olá @5511999990001', mentions: [ada] }).expect(201);
    expect(captured[0]).toMatchObject({ mentions: [ada] });
  });
  it('rejects a malformed JID at the schema level', async () => {
    const captured: WorkerCommand[] = [];
    const app = await appWithWorker(captured);
    await seedGroupMessage(app, 'msg-g1');
    await sendText(app, conversationId(app, groupChat), { text: 'olá @Ada', mentions: ['Ada'] }).expect(400);
    await sendText(app, conversationId(app, groupChat), { text: 'olá @120363012345678901', mentions: [groupChat] }).expect(400);
    expect(captured).toHaveLength(0);
  });
});

/* Nomes do WhatsApp: quem o operador não tem salvo aparecia só como número.
 * Ao listar participantes, a API enfileira um sync de identidade por membro
 * sem nome — a WAHA devolve o pushName (nome que a pessoa cadastrou no
 * WhatsApp) e a próxima leitura já o mostra. A regra de design travada aqui:
 * membro de grupo NÃO vira contato do CRM. */
describe('participant identity sync — names from WhatsApp', () => {
  const appWithPort = async (port: WhatsAppWorkerPort) => {
    const runtime = await listenInternalTransport({ host: '127.0.0.1', port: 0 }, createWorkerTransportHandler(port));
    workerServers.push(runtime);
    const address = runtime.server.address();
    if (!address || typeof address === 'string') throw new Error('missing worker address');
    return appFor(`http://127.0.0.1:${address.port}/internal/transport`, 10_000);
  };
  const seedNamelessParticipants = (app: Awaited<ReturnType<typeof createApp>>) => {
    const now = '2026-08-01T09:00:00.000Z';
    app.locals.persistenceDatabase.sqlite.prepare('INSERT INTO whatsapp_groups (id, workspaceId, wahaSession, chatId, name, pictureUrl, metadataJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('group-1', workspace, 'waha-a', groupChat, 'Grupo Teste', null, null, now, now);
    const participant = app.locals.persistenceDatabase.sqlite.prepare('INSERT INTO whatsapp_group_participants (id, groupId, participantWhatsappId, role, createdAt) VALUES (?, ?, ?, ?, ?)');
    participant.run('p-ada', 'group-1', ada, null, now);
    participant.run('p-caio', 'group-1', caio, 'admin', now);
  };
  it('fills participant names in the background, without turning members into CRM contacts', async () => {
    const captured: WorkerCommand[] = [];
    const worker: WhatsAppWorkerPort = {
      execute: async (_context, command) => {
        if (command.type === 'listSessions') return [];
        if (command.type === 'syncIdentity') {
          captured.push(command);
          if (!command.refreshIdentity) return { identity: null, group: null };
          const jid = command.senderWhatsappId ?? command.chatId;
          return { identity: { whatsappId: jid, canonicalWhatsappId: jid, phone: jid.endsWith('@c.us') ? jid.split('@', 1)[0] : null, name: null, pushName: `Nome WPP ${jid.split('@', 1)[0].slice(-4)}`, shortName: null, profilePictureUrl: null }, group: null };
        }
        throw new Error(`unexpected command: ${command.type}`);
      },
    };
    const app = await appWithPort(worker);
    await seedGroupMessage(app, 'msg-g1');
    seedNamelessParticipants(app);
    const id = conversationId(app, groupChat);
    const first = await participants(app, id).expect(200);
    expect((first.body.items as Array<{ whatsappId: string; name: string | null }>).find(item => item.whatsappId === ada)?.name).toBeNull();
    // O sync é assíncrono (setImmediate + ida e volta ao worker): a leitura é
    // refeita até o pushName gravado aparecer na lista.
    await vi.waitFor(async () => {
      const again = await participants(app, id).expect(200);
      const items = again.body.items as Array<{ whatsappId: string; name: string | null; role: string | null }>;
      expect(items.find(item => item.whatsappId === ada)?.name).toBe('Nome WPP 0001');
      expect(items.find(item => item.whatsappId === caio)?.name).toBe('Nome WPP 0003');
    }, { timeout: 8_000, interval: 100 });
    expect(captured.some(command => command.type === 'syncIdentity' && command.chatId === ada && command.refreshIdentity === true)).toBe(true);
    // A regra de design: identidade gravada, contato do CRM NÃO criado.
    const sqlite = app.locals.persistenceDatabase.sqlite;
    expect((sqlite.prepare('SELECT count(*) AS total FROM contact_identifiers WHERE identifier = ?').get(ada.toLowerCase()) as { total: number }).total).toBe(0);
    expect((sqlite.prepare('SELECT count(*) AS total FROM whatsapp_identities WHERE whatsappId = ?').get(ada) as { total: number }).total).toBe(1);
  });
});
