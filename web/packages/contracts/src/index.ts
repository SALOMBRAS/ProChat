import { z } from 'zod';

export const safeIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Identifier must contain only letters, numbers, hyphens, and underscores');
export const requestContextSchema = z.object({ userId: z.string().min(1).optional(), workspaceId: safeIdentifierSchema, correlationId: z.string().min(1) });
export type RequestContext = z.infer<typeof requestContextSchema>;

export const errorCodes = ['VALIDATION_ERROR','UNAUTHORIZED','FORBIDDEN','NOT_FOUND','CONFLICT','SERVICE_UNAVAILABLE','NOT_IMPLEMENTED','TIMEOUT'] as const;
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
export const whatsAppSessionSchema = z.object({ id: z.string().min(1), workspaceId: z.string().min(1), name: z.string().min(1), status: sessionStatusSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type WhatsAppSession = z.infer<typeof whatsAppSessionSchema>;
export const createSessionRequestSchema = z.object({ name: z.string().trim().min(1).max(120).optional() });
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export const connectSessionRequestSchema = z.object({ forceQrRefresh: z.boolean().optional().default(false) });
export type ConnectSessionRequest = z.infer<typeof connectSessionRequestSchema>;
export const sessionSummarySchema = whatsAppSessionSchema.pick({ id: true, workspaceId: true, name: true, status: true, updatedAt: true });
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
export const persistenceContactSchema = persistedEntitySchema.extend({ displayName: z.string().trim().min(1).max(160), phoneNumber: normalizedPhoneNumberSchema, email: z.string().email().nullable(), company: z.string().trim().max(160).nullable() });
export const tagSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable() });
export const optOutHistorySchema = persistedEntitySchema.extend({ contactId: z.string().uuid(), source: z.string().trim().min(1).max(80), reason: z.string().trim().max(500).nullable(), occurredAt: z.string().datetime() });
export const templateVariablesSchema = z.array(z.string().trim().min(1).max(80)).max(50).superRefine((variables, ctx) => { if (new Set(variables).size !== variables.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Template variables must be unique' }); });
export const persistenceTemplateSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(120), content: z.string().min(1).max(10_000), variables: templateVariablesSchema });
export const pipelineSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(120) });
export const stageSchema = persistedEntitySchema.extend({ pipelineId: z.string().uuid(), name: z.string().trim().min(1).max(120), position: z.number().int().nonnegative() });
export const leadSchema = persistedEntitySchema.extend({ stageId: z.string().uuid(), contactId: z.string().uuid().nullable(), title: z.string().trim().min(1).max(160) });
export const leadNoteSchema = persistedEntitySchema.extend({ leadId: z.string().uuid(), body: z.string().trim().min(1).max(10_000) });
export const activitySchema = persistedEntitySchema.extend({ leadId: z.string().uuid(), type: z.string().trim().min(1).max(80), details: z.record(z.unknown()), occurredAt: z.string().datetime() });
export const campaignStatusSchema = z.enum(['draft', 'scheduled', 'ready', 'blocked', 'cancelled']);
export const campaignSchema = persistedEntitySchema.extend({ name: z.string().trim().min(1).max(160), templateId: z.string().uuid().nullable(), status: campaignStatusSchema, scheduledAt: z.string().datetime().nullable() });
export const workspaceSettingsSchema = persistedEntitySchema.extend({ settings: z.record(z.unknown()) });
export type PersistenceContact = z.infer<typeof persistenceContactSchema>; export type Tag = z.infer<typeof tagSchema>; export type OptOutHistory = z.infer<typeof optOutHistorySchema>; export type PersistenceTemplate = z.infer<typeof persistenceTemplateSchema>; export type Pipeline = z.infer<typeof pipelineSchema>; export type Stage = z.infer<typeof stageSchema>; export type Lead = z.infer<typeof leadSchema>; export type LeadNote = z.infer<typeof leadNoteSchema>; export type Activity = z.infer<typeof activitySchema>; export type Campaign = z.infer<typeof campaignSchema>; export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const eventTypes = ['system.connected','session.status.changed','session.qr.updated','message.received','message.status.updated','worker.error'] as const;
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
export const internalSendMessageCommandSchema = z.object({ type: z.literal('message.send'), payload: z.object({ wahaSession: z.string().trim().min(1).max(200), chatId: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(4_096) }) });
export const internalTransportCommandSchema = z.discriminatedUnion('type', [internalTransportPingCommandSchema, internalListSessionsCommandSchema, internalCreateSessionCommandSchema, internalSessionCommandSchema, internalSendMessageCommandSchema]);
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
  z.object({ sentMessage: z.object({ id: z.string().min(1).max(200), timestamp: z.string().datetime() }) }),
  z.object({ removed: z.literal(true) }),
  z.object({ completed: z.literal(true) }),
]);
export const internalTransportSuccessResponseSchema = z.object({ success: z.literal(true), correlationId: z.string().min(1), workspaceId: safeIdentifierSchema, data: internalTransportDataSchema });
export const internalTransportFailureResponseSchema = z.object({ success: z.literal(false), correlationId: z.string().min(1), workspaceId: safeIdentifierSchema, error: internalTransportErrorSchema });
export const internalTransportResponseSchema = z.discriminatedUnion('success', [internalTransportSuccessResponseSchema, internalTransportFailureResponseSchema]);
export type InternalTransportResponse = z.infer<typeof internalTransportResponseSchema>;
