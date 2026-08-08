import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';

/**
 * Persistence-facing provider names. This is intentionally narrower than the
 * worker's provider union: only providers with a durable provider-session row
 * can be used to scope Inbox data.
 */
export const inboxWhatsAppProviderSchema = z.enum(['waha', 'gowa']);
export type InboxWhatsAppProvider = z.infer<typeof inboxWhatsAppProviderSchema>;

export type ProviderSessionLookup = {
  workspaceId: string;
  provider: InboxWhatsAppProvider;
  sessionId: string;
};

/** Safe internal reference; provider device ids and provider metadata stay out. */
export type ProviderSessionReference = ProviderSessionLookup & {
  providerSessionId: string;
};

export interface ProviderSessionResolver {
  resolve(input: ProviderSessionLookup): Promise<ProviderSessionReference | undefined>;
}

const lookupSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  provider: inboxWhatsAppProviderSchema,
  sessionId: z.string().trim().min(1).max(200),
});

const sqliteRowSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: inboxWhatsAppProviderSchema,
  sessionId: z.string().min(1),
});

const supabaseRowSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  provider: inboxWhatsAppProviderSchema,
  session_id: z.string().min(1),
});

/**
 * Resolves the durable, provider-specific session key that future Inbox
 * migrations will reference. It is read-only: this phase must not invent a
 * WAHA row or mutate an existing GOWA row as a side effect of a lookup.
 */
export class SqliteProviderSessionResolver implements ProviderSessionResolver {
  constructor(private readonly database: SqliteDatabase) {}

  async resolve(input: ProviderSessionLookup): Promise<ProviderSessionReference | undefined> {
    const lookup = lookupSchema.parse(input);
    const row = this.database.prepare('SELECT id, workspaceId, provider, sessionId FROM whatsapp_provider_sessions WHERE workspaceId = ? AND provider = ? AND sessionId = ?').get(lookup.workspaceId, lookup.provider, lookup.sessionId);
    if (!row) return undefined;
    const parsed = sqliteRowSchema.parse(row);
    return { workspaceId: parsed.workspaceId, provider: parsed.provider, sessionId: parsed.sessionId, providerSessionId: parsed.id };
  }
}

export class SupabaseProviderSessionResolver implements ProviderSessionResolver {
  constructor(private readonly client: SupabaseClient) {}

  async resolve(input: ProviderSessionLookup): Promise<ProviderSessionReference | undefined> {
    const lookup = lookupSchema.parse(input);
    const { data, error } = await this.client.from('whatsapp_provider_sessions').select('id, workspace_id, provider, session_id').eq('workspace_id', lookup.workspaceId).eq('provider', lookup.provider).eq('session_id', lookup.sessionId).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    const parsed = supabaseRowSchema.parse(data);
    return { workspaceId: parsed.workspace_id, provider: parsed.provider, sessionId: parsed.session_id, providerSessionId: parsed.id };
  }
}
