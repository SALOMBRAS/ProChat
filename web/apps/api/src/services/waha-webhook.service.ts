import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteDatabase } from '../persistence/database.js';
import { isTechnicalMessageType, resolveConversationIdentity, wahaMessageType } from './conversation-identity.js';
import type { KanbanAutomationCoordinator } from './kanban-automation.service.js';
import type { SlaMessageCoordinator } from './sla-message-coordinator.service.js';
import { SqliteContactIdentityResolver, SupabaseContactIdentityResolver } from './contact-identity-resolver.service.js';
import type { GroupParticipant } from '@chatpro/contracts';
import { log } from '../logging.js';

const acceptedEvents = ['message', 'message.any', 'message.reaction', 'session.status'] as const;
const sensitiveKey = /(api[_-]?key|authorization|credential|token|secret|password|cookie|auth)/i;
const webhookSchema = z.object({ id: z.string().min(1).max(200), timestamp: z.number().int().nonnegative(), event: z.enum(acceptedEvents), session: z.string().min(1).max(200), payload: z.record(z.unknown()) }).passthrough();
export type WahaWebhookEvent = z.infer<typeof webhookSchema>;
export type StoredWebhook = { workspaceId: string; wahaSession: string; externalEventId: string; eventType: WahaWebhookEvent['event']; occurredAt: string; payload: Record<string, unknown>; receivedAt: string };
type StoredMessage = StoredWebhook & { externalMessageId: string; chatId: string; deliveryChatId: string; conversationType: 'direct' | 'group'; senderWhatsappId: string | null; direction: 'inbound' | 'outbound'; messageType: string; body: string | null; mediaUrl: string | null; mediaMimeType: string | null; mediaFilename: string | null; mediaSize: number | null; thumbnailUrl: string | null; duration: number | null; quotedMessageId: string | null; historical: boolean };
export type IngestResult = { duplicate: boolean; messageInserted: boolean; messageType?: string; conversationId?: string; messageId?: string; conversationChatId?: string; conversationType?: 'direct' | 'group'; senderWhatsappId?: string | null; direction?: 'inbound' | 'outbound'; historical?: boolean; technical?: boolean; quarantined?: boolean; lastMessageAt?: string | null; conversationCreated?: boolean };
export type PersistedOutboundMessage = InboxMessage & { persistence: IngestResult };
export interface WahaWebhookStore { ingest(event: StoredWebhook): Promise<IngestResult>; }
/** Reação no formato público: `reactorWhatsappId` é nulo quando a reação é da
 *  própria conta — dashboard ou telefone são indistinguíveis no protocolo e
 *  nenhum dos dois expõe ids internos do operador. */
export type MessageReaction = { emoji: string; reactorWhatsappId: string | null; fromMe: boolean; reactorName: string | null; reactorPhone: string | null; reactedAt: string };
/** Reação como fica gravada, dentro do payload da mensagem-alvo: o autor interno
 *  (`operator:<userId>` ou o whatsappId do contato) só existe nesta forma; a
 *  leitura converte para `MessageReaction`. Não há tabela própria nem migration:
 *  a chave reservada `reactions` viaja no `payloadJson`/`payload_json` que os dois
 *  bancos já têm. */
export type StoredReaction = { author: string; authorName?: string | null; emoji: string; fromMe: boolean; reactedAt: string };
export type ReactionInput = { workspaceId: string; wahaSession: string; messageId: string; author: string; authorName?: string | null; emoji: string; fromMe: boolean; reactedAt: string };
export type ReactionAction = 'inserted' | 'updated' | 'removed' | 'noop' | 'orphan';
export type ReactionIngestResult = { action: ReactionAction; conversationId?: string; messageId: string; reactions: MessageReaction[] };
export interface ReactionStore { messageReactions(workspaceId: string, wahaSession: string, messageId: string): Promise<MessageReaction[] | undefined>; ingestReaction(input: ReactionInput): Promise<ReactionIngestResult>; }
/** `storeEvent` distingue a ingestão do reprocessamento: o evento bruto já está
 * gravado quando se reprocessa, e reinseri-lo violaria a unicidade.
 * `sideEffects` desliga automação de Kanban e relógio de SLA — um evento de dez
 * dias atrás não pode mover card nem contar como espera de agora. É também o que
 * torna o reprocessamento repetível: sem eles, o que resta é escrita idempotente. */
type PersistOptions = { storeEvent: boolean; sideEffects: boolean };
/** Um evento de mensagem que não virou mensagem. Não existe coluna que marque
 * isso: o descarte não deixa rastro no banco, então a única pergunta possível é
 * pela ausência — evento de mensagem sem linha correspondente em
 * `whatsapp_messages`. É uma anti-junção por `externalEventId`. */
export type DiscardedEventPage = { events: StoredWebhook[]; nextAfter: string | null };
/** Teto de ids por filtro `in` do PostgREST. Vale o mesmo raciocínio de
 * `criticalSampleLimit` em `sla.service.ts`: o filtro é serializado na URL e o
 * servidor corta em ~16 KB de header. Medido aqui: 600 ids destes eventos deram
 * 19.916 caracteres e a requisição falhou. */
const identifierBatch = 100;
export interface DiscardedEventStore {
  listDiscardedEvents(input: { workspaceId?: string; after?: string; limit: number }): Promise<DiscardedEventPage>;
  reprocess(event: StoredWebhook): Promise<IngestResult>;
  markMediaUnavailable(workspaceId: string, externalMessageId: string): Promise<void>;
}
export type ConversationIdentity = { displayName: string | null; phone: string | null; pushName: string | null; profileName: string | null; contactName?: string | null; avatarUrl: string | null; lastSyncAt: string | null; syncStatus: 'pending' | 'synced'; knownContact: boolean };
export type ConversationStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'archived';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ConversationEventAction = 'assigned' | 'unassigned' | 'status_changed' | 'priority_changed' | 'archived' | 'reopened';
export type ConversationEvent = { id: string; conversationId: string; workspaceId: string; userId: string; action: ConversationEventAction; previousValue: string | null; newValue: string | null; createdAt: string };
/** `whatsappSessionActive` não vem do banco: é decidido por requisição contra a
 *  lista de sessões que a WAHA ainda conhece. Ausente significa "não perguntei",
 *  e o consumidor deve tratar como ativa — ver
 *  `whatsapp-session-activity.service.ts`. */
export type ConversationSummary = { id: string; workspaceId: string; whatsappSessionId: string; whatsappSessionActive?: boolean; chatId: string; deliveryChatId?: string; contactId: string | null; conversationType: 'direct' | 'group'; assignedUserId: string | null; assignedTeamId: string | null; assignedAt: string | null; routingQueueId: string | null; autoAssignedAt: string | null; routingLockedAt: string | null; status: ConversationStatus; priority: ConversationPriority; lastStatusChange: string | null; lastMessage: string | null; lastMessageAt: string; unreadCount: number; createdAt: string; updatedAt: string; identity: ConversationIdentity };
export type InboxMessage = { id: string; direction: 'inbound' | 'outbound'; content: string | null; timestamp: string; status: 'sending' | 'received' | 'sent' | 'delivered' | 'read' | 'failed'; messageType: string; chatId: string; senderWhatsappId?: string | null; mediaUrl?: string | null; mediaMimeType?: string | null; mediaFilename?: string | null; mediaSize?: number | null; thumbnailUrl?: string | null; duration?: number | null; quotedMessageId?: string | null; metadata: Record<string, unknown>; reactions?: MessageReaction[] };
export type CursorPage<T> = { items: T[]; page: number; pageSize: number; total: number; nextCursor: string | null; hasMore: boolean };
/** Escopo de leitura de um agent na Inbox: conversa sem departamento, do time
 *  dele ou atribuída diretamente a ele. Ausente/`null` = sem filtro (owner,
 *  admin e manager veem tudo). Resolvido por requisição em
 *  `conversation-visibility.service.ts`. */
export type ConversationVisibilityFilter = { teamIds: string[]; userId: string };
export interface ConversationStore { listConversations(workspaceId: string, page: number, pageSize: number, cursor?: string, search?: string, visibility?: ConversationVisibilityFilter | null): Promise<CursorPage<ConversationSummary>>; callPeerNames(workspaceId: string, chatIds: readonly string[]): Promise<Map<string, string>>; ownSessionPhones(workspaceId: string): Promise<Array<{ wahaSession: string; phone: string }>>; findConversationByChat(workspaceId: string, chatIds: readonly string[]): Promise<{ wahaSession: string; chatId: string } | undefined>; listQuarantined(workspaceId: string, page: number, pageSize: number): Promise<{ items: ConversationSummary[]; page: number; pageSize: number; total: number }>; restoreConversation(workspaceId: string, conversationId: string): Promise<boolean>; quarantineCount(workspaceId: string): Promise<number>; getConversation(workspaceId: string, conversationId: string): Promise<ConversationSummary | undefined>; listGroupParticipants(workspaceId: string, conversationId: string): Promise<GroupParticipant[] | undefined>; listMessages(workspaceId: string, conversationId: string, page: number, pageSize: number, cursor?: string): Promise<CursorPage<InboxMessage>>; getMedia(workspaceId: string, messageId: string): Promise<{ url: string; mimeType: string | null; filename: string | null; storagePath?: string | null } | undefined>; markRead(workspaceId: string, conversationId: string): Promise<boolean>; linkContact(workspaceId: string, conversationId: string, contactId: string): Promise<ConversationSummary | undefined>; recordOutbound(input: { workspaceId: string; wahaSession: string; chatId: string; externalMessageId: string; text: string | null; occurredAt: string; type?: string; payload?: Record<string, unknown> }): Promise<PersistedOutboundMessage>; setAssignment(workspaceId: string, conversationId: string, assignedUserId: string | null, actorUserId: string): Promise<ConversationEvent | undefined>; setTeamAssignment(workspaceId: string, conversationId: string, assignedTeamId: string | null, actorUserId: string): Promise<ConversationEvent | undefined>; setStatus(workspaceId: string, conversationId: string, status: ConversationStatus, actorUserId: string): Promise<ConversationEvent | undefined>; setPriority(workspaceId: string, conversationId: string, priority: ConversationPriority, actorUserId: string): Promise<ConversationEvent | undefined>; listActivity(workspaceId: string, conversationId: string): Promise<ConversationEvent[] | undefined>; }
export function parseWebhook(value: unknown): WahaWebhookEvent { return webhookSchema.parse(value); }

