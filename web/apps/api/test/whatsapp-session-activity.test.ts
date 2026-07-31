import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxController } from '../src/controllers/inbox.controller.js';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { AttachmentOutboxService, SqliteAttachmentOutboxStore } from '../src/services/attachment-outbox.service.js';
import { InternalInboxService } from '../src/services/internal-inbox.service.js';
import { SlaMessageCoordinator } from '../src/services/sla-message-coordinator.service.js';
import { SlaService, SqliteSlaStore } from '../src/services/sla.service.js';
import { historyRecord, SqliteWahaWebhookStore, webhookRecord } from '../src/services/waha-webhook.service.js';
import { inactiveSessionReason, WhatsAppSessionActivityService, withSessionActivity } from '../src/services/whatsapp-session-activity.service.js';

/**
 * Cobre o tratamento das conversas deixadas por sessões WhatsApp anteriores —
 * ver web/docs/conversas-sessao-inativa.md.
 *
 * A garantia que mais importa está em "mantém o envio na conversa viva do mesmo
 * contato": há 62 números com conversa nas duas sessões, e marcar a morta não
 * pode custar a viva.
 */
const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
const workspaceId = 'workspace-a';
const live = 'chatpro-viva';
const dead = 'chatpro-morta';
const context = { workspaceId, correlationId: 'correlation-a', userId: '00000000-0000-4000-8000-0000000000ff' };

const sqlite = () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-session-activity-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations);
  database.migrate();
  return database;
};
/** O mesmo número em duas sessões: a chave única é (workspace, sessão, chat). */
const conversation = (database: SqlitePersistenceDatabase, id: string, wahaSession: string, chatId = '5511999990001@c.us') => {
  const now = '2026-07-21T15:00:00.000Z';
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,deliveryChatId,contactId,conversationType,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, workspaceId, wahaSession, chatId, chatId, null, 'direct', 'open', 'Olá', now, 0, now, now);
  return id;
};
const activity = (sessions: Array<{ status: string; wahaName?: string }> | Error, ttlMs = 30_000, clock = () => 0) =>
  new WhatsAppSessionActivityService({ list: async () => { if (sessions instanceof Error) throw sessions; return sessions; } }, ttlMs, clock);

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('quais sessões WhatsApp ainda existem', () => {
  it('resolve o conjunto pelo wahaName, não pelo id interno do ChatPro', async () => {
    const service = activity([{ status: 'connected', wahaName: live }]);
    expect([...(await service.activeSessions(context))!]).toEqual([live]);
  });

  // Sessão parada ou reconectando continua existindo e volta sozinha. Filtrar por
  // `connected` faria a marcação piscar e bloquearia envio na sessão certa.
  it('conta sessão que existe mas não está conectada como ativa', async () => {
    const service = activity([{ status: 'stopped', wahaName: live }]);
    expect(await service.isActive(context, live)).toBe(true);
  });

  it('falha aberto quando o worker não responde', async () => {
    const service = activity(new Error('Internal worker is unavailable'));
    expect(await service.activeSessions(context)).toBeUndefined();
    expect(await service.isActive(context, dead)).toBe(true);
    await expect(service.assertActive(context, dead)).resolves.toBeUndefined();
  });

  // Baileys e o provider demo não preenchem `wahaName`: a lista chega cheia e sem
  // nome resolvível. Condenar o workspace inteiro por isso seria pior do que não
  // marcar nada.
  it('falha aberto quando nenhuma sessão listada expõe wahaName', async () => {
    const service = activity([{ status: 'connected' }, { status: 'connected' }]);
    expect(await service.activeSessions(context)).toBeUndefined();
  });

  it('recusa a sessão que não está na lista, sem citar o identificador técnico', async () => {
    const service = activity([{ status: 'connected', wahaName: live }]);
    await expect(service.assertActive(context, dead)).rejects.toMatchObject({ status: 409, code: 'CONFLICT', details: { reason: inactiveSessionReason } });
    await expect(service.assertActive(context, dead)).rejects.toSatisfy((error: Error) => !error.message.includes(dead));
    await expect(service.assertActive(context, live)).resolves.toBeUndefined();
  });

  it('consulta o worker uma vez por janela de cache e volta a consultar depois dela', async () => {
    let calls = 0; let clock = 0;
    const service = new WhatsAppSessionActivityService({ list: async () => { calls += 1; return [{ status: 'connected', wahaName: live }]; } }, 30_000, () => clock);
    await service.activeSessions(context); await service.activeSessions(context);
    expect(calls).toBe(1);
    clock = 30_001;
    await service.activeSessions(context);
    expect(calls).toBe(2);
  });
});

