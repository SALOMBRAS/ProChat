import type { CreateSessionRequest, RequestContext, WhatsAppSession } from '@chatpro/contracts';
import {
  WorkerOperationError,
  type ContactsPage,
  type HistoryPage,
  type IdentitySyncResult,
  type NormalizedProviderEvent,
  type ProviderChatTarget,
  type ProviderContactCard,
  type ProviderGroup,
  type ProviderGroupParticipant,
  type ProviderLocation,
  type ProviderMedia,
  type ProviderPage,
  type ProviderQrCode,
  type ProviderSessionTarget,
  type SentMessage,
  type WhatsAppProvider,
  type WhatsAppProviderCapability,
  type WhatsAppProviderName,
  type WorkerCommand,
  type WorkerCommandResult,
} from './ports.js';

/**
 * Neutral operations expressed in terms of the command each provider already
 * executes. The point is that WAHA keeps running through exactly the same
 * `execute` path it ran through before: this layer adds vocabulary and a
 * capability gate, not a second code path.
 *
 * The gate runs *before* the provider is touched, so an unimplemented feature
 * fails as NOT_IMPLEMENTED with the capability named, instead of surfacing as
 * a vendor 404 that reads like an outage.
 */
export abstract class CommandBackedWhatsAppProvider implements WhatsAppProvider {
  abstract readonly provider: WhatsAppProviderName;
  abstract readonly capabilities: readonly WhatsAppProviderCapability[];
  abstract execute(context: RequestContext, command: WorkerCommand): Promise<WorkerCommandResult>;
  abstract shutdown(): Promise<void> | void;

  supports(capability: WhatsAppProviderCapability): boolean {
    return this.capabilities.includes(capability);
  }

  listSessions(context: RequestContext): Promise<WhatsAppSession[]> {
    return this.run(context, 'sessions', 'listSessions', { type: 'listSessions' });
  }

  createSession(context: RequestContext, sessionId: string, input: CreateSessionRequest): Promise<WhatsAppSession> {
    return this.run(context, 'sessions', 'createSession', { type: 'createSession', sessionId, input });
  }

  sessionStatus(context: RequestContext, target: ProviderSessionTarget): Promise<WhatsAppSession> {
    return this.run(context, 'status', 'sessionStatus', { type: 'getSession', sessionId: target.sessionId });
  }

  connectSession(context: RequestContext, target: ProviderSessionTarget): Promise<void> {
    return this.run(context, 'sessions', 'connectSession', { type: 'connectSession', sessionId: target.sessionId });
  }

  sessionQr(context: RequestContext, target: ProviderSessionTarget): Promise<ProviderQrCode> {
    return this.run(context, 'sessions', 'sessionQr', { type: 'getQr', sessionId: target.sessionId });
  }

  logoutSession(context: RequestContext, target: ProviderSessionTarget): Promise<void> {
    return this.run(context, 'sessions', 'logoutSession', { type: 'logoutSession', sessionId: target.sessionId });
  }

  removeSession(context: RequestContext, target: ProviderSessionTarget): Promise<void> {
    return this.run(context, 'sessions', 'removeSession', { type: 'removeSession', sessionId: target.sessionId });
  }

  sendText(context: RequestContext, target: ProviderChatTarget, text: string, options: { mentions?: readonly string[]; linkPreview?: boolean } = {}): Promise<SentMessage> {
    return this.run(context, 'sendMessage', 'sendText', {
      type: 'sendMessage', wahaSession: target.sessionId, chatId: target.chatId, text,
      ...(options.mentions?.length ? { mentions: options.mentions } : {}),
      ...(options.linkPreview === undefined ? {} : { linkPreview: options.linkPreview }),
    });
  }

