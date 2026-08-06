import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteWahaWebhookStore } from '../src/services/waha-webhook.service.js';
import { CallLogService } from '../src/services/call-log.service.js';

const databases: SqlitePersistenceDatabase[] = [];
const directories: string[] = [];

const harness = () => {
  const directory = mkdtempSync(join(tmpdir(), 'call-log-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), join(process.cwd(), 'migrations'));
  database.migrate();
  databases.push(database);
  const store = new SqliteWahaWebhookStore(database.sqlite);
  return { database, store, log: new CallLogService(store) };
};

const seedConversation = async (store: SqliteWahaWebhookStore, chatId = '558585263532@c.us') => {
  await store.ingest({
    workspaceId: 'workspace-a', wahaSession: 'waha-a', externalEventId: `evt-${chatId}`, eventType: 'message',
    occurredAt: '2026-08-06T12:00:00.000Z', receivedAt: '2026-08-06T12:00:00.000Z',
    payload: { id: `msg-${chatId}`, from: chatId, body: 'Oi', type: 'text', fromMe: false },
  });
};

afterEach(() => { for (const db of databases.splice(0)) db.sqlite.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('CallLogService', () => {
  it('grava a chamada como mensagem call na conversa, com prévia "Ligação de voz"', async () => {
    const { store, log } = harness();
    await seedConversation(store);

    await log.record({ workspaceId: 'workspace-a', callId: 'CALL1', direction: 'outbound', peer: '558585263532@s.whatsapp.net', connected: true, startedAt: Date.parse('2026-08-06T12:00:35.000Z'), endedAt: Date.parse('2026-08-06T12:02:10.000Z') });

    const message = store['database'].prepare("SELECT messageType, direction, chatId FROM whatsapp_messages WHERE externalMessageId = 'call:CALL1'").get() as { messageType: string; direction: string; chatId: string };
    expect(message).toMatchObject({ messageType: 'call', direction: 'outbound', chatId: '558585263532@c.us' });
    const conversation = store['database'].prepare("SELECT lastMessage FROM conversations WHERE chatId = '558585263532@c.us'").get() as { lastMessage: string };
    expect(conversation.lastMessage).toBe('Ligação de voz');
  });

  it('casa o peer @lid com a conversa pelo chatId @lid', async () => {
    const { store, log } = harness();
    await seedConversation(store, '153073372647624@lid');

    await log.record({ workspaceId: 'workspace-a', callId: 'CALL2', direction: 'inbound', peer: '153073372647624@lid', connected: false, startedAt: 1_000, endedAt: 2_000 });

    const message = store['database'].prepare("SELECT direction, payloadJson FROM whatsapp_messages WHERE externalMessageId = 'call:CALL2'").get() as { direction: string; payloadJson: string };
    expect(message.direction).toBe('inbound');
    expect(JSON.parse(message.payloadJson)).toMatchObject({ callOutcome: 'missed', callDurationSeconds: 0 });
  });

  it('sem conversa conhecida não grava nada nem falha', async () => {
    const { store, log } = harness();
    await expect(log.record({ workspaceId: 'workspace-a', callId: 'CALL3', direction: 'outbound', peer: '5511999999999@s.whatsapp.net', connected: true, startedAt: 0, endedAt: 1 })).resolves.toBeUndefined();
    const total = store['database'].prepare('SELECT count(*) AS total FROM whatsapp_messages').get() as { total: number };
    expect(total.total).toBe(0);
  });

  it('é idempotente: o mesmo callId gravado duas vezes gera uma mensagem só', async () => {
    const { store, log } = harness();
    await seedConversation(store);
    const entry = { workspaceId: 'workspace-a', callId: 'CALL4', direction: 'outbound' as const, peer: '558585263532@s.whatsapp.net', connected: true, startedAt: 0, endedAt: 60_000 };
    await log.record(entry);
    await log.record(entry);
    const total = store['database'].prepare("SELECT count(*) AS total FROM whatsapp_messages WHERE externalMessageId = 'call:CALL4'").get() as { total: number };
    expect(total.total).toBe(1);
  });
});
