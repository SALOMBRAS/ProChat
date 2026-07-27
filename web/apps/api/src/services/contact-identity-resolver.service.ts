import { randomUUID } from 'node:crypto';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeWhatsAppIdentifier, whatsappIdentifierKind } from './whatsapp-identifier.js';

export type ContactIdentityInput = {
  workspaceId: string; identifier?: string; aliases?: readonly string[]; phone?: string | null; displayName?: string | null; source: string;
  session?: string; chatId?: string; isGroup?: boolean; isParticipant?: boolean;
};
export type ResolvedContact = { id: string; phoneNumber: string } | undefined;
export type ContactIdentityResolution = { contactId?: string; canonicalPhone?: string; canonicalChatId: string; identifiers: string[]; pendingIdentity?: string; resolutionSource: 'group' | 'participant' | 'alias' | 'phone' | 'created' | 'pending'; createdContact: boolean; attachedAliases: string[] };
export interface ContactIdentityResolver { resolve(input: ContactIdentityInput): Promise<ResolvedContact>; resolveDetailed(input: ContactIdentityInput): Promise<ContactIdentityResolution>; }

export function normalizedPhone(value: string | null | undefined): string | undefined { const digits = (value ?? '').replace(/\D/g, ''); return digits.length >= 8 && digits.length <= 15 ? digits : undefined; }
export function phoneFromIdentifier(identifier: string): string | undefined { const value = normalizeWhatsAppIdentifier(identifier) ?? identifier.trim().toLowerCase(); return /^\d+$/.test(value) || value.endsWith('@c.us') ? normalizedPhone(value.split('@', 1)[0]) : undefined; }
function observedPhone(input: ContactIdentityInput): string | undefined { return normalizedPhone(input.phone) ?? [input.identifier, input.chatId, ...(input.aliases ?? [])].filter((value): value is string => Boolean(value)).map(phoneFromIdentifier).find((value): value is string => Boolean(value)); }

type Alias = { identifier: string; type: string };
function identityAliases(input: ContactIdentityInput, phone: string | undefined): Alias[] {
  const raw = [input.identifier, input.chatId, ...(input.aliases ?? [])].filter((value): value is string => Boolean(value));
  const result = raw.map(value => {
    const identifier = normalizeWhatsAppIdentifier(value) ?? value.trim().toLowerCase();
    const kind = whatsappIdentifierKind(identifier);
    return { identifier, type: kind === 'lid' ? 'lid' : kind === 'direct' ? 'whatsapp' : /^\d+$/.test(identifier) ? 'phone' : 'whatsapp' };
  }).filter(item => item.identifier.length > 0 && whatsappIdentifierKind(item.identifier) !== 'group');
  if (phone) result.push({ identifier: phone, type: 'phone' });
  return [...new Map(result.map(item => [item.identifier, item])).values()];
}
function noContact(input: ContactIdentityInput, knownAliases: Alias[]): ContactIdentityResolution | undefined {
  // Group members are message authors, not ChatPro contacts inferred from the
  // group. Do not create aliases or pending identities for either a group or a
  // participant-only lookup; direct LID/JID resolution reaches this resolver
  // without these flags and still follows the normal phone-evidence flow.
  if (!input.isGroup && !input.isParticipant) return undefined;
  return { canonicalChatId: normalizeWhatsAppIdentifier(input.chatId ?? input.identifier) ?? '', identifiers: knownAliases.map(item => item.identifier), resolutionSource: input.isGroup ? 'group' : 'participant', createdContact: false, attachedAliases: [] };
}
function detail(contact: ResolvedContact, phone: string | undefined, knownAliases: Alias[], input: ContactIdentityInput, source: ContactIdentityResolution['resolutionSource'], createdContact = false): ContactIdentityResolution {
  return { contactId: contact?.id, canonicalPhone: contact?.phoneNumber ?? phone, canonicalChatId: normalizeWhatsAppIdentifier(input.chatId ?? input.identifier) ?? knownAliases[0]?.identifier ?? '', identifiers: knownAliases.map(item => item.identifier), resolutionSource: source, createdContact, attachedAliases: contact ? knownAliases.map(item => item.identifier) : [], ...(contact ? {} : { pendingIdentity: knownAliases[0]?.identifier }) };
}

