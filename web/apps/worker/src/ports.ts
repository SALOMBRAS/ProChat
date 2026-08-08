import type { ApiError, CreateSessionRequest, EventEnvelope, RequestContext, SendableContent, WhatsAppSession } from '@chatpro/contracts';
/** Provider identifiers are independent from persistence and transport naming. */
export type WhatsAppProviderName = 'baileys' | 'gowa' | 'waha';
/**
 * `sendContent` covers location and vCard, which WAHA delivers through one
 * command and GOWA through two endpoints. `webhookNormalization` is declared
 * but not yet held by any provider — see WhatsAppProviderOperations.
 */
export type WhatsAppProviderCapability = 'health' | 'sessions' | 'status' | 'sendMessage' | 'sendMedia' | 'sendContent' | 'contacts' | 'groups' | 'reactions' | 'history' | 'webhookNormalization';
export type IdentitySyncResult = { identity: { whatsappId: string; canonicalWhatsappId: string; phone: string | null; name: string | null; pushName: string | null; shortName: string | null; profilePictureUrl: string | null } | null; group: { chatId: string; name: string | null; pictureUrl: string | null; metadata: Record<string, unknown>; participants: Array<{ whatsappId: string; role: string | null }> } | null };
export type HistoryPage = { kind: 'chats' | 'messages'; items: Record<string, unknown>[]; unsupported: string[]; hasMore: boolean };
export type ContactsPage = { items: Record<string, unknown>[]; unsupported: string[]; hasMore: boolean };
export type LidsPage = { items: Record<string, unknown>[]; unsupported: string[]; hasMore: boolean };
export type WorkerCommand = { type: 'listSessions' } | { type: 'createSession'; sessionId: string; input: CreateSessionRequest } | { type: 'connectSession' | 'disconnectSession' | 'logoutSession' | 'removeSession'; sessionId: string } | { type: 'getSession' | 'getQr'; sessionId: string } | { type: 'sendMessage'; wahaSession: string; chatId: string; text: string; mentions?: readonly string[]; linkPreview?: boolean } | { type: 'sendAttachment'; wahaSession: string; chatId: string; attachment: { type: 'image' | 'audio' | 'video' | 'document'; url: string; filename: string; mimeType: string; caption?: string; voiceNote?: boolean } } | { type: 'sendContent'; wahaSession: string; chatId: string; content: SendableContent } | { type: 'sendReaction'; wahaSession: string; chatId: string; messageId: string; reaction: string } | { type: 'syncIdentity'; wahaSession: string; chatId: string; senderWhatsappId?: string; refreshIdentity: boolean; refreshGroup: boolean } | { type: 'historyPage'; wahaSession: string; chatId?: string; offset: number; limit: number } | { type: 'contactsPage'; wahaSession: string; offset: number; limit: number } | { type: 'lidsPage'; wahaSession: string; offset: number; limit: number } | { type: 'mergeSessionAliases'; sessionId: string; aliases: string[] };
export type SentMessage = { id?: string; timestamp: string; pending?: boolean };
/** Everything `execute` can hand back, named so the neutral layer and the port
 * cannot drift apart. */
export type WorkerCommandResult = WhatsAppSession[] | WhatsAppSession | { sessionId: string; workspaceId: string; qr: string; expiresAt: string } | SentMessage | IdentitySyncResult | HistoryPage | ContactsPage | void;
export interface WhatsAppWorkerPort { execute(context: RequestContext, command: WorkerCommand): Promise<WorkerCommandResult>; }
/**
 * Stable boundary for HTTP-backed WhatsApp providers. Capabilities describe
 * what has actually been implemented so an unfinished provider is never
 * mistaken for a feature-complete one.
 */
/**
 * Provider-neutral vocabulary. `sessionId` is deliberately not called
 * `wahaSession`: the persistence columns keep the legacy name for now, but a
 * provider contract must not spell one vendor into every call site. The
 * workspace always comes from RequestContext, never from a parameter.
 */
export type ProviderSessionTarget = { sessionId: string };
export type ProviderChatTarget = ProviderSessionTarget & { chatId: string };
export type ProviderPage = { offset: number; limit: number };
export type ProviderQrCode = { sessionId: string; workspaceId: string; qr: string; expiresAt: string };
export type ProviderMedia = { url: string; filename: string; mimeType: string; caption?: string; voiceNote?: boolean };
export type ProviderLocation = { latitude: number; longitude: number; title?: string };
export type ProviderContactCard = { fullName: string; phoneNumber: string; organization?: string };
export type ProviderGroup = NonNullable<IdentitySyncResult['group']>;
export type ProviderGroupParticipant = ProviderGroup['participants'][number];
/** Shape a provider webhook must be reduced to before it reaches the Inbox. */
export type NormalizedProviderEvent =
  | { kind: 'message'; sessionId: string; chatId: string; messageId: string; fromMe: boolean; participant?: string; occurredAt: string }
  | { kind: 'message.status'; sessionId: string; messageId: string; status: 'sent' | 'delivered' | 'read'; occurredAt: string }
  | { kind: 'session.status'; sessionId: string; status: string; occurredAt: string }
  | { kind: 'ignored' };

