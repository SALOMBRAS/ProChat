import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';
import type { ConversationStore, ConversationSummary } from './waha-webhook.service.js';
import type { RealtimeHub } from '../realtime.js';

export type ConversationContext = { notes: string | null; tags: string[]; firstInteractionAt: string; lastInteractionAt: string };
export type ConversationContextUpdate = { notes?: string; tags?: string[] };
type MetadataStore = { getOrCreate(workspaceId: string, conversation: ConversationSummary): Promise<ConversationContext>; update(workspaceId: string, conversation: ConversationSummary, input: ConversationContextUpdate): Promise<ConversationContext> };

export class ConversationContextService {
  constructor(private readonly conversations: ConversationStore, private readonly metadata: MetadataStore, private readonly realtime: RealtimeHub) {}
  async get(workspaceId: string, conversationId: string): Promise<ConversationContext | undefined> { const conversation = await this.conversations.getConversation(workspaceId, conversationId); return conversation ? this.metadata.getOrCreate(workspaceId, conversation) : undefined; }
  async update(workspaceId: string, conversationId: string, input: ConversationContextUpdate): Promise<ConversationContext | undefined> {
    const conversation = await this.conversations.getConversation(workspaceId, conversationId); if (!conversation) return undefined;
    const result = await this.metadata.update(workspaceId, conversation, { ...input, ...(input.tags ? { tags: normalizeTags(input.tags) } : {}) });
    this.realtime.publish(workspaceId, 'conversation.context.updated', { conversationId });
    return result;
  }
}

export class SqliteConversationContextStore implements MetadataStore {
  constructor(private readonly database: SqliteDatabase) {}
  async getOrCreate(workspaceId: string, conversation: ConversationSummary): Promise<ConversationContext> { return this.ensure(workspaceId, conversation); }
  async update(workspaceId: string, conversation: ConversationSummary, input: ConversationContextUpdate): Promise<ConversationContext> {
    const current = this.ensure(workspaceId, conversation); const now = new Date().toISOString();
    this.database.prepare('UPDATE conversation_metadata SET notes = ?, tagsJson = ?, updatedAt = ? WHERE workspaceId = ? AND conversationId = ?').run(input.notes === undefined ? current.notes : input.notes, JSON.stringify(input.tags === undefined ? current.tags : input.tags), now, workspaceId, conversation.id);
    return { notes: input.notes === undefined ? current.notes : input.notes, tags: input.tags === undefined ? current.tags : input.tags, firstInteractionAt: current.firstInteractionAt, lastInteractionAt: current.lastInteractionAt };
  }
  private ensure(workspaceId: string, conversation: ConversationSummary): ConversationContext {
    const now = new Date().toISOString(); this.database.prepare('INSERT OR IGNORE INTO conversation_metadata (workspaceId, conversationId, notes, tagsJson, firstInteractionAt, lastInteractionAt, createdAt, updatedAt) VALUES (?, ?, NULL, \'[]\', ?, ?, ?, ?)').run(workspaceId, conversation.id, conversation.createdAt, conversation.lastMessageAt, now, now);
    const row = this.database.prepare('SELECT notes, tagsJson, firstInteractionAt, lastInteractionAt FROM conversation_metadata WHERE workspaceId = ? AND conversationId = ?').get(workspaceId, conversation.id) as { notes: string | null; tagsJson: string; firstInteractionAt: string; lastInteractionAt: string };
    return { notes: row.notes, tags: parseTags(row.tagsJson), firstInteractionAt: row.firstInteractionAt, lastInteractionAt: row.lastInteractionAt };
  }
}

export class SupabaseConversationContextStore implements MetadataStore {
  constructor(private readonly client: SupabaseClient) {}
  async getOrCreate(workspaceId: string, conversation: ConversationSummary): Promise<ConversationContext> {
    const { data, error } = await this.client.from('conversation_metadata').upsert({ workspace_id: workspaceId, conversation_id: conversation.id, first_interaction_at: conversation.createdAt, last_interaction_at: conversation.lastMessageAt }, { onConflict: 'workspace_id,conversation_id', ignoreDuplicates: true }).select('notes, tags, first_interaction_at, last_interaction_at').single();
    if (error && error.code !== 'PGRST116') throw error;
    if (data) return remoteContext(data);
    const result = await this.client.from('conversation_metadata').select('notes, tags, first_interaction_at, last_interaction_at').eq('workspace_id', workspaceId).eq('conversation_id', conversation.id).single(); if (result.error) throw result.error; return remoteContext(result.data);
  }
  async update(workspaceId: string, conversation: ConversationSummary, input: ConversationContextUpdate): Promise<ConversationContext> {
    const current = await this.getOrCreate(workspaceId, conversation); const { data, error } = await this.client.from('conversation_metadata').update({ ...(input.notes === undefined ? {} : { notes: input.notes }), ...(input.tags === undefined ? {} : { tags: input.tags }), updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('conversation_id', conversation.id).select('notes, tags, first_interaction_at, last_interaction_at').single(); if (error) throw error; return remoteContext(data);
  }
}
function parseTags(value: string): string[] { try { const tags: unknown = JSON.parse(value); return Array.isArray(tags) ? (tags as unknown[]).filter((tag): tag is string => typeof tag === 'string') : []; } catch { return []; } }
function normalizeTags(tags: string[]): string[] { return [...new Map(tags.map(tag => [tag.trim().toLocaleLowerCase('pt-BR'), tag.trim()])).values()].filter(Boolean).slice(0, 20); }
function remoteContext(value: { notes: string | null; tags: unknown; first_interaction_at: string; last_interaction_at: string }): ConversationContext { const tags: unknown[] = Array.isArray(value.tags) ? value.tags : []; return { notes: value.notes, tags: tags.filter((tag): tag is string => typeof tag === 'string'), firstInteractionAt: value.first_interaction_at, lastInteractionAt: value.last_interaction_at }; }
