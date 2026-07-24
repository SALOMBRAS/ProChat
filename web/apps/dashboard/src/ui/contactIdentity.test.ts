import { describe, expect, it } from "vitest";
import type { InboxConversation } from "../api/inbox.js";
import { contactLabel, conversationPhone, participantLabel } from "./contactIdentity.js";

const conversation = (identity: InboxConversation["identity"], chatId = "100000000000001@lid"): InboxConversation => ({ id: "10000000-0000-4000-8000-000000000001", whatsappSessionId: "session-a", chatId, contactId: null, conversationType: "direct", assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null, routingLockedAt: null, status: "open", priority: "normal", lastStatusChange: null, lastMessage: null, lastMessageAt: "2026-07-24T12:00:00.000Z", unreadCount: 0, createdAt: "2026-07-24T12:00:00.000Z", updatedAt: "2026-07-24T12:00:00.000Z", identity });

describe("contact identity presentation", () => {
  it("never turns a LID or JID into visible contact text", () => {
    const label = contactLabel(conversation({ displayName: null, phone: null, pushName: null, profileName: null, avatarUrl: null, lastSyncAt: null, syncStatus: "pending", knownContact: false }));
    expect(label).toBe("Contato sem identificação");
    expect(conversationPhone(conversation({ displayName: null, phone: null, pushName: null, profileName: null, avatarUrl: null, lastSyncAt: null, syncStatus: "pending", knownContact: false }))).toBeUndefined();
    expect(participantLabel("100000000000001@lid")).toBe("Contato sem identificação");
  });

  it("prefers WhatsApp name, then ChatPro name, then a normalized real phone", () => {
    expect(contactLabel(conversation({ displayName: "Nome WhatsApp", phone: "5511999990000", pushName: "Apelido WhatsApp", profileName: "Nome WhatsApp", contactName: "Nome ChatPro", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true }, "5511999990000@c.us"))).toBe("Nome WhatsApp");
    expect(contactLabel(conversation({ displayName: null, phone: "5511999990000", pushName: null, profileName: null, contactName: "Nome ChatPro", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true }, "5511999990000@c.us"))).toBe("Nome ChatPro");
    expect(contactLabel(conversation({ displayName: null, phone: null, pushName: null, profileName: null, avatarUrl: null, lastSyncAt: null, syncStatus: "pending", knownContact: false }, "5511999990000@c.us"))).toBe("5511999990000");
  });
});
