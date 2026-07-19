import type { RequestHandler } from 'express';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import multer from 'multer';
import type { ConversationStore } from '../services/waha-webhook.service.js';
import { AppError } from '../errors.js';
import type { InternalInboxService } from '../services/internal-inbox.service.js';
import type { ConversationContextService } from '../services/conversation-context.service.js';
import type { WhatsAppHistorySyncService } from '../services/whatsapp-history-sync.service.js';
import type { AttachmentOutboxService } from '../services/attachment-outbox.service.js';

const query = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().positive().max(100).default(25) });
const sendMessage = z.object({ text: z.string().trim().min(1).max(4_096) });
const contextUpdate = z.object({ notes: z.string().max(10_000).optional(), tags: z.array(z.string().trim().min(1).max(64)).max(20).optional() }).refine(value => value.notes !== undefined || value.tags !== undefined);
const syncRequest = z.object({ wahaSession: z.string().trim().min(1).max(200).optional() });
const attachmentRequest = z.object({ caption: z.string().max(4_096).optional() });
export class InboxController {
  readonly attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } }).single('file');
  constructor(private readonly conversations: ConversationStore, private readonly inbox: InternalInboxService, private readonly context: ConversationContextService, private readonly sync?: WhatsAppHistorySyncService, private readonly sessions?: { list(context: NonNullable<import('express').Request['context']>): Promise<Array<{ id: string; status: string }>> }, private readonly outbox?: AttachmentOutboxService) {}
  listConversations: RequestHandler = async (req, res) => { const input = query.parse(req.query); res.json(await this.conversations.listConversations(req.context!.workspaceId, input.page, input.pageSize)); };
  listMessages: RequestHandler = async (req, res) => { const input = query.parse(req.query); const conversationId = z.string().uuid().parse(req.params.conversationId); const result = await this.conversations.listMessages(req.context!.workspaceId, conversationId, input.page, input.pageSize); if (!result.total && input.page === 1) { const known = (await this.conversations.listConversations(req.context!.workspaceId, 1, 1)).items.some(item => item.id === conversationId); if (!known) throw new AppError(404, 'NOT_FOUND', 'Conversation not found'); } res.json(result); };
  markRead: RequestHandler = async (req, res) => { const conversationId = z.string().uuid().parse(req.params.conversationId); if (!await this.conversations.markRead(req.context!.workspaceId, conversationId)) throw new AppError(404, 'NOT_FOUND', 'Conversation not found'); res.status(204).end(); };
  sendMessage: RequestHandler = async (req, res) => { const conversationId = z.string().uuid().parse(req.params.conversationId); res.status(201).json(await this.inbox.send(req.context!, conversationId, sendMessage.parse(req.body).text)); };
  createAttachment: RequestHandler = async (req, res) => { if (!this.outbox) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Attachment outbox is unavailable'); const conversationId = z.string().uuid().parse(req.params.conversationId); if (!req.file) throw new AppError(400, 'VALIDATION_ERROR', 'A file is required'); const input = attachmentRequest.parse(req.body); res.status(202).json(await this.outbox.create(req.context!, conversationId, req.file, input.caption)); };
  getOutbox: RequestHandler = async (req, res) => { if (!this.outbox) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Attachment outbox is unavailable'); res.json(await this.outbox.get(req.context!, z.string().uuid().parse(req.params.jobId))); };
  cancelOutbox: RequestHandler = async (req, res) => { if (!this.outbox) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Attachment outbox is unavailable'); res.json(await this.outbox.cancel(req.context!, z.string().uuid().parse(req.params.jobId))); };
  getContext: RequestHandler = async (req, res) => { const conversationId = z.string().uuid().parse(req.params.conversationId); const result = await this.context.get(req.context!.workspaceId, conversationId); if (!result) throw new AppError(404, 'NOT_FOUND', 'Conversation not found'); res.json(result); };
  updateContext: RequestHandler = async (req, res) => { const conversationId = z.string().uuid().parse(req.params.conversationId); const result = await this.context.update(req.context!.workspaceId, conversationId, contextUpdate.parse(req.body)); if (!result) throw new AppError(404, 'NOT_FOUND', 'Conversation not found'); res.json(result); };
  startSync: RequestHandler = async (req, res) => { if (!this.sync) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'History synchronization is unavailable'); const requested = syncRequest.parse(req.body).wahaSession; const session = requested ?? await this.connectedWahaSession(req.context!); res.status(202).json(await this.sync.start(req.context!.workspaceId, session)); };
  syncStatus: RequestHandler = async (req, res) => { if (!this.sync) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'History synchronization is unavailable'); const wahaSession = z.string().trim().min(1).max(200).parse(req.query.wahaSession); const job = await this.sync.status(req.context!.workspaceId, wahaSession); if (!job) throw new AppError(404, 'NOT_FOUND', 'Sync job not found'); res.json(job); };
  cancelSync: RequestHandler = async (req, res) => { if (!this.sync) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'History synchronization is unavailable'); const wahaSession = syncRequest.parse(req.body).wahaSession; if (!wahaSession) throw new AppError(400, 'VALIDATION_ERROR', 'wahaSession is required'); const job = await this.sync.cancel(req.context!.workspaceId, wahaSession); if (!job) throw new AppError(404, 'NOT_FOUND', 'Sync job not found'); res.json(job); };
  private async connectedWahaSession(context: NonNullable<import('express').Request['context']>): Promise<string> { const session = (await this.sessions?.list(context))?.find(item => item.status === 'connected'); if (!session) throw new AppError(409, 'CONFLICT', 'No connected WhatsApp session found'); return `chatpro-${createHash('sha256').update(`${context.workspaceId}:${session.id}`).digest('hex').slice(0, 40)}`; }
}
