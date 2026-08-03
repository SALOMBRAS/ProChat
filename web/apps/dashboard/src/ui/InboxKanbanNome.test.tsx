import { describe, expect, it } from "vitest";
import type { KanbanCard } from "../api/inbox.js";
import { cardName } from "./InboxKanban.js";
import { realName } from "./contactIdentity.js";

const base: KanbanCard = { conversationId: "c1", maskedId: "••••••2765@c.us", identity: null, lastMessage: "Olá", lastMessageAt: "2026-08-03T10:00:00.000Z", unreadCount: 0, conversationType: "direct", assignedUserId: null, assignedTeamId: null, routingQueueId: null, priority: "normal", tags: [], slaStatus: null, sla: null, stageId: "etapa-nova", position: 1, updatedAt: "2026-08-03T10:00:00.000+00:00" };
const identity = (campos: Partial<NonNullable<KanbanCard["identity"]>>) => ({ displayName: null, phone: null, pushName: null, profileName: null, contactName: null, avatarUrl: null, lastSyncAt: null, syncStatus: "synced" as const, knownContact: true, ...campos });
const card = (campos: Partial<KanbanCard>): KanbanCard => ({ ...base, ...campos });

describe("nome no card do Kanban", () => {
  // A precedência é registrada e vale para a Inbox e para o card: nome de
  // perfil do WhatsApp, depois pushName, só então o nome ChatPro.
  it("o nome de perfil do WhatsApp ganha do pushName e do nome ChatPro", () => {
    expect(cardName(card({ identity: identity({ profileName: "Ana Perfil", pushName: "Aninha", contactName: "Ana ChatPro" }) }))).toBe("Ana Perfil");
  });

  it("sem nome de perfil, o pushName ganha do nome ChatPro", () => {
    expect(cardName(card({ identity: identity({ pushName: "Aninha", contactName: "Ana ChatPro" }) }))).toBe("Aninha");
  });

  it("o nome ChatPro entra quando o WhatsApp não trouxe nenhum", () => {
    expect(cardName(card({ identity: identity({ contactName: "Ana ChatPro" }) }))).toBe("Ana ChatPro");
  });

  /** 66 dos 93 contatos da base têm o telefone copiado no `display_name`.
   *  Mostrá-lo como nome é mostrar o número duas vezes — e a heurística é a
   *  mesma do `ContactPicker`, importada, não recriada. */
  it("nome que é só o telefone copiado não vira nome", () => {
    // O telefone gravado é OUTRO: se a cópia contasse como nome, o rótulo seria
    // ela. Como não conta, a cadeia segue e chega ao telefone de verdade.
    expect(cardName(card({ identity: identity({ contactName: "558592369359", phone: "5511999992765" }) }))).toBe("5511999992765");
    expect(realName("558592369359")).toBeUndefined();
    expect(realName("+55 (85) 9236-9359")).toBeUndefined();
    expect(realName("Ana 2")).toBe("Ana 2");
  });

  it("sem nome nenhum, mostra o telefone real normalizado", () => {
    expect(cardName(card({ identity: identity({ phone: "5511999992765" }) }))).toBe("5511999992765");
  });

  // O ponto da mudança: o JID mascarado é identificador técnico e não pode
  // aparecer em tela, nem como último recurso (regra 6 do `CLAUDE.md`).
  it("sem identidade, cai no texto de fallback e nunca no JID", () => {
    const rotulo = cardName(card({ identity: null }));
    expect(rotulo).toBe("Contato sem identificação");
    expect(rotulo).not.toContain("•");
    expect(rotulo).not.toContain("@c.us");
  });

  /** No quadro, dois cards de grupo com o mesmo rótulo genérico não teriam nada
   *  que os diferencie — ao contrário da Inbox, onde a lista ao lado distingue. */
  it("grupo mostra o nome do grupo, e nunca o JID dele", () => {
    const rotulo = cardName(card({ conversationType: "group", maskedId: "••••••••••6490@g.us", identity: identity({ profileName: "Equipe de Campo" }) }));
    expect(rotulo).toBe("Equipe de Campo");
    expect(rotulo).not.toContain("@g.us");
    expect(rotulo).not.toContain("•");
  });

  it("grupo sem nome cai no genérico, não no JID", () => {
    const rotulo = cardName(card({ conversationType: "group", maskedId: "••••••••••6490@g.us", identity: null }));
    expect(rotulo).toBe("Grupo WhatsApp");
    expect(rotulo).not.toContain("@g.us");
  });
});
