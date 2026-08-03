import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { KanbanCard } from "../api/inbox.js";

vi.mock("../api/realtime.js", () => ({ connectRealtime: () => () => {} }));
vi.mock("../api/workspace.js", () => ({ WorkspaceApi: class { users = async () => []; } }));

const mover = vi.fn();
const cartao: KanbanCard = { conversationId: "conversa-1", maskedId: "••••••2765@c.us", identity: null, lastMessage: "Olá", lastMessageAt: "2026-08-03T10:00:00.000Z", unreadCount: 0, conversationType: "direct", assignedUserId: null, assignedTeamId: null, routingQueueId: null, priority: "normal", tags: [], slaStatus: null, sla: null, stageId: "etapa-nova", position: 1, updatedAt: "2026-08-01T00:00:00.000+00:00" };
const quadro = { id: "quadro-1", name: "Operação", stages: [{ id: "etapa-nova", key: "new", name: "Novo", count: 1 }, { id: "etapa-feito", key: "resolved", name: "Resolvido", count: 0 }] };

vi.mock("../api/inbox.js", async (importar) => ({
  ...(await importar<Record<string, unknown>>()),
  InboxApi: class {
    kanbanBoards = async () => [quadro];
    kanbanCards = async (_quadro: string, etapa: string) => ({ items: etapa === "etapa-nova" ? [cartao] : [], page: 1, pageSize: 30, total: etapa === "etapa-nova" ? 1 : 0 });
    moveKanban = mover;
  },
}));

const { InboxKanban, conflictMessage } = await import("./InboxKanban.js");

/** "A movimentação conflitou ou falhou" cobria três coisas diferentes com a
 *  mesma frase: um 400 de validação, uma queda de rede e outro atendente ter
 *  movido o card. Só a terceira é conflito, e é a única em que o operador tem o
 *  que fazer com a informação. */
describe("mensagem de conflito ao arrastar", () => {
  const erro = (details: Record<string, unknown>) => new ApiError("REQUEST_FAILED", "Outro atendente moveu este card.", details);

  it("diz para onde o card foi quando outro atendente moveu", () => {
    expect(conflictMessage(erro({ reason: "moved_by_operator", stageName: "Aguardando cliente", status: 409 })))
      .toBe("Outro atendente moveu este card para «Aguardando cliente». O quadro foi atualizado.");
  });

  it("não inventa destino quando o 409 vem sem o nome da etapa", () => {
    expect(conflictMessage(erro({ reason: "moved_by_operator", status: 409 }))).toBe("Não foi possível mover o card. Ele foi restaurado.");
  });

  it("não chama de conflito o que não é conflito", () => {
    expect(conflictMessage(erro({ status: 400 }))).toBe("Não foi possível mover o card. Ele foi restaurado.");
    expect(conflictMessage(new ApiError("API_UNAVAILABLE", "A API está indisponível."))).toBe("Não foi possível mover o card. Ele foi restaurado.");
    expect(conflictMessage(new Error("qualquer outra"))).toBe("Não foi possível mover o card. Ele foi restaurado.");
  });

  // As três acima provam a função. Esta prova que o quadro a **usa**: sem ela,
  // trocar a chamada de volta pela frase fixa passaria despercebido.
  it("é a frase que aparece na tela depois de soltar o card", async () => {
    mover.mockRejectedValueOnce(erro({ reason: "moved_by_operator", stageName: "Aguardando cliente", status: 409 }));
    render(<InboxKanban />);
    const card = await screen.findByRole("article");
    fireEvent.dragStart(card);
    fireEvent.drop(screen.getByRole("region", { name: "Resolvido" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Outro atendente moveu este card para «Aguardando cliente»."));
    expect(mover).toHaveBeenCalledWith("conversa-1", expect.objectContaining({ source: "manual", expectedUpdatedAt: "2026-08-01T00:00:00.000+00:00" }));
  });
});
