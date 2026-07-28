import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { createSqliteDomainRepository } from '../src/persistence/sqlite-domain.repository.js';
import { SqliteWahaWebhookStore, type ConversationStore, type ConversationSummary } from '../src/services/waha-webhook.service.js';
import { InboxContactService } from '../src/services/inbox-contact.service.js';
import type { DomainRepository } from '../src/persistence/domain.repository.js';

const dirs: string[] = [];
const create = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatpro-inbox-contact-'));
  dirs.push(dir);
  const db = new SqlitePersistenceDatabase(join(dir, 'db.sqlite'), join(process.cwd(), 'migrations'));
  db.migrate();
  const store = new SqliteWahaWebhookStore(db.sqlite);
  return { db, store, service: new InboxContactService(store, createSqliteDomainRepository(db.sqlite)) };
};
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

const stamp = '2026-07-27T12:00:00.000Z';
const conversation = (db: SqlitePersistenceDatabase, id: string, chatId: string, type: 'direct' | 'group' = 'direct', contactId: string | null = null) =>
  db.sqlite.prepare('INSERT INTO conversations (id,workspaceId,wahaSession,chatId,canonicalChatId,contactId,conversationType,status,lastMessage,lastMessageAt,unreadCount,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'workspace-a', 'session-a', chatId, chatId, contactId, type, 'open', 'Oi', stamp, 0, stamp, stamp);

const ids = { direct: '40000000-0000-4000-8000-000000000001', group: '40000000-0000-4000-8000-000000000002', linked: '40000000-0000-4000-8000-000000000003', lid: '40000000-0000-4000-8000-000000000004' };

describe('InboxContactService', () => {
  it('creates the contact and links it to the open conversation right away', async () => {
    const { db, store, service } = create();
    try {
      conversation(db, ids.direct, '5511999990001@c.us');
      expect((await store.getConversation('workspace-a', ids.direct))?.contactId).toBeNull();

      const result = await service.create('workspace-a', ids.direct, { displayName: 'Ada Lovelace', company: 'ChatPro' });

      const contact = result.contact as { id: string; phoneNumber: string; displayName: string; company: string | null };
      expect(contact).toMatchObject({ displayName: 'Ada Lovelace', phoneNumber: '5511999990001', company: 'ChatPro' });
      // The link is what the webhook would otherwise only do on the next message.
      expect(result.conversation.contactId).toBe(contact.id);
      expect((await store.getConversation('workspace-a', ids.direct))?.contactId).toBe(contact.id);
      expect((await store.getConversation('workspace-a', ids.direct))?.identity.knownContact).toBe(true);
    } finally { db.close(); }
  });

  it('takes the phone from the conversation and lets the caller supply one when there is none', async () => {
    const { db, service } = create();
    try {
      // A LID's digits parse as a plausible phone; the contact must not inherit it.
      conversation(db, ids.lid, '100000000000001@lid');
      await expect(service.create('workspace-a', ids.lid, { displayName: 'Sem telefone' })).rejects.toMatchObject({ status: 400 });
      const result = await service.create('workspace-a', ids.lid, { displayName: 'Com telefone', phoneNumber: '+55 (11) 98888-0003' });
      expect(result.contact).toMatchObject({ phoneNumber: '5511988880003' });
      expect(result.conversation.contactId).toBe((result.contact as { id: string }).id);
    } finally { db.close(); }
  });

  it('refuses conversations that are missing, are groups, or already have a contact', async () => {
    const { db, service } = create();
    try {
      conversation(db, ids.group, '120363000000000001@g.us', 'group');
      const existing = await service.create('workspace-a', ids.direct, { displayName: 'Ada' }).catch(() => undefined);
      expect(existing).toBeUndefined();
      await expect(service.create('workspace-a', ids.direct, { displayName: 'Ada' })).rejects.toMatchObject({ status: 404 });
      await expect(service.create('workspace-a', ids.group, { displayName: 'Grupo' })).rejects.toMatchObject({ status: 400 });

      conversation(db, ids.linked, '5511999990009@c.us');
      const created = await service.create('workspace-a', ids.linked, { displayName: 'Grace' });
      await expect(service.create('workspace-a', ids.linked, { displayName: 'Outra' })).rejects.toMatchObject({ status: 409 });
      expect((created.contact as { id: string }).id).toBeTruthy();
    } finally { db.close(); }
  });

  it('keeps the conversation of another workspace untouched', async () => {
    const { db, store, service } = create();
    try {
      conversation(db, ids.direct, '5511999990001@c.us');
      await expect(service.create('workspace-b', ids.direct, { displayName: 'Ada' })).rejects.toMatchObject({ status: 404 });
      expect((await store.getConversation('workspace-a', ids.direct))?.contactId).toBeNull();
    } finally { db.close(); }
  });

  // Provider-agnostic: the service drives whatever ConversationStore it is given,
  // so the Supabase store follows the same sequence.
  it('links through the store contract and never leaves the contact behind on failure', async () => {
    const summary = { id: ids.direct, chatId: '5511999990001@c.us', contactId: null, conversationType: 'direct', identity: { phone: '5511999990001' } } as unknown as ConversationSummary;
    const store = { getConversation: vi.fn().mockResolvedValue(summary), linkContact: vi.fn().mockResolvedValue(undefined) } as unknown as ConversationStore;
    const domain = { createContact: vi.fn().mockResolvedValue({ id: 'contact-1' }) } as unknown as DomainRepository;
    const service = new InboxContactService(store, domain);
    await expect(service.create('workspace-a', ids.direct, { displayName: 'Ada' })).rejects.toMatchObject({ status: 404 });
    expect(domain.createContact).toHaveBeenCalledWith('workspace-a', { displayName: 'Ada', phoneNumber: '5511999990001', email: null, company: null });
    expect(store.linkContact).toHaveBeenCalledWith('workspace-a', ids.direct, 'contact-1');
  });

  it('rejects unknown fields instead of forwarding them to the contact', async () => {
    const { db, service } = create();
    try {
      conversation(db, ids.direct, '5511999990001@c.us');
      await expect(service.create('workspace-a', ids.direct, { displayName: 'Ada', tagIds: ['whatever'] })).rejects.toThrow();
      await expect(service.create('workspace-a', ids.direct, { displayName: '' })).rejects.toThrow();
    } finally { db.close(); }
  });
});
