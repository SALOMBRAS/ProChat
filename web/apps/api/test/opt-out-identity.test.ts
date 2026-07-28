import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceDatabase } from '../src/persistence/database.js';
import { createSqliteDomainRepository } from '../src/persistence/sqlite-domain.repository.js';
import { SqliteContactIdentityResolver } from '../src/services/contact-identity-resolver.service.js';
import { optOutIdentifierHash, OPT_OUT_HASH_PEPPER_VARIABLE } from '../src/services/opt-out-identity.js';
import { AppError } from '../src/errors.js';

const PEPPER = 'test-pepper-with-at-least-32-characters';
const dirs: string[] = [];
const create = () => { const dir = mkdtempSync(join(tmpdir(), 'chatpro-optout-')); dirs.push(dir); const db = new SqlitePersistenceDatabase(join(dir, 'db.sqlite'), join(process.cwd(), 'migrations')); db.migrate(); return { db, repository: createSqliteDomainRepository(db.sqlite) as any }; };
/** The shape migration M3 gives opt_out_history: contactId nullable, identifierHash present. */
const applyM3 = (db: SqlitePersistenceDatabase) => db.sqlite.exec(`
  CREATE TABLE opt_out_history_new (id TEXT NOT NULL, workspaceId TEXT NOT NULL, contactId TEXT, identifierHash TEXT, reason TEXT, source TEXT NOT NULL, occurredAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (workspaceId,id), FOREIGN KEY (workspaceId,contactId) REFERENCES contacts(workspaceId,id) ON DELETE RESTRICT);
  INSERT INTO opt_out_history_new (id,workspaceId,contactId,identifierHash,reason,source,occurredAt,createdAt,updatedAt) SELECT id,workspaceId,contactId,NULL,reason,source,occurredAt,createdAt,updatedAt FROM opt_out_history;
  DROP TABLE opt_out_history; ALTER TABLE opt_out_history_new RENAME TO opt_out_history;`);
/** What the purge leaves behind: the manifestation without its contact, reachable only by hash. */
const orphanOptOut = (db: SqlitePersistenceDatabase, ws: string, phoneNumber: string) => { const at = '2026-07-01T00:00:00.000Z'; db.sqlite.prepare('INSERT INTO opt_out_history (id,workspaceId,contactId,identifierHash,reason,source,occurredAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)').run('orphan-1', ws, null, optOutIdentifierHash(phoneNumber), 'purged', 'manual', at, at, at); };

afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); delete process.env[OPT_OUT_HASH_PEPPER_VARIABLE]; });

describe('opt-out identifier hash', () => {
  it('refuses to produce a hash without a pepper instead of falling back to a weak one', () => {
    delete process.env[OPT_OUT_HASH_PEPPER_VARIABLE];
    expect(() => optOutIdentifierHash('5511999990000')).toThrow(AppError);
    expect(() => optOutIdentifierHash('5511999990000')).toThrow(/OPT_OUT_HASH_PEPPER is not configured/);
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = 'too-short';
    expect(() => optOutIdentifierHash('5511999990000')).toThrow(/at least 32 characters/);
  });

  it('is keyed, versioned and stable for the same normalized number', () => {
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = PEPPER;
    const hash = optOutIdentifierHash('5511999990000');
    expect(hash).toMatch(/^v1:[0-9a-f]{64}$/);
    // Normalization is part of the contract: the stored digits are what gets hashed.
    expect(optOutIdentifierHash('+55 (11) 99999-0000')).toBe(hash);
    expect(optOutIdentifierHash('5511999990001')).not.toBe(hash);
    // A different pepper must not produce the same digest, or the key would be decorative.
    expect(optOutIdentifierHash('5511999990000', { [OPT_OUT_HASH_PEPPER_VARIABLE]: `${PEPPER}-other` })).not.toBe(hash);
    expect(() => optOutIdentifierHash('123')).toThrow(/8 to 15 digits/);
  });
});

