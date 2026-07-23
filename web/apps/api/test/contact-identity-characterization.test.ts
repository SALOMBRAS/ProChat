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

  it('persists a Supabase contact before aliases, avoiding the observed 23503 foreign-key failure', async () => {
    const calls: string[] = []; let contactInserted = false;
    const client = {
      from(table: string) {
        const query: any = {
          select() { return query; }, eq() { return query; }, in() { return query; }, limit() { return query; },
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: { id: 'contact-supabase', phone_number: '5511999990000' }, error: null }),
          upsert: (_rows: any) => {
            calls.push(`${table}:upsert`);
            if (table === 'contacts') contactInserted = true;
            if (table === 'contact_identifiers' && !contactInserted) return { error: { code: '23503', message: 'foreign key violation' } };
            if (table === 'contacts') return { select() { return { single: async () => ({ data: { id: 'contact-supabase', phone_number: '5511999990000' }, error: null }) }; } };
            return { error: null };
          },
          delete() { calls.push(`${table}:delete`); return query; }
        };
        return query;
      }
    };
    const resolver = new SupabaseContactIdentityResolver(client as any);
    await expect(resolver.resolve({ workspaceId: 'workspace-a', identifier: '5511999990000@c.us', source: 'characterization' })).resolves.toEqual({ id: 'contact-supabase', phoneNumber: '5511999990000' });
    expect(calls).toEqual(['contacts:upsert', 'contact_identifiers:upsert', 'pending_contact_identities:delete']);
  });
});
