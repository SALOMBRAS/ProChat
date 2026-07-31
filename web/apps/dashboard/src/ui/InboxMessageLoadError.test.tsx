import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import { ApiError } from "../api/client.js";
import type { HistorySyncJob, InboxApi, InboxConversation, Page } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * Abrir uma conversa durante a sincronização estourava o tempo limite, e o
 * operador lia isto no topo da LISTA de conversas:
 *
 *   A API demorou para responder. [TIMEOUT 0 /api/v1/inbox/conversations/…/
 *   messages?page=1&pageSize=50; AbortError: signal is aborted without reason]
 *
 * Dois defeitos: o diagnóstico de desenvolvimento chegava à tela, e o aviso saía
 * na coluna errada — longe da conversa que falhou, e sobrevivendo à troca dela.
 *
 * O tempo limite em si é do servidor e não é tocado aqui.
 */
const TIMEOUT_MESSAGE =
  "A API demorou para responder. [TIMEOUT 0 /api/v1/inbox/conversations/11111111-1111-4111-8111-111111111111/messages?page=1&pageSize=50; AbortError: signal is aborted without reason]";

const conversation = (id: string, chatId: string): InboxConversation => ({
  id, whatsappSessionId: "session-a", chatId, contactId: null, conversationType: "direct",
  assignedUserId: null, assignedTeamId: null, assignedAt: null, routingQueueId: null, autoAssignedAt: null,
  routingLockedAt: null, status: "in_progress", priority: "normal", lastStatusChange: null,
  lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const first = conversation("11111111-1111-4111-8111-111111111111", "5511999990001@c.us");
const second = conversation("22222222-2222-4222-8222-222222222222", "5511999990002@c.us");
const emptyPage = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });

const syncing: HistorySyncJob = {
  id: "job-a", jobId: "job-a", wahaSession: "session-a", status: "running", chatsProcessed: 12,
  messagesProcessed: 300, chatsTotal: null, currentChat: null, hasMore: true, progressLabel: "Sincronizando histórico…",
  lastErrorSafe: null, updatedAt: "2026-07-31T12:00:00.000Z",
};

const api = (over: Record<string, unknown> = {}) => ({
  conversations: vi.fn().mockResolvedValue({ items: [first, second], page: 1, pageSize: 50, total: 2 }),
  messages: vi.fn().mockResolvedValue(emptyPage()),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: null, lastInteractionAt: null }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendMessage: vi.fn(),
  ...over,
}) as unknown as InboxApi & { messages: ReturnType<typeof vi.fn> };

const abrir = async (chatId: string) => {
  const item = await screen.findByLabelText(`Abrir conversa ${chatId}`);
  fireEvent.click(item);
};
const painelDaConversa = () => document.querySelector<HTMLElement>(".chat-inbox .inbox-history")!;
const listaDeConversas = () => document.querySelector<HTMLElement>(".chat-inbox .inbox-list")!;

// `openConversation` faz `pushState`, e o jsdom guarda a URL entre os testes do
// mesmo arquivo. Sem zerar, o teste seguinte abre sozinho a conversa que ficou no
// endereço — e uma rejeição de uma vez só é consumida por essa abertura.
beforeEach(() => history.replaceState({}, "", "/inbox"));
afterEach(() => { history.replaceState({}, "", "/inbox"); vi.restoreAllMocks(); });

