import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DomainApi } from "../api/domain.js";
import type { GroupParticipant, InboxApi, InboxConversation, InboxMessage, Page } from "../api/inbox.js";

const realtime = vi.hoisted(() => ({ listener: undefined as undefined | ((event: { workspaceId: string; eventType: string; payload: Record<string, unknown> }) => void) }));
vi.mock("../api/realtime.js", () => ({ connectRealtime: (callback: NonNullable<typeof realtime.listener>) => { realtime.listener = callback; return () => {}; } }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));
// Mesma isolação do InboxReactions.test.tsx: LinkPreview em refactor por outra
// frente, e o mock de MessageMediaCard evita a colisão de casing do Windows.
vi.mock("./LinkPreviewCard.js", () => ({ LinkPreview: () => null, linkify: (content: string) => content }));
vi.mock("./MessageMediaCard.js", () => ({ Media: () => null }));

import Inbox from "./Inbox.js";

// Abrir uma conversa grava ?conversationId= na URL; sem limpar, o teste
// seguinte tenta o deep link para uma conversa que o mock dele não tem.
afterEach(() => window.history.replaceState(null, "", "/inbox"));

/**
 * Menções em grupos (T3): o `@` abre o autocomplete de participantes, teclado
 * e clique selecionam, o submit converte `@Nome` em `@dígitos` + array de JIDs
 * (o que a WAHA exige para notificar) e o corpo das mensagens destaca menções.
 * O painel do grupo lista os membros com nome e número.
 */
const conversationId = "11111111-1111-4111-8111-111111111111";
const ada: GroupParticipant = { whatsappId: "5511999990001@c.us", name: "Ada Lovelace", phone: "5511999990001", role: null, avatarUrl: null, lastActiveAt: null };
const bento: GroupParticipant = { whatsappId: "123456789012345@lid", name: null, phone: null, role: "admin", avatarUrl: null, lastActiveAt: null };
const group = (): InboxConversation => ({
  id: conversationId, whatsappSessionId: "session-a", chatId: "120363012345678901@g.us", contactId: null, conversationType: "group",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Grupo Teste", phone: null, pushName: null, profileName: "Grupo Teste", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: false },
});
const direct = (): InboxConversation => ({ ...group(), id: "22222222-2222-4222-8222-222222222222", chatId: "5511999990009@c.us", conversationType: "direct" });
const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: "m-1", direction: "inbound", content: "Oi", timestamp: "2026-07-29T12:00:00.000Z",
  status: "received", messageType: "text", chatId: "120363012345678901@g.us", metadata: {}, ...over,
});
const page = <T,>(items: T[]): Page<T> => ({ items, page: 1, pageSize: 50, total: items.length });

const api = (conversation: InboxConversation, messages: InboxMessage[], sendMessage: ReturnType<typeof vi.fn>, participants: GroupParticipant[] = [ada, bento]) => ({
  conversations: vi.fn().mockResolvedValue(page([conversation])),
  messages: vi.fn().mockResolvedValue(page(messages)),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  participants: vi.fn().mockResolvedValue({ items: participants }),
  sendMessage,
}) as unknown as InboxApi;
const domain = () => ({ contacts: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 1, total: 0 }) }) as unknown as DomainApi;

