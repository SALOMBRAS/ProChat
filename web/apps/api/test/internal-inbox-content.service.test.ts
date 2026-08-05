import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteWahaWebhookStore } from '../src/services/waha-webhook.service.js';
import { InternalInboxService } from '../src/services/internal-inbox.service.js';
import type { InternalWorkerClient } from '../src/internal-worker-client.js';
import type { ConversationStore, ReactionStore } from '../src/services/waha-webhook.service.js';
import type { RealtimeHub } from '../src/realtime.js';

const context = { workspaceId: 'workspace-a', correlationId: 'correlation-a', userId: 'user-a' } as never;
const conversation = { id: 'conversation-a', chatId: '5585999990001@c.us', deliveryChatId: null, whatsappSessionId: 'session-a' };
const accepted = { success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { sentMessage: { id: 'wamid-a', timestamp: '2026-07-28T12:00:00.000Z' } } };

function service(send: ReturnType<typeof vi.fn>, recordOutbound: ReturnType<typeof vi.fn>) {
  const store = { getConversation: vi.fn().mockResolvedValue(conversation), recordOutbound } as unknown as ConversationStore & ReactionStore;
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

  it('travels linkPreview:false only when the operator dismissed the composer card', async () => {
    const send = vi.fn().mockResolvedValue(accepted);
    const recordOutbound = vi.fn().mockResolvedValue(persisted({ messageType: 'text', content: 'Olá' }));
    await service(send, recordOutbound).send(context, 'conversation-a', 'veja https://example.com/a', undefined, false);
    expect(send.mock.calls[0][0].command.payload).toMatchObject({ text: 'veja https://example.com/a', linkPreview: false });
    await service(send, recordOutbound).send(context, 'conversation-a', 'veja https://example.com/b');
    expect(send.mock.calls[1][0].command.payload.linkPreview).toBeUndefined();
  });

  it('asks the worker for a vcard content command and stores it as a contact', async () => {
    const send = vi.fn().mockResolvedValue(accepted);
    const recordOutbound = vi.fn().mockResolvedValue(persisted({ messageType: 'contact' }));
    const cards = [{ fullName: 'Ada Lovelace', phoneNumber: '+55 85 92369359', organization: 'ChatPro' }];
    await service(send, recordOutbound).sendVcard(context, 'conversation-a', cards);
    expect(send.mock.calls[0][0].command).toEqual({ type: 'message.sendContent', payload: { wahaSession: 'session-a', chatId: conversation.chatId, content: { kind: 'vcard', contacts: cards } } });
    // `contact` and not `vcard`: the preview of the conversation already spoke
    // that word before this existed.
    expect(recordOutbound.mock.calls[0][0]).toMatchObject({ type: 'contact', text: 'Ada Lovelace', payload: { contacts: cards } });
  });

  it('summarises more than one contact in the body and sends the whole list', async () => {
    const send = vi.fn().mockResolvedValue(accepted);
    const recordOutbound = vi.fn().mockResolvedValue(persisted({ messageType: 'contact' }));
    const cards = [{ fullName: 'Ada Lovelace', phoneNumber: '+55 85 92369359' }, { fullName: 'Grace Hopper', phoneNumber: '+55 85 90000001' }, { fullName: 'Alan Turing', phoneNumber: '+55 85 90000002' }];
    await service(send, recordOutbound).sendVcard(context, 'conversation-a', cards);
    expect(send.mock.calls[0][0].command.payload.content.contacts).toEqual(cards);
    expect(recordOutbound.mock.calls[0][0].text).toBe('Ada Lovelace e mais 2');
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

  it('stores a contact card the same way, and returns what it stored', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chatpro-vcard-'));
    directories.push(directory);
    const database = new SqlitePersistenceDatabase(join(directory, 'db.sqlite'), join(process.cwd(), 'migrations'));
    database.migrate();
    try {
      const store = new SqliteWahaWebhookStore(database.sqlite);
      const contacts = [{ fullName: 'Ada Lovelace', phoneNumber: '+55 85 92369359', organization: 'ChatPro' }];
      const stored = await store.recordOutbound({ workspaceId: 'workspace-a', wahaSession: 'session-a', chatId: '5585999990001@c.us', externalMessageId: 'wamid-b', text: 'Ada Lovelace', occurredAt: '2026-07-28T12:00:00.000Z', type: 'contact', payload: { contacts } });
      const row = database.sqlite.prepare('SELECT messageType, payloadJson FROM whatsapp_messages WHERE externalMessageId=?').get('wamid-b') as { messageType: string; payloadJson: string };
      // Both halves, because the returned value used to be hardcoded to text
      // while the row was already correct.
      expect(row.messageType).toBe('contact');
      expect(JSON.parse(row.payloadJson).contacts).toEqual(contacts);
      expect(stored.messageType).toBe('contact');
      expect(stored.metadata).toEqual({ contacts });
    } finally { database.close(); }
  });
});

/** A prévia nativa que o WhatsApp gerou no envio volta do worker e vira payload
 *  da mensagem — é o que o dashboard lê para desenhar o cartão sem chamar a
 *  retaguarda OG. */
describe('Inbox text send link preview', () => {
  it('grava a prévia no payload quando o worker a devolve', async () => {
    const linkPreview = { url: 'https://example.com/materia', domain: 'example.com', title: 'Matéria', provider: 'generic' };
    const send = vi.fn().mockResolvedValue({ success: true as const, correlationId: 'c', workspaceId: 'workspace-a', data: { sentMessage: { id: 'wamid-a', timestamp: '2026-07-28T12:00:00.000Z', linkPreview } } });
    const recordOutbound = vi.fn().mockResolvedValue(persisted({ messageType: 'text', content: 'Veja https://example.com/materia', metadata: { linkPreview } }));
    await service(send, recordOutbound).send(context, 'conversation-a', 'Veja https://example.com/materia');
    expect(recordOutbound.mock.calls[0][0]).toMatchObject({ type: 'text', payload: { linkPreview } });
  });

  it('não grava payload num texto sem prévia', async () => {
    const send = vi.fn().mockResolvedValue(accepted);
    const recordOutbound = vi.fn().mockResolvedValue(persisted({ messageType: 'text', content: 'Olá' }));
    await service(send, recordOutbound).send(context, 'conversation-a', 'Olá');
    expect(recordOutbound.mock.calls[0][0].payload).toBeUndefined();
  });
});
