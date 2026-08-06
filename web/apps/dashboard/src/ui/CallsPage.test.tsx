import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallsApi } from "../api/calls.js";
import { CallsPage } from "./CallsPage.js";

const callsApi = (overrides: Partial<CallsApi>): CallsApi =>
  ({
    historyAll: vi.fn().mockResolvedValue({ calls: [] }),
    recordingBlob: vi.fn().mockResolvedValue(new Blob(["wav"], { type: "audio/wav" })),
    ...overrides,
  }) as unknown as CallsApi;

describe("CallsPage", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:recording"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  });

  it("lista quem ligou para quem, com duração e estado", async () => {
    const api = callsApi({
      historyAll: vi.fn().mockResolvedValue({ calls: [
        { callId: "a", direction: "outbound", status: "ended", startedAt: Date.parse("2026-08-06T10:00:00"), endedAt: Date.parse("2026-08-06T10:02:00"), endReason: "user_ended", recording: true, contactName: "Sal", phone: "558585263532" },
        { callId: "b", direction: "inbound", status: "ended", startedAt: Date.parse("2026-08-06T11:00:00"), endedAt: null, endReason: "timeout", recording: false, contactName: null, phone: null },
      ] }),
    });
    render(<CallsPage api={api} />);
    expect(await screen.findByText("Sal")).toBeInTheDocument();
    expect(screen.getByText(/Feita · Encerrada · 02:00/)).toBeInTheDocument();
    expect(screen.getByText("Contato sem identificação")).toBeInTheDocument();
    expect(screen.getByText(/Recebida · Não atendida/)).toBeInTheDocument();
  });

  it("mostra o telefone quando não há nome conhecido", async () => {
    const api = callsApi({
      historyAll: vi.fn().mockResolvedValue({ calls: [
        { callId: "a", direction: "inbound", status: "ended", startedAt: 1, endedAt: 2, endReason: null, recording: false, contactName: null, phone: "5585987654321" },
      ] }),
    });
    render(<CallsPage api={api} />);
    expect(await screen.findByText("5585987654321")).toBeInTheDocument();
  });

  it("a gravação vira player ao clicar em Ouvir", async () => {
    const api = callsApi({
      historyAll: vi.fn().mockResolvedValue({ calls: [
        { callId: "a", direction: "outbound", status: "ended", startedAt: 1, endedAt: 2, endReason: null, recording: true, contactName: "Sal", phone: null },
      ] }),
    });
    render(<CallsPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ouvir gravação" }));
    await waitFor(() => expect(api.recordingBlob).toHaveBeenCalledWith("a"));
    expect(await screen.findByLabelText("Gravação da chamada")).toHaveAttribute("src", "blob:recording");
  });

  it("falha na API mostra o erro e não quebra a página", async () => {
    const api = callsApi({ historyAll: vi.fn().mockRejectedValue(new Error("down")) });
    render(<CallsPage api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar as chamadas");
  });
});