  sendImage(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage> {
    return this.attachment(context, 'sendImage', 'image', target, media);
  }

  sendFile(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage> {
    return this.attachment(context, 'sendFile', 'document', target, media);
  }

  sendAudio(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage> {
    return this.attachment(context, 'sendAudio', 'audio', target, media);
  }

  sendVideo(context: RequestContext, target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage> {
    return this.attachment(context, 'sendVideo', 'video', target, media);
  }

  sendLocation(context: RequestContext, target: ProviderChatTarget, location: ProviderLocation): Promise<SentMessage> {
    return this.run(context, 'sendContent', 'sendLocation', {
      type: 'sendContent', wahaSession: target.sessionId, chatId: target.chatId,
      content: { kind: 'location', latitude: location.latitude, longitude: location.longitude, ...(location.title ? { title: location.title } : {}) },
    });
  }

  sendContact(context: RequestContext, target: ProviderChatTarget, contacts: readonly ProviderContactCard[]): Promise<SentMessage> {
    return this.run(context, 'sendContent', 'sendContact', {
      type: 'sendContent', wahaSession: target.sessionId, chatId: target.chatId,
      content: { kind: 'vcard', contacts: contacts.map(contact => ({ ...contact })) },
    });
  }

  getContacts(context: RequestContext, target: ProviderSessionTarget, page: ProviderPage): Promise<ContactsPage> {
    return this.run(context, 'contacts', 'getContacts', { type: 'contactsPage', wahaSession: target.sessionId, offset: page.offset, limit: page.limit });
  }

  /** WAHA returns the avatar inside the identity sync result; there is no
   * dedicated avatar command, so this reads the one field it needs. */
  async getAvatar(context: RequestContext, target: ProviderChatTarget): Promise<string | null> {
    const result = await this.run<IdentitySyncResult>(context, 'contacts', 'getAvatar', { type: 'syncIdentity', wahaSession: target.sessionId, chatId: target.chatId, refreshIdentity: true, refreshGroup: false });
    return result?.identity?.profilePictureUrl ?? null;
  }

  listChats(context: RequestContext, target: ProviderSessionTarget, page: ProviderPage): Promise<HistoryPage> {
    return this.run(context, 'history', 'listChats', { type: 'historyPage', wahaSession: target.sessionId, offset: page.offset, limit: page.limit });
  }

  listMessages(context: RequestContext, target: ProviderChatTarget, page: ProviderPage): Promise<HistoryPage> {
    return this.run(context, 'history', 'listMessages', { type: 'historyPage', wahaSession: target.sessionId, chatId: target.chatId, offset: page.offset, limit: page.limit });
  }

  async getGroupInfo(context: RequestContext, target: ProviderChatTarget): Promise<ProviderGroup | null> {
    const result = await this.run<IdentitySyncResult>(context, 'groups', 'getGroupInfo', { type: 'syncIdentity', wahaSession: target.sessionId, chatId: target.chatId, refreshIdentity: false, refreshGroup: true });
    return result?.group ?? null;
  }

  async getGroupParticipants(context: RequestContext, target: ProviderChatTarget): Promise<readonly ProviderGroupParticipant[]> {
    return (await this.getGroupInfo(context, target))?.participants ?? [];
  }

  /** No provider declares `webhookNormalization` yet: see WhatsAppProviderOperations. */
  normalizeWebhook(_event: unknown, correlationId: string): NormalizedProviderEvent[] {
    throw this.unsupported('webhookNormalization', 'normalizeWebhook', correlationId);
  }

  private attachment(context: RequestContext, operation: string, type: 'image' | 'audio' | 'video' | 'document', target: ProviderChatTarget, media: ProviderMedia): Promise<SentMessage> {
    return this.run(context, 'sendMedia', operation, {
      type: 'sendAttachment', wahaSession: target.sessionId, chatId: target.chatId,
      attachment: { type, url: media.url, filename: media.filename, mimeType: media.mimeType, ...(media.caption ? { caption: media.caption } : {}), ...(media.voiceNote === undefined ? {} : { voiceNote: media.voiceNote }) },
    });
  }

  private async run<T>(context: RequestContext, capability: WhatsAppProviderCapability, operation: string, command: WorkerCommand): Promise<T> {
    if (!this.supports(capability)) throw this.unsupported(capability, operation, context.correlationId);
    return (await this.execute(context, command)) as T;
  }

  private unsupported(capability: WhatsAppProviderCapability, operation: string, correlationId: string): WorkerOperationError {
    return new WorkerOperationError('NOT_IMPLEMENTED', `Provider ${this.provider} does not implement ${operation}`, correlationId, { provider: this.provider, operation, capability });
  }
}