const abrirConversa = async (client: InboxApi) => {
  render(<Inbox api={client} domain={domain()} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  return screen.findByLabelText("Mensagem");
};
const digitar = (composer: HTMLElement, value: string) => fireEvent.change(composer, { target: { value } });
const listbox = () => document.querySelector(".composer-mention");

describe("Inbox group mentions", () => {
  it("typing @ in a group opens the participant list with names, numbers and the admin badge", async () => {
    const composer = await abrirConversa(api(group(), [message()], vi.fn()));
    digitar(composer, "@");
    await waitFor(() => expect(listbox()).not.toBeNull());
    const options = [...listbox()!.querySelectorAll("[role=option]")];
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain("Ada Lovelace");
    expect(options[0].textContent).toContain("+55 (11) 99999-0001");
    expect(options[1].textContent).toContain("123456789012345");
    expect(options[1].querySelector("em")?.textContent).toBe("admin");
  });
  it("filters by name as the operator keeps typing", async () => {
    const composer = await abrirConversa(api(group(), [message()], vi.fn()));
    digitar(composer, "bom dia @ad");
    await waitFor(() => expect(listbox()!.querySelectorAll("[role=option]")).toHaveLength(1));
    expect(listbox()!.textContent).toContain("Ada Lovelace");
  });
  it("Enter inserts @Name in the text and the submit sends @digits plus the mentions array", async () => {
    const sendMessage = vi.fn().mockResolvedValue(message({ direction: "outbound" }));
    const composer = await abrirConversa(api(group(), [message()], sendMessage));
    digitar(composer, "@");
    await waitFor(() => expect(listbox()!.querySelectorAll("[role=option]")).toHaveLength(2));
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("@Ada Lovelace "));
    expect(listbox()).toBeNull();
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(conversationId, "@5511999990001", ["5511999990001@c.us"]));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
  });
  it("arrow keys navigate and Tab selects the highlighted participant", async () => {
    const composer = await abrirConversa(api(group(), [message()], vi.fn()));
    digitar(composer, "@");
    await waitFor(() => expect(listbox()!.querySelectorAll("[role=option]")).toHaveLength(2));
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    fireEvent.keyDown(composer, { key: "Tab" });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("@123456789012345 "));
  });
  it("Escape closes the popup without touching the text", async () => {
    const composer = await abrirConversa(api(group(), [message()], vi.fn()));
    digitar(composer, "@");
    await waitFor(() => expect(listbox()).not.toBeNull());
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(listbox()).toBeNull();
    expect((composer as HTMLTextAreaElement).value).toBe("@");
  });
  it("clicking an option selects it, and a deleted @Name is dropped from the send", async () => {
    const sendMessage = vi.fn().mockResolvedValue(message({ direction: "outbound" }));
    const composer = await abrirConversa(api(group(), [message()], sendMessage));
    digitar(composer, "@");
    await waitFor(() => expect(listbox()!.querySelectorAll("[role=option]")).toHaveLength(2));
    fireEvent.click(listbox()!.querySelector("[role=option]")!);
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("@Ada Lovelace "));
    // Apagou o nome? A menção morre junto — o texto sempre manda. E sem menção
    // a chamada volta à forma de sempre: 2 argumentos, sem a chave.
    digitar(composer, "oi pessoal");
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(conversationId, "oi pessoal"));
  });
  it("highlights mentions on received messages, resolving @digits to the participant name", async () => {
    const mentioned = message({ content: "olá @5511999990001 tudo?", metadata: { _data: { mentionedJidList: ["5511999990001@c.us"] } } });
    await abrirConversa(api(group(), [mentioned], vi.fn()));
    await waitFor(() => expect(document.querySelector(".message-mention")?.textContent).toBe("@Ada Lovelace"));
  });
  it("highlights mentions on messages we sent, from the stored mentions metadata", async () => {
    const sent = message({ direction: "outbound", status: "sent", content: "@5511999990001 visto", metadata: { mentions: ["5511999990001@c.us"] } });
    await abrirConversa(api(group(), [sent], vi.fn()));
    await waitFor(() => expect(document.querySelector(".message-mention")?.textContent).toBe("@Ada Lovelace"));
  });
  it("never opens the popup in a direct conversation", async () => {
    const composer = await abrirConversa(api(direct(), [message({ chatId: "5511999990009@c.us" })], vi.fn()));
    digitar(composer, "@");
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("@"));
    expect(listbox()).toBeNull();
  });
  it("lists the group members with name and number in the side panel", async () => {
    await abrirConversa(api(group(), [message()], vi.fn()));
    await screen.findByLabelText("Mensagem");
    await waitFor(() => expect(document.querySelector(".customer-members")?.textContent).toContain("MEMBROS (2)"));
    const members = [...document.querySelectorAll(".customer-member")];
    expect(members[0].querySelector("strong")?.textContent).toBe("Ada Lovelace");
    expect(members[0].querySelector("span")?.textContent).toContain("+55 (11) 99999-0001");
    expect(members[1].querySelector("strong")?.textContent).toBe("123456789012345");
    expect(members[1].querySelector("span")?.textContent).toContain("admin");
  });
  it("refreshes member names when the background identity sync lands for the open group", async () => {
    // Primeira leitura sem nome (número não salvo); o sync em segundo plano
    // grava o pushName e o evento realtime derruba o cache para reler.
    const namelessAda: GroupParticipant = { ...ada, name: null };
    const participantsMock = vi.fn().mockResolvedValueOnce({ items: [namelessAda, bento] }).mockResolvedValue({ items: [ada, bento] });
    const client = api(group(), [message()], vi.fn());
    (client as unknown as { participants: unknown }).participants = participantsMock;
    await abrirConversa(client);
    await waitFor(() => expect(document.querySelector(".customer-member strong")?.textContent).toBe("5511999990001"));
    realtime.listener?.({ workspaceId: "default-workspace", eventType: "conversation.updated", payload: { chatId: ada.whatsappId, identitySynchronized: true } });
    await waitFor(() => expect(document.querySelector(".customer-member strong")?.textContent).toBe("Ada Lovelace"));
    expect(participantsMock).toHaveBeenCalledTimes(2);
  });
});
