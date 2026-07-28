import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteWahaWebhookStore } from '../src/services/waha-webhook.service.js';
import { InternalInboxService } from '../src/services/internal-inbox.service.js';
import type { InternalWorkerClient } from '../src/internal-worker-client.js';
import type { ConversationStore } from '../src/services/waha-webhook.service.js';
import type { RealtimeHub } from '../src/realtime.js';

const context = { workspaceId: 'workspace-a', correlationId: 'correlation-a', userId: 'user-a' } as never;
const conversation = { id: 'conversation-a', chatId: '5585999990001@c.us', deliveryChatId: null, whatsappSessionId: 'session-a' };
const accepted = { success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { sentMessage: { id: 'wamid-a', timestamp: '2026-07-28T12:00:00.000Z' } } };

function service(send: ReturnType<typeof vi.fn>, recordOutbound: ReturnType<typeof vi.fn>) {
  const store = { getConversation: vi.fn().mockResolvedValue(conversation), recordOutbound } as unknown as ConversationStore;
  return new InternalInboxService({ send } as unknown as InternalWorkerClient, store, { publish: vi.fn() } as unknown as RealtimeHub);
}
const persisted = (overrides: Record<string, unknown> = {}) => ({ id: 'wamid-a', direction: 'outbound', content: null, timestamp: '2026-07-28T12:00:00.000Z', status: 'sent', messageType: 'location', chatId: conversation.chatId, metadata: {}, persistence: { messageInserted: true, conversationId: 'conversation-a', duplicate: false }, ...overrides });

describe('Inbox location send', () => {
  it('asks the worker for a location content command and stores it without a media column', async () => {
    const send = vi.fn().mockResolvedValue(accepted);
    const recordOutbound = vi.fn().mockResolvedValue(persisted());
    await service(send, recordOutbound).sendLocation(context, 'conversation-a', { latitude: -7.115, longitude: -34.861, title: 'Escritório' });
    expect(send.mock.calls[0][0].command).toEqual({ type: 'message.sendContent', payload: { wahaSession: 'session-a', chatId: conversation.chatId, content: { kind: 'location', latitude: -7.115, longitude: -34.861, title: 'Escritório' } } });
    // messageType free text plus coordinates in the stored payload: the reader
    // already surfaces payload_json as metadata, so no column and no migration.
    expect(recordOutbound.mock.calls[0][0]).toMatchObject({ type: 'location', text: 'Escritório', payload: { location: { latitude: -7.115, longitude: -34.861, title: 'Escritório' } } });
  });

  it('keeps a location without a title, and never sends a title field the operator did not give', async () => {
    const send = vi.fn().mockResolvedValue(accepted);
    const recordOutbound = vi.fn().mockResolvedValue(persisted());
    await service(send, recordOutbound).sendLocation(context, 'conversation-a', { latitude: 0, longitude: 0 });
    expect(send.mock.calls[0][0].command.payload.content).toEqual({ kind: 'location', latitude: 0, longitude: 0 });
    expect(recordOutbound.mock.calls[0][0].text).toBeNull();
  });

  it('leaves a text send on its own command and type', async () => {
    const send = vi.fn().mockResolvedValue(accepted);
    const recordOutbound = vi.fn().mockResolvedValue(persisted({ messageType: 'text', content: 'Olá' }));
    await service(send, recordOutbound).send(context, 'conversation-a', 'Olá');
    expect(send.mock.calls[0][0].command).toMatchObject({ type: 'message.send', payload: { text: 'Olá' } });
    expect(recordOutbound.mock.calls[0][0]).toMatchObject({ type: 'text', text: 'Olá' });
  });

  it('reports a worker refusal as the operator-facing failure it is', async () => {
    const send = vi.fn().mockResolvedValue({ success: false as const, correlationId: 'c', workspaceId: 'workspace-a', error: { code: 'NOT_IMPLEMENTED', message: 'Sending poll is not implemented yet', details: {} } });
    const recordOutbound = vi.fn();
    await expect(service(send, recordOutbound).sendLocation(context, 'conversation-a', { latitude: 1, longitude: 2 })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(recordOutbound).not.toHaveBeenCalled();
  });
});

describe('Inbox location persistence (SQLite, the shape both providers share)', () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

  it('stores a location as its own message type with the coordinates in the payload', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chatpro-location-'));
    directories.push(directory);
    const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), join(process.cwd(), 'migrations'));
    database.migrate();
    try {
      const store = new SqliteWahaWebhookStore(database.sqlite);
      const stored = await store.recordOutbound({ workspaceId: 'workspace-a', wahaSession: 'session-a', chatId: '5585999990001@c.us', externalMessageId: 'wamid-a', text: 'Escritório', occurredAt: '2026-07-28T12:00:00.000Z', type: 'location', payload: { location: { latitude: -7.115, longitude: -34.861, title: 'Escritório' } } });
      expect(stored.messageType).toBe('location');
      const row = database.sqlite.prepare('SELECT messageType, payloadJson FROM whatsapp_messages WHERE externalMessageId=?').get('wamid-a') as { messageType: string; payloadJson: string };
      // No column was added: the coordinates ride in the payload the reader
      // already exposes as `metadata`, and messageType has no CHECK to fight.
      expect(row.messageType).toBe('location');
      expect(JSON.parse(row.payloadJson).location).toEqual({ latitude: -7.115, longitude: -34.861, title: 'Escritório' });
    } finally { database.close(); }
  });
});
