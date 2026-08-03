import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxApi, InboxConversation, InboxMessage, KanbanCard, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

const conversa = "11111111-1111-4111-8111-111111111111";
const outra = "22222222-2222-4222-8222-222222222222";
const conversation = (id: string, nome: string): InboxConversation => ({
  id, whatsappSessionId: "session-a", chatId: `${id}@c.us`, contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: nome, phone: "5511999990001", pushName: nome, profileName: nome, avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const cartao = (conversationId: string): KanbanCard => ({ conversationId, maskedId: "••••••2765@c.us", lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0, conversationType: "direct", assignedUserId: null, assignedTeamId: null, routingQueueId: null, priority: "normal", tags: [], slaStatus: null, sla: null, stageId: "etapa-nova", position: 1, updatedAt: "2026-07-28T12:00:00.000+00:00" });
const quadro = { id: "quadro-1", name: "Operação", stages: [{ id: "etapa-nova", key: "new", name: "Novo", count: 1 }] };
const vazia = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });

/** O `InboxKanban` instancia o próprio `InboxApi` no escopo do módulo — não
 *  recebe o cliente por prop como o `Inbox`. Então o quadro é servido daqui, e
 *  a conversa aberta pela janela continua vindo do cliente injetado. */
let noQuadro: KanbanCard[] = [];
vi.mock("../api/inbox.js", async (importar) => ({
  ...(await importar<Record<string, unknown>>()),
  InboxApi: class {
    kanbanBoards = async () => [quadro];
    kanbanCards = async () => ({ items: noQuadro, page: 1, pageSize: 30, total: noQuadro.length });
  },
}));

const Inbox = (await import("./Inbox.js")).default;
const { InboxKanban } = await import("./InboxKanban.js");

const porId = vi.fn();
const cliente = (listadas: InboxConversation[]) => ({
  conversations: vi.fn().mockResolvedValue({ items: listadas, page: 1, pageSize: 50, total: listadas.length }),
  conversation: porId,
  messages: vi.fn().mockResolvedValue(vazia<InboxMessage>()),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: null, lastInteractionAt: null }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
}) as unknown as InboxApi;

async function quadroAberto(api: InboxApi) {
  render(<Inbox api={api} />);
  fireEvent.click(await screen.findByLabelText("Abrir Kanban"));
  return screen.findByRole("button", { name: /^Abrir conversa/ });
}

beforeEach(() => { Object.defineProperty(URL, "createObjectURL", { value: vi.fn(), configurable: true }); history.replaceState({}, "", "/inbox"); porId.mockReset(); noQuadro = [cartao(conversa)]; });
afterEach(() => vi.restoreAllMocks());

describe("conversa em janela flutuante sobre o Kanban", () => {
  it("duplo clique abre a conversa por cima do quadro, sem sair dele", async () => {
    const empurrar = vi.spyOn(history, "pushState");
    const card = await quadroAberto(cliente([conversation(conversa, "Ana")]));
    fireEvent.doubleClick(card);

    const janela = await screen.findByRole("dialog", { name: "Conversa com Ana" });
    // É o painel da Inbox, não uma reimplementação: o compositor vem junto.
    expect(janela.querySelector(".inbox-history")).toBeTruthy();
    expect(janela.querySelector("form.message-composer")).toBeTruthy();
    // O quadro continua montado atrás — fechar não recarrega nada.
    expect(screen.getByRole("region", { name: "Novo" })).toBeTruthy();
    // E a rota continua sendo a do Kanban.
    expect(empurrar).not.toHaveBeenCalled();
  });

  it("Esc fecha e devolve o foco ao card", async () => {
    const card = await quadroAberto(cliente([conversation(conversa, "Ana")]));
    card.focus();
    fireEvent.keyDown(card, { key: "Enter" });
    const janela = await screen.findByRole("dialog", { name: "Conversa com Ana" });
    await waitFor(() => expect(document.activeElement).toBe(janela));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Conversa com Ana" })).toBeNull());
    expect(document.activeElement).toBe(card);
    expect(screen.getByRole("region", { name: "Novo" })).toBeTruthy();
  });

  /** O card pode ser de uma conversa que a primeira página da lista não alcança
   *  — 630 cartões contra 50 conversas por página. Buscar por `id` é o caminho;
   *  percorrer páginas atrás dela seria a regra crítica nº 4 do CLAUDE.md. */
  it("busca por id a conversa que não está na página carregada", async () => {
    noQuadro = [cartao(outra)];
    porId.mockResolvedValue(conversation(outra, "Bruno"));
    const card = await quadroAberto(cliente([conversation(conversa, "Ana")]));
    fireEvent.doubleClick(card);
    await waitFor(() => expect(porId).toHaveBeenCalledWith(outra));
    expect(await screen.findByRole("dialog", { name: "Conversa com Bruno" })).toBeTruthy();
  });

  /** Quem chega ao quadro vindo da Inbox com uma conversa aberta ainda tem o
   *  `conversationId` na URL. Sem uma guarda, o deep link reabriria a conversa
   *  da URL por cima da que o operador clicou — e o gatilho é justamente limpar
   *  a seleção para abrir a nova. */
  it("a conversa da URL não rouba a janela do card clicado", async () => {
    history.replaceState({}, "", `/inbox?conversationId=${conversa}`);
    noQuadro = [cartao(outra)];
    porId.mockResolvedValue(conversation(outra, "Bruno"));
    const card = await quadroAberto(cliente([conversation(conversa, "Ana"), conversation(outra, "Bruno")]));
    fireEvent.doubleClick(card);

    expect(await screen.findByRole("dialog", { name: "Conversa com Bruno" })).toBeTruthy();
    // Um instante depois, para o efeito do deep link ter chance de agir.
    await new Promise(resolver => setTimeout(resolver, 20));
    expect(screen.getByRole("dialog", { name: "Conversa com Bruno" })).toBeTruthy();
  });

  it("diz o que houve quando a conversa do card não abre", async () => {
    noQuadro = [cartao(outra)];
    porId.mockRejectedValue(new Error("caiu"));
    const card = await quadroAberto(cliente([]));
    fireEvent.doubleClick(card);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível abrir esta conversa.");
  });

  // Guarda do próprio gancho: sem ele o card não vira botão nem entra na ordem
  // de foco, e os casos acima passariam por acidente se o `article` já fosse um.
  it("sem o gancho de abrir, o card continua sendo só um card arrastável", async () => {
    render(<InboxKanban />);
    expect(await screen.findByRole("article")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Abrir conversa/ })).toBeNull();
  });
});