export function verifyWahaWebhook(rawBody: Buffer, headers: { hmac?: string; algorithm?: string; timestamp?: string }, key?: string): void {
  if (!key) throw new WahaWebhookValidationError(503, 'WAHA webhook authentication is not configured');
  if (headers.algorithm?.toLowerCase() !== 'sha512' || !headers.hmac || !/^[a-f0-9]{128}$/i.test(headers.hmac)) throw new WahaWebhookValidationError(401, 'WAHA webhook signature is invalid');
  const expected = createHmac('sha512', key).update(rawBody).digest(); const provided = Buffer.from(headers.hmac, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new WahaWebhookValidationError(401, 'WAHA webhook signature is invalid');
  const sentAt = Number(headers.timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(Date.now() - sentAt) > 10 * 60_000) throw new WahaWebhookValidationError(401, 'WAHA webhook timestamp is invalid');
}
export class WahaWebhookValidationError extends Error { constructor(readonly status: number, message: string) { super(message); this.name = 'WahaWebhookValidationError'; } }

export class SqliteWahaWebhookStore implements WahaWebhookStore, ConversationStore, ReactionStore {
  private readonly contacts: SqliteContactIdentityResolver;
  constructor(private readonly database: SqliteDatabase, private readonly automation?: KanbanAutomationCoordinator, private readonly ownWhatsappNumbers: readonly string[] = [], private readonly sla?: SlaMessageCoordinator) { this.contacts = new SqliteContactIdentityResolver(database); }
  async ingest(event: StoredWebhook): Promise<IngestResult> { return this.persistEvent(event, { storeEvent: true, sideEffects: true }); }
  async reprocess(event: StoredWebhook): Promise<IngestResult> { return this.persistEvent(event, { storeEvent: false, sideEffects: false }); }
  /** Nomes WAHA que já enviaram mensagem direta (`from` = número próprio), com
   *  o telefone de cada um. É a memória cross-máquina da conta: permite adoção
   *  por número sem migration nem tabela de sessões. */
  async ownSessionPhones(workspaceId: string): Promise<Array<{ wahaSession: string; phone: string }>> {
    const rows = this.database.prepare("SELECT DISTINCT wahaSession, json_extract(payloadJson, '$.from') AS sender FROM whatsapp_messages WHERE workspaceId = ? AND direction = 'outbound' AND chatId LIKE '%@c.us'").all(workspaceId) as Array<{ wahaSession: string; sender: string | null }>;
    return rows.flatMap(row => { const phone = ownPhoneFromSender(row.sender); return phone ? [{ wahaSession: row.wahaSession, phone }] : []; });
  }
  /** Nomes de exibição em lote para uma lista de chatIds (tela Chamadas):
   *  nome do contato (CRM) > nome WhatsApp > pushName. Uma query só — nada de
   *  N+1 por chamada do histórico. */
  async callPeerNames(workspaceId: string, chatIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>(); if (!chatIds.length) return names;
    const placeholders = chatIds.map(() => '?').join(',');
    const rows = this.database.prepare(`SELECT c.chatId, ct.displayName contactName, i.name identityName, i.pushName FROM conversations c LEFT JOIN contacts ct ON ct.workspaceId=c.workspaceId AND ct.id=c.contactId LEFT JOIN whatsapp_identities i ON i.workspaceId=c.workspaceId AND i.wahaSession=c.wahaSession AND (i.whatsappId=c.chatId OR i.canonicalWhatsappId=c.chatId) WHERE c.workspaceId=? AND c.chatId IN (${placeholders})`).all(workspaceId, ...chatIds) as Array<{ chatId: string; contactName: string | null; identityName: string | null; pushName: string | null }>;
    for (const row of rows) { const name = row.contactName ?? row.identityName ?? row.pushName; if (name && !names.has(row.chatId)) names.set(row.chatId, name); }
    // Sem conversa com aquele chatId (ex.: chamada atendida por LID), a
    // identidade ainda pode ter o nome — consulta direta como retaguarda.
    const missing = chatIds.filter(chatId => !names.has(chatId));
    if (missing.length) {
      const ph = missing.map(() => '?').join(',');
      const fallback = this.database.prepare(`SELECT whatsappId, name, pushName FROM whatsapp_identities WHERE workspaceId=? AND whatsappId IN (${ph})`).all(workspaceId, ...missing) as Array<{ whatsappId: string; name: string | null; pushName: string | null }>;
      for (const row of fallback) { const name = row.name ?? row.pushName; if (name) names.set(row.whatsappId, name); }
    }
    return names;
  }
  /** A conversa mais recente entre os chatIds candidatos — onde o registro de
   *  chamada é pendurado (CallLogService). */
  async findConversationByChat(workspaceId: string, chatIds: readonly string[]): Promise<{ wahaSession: string; chatId: string } | undefined> {
    if (!chatIds.length) return undefined;
    const placeholders = chatIds.map(() => '?').join(',');
    return this.database.prepare(`SELECT wahaSession, chatId FROM conversations WHERE workspaceId=? AND chatId IN (${placeholders}) ORDER BY lastMessageAt DESC LIMIT 1`).get(workspaceId, ...chatIds) as { wahaSession: string; chatId: string } | undefined;
  }
  async listDiscardedEvents(input: { workspaceId?: string; after?: string; limit: number }): Promise<DiscardedEventPage> {
    const rows = this.database.prepare(`SELECT e.workspaceId, e.wahaSession, e.externalEventId, e.eventType, e.occurredAt, e.payloadJson, e.receivedAt FROM waha_webhook_events e WHERE e.eventType IN ('message', 'message.any') AND (@workspaceId IS NULL OR e.workspaceId = @workspaceId) AND (@after IS NULL OR e.externalEventId > @after) AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.workspaceId = e.workspaceId AND m.externalEventId = e.externalEventId) ORDER BY e.externalEventId LIMIT @limit`).all({ workspaceId: input.workspaceId ?? null, after: input.after ?? null, limit: input.limit }) as Array<{ workspaceId: string; wahaSession: string; externalEventId: string; eventType: string; occurredAt: string; payloadJson: string; receivedAt: string }>;
    const events = rows.map(row => ({ workspaceId: row.workspaceId, wahaSession: row.wahaSession, externalEventId: row.externalEventId, eventType: row.eventType as StoredWebhook['eventType'], occurredAt: row.occurredAt, payload: JSON.parse(row.payloadJson) as Record<string, unknown>, receivedAt: row.receivedAt }));
    return { events, nextAfter: events.length === input.limit ? events[events.length - 1].externalEventId : null };
  }
  private async persistEvent(event: StoredWebhook, options: PersistOptions): Promise<IngestResult> {
    const payloadJson = JSON.stringify(sanitize(event.payload));
    try {
      let persisted: IngestResult = { duplicate: false, messageInserted: false };
      this.database.transaction(() => {
        if (options.storeEvent) this.database.prepare('INSERT INTO waha_webhook_events (workspaceId, wahaSession, externalEventId, eventType, occurredAt, payloadJson, receivedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.workspaceId, event.wahaSession, event.externalEventId, event.eventType, event.occurredAt, payloadJson, event.receivedAt);
        const parsed = messageFrom(event, this.ownWhatsappNumbers); const message = parsed ? this.normalize(parsed) : undefined; if (message) { const result = this.database.prepare('INSERT OR IGNORE INTO whatsapp_messages (workspaceId, wahaSession, externalMessageId, externalEventId, chatId, senderWhatsappId, direction, messageType, body, mediaUrl, mediaMimeType, mediaFilename, mediaSize, thumbnailUrl, duration, quotedMessageId, occurredAt, payloadJson, receivedAt, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(message.workspaceId, message.wahaSession, message.externalMessageId, message.externalEventId, message.chatId, message.senderWhatsappId, message.direction, message.messageType, message.body, message.mediaUrl, message.mediaMimeType, message.mediaFilename, message.mediaSize, message.thumbnailUrl, message.duration, message.quotedMessageId, message.occurredAt, JSON.stringify(sanitize(message.payload)), message.receivedAt, message.direction === 'inbound' ? 'received' : 'sent'); const conversationExisted = Boolean(this.database.prepare('SELECT 1 FROM conversations WHERE workspaceId=? AND wahaSession=? AND chatId=?').get(message.workspaceId, message.wahaSession, message.chatId)); this.upsertConversation(message); let conversation = this.database.prepare('SELECT id, visibilityState, lastMessageAt FROM conversations WHERE workspaceId=? AND wahaSession=? AND chatId=?').get(message.workspaceId, message.wahaSession, message.chatId) as { id: string; visibilityState: string; lastMessageAt: string } | undefined; if (!conversation) { this.upsertConversation(message); conversation = this.database.prepare('SELECT id, visibilityState, lastMessageAt FROM conversations WHERE workspaceId=? AND wahaSession=? AND chatId=?').get(message.workspaceId, message.wahaSession, message.chatId) as { id: string; visibilityState: string; lastMessageAt: string } | undefined; } persisted = { duplicate: false, messageInserted: result.changes > 0, messageType: message.messageType, conversationId: conversation?.id, messageId: message.externalMessageId, conversationChatId: message.chatId, conversationType: message.conversationType, senderWhatsappId: message.senderWhatsappId, direction: message.direction, historical: message.historical, technical: isTechnical(message), quarantined: conversation?.visibilityState === 'quarantined', lastMessageAt: conversation?.lastMessageAt ?? null, conversationCreated: !conversationExisted }; }
      })();
      log('info', 'Inbox message persistence completed', { correlationId: event.externalEventId, eventId: event.externalEventId, messageId: persisted.messageId ?? null, conversationId: persisted.conversationId ?? null, messageInserted: persisted.messageInserted, lastMessageUpdated: persisted.lastMessageAt === event.occurredAt, lastMessageAt: persisted.lastMessageAt ?? null });
      if (options.sideEffects && persisted.messageInserted && persisted.conversationId) {
        if (persisted.direction === 'inbound') await this.automation?.run({ workspaceId: event.workspaceId, conversationId: persisted.conversationId, messageId: persisted.messageId!, direction: 'inbound', historical: persisted.historical, visible: !persisted.quarantined, technical: persisted.technical, quarantined: persisted.quarantined });
        await this.sla?.run({ workspaceId: event.workspaceId, conversationId: persisted.conversationId, messageId: persisted.messageId!, direction: persisted.direction!, occurredAt: event.occurredAt, historical: Boolean(persisted.historical) });
      }
      return persisted;
    // `duplicate` é resposta do caminho de ingestão, onde a colisão esperada é a
    // do evento bruto reentregue pela WAHA. No reprocessamento esse INSERT nem
    // acontece, e `isUniqueError` casa com qualquer "constraint" — inclusive a
    // de chave estrangeira. Sem esta guarda, uma falha real de gravação seria
    // reportada como duplicata e sairia do relatório como `skipped`, que é o
    // jeito mais silencioso possível de perder trabalho num reparo de dez mil.
    } catch (error) { if (options.storeEvent && isUniqueError(error)) return { duplicate: true, messageInserted: false }; throw error; }
  }
  async listConversations(workspaceId: string, page: number, pageSize: number, cursor?: string, search?: string, visibility?: ConversationVisibilityFilter | null): Promise<CursorPage<ConversationSummary>> { const limit = Math.min(pageSize, 100); const parsed = cursorValue(cursor); const terms = search?.trim() ? `%${search.trim().replace(/[%_]/g, '\\$&')}%` : undefined; const where = ["c.workspaceId = ?", "c.visibilityState = 'visible'"]; const values: unknown[] = [workspaceId]; if (terms) { where.push("(c.chatId LIKE ? ESCAPE '\\' OR COALESCE(i.name, i.pushName, c.lastMessage, '') LIKE ? ESCAPE '\\')"); values.push(terms, terms); } // O filtro do agent entra no WHERE da página e do total: sem departamento,
  // do time dele ou atribuída a ele — e o IN vazio nem é montado.
  if (visibility) { where.push(`(c.assignedTeamId IS NULL OR c.assignedUserId = ?${visibility.teamIds.length ? ` OR c.assignedTeamId IN (${visibility.teamIds.map(() => '?').join(',')})` : ''})`); values.push(visibility.userId, ...visibility.teamIds); } const total = (this.database.prepare(`SELECT count(*) AS total FROM conversations c LEFT JOIN whatsapp_identities i ON i.workspaceId=c.workspaceId AND i.wahaSession=c.wahaSession AND i.whatsappId=c.chatId WHERE ${where.join(' AND ')}`).get(...values) as { total: number }).total; if (parsed) { where.push("(c.lastMessageAt < ? OR (c.lastMessageAt = ? AND c.id > ?))"); values.push(parsed.at, parsed.at, parsed.id); } const rows = this.rows(`WHERE ${where.join(' AND ')} ORDER BY c.lastMessageAt DESC, c.id ASC LIMIT ?`, ...values, limit + 1); const more = rows.length > limit; const items = rows.slice(0, limit).map(toConversationSummary); const last = items.at(-1); return { items, page, pageSize: limit, total, hasMore: more, nextCursor: more && last ? encodeCursor(last.lastMessageAt, last.id) : null }; }
  async listQuarantined(workspaceId: string, page: number, pageSize: number) { const total = (this.database.prepare("SELECT count(*) AS total FROM conversations WHERE workspaceId = ? AND visibilityState IN ('quarantined', 'technical')").get(workspaceId) as { total: number }).total; const rows = this.rows("WHERE c.workspaceId = ? AND c.visibilityState IN ('quarantined', 'technical') ORDER BY c.lastMessageAt DESC, c.id ASC LIMIT ? OFFSET ?", workspaceId, pageSize, (page - 1) * pageSize); return { items: rows.map(toConversationSummary), page, pageSize, total }; }
  async quarantineCount(workspaceId: string) { return (this.database.prepare("SELECT count(*) total FROM conversations WHERE workspaceId = ? AND visibilityState IN ('quarantined', 'technical')").get(workspaceId) as { total: number }).total; }
  async restoreConversation(workspaceId: string, conversationId: string) { return this.database.prepare("UPDATE conversations SET visibilityState = 'visible', integrityClassification = 'inconclusive', integrityReasonSafe = 'restored_manually', integrityReviewedAt = ?, updatedAt = ? WHERE workspaceId = ? AND id = ? AND visibilityState IN ('quarantined', 'technical')").run(new Date().toISOString(), new Date().toISOString(), workspaceId, conversationId).changes > 0; }
  async getConversation(workspaceId: string, conversationId: string) { const row = this.rows('WHERE c.workspaceId = ? AND c.id = ?', workspaceId, conversationId)[0]; return row ? toConversationSummary(row) : undefined; }
  private rows(where: string, ...values: unknown[]): ConversationRow[] { return this.database.prepare(`SELECT c.id, c.workspaceId, c.wahaSession whatsappSessionId, c.chatId, c.deliveryChatId, c.contactId, c.conversationType, c.assignedUserId, c.assignedTeamId, c.assignedAt, c.routingQueueId, c.autoAssignedAt, c.routingLockedAt, c.operationalStatus status, c.priority, c.lastStatusChange, c.lastMessage, c.lastMessageAt, c.unreadCount, c.createdAt, c.updatedAt, i.phone identityPhone, i.name profileName, i.pushName, i.profilePictureUrl identityAvatarUrl, i.updatedAt identityUpdatedAt, ct.displayName contactDisplayName, g.name groupName, g.pictureUrl groupPictureUrl, g.updatedAt groupUpdatedAt FROM conversations c LEFT JOIN whatsapp_identities i ON c.conversationType = 'direct' AND i.workspaceId = c.workspaceId AND i.wahaSession = c.wahaSession AND i.whatsappId = c.chatId LEFT JOIN contacts ct ON ct.workspaceId = c.workspaceId AND ct.id = c.contactId LEFT JOIN whatsapp_groups g ON c.conversationType = 'group' AND g.workspaceId = c.workspaceId AND g.wahaSession = c.wahaSession AND g.chatId = c.chatId ${where}`).all(...values) as ConversationRow[]; }
  async listMessages(workspaceId: string, conversationId: string, page: number, pageSize: number, cursor?: string): Promise<CursorPage<InboxMessage>> { const conversation = this.database.prepare('SELECT wahaSession, chatId, conversationType FROM conversations WHERE workspaceId = ? AND id = ?').get(workspaceId, conversationId) as { wahaSession: string; chatId: string; conversationType: 'direct' | 'group' } | undefined; const limit = conversation?.conversationType === 'group' ? Math.min(pageSize, 100) : 10_000; if (!conversation) return { items: [], page, pageSize: limit, total: 0, hasMore: false, nextCursor: null }; const parsed = conversation.conversationType === 'group' ? cursorValue(cursor) : undefined; const total = (this.database.prepare('SELECT count(*) AS total FROM whatsapp_messages WHERE workspaceId = ? AND wahaSession = ? AND chatId = ?').get(workspaceId, conversation.wahaSession, conversation.chatId) as { total: number }).total; const rows = this.database.prepare(`SELECT externalMessageId id, direction, body content, occurredAt timestamp, status, messageType, chatId, senderWhatsappId, mediaUrl, mediaMimeType, mediaFilename, mediaSize, thumbnailUrl, duration, quotedMessageId, payloadJson FROM whatsapp_messages WHERE workspaceId = ? AND wahaSession = ? AND chatId = ? ${parsed ? 'AND (occurredAt < ? OR (occurredAt = ? AND externalMessageId < ?))' : ''} ORDER BY occurredAt DESC, externalMessageId DESC LIMIT ?`).all(workspaceId, conversation.wahaSession, conversation.chatId, ...(parsed ? [parsed.at, parsed.at, parsed.id] : []), limit + 1) as Array<Omit<InboxMessage, 'metadata'> & { payloadJson: string }>; const more = conversation.conversationType === 'group' && rows.length > limit; const pageRows = rows.slice(0, limit); const last = pageRows.at(-1); return { items: pageRows.reverse().map(({ payloadJson, ...row }) => { const { metadata, reactions } = splitReactions(JSON.parse(payloadJson) as Record<string, unknown>); return { ...row, metadata, reactions }; }), page, pageSize: limit, total, hasMore: more, nextCursor: more && last ? encodeCursor(last.timestamp, last.id) : null }; }
  async getMedia(workspaceId: string, messageId: string) { return this.database.prepare('SELECT mediaUrl url, mediaMimeType mimeType, mediaFilename filename, mediaStoragePath storagePath FROM whatsapp_messages WHERE workspaceId = ? AND externalMessageId = ? AND mediaUrl IS NOT NULL').get(workspaceId, messageId) as { url: string; mimeType: string | null; filename: string | null; storagePath?: string | null } | undefined; }
  async persistMedia(input: { workspaceId: string; externalMessageId: string; storagePath: string; checksum: string; size: number; mimeType: string; filename: string }) { this.database.prepare("UPDATE whatsapp_messages SET mediaStoragePath = ?, mediaChecksum = ?, mediaSize = ?, mediaMimeType = ?, mediaFilename = ?, mediaPersistenceStatus = 'stored' WHERE workspaceId = ? AND externalMessageId = ?").run(input.storagePath, input.checksum, input.size, input.mimeType, input.filename, input.workspaceId, input.externalMessageId); }
  // O tipo vem do payload, não da coluna messageType: a coluna é decidida por
  // sniffing do mime e, justo quando o mime é genérico, ela vira 'document'.
  async pendingMedia(limit: number) { const rows = this.database.prepare("SELECT workspaceId, externalMessageId, mediaUrl url, mediaMimeType mimeType, mediaFilename filename, json_extract(payloadJson, '$.type') rootType, json_extract(payloadJson, '$._data.type') dataType FROM whatsapp_messages WHERE mediaUrl IS NOT NULL AND mediaStoragePath IS NULL AND mediaPersistenceStatus <> 'unavailable' LIMIT ?").all(limit) as Array<{ workspaceId: string; externalMessageId: string; url: string; mimeType: string | null; filename: string | null; rootType: string | null; dataType: string | null }>; return rows.map(({ rootType, dataType, ...media }) => ({ ...media, messageType: payloadMessageType(rootType, dataType) })); }
  async storedMediaWithGenericMime(limit: number) { const rows = this.database.prepare("SELECT workspaceId, externalMessageId, mediaStoragePath storagePath, mediaMimeType mimeType, json_extract(payloadJson, '$.type') rootType, json_extract(payloadJson, '$._data.type') dataType FROM whatsapp_messages WHERE mediaStoragePath IS NOT NULL AND mediaMimeType IN ('application/mp4', 'application/octet-stream') LIMIT ?").all(limit) as Array<{ workspaceId: string; externalMessageId: string; storagePath: string; mimeType: string | null; rootType: string | null; dataType: string | null }>; return rows.map(({ rootType, dataType, ...media }) => ({ ...media, messageType: payloadMessageType(rootType, dataType) })); }
  async updateMediaMime(workspaceId: string, externalMessageId: string, mimeType: string) { this.database.prepare('UPDATE whatsapp_messages SET mediaMimeType = ? WHERE workspaceId = ? AND externalMessageId = ?').run(mimeType, workspaceId, externalMessageId); }
  async markMediaUnavailable(workspaceId: string, externalMessageId: string) { this.database.prepare("UPDATE whatsapp_messages SET mediaPersistenceStatus = 'unavailable' WHERE workspaceId = ? AND externalMessageId = ? AND mediaStoragePath IS NULL").run(workspaceId, externalMessageId); }
  async markRead(workspaceId: string, conversationId: string): Promise<boolean> { return this.database.prepare('UPDATE conversations SET unreadCount = 0, updatedAt = ? WHERE workspaceId = ? AND id = ?').run(new Date().toISOString(), workspaceId, conversationId).changes > 0; }
  /** Binds a conversation to a contact now, instead of waiting for the next
   * inbound message to run identity resolution. */
  async linkContact(workspaceId: string, conversationId: string, contactId: string): Promise<ConversationSummary | undefined> { const changed = this.database.prepare('UPDATE conversations SET contactId = ?, updatedAt = ? WHERE workspaceId = ? AND id = ?').run(contactId, new Date().toISOString(), workspaceId, conversationId).changes > 0; return changed ? this.getConversation(workspaceId, conversationId) : undefined; }
  async listGroupParticipants(workspaceId: string, conversationId: string): Promise<GroupParticipant[] | undefined> {
    const conversation = this.database.prepare('SELECT wahaSession, chatId, conversationType FROM conversations WHERE workspaceId = ? AND id = ?').get(workspaceId, conversationId) as { wahaSession: string; chatId: string; conversationType: 'direct' | 'group' } | undefined;
    if (!conversation || conversation.conversationType !== 'group') return undefined;
    // `IS NOT 'left'` e não `!=`: o NULL de quem nunca teve papel registrado
    // precisa passar; só o ex-membro explícito fica de fora do autocomplete.
    const rows = this.database.prepare(`SELECT p.participantWhatsappId whatsappId, p.role, i.name identityName, i.pushName pushName, i.phone identityPhone, i.profilePictureUrl avatarUrl, c.displayName contactName FROM whatsapp_group_participants p JOIN whatsapp_groups g ON g.id = p.groupId AND g.workspaceId = ? AND g.wahaSession = ? AND g.chatId = ? LEFT JOIN whatsapp_identities i ON i.workspaceId = g.workspaceId AND i.wahaSession = g.wahaSession AND (i.whatsappId = p.participantWhatsappId OR i.canonicalWhatsappId = p.participantWhatsappId) LEFT JOIN contacts c ON c.workspaceId = g.workspaceId AND c.phoneNumber = substr(p.participantWhatsappId, 1, instr(p.participantWhatsappId, '@') - 1) WHERE p.role IS NOT 'left'`).all(workspaceId, conversation.wahaSession, conversation.chatId) as GroupParticipantRow[];
    const recents = this.database.prepare('SELECT senderWhatsappId author, MAX(occurredAt) lastAt FROM whatsapp_messages WHERE workspaceId = ? AND wahaSession = ? AND chatId = ? AND senderWhatsappId IS NOT NULL GROUP BY senderWhatsappId').all(workspaceId, conversation.wahaSession, conversation.chatId) as Array<{ author: string; lastAt: string }>;
    return assembleGroupParticipants(rows, new Map(recents.map(row => [row.author, row.lastAt])));
  }
  async recordOutbound(input: { workspaceId: string; wahaSession: string; chatId: string; externalMessageId: string; text: string | null; occurredAt: string; type?: string; payload?: Record<string, unknown> }): Promise<PersistedOutboundMessage> { const persistence = await this.ingest(outboundRecord(input)); return { id: input.externalMessageId, direction: 'outbound', content: input.text, timestamp: input.occurredAt, status: 'sent', messageType: input.type ?? 'text', chatId: input.chatId, senderWhatsappId: input.chatId, metadata: input.payload ?? {}, reactions: [], persistence }; }
  async messageReactions(workspaceId: string, wahaSession: string, messageId: string): Promise<MessageReaction[] | undefined> { const row = this.database.prepare('SELECT payloadJson FROM whatsapp_messages WHERE workspaceId = ? AND wahaSession = ? AND externalMessageId = ?').get(workspaceId, wahaSession, messageId) as { payloadJson: string } | undefined; if (!row) return undefined; return reactionEntries((JSON.parse(row.payloadJson) as Record<string, unknown>).reactions).map(toMessageReaction); }
  async ingestReaction(input: ReactionInput): Promise<ReactionIngestResult> {
    return this.database.transaction(() => {
      const row = this.database.prepare('SELECT payloadJson, chatId FROM whatsapp_messages WHERE workspaceId = ? AND wahaSession = ? AND externalMessageId = ?').get(input.workspaceId, input.wahaSession, input.messageId) as { payloadJson: string; chatId: string } | undefined;
      // Órfã: a reação chegou antes da mensagem-alvo, ou a mensagem foi
      // descartada. Não há fila de retry para reações — o próximo evento da
      // mesma mensagem reconstrói o estado, então a resposta é 202 sem publish.
      if (!row) return { action: 'orphan' as const, messageId: input.messageId, reactions: [] as MessageReaction[] };
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      const { entries, action } = reduceReactions(reactionEntries(payload.reactions), input);
      if (action !== 'noop') {
        if (entries.length) payload.reactions = entries; else delete payload.reactions;
        this.database.prepare('UPDATE whatsapp_messages SET payloadJson = ? WHERE workspaceId = ? AND wahaSession = ? AND externalMessageId = ?').run(JSON.stringify(payload), input.workspaceId, input.wahaSession, input.messageId);
      }
      const conversation = this.database.prepare('SELECT id FROM conversations WHERE workspaceId = ? AND wahaSession = ? AND chatId = ?').get(input.workspaceId, input.wahaSession, row.chatId) as { id: string } | undefined;
      return { action, conversationId: conversation?.id, messageId: input.messageId, reactions: entries.map(toMessageReaction) };
    })();
  }
  async setAssignment(workspaceId: string, conversationId: string, assignedUserId: string | null, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'assignedUserId', assignedUserId); }
  async setTeamAssignment(workspaceId: string, conversationId: string, assignedTeamId: string | null, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'assignedTeamId', assignedTeamId); }
  async setStatus(workspaceId: string, conversationId: string, status: ConversationStatus, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'operationalStatus', status); }
  async setPriority(workspaceId: string, conversationId: string, priority: ConversationPriority, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'priority', priority); }
  async listActivity(workspaceId: string, conversationId: string) { if (!this.database.prepare('SELECT 1 FROM conversations WHERE workspaceId = ? AND id = ?').get(workspaceId, conversationId)) return undefined; return this.database.prepare('SELECT id, conversationId, workspaceId, userId, action, previousValue, newValue, createdAt FROM conversation_events WHERE workspaceId = ? AND conversationId = ? ORDER BY createdAt DESC').all(workspaceId, conversationId) as ConversationEvent[]; }
  private change(workspaceId: string, conversationId: string, actorUserId: string, field: 'assignedUserId' | 'assignedTeamId' | 'operationalStatus' | 'priority', value: string | null): ConversationEvent | undefined { return this.database.transaction(() => { const current = this.database.prepare(`SELECT ${field} value FROM conversations WHERE workspaceId = ? AND id = ?`).get(workspaceId, conversationId) as { value: string | null } | undefined; if (!current) return undefined; if (current.value === value) return undefined; const now = new Date().toISOString(); const action: ConversationEventAction = field === 'assignedUserId' || field === 'assignedTeamId' ? (value ? 'assigned' : 'unassigned') : field === 'priority' ? 'priority_changed' : value === 'archived' ? 'archived' : current.value === 'archived' && value === 'open' ? 'reopened' : 'status_changed'; if (field === 'assignedUserId') this.database.prepare('UPDATE conversations SET assignedUserId = ?, assignedAt = ?, routingLockedAt = ?, updatedAt = ? WHERE workspaceId = ? AND id = ?').run(value, value ? now : null, now, now, workspaceId, conversationId); else if (field === 'assignedTeamId') this.database.prepare('UPDATE conversations SET assignedTeamId = ?, updatedAt = ? WHERE workspaceId = ? AND id = ?').run(value, now, workspaceId, conversationId); else if (field === 'operationalStatus') this.database.prepare('UPDATE conversations SET operationalStatus = ?, lastStatusChange = ?, updatedAt = ? WHERE workspaceId = ? AND id = ?').run(value, now, now, workspaceId, conversationId); else this.database.prepare('UPDATE conversations SET priority = ?, updatedAt = ? WHERE workspaceId = ? AND id = ?').run(value, now, workspaceId, conversationId); const event: ConversationEvent = { id: randomUUID(), conversationId, workspaceId, userId: actorUserId, action, previousValue: current.value, newValue: value, createdAt: now }; this.database.prepare('INSERT INTO conversation_events (id, conversationId, workspaceId, userId, action, previousValue, newValue, createdAt) VALUES (@id, @conversationId, @workspaceId, @userId, @action, @previousValue, @newValue, @createdAt)').run(event); return event; })(); }
  private normalize(message: StoredMessage): StoredMessage { if (message.conversationType === 'group') return message; const row = this.database.prepare('SELECT canonicalWhatsappId FROM whatsapp_identities WHERE workspaceId = ? AND wahaSession = ? AND whatsappId = ?').get(message.workspaceId, message.wahaSession, message.chatId) as { canonicalWhatsappId?: string | null } | undefined; const canonical = row?.canonicalWhatsappId || message.chatId; return { ...message, chatId: canonical, deliveryChatId: canonical.endsWith('@c.us') ? canonical : message.deliveryChatId }; }
  private upsertConversation(message: StoredMessage): void { if (message.conversationType === 'direct') void this.contacts.resolve({ workspaceId: message.workspaceId, identifier: message.chatId, source: 'waha_webhook' }); const contact = message.conversationType === 'direct' ? this.database.prepare("SELECT c.id FROM contact_identifiers i JOIN contacts c ON c.workspaceId=i.workspaceId AND c.id=i.contactId WHERE i.workspaceId=? AND i.identifier=? UNION ALL SELECT id FROM contacts WHERE workspaceId=? AND phoneNumber=? LIMIT 1").get(message.workspaceId, message.chatId.toLowerCase(), message.workspaceId, phoneFromDirectChat(message.chatId)) as { id?: string } | undefined : undefined; const now = message.receivedAt; this.database.prepare("INSERT INTO conversations (id, workspaceId, wahaSession, chatId, canonicalChatId, deliveryChatId, contactId, conversationType, status, lastMessage, lastMessageAt, unreadCount, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?) ON CONFLICT(workspaceId, wahaSession, chatId) DO UPDATE SET deliveryChatId = excluded.deliveryChatId, contactId = COALESCE(conversations.contactId, excluded.contactId), conversationType = excluded.conversationType, lastMessage = CASE WHEN excluded.lastMessageAt > conversations.lastMessageAt THEN excluded.lastMessage ELSE conversations.lastMessage END, lastMessageAt = MAX(conversations.lastMessageAt, excluded.lastMessageAt), unreadCount = CASE WHEN excluded.lastMessageAt > conversations.lastMessageAt THEN conversations.unreadCount + excluded.unreadCount ELSE conversations.unreadCount END, updatedAt = MAX(conversations.updatedAt, excluded.updatedAt)").run(randomUUID(), message.workspaceId, message.wahaSession, message.chatId, message.chatId, message.deliveryChatId, contact?.id ?? null, message.conversationType, messagePreview(message), message.occurredAt, message.historical ? 0 : message.direction === 'inbound' ? 1 : 0, now, now); }
}
export class SupabaseWahaWebhookStore implements WahaWebhookStore, ConversationStore, ReactionStore {
  private readonly contacts: SupabaseContactIdentityResolver;
  constructor(private readonly client: SupabaseClient, private readonly automation?: KanbanAutomationCoordinator, private readonly ownWhatsappNumbers: readonly string[] = [], private readonly sla?: SlaMessageCoordinator) { this.contacts = new SupabaseContactIdentityResolver(client); }
  async ingest(event: StoredWebhook): Promise<IngestResult> { return this.persistEvent(event, { storeEvent: true, sideEffects: true }); }
  async reprocess(event: StoredWebhook): Promise<IngestResult> { return this.persistEvent(event, { storeEvent: false, sideEffects: false }); }
  /** Mesma memória cross-máquina da versão SQLite; o PostgREST não tem DISTINCT,
   *  então a página recente é deduplicada aqui. */
  async ownSessionPhones(workspaceId: string): Promise<Array<{ wahaSession: string; phone: string }>> {
    const { data, error } = await this.client.from('whatsapp_messages').select('waha_session,sender:payload_json->>from').eq('workspace_id', workspaceId).eq('direction', 'outbound').like('chat_id', '%@c.us').order('received_at', { ascending: false }).limit(5000);
    if (error) throw error;
    const seen = new Set<string>(); const pairs: Array<{ wahaSession: string; phone: string }> = [];
    for (const row of (data ?? []) as Array<{ waha_session: string; sender: string | null }>) {
      const phone = ownPhoneFromSender(row.sender);
      const key = `${row.waha_session}:${phone}`;
      if (phone && !seen.has(key)) { seen.add(key); pairs.push({ wahaSession: row.waha_session, phone }); }
    }
    return pairs;
  }
  /** Mesma entrega da versão SQLite, em três consultas (conversa → contato,
   *  identidades WhatsApp) porque o PostgREST não embute joins soltos. */
  async callPeerNames(workspaceId: string, chatIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>(); if (!chatIds.length) return names;
    const { data, error } = await this.client.from('conversations').select('chat_id, contact_id').eq('workspace_id', workspaceId).in('chat_id', [...chatIds]);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ chat_id: string; contact_id: string | null }>;
    const contactIds = [...new Set(rows.map(row => row.contact_id).filter((value): value is string => Boolean(value)))];
    const contactNames = new Map<string, string>();
    if (contactIds.length) {
      const { data: contacts, error: contactError } = await this.client.from('contacts').select('id, display_name').eq('workspace_id', workspaceId).in('id', contactIds);
      if (contactError) throw contactError;
      for (const contact of (contacts ?? []) as Array<{ id: string; display_name: string | null }>) if (contact.display_name) contactNames.set(contact.id, contact.display_name);
    }
    const { data: identities, error: identityError } = await this.client.from('whatsapp_identities').select('whatsapp_id, canonical_whatsapp_id, name, push_name').eq('workspace_id', workspaceId).in('whatsapp_id', [...chatIds]);
    if (identityError) throw identityError;
    const waNames = new Map<string, string>();
    for (const identity of (identities ?? []) as Array<{ whatsapp_id: string; canonical_whatsapp_id: string | null; name: string | null; push_name: string | null }>) {
      const name = identity.name ?? identity.push_name;
      if (name) { waNames.set(identity.whatsapp_id, name); if (identity.canonical_whatsapp_id) waNames.set(identity.canonical_whatsapp_id, name); }
    }
    for (const row of rows) { const name = (row.contact_id ? contactNames.get(row.contact_id) : undefined) ?? waNames.get(row.chat_id); if (name && !names.has(row.chat_id)) names.set(row.chat_id, name); }
    // Retaguarda: peer sem conversa com aquele chatId (chamada por LID) ainda
    // pode ter nome na identidade.
    for (const chatId of chatIds) { if (!names.has(chatId)) { const name = waNames.get(chatId); if (name) names.set(chatId, name); } }
    return names;
  }
  /** Mesma entrega da versão SQLite. */
  async findConversationByChat(workspaceId: string, chatIds: readonly string[]): Promise<{ wahaSession: string; chatId: string } | undefined> {
    if (!chatIds.length) return undefined;
    const { data, error } = await this.client.from('conversations').select('waha_session, chat_id').eq('workspace_id', workspaceId).in('chat_id', [...chatIds]).order('last_message_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? { wahaSession: (data as { waha_session: string }).waha_session, chatId: (data as { chat_id: string }).chat_id } : undefined;
  }
  // O PostgREST não faz anti-junção, então ela é feita em duas chamadas: uma
  // página de eventos e uma pergunta sobre quais daqueles ids já têm mensagem.
  // O cursor devolvido é o último id *varrido*, não o último devolvido — senão
  // uma página inteira de eventos já persistidos faria a varredura parar neles.
  async listDiscardedEvents(input: { workspaceId?: string; after?: string; limit: number }): Promise<DiscardedEventPage> {
    const events: StoredWebhook[] = [];
    let after = input.after ?? null;
    // Só uma página vazia prova o fim. O PostgREST pode devolver menos linhas do
    // que o `limit` pedido — por teto de linhas do projeto ou por tamanho da
    // resposta, e estes eventos carregam o payload inteiro. Tratar página curta
    // como fim faz a varredura parar no meio e relatar `done: true`, que num
    // reparo de dez mil é a forma mais silenciosa de deixar trabalho para trás.
    let vazio = false;
    while (events.length < input.limit && !vazio) {
      const janela = input.limit * 2;
      let consulta = this.client.from('waha_webhook_events').select('workspace_id,waha_session,external_event_id,event_type,occurred_at,payload_json,received_at').in('event_type', ['message', 'message.any']).order('external_event_id', { ascending: true }).limit(janela);
      if (input.workspaceId) consulta = consulta.eq('workspace_id', input.workspaceId);
      if (after) consulta = consulta.gt('external_event_id', after);
      const { data, error } = await consulta; if (error) throw error;
      const pagina = (data ?? []) as Array<Record<string, any>>;
      if (!pagina.length) { vazio = true; break; }
      // O `in` vira filtro serializado na URL, e o PostgREST corta em ~16 KB de
      // header: 600 ids destes deram 19.916 caracteres e a chamada morreu. O
      // lote de 100 é o mesmo teto já justificado em `criticalSampleLimit`.
      const persistidos = new Set<string>();
      for (let inicio = 0; inicio < pagina.length; inicio += identifierBatch) {
        const ids = pagina.slice(inicio, inicio + identifierBatch).map(row => row.external_event_id);
        const { data: existentes, error: erroMensagem } = await this.client.from('whatsapp_messages').select('external_event_id').in('external_event_id', ids); if (erroMensagem) throw erroMensagem;
        for (const row of (existentes ?? []) as Array<{ external_event_id: string }>) persistidos.add(row.external_event_id);
      }
      // O cursor anda até a última linha *examinada*, nunca até o fim da página:
      // quando o laço para no limite pedido, as linhas seguintes não foram
      // olhadas, e avançar por cima delas as descartaria em silêncio. Foi assim
      // que uma varredura desta base achou 6.500 pendentes onde havia 10.481.
      for (const row of pagina) {
        if (events.length >= input.limit) break;
        after = row.external_event_id;
        if (persistidos.has(row.external_event_id)) continue;
        events.push({ workspaceId: row.workspace_id, wahaSession: row.waha_session, externalEventId: row.external_event_id, eventType: row.event_type as StoredWebhook['eventType'], occurredAt: row.occurred_at, payload: (row.payload_json ?? {}) as Record<string, unknown>, receivedAt: row.received_at });
      }
    }
    return { events, nextAfter: vazio ? null : after };
  }
  private async persistEvent(event: StoredWebhook, options: PersistOptions): Promise<IngestResult> {
    if (options.storeEvent) {
      const { error } = await this.client.from('waha_webhook_events').insert({ workspace_id: event.workspaceId, waha_session: event.wahaSession, external_event_id: event.externalEventId, event_type: event.eventType, occurred_at: event.occurredAt, payload_json: sanitize(event.payload), received_at: event.receivedAt });
      if (error) { if (error.code === '23505') return { duplicate: true, messageInserted: false }; throw error; }
    }
    const parsed = messageFrom(event, this.ownWhatsappNumbers); const message = parsed ? await this.normalize(parsed) : undefined; if (!message) return { duplicate: false, messageInserted: false };
    const { error: messageError } = await this.client.from('whatsapp_messages').insert({ workspace_id: message.workspaceId, waha_session: message.wahaSession, external_message_id: message.externalMessageId, external_event_id: message.externalEventId, chat_id: message.chatId, sender_whatsapp_id: message.senderWhatsappId, sender_contact_id: null, direction: message.direction, message_type: message.messageType, body: message.body, media_url: message.mediaUrl, media_mime_type: message.mediaMimeType, media_filename: message.mediaFilename, media_size: message.mediaSize, thumbnail_url: message.thumbnailUrl, duration: message.duration, quoted_message_id: message.quotedMessageId, occurred_at: message.occurredAt, payload_json: sanitize(message.payload), received_at: message.receivedAt, status: message.direction === 'inbound' ? 'received' : 'sent' });
    if (messageError && messageError.code !== '23505') throw messageError; const conversationCreated = await this.upsertConversation(message); let { data: conversation, error: conversationError } = await this.client.from('conversations').select('id,visibility_state,last_message_at').eq('workspace_id', message.workspaceId).eq('waha_session', message.wahaSession).eq('chat_id', message.chatId).maybeSingle(); if (conversationError) throw conversationError; if (!conversation) { await this.upsertConversation(message); ({ data: conversation, error: conversationError } = await this.client.from('conversations').select('id,visibility_state,last_message_at').eq('workspace_id', message.workspaceId).eq('waha_session', message.wahaSession).eq('chat_id', message.chatId).maybeSingle()); if (conversationError) throw conversationError; } const persisted: IngestResult = { duplicate: false, messageInserted: !messageError, messageType: message.messageType, conversationId: conversation?.id, messageId: message.externalMessageId, conversationChatId: message.chatId, conversationType: message.conversationType, senderWhatsappId: message.senderWhatsappId, direction: message.direction, historical: message.historical, technical: isTechnical(message), quarantined: conversation?.visibility_state === 'quarantined', lastMessageAt: conversation?.last_message_at ?? null, conversationCreated }; log('info', 'Inbox message persistence completed', { correlationId: event.externalEventId, eventId: event.externalEventId, messageId: persisted.messageId, conversationId: persisted.conversationId ?? null, messageInserted: persisted.messageInserted, lastMessageUpdated: persisted.lastMessageAt === event.occurredAt, lastMessageAt: persisted.lastMessageAt ?? null }); if (options.sideEffects && persisted.messageInserted && persisted.conversationId) { if (persisted.direction === 'inbound') await this.automation?.run({ workspaceId: event.workspaceId, conversationId: persisted.conversationId, messageId: persisted.messageId!, direction: 'inbound', historical: persisted.historical, visible: !persisted.quarantined, technical: persisted.technical, quarantined: persisted.quarantined }); await this.sla?.run({ workspaceId: event.workspaceId, conversationId: persisted.conversationId, messageId: persisted.messageId!, direction: persisted.direction!, occurredAt: event.occurredAt, historical: Boolean(persisted.historical) }); } return persisted;
  }
  async listConversations(workspaceId: string, page: number, pageSize: number, cursor?: string, search?: string, visibility?: ConversationVisibilityFilter | null): Promise<CursorPage<ConversationSummary>> { const limit = Math.min(pageSize, 100); const parsed = cursorValue(cursor); let request = this.client.from('conversations').select('id, workspace_id, waha_session, chat_id, delivery_chat_id, contact_id, conversation_type, assigned_user_id, assigned_team_id, assigned_at, routing_queue_id, auto_assigned_at, routing_locked_at, status, priority, last_status_change, last_message, last_message_at, unread_count, created_at, updated_at', { count: 'exact' }).eq('workspace_id', workspaceId).eq('visibility_state', 'visible').order('last_message_at', { ascending: false }).order('id', { ascending: true }).limit(limit + 1); if (parsed) request = request.or(`last_message_at.lt.${parsed.at},and(last_message_at.eq.${parsed.at},id.gt.${parsed.id})`); if (search?.trim()) request = request.or(`chat_id.ilike.%${search.trim()}%,last_message.ilike.%${search.trim()}%`); // Mesma regra do SQLite: cada `.or` vira um parâmetro próprio na URL e o
  // PostgREST os combina com AND — o filtro do agent vale junto com busca e cursor.
  if (visibility) request = request.or(`assigned_team_id.is.null,assigned_user_id.eq.${visibility.userId}${visibility.teamIds.length ? `,assigned_team_id.in.(${visibility.teamIds.join(',')})` : ''}`); const { data, error, count } = await request; if (error) throw error; const rows = (data ?? []) as RemoteConversation[]; const more = rows.length > limit; const items = await this.withIdentities(rows.slice(0, limit)); const last = items.at(-1); return { items, page, pageSize: limit, total: count ?? 0, hasMore: more, nextCursor: more && last ? encodeCursor(last.lastMessageAt, last.id) : null }; }
  async listQuarantined(workspaceId: string, page: number, pageSize: number) { const from = (page - 1) * pageSize; const { data, error, count } = await this.client.from('conversations').select('id, workspace_id, waha_session, chat_id, delivery_chat_id, contact_id, conversation_type, assigned_user_id, assigned_team_id, assigned_at, routing_queue_id, auto_assigned_at, routing_locked_at, status, priority, last_status_change, last_message, last_message_at, unread_count, created_at, updated_at', { count: 'exact' }).eq('workspace_id', workspaceId).in('visibility_state', ['quarantined', 'technical']).order('last_message_at', { ascending: false }).order('id', { ascending: true }).range(from, from + pageSize - 1); if (error) throw error; return { items: await this.withIdentities((data ?? []) as RemoteConversation[]), page, pageSize, total: count ?? 0 }; }
  async quarantineCount(workspaceId: string) { const { count, error } = await this.client.from('conversations').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).in('visibility_state', ['quarantined', 'technical']); if (error) throw error; return count ?? 0; }
  async restoreConversation(workspaceId: string, conversationId: string) { const now = new Date().toISOString(); const { data, error } = await this.client.from('conversations').update({ visibility_state: 'visible', integrity_classification: 'inconclusive', integrity_reason_safe: 'restored_manually', integrity_reviewed_at: now, updated_at: now }).eq('workspace_id', workspaceId).eq('id', conversationId).in('visibility_state', ['quarantined', 'technical']).select('id'); if (error) throw error; return (data?.length ?? 0) > 0; }
  async getConversation(workspaceId: string, conversationId: string) { const { data, error } = await this.client.from('conversations').select('id, workspace_id, waha_session, chat_id, delivery_chat_id, contact_id, conversation_type, assigned_user_id, assigned_team_id, assigned_at, routing_queue_id, auto_assigned_at, routing_locked_at, status, priority, last_status_change, last_message, last_message_at, unread_count, created_at, updated_at').eq('workspace_id', workspaceId).eq('id', conversationId).maybeSingle(); if (error) throw error; return data ? (await this.withIdentities([data as RemoteConversation]))[0] : undefined; }
  private async withIdentities(rows: RemoteConversation[]): Promise<ConversationSummary[]> { if (!rows.length) return []; const encontrado = await remoteIdentityLookup(this.client, rows); return rows.map(row => toRemoteConversationSummary(row, encontrado.identity(row), encontrado.group(row), encontrado.contact(row))); }
  async listMessages(workspaceId: string, conversationId: string, page: number, pageSize: number, cursor?: string): Promise<CursorPage<InboxMessage>> { const { data: conversation, error: conversationError } = await this.client.from('conversations').select('waha_session, chat_id, conversation_type').eq('workspace_id', workspaceId).eq('id', conversationId).maybeSingle(); if (conversationError) throw conversationError; const limit = conversation?.conversation_type === 'group' ? Math.min(pageSize, 100) : 10_000; if (!conversation) return { items: [], page, pageSize: limit, total: 0, hasMore: false, nextCursor: null }; const parsed = conversation.conversation_type === 'group' ? cursorValue(cursor) : undefined; const result = await this.messageRows(workspaceId, conversation.waha_session, conversation.chat_id, 0, limit + 1, true, parsed); if (result.error && !missingMediaColumns(result.error)) throw result.error; const fallback = result.error ? await this.messageRows(workspaceId, conversation.waha_session, conversation.chat_id, 0, limit + 1, false, parsed) : result; if (fallback.error) throw fallback.error; const rows = (fallback.data ?? []) as unknown as RemoteMessageRow[]; const more = conversation.conversation_type === 'group' && rows.length > limit; const selected = rows.slice(0, limit); const last = selected.at(-1); return { items: selected.reverse().map(row => { const { metadata, reactions } = splitReactions((row.payload_json ?? {}) as Record<string, unknown>); return { id: row.external_message_id, direction: row.direction, content: row.body, timestamp: row.occurred_at, status: row.status, messageType: row.message_type, chatId: row.chat_id, senderWhatsappId: row.sender_whatsapp_id, mediaUrl: row.media_url ?? null, mediaMimeType: row.media_mime_type ?? null, mediaFilename: row.media_filename ?? null, mediaSize: row.media_size ?? null, thumbnailUrl: row.thumbnail_url ?? null, duration: row.duration ?? null, quotedMessageId: row.quoted_message_id ?? null, metadata, reactions }; }) as InboxMessage[], page, pageSize: limit, total: fallback.count ?? 0, hasMore: more, nextCursor: more && last ? encodeCursor(last.occurred_at, last.external_message_id) : null }; }
  async getMedia(workspaceId: string, messageId: string) { const { data, error } = await this.client.from('whatsapp_messages').select('media_url, media_mime_type, media_filename, media_storage_path').eq('workspace_id', workspaceId).eq('external_message_id', messageId).not('media_url', 'is', null).maybeSingle(); if (error) throw error; return data?.media_url ? { url: data.media_url, mimeType: data.media_mime_type, filename: data.media_filename, storagePath: data.media_storage_path } : undefined; }
  async persistMedia(input: { workspaceId: string; externalMessageId: string; storagePath: string; checksum: string; size: number; mimeType: string; filename: string }) { const { error } = await this.client.from('whatsapp_messages').update({ media_storage_path: input.storagePath, media_checksum: input.checksum, media_size: input.size, media_mime_type: input.mimeType, media_filename: input.filename, media_persistence_status: 'stored' }).eq('workspace_id', input.workspaceId).eq('external_message_id', input.externalMessageId); if (error) throw error; }
  // Mesma regra do SQLite: o tipo vem do payload, não da coluna message_type.
  async pendingMedia(limit: number) { const { data, error } = await this.client.from('whatsapp_messages').select('workspace_id, external_message_id, media_url, media_mime_type, media_filename, root_type:payload_json->>type, data_type:payload_json->_data->>type').not('media_url', 'is', null).is('media_storage_path', null).neq('media_persistence_status', 'unavailable').limit(limit); if (error) throw error; return (data ?? []).map(row => ({ workspaceId: row.workspace_id, externalMessageId: row.external_message_id, url: row.media_url, mimeType: row.media_mime_type, filename: row.media_filename, messageType: payloadMessageType(row.root_type, row.data_type) })); }
  async storedMediaWithGenericMime(limit: number) { const { data, error } = await this.client.from('whatsapp_messages').select('workspace_id, external_message_id, media_storage_path, media_mime_type, root_type:payload_json->>type, data_type:payload_json->_data->>type').not('media_storage_path', 'is', null).in('media_mime_type', ['application/mp4', 'application/octet-stream']).limit(limit); if (error) throw error; return (data ?? []).map(row => ({ workspaceId: row.workspace_id, externalMessageId: row.external_message_id, storagePath: row.media_storage_path, mimeType: row.media_mime_type, messageType: payloadMessageType(row.root_type, row.data_type) })); }
  async updateMediaMime(workspaceId: string, externalMessageId: string, mimeType: string) { const { error } = await this.client.from('whatsapp_messages').update({ media_mime_type: mimeType }).eq('workspace_id', workspaceId).eq('external_message_id', externalMessageId); if (error) throw error; }
  async markMediaUnavailable(workspaceId: string, externalMessageId: string) { const { error } = await this.client.from('whatsapp_messages').update({ media_persistence_status: 'unavailable' }).eq('workspace_id', workspaceId).eq('external_message_id', externalMessageId).is('media_storage_path', null); if (error) throw error; }
  private messageRows(workspaceId: string, session: string, chatId: string, from: number, pageSize: number, includeMedia: boolean, cursor?: { at: string; id: string }) { let request = this.client.from('whatsapp_messages').select(includeMedia ? 'external_message_id, direction, body, occurred_at, status, message_type, chat_id, sender_whatsapp_id, payload_json, media_url, media_mime_type, media_filename, media_size, thumbnail_url, duration, quoted_message_id' : 'external_message_id, direction, body, occurred_at, status, message_type, chat_id, sender_whatsapp_id, payload_json', { count: 'exact' }).eq('workspace_id', workspaceId).eq('waha_session', session).eq('chat_id', chatId).order('occurred_at', { ascending: false }).order('external_message_id', { ascending: false }).range(from, from + pageSize - 1); if (cursor) request = request.or(`occurred_at.lt.${cursor.at},and(occurred_at.eq.${cursor.at},external_message_id.lt.${cursor.id})`); return request; }
  async markRead(workspaceId: string, conversationId: string): Promise<boolean> { const { data, error } = await this.client.from('conversations').update({ unread_count: 0, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', conversationId).select('id'); if (error) throw error; return (data?.length ?? 0) > 0; }
  async linkContact(workspaceId: string, conversationId: string, contactId: string): Promise<ConversationSummary | undefined> { const { data, error } = await this.client.from('conversations').update({ contact_id: contactId, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', conversationId).select('id'); if (error) throw error; return (data?.length ?? 0) > 0 ? this.getConversation(workspaceId, conversationId) : undefined; }
  async listGroupParticipants(workspaceId: string, conversationId: string): Promise<GroupParticipant[] | undefined> {
    const { data: conversation, error } = await this.client.from('conversations').select('waha_session, chat_id, conversation_type').eq('workspace_id', workspaceId).eq('id', conversationId).maybeSingle();
    if (error) throw error;
    if (!conversation || conversation.conversation_type !== 'group') return undefined;
    const { data: group, error: groupError } = await this.client.from('whatsapp_groups').select('id').eq('workspace_id', workspaceId).eq('waha_session', conversation.waha_session).eq('chat_id', conversation.chat_id).maybeSingle();
    if (groupError) throw groupError;
    if (!group) return [];
    // `.or` e não `.neq`: NULL não passa no `neq` do PostgREST, e participante
    // sem papel registrado continua elegível; 'left' é ex-membro e fica de fora.
    const { data: participants, error: participantsError } = await this.client.from('whatsapp_group_participants').select('participant_whatsapp_id, role').eq('group_id', group.id).or('role.is.null,role.neq.left');
    if (participantsError) throw participantsError;
    const list = (participants ?? []) as Array<{ participant_whatsapp_id: string; role: string | null }>;
    if (!list.length) return [];
    const ids = [...new Set(list.map(row => row.participant_whatsapp_id))];
    const phones = ids.map(id => id.split('@', 1)[0]);
    // Tudo em lote, no padrão do remoteIdentityLookup: identidade por JID e por
    // canônico (LIDs), contato pelo telefone, recência pelas 300 últimas mensagens.
    const [identityResult, canonicalResult, contactResult, activityResult] = await Promise.all([
      this.client.from('whatsapp_identities').select('whatsapp_id, name, push_name, phone, profile_picture_url').eq('workspace_id', workspaceId).eq('waha_session', conversation.waha_session).in('whatsapp_id', ids),
      this.client.from('whatsapp_identities').select('canonical_whatsapp_id, name, push_name, phone, profile_picture_url').eq('workspace_id', workspaceId).eq('waha_session', conversation.waha_session).in('canonical_whatsapp_id', ids),
      this.client.from('contacts').select('display_name, phone_number').eq('workspace_id', workspaceId).in('phone_number', phones),
      this.client.from('whatsapp_messages').select('sender_whatsapp_id, occurred_at').eq('workspace_id', workspaceId).eq('waha_session', conversation.waha_session).eq('chat_id', conversation.chat_id).not('sender_whatsapp_id', 'is', null).order('occurred_at', { ascending: false }).limit(300),
    ]);
    if (identityResult.error) throw identityResult.error;
    if (canonicalResult.error) throw canonicalResult.error;
    if (contactResult.error) throw contactResult.error;
    if (activityResult.error) throw activityResult.error;
    const byId = new Map(((identityResult.data ?? []) as any[]).map(row => [row.whatsapp_id, row]));
    const byCanonical = new Map(((canonicalResult.data ?? []) as any[]).map(row => [row.canonical_whatsapp_id, row]));
    const byPhone = new Map(((contactResult.data ?? []) as any[]).map(row => [row.phone_number, row.display_name]));
    const lastActive = new Map<string, string>();
    for (const row of (activityResult.data ?? []) as any[]) if (row.sender_whatsapp_id && !lastActive.has(row.sender_whatsapp_id)) lastActive.set(row.sender_whatsapp_id, row.occurred_at);
    const rows: GroupParticipantRow[] = list.map(row => {
      const identity = byId.get(row.participant_whatsapp_id) ?? byCanonical.get(row.participant_whatsapp_id);
      return { whatsappId: row.participant_whatsapp_id, role: row.role, identityName: identity?.name ?? null, pushName: identity?.push_name ?? null, identityPhone: identity?.phone ?? null, avatarUrl: identity?.profile_picture_url ?? null, contactName: byPhone.get(row.participant_whatsapp_id.split('@', 1)[0]) ?? null };
    });
    return assembleGroupParticipants(rows, lastActive);
  }
  async recordOutbound(input: { workspaceId: string; wahaSession: string; chatId: string; externalMessageId: string; text: string | null; occurredAt: string; type?: string; payload?: Record<string, unknown> }): Promise<PersistedOutboundMessage> { const persistence = await this.ingest(outboundRecord(input)); return { id: input.externalMessageId, direction: 'outbound', content: input.text, timestamp: input.occurredAt, status: 'sent', messageType: input.type ?? 'text', chatId: input.chatId, senderWhatsappId: input.chatId, metadata: input.payload ?? {}, reactions: [], persistence }; }
  async messageReactions(workspaceId: string, wahaSession: string, messageId: string): Promise<MessageReaction[] | undefined> { const { data, error } = await this.client.from('whatsapp_messages').select('payload_json').eq('workspace_id', workspaceId).eq('waha_session', wahaSession).eq('external_message_id', messageId).maybeSingle(); if (error) throw error; if (!data) return undefined; return reactionEntries(((data.payload_json ?? {}) as Record<string, unknown>).reactions).map(toMessageReaction); }
  async ingestReaction(input: ReactionInput): Promise<ReactionIngestResult> {
    // Leitura + escrita sem transação no PostgREST: duas reações simultâneas na
    // mesma mensagem disputam uma janela curta, e o LWW por `reactedAt` faz o
    // estado final convergir no evento seguinte. Transação de verdade exigiria
    // RPC — mudança de schema, fora do escopo.
    const { data: row, error } = await this.client.from('whatsapp_messages').select('payload_json, chat_id').eq('workspace_id', input.workspaceId).eq('waha_session', input.wahaSession).eq('external_message_id', input.messageId).maybeSingle();
    if (error) throw error;
    if (!row) return { action: 'orphan', messageId: input.messageId, reactions: [] };
    const payload = (row.payload_json ?? {}) as Record<string, unknown>;
    const { entries, action } = reduceReactions(reactionEntries(payload.reactions), input);
    if (action !== 'noop') {
      if (entries.length) payload.reactions = entries; else delete payload.reactions;
      const { error: updateError } = await this.client.from('whatsapp_messages').update({ payload_json: payload }).eq('workspace_id', input.workspaceId).eq('waha_session', input.wahaSession).eq('external_message_id', input.messageId);
      if (updateError) throw updateError;
    }
    const { data: conversation, error: conversationError } = await this.client.from('conversations').select('id').eq('workspace_id', input.workspaceId).eq('waha_session', input.wahaSession).eq('chat_id', row.chat_id).maybeSingle();
    if (conversationError) throw conversationError;
    return { action, conversationId: conversation?.id as string | undefined, messageId: input.messageId, reactions: entries.map(toMessageReaction) };
  }
  async setAssignment(workspaceId: string, conversationId: string, assignedUserId: string | null, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'assigned_user_id', assignedUserId); }
  async setTeamAssignment(workspaceId: string, conversationId: string, assignedTeamId: string | null, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'assigned_team_id', assignedTeamId); }
  async setStatus(workspaceId: string, conversationId: string, status: ConversationStatus, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'status', status); }
  async setPriority(workspaceId: string, conversationId: string, priority: ConversationPriority, actorUserId: string) { return this.change(workspaceId, conversationId, actorUserId, 'priority', priority); }
  async listActivity(workspaceId: string, conversationId: string) { const exists = await this.getConversation(workspaceId, conversationId); if (!exists) return undefined; const { data, error } = await this.client.from('conversation_events').select('id, conversation_id, workspace_id, user_id, action, previous_value, new_value, created_at').eq('workspace_id', workspaceId).eq('conversation_id', conversationId).order('created_at', { ascending: false }); if (error) throw error; return (data ?? []).map(row => ({ id: row.id, conversationId: row.conversation_id, workspaceId: row.workspace_id, userId: row.user_id, action: row.action, previousValue: row.previous_value, newValue: row.new_value, createdAt: row.created_at })) as ConversationEvent[]; }
  private async change(workspaceId: string, conversationId: string, actorUserId: string, field: 'assigned_user_id' | 'assigned_team_id' | 'status' | 'priority', value: string | null): Promise<ConversationEvent | undefined> { const { data, error: currentError } = await this.client.from('conversations').select(`id, ${field}`).eq('workspace_id', workspaceId).eq('id', conversationId).maybeSingle(); const current = data as Record<string, unknown> | null; if (currentError) throw currentError; if (!current || current[field] === value) return undefined; const now = new Date().toISOString(); const previousValue = current[field] as string | null; const action: ConversationEventAction = field === 'assigned_user_id' || field === 'assigned_team_id' ? (value ? 'assigned' : 'unassigned') : field === 'priority' ? 'priority_changed' : value === 'archived' ? 'archived' : previousValue === 'archived' && value === 'open' ? 'reopened' : 'status_changed'; const changes: Record<string, unknown> = { [field]: value, updated_at: now }; if (field === 'assigned_user_id') { changes.assigned_at = value ? now : null; changes.routing_locked_at = now; } if (field === 'status') changes.last_status_change = now; const { error } = await this.client.from('conversations').update(changes).eq('workspace_id', workspaceId).eq('id', conversationId); if (error) throw error; const event: ConversationEvent = { id: randomUUID(), conversationId, workspaceId, userId: actorUserId, action, previousValue, newValue: value, createdAt: now }; const { error: eventError } = await this.client.from('conversation_events').insert({ id: event.id, conversation_id: event.conversationId, workspace_id: event.workspaceId, user_id: event.userId, action: event.action, previous_value: event.previousValue, new_value: event.newValue, created_at: event.createdAt }); if (eventError) throw eventError; return event; }
  private async normalize(message: StoredMessage): Promise<StoredMessage> { if (message.conversationType === 'group') return message; const { data, error } = await this.client.from('whatsapp_identities').select('canonical_whatsapp_id').eq('workspace_id', message.workspaceId).eq('waha_session', message.wahaSession).eq('whatsapp_id', message.chatId).maybeSingle(); if (error) throw error; const canonical = data?.canonical_whatsapp_id || message.chatId; return { ...message, chatId: canonical, deliveryChatId: canonical.endsWith('@c.us') ? canonical : message.deliveryChatId }; }
  private async upsertConversation(message: StoredMessage): Promise<boolean> { const contact = message.conversationType === 'direct' ? await this.contacts.resolve({ workspaceId: message.workspaceId, identifier: message.chatId, source: 'waha_webhook' }) : undefined; const { data: existing, error: existingError } = await this.client.from('conversations').select('id, contact_id, unread_count, last_message_at, last_message, last_status_change, updated_at').eq('workspace_id', message.workspaceId).eq('waha_session', message.wahaSession).eq('chat_id', message.chatId).maybeSingle(); if (existingError) throw existingError; const newer = !existing || message.occurredAt > existing.last_message_at; const incrementUnread = newer && !message.historical && message.direction === 'inbound' ? 1 : 0; const row = { workspace_id: message.workspaceId, waha_session: message.wahaSession, chat_id: message.chatId, canonical_chat_id: message.chatId, delivery_chat_id: message.deliveryChatId, contact_id: existing?.contact_id ?? contact?.id ?? null, conversation_type: message.conversationType, status: 'open', last_status_change: existing?.last_status_change ?? message.occurredAt, last_message: newer ? messagePreview(message) : existing.last_message, last_message_at: newer ? message.occurredAt : existing.last_message_at, unread_count: (existing?.unread_count ?? 0) + incrementUnread, updated_at: newer ? message.receivedAt : existing!.updated_at }; const result = existing ? await this.client.from('conversations').update(row).eq('workspace_id', message.workspaceId).eq('id', existing.id) : await this.client.from('conversations').insert({ ...row, id: randomUUID(), created_at: message.receivedAt }); if (result.error) throw result.error; return !existing; }
}
export function webhookRecord(event: WahaWebhookEvent, workspaceId: string): StoredWebhook { const receivedAt = new Date().toISOString(); return { workspaceId, wahaSession: event.session, externalEventId: event.id, eventType: event.event, occurredAt: timestampFrom(event.payload.timestamp, new Date(event.timestamp).toISOString()), payload: event.payload, receivedAt }; }
export function historyRecord(workspaceId: string, wahaSession: string, payload: Record<string, unknown>, listedChatId?: string): StoredWebhook | undefined { const id = text(payload.id) ?? text(nested(payload, 'key', 'id')); const timestamp = timestampFrom(payload.timestamp, new Date().toISOString()); return id ? { workspaceId, wahaSession, externalEventId: `history:${id}`, eventType: 'message.any', occurredAt: timestamp, payload: { ...payload, ...(listedChatId ? { chatId: listedChatId, _historyChatId: listedChatId } : {}), _history: true }, receivedAt: new Date().toISOString() } : undefined; }
/**
 * An outbound send is replayed as the `message.any` it would have been, so it
 * goes through the same normalisation, quarantine and automation as anything
 * arriving from WhatsApp. `type` and `payload` are what let a send that is not
 * text reuse all of it: `mediaType` passes any non-text type through verbatim,
 * so the stored `messageType` is whatever the caller declares, and the extra
 * payload lands in `payloadJson` — no column and no migration for coordinates.
 */
function outboundRecord(input: { workspaceId: string; wahaSession: string; chatId: string; externalMessageId: string; text: string | null; occurredAt: string; type?: string; payload?: Record<string, unknown> }): StoredWebhook { return { workspaceId: input.workspaceId, wahaSession: input.wahaSession, externalEventId: `outbound:${input.externalMessageId}`, eventType: 'message.any', occurredAt: input.occurredAt, payload: { id: input.externalMessageId, chatId: input.chatId, body: input.text, type: input.type ?? 'text', fromMe: true, ...(input.payload ?? {}) }, receivedAt: new Date().toISOString() }; }
/** O evento `message.reaction` não é mensagem: não gera linha em
 *  `whatsapp_messages` nem em `waha_webhook_events` — o CHECK de `eventType`
 *  só conhece os três tipos originais, então o controller o desvia antes do
 *  `ingest`. O alvo é `reaction.messageId`, no mesmo formato gravado como
 *  `externalMessageId`, e `reaction.text` vazio é remoção — por isso o emoji
 *  não passa por `text()`, que descarta strings vazias. */
export function reactionFrom(event: StoredWebhook): ReactionInput | undefined {
  if (event.eventType !== 'message.reaction') return undefined;
  const reaction = record(event.payload.reaction);
  const messageId = text(reaction?.messageId);
  const emoji = typeof reaction?.text === 'string' ? reaction.text.slice(0, 32) : undefined;
  const fromMe = event.payload.fromMe === true || nested(event.payload, 'key', 'fromMe') === true;
  const from = text(event.payload.from);
  const author = text(event.payload.participant) ?? text(nested(event.payload, 'key', 'participant')) ?? (fromMe ? 'me' : from && !from.endsWith('@g.us') ? from : undefined);
  if (!messageId || emoji === undefined || !author) { log('info', 'WAHA reaction discarded', { eventId: event.externalEventId, messageId: messageId ?? null, discardReason: !messageId ? 'missing_target_message_id' : emoji === undefined ? 'missing_reaction_text' : 'indeterminate_author', messageInserted: false }); return undefined; }
  return { workspaceId: event.workspaceId, wahaSession: event.wahaSession, messageId, author, authorName: text(event.payload.pushName) ?? text(event.payload.notifyName) ?? null, emoji, fromMe, reactedAt: event.occurredAt };
}
function ownPhoneFromSender(sender: string | null): string | null { if (!sender || !sender.endsWith('@c.us')) return null; const phone = sender.split('@', 1)[0]!.split(':', 1)[0]!.replace(/\D/g, ''); return phone.length >= 8 && phone.length <= 15 ? phone : null; }
function messageFrom(event: StoredWebhook, ownWhatsappNumbers: readonly string[] = []): StoredMessage | undefined { if (event.eventType !== 'message' && event.eventType !== 'message.any') return undefined; const value = event.payload; const id = text(value.id) ?? text(nested(value, 'key', 'id')); const direction = value.fromMe === true ? 'outbound' : 'inbound'; const lockedHistoryChatId = value._history === true ? text(value._historyChatId) : undefined; const receivedChatId = lockedHistoryChatId ?? chatIdFromPayload(value, direction); const media = record(value.media); const mime = mimeFrom(value, media); const wahaType = wahaMessageType(value); const messageType = mediaType(text(value.type), mime, value.hasMedia === true, wahaType); const identity = resolveConversationIdentity({ direction, chatId: receivedChatId, messageType: wahaType, ownWhatsappNumbers }); if (!id || !identity) { log('info', 'WAHA message discarded', { eventId: event.externalEventId, messageId: id ?? null, chatIdReceived: receivedChatId ?? null, chatIdNormalized: null, discardReason: !id ? 'missing_message_id' : !receivedChatId ? 'missing_chat_id' : isTechnicalMessageType(wahaType) ? 'technical_message_type' : 'invalid_or_technical_chat_id', wahaMessageType: wahaType ?? null, messageInserted: false, conversationId: null }); return undefined; } log('info', 'WAHA message normalized', { eventId: event.externalEventId, messageId: id, chatIdReceived: receivedChatId, chatIdNormalized: identity.conversationChatId, chatIdSource: chatIdSource(value, direction), discardReason: null }); return { ...event, externalMessageId: id, chatId: identity.conversationChatId, deliveryChatId: identity.deliveryChatId, conversationType: identity.conversationType, senderWhatsappId: identity.conversationType === 'group' ? text(value.participant) ?? text(nested(value, 'key', 'participant')) ?? null : identity.conversationChatId, direction, messageType, body: bodyFrom(messageType, wahaType, value), mediaUrl: safeUrl(text(media?.url) ?? text(value.mediaUrl)), mediaMimeType: mime ?? null, mediaFilename: text(media?.filename) ?? text(value.filename) ?? null, mediaSize: integer(media?.filesize) ?? integer(media?.size) ?? integer(value.mediaSize), thumbnailUrl: safeUrl(text(media?.thumbnailUrl) ?? text(value.thumbnailUrl)), duration: integer(media?.duration) ?? integer(value.duration), quotedMessageId: text(value.replyTo) ?? text(nested(value, 'quoted', 'id')) ?? null, historical: value._history === true }; }
function chatIdFromPayload(value: Record<string, unknown>, direction: 'inbound' | 'outbound'): string | undefined {
  // A participant identifies the author of a group message, never its chat.
  // Prefer explicit chat fields. When WAHA only provides remoteJid alongside a
  // participant, accept it exclusively if it is itself a group JID; otherwise
  // discard the ambiguous event rather than creating a private conversation.
  const explicit = [text(value.chatId), text(value.chat_id)].find(isChatIdentifier);
  if (explicit) return explicit;
  const remote = [text(value.remoteJid), text(value.remote_jid), text(nested(value, 'key', 'remoteJid')), text(nested(value, 'key', 'remote_jid'))].find(isChatIdentifier);
  const hasParticipant = Boolean(text(value.participant) || text(nested(value, 'key', 'participant')));
  if (remote?.endsWith('@g.us')) return remote;
  // Um JID de grupo endereça um chat e nunca um autor, então a ambiguidade que a
  // guarda de participante abaixo existe para resolver não se aplica a ele: se
  // `from` ou `to` traz um `@g.us`, aquele é o chat, com participante ou sem.
  //
  // Sem esta linha, todo evento de grupo cujo payload não traz `chatId` nem
  // `remoteJid` morre na guarda. É a forma que o WEBJS passou a mandar em
  // 2026-07-20 — `from` com o grupo, `participant` com o autor em `@lid`, e nada
  // mais —, e ela responde por 9.686 dos 10.372 descartes `missing_chat_id`
  // medidos em `waha_webhook_events`: 9.581 recebidas, pelo `from`, e 105
  // enviadas por nós, pelo `to`.
  const group = [text(value.from), text(value.to)].find(candidate => candidate?.endsWith('@g.us'));
  if (group) return group;
  if (hasParticipant) return undefined;
  if (remote) return remote;
  return direction === 'inbound' ? firstValid(value.from, value.sender, value.author) : firstValid(value.to);
}
function chatIdSource(value: Record<string, unknown>, direction: 'inbound' | 'outbound'): string { if (text(value.chatId)) return 'chatId'; if (text(value.chat_id)) return 'chat_id'; if (text(value.remoteJid) || text(value.remote_jid)) return 'remoteJid'; if (text(nested(value, 'key', 'remoteJid')) || text(nested(value, 'key', 'remote_jid'))) return 'key.remoteJid'; if ([text(value.from), text(value.to)].some(candidate => candidate?.endsWith('@g.us'))) return 'group_jid'; return direction === 'inbound' ? 'sender_fallback' : 'to_fallback'; }
function firstValid(...values: unknown[]): string | undefined { return values.map(text).find(isChatIdentifier); }
function isChatIdentifier(value: string | undefined): value is string { return Boolean(value && (value.endsWith('@c.us') || value.endsWith('@lid') || value.endsWith('@g.us'))); }
function isTechnical(message: StoredMessage): boolean { return isTechnicalMessageType(wahaMessageType(message.payload)) || message.chatId === 'status@broadcast'; }
/** `wahaMessageType` mora em conversation-identity.ts: media persistence, o
 * webhook e o descarte de evento técnico precisam responder a mesma pergunta, e
 * a cópia privada que existia aqui foi o que deixou o controller lendo só a raiz.
 *
 * As duas colunas vêm extraídas do payload pelo banco (json_extract no SQLite,
 * `->>` no PostgREST) para não trazer o payload inteiro por linha; a decisão de
 * qual delas vale continua sendo uma só, em `wahaMessageType`. */
function payloadMessageType(rootType: string | null, dataType: string | null): string | null { return wahaMessageType({ type: rootType ?? undefined, _data: { type: dataType ?? undefined } }) ?? null; }
function timestampFrom(value: unknown, fallback: string): string { const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined; if (numeric !== undefined && Number.isFinite(numeric)) return new Date(numeric < 100_000_000_000 ? numeric * 1_000 : numeric).toISOString(); if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString(); return fallback; }
function nested(value: Record<string, unknown>, key: string, child: string): unknown { const parent = value[key]; return parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[child] : undefined; }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value.slice(0, 20_000) : undefined; }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function integer(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeUrl(value: string | undefined): string | null { if (!value) return null; try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null; } catch { return null; } }
const maxMessageReactions = 100;
function reactionEntries(value: unknown): StoredReaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const entry = record(item);
    const author = text(entry?.author);
    const emoji = typeof entry?.emoji === 'string' ? entry.emoji : undefined;
    const reactedAt = text(entry?.reactedAt);
    if (!author || !emoji || !reactedAt) return [];
    return [{ author, authorName: text(entry?.authorName) ?? null, emoji, fromMe: entry?.fromMe === true, reactedAt }];
  });
}
function toMessageReaction(entry: StoredReaction): MessageReaction {
  return { emoji: entry.emoji, reactorWhatsappId: entry.fromMe ? null : entry.author, fromMe: entry.fromMe, reactorName: entry.authorName ?? null, reactorPhone: entry.fromMe ? null : phoneFromChat(entry.author) || null, reactedAt: entry.reactedAt };
}
/** Máquina de estado das reações, paridade com o WhatsApp Web: uma reação por
 *  autor; o mesmo emoji no mesmo autor é no-op (o toggle vira remoção no envio);
 *  emoji vazio remove; e qualquer escrita `fromMe` substitui TODAS as entradas
 *  `fromMe`, porque dashboard e telefone são a mesma conta no protocolo.
 *
 *  Eventos fora de ordem resolvem por LWW: a escrita cuja `reactedAt` — o
 *  timestamp do evento, não o da entrega — é mais antiga que a do autor (ou que
 *  a mais recente da conta, para `fromMe`) é descartada como `noop`, o que
 *  também torna a reentrega do mesmo evento idempotente. */
