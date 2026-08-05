import { z } from 'zod';

export const safeIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Identifier must contain only letters, numbers, hyphens, and underscores');
export const requestContextSchema = z.object({ userId: z.string().min(1).optional(), workspaceId: safeIdentifierSchema, correlationId: z.string().min(1) });
export type RequestContext = z.infer<typeof requestContextSchema>;

export const errorCodes = ['VALIDATION_ERROR','UNAUTHORIZED','FORBIDDEN','NOT_FOUND','CONFLICT','SERVICE_UNAVAILABLE','PROVIDER_CONTRACT_ERROR','NOT_IMPLEMENTED','TIMEOUT'] as const;
export const apiErrorSchema = z.object({ error: z.object({ code: z.enum(errorCodes), message: z.string().min(1), correlationId: z.string().min(1), details: z.record(z.unknown()).default({}) }) });
export type ApiError = z.infer<typeof apiErrorSchema>;
export const validationErrorSchema = apiErrorSchema.refine(value => value.error.code === 'VALIDATION_ERROR');
export const unauthorizedErrorSchema = apiErrorSchema.refine(value => value.error.code === 'UNAUTHORIZED');
export const forbiddenErrorSchema = apiErrorSchema.refine(value => value.error.code === 'FORBIDDEN');
export const notFoundErrorSchema = apiErrorSchema.refine(value => value.error.code === 'NOT_FOUND');
export const conflictErrorSchema = apiErrorSchema.refine(value => value.error.code === 'CONFLICT');
export const serviceUnavailableErrorSchema = apiErrorSchema.refine(value => value.error.code === 'SERVICE_UNAVAILABLE');
export const notImplementedErrorSchema = apiErrorSchema.refine(value => value.error.code === 'NOT_IMPLEMENTED');

export const sessionStatusSchema = z.enum(['disconnected','connecting','waiting_qr','connected','stopped','error']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export const whatsAppSessionSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), name: z.string().min(1), status: sessionStatusSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime(), wahaName: z.string().min(1).optional(), aliases: z.array(z.string().min(1)).optional(), managed: z.boolean().optional() });
export type WhatsAppSession = z.infer<typeof whatsAppSessionSchema>;
// The caller owns this key so retrying a request whose response was lost does
// not create a second WAHA session. It is also used as the public session id.
export const createSessionRequestSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), clientRequestId: z.string().uuid().optional() });
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export const connectSessionRequestSchema = z.object({ forceQrRefresh: z.boolean().optional().default(false) });
export type ConnectSessionRequest = z.infer<typeof connectSessionRequestSchema>;
export const sessionSummarySchema = whatsAppSessionSchema.pick({ id: true, workspaceId: true, name: true, status: true, updatedAt: true, wahaName: true, aliases: true, managed: true });
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const contactSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), displayName: z.string().min(1), phoneNumber: z.string().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type Contact = z.infer<typeof contactSchema>;
export const contactListQuerySchema = z.object({ page: z.coerce.number().int().positive().optional(), pageSize: z.coerce.number().int().positive().max(100).optional(), search: z.string().trim().max(120).optional() });
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
export const contactListResponseSchema = z.object({ items: z.array(contactSchema), page: z.number().int().positive(), pageSize: z.number().int().positive(), total: z.number().int().nonnegative() });
export type ContactListResponse = z.infer<typeof contactListResponseSchema>;

export const messageTemplateSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), name: z.string().min(1), content: z.string().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;
export const createTemplateRequestSchema = messageTemplateSchema.pick({ name: true, content: true });
export type CreateTemplateRequest = z.infer<typeof createTemplateRequestSchema>;
export const updateTemplateRequestSchema = createTemplateRequestSchema.partial().refine(value => Object.keys(value).length > 0, 'At least one field is required');
export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>;
export const templateListResponseSchema = z.object({ items: z.array(messageTemplateSchema), total: z.number().int().nonnegative() });
export type TemplateListResponse = z.infer<typeof templateListResponseSchema>;

