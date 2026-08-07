import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteContactIdentityResolver, SqliteContactNameRepair, SupabaseContactIdentityResolver, isTechnicalDisplayName } from '../src/services/contact-identity-resolver.service.js';

const databases: SqlitePersistenceDatabase[] = [];
const directories: string[] = [];
const sqlite = () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-contact-identity-'));
  directories.push(directory);
  const database = new SqlitePersistenceDatabase(join(directory, 'api.sqlite'));
  database.migrate();
  databases.push(database);
  return database.sqlite;
};
afterEach(() => { databases.splice(0).forEach(database => database.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

describe('contact identity characterization baseline', () => {
  it('keeps the same phone and aliases isolated by workspace', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database);
    const first = await resolver.resolve({ workspaceId: 'workspace-a', identifier: '5511999990000@c.us', source: 'characterization' });
    const second = await resolver.resolve({ workspaceId: 'workspace-b', identifier: '5511999990000@c.us', source: 'characterization' });
    expect(first?.id).not.toBe(second?.id);
    expect(database.prepare('SELECT workspaceId, identifier FROM contact_identifiers ORDER BY workspaceId').all()).toEqual([
      { workspaceId: 'workspace-a', identifier: '5511999990000' }, { workspaceId: 'workspace-a', identifier: '5511999990000@c.us' },
      { workspaceId: 'workspace-b', identifier: '5511999990000' }, { workspaceId: 'workspace-b', identifier: '5511999990000@c.us' }
    ]);
  });

  it('does not allow an orphan alias when SQLite foreign keys are enabled', () => {
    const database = sqlite();
    expect(() => database.prepare('INSERT INTO contact_identifiers (id, workspaceId, contactId, identifier, type, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run('orphan', 'workspace-a', 'missing-contact', '123@lid', 'lid', 'characterization', new Date().toISOString())).toThrow(/FOREIGN KEY constraint failed/);
    expect(database.prepare('SELECT count(*) AS total FROM contact_identifiers').get()).toEqual({ total: 0 });
  });

  it('uses one Supabase RPC so contacts and aliases commit together without 23503', async () => {
    const calls: string[] = [];
    const client = { rpc(name: string, args: Record<string, unknown>) { calls.push(name); expect(args.p_identifiers).toEqual([{ identifier: '5511999990000@c.us', type: 'whatsapp' }, { identifier: '5511999990000', type: 'phone' }]); return Promise.resolve({ data: { contact_id: 'contact-supabase', phone_number: '5511999990000', resolution_source: 'created', created_contact: true, attached_identifiers: ['5511999990000@c.us', '5511999990000'] }, error: null }); } };
    const resolver = new SupabaseContactIdentityResolver(client as any);
    await expect(resolver.resolve({ workspaceId: 'workspace-a', identifier: '5511999990000@c.us', source: 'characterization' })).resolves.toEqual({ id: 'contact-supabase', phoneNumber: '5511999990000' });
    expect(calls).toEqual(['chatpro_resolve_contact_identity']);
  });

  it('normalizes @s.whatsapp.net, number, and @c.us into one SQLite contact', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database);
    const first = await resolver.resolve({ workspaceId: 'workspace-a', identifier: '5511999990000:12@s.whatsapp.net', source: 'test' });
    const second = await resolver.resolve({ workspaceId: 'workspace-a', identifier: '5511999990000@c.us', source: 'test' });
    expect(first?.id).toBe(second?.id);
    expect(database.prepare('SELECT identifier FROM contact_identifiers ORDER BY identifier').all()).toEqual([{ identifier: '5511999990000' }, { identifier: '5511999990000@c.us' }]);
  });

  it('keeps LID without a phone pending and resolves it with its later phone alias', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database);
    await expect(resolver.resolve({ workspaceId: 'workspace-a', identifier: 'opaque@lid', source: 'test' })).resolves.toBeUndefined();
    const resolved = await resolver.resolve({ workspaceId: 'workspace-a', identifier: 'opaque@lid', aliases: ['5511999990000@c.us'], source: 'test' });
    expect(resolved?.phoneNumber).toBe('5511999990000');
    expect(database.prepare('SELECT count(*) total FROM pending_contact_identities').get()).toEqual({ total: 0 });
  });

  it('never creates contacts or pending aliases for a group participant', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database);
    const result = await resolver.resolveDetailed({ workspaceId: 'workspace-a', chatId: '120363000000@g.us', identifier: 'opaque@lid', phone: '5511999990000', isGroup: true, isParticipant: true, source: 'group_participant' });
    expect(result).toMatchObject({ resolutionSource: 'group', createdContact: false });
    expect(result.contactId).toBeUndefined();
    expect(database.prepare('SELECT count(*) total FROM contacts').get()).toEqual({ total: 0 });
    expect(database.prepare('SELECT count(*) total FROM pending_contact_identities').get()).toEqual({ total: 0 });
  });
});

