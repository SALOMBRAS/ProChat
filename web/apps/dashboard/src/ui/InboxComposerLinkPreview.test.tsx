import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxApi, InboxConversation, Page } from "../api/inbox.js";
import { previewCache } from "./linkPreview.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * Prévia do link no compositor, antes de enviar — como o WhatsApp: o cartão
 * aparece sobre o campo enquanto o operador digita, e o X envia o link puro,
 * sem prévia (`linkPreview: false` desce pela cadeia até a WAHA).
 */
const conversation = (id: string): InboxConversation => ({
  id, whatsappSessionId: "session-a", chatId: "5511999990001@c.us", contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const conversationId = "11111111-1111-4111-8111-111111111111";
const emptyPage = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });
const api = () => ({
  conversations: vi.fn().mockResolvedValue({ items: [conversation(conversationId)], page: 1, pageSize: 50, total: 1 }),
  messages: vi.fn().mockResolvedValue(emptyPage()),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: "2026-07-28T10:00:00.000Z", lastInteractionAt: "2026-07-28T12:00:00.000Z" }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendMessage: vi.fn().mockResolvedValue(undefined),
  linkPreview: vi.fn().mockResolvedValue({ url: "https://example.com/materia", title: "Matéria especial", description: "Resumo da matéria", provider: "generic" }),
}) as unknown as InboxApi;

beforeEach(() => { previewCache.clear(); });

const abrirConversa = async (client = api()) => {
  render(<Inbox api={client} />);
  await waitFor(() => expect(document.querySelectorAll(".chat-inbox .conversation-item")).toHaveLength(1));
  fireEvent.click(document.querySelector(".chat-inbox .conversation-item")!);
  await screen.findByLabelText("Adicionar anexo");
  return { client, campo: screen.getByLabelText("Mensagem") };
};

describe("Prévia de link no compositor", () => {
  it("digitar um link mostra o cartão com título e domínio antes de enviar", async () => {
    const { campo } = await abrirConversa();
    fireEvent.change(campo, { target: { value: "olha https://example.com/materia" } });
    const cartao = await screen.findByLabelText("Prévia do link", {}, { timeout: 2_500 });
    expect(await screen.findByText("Matéria especial")).toBeTruthy();
    expect(cartao.textContent).toContain("example.com");
    expect(screen.getByLabelText("Enviar sem a prévia do link")).toBeTruthy();
  });

  it("o X esconde o cartão e o envio viaja com linkPreview: false", async () => {
    const { client, campo } = await abrirConversa();
    fireEvent.change(campo, { target: { value: "olha https://example.com/materia" } });
    fireEvent.click(await screen.findByLabelText("Enviar sem a prévia do link", {}, { timeout: 2_500 }));
    await waitFor(() => expect(screen.queryByLabelText("Prévia do link")).toBeNull());
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(conversationId, "olha https://example.com/materia", undefined, false));
  });

  it("sem dispensar, o envio segue de 2 argumentos, como sempre foi", async () => {
    const { client, campo } = await abrirConversa();
    fireEvent.change(campo, { target: { value: "olha https://example.com/materia" } });
    await screen.findByLabelText("Prévia do link", {}, { timeout: 2_500 });
    fireEvent.click(screen.getByLabelText("Enviar"));
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith(conversationId, "olha https://example.com/materia"));
  });

  it("mudar o link depois de dispensar reexibe o cartão para o link novo", async () => {
    const { campo } = await abrirConversa();
    fireEvent.change(campo, { target: { value: "olha https://example.com/materia" } });
    fireEvent.click(await screen.findByLabelText("Enviar sem a prévia do link", {}, { timeout: 2_500 }));
    await waitFor(() => expect(screen.queryByLabelText("Prévia do link")).toBeNull());
    fireEvent.change(campo, { target: { value: "agora https://outro.site/x" } });
    expect(await screen.findByLabelText("Prévia do link", {}, { timeout: 2_500 })).toBeTruthy();
  });

  it("texto sem link não mostra cartão nem chama a API de prévia", async () => {
    const { client, campo } = await abrirConversa();
    fireEvent.change(campo, { target: { value: "bom dia, sem link" } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByLabelText("Prévia do link")).toBeNull();
    expect(client.linkPreview).not.toHaveBeenCalled();
  });
});
