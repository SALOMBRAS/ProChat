import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ConversationStore } from '../services/waha-webhook.service.js';

const query = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().positive().max(100).default(25) });
export class InboxController {
  constructor(private readonly conversations: ConversationStore) {}
  listConversations: RequestHandler = async (req, res) => { const input = query.parse(req.query); res.json(await this.conversations.listConversations(req.context!.workspaceId, input.page, input.pageSize)); };
}