export class SqliteContactIdentityResolver implements ContactIdentityResolver {
  constructor(private readonly database: SqliteDatabase) {}
  async resolve(input: ContactIdentityInput): Promise<ResolvedContact> { const result = await this.resolveDetailed(input); return result.contactId ? this.lookup(input.workspaceId, result.contactId) : undefined; }
  private lookup(workspaceId: string, id: string): ResolvedContact { return this.database.prepare('SELECT id, phoneNumber FROM contacts WHERE workspaceId=? AND id=?').get(workspaceId, id) as ResolvedContact; }
  async resolveDetailed(input: ContactIdentityInput): Promise<ContactIdentityResolution> {
    const phone = observedPhone(input); const knownAliases = identityAliases(input, phone); const skipped = noContact(input, knownAliases); if (skipped) return skipped;
    return this.database.transaction(() => {
      const now = new Date().toISOString(); let contact = phone ? this.database.prepare('SELECT id, phoneNumber FROM contacts WHERE workspaceId=? AND phoneNumber=?').get(input.workspaceId, phone) as ResolvedContact : undefined;
      let source: ContactIdentityResolution['resolutionSource'] = contact ? 'phone' : 'pending';
      if (!contact && knownAliases.length) { contact = this.database.prepare(`SELECT c.id, c.phoneNumber FROM contact_identifiers i JOIN contacts c ON c.workspaceId=i.workspaceId AND c.id=i.contactId WHERE i.workspaceId=? AND i.identifier IN (${knownAliases.map(() => '?').join(',')}) LIMIT 1`).get(input.workspaceId, ...knownAliases.map(item => item.identifier)) as ResolvedContact | undefined; if (contact) source = 'alias'; }
      if (!contact && phone) { contact = { id: randomUUID(), phoneNumber: phone }; this.database.prepare('INSERT INTO contacts (id,workspaceId,displayName,phoneNumber,email,company,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)').run(contact.id, input.workspaceId, input.displayName?.trim() || phone, phone, null, null, now, now); source = 'created'; }
      if (contact) { const insert = this.database.prepare('INSERT OR IGNORE INTO contact_identifiers (id,workspaceId,contactId,identifier,type,source,createdAt) VALUES (?,?,?,?,?,?,?)'); for (const alias of knownAliases) insert.run(randomUUID(), input.workspaceId, contact.id, alias.identifier, alias.type, input.source, now); if (knownAliases.length) this.database.prepare(`DELETE FROM pending_contact_identities WHERE workspaceId=? AND identifier IN (${knownAliases.map(() => '?').join(',')})`).run(input.workspaceId, ...knownAliases.map(item => item.identifier)); return detail(contact, phone, knownAliases, input, source, source === 'created'); }
      for (const alias of knownAliases) this.database.prepare("INSERT INTO pending_contact_identities (id,workspaceId,identifier,type,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspaceId,identifier) DO UPDATE SET source=excluded.source,updatedAt=excluded.updatedAt").run(randomUUID(), input.workspaceId, alias.identifier, alias.type, input.source, now, now);
      return detail(undefined, phone, knownAliases, input, 'pending');
    })();
  }
}

export class SupabaseContactIdentityResolver implements ContactIdentityResolver {
  constructor(private readonly client: SupabaseClient) {}
  async resolve(input: ContactIdentityInput): Promise<ResolvedContact> { const result = await this.resolveDetailed(input); return result.contactId && result.canonicalPhone ? { id: result.contactId, phoneNumber: result.canonicalPhone } : undefined; }
  async resolveDetailed(input: ContactIdentityInput): Promise<ContactIdentityResolution> {
    const phone = observedPhone(input); const knownAliases = identityAliases(input, phone); const skipped = noContact(input, knownAliases); if (skipped) return skipped;
    const { data, error } = await this.client.rpc('chatpro_resolve_contact_identity', { p_workspace_id: input.workspaceId, p_phone_number: phone ?? null, p_display_name: input.displayName?.trim() || null, p_identifiers: knownAliases, p_source: input.source });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data as Record<string, unknown> | null;
    const attached = Array.isArray(row?.attached_identifiers) ? row.attached_identifiers as unknown[] : [];
    return { contactId: typeof row?.contact_id === 'string' ? row.contact_id : undefined, canonicalPhone: typeof row?.phone_number === 'string' ? row.phone_number : undefined, canonicalChatId: normalizeWhatsAppIdentifier(input.chatId ?? input.identifier) ?? knownAliases[0]?.identifier ?? '', identifiers: knownAliases.map(item => item.identifier), pendingIdentity: typeof row?.pending_identifier === 'string' ? row.pending_identifier : undefined, resolutionSource: (row?.resolution_source as ContactIdentityResolution['resolutionSource']) ?? (phone ? 'phone' : 'pending'), createdContact: Boolean(row?.created_contact), attachedAliases: attached.filter((value): value is string => typeof value === 'string') };
  }
}
