import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { RealtimeHub } from '../src/realtime.js';
import { InternalInboxService } from '../src/services/internal-inbox.service.js';
import { SlaMessageCoordinator } from '../src/services/sla-message-coordinator.service.js';
import { SlaService, SqliteSlaStore } from '../src/services/sla.service.js';
import { SqliteWahaWebhookStore, webhookRecord } from '../src/services/waha-webhook.service.js';

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

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('operational SLA lifecycle', () => {
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