function reduceReactions(entries: StoredReaction[], input: ReactionInput): { entries: StoredReaction[]; action: ReactionAction } {
  const own = entries.find(entry => entry.author === input.author);
  const newestFromMe = input.fromMe ? entries.filter(entry => entry.fromMe).reduce<StoredReaction | undefined>((newest, entry) => !newest || entry.reactedAt > newest.reactedAt ? entry : newest, undefined) : undefined;
  const clock = [own?.reactedAt, newestFromMe?.reactedAt].filter((value): value is string => Boolean(value)).sort().at(-1);
  if (clock && input.reactedAt < clock) return { entries, action: 'noop' };
  const withoutAuthor = entries.filter(entry => entry.author !== input.author);
  let next = input.fromMe ? withoutAuthor.filter(entry => !entry.fromMe) : withoutAuthor;
  if (!input.emoji) return { entries: next, action: next.length !== entries.length ? 'removed' : 'noop' };
  next = [...next, { author: input.author, authorName: input.authorName ?? null, emoji: input.emoji, fromMe: input.fromMe, reactedAt: input.reactedAt }].sort((a, b) => a.reactedAt.localeCompare(b.reactedAt));
  if (next.length > maxMessageReactions) next = next.slice(next.length - maxMessageReactions);
  return { entries: next, action: !own ? 'inserted' : own.emoji === input.emoji && own.reactedAt === input.reactedAt ? 'noop' : 'updated' };
}
/** A chave `reactions` é reservada no payload da mensagem: sai de `metadata`
 *  na leitura para virar o campo explícito do contrato. */
