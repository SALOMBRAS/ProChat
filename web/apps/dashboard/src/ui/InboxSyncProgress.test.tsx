import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stylesheet from "./styles.css?raw";
import type { HistorySyncJob, InboxApi, InboxConversation, Page } from "../api/inbox.js";

const realtime = vi.hoisted(() => ({ handler: undefined as undefined | ((event: any) => void) }));
vi.mock("../api/realtime.js", () => ({ connectRealtime: (handler: (event: any) => void) => { realtime.handler = handler; return () => undefined; } }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; teams = async () => []; } }));

import Inbox from "./Inbox.js";

/**
 * A faixa de sincronização.
 *
 * O defeito: a tela repetia `progressLabel`, que é a última frase que o servidor
 * gravou. Um job que falhou e voltou a rodar continuava anunciando "Falhou;
 * corrija o problema e retome" enquanto trazia conversas na frente do operador.
 *
 * A porcentagem existe desde que o job traga `chatsTotal`, contado uma vez por
 * corrida pelo servidor. Nulo é "a contagem não veio", e aí a faixa volta a
 * contar sem denominador. Ver o cabeçalho de syncProgress.ts.
 */
const conversation = (): InboxConversation => ({
  id: "11111111-1111-4111-8111-111111111111", whatsappSessionId: "session-a", chatId: "5511999990001@c.us",
  contactId: null, conversationType: "direct", assignedUserId: null, assignedTeamId: null, assignedAt: null,
  routingQueueId: null, autoAssignedAt: null, routingLockedAt: null, status: "in_progress", priority: "normal",
  lastStatusChange: null, lastMessage: "Oi", lastMessageAt: "2026-07-28T12:00:00.000Z", unreadCount: 0,
  createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T12:00:00.000Z",
  identity: { displayName: "Ana", phone: "5511999990001", pushName: "Ana", profileName: "Ana", avatarUrl: null, lastSyncAt: null, syncStatus: "synced", knownContact: true },
});
const emptyPage = <T,>(): Page<T> => ({ items: [], page: 1, pageSize: 50, total: 0 });

const job = (over: Partial<HistorySyncJob> = {}): HistorySyncJob => ({
  id: "job-a", jobId: "job-a", wahaSession: "session-a", status: "running",
  chatsProcessed: 240, messagesProcessed: 1834, chatsTotal: null, currentChat: "5511999990001@c.us", hasMore: true,
  progressLabel: "Sincronizando histórico…", lastErrorSafe: null, updatedAt: "2026-07-31T12:00:00.000Z",
  ...over,
});

const api = (over: Record<string, unknown> = {}) => ({
  conversations: vi.fn().mockResolvedValue({ items: [conversation()], page: 1, pageSize: 50, total: 1 }),
  messages: vi.fn().mockResolvedValue(emptyPage()),
  markRead: vi.fn().mockResolvedValue(undefined),
  context: vi.fn().mockResolvedValue({ notes: null, tags: [], firstInteractionAt: null, lastInteractionAt: null }),
  activity: vi.fn().mockResolvedValue([]),
  slaMetrics: vi.fn().mockRejectedValue(new Error("sem SLA")),
  sendMessage: vi.fn(),
  syncStatus: vi.fn().mockResolvedValue(job()),
  startSync: vi.fn(),
  cancelSync: vi.fn(),
  ...over,
}) as unknown as InboxApi & { syncStatus: ReturnType<typeof vi.fn>; startSync: ReturnType<typeof vi.fn>; cancelSync: ReturnType<typeof vi.fn> };

const faixa = () => document.querySelector<HTMLElement>(".chat-inbox .inbox-sync")!;

beforeEach(() => { realtime.handler = undefined; });
// Sem `vi.restoreAllMocks()` aqui, de propósito.
//
// Os hooks de `afterEach` correm na ordem inversa do registro, então o deste
// arquivo corre ANTES do `cleanup` do setup — e nessa janela a Inbox ainda está
// montada, com o intervalo de 2 s do polling vivo. `restoreAllMocks` zerava a
// implementação de `api.syncStatus`, e o tique que caísse ali recebia `undefined`:
//
//   Cannot read properties of undefined (reading 'then')
//
// Não havia o que restaurar: os mocks deste arquivo são `vi.fn()` criados por
// teste dentro de `api()`, e nenhum é `vi.spyOn`. A chamada só fazia mal.

