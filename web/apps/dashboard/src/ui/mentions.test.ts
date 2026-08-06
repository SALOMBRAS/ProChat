import { describe, expect, it } from "vitest";
import type { GroupParticipant } from "../api/inbox.js";
import { filterParticipants, insertMention, isGroupAdmin, mentionJidsOf, mentionTrigger, participantDisplay, serializeMentions, tokenizeMentions } from "./mentions.js";

/**
 * Menções em grupos (T3) — helpers puros: gatilho do `@`, inserção do nome,
 * serialização para o formato que a WAHA exige (`@dígitos` + array de JIDs),
 * destaque no corpo e filtro do autocomplete.
 */
const ada: GroupParticipant = { whatsappId: "5511999990001@c.us", name: "Ada Lovelace", phone: "5511999990001", role: null, avatarUrl: null, lastActiveAt: null };
const bento: GroupParticipant = { whatsappId: "123456789012345@lid", name: null, phone: null, role: "admin", avatarUrl: null, lastActiveAt: null };

describe("mentions helpers", () => {
  it("participantDisplay falls back from name to phone to JID digits", () => {
    expect(participantDisplay(ada)).toBe("Ada Lovelace");
    expect(participantDisplay({ ...ada, name: null })).toBe("5511999990001");
    expect(participantDisplay(bento)).toBe("123456789012345");
  });
  it("mentionTrigger only fires on @ at the start or after whitespace, with a bounded query", () => {
    expect(mentionTrigger("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionTrigger("oi @ad", 6)).toEqual({ start: 3, query: "ad" });
    // E-mail não é menção: o @ não está em início nem após espaço.
    expect(mentionTrigger("ana@exemplo", 11)).toBeNull();
    expect(mentionTrigger("sem arroba", 10)).toBeNull();
    // Quebra de linha ANTES do @ é gatilho válido (parágrafo novo); quebra
    // DENTRO da query encerra — o @ anterior deixa de valer.
    expect(mentionTrigger("oi\n@ad", 6)).toEqual({ start: 3, query: "ad" });
    expect(mentionTrigger("oi @ada\nbe", 11)).toBeNull();
  });
  it("insertMention replaces the @query with @Name and lands the caret after the space", () => {
    const inserted = insertMention("oi @ad tudo?", 6, 3, "Ada Lovelace");
    expect(inserted.text).toBe("oi @Ada Lovelace  tudo?");
    expect(inserted.caret).toBe(3 + "Ada Lovelace".length + 2);
  });
  it("serializeMentions converts each tracked @Name into @digits and collects deduped JIDs", () => {
    const records = [{ display: "Ada Lovelace", jid: ada.whatsappId }];
    expect(serializeMentions("oi @Ada Lovelace e @Ada Lovelace de novo", records)).toEqual({ text: "oi @5511999990001 e @Ada Lovelace de novo", mentions: [ada.whatsappId] });
    // Apagou o nome? O registro é descartado — o texto sempre manda.
    expect(serializeMentions("oi pessoal", records)).toEqual({ text: "oi pessoal", mentions: [] });
    // Vários registros, dedupe por JID.
    const two = serializeMentions("@Ada Lovelace e @123456789012345", [...records, { display: "123456789012345", jid: bento.whatsappId }]);
    expect(two.text).toBe("@5511999990001 e @123456789012345");
    expect(two.mentions).toEqual([ada.whatsappId, bento.whatsappId]);
  });
  it("mentionJidsOf reads _data.mentionedJidList on inbound and mentions on outbound, deduped", () => {
    expect(mentionJidsOf(undefined)).toEqual([]);
    expect(mentionJidsOf({})).toEqual([]);
    expect(mentionJidsOf({ _data: { mentionedJidList: [ada.whatsappId, bento.whatsappId] } })).toEqual([ada.whatsappId, bento.whatsappId]);
    expect(mentionJidsOf({ mentions: [ada.whatsappId] })).toEqual([ada.whatsappId]);
    expect(mentionJidsOf({ _data: { mentionedJidList: [ada.whatsappId] }, mentions: [ada.whatsappId] })).toEqual([ada.whatsappId]);
    expect(mentionJidsOf({ _data: { mentionedJidList: [42] } })).toEqual([]);
  });
  it("tokenizeMentions splits text and mention spans, resolving labels and skipping overlaps", () => {
    const tokens = tokenizeMentions("oi @5511999990001, viu @123456789012345?", [ada.whatsappId, bento.whatsappId], jid => (jid === ada.whatsappId ? "Ada Lovelace" : null));
    expect(tokens).toEqual(["oi ", { jid: ada.whatsappId, label: "@Ada Lovelace" }, ", viu ", { jid: bento.whatsappId, label: "@123456789012345" }, "?"]);
    expect(tokenizeMentions("sem menção", [ada.whatsappId], () => null)).toEqual(["sem menção"]);
  });
  it("filterParticipants matches name, phone or digits, case- and accent-insensitive", () => {
    const items = [ada, bento, { ...ada, whatsappId: "5511888880002@c.us", name: "Cáio", phone: "5511888880002" }];
    expect(filterParticipants(items, "")).toHaveLength(3);
    expect(filterParticipants(items, "ada")).toEqual([ada]);
    expect(filterParticipants(items, "CAIO").map(item => item.name)).toEqual(["Cáio"]);
    expect(filterParticipants(items, "88888").map(item => item.phone)).toEqual(["5511888880002"]);
    expect(filterParticipants(items, "123456789012345")).toEqual([bento]);
    expect(filterParticipants(items, "zzz")).toEqual([]);
  });
  it("isGroupAdmin accepts the WhatsApp vocabulary for admins", () => {
    expect(isGroupAdmin("admin")).toBe(true);
    expect(isGroupAdmin("superadmin")).toBe(true);
    expect(isGroupAdmin(null)).toBe(false);
    expect(isGroupAdmin("left")).toBe(false);
  });
});
