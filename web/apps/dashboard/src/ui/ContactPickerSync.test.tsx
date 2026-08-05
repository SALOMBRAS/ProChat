import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactPicker, type ContactSyncState, type PickableContact } from "./ContactPicker.js";

/**
 * A sincronização é a porta de entrada do picker novo: a janela abre vazia e o
 * botão "Sincronizar contatos" dispara o job no servidor, acompanhado por
 * polling de 2 s — o evento realtime é reservado ao banner do history sync,
 * que o `syncKind` separa no Inbox. Concluído o job, a lista carrega sozinha;
 * falhou, a tela volta ao estado inicial com o erro seguro.
 */
const running: ContactSyncState = { wahaSession: "session-a", status: "running", contactsProcessed: 7, progressLabel: "Sincronizando agenda de contatos…", lastErrorSafe: null };
const completed: ContactSyncState = { ...running, status: "completed", contactsProcessed: 42, progressLabel: "Agenda de contatos sincronizada." };
const failed: ContactSyncState = { ...running, status: "failed", lastErrorSafe: "TIMEOUT" };

const ANA: PickableContact = { id: "aaaaaaaa-1111-4111-8111-111111111111", displayName: "Ana Ribeiro", phoneNumber: "5511999990001", origin: "phonebook" };

const picker = (overrides: {
  loadAll?: () => Promise<PickableContact[]>;
  sync?: { start: () => Promise<ContactSyncState>; status: (wahaSession: string) => Promise<ContactSyncState> };
} = {}) => {
  const loadAll = overrides.loadAll ?? vi.fn().mockResolvedValue([ANA]);
  const sync = overrides.sync ?? { start: vi.fn().mockResolvedValue(running), status: vi.fn().mockResolvedValue(running) };
  render(<ContactPicker loadAll={loadAll} onSend={vi.fn()} onClose={vi.fn()} sending={false} sync={sync} />);
  return { loadAll, sync };
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("sincronização de contatos no picker", () => {
  it("abre vazio: sem lista, sem chamada ao banco e sem o botão de sync quando a tela não o recebe", async () => {
    const loadAll = vi.fn().mockResolvedValue([]);
    render(<ContactPicker loadAll={loadAll} onSend={vi.fn()} onClose={vi.fn()} sending={false} />);
    expect(screen.getByText("Nenhum contato carregado.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sincronizar contatos" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Já sincronizei — carregar contatos" })).toBeInTheDocument();
    expect(loadAll).not.toHaveBeenCalled();
  });

  it("o atalho carrega os contatos já sincronizados sem disparar sync", async () => {
    const { loadAll, sync } = picker();
    fireEvent.click(screen.getByRole("button", { name: "Já sincronizei — carregar contatos" }));
    expect(await screen.findByRole("list", { name: "Salvos no celular" })).toBeInTheDocument();
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(sync.start).not.toHaveBeenCalled();
  });

  it("dispara o job e mostra o progresso no lugar do formulário", async () => {
    vi.useFakeTimers();
    const { sync } = picker();
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    expect(sync.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Sincronizar contatos" })).not.toBeInTheDocument();
    expect(screen.getByText("Sincronizando agenda de contatos… · 7 contatos")).toBeInTheDocument();
  });

  it("acompanha o job a cada 2 segundos e carrega a lista sozinho quando ele conclui", async () => {
    vi.useFakeTimers();
    const loadAll = vi.fn().mockResolvedValue([ANA]);
    const status = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(completed);
    const { sync } = picker({ loadAll, sync: { start: vi.fn().mockResolvedValue(running), status } });
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith("session-a");
    expect(loadAll).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(status).toHaveBeenCalledTimes(2);
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "Salvos no celular" })).toBeInTheDocument();
    expect(screen.getByText("Ana Ribeiro")).toBeInTheDocument();
    expect(sync.start).toHaveBeenCalledTimes(1);
  });

  it("mostra a falha segura e volta ao estado inicial quando o job falha", async () => {
    vi.useFakeTimers();
    const status = vi.fn().mockResolvedValue(failed);
    picker({ sync: { start: vi.fn().mockResolvedValue(running), status } });
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("TIMEOUT");
    expect(screen.getByRole("button", { name: "Sincronizar contatos" })).toBeEnabled();
  });

  it("para de acompanhar quando o status deixa de responder, em vez de girar para sempre", async () => {
    vi.useFakeTimers();
    const status = vi.fn().mockRejectedValue(new Error("job não encontrado"));
    picker({ sync: { start: vi.fn().mockResolvedValue(running), status } });
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
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole("list", { name: "Salvos no celular" })).toBeInTheDocument();
    expect(screen.getByText(/sincronizados a partir das conversas/)).toBeInTheDocument();
    expect(document.querySelector(".composer-contact-sync-state.warn")).toBeInTheDocument();
    expect(document.querySelector(".composer-contact-sync-state.failed")).not.toBeInTheDocument();
  });

  it("avisa quando nem o disparo funciona — normalmente sessão desconectada", async () => {
    vi.useFakeTimers();
    picker({ sync: { start: vi.fn().mockRejectedValue(new Error("409")), status: vi.fn() } });
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar contatos" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent(/Verifique se há uma sessão WhatsApp conectada/);
    expect(screen.getByRole("button", { name: "Sincronizar contatos" })).toBeEnabled();
  });
});
