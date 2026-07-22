import { randomUUID } from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ContactIdentityInput = { workspaceId: string; identifier: string; phone?: string | null; displayName?: string | null; source: string };
export type ResolvedContact = { id: string; phoneNumber: string } | undefined;
export interface ContactIdentityResolver { resolve(input: ContactIdentityInput): Promise<ResolvedContact>; }

export function normalizedPhone(value: string | null | undefined): string | undefined {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : undefined;
}

export function phoneFromIdentifier(identifier: string): string | undefined {
  const value = identifier.trim().toLowerCase();
  if (/^\d+$/.test(value) || value.endsWith('@c.us')) return normalizedPhone(value.split('@', 1)[0]);
  return undefined;
}

function aliases(input: ContactIdentityInput, phone: string | undefined): Array<{ identifier: string; type: string }> {
  const result = [{ identifier: input.identifier.trim().toLowerCase(), type: input.identifier.includes('@lid') ? 'lid' : input.identifier.includes('@') ? 'whatsapp' : 'phone' }];
  if (phone && !result.some(item => item.identifier === phone)) result.push({ identifier: phone, type: 'phone' });
  return result.filter(item => item.identifier.length > 0);
}

export class SqliteContactIdentityResolver implements ContactIdentityResolver {
  constructor(private readonly database: SqliteDatabase) {}
  async resolve(input: ContactIdentityInput): Promise<ResolvedContact> {
    const phone = normalizedPhone(input.phone) ?? phoneFromIdentifier(input.identifier);
    const knownAliases = aliases(input, phone);
    return this.database.transaction(() => {
      let contact = phone ? this.database.prepare('SELECT id, phoneNumber FROM contacts WHERE workspaceId=? AND phoneNumber=?').get(input.workspaceId, phone) as ResolvedContact : undefined;
      if (!contact) {
        const row = this.database.prepare(`SELECT c.id, c.phoneNumber FROM contact_identifiers i JOIN contacts c ON c.workspaceId=i.workspaceId AND c.id=i.contactId WHERE i.workspaceId=? AND i.identifier IN (${knownAliases.map(() => '?').join(',')}) LIMIT 1`).get(input.workspaceId, ...knownAliases.map(item => item.identifier)) as ResolvedContact | undefined;
        contact = row;
      }
      const now = new Date().toISOString();
      if (!contact && phone) {
        contact = { id: randomUUID(), phoneNumber: phone };
        this.database.prepare('INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,email,company,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)').run(contact.id, input.workspaceId, input.displayName?.trim() || phone, phone, null, null, now, now);
      }
      if (contact) {
        const insert = this.database.prepare('INSERT OR IGNORE INTO contact_identifiers (id,workspaceId,contactId,identifier,type,source,createdAt) VALUES (?,?,?,?,?,?,?)');
        for (const alias of knownAliases) insert.run(randomUUID(), input.workspaceId, contact.id, alias.identifier, alias.type, input.source, now);
        this.database.prepare(`DELETE FROM pending_contact_identities WHERE workspaceId=? AND identifier IN (${knownAliases.map(() => '?').join(',')})`).run(input.workspaceId, ...knownAliases.map(item => item.identifier));
        return contact;
      }
      for (const alias of knownAliases) this.database.prepare("INSERT INTO pending_contact_identities (id,workspaceId,identifier,type,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspaceId,identifier) DO UPDATE SET source=excluded.source,updatedAt=excluded.updatedAt").run(randomUUID(), input.workspaceId, alias.identifier, alias.type, input.source, now, now);
      return undefined;
    })();
  }
}

export class SupabaseContactIdentityResolver implements ContactIdentityResolver {
  constructor(private readonly client: SupabaseClient) {}
  async resolve(input: ContactIdentityInput): Promise<ResolvedContact> {
    const phone = normalizedPhone(input.phone) ?? phoneFromIdentifier(input.identifier);
    const knownAliases = aliases(input, phone); const now = new Date().toISOString();
    let contact: ResolvedContact;
    if (phone) { const { data, error } = await this.client.from('contacts').select('id,phone_number').eq('workspace_id', input.workspaceId).eq('phone_number', phone).maybeSingle(); if (error) throw error; contact = data ? { id: data.id, phoneNumber: data.phone_number } : undefined; }
    if (!contact) { const { data, error } = await this.client.from('contact_identifiers').select('contact_id,contacts!inner(id,phone_number)').eq('workspace_id', input.workspaceId).in('identifier', knownAliases.map(item => item.identifier)).limit(1); if (error) throw error; const row: any = data?.[0]; if (row) contact = { id: row.contacts.id, phoneNumber: row.contacts.phone_number }; }
    if (!contact && phone) { const candidate = { id: randomUUID(), workspace_id: input.workspaceId, display_name: input.displayName?.trim() || phone, phone_number: phone, email: null, company: null, created_at: now, updated_at: now }; const { data, error } = await this.client.from('contacts').upsert(candidate, { onConflict: 'workspace_id,phone_number' }).select('id,phone_number').single(); if (error) throw error; contact = { id: data.id, phoneNumber: data.phone_number }; }
    if (contact) { const { error } = await this.client.from('contact_identifiers').upsert(knownAliases.map(alias => ({ id: randomUUID(), workspace_id: input.workspaceId, contact_id: contact!.id, identifier: alias.identifier, type: alias.type, source: input.source, created_at: now })), { onConflict: 'workspace_id,identifier', ignoreDuplicates: true }); if (error) throw error; await this.client.from('pending_contact_identities').delete().eq('workspace_id', input.workspaceId).in('identifier', knownAliases.map(alias => alias.identifier)); return contact; }
    const { error } = await this.client.from('pending_contact_identities').upsert(knownAliases.map(alias => ({ id: randomUUID(), workspace_id: input.workspaceId, identifier: alias.identifier, type: alias.type, source: input.source, created_at: now, updated_at: now })), { onConflict: 'workspace_id,identifier' }); if (error) throw error; return undefined;
  }
}
