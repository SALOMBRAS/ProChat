import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ConversationStore } from '../services/waha-webhook.service.js';
import { AppError } from '../errors.js';
import type { InternalInboxService } from '../services/internal-inbox.service.js';

const query = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().positive().max(100).default(25) });
const sendMessage = z.object({ text: z.string().trim().min(1).max(4_096) });
export class InboxController {
  constructor(private readonly conversations: ConversationStore, private readonly inbox: InternalInboxService) {}
  listConversations: RequestHandler = async (req, res) => { const input = query.parse(req.query); res.json(await this.conversations.listConversations(req.context!.workspaceId, input.page, input.pageSize)); };
  listMessages: RequestHandler = async (req, res) => { const input = query.parse(req.query); const conversationId = z.string().uuid().parse(req.params.conversationId); const result = await this.conversations.listMessages(req.context!.workspaceId, conversationId, input.page, input.pageSize); if (!result.total && input.page === 1) { const known = (await this.conversations.listConversations(req.context!.workspaceId, 1, 1)).items.some(item => item.id === conversationId); if (!known) throw new AppError(404, 'NOT_FOUND', 'Conversation not found'); } res.json(result); };
  markRead: RequestHandler = async (req, res) => { const conversationId = z.string().uuid().parse(req.params.conversationId); if (!await this.conversations.markRead(req.context!.workspaceId, conversationId)) throw new AppError(404, 'NOT_FOUND', 'Conversation not found'); res.status(204).end(); };
  sendMessage: RequestHandler = async (req, res) => { const conversationId = z.string().uuid().parse(req.params.conversationId); res.status(201).json(await this.inbox.send(req.context!, conversationId, sendMessage.parse(req.body).text)); };
}