function splitReactions(payload: Record<string, unknown>): { metadata: Record<string, unknown>; reactions: MessageReaction[] } {
  const { reactions: raw, ...metadata } = payload;
  return { metadata, reactions: reactionEntries(raw).map(toMessageReaction) };
}
function encodeCursor(at: string, id: string) { return Buffer.from(JSON.stringify({ at, id })).toString('base64url'); }
function cursorValue(cursor?: string): { at: string; id: string } | undefined { if (!cursor) return undefined; try { const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); return typeof value.at === 'string' && typeof value.id === 'string' && !Number.isNaN(Date.parse(value.at)) && value.id ? value : undefined; } catch { return undefined; } }
/** The raw WhatsApp type distinguishes a recorded note (`ptt`) from a music file
 *  (`audio`); the stored vocabulary did not, and every one of them landed as
 *  `audio`. Measured on the live base: of 116 audio rows, 114 carry `_data.type`
 *  `ptt` and 2 carry `audio` — the distinction was always in the payload, only
 *  never read, because this function was given `value.type` and WAHA/WEBJS leaves
 *  the payload root empty.
 *
 *  `rawType` is consulted for exactly one decision and never returned as-is. It
 *  cannot replace the normalisation: the raw vocabulary is WhatsApp's own, and
 *  adopting it wholesale would rewrite 5.846 of 6.825 rows — `text` would become
 *  `chat`, and `gp2`, `e2e_notification` and `revoked` would reach the Inbox. */