/**
 * Everything the ChatPro actually asks a WhatsApp provider to do, in neutral
 * terms. Anything a provider has not implemented raises NOT_IMPLEMENTED
 * through the capability gate rather than failing deeper with a vendor error.
 *
 * `normalizeWebhook` is part of the contract but no provider declares
 * `webhookNormalization` yet: both normalizers live API-side today
 * (waha-webhook.service.ts, gowa-webhook.service.ts) because the webhook
 * arrives at the API, not at the worker. Moving them is a change to the
 * webhook/identity/persistence cycle and needs its own regression pass.
 */
export interface WhatsAppProviderOperations {
  listSessions(context: RequestContext): Promise<WhatsAppSession[]>;
  createSession(context: RequestContext, sessionId: string, input: CreateSessionRequest): Promise<WhatsAppSession>;
  sessionStatus(context: RequestContext, target: ProviderSessionTarget): Promise<WhatsAppSession>;
  connectSession(context: RequestContext, target: ProviderSessionTarget): Promise<void>;
  sessionQr(context: RequestContext, target: ProviderSessionTarget): Promise<ProviderQrCode>;
  logoutSession(context: RequestContext, target: ProviderSessionTarget): Promise<void>;
  removeSession(context: RequestContext, target: ProviderSessionTarget): Promise<void>;

  sendText(context: RequestContext, target: ProviderChatTarget, text: string, options?: { mentions?: readonly string[]; linkPreview?: boolean }): Promise<SentMessage>;
  sendImage(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage>;
  sendFile(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage>;
  sendAudio(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage>;
  sendVideo(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage>;
  sendLocation(context: RequestContext, target: ProviderChatTarget, location: ProviderLocation): Promise<SentMessage>;
  sendContact(context: RequestContext, target: ProviderChatTarget, contacts: readonly ProviderContactCard[]): Promise<SentMessage>;

  getContacts(context: RequestContext, target: ProviderSessionTarget, page: ProviderPage): Promise<ContactsPage>;
  getAvatar(context: RequestContext, target: ProviderChatTarget): Promise<string | null>;

  listChats(context: RequestContext, target: ProviderSessionTarget, page: ProviderPage): Promise<HistoryPage>;
  listMessages(context: RequestContext, target: ProviderChatTarget, page: ProviderPage): Promise<HistoryPage>;

  getGroupInfo(context: RequestContext, target: ProviderChatTarget): Promise<ProviderGroup | null>;
  getGroupParticipants(context: RequestContext, target: ProviderChatTarget): Promise<readonly ProviderGroupParticipant[]>;

  normalizeWebhook(event: unknown, correlationId: string): NormalizedProviderEvent[];
}

export interface WhatsAppProvider extends WhatsAppWorkerPort, WhatsAppProviderOperations {
  readonly provider: WhatsAppProviderName;
  readonly capabilities: readonly WhatsAppProviderCapability[];
  supports(capability: WhatsAppProviderCapability): boolean;
  shutdown(): Promise<void> | void;
}
export interface SessionRepositoryPort { /* persistence adapter to be implemented */ }
export interface EventPublisherPort { publish(event: EventEnvelope): Promise<void>; }
export interface CredentialStorePort { authDirectory(workspaceId: string, sessionId: string): string; prepareAuthDirectory(workspaceId: string, sessionId: string): Promise<string>; hasAuthDirectory(workspaceId: string, sessionId: string): Promise<boolean>; removeAuthDirectory(workspaceId: string, sessionId: string): Promise<void>; discoverSessions(): Promise<Array<{ workspaceId: string; sessionId: string }>>; }
export class WorkerUnavailableError extends Error { readonly response: ApiError; constructor(correlationId: string) { super('WhatsApp worker adapter is not connected'); this.response = { error: { code: 'SERVICE_UNAVAILABLE', message: this.message, correlationId, details: {} } }; } }
export class WorkerOperationError extends Error { readonly response: ApiError; constructor(code: ApiError['error']['code'], message: string, correlationId: string, details: Record<string, unknown> = {}) { super(message); this.name = 'WorkerOperationError'; this.response = { error: { code, message, correlationId, details } }; } }
