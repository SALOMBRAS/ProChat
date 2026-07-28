import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { ConversationManagementService } from '../src/services/conversation-management.service.js';
import { InternalInboxService } from '../src/services/internal-inbox.service.js';
import { KanbanService } from '../src/services/kanban.service.js';
import { SlaMessageCoordinator } from '../src/services/sla-message-coordinator.service.js';
import { criticalSampleLimit, projectSlaCard, SlaService, SqliteSlaStore } from '../src/services/sla.service.js';
import { historyRecord, SqliteWahaWebhookStore, webhookRecord } from '../src/services/waha-webhook.service.js';

const directories: string[] = [];
const migrations = join(process.cwd(), 'migrations');
const workspaceId = 'workspace-a';
const conversationId = '00000000-0000-4000-8000-000000000010';
const inboundAt = '2026-07-23T10:00:00.000Z';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-sla-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), migrations);
  database.migrate();
  const realtime = new RealtimeHub();
  const service = new SlaService(new SqliteSlaStore(database.sqlite), realtime);
  return { database, realtime, service };
}

function conversation(database: SqlitePersistenceDatabase) {
  database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(conversationId, workspaceId, 'waha-a', '5511999990000@c.us', null, 'open', 'Olá', inboundAt, 0, inboundAt, inboundAt);
}

const actor = { workspaceId, userId: '00000000-0000-4000-8000-000000000001', correlationId: 'sla-status' } as any;

// A Inbox muda o status pelo ConversationManagementService; o Kanban, pelo
// KanbanService. Os dois testes abaixo usam o serviço real de cada alavanca com o
// mesmo SlaService, que é a única forma de provar que elas não divergem.
const inboxLever = (database: SqlitePersistenceDatabase, realtime: RealtimeHub, service: SlaService) =>
  new ConversationManagementService(new SqliteWahaWebhookStore(database.sqlite), realtime, {} as any, service);

const slaRow = (database: SqlitePersistenceDatabase) =>
  database.sqlite.prepare('SELECT slaStatus,frozenAt,resolvedAt,archivedAt,waitingSinceAt,operatorWaitingMs,customerWaitingMs FROM conversation_sla_metrics').get() as Record<string, string | number | null>;

