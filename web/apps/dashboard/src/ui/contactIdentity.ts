import type { InboxConversation } from "../api/inbox.js";

const fallback = "Contato sem identificação";
const technicalIdentifier = (value: string) =>
  /@(?:lid|s\.whatsapp\.net|g\.us|broadcast|newsletter)\b/i.test(value) ||
  /^(?:[a-z0-9_-]+:){2,}[a-z0-9_-]+$/i.test(value);

const safeName = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed && !technicalIdentifier(trimmed) ? trimmed : undefined;
};

export const normalizedPhone = (value: string | null | undefined) => {
  if (!value || technicalIdentifier(value) && !/@c\.us$/i.test(value)) return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : undefined;
};

export const conversationPhone = (conversation: InboxConversation) =>
  normalizedPhone(conversation.identity?.phone) ?? normalizedPhone(conversation.chatId);

export const contactLabel = (conversation: InboxConversation) => {
  if (conversation.conversationType === "group") return "Grupo WhatsApp";
  return (
    safeName(conversation.identity?.profileName) ??
    safeName(conversation.identity?.pushName) ??
    safeName(conversation.identity?.displayName) ??
    safeName(conversation.identity?.contactName) ??
    conversationPhone(conversation) ??
    fallback
  );
};

export const participantLabel = (value: string | null | undefined) =>
  normalizedPhone(value) ?? fallback;

export const safeContactText = (value: string | null | undefined) =>
  safeName(value) ?? fallback;

export const safePhoneText = (value: string | null | undefined) =>
  normalizedPhone(value) ?? fallback;