describe('opt-out survives the contact that made it', () => {
  it('reports a contact as opted out when only the orphaned hash row remains', async () => {
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = PEPPER;
    const { db, repository } = create();
    try {
      applyM3(db);
      orphanOptOut(db, 'a', '5511999990000');
      // Re-imported after the purge: brand new contactId, same number.
      const contact = await repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' });
      expect(await repository.optOutStatus('a', contact.id)).toMatchObject({ optedOut: true });
    } finally { db.close(); }
  });

  it('adopts the orphaned row on creation so campaign exclusion keeps working by contactId', async () => {
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = PEPPER;
    const { db, repository } = create();
    try {
      applyM3(db);
      orphanOptOut(db, 'a', '5511999990000');
      const contact = await repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' });
      expect(db.sqlite.prepare('SELECT contactId FROM opt_out_history WHERE id=?').get('orphan-1')).toEqual({ contactId: contact.id });

      const template: any = await repository.saveTemplate('a', undefined, { name: 'Hello', content: 'Oi' });
      const campaign: any = await repository.saveCampaign('a', undefined, { name: 'C', templateId: template.id, contactIds: [contact.id] });
      expect(await repository.prepareCampaign('a', campaign.id)).toMatchObject({ eligibleRecipients: 0, excludedOptOut: 1, campaign: { status: 'blocked' } });
    } finally { db.close(); }
  });

  it('adopts the orphaned row when an inbound message materializes the contact', async () => {
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = PEPPER;
    const { db } = create();
    try {
      applyM3(db);
      orphanOptOut(db, 'a', '5511999990000');
      const resolved = await new SqliteContactIdentityResolver(db.sqlite).resolveDetailed({ workspaceId: 'a', identifier: '5511999990000@c.us', source: 'waha_webhook' });
      expect(resolved.createdContact).toBe(true);
      expect(db.sqlite.prepare('SELECT contactId FROM opt_out_history WHERE id=?').get('orphan-1')).toEqual({ contactId: resolved.contactId });
    } finally { db.close(); }
  });

  // Covers the read path on its own: this contact predates the adoption write, so only the
  // hash predicate in optOutStatus can find the manifestation.
  it('reports the orphaned opt-out for a contact that was never adopted, without mutating it', async () => {
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = PEPPER;
    const { db, repository } = create();
    try {
      const contact = await repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' });
      applyM3(db);
      orphanOptOut(db, 'a', '5511999990000');
      expect(await repository.optOutStatus('a', contact.id)).toMatchObject({ optedOut: true });
      expect(db.sqlite.prepare('SELECT contactId FROM opt_out_history WHERE id=?').get('orphan-1')).toEqual({ contactId: null });
    } finally { db.close(); }
  });

  it('leaves a different number alone', async () => {
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = PEPPER;
    const { db, repository } = create();
    try {
      applyM3(db);
      orphanOptOut(db, 'a', '5511999990000');
      const other = await repository.createContact('a', { displayName: 'Alan', phoneNumber: '5511999990002' });
      expect(await repository.optOutStatus('a', other.id)).toMatchObject({ optedOut: false });
      expect(db.sqlite.prepare('SELECT contactId FROM opt_out_history WHERE id=?').get('orphan-1')).toEqual({ contactId: null });
    } finally { db.close(); }
  });

  it('keeps the existing behaviour for contacts whose own opt-out is intact', async () => {
    process.env[OPT_OUT_HASH_PEPPER_VARIABLE] = PEPPER;
    const { db, repository } = create();
    try {
      applyM3(db);
      const contact = await repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' });
      await repository.optOut('a', contact.id, { reason: 'requested' });
      expect(await repository.optOutStatus('a', contact.id)).toMatchObject({ optedOut: true });
      await repository.removeOptOut('a', contact.id);
      expect(await repository.optOutStatus('a', contact.id)).toMatchObject({ optedOut: false });
    } finally { db.close(); }
  });

  it('stays inert, and needs no pepper, while the column does not exist', async () => {
    delete process.env[OPT_OUT_HASH_PEPPER_VARIABLE];
    const { db, repository } = create();
    try {
      const contact = await repository.createContact('a', { displayName: 'Ada', phoneNumber: '5511999990000' });
      expect(await repository.optOutStatus('a', contact.id)).toMatchObject({ optedOut: false });
      await repository.optOut('a', contact.id, { reason: 'requested' });
      expect(await repository.optOutStatus('a', contact.id)).toMatchObject({ optedOut: true });
    } finally { db.close(); }
  });
});
