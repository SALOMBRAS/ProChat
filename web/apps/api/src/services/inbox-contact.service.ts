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

  /**
   * WAHA's structured contact carries exactly fullName, organization,
   * phoneNumber and whatsappId. The stored e-mail has nowhere to go there, and
   * smuggling it inside a hand-built vCard string would rely on behaviour the
   * provider documentation does not demonstrate — so it is left out rather than
   * sent in a shape nobody verified.
   */
  async cards(workspaceId: string, contactIds: readonly string[]): Promise<Array<{ fullName: string; phoneNumber: string; organization?: string }>> {
    const contacts = await Promise.all(contactIds.map(id => this.domain.contact(workspaceId, id) as Promise<Record<string, unknown> | undefined>));
    return contacts.map((contact, index) => {
      if (!contact) throw new AppError(404, 'NOT_FOUND', 'Contact not found');
      const fullName = typeof contact.displayName === 'string' ? contact.displayName.trim() : '';
      const phoneNumber = typeof contact.phoneNumber === 'string' ? contact.phoneNumber.trim() : '';
      // Name and phone are what makes a card usable on the other side; a card
      // without either would arrive as an empty entry in WhatsApp.
      if (!fullName || !phoneNumber) throw new AppError(422, 'VALIDATION_ERROR', 'Contact has no name or phone number to share', { contactId: contactIds[index] });
      const organization = typeof contact.company === 'string' && contact.company.trim() ? contact.company.trim() : undefined;
      return { fullName, phoneNumber, ...(organization ? { organization } : {}) };
    });
  }

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
