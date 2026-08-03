import type { InboxConversation } from "../api/inbox.js";

const fallback = "Contato sem identificação";
const technicalIdentifier = (value: string) =>
  /@(?:lid|s\.whatsapp\.net|g\.us|broadcast|newsletter)\b/i.test(value) ||
  /^(?:[a-z0-9_-]+:){2,}[a-z0-9_-]+$/i.test(value);

/** Um nome só de dígitos não é nome.
 *
 *  Medido na base em 03/08/2026: **66 dos 93 contatos** têm `displayName`
 *  idêntico ao telefone. Não é campo vazio — é uma cópia —, então testar por
 *  vazio não pega nenhum deles.
 *
 *  O teste é a forma, não a igualdade com o telefone daquele contato: um nome
 *  que é só algarismos e pontuação não vira nome por ser diferente do número
 *  gravado ao lado.
 *
 *  Nasceu no `ContactPicker` (#129) e mora aqui desde que o card do Kanban
 *  passou a precisar da mesma regra — duas cópias divergiriam. */
export const realName = (value: string | null | undefined) => {
  const name = value?.trim();
  if (!name || /^[+(]?[\d\s().+-]+$/.test(name)) return undefined;
  return name;
};

const safeName = (value: string | null | undefined) => {
  const trimmed = realName(value);
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
