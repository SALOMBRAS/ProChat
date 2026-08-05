import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DomainApi } from "../api/domain.js";
import type { InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));
// LinkPreview está em refactor por outra frente (rename linkPreview.ts); o
// mock isola estes testes daquele trabalho em andamento.
vi.mock("./LinkPreviewCard.js", () => ({ LinkPreview: () => null, linkify: (content: string) => content }));
// No Windows, "./MessageMedia.js" resolvia para messageMedia.ts (colisão de
// casing com MessageMedia.tsx, pré-existente no HEAD); o componente passou a
// se chamar MessageMediaCard.tsx e o mock segue a intenção original.
vi.mock("./MessageMediaCard.js", () => ({ Media: () => null }));

import Inbox from "./Inbox.js";

/**
 * Reações na bolha (T1): badges agrupados por emoji, picker rápido com envio
 * otimista reconciliado pela resposta do POST e ⚠ quando o envio falha.
 */
const conversationId = "11111111-1111-4111-8111-111111111111";
const conversation = (): InboxConversation => ({
  id: conversationId, whatsappSessionId: "session-a", chatId: "5511999990001@c.us", contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: "m-1", direction: "inbound", content: "Oi", timestamp: "2026-07-29T12:00:00.000Z",
  status: "received", messageType: "text", chatId: "5511999990001@c.us", metadata: {}, reactions: [], ...over,
});
const page = <T,>(items: T[]): Page<T> => ({ items, page: 1, pageSize: 50, total: items.length });

const api = (messages: InboxMessage[], react: ReturnType<typeof vi.fn>) => ({
  conversations: vi.fn().mockResolvedValue(page([conversation()])),
  messages: vi.fn().mockResolvedValue(page(messages)),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  react,
}) as unknown as InboxApi;
const domain = () => ({ contacts: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 1, total: 0 }) }) as unknown as DomainApi;

const abrirConversa = async (client: InboxApi) => {
  render(<Inbox api={client} domain={domain()} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Adicionar anexo");
};

describe("Inbox message reactions", () => {
  it("groups reactions by emoji with counts and marks the account's own", async () => {
    const reacted = message({
      reactions: [
        { emoji: "👍", reactorWhatsappId: "5511999990001@c.us", fromMe: false, reactorName: "Ana", reactorPhone: "5511999990001", reactedAt: "2026-07-29T12:01:00.000Z" },
        { emoji: "👍", reactorWhatsappId: "5511888880002@c.us", fromMe: false, reactorName: null, reactorPhone: "5511888880002", reactedAt: "2026-07-29T12:02:00.000Z" },
        { emoji: "❤️", reactorWhatsappId: null, fromMe: true, reactorName: null, reactorPhone: null, reactedAt: "2026-07-29T12:03:00.000Z" },
      ],
    });
    await abrirConversa(api([reacted], vi.fn()));
    const badges = document.querySelectorAll(".message-reaction-badge");
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toContain("👍");
    expect(badges[0].querySelector(".reaction-count")?.textContent).toBe("2");
    expect(badges[1].textContent).toContain("❤️");
    expect(badges[1].classList.contains("mine")).toBe(true);
    expect(badges[0].getAttribute("title")).toBe("Ana, 5511888880002");
    expect(badges[1].getAttribute("title")).toBe("Você");
  });
  it("reacts through the picker: optimistic badge, POST to the API and reconciliation with the response", async () => {
    const react = vi.fn().mockResolvedValue({ messageId: "m-1", reactions: [{ emoji: "😂", reactorWhatsappId: null, fromMe: true, reactorName: null, reactorPhone: null, reactedAt: "2026-07-29T12:05:00.000Z" }] });
    await abrirConversa(api([message()], react));
    fireEvent.click(screen.getByLabelText("Reagir à mensagem"));
    const picker = document.querySelector(".reaction-picker");
    expect(picker).not.toBeNull();
    fireEvent.click([...picker!.querySelectorAll("button")].find(button => button.textContent === "😂")!);
    // Otimismo: o badge aparece antes da resposta e é marcado como da conta.
    await waitFor(() => expect(document.querySelector(".message-reaction-badge.mine")?.textContent).toContain("😂"));
    expect(react).toHaveBeenCalledWith(conversationId, "m-1", "😂");
    await waitFor(() => expect(document.querySelector(".reaction-picker")).toBeNull());
    expect(document.querySelector(".message-reaction-error")).toBeNull();
  });
  it("rolls back and flags the message when the send fails", async () => {
    const react = vi.fn().mockRejectedValue(new Error("worker fora"));
    const reacted = message({ reactions: [{ emoji: "👍", reactorWhatsappId: "5511999990001@c.us", fromMe: false, reactorName: "Ana", reactorPhone: "5511999990001", reactedAt: "2026-07-29T12:01:00.000Z" }] });
    await abrirConversa(api([reacted], react));
    fireEvent.click(screen.getByLabelText("Reagir à mensagem"));
    fireEvent.click([...document.querySelector(".reaction-picker")!.querySelectorAll("button")].find(button => button.textContent === "🙏")!);
    await waitFor(() => expect(document.querySelector(".message-reaction-error")).not.toBeNull());
    const badges = [...document.querySelectorAll(".message-reaction-badge")];
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain("👍");
    expect(badges[0].classList.contains("mine")).toBe(false);
  });
  it("clicking a badge repeats that emoji, which the server toggles off", async () => {
    const react = vi.fn().mockResolvedValue({ messageId: "m-1", reactions: [] });
    const reacted = message({ reactions: [{ emoji: "❤️", reactorWhatsappId: null, fromMe: true, reactorName: null, reactorPhone: null, reactedAt: "2026-07-29T12:03:00.000Z" }] });
    await abrirConversa(api([reacted], react));
    fireEvent.click(document.querySelector(".message-reaction-badge.mine")!);
    expect(react).toHaveBeenCalledWith(conversationId, "m-1", "❤️");
    await waitFor(() => expect(document.querySelectorAll(".message-reaction-badge")).toHaveLength(0));
  });
});
