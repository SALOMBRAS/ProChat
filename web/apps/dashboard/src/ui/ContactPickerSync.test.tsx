import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactPicker, type ContactSyncState, type PickableContact } from "./ContactPicker.js";

/**
 * O picker abre mostrando os contatos salvos no celular (a lupa pesquisa o
 * resto no servidor, em lotes) e o botão "Sincronizar contatos" do cabeçalho
 * é quem busca o que mudou desde então (contato salvo agora, conversa nova).
 * O job roda com a lista visível, acompanhado por polling de 2 s — o evento
 * realtime é reservado ao banner do history sync, que o `syncKind` separa no
 * Inbox. Concluído o job, a lista recarrega sozinha; falhou, a lista fica e o
 * erro seguro aparece em linha.
 */
const running: ContactSyncState = { wahaSession: "session-a", status: "running", contactsProcessed: 7, progressLabel: "Sincronizando agenda de contatos…", lastErrorSafe: null };
const completed: ContactSyncState = { ...running, status: "completed", contactsProcessed: 42, progressLabel: "Agenda de contatos sincronizada." };
const failed: ContactSyncState = { ...running, status: "failed", lastErrorSafe: "TIMEOUT" };

const ANA: PickableContact = { id: "aaaaaaaa-1111-4111-8111-111111111111", displayName: "Ana Ribeiro", phoneNumber: "5511999990001", origin: "phonebook" };

const picker = (overrides: {
  loadInitial?: () => Promise<PickableContact[]>;
  searchContacts?: (term: string, page: number) => Promise<{ items: PickableContact[]; total: number }>;
  sync?: { start: () => Promise<ContactSyncState>; status: (wahaSession: string) => Promise<ContactSyncState> };
} = {}) => {
  const loadInitial = overrides.loadInitial ?? vi.fn().mockResolvedValue([ANA]);
  const searchContacts = overrides.searchContacts ?? vi.fn().mockResolvedValue({ items: [], total: 0 });
  const sync = overrides.sync ?? { start: vi.fn().mockResolvedValue(running), status: vi.fn().mockResolvedValue(running) };
  render(<ContactPicker loadInitial={loadInitial} searchContacts={searchContacts} onSend={vi.fn()} onClose={vi.fn()} sending={false} sync={sync} />);
  return { loadInitial, searchContacts, sync };
};
/** A abertura dispara o primeiro loadInitial sozinha: descarrega as microtarefas
 *  dele antes de afirmar qualquer coisa. */
const aberto = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("sincronização de contatos no picker", () => {
  it("abre carregando os contatos da última sincronização, sem disparar sync", async () => {
    vi.useFakeTimers();
    const { loadInitial, sync } = picker();
    expect(screen.getByText("Carregando contatos…")).toBeInTheDocument();
    await aberto();
    expect(screen.getByRole("list", { name: "Contatos" })).toBeInTheDocument();
    expect(screen.getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(loadInitial).toHaveBeenCalledTimes(1);
    expect(sync.start).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sincronizar contatos" })).toBeEnabled();
  });

  it("sem ação de sync a tela mostra só a lista — nada de botão no cabeçalho", async () => {
    const loadInitial = vi.fn().mockResolvedValue([ANA]);
    render(<ContactPicker loadInitial={loadInitial} searchContacts={vi.fn().mockResolvedValue({ items: [], total: 0 })} onSend={vi.fn()} onClose={vi.fn()} sending={false} />);
    expect(await screen.findByRole("list", { name: "Contatos" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sincronizar contatos" })).not.toBeInTheDocument();
  });

  it("a falha da abertura vira erro com Tentar novamente, não tela presa em carregando", async () => {
    const loadInitial = vi.fn().mockRejectedValueOnce(new Error("rede")).mockResolvedValue([ANA]);
    render(<ContactPicker loadInitial={loadInitial} searchContacts={vi.fn().mockResolvedValue({ items: [], total: 0 })} onSend={vi.fn()} onClose={vi.fn()} sending={false} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar os contatos.");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByRole("list", { name: "Contatos" })).toBeInTheDocument();
    expect(loadInitial).toHaveBeenCalledTimes(2);
  });

  it("dispara o job e mostra o progresso numa linha, com a lista visível", async () => {
    vi.useFakeTimers();
    const { sync } = picker();
    await aberto();
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    expect(sync.start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sincronizando…" })).toBeDisabled();
    expect(screen.getByText("Sincronizando agenda de contatos… · 7 contatos")).toBeInTheDocument();
    // A lista da última sincronização continua na tela durante o job.
    expect(screen.getByRole("list", { name: "Contatos" })).toBeInTheDocument();
  });

  it("acompanha o job a cada 2 segundos e recarrega a lista quando ele conclui", async () => {
    vi.useFakeTimers();
    const loadInitial = vi.fn().mockResolvedValue([ANA]);
    const status = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(completed);
    const { sync } = picker({ loadInitial, sync: { start: vi.fn().mockResolvedValue(running), status } });
    await aberto();
    expect(loadInitial).toHaveBeenCalledTimes(1); // abertura
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith("session-a");
    expect(loadInitial).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(status).toHaveBeenCalledTimes(2);
    expect(loadInitial).toHaveBeenCalledTimes(2); // recarga pós-conclusão
    expect(screen.getByRole("list", { name: "Contatos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sincronizar contatos" })).toBeEnabled();
    expect(sync.start).toHaveBeenCalledTimes(1);
  });

  it("mostra a falha segura e mantém a lista quando o job falha", async () => {
    vi.useFakeTimers();
    const status = vi.fn().mockResolvedValue(failed);
    picker({ sync: { start: vi.fn().mockResolvedValue(running), status } });
    await aberto();
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("TIMEOUT");
    expect(screen.getByRole("button", { name: "Sincronizar contatos" })).toBeEnabled();
    expect(screen.getByRole("list", { name: "Contatos" })).toBeInTheDocument();
  });

  it("para de acompanhar quando o status deixa de responder, em vez de girar para sempre", async () => {
    vi.useFakeTimers();
    const status = vi.fn().mockRejectedValue(new Error("job não encontrado"));
    picker({ sync: { start: vi.fn().mockResolvedValue(running), status } });
    await aberto();
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(status).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Perdemos o andamento da sincronização");
    expect(screen.getByRole("button", { name: "Sincronizar contatos" })).toBeEnabled();
  });

  it("avisa quando a sincronização concluiu pelas conversas, sem a agenda inteira", async () => {
    vi.useFakeTimers();
    const viaConversas: ContactSyncState = { ...completed, lastErrorSafe: "Agenda do WhatsApp não respondeu; contatos sincronizados a partir das conversas." };
    const status = vi.fn().mockResolvedValue(viaConversas);
    picker({ sync: { start: vi.fn().mockResolvedValue(running), status } });
    await aberto();
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole("list", { name: "Contatos" })).toBeInTheDocument();
    expect(screen.getByText(/sincronizados a partir das conversas/)).toBeInTheDocument();
    expect(document.querySelector(".composer-contact-sync-state.warn")).toBeInTheDocument();
    expect(document.querySelector(".composer-contact-sync-state.failed")).not.toBeInTheDocument();
  });

  it("avisa quando nem o disparo funciona — normalmente sessão desconectada", async () => {
    vi.useFakeTimers();
    picker({ sync: { start: vi.fn().mockRejectedValue(new Error("409")), status: vi.fn() } });
    await aberto();
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent(/Verifique se há uma sessão WhatsApp conectada/);
    expect(screen.getByRole("button", { name: "Sincronizar contatos" })).toBeEnabled();
  });
});
