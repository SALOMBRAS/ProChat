/**
 * GOWA history structs -> the neutral item shape the history pipeline consumes.
 *
 * Field names come from the GOWA source at commit `be8155c5`
 * (`src/domains/chat/chat.go`), not from the OpenAPI, which references
 * `ChatListResponse`/`ChatMessagesResponse` without defining them.
 *
 *   ChatInfo    { jid, name, last_message_time, ephemeral_expiration,
 *                 created_at, updated_at, archived }
 *   MessageInfo { id, chat_jid, sender_jid, sender_display_name, content,
 *                 timestamp, is_from_me, media_type, reactions?,
 *                 call_metadata?, filename, url, file_length }
 *
 * Known debt: the neutral shape below is still the one WAHA emits, because
 * `historyRecord` -> `messageFrom` reads it. Translating here keeps every raw
 * GOWA field at this single boundary — the pipeline never sees `chat_jid` or
 * `is_from_me` — but a fully canonical history contract still has to replace
 * the shared shape on both sides. This adapter is where that swap lands.
 */

/** `chat_jid` is the conversation. `sender_jid` is only ever the author: in a
 * group it is the participant, and promoting it would recreate the false
 * private conversation bug. */
export function gowaHistoryChat(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const jid = text(item.jid);
  if (!jid) return undefined;
  return {
    id: jid,
    ...(text(item.name) ? { name: text(item.name) } : {}),
    ...(text(item.last_message_time) ? { conversationTimestamp: text(item.last_message_time) } : {}),
    ...(item.archived === true ? { archived: true } : {}),
  };
}

export function gowaHistoryMessage(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const id = text(item.id);
  const chatId = text(item.chat_jid);
  if (!id || !chatId) return undefined;
  const group = chatId.toLowerCase().endsWith('@g.us');
  const sender = text(item.sender_jid);
  const url = text(item.url, 2_048);
  const mediaType = text(item.media_type)?.toLowerCase();
  const type = historyType(mediaType, url);
  const message: Record<string, unknown> = {
    id, chatId, timestamp: text(item.timestamp), type,
    fromMe: item.is_from_me === true,
    body: text(item.content, 20_000) ?? null,
  };
  // Author travels as `participant` and only in a group, mirroring WAHA.
  if (group && sender) message.participant = sender;
  if (text(item.sender_display_name)) message.notifyName = text(item.sender_display_name);
  if (type !== 'text') {
    message.hasMedia = true;
    message.media = {
      ...(url ? { url } : {}),
      ...(text(item.filename, 512) ? { filename: text(item.filename, 512) } : {}),
      ...(typeof item.file_length === 'number' && Number.isFinite(item.file_length) ? { filesize: item.file_length } : {}),
    };
  }
  // Kept verbatim so a later canonical contract can use them without a second
  // pass over the provider; nothing downstream reads them today.
  if (Array.isArray(item.reactions) && item.reactions.length) message.reactions = item.reactions;
  if (text(item.call_metadata, 4_000)) message.callMetadata = text(item.call_metadata, 4_000);
  return message;
}

/** GOWA reports the kind in `media_type`; an empty one with no URL is text. */
function historyType(mediaType: string | undefined, url: string | undefined): string {
  if (!mediaType || mediaType === 'text' || mediaType === 'chat') return url ? 'document' : 'text';
  if (mediaType === 'ptt' || mediaType === 'voice') return 'ptt';
  if (['image', 'video', 'audio', 'document', 'sticker', 'location', 'vcard', 'contact', 'call_log'].includes(mediaType)) return mediaType;
  return mediaType;
}

function text(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : undefined;
}

/** Quantos itens da página o adaptador não conseguiu mapear. Vai para
 *  `unsupported`, que o serviço de histórico já sabe reportar. */
export function unmapped(received: number, mapped: number): string[] {
  const lost = received - mapped;
  return lost > 0 ? [`gowa:unmapped:${lost}`] : [];
}