const voiceNoteRawTypes = new Set(['ptt', 'voice']);
/** A tradução do vocabulário do WEBJS para o do produto, e o motivo de ela ser um
 *  MAPA e não um repasse.
 *
 *  A tentação, depois de descobrir que o tipo real está em `_data.type`, é usá-lo
 *  direto. É o que o comentário acima proíbe, e a medição na base viva diz por
 *  quê: `chat` — o nome que o WEBJS dá a uma mensagem de texto comum — são 7.296
 *  linhas, e adotar o vocabulário cru renomearia 10.714 das 12.851 (83%).
 *
 *  Então só entram aqui os tipos cuja tradução é conhecida, e o mapa é
 *  deliberadamente CURTO: tipo que não está nele não é traduzido e continua
 *  caindo na classificação por mime, exatamente como antes. É isso que impede que
 *  um tipo novo do WhatsApp vire um rótulo que nenhum renderizador conhece.
 *
 *  `location` e `contact` são os dois que o dashboard desenha a partir do payload
 *  guardado, antes de precisar de mídia (MessageMedia.tsx:331-332). Para eles a
 *  classificação era a única coisa que faltava: sem ela a mensagem caía em
 *  `text`, e uma localização do WEBJS traz no `body` a MINIATURA em base64 — 4 KB
 *  de `/9j/4AAQ…` ocupando a conversa. Ver `bodyFrom`. */