describe('marcador de sessão na listagem', () => {
  it('marca cada conversa sem tirar nenhuma da lista', () => {
    const items = [{ id: 'a', whatsappSessionId: live }, { id: 'b', whatsappSessionId: dead }];
    expect(withSessionActivity(items, new Set([live]))).toEqual([{ id: 'a', whatsappSessionId: live, whatsappSessionActive: true }, { id: 'b', whatsappSessionId: dead, whatsappSessionActive: false }]);
  });

  it('trata tudo como ativo quando o conjunto é desconhecido', () => {
    expect(withSessionActivity([{ id: 'b', whatsappSessionId: dead }], undefined)).toEqual([{ id: 'b', whatsappSessionId: dead, whatsappSessionActive: true }]);
  });

  // A rota é o que o operador vê: a lista tem que continuar com o mesmo tamanho,
  // a mesma ordem e o mesmo total — o marcador é o único acréscimo.
  it('a rota devolve a lista inteira, na mesma ordem, com o marcador', async () => {
    const database = sqlite();
    try {
      const store = new SqliteWahaWebhookStore(database.sqlite);
      conversation(database, '00000000-0000-4000-8000-000000000010', dead, '5511999990001@c.us');
      conversation(database, '00000000-0000-4000-8000-000000000011', live, '5511999990001@c.us');
      const controller = new InboxController(store, {} as never, {} as never, {} as never, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, activity([{ status: 'connected', wahaName: live }]));
      let body: any;
      await controller.listConversations({ context, query: {} } as never, { json: (value: unknown) => { body = value; } } as never, (() => undefined) as never);
      expect(body.total).toBe(2);
      expect(body.items.map((item: any) => [item.whatsappSessionId, item.whatsappSessionActive])).toEqual([[dead, false], [live, true]]);
    } finally { database.close(); }
  });
});