// Persistence domain contracts. These are intentionally transport-agnostic: CRUD routes are a later phase.
export const persistedEntitySchema = z.object({ id: z.string().uuid(), workspaceId: safeIdentifierSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export const normalizedPhoneNumberSchema = z.string().regex(/^\d{8,15}$/, 'Phone number must contain 8 to 15 normalized digits');
export const persistenceContactSchema = persistedEntitySchema.extend({ displayName: z.string().trim().min(1).max(160), phoneNumber: normalizedPhoneNumberSchema, email: z.string().email().nullable(), company: z.string().trim().max(160).nullable(),
  // Enriquecimento opcional vindo de `whatsapp_identities`: as listagens de
  // contato o anexam em lote (uma consulta por página, nunca uma por linha).
  // Opcionais porque a fonte é assíncrona — o contato existe antes da primeira
  // sincronização de identidade, e contatos manuais/importados podem nunca ter
  // uma identidade WhatsApp associada.
  photoUrl: z.string().url().max(2_048).nullable().optional(), whatsappName: z.string().trim().min(1).max(240).nullable().optional(), whatsappPushName: z.string().trim().min(1).max(240).nullable().optional(),
  // De onde o contato veio: 'phonebook' quando a sincronização da agenda do
  // WhatsApp o criou (contato salvo no celular), 'history' quando veio das
  // conversas, do webhook ou de cadastro manual. Derivado de
  // `contact_identifiers.source` em lote — nunca uma consulta por linha.
  origin: z.enum(['phonebook', 'history']).nullable().optional() });
export const tagSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() });
export const optOutHistorySchema = persistedEntitySchema.extend({ contactId: z.string().uuid(), source: z.string().trim().min(1).max(80), reason: z.string().trim().max(500).nullable(), occurredAt: z.string().datetime() });
export const templateVariablesSchema = z.array(z.string().trim().min(1).max(80)).max(50).superRefine((variables, ctx) => { if (new Set(variables).size !== variables.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Template variables must be unique' }); });
export const persistenceTemplateSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(120), content: z.string().min(1).max(10_000), variables: templateVariablesSchema.default([]) });
export const pipelineSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(120) });
export const stageSchema = persistedEntitySchema.extend({ pipelineId: z.string().uuid(), name: z.string().trim().min(1).max(120), position: z.number().int().nonnegative() });
export const leadSchema = persistedEntitySchema.extend({ stageId: z.string().uuid(), contactId: z.string().uuid().nullable(), title: z.string().trim().min(1).max(160) });
export const leadNoteSchema = persistedEntitySchema.extend({ leadId: z.string().uuid(), body: z.string().trim().min(1).max(10_000) });
export const activitySchema = persistedEntitySchema.extend({ leadId: z.string().uuid(), type: z.string().trim().min(1).max(80), details: z.record(z.unknown()), occurredAt: z.string().datetime() });
export const campaignStatusSchema = z.enum(['draft', 'scheduled', 'ready', 'blocked', 'cancelled']);
export const campaignSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(160), templateId: z.string().uuid().nullable(), status: campaignStatusSchema, scheduledAt: z.string().datetime().nullable() });
export const workspaceSettingsSchema = persistedEntitySchema.extend({ settings: z.record(z.unknown()) });
export type PersistenceContact = z.infer<typeof persistenceContactSchema>; export type Tag = z.infer<typeof tagSchema>; export type OptOutHistory = z.infer<typeof optOutHistorySchema>; export type PersistenceTemplate = z.infer<typeof persistenceTemplateSchema>; export type Pipeline = z.infer<typeof pipelineSchema>; export type Stage = z.infer<typeof stageSchema>; export type Lead = z.infer<typeof leadSchema>; export type LeadNote = z.infer<typeof leadNoteSchema>; export type Activity = z.infer<typeof activitySchema>; export type Campaign = z.infer<typeof campaignSchema>; export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const inboxConversationTypeSchema = z.enum(['direct', 'group']);
export const inboxIdentitySchema = z.object({ displayName: z.string().nullable(), phone: z.string().nullable(), pushName: z.string().nullable(), profileName: z.string().nullable(), contactName: z.string().nullable().optional(), avatarUrl: z.string().url().nullable(), lastSyncAt: z.string().datetime().nullable(), syncStatus: z.enum(['pending', 'synced']), knownContact: z.boolean() });
export const conversationStatusSchema = z.enum(['open', 'in_progress', 'waiting_customer', 'resolved', 'archived']);
export const conversationPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const routingStrategySchema = z.enum(['round_robin', 'least_loaded', 'manual']);
export const routingResultSchema = z.enum(['assigned', 'skipped', 'failed', 'manual_override']);
export const routingQueueSchema = z.object({ id: z.string().uuid(), workspaceId: safeIdentifierSchema, teamId: z.string().uuid().nullable(), name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).nullable(), isActive: z.boolean(), strategy: routingStrategySchema, maxOpenConversationsPerAgent: z.number().int().positive().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export const routingQueueMemberSchema = z.object({ queueId: z.string().uuid(), userId: z.string().uuid(), priorityWeight: z.number().int().positive(), isAvailable: z.boolean(), lastAssignedAt: z.string().datetime().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export const routingEventSchema = z.object({ id: z.string().uuid(), workspaceId: safeIdentifierSchema, conversationId: z.string().uuid(), queueId: z.string().uuid().nullable(), assignedUserId: z.string().uuid().nullable(), strategy: routingStrategySchema, result: routingResultSchema, reasonSafe: z.string().nullable(), createdAt: z.string().datetime() });
export type RoutingQueue = z.infer<typeof routingQueueSchema>;
export type RoutingQueueMember = z.infer<typeof routingQueueMemberSchema>;
export type RoutingEvent = z.infer<typeof routingEventSchema>;
export const conversationEventActionSchema = z.enum(['assigned', 'unassigned', 'status_changed', 'priority_changed', 'archived', 'reopened']);
export const workspaceUserRoleSchema = z.enum(['owner', 'admin', 'manager', 'agent']);
export const workspaceUserStatusSchema = z.enum(['active', 'invited', 'disabled']);
export const workspaceUserSchema = z.object({ id: z.string().uuid(), workspaceId: safeIdentifierSchema, email: z.string().email(), displayName: z.string().trim().min(1).max(160), avatarUrl: z.string().url().nullable(), role: workspaceUserRoleSchema, status: workspaceUserStatusSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime(), lastSeenAt: z.string().datetime().nullable() });
export const teamSchema = z.object({ id: z.string().uuid(), workspaceId: safeIdentifierSchema, name: z.string().trim().min(1).max(120), description: z.string().trim().max(500).nullable(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(), isActive: z.boolean(), memberCount: z.number().int().nonnegative(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export const teamMemberSchema = z.object({ teamId: z.string().uuid(), userId: z.string().uuid(), membershipRole: z.enum(['member', 'leader']), createdAt: z.string().datetime() });
export type WorkspaceUser = z.infer<typeof workspaceUserSchema>;
export type Team = z.infer<typeof teamSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export const inboxConversationSchema = z.object({ id: z.string().uuid(), whatsappSessionId: z.string().min(1), chatId: z.string().min(1), contactId: z.string().uuid().nullable(), conversationType: inboxConversationTypeSchema.default('direct'), assignedUserId: z.string().uuid().nullable(), assignedTeamId: z.string().uuid().nullable(), assignedAt: z.string().datetime().nullable(), routingQueueId: z.string().uuid().nullable(), autoAssignedAt: z.string().datetime().nullable(), routingLockedAt: z.string().datetime().nullable(), status: conversationStatusSchema, priority: conversationPrioritySchema, lastStatusChange: z.string().datetime().nullable(), lastMessage: z.string().nullable(), lastMessageAt: z.string().datetime(), unreadCount: z.number().int().nonnegative(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), identity: inboxIdentitySchema });
/**
 * Uma reação por autor por mensagem, como no WhatsApp Web: reagir de novo com
 * outro emoji substitui, e o mesmo emoji remove (toggle, enviado como `""` ao
 * provedor). `reactorWhatsappId` é nulo quando `fromMe`, porque reações da
 * própria conta — do dashboard ou do telefone — não expõem ids internos.
 */
export const messageReactionSchema = z.object({ emoji: z.string().min(1).max(32), reactorWhatsappId: z.string().min(1).nullable(), fromMe: z.boolean(), reactorName: z.string().min(1).nullable(), reactorPhone: z.string().min(1).nullable(), reactedAt: z.string().datetime() });
export type MessageReaction = z.infer<typeof messageReactionSchema>;
export const inboxMessageSchema = z.object({ id: z.string().min(1), direction: z.enum(['inbound', 'outbound']), content: z.string().nullable(), timestamp: z.string().datetime(), status: z.enum(['sending', 'received', 'sent', 'delivered', 'read', 'failed']), messageType: z.string().min(1), chatId: z.string().min(1), senderWhatsappId: z.string().min(1).nullable().optional(), mediaUrl: z.string().url().nullable().optional(), mediaMimeType: z.string().nullable().optional(), mediaFilename: z.string().nullable().optional(), mediaSize: z.number().int().nonnegative().nullable().optional(), thumbnailUrl: z.string().url().nullable().optional(), duration: z.number().int().nonnegative().nullable().optional(), quotedMessageId: z.string().nullable().optional(), metadata: z.record(z.unknown()), reactions: z.array(messageReactionSchema).optional() });
export type InboxConversation = z.infer<typeof inboxConversationSchema>;
export type InboxMessage = z.infer<typeof inboxMessageSchema>;
/** Participante de grupo para o autocomplete de menções e o painel de membros:
 *  `whatsappId` é o JID armazenado (`@c.us` ou `@lid`); `name` já vem resolvido
 *  (identidade → contato) e `phone` só é garantido em JIDs `@c.us`. */
export const groupParticipantSchema = z.object({ whatsappId: z.string().min(1).max(200), name: z.string().max(240).nullable(), phone: z.string().max(32).nullable(), role: z.string().max(64).nullable(), avatarUrl: z.string().url().max(2_048).nullable(), lastActiveAt: z.string().datetime().nullable() });
export type GroupParticipant = z.infer<typeof groupParticipantSchema>;
export const conversationEventSchema = z.object({ id: z.string().uuid(), conversationId: z.string().uuid(), workspaceId: safeIdentifierSchema, userId: z.string().uuid(), action: conversationEventActionSchema, previousValue: z.string().nullable(), newValue: z.string().nullable(), createdAt: z.string().datetime() });
export type ConversationEvent = z.infer<typeof conversationEventSchema>;

export const eventTypes = ['system.connected','session.status.changed','session.qr.updated','message.received','message.sent','message.status.updated','message.reaction.updated','conversation.updated','conversation.management.updated','conversation.context.updated','conversation.sync.updated','conversation.sla.updated','conversation.kanban.moved','kanban.stage.created','kanban.stage.updated','kanban.stage.reordered','workspace.user.created','workspace.user.updated','workspace.team.created','workspace.team.updated','workspace.team.members.updated','routing.queue.created','routing.queue.updated','routing.queue.members.updated','conversation.routing.queued','conversation.routing.processing','conversation.routing.updated','worker.error'] as const;
export const eventEnvelopeSchema = z.object({ eventId: z.string().min(1), eventType: z.enum(eventTypes), workspaceId: safeIdentifierSchema, timestamp: z.string().datetime(), correlationId: z.string().min(1), payload: z.record(z.unknown()) });
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const sessionStatusChangedPayloadSchema = z.object({ sessionId: safeIdentifierSchema, status: sessionStatusSchema, previousStatus: sessionStatusSchema.optional(), changedAt: z.string().datetime(), attempt: z.number().int().positive().optional() });
export const sessionQrUpdatedPayloadSchema = z.object({ sessionId: safeIdentifierSchema, qr: z.string().min(1).max(8192), expiresAt: z.string().datetime() });
export const workerErrorPayloadSchema = z.object({ sessionId: safeIdentifierSchema.optional(), operation: z.string().min(1).max(64), code: z.string().min(1).max(64), message: z.string().min(1).max(240) });

export function validateEventEnvelope(event: EventEnvelope): EventEnvelope {
  const parsed = eventEnvelopeSchema.parse(event);
  if (parsed.eventType === 'session.status.changed') sessionStatusChangedPayloadSchema.parse(parsed.payload);
  if (parsed.eventType === 'session.qr.updated') sessionQrUpdatedPayloadSchema.parse(parsed.payload);
  if (parsed.eventType === 'worker.error') workerErrorPayloadSchema.parse(parsed.payload);
  return parsed;
}

// Internal API-to-worker protocol. It exposes only controlled commands until a later session/QR phase.
export const internalTransportTimeoutSchema = z.number().int().min(1).max(30_000);
export const internalTransportPingCommandSchema = z.object({ type: z.literal('transport.ping'), payload: z.object({ message: z.string().min(1).max(120), delayMs: z.number().int().min(0).max(5_000).optional(), fail: z.boolean().optional() }) });
export const sessionIdSchema = safeIdentifierSchema;
export const sessionQrSchema = z.object({ sessionId: sessionIdSchema, workspaceId: safeIdentifierSchema, qr: z.string().min(1).max(8192), expiresAt: z.string().datetime() });
export type SessionQr = z.infer<typeof sessionQrSchema>;
export const internalListSessionsCommandSchema = z.object({ type: z.literal('session.list'), payload: z.object({}) });
export const internalCreateSessionCommandSchema = z.object({ type: z.literal('session.create'), payload: z.object({ sessionId: sessionIdSchema, name: z.string().trim().min(1).max(120).optional() }) });
export const internalSessionCommandSchema = z.object({ type: z.enum(['session.connect', 'session.status', 'session.qr', 'session.stop', 'session.logout', 'session.remove']), payload: z.object({ sessionId: sessionIdSchema }) });
export const internalSendMessageCommandSchema = z.object({ type: z.literal('message.send'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(4_096), mentions: z.array(z.string().regex(/^\d{6,20}@(c\.us|lid)$/)).max(50).optional(), linkPreview: z.boolean().optional() }) });
export const attachmentTypeSchema = z.enum(['image', 'audio', 'video', 'document']);
export const outboxStatusSchema = z.enum(['pending', 'processing', 'sent', 'confirmed', 'failed', 'cancelled']);
export const inboxOutboxJobSchema = z.object({ id: z.string().uuid(), workspaceId: safeIdentifierSchema, conversationId: z.string().uuid(), wahaSession: z.string().min(1), clientRequestId: z.string().uuid(), type: attachmentTypeSchema, storageObjectPath: z.string().min(1).nullable(), filename: z.string().min(1).nullable(), mimeType: z.string().min(1).nullable(), sizeBytes: z.number().int().nonnegative().nullable(), caption: z.string().max(4_096).nullable(), status: outboxStatusSchema, attemptCount: z.number().int().nonnegative(), externalMessageId: z.string().nullable(), providerAcceptedAt: z.string().datetime().nullable(), lastErrorSafe: z.string().nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type InboxOutboxJob = z.infer<typeof inboxOutboxJobSchema>;
/**
 * `voiceNote` is the operator's intent, not a property of the file. WhatsApp
 * shows a recorded note (PTT) with a waveform and a music file as a track, and
 * the two are different endpoints on the provider — but both carry `audio/mpeg`
 * just as well, so the mimetype cannot decide it. Until now nothing did: every
 * `audio` went out as a note.
 *
 * It is optional, and absent means a voice note, because that is what the
 * composer's recorder has always produced. A caller that says nothing keeps the
 * behaviour it had; only an explicit `false` asks for a file. That is also why
 * this is a flag and not a fifth `attachmentTypeSchema` member: the kind is
 * still audio, and the enum is mirrored by a CHECK constraint in both databases.
 */
export const internalSendAttachmentCommandSchema = z.object({ type: z.literal('message.sendAttachment'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(200), type: attachmentTypeSchema, url: z.string().url().max(4_096), filename: z.string().trim().min(1).max(255), mimeType: z.string().trim().min(1).max(128), caption: z.string().max(4_096).optional(), voiceNote: z.boolean().optional() }) });
const whatsappIdentitySnapshotSchema = z.object({ whatsappId: z.string().min(1).max(200), canonicalWhatsappId: z.string().min(1).max(200), phone: z.string().min(1).max(32).nullable(), name: z.string().min(1).max(240).nullable(), pushName: z.string().min(1).max(240).nullable(), shortName: z.string().min(1).max(240).nullable(), profilePictureUrl: z.string().url().max(2_048).nullable() });
const whatsappGroupSnapshotSchema = z.object({ chatId: z.string().min(1).max(200), name: z.string().min(1).max(240).nullable(), pictureUrl: z.string().url().max(2_048).nullable(), metadata: z.record(z.unknown()), participants: z.array(z.object({ whatsappId: z.string().min(1).max(200), role: z.string().min(1).max(64).nullable() })).max(2_000) });
/**
 * Sends that are neither text nor a file. `message.send` carries a string and
 * `message.sendAttachment` carries a URL plus filename and mimetype, so a set of
 * coordinates, a contact card or a poll had nowhere to travel.
 *
 * One command with a discriminated content instead of one command per kind: the
 * envelope is identical for all of them — same session, same chat, same
 * `sentMessage` answer — and only the content differs. A new kind is a member of
 * this union plus a branch in the provider; it needs no new command type, no new
 * response variant and no new call site in the API. Location, vCard and poll are
 * all declared here already, so adding either of the remaining two later does not
 * touch the contract at all.
 */
export const sendableLocationSchema = z.object({ kind: z.literal('location'), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), title: z.string().trim().min(1).max(240).optional() });
export const sendableVcardSchema = z.object({ kind: z.literal('vcard'), contacts: z.array(z.union([
  z.object({ vcard: z.string().min(1).max(8_192) }),
  z.object({ fullName: z.string().trim().min(1).max(240), organization: z.string().trim().min(1).max(240).optional(), phoneNumber: z.string().trim().min(1).max(64), whatsappId: z.string().trim().min(1).max(200).optional() }),
])).min(1).max(20) });
export const sendablePollSchema = z.object({ kind: z.literal('poll'), name: z.string().trim().min(1).max(240), options: z.array(z.string().trim().min(1).max(100)).min(2).max(12), multipleAnswers: z.boolean() });
export const sendableContentSchema = z.discriminatedUnion('kind', [sendableLocationSchema, sendableVcardSchema, sendablePollSchema]);
export type SendableContent = z.infer<typeof sendableContentSchema>;
export type SendableContentKind = SendableContent['kind'];
export const internalSendContentCommandSchema = z.object({ type: z.literal('message.sendContent'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(200), content: sendableContentSchema }) });
/**
 * `reaction` é o emoji a aplicar e `""` remove a reação da própria conta —
 * o provedor usa a string vazia como remoção, então o comando não pode exigir
 * `min(1)`. `messageId` é o id externo já gravado, repassado verbatim.
 */
export const internalSendReactionCommandSchema = z.object({ type: z.literal('message.sendReaction'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(200), messageId: z.string().min(1).max(200), reaction: z.string().max(32) }) });
export const internalIdentitySyncCommandSchema = z.object({ type: z.literal('identity.sync'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(200), senderWhatsappId: z.string().trim().min(1).max(200).optional(), refreshIdentity: z.boolean(), refreshGroup: z.boolean() }) });

/**
 * Prévia de link, na prioridade do próprio WhatsApp: o remetente gera a prévia e
 * ela viaja dentro da mensagem (`_data.title/description/thumbnail/matchedText`
 * do whatsapp-web.js) — e a WAHA a devolve no `sendText` quando pedida com
 * `linkPreview`. Só na ausência das duas a API raspa OG/oEmbed como retaguarda.
 *
 * `imageUrl` aceita `data:` de propósito: a thumbnail nativa chega em base64 —
 * por isso `z.string()` e não `z.string().url()`, com teto de 400 KB.
 */
export const linkPreviewProviderSchema = z.enum(['youtube', 'tiktok', 'github', 'spotify', 'instagram', 'facebook', 'figma', 'notion', 'google-drive', 'dropbox', 'generic']);
export type LinkPreviewProvider = z.infer<typeof linkPreviewProviderSchema>;
export const linkPreviewSchema = z.object({ url: z.string().min(1).max(2_048), domain: z.string().min(1).max(255).optional(), title: z.string().max(500).optional(), description: z.string().max(2_000).optional(), imageUrl: z.string().min(1).max(400_000).optional(), siteName: z.string().max(240).optional(), faviconUrl: z.string().url().max(2_048).optional(), provider: linkPreviewProviderSchema.optional(), author: z.string().max(240).optional(), durationSeconds: z.number().int().nonnegative().optional() });
export type LinkPreview = z.infer<typeof linkPreviewSchema>;
export const internalHistoryPageCommandSchema = z.object({ type: z.literal('history.page'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(200).optional(), offset: z.number().int().nonnegative(), limit: z.number().int().positive().max(100) }) });
/**
 * Uma página da agenda de contatos carregada pela sessão (`GET /api/contacts/all`
 * da WAHA). Comando separado de `history.page` porque a unidade é o contato, não
 * a conversa: a agenda inclui quem nunca trocou mensagem com a conta, e é essa
 * lista que alimenta a base interna de contatos.
 *
 * `sortBy=id` no provedor é o que torna o `offset` um cursor estável o bastante
 * para checkpoint — a listagem por recência usada no histórico se reordenaria
 * sob o job a cada mensagem que chegasse.
 */
export const internalContactsPageCommandSchema = z.object({ type: z.literal('contacts.page'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), offset: z.number().int().nonnegative(), limit: z.number().int().positive().max(100) }) });
export const internalTransportCommandSchema = z.discriminatedUnion('type', [internalTransportPingCommandSchema, internalListSessionsCommandSchema, internalCreateSessionCommandSchema, internalSessionCommandSchema, internalSendMessageCommandSchema, internalSendAttachmentCommandSchema, internalSendContentCommandSchema, internalSendReactionCommandSchema, internalIdentitySyncCommandSchema, internalHistoryPageCommandSchema, internalContactsPageCommandSchema]);
export type InternalTransportCommand = z.infer<typeof internalTransportCommandSchema>;
export const internalTransportRequestSchema = z.object({ correlationId: z.string().min(1).max(128), workspaceId: safeIdentifierSchema, timeoutMs: internalTransportTimeoutSchema, command: internalTransportCommandSchema });
export type InternalTransportRequest = z.infer<typeof internalTransportRequestSchema>;
export const internalTransportErrorSchema = z.object({ code: z.enum(errorCodes), message: z.string().min(1).max(240), details: z.record(z.unknown()).default({}) });
export type InternalTransportError = z.infer<typeof internalTransportErrorSchema>;
export const internalTransportDataSchema = z.union([
  z.object({ message: z.string().min(1).max(120) }),
  z.object({ sessions: z.array(sessionSummarySchema) }),
  z.object({ session: whatsAppSessionSchema }),
  z.object({ qr: sessionQrSchema }),
  z.object({ sentMessage: z.object({ id: z.string().min(1).max(200).optional(), timestamp: z.string().datetime(), pending: z.boolean().optional(), linkPreview: linkPreviewSchema.optional() }) }),
  z.object({ reactionSent: z.object({ timestamp: z.string().datetime() }) }),
  z.object({ identitySync: z.object({ identity: whatsappIdentitySnapshotSchema.nullable(), group: whatsappGroupSnapshotSchema.nullable() }) }),
  z.object({ historyPage: z.object({ kind: z.enum(['chats','messages']), items: z.array(z.record(z.unknown())), unsupported: z.array(z.string()), hasMore: z.boolean() }) }),
  z.object({ contactsPage: z.object({ items: z.array(z.record(z.unknown())), unsupported: z.array(z.string()), hasMore: z.boolean() }) }),
  z.object({ removed: z.literal(true) }),
  z.object({ completed: z.literal(true) }),
]);
export const internalTransportSuccessResponseSchema = z.object({ success: z.literal(true), correlationId: z.string().min(1), workspaceId: safeIdentifierSchema, data: internalTransportDataSchema });
export const internalTransportFailureResponseSchema = z.object({ success: z.literal(false), correlationId: z.string().min(1), workspaceId: safeIdentifierSchema, error: internalTransportErrorSchema });
export const internalTransportResponseSchema = z.discriminatedUnion('success', [internalTransportSuccessResponseSchema, internalTransportFailureResponseSchema]);
export type InternalTransportResponse = z.infer<typeof internalTransportResponseSchema>;
