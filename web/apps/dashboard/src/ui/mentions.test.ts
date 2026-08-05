import { describe, expect, it } from "vitest";
import type { GroupParticipant } from "../api/inbox.js";
import { filterParticipants, insertMention, mentionJidsOf, mentionTrigger, participantDisplay, serializeMentions, tokenizeMentions } from "./mentions.js";

const participant = (whatsappId: string, name: string | null = null, phone: string | null = null, role: string | null = null): GroupParticipant => ({ whatsappId, name, phone, role, avatarUrl: null, lastActiveAt: null });

describe("mentionTrigger", () => {
  it("opens on @ at the start or after whitespace and carries the query", () => {
    expect(mentionTrigger("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionTrigger("oi @An", 6)).toEqual({ start: 3, query: "An" });
    expect(mentionTrigger("oi\n@An", 6)).toEqual({ start: 3, query: "An" });
    expect(mentionTrigger("bom dia @Maria Jo", 17)).toEqual({ start: 8, query: "Maria Jo" });
  });
  it("ignores @ glued to a word, after a line break, or past 30 characters", () => {
    expect(mentionTrigger("email@provedor", 8)).toBeNull();
    expect(mentionTrigger("@Ana\n", 5)).toBeNull();
    expect(mentionTrigger(`@${"a".repeat(31)}`, 32)).toBeNull();
  });
});

describe("insertMention", () => {
  it("replaces the partial query with the display name and a trailing space", () => {
    expect(insertMention("oi @An tudo", 6, 3, "Ana")).toEqual({ text: "oi @Ana  tudo", caret: 8 });
    expect(insertMention("@Ma", 3, 0, "Maria")).toEqual({ text: "@Maria ", caret: 7 });
  });
});

describe("serializeMentions", () => {
  const records = [
    { display: "Ana", jid: "5511999990001@c.us" },
    { display: "Bruno", jid: "100000000000001@lid" },
  ];
  it("converts each tracked display into the WAHA @digits form", () => {
    expect(serializeMentions("@Ana e @Bruno, vejam isso", records)).toEqual({ text: "@5511999990001 e @100000000000001, vejam isso", mentions: ["5511999990001@c.us", "100000000000001@lid"] });
  });
  it("drops records whose display text was edited away and dedups JIDs", () => {
    expect(serializeMentions("ola @An e @An", [{ display: "An", jid: "5511999990001@c.us" }, { display: "An", jid: "5511999990001@c.us" }, { display: "Sumiu", jid: "5511999990002@c.us" }])).toEqual({ text: "ola @5511999990001 e @5511999990001", mentions: ["5511999990001@c.us"] });
  });
  it("returns no mentions for plain text", () => {
    expect(serializeMentions("sem menção", records)).toEqual({ text: "sem menção", mentions: [] });
  });
});

describe("mentionJidsOf", () => {
  it("reads received _data.mentionedJidList and our own sent mentions", () => {
    expect(mentionJidsOf({ _data: { mentionedJidList: ["100000000000001@lid"] } })).toEqual(["100000000000001@lid"]);
    expect(mentionJidsOf({ mentions: ["5511999990001@c.us"] })).toEqual(["5511999990001@c.us"]);
    expect(mentionJidsOf({ mentions: ["5511999990001@c.us"], _data: { mentionedJidList: ["100000000000001@lid", "lixo"] } })).toEqual(["5511999990001@c.us", "100000000000001@lid"]);
  });
  it("tolerates missing or malformed metadata", () => {
    expect(mentionJidsOf(undefined)).toEqual([]);
    expect(mentionJidsOf({})).toEqual([]);
    expect(mentionJidsOf({ _data: "texto" })).toEqual([]);
  });
});

describe("tokenizeMentions", () => {
  const resolve = (jid: string) => (jid === "5511999990001@c.us" ? "Ana" : undefined);
  it("splits mentions at the start, middle, and end of the content", () => {
    expect(tokenizeMentions("@5511999990001 oi @100000000000001 tchau @5511999990001", ["5511999990001@c.us", "100000000000001@lid"], resolve)).toEqual([
      { jid: "5511999990001@c.us", label: "Ana" },
      " oi ",
      { jid: "100000000000001@lid", label: "100000000000001" },
      " tchau ",
      { jid: "5511999990001@c.us", label: "Ana" },
    ]);
  });
  it("does not match partial digits or mid-word occurrences", () => {
    expect(tokenizeMentions("x@5511999990001 e @55119999900012", ["5511999990001@c.us"], resolve)).toEqual(["x@5511999990001 e @55119999900012"]);
  });
});

describe("filterParticipants", () => {
  const items = [participant("5511999990001@c.us", "João Silva", "5511999990001"), participant("100000000000001@lid", null, null), participant("5511999990003@c.us", "Ana", "5511999990003", "admin")];
  it("matches name, phone, or JID digits, ignoring case and accents", () => {
    expect(filterParticipants(items, "joao").map((item) => item.whatsappId)).toEqual(["5511999990001@c.us"]);
    expect(filterParticipants(items, "ANA")).toEqual([items[2]]);
    expect(filterParticipants(items, "100000000000001")).toEqual([items[1]]);
    expect(filterParticipants(items, "")).toHaveLength(3);
  });
});

describe("participantDisplay", () => {
  it("prefers the name, then the phone, then the JID digits", () => {
    expect(participantDisplay(participant("5511999990001@c.us", "Ana", "5511999990001"))).toBe("Ana");
    expect(participantDisplay(participant("5511999990001@c.us", null, "5511999990001"))).toBe("5511999990001");
    expect(participantDisplay(participant("100000000000001@lid"))).toBe("100000000000001");
  });
});