const canonicalRawTypes: ReadonlyMap<string, string> = new Map([
  ['chat', 'text'],
  // O template de marketing é texto: o corpo dele vem de `_data.caption`, e sem
  // esta entrada o mime de `_data` o classificaria como image/video — 5 das 8
  // linhas trazem mimetype — deixando a legenda invisível atrás de uma mídia que
  // não existe (media_url nulo em 7 das 8). Ver `interactiveBody`.
  ['interactive', 'text'],
  ['location', 'location'],
  ['vcard', 'contact'],
  ['multi_vcard', 'contact'],
]);
export function canonicalMessageType(rawType: string | null | undefined): string | undefined {
  return canonicalRawTypes.get(rawType?.trim().toLowerCase() ?? '');
}
function mediaType(type: string | undefined, mime: string | undefined, hasMedia: boolean, rawType?: string): string { if (type && type !== 'text') return type.toLowerCase(); const canonical = canonicalMessageType(rawType); if (canonical) return canonical; if (!hasMedia && !mime) return 'text'; if (mime?.startsWith('image/')) return 'image'; if (mime?.startsWith('video/')) return 'video'; if (mime?.startsWith('audio/')) return voiceNoteRawTypes.has(rawType?.trim().toLowerCase() ?? '') ? 'ptt' : 'audio'; return 'document'; }
/** O texto da mensagem, por tipo — porque nem todo tipo guarda texto no mesmo
 *  lugar, e um deles não guarda texto nenhum.
 *
 *  Numa localização do WEBJS o `body` da raiz é a miniatura do mapa em base64, o
 *  mesmo blob de `location.thumbnail`. Copiá-lo para a coluna `body` é o que fazia
 *  a Inbox exibir um bloco de base64 no lugar da mensagem, e o que punha esse
 *  bloco em `conversations.last_message`. O texto útil de uma localização é o nome
 *  do lugar, que vem em `location.name` quando o remetente escolheu um ponto
 *  nomeado; quando ele mandou só as coordenadas, a localização não tem corpo — o
 *  cartão do mapa já diz tudo.
 *
 *  `name` e não `description`: a descrição é o nome e o endereço concatenados, e o
 *  cartão já mostra os dois. O dashboard suprime o corpo que repete o título
 *  (`bodyRepeatsCard`, messageMedia.ts:121), e é com `name` que essa comparação
 *  casa. */