describe('technical display name repair', () => {
  it('calls technical only what no person would choose as a name', () => {
    // O rótulo dos contatos LID: só dígitos e pontuação de telefone. Nome real
    // sempre tem algum caractere fora desse conjunto — em qualquer alfabeto.
    for (const value of [undefined, null, '', '   ', '200339068317777', '558592369359', '+55 (85) 9236-9359', '55 11 9.9999-0001']) {
      expect(isTechnicalDisplayName(value)).toBe(true);
    }
    for (const value of ['Ana Ribeiro', 'Pizzaria Jana', 'Lucia Mãe', '铃木', 'خالد', "D'Avila"]) {
      expect(isTechnicalDisplayName(value)).toBe(false);
    }
  });

  it('replaces a technical label and never touches a name a person chose', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database); const repair = new SqliteContactNameRepair(database);
    // Contato "fantasma": criado pelo webhook sem nome, rotulado com o telefone.
    const ghost = await resolver.resolve({ workspaceId: 'workspace-a', identifier: '5511999990000@c.us', source: 'test' });
    expect(database.prepare('SELECT displayName FROM contacts WHERE id=?').get(ghost!.id)).toEqual({ displayName: '5511999990000' });
    await repair.repairIfTechnical('workspace-a', ghost!.id, 'Ana Ribeiro');
    expect(database.prepare('SELECT displayName FROM contacts WHERE id=?').get(ghost!.id)).toEqual({ displayName: 'Ana Ribeiro' });
    // Com nome de verdade — inclusive o que o operador digitou no CRM — o
    // reparo não toca, mesmo quando a agenda sugere outro nome.
    await repair.repairIfTechnical('workspace-a', ghost!.id, 'Outro Nome');
    expect(database.prepare('SELECT displayName FROM contacts WHERE id=?').get(ghost!.id)).toEqual({ displayName: 'Ana Ribeiro' });
  });

  it('scopes the repair to the workspace, like every contact write', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database); const repair = new SqliteContactNameRepair(database);
    const own = await resolver.resolve({ workspaceId: 'workspace-a', identifier: '5511999990000@c.us', source: 'test' });
    await repair.repairIfTechnical('workspace-b', own!.id, 'Invasor');
    expect(database.prepare('SELECT displayName FROM contacts WHERE id=?').get(own!.id)).toEqual({ displayName: '5511999990000' });
  });
});

/* Um "telefone" igual aos dígitos do próprio @lid não é telefone — é o LID que
 * o provedor devolveu no campo de número. Aceitá-lo criava um contato gêmeo
 * com o LID como phoneNumber e um chat separado na inbox (cura-lids v3). */
describe('contact identity LID phone guard', () => {
  it('ignores a phone that is the lid digits and parks the identity as pending instead of creating a contact', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database);
    const result = await resolver.resolveDetailed({ workspaceId: 'workspace-a', identifier: '274319762546912@lid', phone: '274319762546912', displayName: 'Luan', source: 'test' });
    expect(result.contactId).toBeUndefined();
    expect(result.resolutionSource).toBe('pending');
    expect(database.prepare('SELECT count(*) AS total FROM contacts').get()).toEqual({ total: 0 });
    expect(database.prepare('SELECT identifier, type FROM pending_contact_identities').all()).toEqual([{ identifier: '274319762546912@lid', type: 'lid' }]);
  });

  it('still accepts a real phone that differs from the lid digits', async () => {
    const database = sqlite(); const resolver = new SqliteContactIdentityResolver(database);
    const result = await resolver.resolveDetailed({ workspaceId: 'workspace-a', identifier: '274319762546912@lid', phone: '558599518906', displayName: 'Luan', source: 'test' });
    expect(result.contactId).toBeDefined();
    expect(result.canonicalPhone).toBe('558599518906');
  });

  it('passes a null phone to the Supabase RPC when the only candidate is the lid digits', async () => {
    let seen: unknown;
    const client = { rpc(_name: string, args: Record<string, unknown>) { seen = args.p_phone_number; return Promise.resolve({ data: { contact_id: null, pending_identifier: '274319762546912@lid', resolution_source: 'pending', created_contact: false, attached_identifiers: [] }, error: null }); } };
    const resolver = new SupabaseContactIdentityResolver(client as any);
    await resolver.resolveDetailed({ workspaceId: 'workspace-a', identifier: '274319762546912@lid', phone: '274319762546912', source: 'test' });
    expect(seen).toBeNull();
  });
});