describe('envio numa conversa de sessão que não existe mais', () => {
  const inbox = (database: SqlitePersistenceDatabase, sessions: Array<{ status: string; wahaName?: string }> | Error, send = vi.fn(async () => ({ success: true as const, data: { sentMessage: { id: 'wamid-1', timestamp: '2026-07-29T12:00:00.000Z' } } }))) => {
    const store = new SqliteWahaWebhookStore(database.sqlite);
    return { send, service: new InternalInboxService({ send } as never, store, new RealtimeHub(), undefined, undefined, activity(sessions)) };
  };

  // O worker reconcilia por alias: sem esta recusa a mensagem sai de verdade pela
  // sessão atual, fica gravada na conversa antiga, e a resposta do cliente chega
  // carimbada com a sessão nova — em outra conversa.
  it('recusa antes de chamar o worker, para a thread não partir', async () => {
    const database = sqlite();
    try {
      const id = conversation(database, '00000000-0000-4000-8000-000000000001', dead);
      const { send, service } = inbox(database, [{ status: 'connected', wahaName: live }]);
      await expect(service.send(context, id, 'Olá')).rejects.toMatchObject({ status: 409, details: { reason: inactiveSessionReason } });
      expect(send).not.toHaveBeenCalled();
      expect(database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages WHERE workspaceId=?').get(workspaceId)).toMatchObject({ total: 0 });
    } finally { database.close(); }
  });

  it('mantém o envio na conversa viva do mesmo contato', async () => {
    const database = sqlite();
    try {
      conversation(database, '00000000-0000-4000-8000-000000000002', dead);
      const alive = conversation(database, '00000000-0000-4000-8000-000000000003', live);
      const { send, service } = inbox(database, [{ status: 'connected', wahaName: live }]);
      await expect(service.send(context, alive, 'Olá')).resolves.toMatchObject({ direction: 'outbound', content: 'Olá' });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { database.close(); }
  });

  it('deixa o envio passar quando não dá para saber quais sessões existem', async () => {
    const database = sqlite();
    try {
      const id = conversation(database, '00000000-0000-4000-8000-000000000004', dead);
      const { send, service } = inbox(database, new Error('Internal worker is unavailable'));
      await expect(service.send(context, id, 'Olá')).resolves.toMatchObject({ direction: 'outbound' });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { database.close(); }
  });

  // Recusar depois do upload deixaria um job `failed` e um arquivo no storage por
  // até 24h para um envio que a conversa nunca deveria ter permitido.
  it('recusa o anexo antes de gravar a linha de outbox e de subir o arquivo', async () => {
    const database = sqlite();
    try {
      const id = conversation(database, '00000000-0000-4000-8000-000000000005', dead);
      const upload = vi.fn(async () => undefined);
      const service = new AttachmentOutboxService(new SqliteWahaWebhookStore(database.sqlite), new SqliteAttachmentOutboxStore(database.sqlite), { upload, signedUrl: async () => 'http://storage.test/file', remove: async () => undefined }, { send: vi.fn() } as never, activity([{ status: 'connected', wahaName: live }]));
      const file = { buffer: Buffer.from('\xff\xd8\xffqualquer'), originalname: 'foto.jpg', mimetype: 'image/jpeg', size: 12 };
      await expect(service.create(context, id, file, '00000000-0000-4000-8000-0000000000aa')).rejects.toMatchObject({ status: 409, details: { reason: inactiveSessionReason } });
      expect(upload).not.toHaveBeenCalled();
      expect(database.sqlite.prepare('SELECT count(*) total FROM inbox_outbox_jobs WHERE workspaceId=?').get(workspaceId)).toMatchObject({ total: 0 });
    } finally { database.close(); }
  });
});

describe('o painel de SLA e as conversas de sessão anterior', () => {
  /**
   * O acervo antigo entrou por history sync, e `SlaService.message` devolve antes
   * de qualquer escrita quando a mensagem é histórica. É esse retorno que mantém
   * as 531 conversas fora de `conversation_sla_metrics` — e, por consequência,
   * fora de `summary`, que lê exclusivamente essa tabela. Sem ele, o painel
   * ganharia centenas de linhas de uma vez.
   */
  it('não abre relógio de SLA para o acervo sincronizado de uma sessão antiga', async () => {
    const database = sqlite();
    try {
      const realtime = new RealtimeHub();
      const sla = new SlaService(new SqliteSlaStore(database.sqlite), realtime);
      const store = new SqliteWahaWebhookStore(database.sqlite, undefined, [], new SlaMessageCoordinator(sla, { warn: () => undefined }));
      await store.ingest(historyRecord(workspaceId, dead, { id: 'historica-1', chatId: '5511999990001@c.us', body: 'Mensagem antiga', timestamp: 1_721_000_000, fromMe: false })!);
      expect(database.sqlite.prepare('SELECT count(*) total FROM conversation_sla_metrics WHERE workspaceId=?').get(workspaceId)).toMatchObject({ total: 0 });
      expect((await sla.summary(workspaceId)).totals).toMatchObject({ active: 0, waitingOperator: 0, overdue: 0 });
    } finally { database.close(); }
  });

  it('continua abrindo relógio para a mensagem que chega pela sessão viva', async () => {
    const database = sqlite();
    try {
      const sla = new SlaService(new SqliteSlaStore(database.sqlite), new RealtimeHub());
      const store = new SqliteWahaWebhookStore(database.sqlite, undefined, [], new SlaMessageCoordinator(sla, { warn: () => undefined }));
      await store.ingest(webhookRecord({ id: 'evt-viva', timestamp: Date.now(), event: 'message', session: live, payload: { id: 'msg-viva', chatId: '5511999990002@c.us', body: 'Oi', timestamp: Math.floor(Date.now() / 1000), fromMe: false } }, workspaceId));
      expect((await sla.summary(workspaceId)).totals).toMatchObject({ active: 1, waitingOperator: 1 });
    } finally { database.close(); }
  });
});
