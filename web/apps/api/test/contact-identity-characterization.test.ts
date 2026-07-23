import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { SqliteContactIdentityResolver, SupabaseContactIdentityResolver } from '../src/services/contact-identity-resolver.service.js';

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
});
