import type { GroupParticipant } from "../api/inbox.js";

export type MentionRecord = { display: string; jid: string };
export type MentionToken = string | { jid: string; label: string };

// A mention trigger is an "@" at the start of the text or after whitespace,
// followed by up to 30 letters/numbers/spaces (multi-word display names).
const triggerPattern = /(?:^|\s)@([\p{L}\p{N} ]{0,30})$/u;

export const mentionTrigger = (
  text: string,
  caret: number,
): { start: number; query: string } | null => {
  const match = triggerPattern.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
};

export const insertMention = (
  text: string,
  caret: number,
  start: number,
  display: string,
): { text: string; caret: number } => ({
  text: `${text.slice(0, start)}@${display} ${text.slice(caret)}`,
  caret: start + display.length + 2,
});

// WAHA requires the @digits of every mentioned JID inside the text. Each
// tracked "@Display" becomes "@<digits>"; a record whose display text no
// longer appears was edited away and is dropped instead of failing the send.
export const serializeMentions = (
  text: string,
  records: readonly MentionRecord[],
): { text: string; mentions: string[] } => {
  let output = text;
  const mentions: string[] = [];
  for (const record of records) {
    const needle = `@${record.display}`;
    const index = output.indexOf(needle);
    if (index < 0) continue;
    output = `${output.slice(0, index)}@${record.jid.split("@", 1)[0]}${output.slice(index + needle.length)}`;
    if (!mentions.includes(record.jid)) mentions.push(record.jid);
  }
  return { text: output, mentions };
};

// Received messages carry _data.mentionedJidList in the raw WAHA payload;
// messages sent by this workspace carry metadata.mentions from recordOutbound.
export const mentionJidsOf = (
  metadata: Record<string, unknown> | null | undefined,
): string[] => {
  if (!metadata) return [];
  const own = Array.isArray(metadata.mentions) ? metadata.mentions : [];
  const data =
    metadata._data && typeof metadata._data === "object" && !Array.isArray(metadata._data)
      ? (metadata._data as Record<string, unknown>)
      : undefined;
  const received = data && Array.isArray(data.mentionedJidList) ? data.mentionedJidList : [];
  return [...own, ...received].filter(
    (value): value is string => typeof value === "string" && /@(c\.us|lid)$/.test(value),
  );
};

export const tokenizeMentions = (
  content: string,
  jids: readonly string[],
  resolve: (jid: string) => string | undefined,
): MentionToken[] => {
  const matches: Array<{ index: number; length: number; jid: string }> = [];
  for (const jid of new Set(jids)) {
    const digits = jid.split("@", 1)[0];
    if (!digits) continue;
    const needle = `@${digits}`;
    let from = 0;
    for (;;) {
      const index = content.indexOf(needle, from);
      if (index < 0) break;
      from = index + needle.length;
      const before = index === 0 ? "" : content[index - 1];
      const after = content[index + needle.length] ?? "";
      if (before && !/\s/.test(before)) continue;
      if (after && /[\p{L}\p{N}]/u.test(after)) continue;
      matches.push({ index, length: needle.length, jid });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  const tokens: MentionToken[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) tokens.push(content.slice(cursor, match.index));
    tokens.push({ jid: match.jid, label: resolve(match.jid) ?? match.jid.split("@", 1)[0] });
    cursor = match.index + match.length;
  }
  if (cursor < content.length) tokens.push(content.slice(cursor));
  return tokens;
};

export const normalizeMentionText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");

export const filterParticipants = (
  items: readonly GroupParticipant[],
  query: string,
): GroupParticipant[] => {
  const needle = normalizeMentionText(query.trim());
  if (!needle) return [...items];
  return items.filter(
    (item) =>
      normalizeMentionText(item.name ?? "").includes(needle) ||
      normalizeMentionText(item.phone ?? "").includes(needle) ||
      item.whatsappId.split("@", 1)[0].includes(needle),
  );
};

export const participantDisplay = (participant: GroupParticipant): string =>
  participant.name?.trim() ||
  participant.phone ||
  participant.whatsappId.split("@", 1)[0];
