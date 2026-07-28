import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { createSqliteDomainRepository } from '../src/persistence/sqlite-domain.repository.js';
import { AppError } from '../src/errors.js';

const dirs: string[] = [];
const create = () => { const dir = mkdtempSync(join(tmpdir(), 'chatpro-drift-')); dirs.push(dir); const db = new SqlitePersistenceDatabase(join(dir, 'db.sqlite'), join(process.cwd(), 'migrations')); db.migrate(); return { db, repository: createSqliteDomainRepository(db.sqlite) as any }; };
const rejection = async (work: Promise<unknown>) => work.then(() => undefined, (error: unknown) => error);
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
// Once identifierHash exists the pepper is mandatory, so a database migrated past M3 has to carry one.
const previousPepper = process.env.OPT_OUT_HASH_PEPPER;
beforeAll(() => { process.env.OPT_OUT_HASH_PEPPER = 'test-pepper-with-at-least-32-characters'; });
afterAll(() => { if (previousPepper === undefined) delete process.env.OPT_OUT_HASH_PEPPER; else process.env.OPT_OUT_HASH_PEPPER = previousPepper; });

/**
 * The proposed contact migrations (docs/migrations-propostas-contatos.sql) are additive:
 * M1 and M2 add columns to `contacts`, M3 rebuilds `opt_out_history` with one more column.
 * Positional INSERTs break on exactly that, and a bare `catch { fail(409, ...) }` used to
 * report the breakage as "Phone number already exists in this workspace".
 */
describe('SQLite domain writes under schema drift', () => {
  it('creates a contact after M1 and M2 add columns to contacts', async () => {
    const { db, repository } = create();
    try {
      db.sqlite.exec("ALTER TABLE contacts ADD COLUMN blockState TEXT NOT NULL DEFAULT 'active'");
      db.sqlite.exec("ALTER TABLE contacts ADD COLUMN blockPropagation TEXT NOT NULL DEFAULT 'none'");
      db.sqlite.exec('ALTER TABLE contacts ADD COLUMN deletedAt TEXT');
      const contact = await repository.createContact('a', { displayName: 'Ada', phoneNumber: '+55 (11) 99999-0000' });
      expect(contact).toMatchObject({ displayName: 'Ada', phoneNumber: '5511999990000', workspaceId: 'a' });
      expect(await repository.updateContact('a', contact.id, { displayName: 'Ada Lovelace' })).toMatchObject({ displayName: 'Ada Lovelace' });
    } finally { db.close(); }
  });

  it('records an opt-out after M3 adds identifierHash to opt_out_history', async () => {
    const { db, repository } = create();
    try {
      db.sqlite.exec('ALTER TABLE opt_out_history ADD COLUMN identifierHash TEXT');
      const contact = await repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' });
      expect(await repository.optOut('a', contact.id, { reason: 'requested' })).toMatchObject({ contactId: contact.id, reason: 'requested' });
      expect(await repository.optOutStatus('a', contact.id)).toMatchObject({ optedOut: true });
    } finally { db.close(); }
  });

  it('still reports a duplicate phone number as a 409 conflict', async () => {
    const { db, repository } = create();
    try {
      await repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' });
      const error = await rejection(repository.createContact('a', { displayName: 'Duplicate', phoneNumber: '5511999990000' }));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Phone number already exists in this workspace' });
    } finally { db.close(); }
  });

  it('propagates a database error that is not the phone constraint instead of calling it a conflict', async () => {
    const { db, repository } = create();
    try {
      // Any failure that is not UNIQUE(workspaceId, phoneNumber): the default value of the
      // new column violates its own CHECK, so every insert fails for an unrelated reason.
      db.sqlite.exec("ALTER TABLE contacts ADD COLUMN kind TEXT NOT NULL DEFAULT 'unset' CHECK (kind IN ('lead'))");
      const error = await rejection(repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' })) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AppError);
      expect(error.message).toContain('CHECK constraint failed');
      expect(error.message).not.toContain('Phone number already exists');
    } finally { db.close(); }
  });

  it('keeps the same discrimination on the other unique constraints', async () => {
    const conflict = create();
    try {
      await conflict.repository.createTag('a', { name: 'VIP', color: null });
      expect(await rejection(conflict.repository.createTag('a', { name: 'VIP', color: null }))).toMatchObject({ status: 409, message: 'Tag name already exists' });
    } finally { conflict.db.close(); }

    // A fresh database: ADD COLUMN with a CHECK validates the rows already stored,
    // so the drift has to be introduced while the table is still empty.
    const drift = create();
    try {
      drift.db.sqlite.exec("ALTER TABLE tags ADD COLUMN archived TEXT NOT NULL DEFAULT 'no' CHECK (archived IN ('yes'))");
      const error = await rejection(drift.repository.createTag('a', { name: 'VIP', color: null })) as Error;
      expect(error).not.toBeInstanceOf(AppError);
      expect(error.message).toContain('CHECK constraint failed');
    } finally { drift.db.close(); }
  });
});