afterEach(() => { vi.useRealTimers(); directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe('operational SLA lifecycle', () => {
  it('projects card severity and deadline independently from the SLA cycle status', () => {
    const config = { firstResponseThresholdMs: 300_000, operatorWaitingThresholdMs: 900_000, customerWaitingThresholdMs: 86_400_000, warningRatio: .8 };
    expect(projectSlaCard({ slaStatus: 'waiting_operator', waitingSinceAt: inboundAt, firstResponseAt: null, frozenAt: null }, config, '2026-07-23T10:04:00.000Z')).toEqual({ status: 'waiting_operator', indicator: 'yellow', deadlineAt: '2026-07-23T10:05:00.000Z' });
    expect(projectSlaCard({ slaStatus: 'waiting_customer', waitingSinceAt: inboundAt, firstResponseAt: inboundAt, frozenAt: null }, config, '2026-07-24T10:01:00.000Z')).toMatchObject({ status: 'waiting_customer', indicator: 'red', deadlineAt: '2026-07-24T10:00:00.000Z' });
    expect(projectSlaCard({ slaStatus: 'resolved', waitingSinceAt: null, firstResponseAt: inboundAt, frozenAt: inboundAt }, config)).toEqual({ status: 'resolved', indicator: 'neutral', deadlineAt: null });
  });
  it('returns critical SLA identities in one workspace-scoped projection', async () => {
    const { database, service } = setup();
    try {
      conversation(database);
      const now = inboundAt;
      database.sqlite.prepare('INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run('contact-a', workspaceId, 'Nome ChatPro', '5511999990000', now, now);
      database.sqlite.prepare('UPDATE conversations SET contactId=? WHERE workspaceId=? AND id=?').run('contact-a', workspaceId, conversationId);
      database.sqlite.prepare('INSERT INTO whatsapp_identities (id,workspaceId,wahaSession,whatsappId,phone,name,pushName,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)').run('identity-a', workspaceId, 'waha-a', '5511999990000@c.us', '5511999990000', 'Nome WhatsApp', 'Apelido WhatsApp', now, now);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      const summary = await service.summary(workspaceId);
      expect(summary.critical).toContainEqual(expect.objectContaining({ conversationId, displayName: 'Nome WhatsApp', phoneNumber: '5511999990000' }));
    } finally { database.close(); }
  });
  it('starts operator waiting after a persisted inbound message', async () => {
    const { database, service } = setup();
    try {
      const store = new SqliteWahaWebhookStore(database.sqlite, undefined, [], new SlaMessageCoordinator(service));
      await store.ingest(webhookRecord({ id: 'inbound-event', timestamp: Date.parse(inboundAt), event: 'message', session: 'waha-a', payload: { id: 'inbound-message', chatId: '5511999990000@c.us', body: 'Olá' } }, workspaceId));
      expect(database.sqlite.prepare('SELECT slaStatus,firstInboundAt,firstResponseAt,waitingSinceAt FROM conversation_sla_metrics').get()).toEqual({ slaStatus: 'waiting_operator', firstInboundAt: inboundAt, firstResponseAt: null, waitingSinceAt: inboundAt });
    } finally { database.close(); }
  });

  it('records an outbound response and transitions to customer waiting', async () => {
    const { database, service } = setup();
    try {
      const store = new SqliteWahaWebhookStore(database.sqlite, undefined, [], new SlaMessageCoordinator(service));
      await store.ingest(webhookRecord({ id: 'inbound-event', timestamp: Date.parse(inboundAt), event: 'message', session: 'waha-a', payload: { id: 'inbound-message', chatId: '5511999990000@c.us', body: 'Olá' } }, workspaceId));
      const repliedAt = '2026-07-23T10:02:00.000Z';
      await store.recordOutbound({ workspaceId, wahaSession: 'waha-a', chatId: '5511999990000@c.us', externalMessageId: 'outbound-message', text: 'Resposta', occurredAt: repliedAt });
      expect(database.sqlite.prepare('SELECT slaStatus,firstResponseAt,lastOutboundAt,totalResponseMs,responseCount FROM conversation_sla_metrics').get()).toEqual({ slaStatus: 'waiting_customer', firstResponseAt: repliedAt, lastOutboundAt: repliedAt, totalResponseMs: 120000, responseCount: 1 });
    } finally { database.close(); }
  });

  it('keeps the first response when later messages are sent', async () => {
    const { database, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      await service.message(workspaceId, conversationId, 'outbound', '2026-07-23T10:02:00.000Z', false);
      await service.message(workspaceId, conversationId, 'inbound', '2026-07-23T10:04:00.000Z', false);
      await service.message(workspaceId, conversationId, 'outbound', '2026-07-23T10:06:00.000Z', false);
      expect(database.sqlite.prepare('SELECT firstResponseAt,totalResponseMs,responseCount,slaStatus FROM conversation_sla_metrics').get()).toEqual({ firstResponseAt: '2026-07-23T10:02:00.000Z', totalResponseMs: 240000, responseCount: 2, slaStatus: 'waiting_customer' });
    } finally { database.close(); }
  });

  it('freezes metrics when the conversation is resolved', async () => {
    const { database, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      await service.status(workspaceId, conversationId, 'resolved');
      expect(database.sqlite.prepare('SELECT slaStatus,frozenAt,resolvedAt,waitingSinceAt FROM conversation_sla_metrics').get()).toMatchObject({ slaStatus: 'resolved', waitingSinceAt: null });
      const row = database.sqlite.prepare('SELECT frozenAt,resolvedAt FROM conversation_sla_metrics').get() as { frozenAt: string; resolvedAt: string };
      expect(row.frozenAt).toBe(row.resolvedAt);
    } finally { database.close(); }
  });

  it('caps the critical sample without ever understating the population', async () => {
    const { database, service } = setup();
    try {
      const overflow = criticalSampleLimit + 17;
      const past = '2020-01-01T00:00:00.000Z';
      const insert = database.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,contactId,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      database.sqlite.transaction(() => {
        for (let index = 0; index < overflow; index += 1) insert.run(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, workspaceId, 'waha-a', `55119${String(90000000 + index).padStart(8, '0')}@c.us`, null, 'open', 'Olá', past, 0, past, past);
      })();
      for (let index = 0; index < overflow; index += 1) await service.message(workspaceId, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 'inbound', past, false);

      const summary = await service.summary(workspaceId);
      // A amostra é cortada, mas o total continua sendo a população inteira — é o
      // que o badge mostra e o que a linha de truncagem compara.
      expect(summary.critical).toHaveLength(criticalSampleLimit);
      expect(summary.totals.warning + summary.totals.overdue).toBe(overflow);
      expect(summary.totals.active).toBe(overflow);
      // Corte é dos MAIS urgentes: nada verde entra na amostra.
      expect(summary.critical.every((item) => item.indicator !== 'green')).toBe(true);
      // Toda a amostra tem identidade resolvida na mesma consulta em lote.
      expect(summary.critical.every((item) => item.conversationId)).toBe(true);
    } finally { database.close(); }
  }, 30_000);

  it('keeps the critical cap inside the Supabase URL budget', () => {
    // No provider Supabase, `criticalConversationIdentities` vira um filtro
    // `.in('id', [...])` que o PostgREST serializa na URL, a ~45 B por id. Medido:
    // 100 ids -> 4,55 KB; 200 -> 8,94 KB, acima do limite prático de header (~8 KB).
    // Subir o teto além dessa faixa exige paginar o filtro em lotes, não só trocar
    // a constante — por isso o valor é verificado, não só o fato de existir corte.
    const urlBytesPerId = 46;
    expect(criticalSampleLimit * urlBytesPerId).toBeLessThan(6 * 1024);
    // E precisa continuar cobrindo com folga o pior caso real observado (49).
    expect(criticalSampleLimit).toBeGreaterThanOrEqual(98);
  });

  it('returns everything when the population fits under the cap', async () => {
    const { database, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', '2020-01-01T00:00:00.000Z', false);
      const summary = await service.summary(workspaceId);
      expect(summary.critical).toHaveLength(1);
      expect(summary.totals.warning + summary.totals.overdue).toBe(1);
    } finally { database.close(); }
  });

  it('freezes metrics when the Inbox status selector resolves the conversation', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      const inbox = inboxLever(database, realtime, service);
      await inbox.setStatus(actor, conversationId, 'in_progress');
      await inbox.setStatus(actor, conversationId, 'resolved');
      const row = slaRow(database);
      expect(row).toMatchObject({ slaStatus: 'resolved', waitingSinceAt: null, archivedAt: null });
      expect(row.frozenAt).toBe(row.resolvedAt);
    } finally { database.close(); }
  });

  it('freezes metrics when the Inbox archives the conversation', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      await inboxLever(database, realtime, service).setStatus(actor, conversationId, 'archived');
      const row = slaRow(database);
      expect(row).toMatchObject({ slaStatus: 'archived', waitingSinceAt: null, resolvedAt: null });
      expect(row.frozenAt).toBe(row.archivedAt);
    } finally { database.close(); }
  });

  it('relabels a frozen conversation archived without charging the wait twice', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      const inbox = inboxLever(database, realtime, service);
      await inbox.setStatus(actor, conversationId, 'in_progress');
      await inbox.setStatus(actor, conversationId, 'resolved');
      const frozen = slaRow(database);
      await inbox.setStatus(actor, conversationId, 'archived');
      const row = slaRow(database);
      // Já estava parada: só troca o rótulo terminal, sem somar espera de novo.
      expect(row).toMatchObject({ slaStatus: 'archived', resolvedAt: null, waitingSinceAt: null });
      expect(row.operatorWaitingMs).toBe(frozen.operatorWaitingMs);
      expect(row.frozenAt).toBe(frozen.frozenAt);
    } finally { database.close(); }
  });

  it('reopens through the Inbox without charging the team for the frozen period', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      const inbox = inboxLever(database, realtime, service);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-23T10:05:00.000Z'));
      await inbox.setStatus(actor, conversationId, 'in_progress');
      await inbox.setStatus(actor, conversationId, 'resolved');
      // Um dia inteiro parada: nada disso é espera do time.
      vi.setSystemTime(new Date('2026-07-24T10:05:00.000Z'));
      await inbox.setStatus(actor, conversationId, 'in_progress');
      expect(slaRow(database)).toMatchObject({
        slaStatus: 'waiting_operator',
        frozenAt: null,
        resolvedAt: null,
        waitingSinceAt: '2026-07-24T10:05:00.000Z',
        operatorWaitingMs: 300_000,
      });
    } finally { database.close(); }
  });

  it('reopens through the Kanban when the card leaves a terminal stage', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      const kanban = new KanbanService(database.sqlite, realtime, service);
      const [board] = await kanban.boards(workspaceId);
      const stage = (key: string) => board.stages.find((item: { key: string }) => item.key === key)!.id;
      await kanban.move(workspaceId, actor.userId, conversationId, { boardId: board.id, stageId: stage('resolved'), source: 'manual' });
      expect(slaRow(database)).toMatchObject({ slaStatus: 'resolved', waitingSinceAt: null });
      await kanban.move(workspaceId, actor.userId, conversationId, { boardId: board.id, stageId: stage('in_progress'), source: 'manual' });
      expect(slaRow(database)).toMatchObject({ slaStatus: 'waiting_operator', frozenAt: null, resolvedAt: null });
    } finally { database.close(); }
  });

  it('hands a reopened conversation back to the side that actually owes a reply', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      await service.message(workspaceId, conversationId, 'outbound', '2026-07-23T10:02:00.000Z', false);
      const inbox = inboxLever(database, realtime, service);
      await inbox.setStatus(actor, conversationId, 'in_progress');
      await inbox.setStatus(actor, conversationId, 'resolved');
      await inbox.setStatus(actor, conversationId, 'in_progress');
      // A última mensagem foi nossa, então quem deve responder é o cliente e o
      // relógio não pode voltar como atraso do atendente.
      expect(slaRow(database)).toMatchObject({ slaStatus: 'waiting_customer', frozenAt: null });
    } finally { database.close(); }
  });

  it('leaves the message-driven clock alone when an operator only marks waiting_customer', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', inboundAt, false);
      const inbox = inboxLever(database, realtime, service);
      await inbox.setStatus(actor, conversationId, 'in_progress');
      await inbox.setStatus(actor, conversationId, 'waiting_customer');
      // Marcar "aguardando cliente" sem responder não pode parar o relógio da
      // primeira resposta: a espera vira do cliente quando sai uma mensagem, não
      // quando alguém troca um seletor.
      expect(slaRow(database)).toMatchObject({ slaStatus: 'waiting_operator', frozenAt: null, waitingSinceAt: inboundAt });
    } finally { database.close(); }
  });

  it('keeps a conversation without SLA metrics out of the freeze path', async () => {
    const { database, realtime, service } = setup();
    try {
      conversation(database);
      // Nenhuma mensagem entrou, então não há linha de métrica para congelar.
      await inboxLever(database, realtime, service).setStatus(actor, conversationId, 'archived');
      expect(database.sqlite.prepare('SELECT count(*) total FROM conversation_sla_metrics').get()).toEqual({ total: 0 });
    } finally { database.close(); }
  });

  it('expires an operator wait that passed its threshold', async () => {
    const { database, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', '2020-01-01T00:00:00.000Z', false);
      await service.tick();
      expect(database.sqlite.prepare('SELECT slaStatus FROM conversation_sla_metrics').get()).toEqual({ slaStatus: 'expired' });
    } finally { database.close(); }
  });

  it('never expires an answered conversation waiting on the customer', async () => {
    const { database, service } = setup();
    try {
      conversation(database);
      await service.message(workspaceId, conversationId, 'inbound', '2020-01-01T00:00:00.000Z', false);
      await service.message(workspaceId, conversationId, 'outbound', '2020-01-01T00:01:00.000Z', false);
      await service.tick();
      // The customer has been silent for years, far past customerWaitingThresholdMs.
      expect(database.sqlite.prepare('SELECT slaStatus FROM conversation_sla_metrics').get()).toEqual({ slaStatus: 'waiting_customer' });
      const summary = await service.summary(workspaceId);
      // The silence belongs to the customer: it must not be reported as the
      // operator being late, nor inflate the operator waiting average.
      expect(summary.totals).toMatchObject({ active: 1, waitingOperator: 0, waitingCustomer: 1 });
      expect(summary.averages.operatorWaitSeconds).toBeNull();
      expect(summary.averages.customerWaitSeconds).toBeGreaterThan(0);
    } finally { database.close(); }
  });

  it('ignores messages replayed by the history sync so imports cannot start an SLA clock', async () => {
    const { database, service } = setup();
    try {
      const store = new SqliteWahaWebhookStore(database.sqlite, undefined, [], new SlaMessageCoordinator(service));
      // historyRecord is what the history sync feeds into ingest for every
      // imported message; its payload carries the `_history` marker.
      await store.ingest(historyRecord(workspaceId, 'waha-a', { id: 'imported-message', chatId: '5511999990000@c.us', body: 'Mensagem antiga', timestamp: Date.parse(inboundAt) / 1000 }, '5511999990000@c.us')!);
      expect(database.sqlite.prepare('SELECT count(*) total FROM whatsapp_messages').get()).toEqual({ total: 1 });
      expect(database.sqlite.prepare('SELECT count(*) total FROM conversation_sla_metrics').get()).toEqual({ total: 0 });
    } finally { database.close(); }
  });

  it('isolates an SLA failure so outbound persistence and Inbox realtime still complete', async () => {
    const warn = vi.fn();
    const coordinator = new SlaMessageCoordinator({ message: async () => { throw new Error('metrics unavailable'); } }, { warn });
    const realtime = { publish: vi.fn() } as any;
    const conversations = {
      getConversation: vi.fn().mockResolvedValue({ id: conversationId, workspaceId, whatsappSessionId: 'waha-a', chatId: '5511999990000@c.us' }),
      recordOutbound: vi.fn().mockResolvedValue({ id: 'outbound-message', direction: 'outbound', content: 'Resposta', timestamp: '2026-07-23T10:02:00.000Z', status: 'sent', messageType: 'text', chatId: '5511999990000@c.us', metadata: {}, persistence: { duplicate: false, messageInserted: true, conversationId } }),
    } as any;
    const worker = { send: vi.fn().mockResolvedValue({ success: true, data: { sentMessage: { id: 'outbound-message', timestamp: '2026-07-23T10:02:00.000Z' } } }) } as any;
    const inbox = new InternalInboxService(worker, conversations, realtime, undefined, coordinator);
    const message = await inbox.send({ workspaceId, userId: '00000000-0000-4000-8000-000000000001', correlationId: 'sla-isolation' } as any, conversationId, 'Resposta');
    expect(message.id).toBe('outbound-message');
    expect(conversations.recordOutbound).toHaveBeenCalledOnce();
    expect(realtime.publish).toHaveBeenCalledWith(workspaceId, 'message.sent', expect.anything());
    expect(realtime.publish).toHaveBeenCalledWith(workspaceId, 'conversation.updated', expect.anything());
    expect(warn).toHaveBeenCalledOnce();
  });
});