describe("a faixa de progresso da sincronização", () => {
  it("mostra o andamento real enquanto o job roda", async () => {
    render(<Inbox api={api()} />);
    expect(await screen.findByText("Sincronizando o histórico")).toBeInTheDocument();
    expect(screen.getByText("240 conversas, 1.834 mensagens")).toBeInTheDocument();
    expect(faixa().className).toContain("is-active");
  });

  it("um job retomado deixa de anunciar a falha que já passou", async () => {
    // O defeito relatado, exatamente: status running com o rótulo antigo gravado.
    render(<Inbox api={api({ syncStatus: vi.fn().mockResolvedValue(job({ progressLabel: "Falhou; corrija o problema e retome." })) })} />);
    expect(await screen.findByText("Sincronizando o histórico")).toBeInTheDocument();
    expect(screen.queryByText(/Falhou/)).not.toBeInTheDocument();
    // E rodando não se retoma: só cancelar.
    expect(screen.queryByRole("button", { name: /Retomar/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar sincronização" })).toBeInTheDocument();
  });

  it("acompanha o progresso enquanto o job anda, sem recarregar a tela", async () => {
    // O `syncStatus` fica preso nos 240 de propósito: assim só o evento em tempo
    // real pode produzir 305, e o teste prova o caminho que diz provar.
    const client = api();
    render(<Inbox api={client} />);
    await screen.findByText("240 conversas, 1.834 mensagens");

    act(() => realtime.handler?.({ workspaceId: "default-workspace", eventType: "conversation.sync.updated", payload: { wahaSession: "session-a", jobId: "job-a", status: "running", chatsProcessed: 305, messagesProcessed: 2500, hasMore: true, progressLabel: "Sincronizando histórico…", updatedAt: "2026-07-31T12:01:00.000Z" } }));
    expect(screen.getByText("305 conversas, 2.500 mensagens")).toBeInTheDocument();
  });

  it("continua consultando o estado enquanto o job está ativo", async () => {
    const client = api();
    render(<Inbox api={client} />);
    await screen.findByText("Sincronizando o histórico");
    // O polling de 2 s é o que mantém a faixa viva quando não chega evento.
    await waitFor(() => expect(client.syncStatus.mock.calls.length).toBeGreaterThan(1), { timeout: 4_000 });
  });

  it("para de consultar quando o job termina", async () => {
    const client = api({ syncStatus: vi.fn().mockResolvedValue(job({ status: "completed" })) });
    render(<Inbox api={client} />);
    await screen.findByText("Histórico sincronizado");
    const calls = client.syncStatus.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    // Nada a acompanhar: insistir seria bater na API a cada 2 s para sempre.
    expect(client.syncStatus.mock.calls.length).toBe(calls);
  });

  it("só a falha oferece retomar, e mostra o motivo em vez do rótulo cru", async () => {
    render(<Inbox api={api({ syncStatus: vi.fn().mockResolvedValue(job({ status: "failed", lastErrorSafe: "A WAHA recusou a sessão." })) })} />);
    expect(await screen.findByText("A sincronização falhou")).toBeInTheDocument();
    expect(screen.getByText("A WAHA recusou a sessão.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retomar sincronização" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar sincronização" })).not.toBeInTheDocument();
    expect(faixa().className).toContain("is-error");
  });

  it("cancelada oferece retomar sem se pintar de erro", async () => {
    render(<Inbox api={api({ syncStatus: vi.fn().mockResolvedValue(job({ status: "cancelled" })) })} />);
    expect(await screen.findByText("Sincronização cancelada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retomar sincronização" })).toBeInTheDocument();
    expect(faixa().className).not.toContain("is-error");
  });

  it("concluída com truncamento avisa que o histórico não veio inteiro", async () => {
    render(<Inbox api={api({ syncStatus: vi.fn().mockResolvedValue(job({ status: "completed", lastErrorSafe: "tempo esgotado" })) })} />);
    expect(await screen.findByText("Histórico sincronizado")).toBeInTheDocument();
    expect(screen.getByText("Conversas muito longas foram truncadas.")).toBeInTheDocument();
    expect(faixa().className).toContain("is-warn");
  });

  it("diz que foi você quem retomou quando o clique partiu daqui", async () => {
    // O servidor de mentira guarda um estado só. Uma sequência de `mockResolvedValueOnce`
    // faria o polling e o clique disputarem qual job é o corrente, e o botão
    // sumiria debaixo do ponteiro antes do clique chegar.
    let current = job({ status: "failed", lastErrorSafe: "caiu" });
    const client = api({
      syncStatus: vi.fn(async () => current),
      startSync: vi.fn(async () => { current = job({ status: "pending", chatsProcessed: 0, messagesProcessed: 0 }); return current; }),
    });
    render(<Inbox api={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retomar sincronização" }));
    await waitFor(() => expect(client.startSync).toHaveBeenCalled());
    expect(await screen.findByText("Retomada por você.")).toBeInTheDocument();
  });

  it("diz que retomou sozinha quando o job voltou a andar sem clique", async () => {
    let current = job({ status: "failed", lastErrorSafe: "caiu" });
    render(<Inbox api={api({ syncStatus: vi.fn(async () => current) })} />);
    expect(await screen.findByText("A sincronização falhou")).toBeInTheDocument();

    // O servidor avisa que voltou a andar; ninguém clicou em nada aqui.
    current = job({ status: "running" });
    act(() => realtime.handler?.({ workspaceId: "default-workspace", eventType: "conversation.sync.updated", payload: { wahaSession: "session-a", jobId: "job-a", status: "running", chatsProcessed: 240, messagesProcessed: 1834, hasMore: true, progressLabel: "Sincronizando histórico…", updatedAt: "2026-07-31T12:02:00.000Z" } }));
    expect(await screen.findByText("Retomada automaticamente.")).toBeInTheDocument();
  });

  it("não atribui a retomada quando a tela já abriu com o job rodando", async () => {
    render(<Inbox api={api()} />);
    await screen.findByText("Sincronizando o histórico");
    // Sem transição observada não há a quem creditar; inventar seria mentir.
    expect(screen.queryByText(/Retomada/)).not.toBeInTheDocument();
  });

  it("com o total contado, mostra de quantas e a porcentagem", async () => {
    render(<Inbox api={api({ syncStatus: vi.fn().mockResolvedValue(job({ chatsTotal: 551 })) })} />);
    expect(await screen.findByText("240 de 551 conversas (44%), 1.834 mensagens")).toBeInTheDocument();
  });

  it("o total chega pelo tempo real junto com o avanço", async () => {
    const client = api();
    render(<Inbox api={client} />);
    await screen.findByText("240 conversas, 1.834 mensagens");

    act(() => realtime.handler?.({ workspaceId: "default-workspace", eventType: "conversation.sync.updated", payload: { wahaSession: "session-a", jobId: "job-a", status: "running", chatsProcessed: 305, messagesProcessed: 2500, chatsTotal: 551, hasMore: true, progressLabel: "Sincronizando histórico…", updatedAt: "2026-07-31T12:01:00.000Z" } }));
    expect(screen.getByText("305 de 551 conversas (55%), 2.500 mensagens")).toBeInTheDocument();
  });

  it("sem total, a faixa segue sem porcentagem em vez de travar", async () => {
    // A contagem falha aberta no servidor. A tela tem de continuar útil.
    render(<Inbox api={api({ syncStatus: vi.fn().mockResolvedValue(job({ chatsTotal: null })) })} />);
    expect(await screen.findByText("240 conversas, 1.834 mensagens")).toBeInTheDocument();
    expect(faixa().textContent ?? "").not.toContain("%");
  });

  it("nunca mostra o identificador da conversa em curso", async () => {
    render(<Inbox api={api()} />);
    await screen.findByText("Sincronizando o histórico");
    // JID não é informação de usuário (regra 6 do CLAUDE.md).
    expect(faixa().textContent ?? "").not.toContain("@c.us");
  });

  it("a faixa tem estilo próprio, com um tom por estado", () => {
    // A regra base, não a do `@media` — que também casa com `.inbox-sync {` e
    // deixaria passar a ausência da regra de verdade.
    expect(stylesheet).toMatch(/\.chat-inbox \.inbox-sync\s*\{[^}]*padding:/);
    expect(stylesheet).toMatch(/\.chat-inbox \.inbox-sync\.is-active\s*\{/);
    expect(stylesheet).toMatch(/\.chat-inbox \.inbox-sync\.is-error\s*\{/);
  });
});