/** O mime do anexo, das duas origens — e a segunda é a que faltava.
 *
 *  O objeto `media` da raiz existe nos eventos que chegam ao vivo pelo webhook e
 *  falta nos importados pela sincronização de histórico. Como `mediaType`
 *  classifica por mime, todo anexo histórico caía no `return 'document'` final:
 *  medido na base, 2.524 das 2.545 linhas gravadas como `document` estão com
 *  `media_mime_type` nulo.
 *
 *  O mime nunca esteve faltando no payload — só não estava sendo lido.
 *  `_data.mimetype` está preenchido em 5.377 de 5.377 linhas da família de mídia
 *  (100%), contra 2.245 na raiz. Ler a raiz primeiro mantém o tráfego ao vivo
 *  exatamente como estava; a retaguarda só age onde hoje não há nada.
 *
 *  Efeito medido antes de aplicar: 3.079 linhas passariam a classificar de outro
 *  jeito (ptt, image, video no lugar de document) e TODAS as 3.079 estão sem
 *  `media_url`, então a tela — que já mostra "Recebida" quando não há mídia para
 *  buscar — não muda para nenhuma delas. O que muda é a classificação do que
 *  chegar daqui em diante, inclusive pela sincronização de histórico. */
function mimeFrom(value: Record<string, unknown>, media: Record<string, unknown> | undefined): string | undefined {
  return text(media?.mimetype) ?? text(media?.mimeType) ?? text(record(value._data)?.mimetype);
}
function bodyFrom(canonical: string, rawType: string | undefined, value: Record<string, unknown>): string | null {
  if (canonical === 'location') {
    const point = record(value.location);
    return text(point?.name) ?? null;
  }
  if (rawType?.trim().toLowerCase() === 'interactive') return interactiveBody(value);
  return text(value.body) ?? text(value.text) ?? null;
}
/** O texto de um template de marketing, que estava sendo jogado fora inteiro.
 *
 *  `interactive` é o tipo do WhatsApp para a mensagem com botão de ação — a peça
 *  que Uber, Amazon e afins disparam. O texto **nunca** está no `body` da raiz:
 *  está em `_data.caption`, medido presente em 8 de 8 linhas da base, com 345 a
 *  994 caracteres. O `body` da raiz, quando existe, ou repete a legenda ou traz o
 *  pôster do vídeo em base64 — uma das 8 tinha exatamente isso, `/9j/4AAQ…` na
 *  coluna de texto, o mesmo sintoma da localização por outro caminho.
 *
 *  O título, quando vem, está em `_data.interactiveHeader.title` (1 das 8). Vai
 *  antes da legenda, separado por linha em branco, porque é assim que aparece no
 *  aparelho: manchete e corpo.
 *
 *  O `_data.footer` — "Envie PARAR para não receber mais mensagens", em 5 das 8 —
 *  fica **de fora de propósito**: é instrução de descadastro do disparador, não
 *  conteúdo da conversa, e repeti-la em toda mensagem enche a Inbox de ruído. Se
 *  um dia importar, é um `??` a mais aqui. */
