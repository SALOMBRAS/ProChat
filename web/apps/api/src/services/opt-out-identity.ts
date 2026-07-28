import { createHmac } from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { normalizedPhoneNumberSchema } from '@chatpro/contracts';
import { AppError } from '../errors.js';

/**
 * Opt-out identity that survives the deletion of the contact.
 *
 * When a contact is purged its `opt_out_history` row keeps `identifier_hash` and loses
 * `contact_id`. Re-importing the same number produces a new contact id, so nothing would
 * link it back to the manifestation the person made — purging would silently revoke the
 * opt-out. The hash is that link.
 *
 * It is an HMAC, not a bare digest, and the key lives outside the database on purpose:
 * a Brazilian mobile number has a preimage space small enough to exhaust on commodity
 * hardware, so `sha256(phone)` is reversible and would still be personal data. With the
 * pepper held by the application, a dump of `opt_out_history` alone does not reverse it.
 */
export const OPT_OUT_HASH_PEPPER_VARIABLE = 'OPT_OUT_HASH_PEPPER';
/** Prefix so a pepper rotation can keep both schemes readable side by side. */
export const OPT_OUT_HASH_VERSION = 'v1';
const MINIMUM_PEPPER_LENGTH = 32;

/**
 * Fails loudly and never falls back to an unkeyed or default pepper: a weak hash here
 * looks like compliance while providing none, which is worse than an outage.
 */
export function optOutHashPepper(env: Record<string, string | undefined> = process.env): string {
  const pepper = (env[OPT_OUT_HASH_PEPPER_VARIABLE] ?? '').trim();
  if (!pepper) throw new AppError(500, 'SERVICE_UNAVAILABLE', `${OPT_OUT_HASH_PEPPER_VARIABLE} is not configured; opt-out identifier hashes cannot be computed`);
  if (pepper.length < MINIMUM_PEPPER_LENGTH) throw new AppError(500, 'SERVICE_UNAVAILABLE', `${OPT_OUT_HASH_PEPPER_VARIABLE} must be at least ${MINIMUM_PEPPER_LENGTH} characters`);
  return pepper;
}

/**
 * Canonical input is the stored, normalized phone number — digits only, no `+`, no `@c.us`
 * suffix — matching `normalizedPhoneNumberSchema`. Changing the pepper or this normalization
 * invalidates every hash already written.
 */
export function optOutIdentifierHash(phoneNumber: unknown, env: Record<string, string | undefined> = process.env): string {
  const normalized = String(phoneNumber ?? '').replace(/\D/g, '');
  if (!normalizedPhoneNumberSchema.safeParse(normalized).success) throw new AppError(400, 'VALIDATION_ERROR', 'Opt-out identifier hash requires a phone number with 8 to 15 digits');
  return `${OPT_OUT_HASH_VERSION}:${createHmac('sha256', optOutHashPepper(env)).update(normalized).digest('hex')}`;
}

/**
 * `opt_out_history.identifier_hash` only exists once migration M3 is applied. Until then the
 * hash paths stay inert rather than failing, so this change is safe to deploy before it.
 * Mirrors `missingMediaColumns` in waha-webhook.service.ts.
 */
export function missingIdentifierHash(value: { code?: string; message?: string; details?: string } | null | undefined): boolean {
  return value?.code === '42703' || /identifier_hash/i.test(`${value?.message ?? ''} ${value?.details ?? ''}`);
}

type SqliteLike = Pick<SqliteDatabase, 'prepare'>;

/**
 * Same idea as `missingIdentifierHash`, resolved up front because SQLite can be asked about
 * its own schema. Deliberately uncached: reading the schema is an in-memory lookup, and a
 * cached answer would go stale the moment the column is added, silently disabling the hash
 * paths on a process that is still running.
 */
export function sqliteIdentifierHashReady(database: SqliteLike): boolean {
  return Number((database.prepare("SELECT count(*) n FROM pragma_table_info('opt_out_history') WHERE name='identifierHash'").get() as { n?: number } | undefined)?.n ?? 0) > 0;
}

/**
 * Re-attach an opt-out that outlived its contact. A purge leaves the row with `contactId`
 * NULL and `identifierHash` set; the contact that now carries the same number adopts it, so
 * every consumer matching on `contactId` — campaign exclusion, the listing filter — keeps
 * honouring the manifestation without having to know that hashes exist.
 *
 * Call it wherever a contact is materialized. Inert until migration M3 adds the column.
 */
export function sqliteAdoptOrphanOptOut(database: SqliteLike, workspaceId: string, contactId: string, phoneNumber: unknown, at: string): void {
  if (!sqliteIdentifierHashReady(database)) return;
  database.prepare('UPDATE opt_out_history SET contactId=?, updatedAt=? WHERE workspaceId=? AND contactId IS NULL AND identifierHash=?').run(contactId, at, workspaceId, optOutIdentifierHash(phoneNumber));
}

type PostgrestLike = { from: (table: string) => any };
const readyClients = new WeakMap<object, Promise<boolean>>();

/**
 * Probed once per client, so a deployment that has not applied M3 keeps working — and never
 * has to hold a pepper. Any failure to probe is read as "column absent", which is the state
 * the system is already in before M3; it degrades to today's behaviour rather than breaking
 * contact creation over a capability check.
 *
 * Unlike the SQLite check this one is cached, because it costs a round trip. The API therefore
 * has to be restarted after M3 is applied, or a running process keeps the negative answer and
 * the hash paths stay inert. SQLite has no such requirement: it migrates at boot.
 */
export function supabaseIdentifierHashReady(client: PostgrestLike): Promise<boolean> {
  const cached = readyClients.get(client as object);
  if (cached) return cached;
  let probe: Promise<boolean>;
  try { probe = Promise.resolve(client.from('opt_out_history').select('identifier_hash').limit(1)).then((result: { error?: { code?: string; message?: string; details?: string } | null }) => !missingIdentifierHash(result?.error)).catch(() => false); }
  catch { probe = Promise.resolve(false); }
  readyClients.set(client as object, probe);
  return probe;
}

/** Supabase counterpart of `sqliteAdoptOrphanOptOut`, so both providers honour a purged opt-out identically. */
export async function supabaseAdoptOrphanOptOut(client: PostgrestLike, workspaceId: string, contactId: string, phoneNumber: unknown): Promise<void> {
  if (!(await supabaseIdentifierHashReady(client))) return;
  const { error } = await client.from('opt_out_history').update({ contact_id: contactId, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).is('contact_id', null).eq('identifier_hash', optOutIdentifierHash(phoneNumber));
  if (error && !missingIdentifierHash(error)) throw error;
}