describe("falha ao carregar as mensagens de uma conversa", () => {
  it("mostra frase legível, sem o diagnóstico técnico que ia para a tela", async () => {
    render(<Inbox api={api({ messages: vi.fn().mockRejectedValue(new ApiError("TIMEOUT", TIMEOUT_MESSAGE, { status: 0 })) })} />);
    await abrir("5511999990001@c.us");

    expect(await screen.findByText("As mensagens desta conversa demoraram demais para chegar.")).toBeInTheDocument();
    const tela = document.body.textContent ?? "";
    for (const vazamento of ["TIMEOUT", "AbortError", "/api/v1", "signal is aborted"])
      expect(tela).not.toContain(vazamento);
  });

  it("o aviso fica na conversa, não na coluna da lista", async () => {
    render(<Inbox api={api({ messages: vi.fn().mockRejectedValue(new ApiError("TIMEOUT", TIMEOUT_MESSAGE, { status: 0 })) })} />);
    await abrir("5511999990001@c.us");
    await screen.findByText("As mensagens desta conversa demoraram demais para chegar.");

    expect(within(painelDaConversa()).getByText("As mensagens desta conversa demoraram demais para chegar.")).toBeInTheDocument();
    expect(within(listaDeConversas()).queryByText(/demoraram demais/)).not.toBeInTheDocument();
  });

  it("oferece tentar de novo, e a segunda tentativa carrega", async () => {
    const messages = vi.fn()
      .mockRejectedValueOnce(new ApiError("TIMEOUT", TIMEOUT_MESSAGE, { status: 0 }))
      .mockResolvedValue(emptyPage());
    render(<Inbox api={api({ messages })} />);
    await abrir("5511999990001@c.us");
    fireEvent.click(await screen.findByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(messages.mock.calls.length).toBeGreaterThan(1));
    // Depois de tudo assentar, e não no piscar do "carregando" — que some o aviso
    // por um instante mesmo quando ele não foi limpo de verdade.
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText("As mensagens desta conversa demoraram demais para chegar.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tentar novamente" })).not.toBeInTheDocument();
  });

  it("uma falha que chega tarde não acusa a conversa que o operador já abriu", async () => {
    // É o caso da sincronização: a leitura da primeira conversa fica na fila e só
    // desiste depois de o operador ter seguido em frente.
    let rejectFirst!: (error: unknown) => void;
    const messages = vi.fn().mockImplementation((conversationId: string) =>
      conversationId === first.id
        ? new Promise((_, reject) => { rejectFirst = reject; })
        : Promise.resolve(emptyPage()));
    render(<Inbox api={api({ messages })} />);
    await abrir("5511999990001@c.us");
    await waitFor(() => expect(messages).toHaveBeenCalledWith(first.id, 1, 50));

    await abrir("5511999990002@c.us");
    await waitFor(() => expect(messages).toHaveBeenCalledWith(second.id, 1, 50));

    await act(async () => { rejectFirst(new ApiError("TIMEOUT", TIMEOUT_MESSAGE, { status: 0 })); });
    expect(screen.queryByText("As mensagens desta conversa demoraram demais para chegar.")).not.toBeInTheDocument();
  });

  it("com a sincronização rodando, diz por que aconteceu sem falar de peça interna", async () => {
    render(<Inbox api={api({
      messages: vi.fn().mockRejectedValue(new ApiError("TIMEOUT", TIMEOUT_MESSAGE, { status: 0 })),
      syncStatus: vi.fn().mockResolvedValue(syncing),
    })} />);
    await abrir("5511999990001@c.us");

    expect(await screen.findByText("A sincronização do histórico está ocupando a conexão com o WhatsApp. Espere alguns instantes e tente de novo.")).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("WAHA");
  });

  it("sem sincronização, não atribui a causa a ela", async () => {
    render(<Inbox api={api({ messages: vi.fn().mockRejectedValue(new ApiError("TIMEOUT", TIMEOUT_MESSAGE, { status: 0 })) })} />);
    await abrir("5511999990001@c.us");
    await screen.findByText("As mensagens desta conversa demoraram demais para chegar.");
    expect(screen.queryByText(/sincronização do histórico/)).not.toBeInTheDocument();
  });

  it("o aviso não acompanha o operador para a próxima conversa", async () => {
    // Era o segundo defeito: o alerta era do estado global e ficava pendurado
    // sobre uma conversa que tinha aberto bem.
    const messages = vi.fn().mockImplementation((conversationId: string) =>
      conversationId === first.id
        ? Promise.reject(new ApiError("TIMEOUT", TIMEOUT_MESSAGE, { status: 0 }))
        : Promise.resolve(emptyPage()));
    render(<Inbox api={api({ messages })} />);
    await abrir("5511999990001@c.us");
    await screen.findByText("As mensagens desta conversa demoraram demais para chegar.");

    await abrir("5511999990002@c.us");
    await waitFor(() => expect(screen.queryByText("As mensagens desta conversa demoraram demais para chegar.")).not.toBeInTheDocument());
  });

  it("o aviso tem estilo próprio, dentro da lista de mensagens", () => {
    expect(stylesheet).toMatch(/\.chat-inbox \.message-load-error\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.message-load-error button\s*\{/);
  });
});