function interactiveBody(value: Record<string, unknown>): string | null {
  const data = record(value._data);
  const title = text(record(data?.interactiveHeader)?.title);
  const caption = text(data?.caption);
  const parts = [title, caption].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('\n\n') : null;
}
export function messagePreview(message: Pick<StoredMessage, 'messageType' | 'body' | 'mediaFilename'>): string { const caption = message.body?.trim(); switch (message.messageType) { case 'text': return caption || 'Mensagem'; case 'image': return caption ? `Foto: ${caption}` : 'Foto'; case 'video': return caption ? `Vídeo: ${caption}` : 'Vídeo'; case 'audio': return 'Áudio'; case 'ptt': case 'voice': return 'Mensagem de voz'; case 'document': return message.mediaFilename ? `Documento: ${message.mediaFilename}` : 'Documento'; case 'sticker': return 'Sticker'; case 'contact': return 'Contato'; case 'location': return 'Localização'; case 'call': return 'Ligação de voz'; default: return caption || 'Mensagem'; } }
function missingMediaColumns(error: { code?: string; message?: string; details?: string }): boolean { return error.code === '42703' || /media_(url|mime_type|filename|size|storage_path|checksum|persistence_status)|thumbnail_url|quoted_message_id/i.test(`${error.message ?? ''} ${error.details ?? ''}`); }
function phoneFromChat(chatId: string): string { return chatId.split('@', 1)[0].replace(/\D/g, ''); }
/** A LID has digits but is not evidence of a telephone number. */
function phoneFromDirectChat(chatId: string): string | null { return chatId.endsWith('@c.us') ? phoneFromChat(chatId) : null; }
/** Linha já juntada de participante (identidade + contato), comum aos dois stores. */
type GroupParticipantRow = { whatsappId: string; role: string | null; identityName: string | null; pushName: string | null; identityPhone: string | null; avatarUrl: string | null; contactName: string | null };
/** Resolve o nome público (identidade → contato, nunca o JID cru), o telefone
 *  (garantido só em `@c.us`) e ordena como o WhatsApp Web: quem falou por
 *  último primeiro, depois alfabética. A junção por canônico pode repetir um
 *  participante; a primeira ocorrência vence. */
function assembleGroupParticipants(rows: readonly GroupParticipantRow[], lastActive: ReadonlyMap<string, string>): GroupParticipant[] {
  const seen = new Map<string, GroupParticipant>();
  for (const row of rows) {
    if (seen.has(row.whatsappId)) continue;
    const digits = phoneFromChat(row.whatsappId);
    seen.set(row.whatsappId, { whatsappId: row.whatsappId, name: row.identityName ?? row.pushName ?? row.contactName ?? null, phone: row.identityPhone ?? (row.whatsappId.endsWith('@c.us') ? digits || null : null), role: row.role, avatarUrl: row.avatarUrl, lastActiveAt: lastActive.get(row.whatsappId) ?? null });
  }
  return [...seen.values()].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '') || (a.name ?? a.phone ?? a.whatsappId).localeCompare(b.name ?? b.phone ?? b.whatsappId, 'pt-BR'));
}
type ConversationRow = Omit<ConversationSummary, 'identity'> & { identityPhone: string | null; profileName: string | null; pushName: string | null; identityAvatarUrl: string | null; identityUpdatedAt: string | null; contactDisplayName: string | null; groupName: string | null; groupPictureUrl: string | null; groupUpdatedAt: string | null };
type RemoteConversation = { id: string; workspace_id: string; waha_session: string; chat_id: string; delivery_chat_id?: string; contact_id: string | null; conversation_type: 'direct' | 'group'; assigned_user_id: string | null; assigned_team_id: string | null; assigned_at: string | null; routing_queue_id: string | null; auto_assigned_at: string | null; routing_locked_at: string | null; status: ConversationStatus; priority: ConversationPriority; last_status_change: string | null; last_message: string | null; last_message_at: string; unread_count: number; created_at: string; updated_at: string };
type RemoteMessageRow = { external_message_id: string; direction: 'inbound' | 'outbound'; body: string | null; occurred_at: string; status: InboxMessage['status']; message_type: string; chat_id: string; sender_whatsapp_id: string | null; media_url?: string | null; media_mime_type?: string | null; media_filename?: string | null; media_size?: number | null; thumbnail_url?: string | null; duration?: number | null; quoted_message_id?: string | null; payload_json: Record<string, unknown> };
export function identityFor(conversation: { chatId: string; contactId: string | null; conversationType: 'direct' | 'group' }, source?: { phone?: string | null; name?: string | null; pushName?: string | null; push_name?: string | null; profilePictureUrl?: string | null; profile_picture_url?: string | null; updatedAt?: string | null; updated_at?: string | null }, group?: { name?: string | null; pictureUrl?: string | null; picture_url?: string | null; updatedAt?: string | null; updated_at?: string | null }, contactName?: string | null): ConversationIdentity { const isGroup = conversation.conversationType === 'group'; const profileName = isGroup ? group?.name ?? null : source?.name ?? null; const pushName = isGroup ? null : source?.pushName ?? source?.push_name ?? null; const phone = isGroup ? null : (source?.phone ?? phoneFromDirectChat(conversation.chatId)); const avatarUrl = isGroup ? group?.pictureUrl ?? group?.picture_url ?? null : source?.profilePictureUrl ?? source?.profile_picture_url ?? null; const lastSyncAt = isGroup ? group?.updatedAt ?? group?.updated_at ?? null : source?.updatedAt ?? source?.updated_at ?? null; return { displayName: profileName ?? pushName ?? contactName ?? null, phone, pushName, profileName, contactName: contactName ?? null, avatarUrl, lastSyncAt, syncStatus: lastSyncAt ? 'synced' : 'pending', knownContact: !isGroup && Boolean(conversation.contactId) }; }
function toConversationSummary(row: ConversationRow): ConversationSummary { const { identityPhone, profileName, pushName, identityAvatarUrl, identityUpdatedAt, contactDisplayName, groupName, groupPictureUrl, groupUpdatedAt, ...conversation } = row; return { ...conversation, identity: identityFor(conversation, { phone: identityPhone, name: profileName, pushName, profilePictureUrl: identityAvatarUrl, updatedAt: identityUpdatedAt }, { name: groupName, pictureUrl: groupPictureUrl, updatedAt: groupUpdatedAt }, contactDisplayName) }; }
function toRemoteConversationSummary(row: RemoteConversation, identity?: { phone?: string | null; name?: string | null; push_name?: string | null; profile_picture_url?: string | null; updated_at?: string | null }, group?: { name?: string | null; picture_url?: string | null; updated_at?: string | null }, contactName?: string | null): ConversationSummary { const conversation = { id: row.id, workspaceId: row.workspace_id, whatsappSessionId: row.waha_session, chatId: row.chat_id, ...(row.delivery_chat_id ? { deliveryChatId: row.delivery_chat_id } : {}), contactId: row.contact_id, conversationType: row.conversation_type, assignedUserId: row.assigned_user_id, assignedTeamId: row.assigned_team_id, assignedAt: row.assigned_at, routingQueueId: row.routing_queue_id, autoAssignedAt: row.auto_assigned_at, routingLockedAt: row.routing_locked_at, status: row.status, priority: row.priority, lastStatusChange: row.last_status_change, lastMessage: row.last_message, lastMessageAt: row.last_message_at, unreadCount: row.unread_count, createdAt: row.created_at, updatedAt: row.updated_at }; return { ...conversation, identity: identityFor(conversation, identity, group, contactName) }; }
function isUniqueError(error: unknown): boolean { return error instanceof Error && /unique|constraint/i.test(error.message); }
function sanitize(value: unknown, depth = 0): unknown { if (depth > 12) return '[TRUNCATED]'; if (typeof value === 'string') return value.length > 20_000 ? `${value.slice(0, 20_000)}[TRUNCATED]` : value; if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1)); if (!value || typeof value !== 'object') return value; return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : sanitize(item, depth + 1)])); }

/**
 * As três leituras que resolvem quem é a pessoa do outro lado: identidade do
 * WhatsApp, nome do grupo e contato ChatPro. São **três consultas por página**,
 * em lote por `IN` — não uma por conversa —, e é por isso que dá para chamá-las
 * também na consulta de cartões do Kanban sem reintroduzir N+1.
 *
 * Extraída de `withIdentities` quando o card do Kanban passou a precisar do
 * mesmo resultado. Uma cópia divergiria da precedência registrada, que é o que
 * `identityFor` decide: nome de perfil do WhatsApp antes do nome ChatPro.
 */
export async function remoteIdentityLookup(client: SupabaseClient, rows: ReadonlyArray<{ workspace_id: string; waha_session: string; chat_id: string; contact_id: string | null }>) {
  const sessions = [...new Set(rows.map(row => row.waha_session))];
  const chatIds = [...new Set(rows.map(row => row.chat_id))];
  const contactIds = [...new Set(rows.flatMap(row => row.contact_id ? [row.contact_id] : []))];
  const workspaceId = rows[0]!.workspace_id;
  const [identityResult, groupResult, contactResult] = await Promise.all([
    client.from('whatsapp_identities').select('waha_session, whatsapp_id, phone, name, push_name, profile_picture_url, updated_at').in('waha_session', sessions).in('whatsapp_id', chatIds),
    client.from('whatsapp_groups').select('waha_session, chat_id, name, picture_url, updated_at').in('waha_session', sessions).in('chat_id', chatIds),
    contactIds.length ? client.from('contacts').select('id, display_name').eq('workspace_id', workspaceId).in('id', contactIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (identityResult.error) throw identityResult.error;
  if (groupResult.error) throw groupResult.error;
  if (contactResult.error) throw contactResult.error;
  const identities = new Map((identityResult.data ?? []).map((row: any) => [`${row.waha_session}:${row.whatsapp_id}`, row]));
  const groups = new Map((groupResult.data ?? []).map((row: any) => [`${row.waha_session}:${row.chat_id}`, row]));
  const contacts = new Map((contactResult.data ?? []).map((row: any) => [row.id, row.display_name]));
  const chave = (row: { waha_session: string; chat_id: string }) => `${row.waha_session}:${row.chat_id}`;
  return {
    identity: (row: { waha_session: string; chat_id: string }) => identities.get(chave(row)),
    group: (row: { waha_session: string; chat_id: string }) => groups.get(chave(row)),
    contact: (row: { contact_id: string | null }) => contacts.get(row.contact_id ?? '') ?? null,
  };
}
