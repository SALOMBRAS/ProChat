import type { GroupParticipant } from "../api/inbox.js";

/**
 * Menções em grupos — helpers puros (sem React), no padrão de messageMedia.ts.
 *
 * O composer é um textarea de texto puro por decisão de design: o `@Nome`
 * visível é só texto, e a fidelidade da menção é garantida na serialização do
 * submit, que troca cada `@Nome` rastreado pelo `@dígitos` que a WAHA exige.
 * Registro cujo `@Nome` não está mais no texto foi apagado/editado pelo
 * operador e é descartado — o texto sempre manda.
 */

export type MentionRecord = { display: string; jid: string };
export type MentionToken = string | { jid: string; label: string };

/** O que o autocomplete insere e o renderer exibe: nome, telefone ou, em
 *  último caso, os dígitos do JID (LIDs não têm telefone garantido). */
export const participantDisplay = (participant: Pick<GroupParticipant, "name" | "phone" | "whatsappId">): string =>
  participant.name ?? participant.phone ?? participant.whatsappId.split("@", 1)[0];

/** `@` no início ou após espaço, com query de até 30 letras/números/espaços e
 *  sem quebra de linha — é o gatilho do autocomplete. Fora dessa forma, o `@`
 *  é texto comum (e-mail, por exemplo, não abre a lista). */
export const mentionTrigger = (text: string, caret: number): { start: number; query: string } | null => {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([\p{L}\p{N} ]{0,30})$/u.exec(before);
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
};

/** Substitui o `@query` que vai de `start` ao caret por `@Nome ` e devolve a
 *  posição nova do cursor, depois do espaço. */
export const insertMention = (text: string, caret: number, start: number, display: string): { text: string; caret: number } => {
  const next = `${text.slice(0, start)}@${display} ${text.slice(caret)}`;
  return { text: next, caret: start + display.length + 2 };
};

/** Converte cada `@Nome` rastreado no `@dígitos` do JID (primeira ocorrência
 *  restante, literal) e coleta os JIDs deduplicados — é o par `{ text,
 *  mentions }` que a API e a WAHA esperam. */
export const serializeMentions = (text: string, records: readonly MentionRecord[]): { text: string; mentions: string[] } => {
  let output = text;
  const jids: string[] = [];
  for (const record of records) {
    const needle = `@${record.display}`;
    const at = output.indexOf(needle);
    if (at < 0) continue;
    output = `${output.slice(0, at)}@${record.jid.split("@", 1)[0]}${output.slice(at + needle.length)}`;
    if (!jids.includes(record.jid)) jids.push(record.jid);
  }
  return { text: output, mentions: jids };
};

/** JIDs mencionados numa mensagem: `_data.mentionedJidList` nas recebidas
 *  (payload cru da WAHA), `mentions` nas enviadas por nós (gravado no envio). */
export const mentionJidsOf = (metadata: Record<string, unknown> | undefined): string[] => {
  if (!metadata) return [];
  const read = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const data = metadata._data && typeof metadata._data === "object" && !Array.isArray(metadata._data) ? (metadata._data as Record<string, unknown>) : {};
  return [...new Set([...read(data.mentionedJidList), ...read(metadata.mentions)])];
};

/** Quebra o corpo em segmentos de texto e menções: cada `@dígitos` de um JID
 *  conhecido vira `{ jid, label }` com `@Nome` (ou `@dígitos` quando não há
 *  nome); o resto segue como string para o linkify. Início, meio, fim e
 *  múltiplas ocorrências são cobertos pela varredura literal. */
export const tokenizeMentions = (content: string, jids: readonly string[], resolve: (jid: string) => string | null): MentionToken[] => {
  const spans: Array<{ from: number; to: number; jid: string }> = [];
  for (const jid of jids) {
    const needle = `@${jid.split("@", 1)[0]}`;
    if (needle === "@") continue;
    let at = content.indexOf(needle);
    while (at >= 0) {
      spans.push({ from: at, to: at + needle.length, jid });
      at = content.indexOf(needle, at + needle.length);
    }
  }
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  const tokens: MentionToken[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.from < cursor) continue;
    if (span.from > cursor) tokens.push(content.slice(cursor, span.from));
    tokens.push({ jid: span.jid, label: `@${resolve(span.jid) ?? span.jid.split("@", 1)[0]}` });
    cursor = span.to;
  }
  if (cursor < content.length) tokens.push(content.slice(cursor));
  return tokens;
};

const fold = (value: string): string => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");

/** Filtro local do autocomplete: nome, telefone ou dígitos do JID, insensível
 *  a caso e acento (pt-BR). Query vazia devolve a lista inteira — ordenada
 *  pelo backend (recência → alfabética). */
export const filterParticipants = (items: readonly GroupParticipant[], query: string): GroupParticipant[] => {
  const needle = fold(query.trim());
  if (!needle) return [...items];
  return items.filter((item) => fold(item.name ?? "").includes(needle) || fold(item.phone ?? "").includes(needle) || item.whatsappId.split("@", 1)[0].includes(needle));
};

/** Selo de administração do grupo, no vocabulário do WhatsApp. */
export const isGroupAdmin = (role: string | null): boolean => role === "admin" || role === "superadmin";
