import { z } from 'zod';
import { AppError } from '../errors.js';
import type { DomainRepository } from '../persistence/domain.repository.js';
import type { ConversationStore, ConversationSummary } from './waha-webhook.service.js';

const createInput = z.object({
  displayName: z.string().trim().min(1).max(160),
  phoneNumber: z.string().trim().min(1).optional(),
  email: z.string().email().nullable().optional(),
  company: z.string().trim().max(160).nullable().optional(),
}).strict();

/**
 * Creating a contact from the Inbox has to bind it to the open conversation.
 * The webhook only sets `conversations.contactId` while ingesting a message
 * (`upsertConversation`), so without an explicit link the conversation would
 * stay unlinked until the contact happened to write again.
 */
export class InboxContactService {
  constructor(private readonly conversations: ConversationStore, private readonly domain: DomainRepository) {}

  async create(workspaceId: string, conversationId: string, body: unknown): Promise<{ contact: unknown; conversation: ConversationSummary }> {
    const input = createInput.parse(body);
    const conversation = await this.conversations.getConversation(workspaceId, conversationId);
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    if (conversation.conversationType === 'group') throw new AppError(400, 'VALIDATION_ERROR', 'Group conversations do not have a contact');
    if (conversation.contactId) throw new AppError(409, 'CONFLICT', 'Conversation already has a contact');
    // Only a `@c.us` chat carries a real phone. A LID's digits parse as a
    // plausible number, so trusting the identity for other chat kinds would
    // store the identifier itself as the contact's phone; there the operator
    // has to supply it.
    const conversationPhone = conversation.chatId.endsWith('@c.us') ? conversation.identity.phone : null;
    const phoneNumber = input.phoneNumber ?? conversationPhone ?? undefined;
    if (!phoneNumber) throw new AppError(400, 'VALIDATION_ERROR', 'Conversation has no phone number; provide phoneNumber');

    const contact = await this.domain.createContact(workspaceId, { displayName: input.displayName, phoneNumber, email: input.email ?? null, company: input.company ?? null }) as { id: string };
    // The contact exists at this point even if the link below fails. That is
    // recoverable — identity resolution links it on the next message — while a
    // rolled back contact would lose what the operator typed.
    const linked = await this.conversations.linkContact(workspaceId, conversationId, contact.id);
    if (!linked) throw new AppError(404, 'NOT_FOUND', 'Conversation not found');
    return { contact, conversation: linked };
  }
}
