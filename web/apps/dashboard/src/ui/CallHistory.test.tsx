import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallsApi } from "../api/calls.js";
import { CallHistory } from "./CallHistory.js";

const callsApi = (overrides: Partial<CallsApi>): CallsApi =>
  ({
    history: vi.fn().mockResolvedValue({ calls: [] }),
    recordingBlob: vi.fn().mockResolvedValue(new Blob(["wav"], { type: "audio/wav" })),
    ...overrides,
  }) as unknown as CallsApi;

describe("CallHistory", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", { value: vi.fn().mockReturnValue("blob:recording"), configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  });

  it("sem chamadas, a seção não aparece no painel", async () => {
    const api = callsApi({});
    const { container } = render(<CallHistory conversationId="conv-1" api={api} />);
    await waitFor(() => expect(api.history).toHaveBeenCalledWith("conv-1"));
    expect(container).toBeEmptyDOMElement();
  });

  it("lista as chamadas com direção e duração", async () => {
    const api = callsApi({
      history: vi.fn().mockResolvedValue({ calls: [
        { callId: "a", direction: "outbound", status: "ended", startedAt: Date.parse("2026-08-06T10:00:00"), endedAt: Date.parse("2026-08-06T10:01:30"), endReason: "user_ended", recording: true },
        { callId: "b", direction: "inbound", status: "ended", startedAt: Date.parse("2026-08-06T11:00:00"), endedAt: null, endReason: "timeout", recording: false },
      ] }),
    });
    render(<CallHistory conversationId="conv-1" api={api} />);
    expect(await screen.findByText("CHAMADAS")).toBeInTheDocument();
    expect(screen.getByText(/Feita · 01:30/)).toBeInTheDocument();
    expect(screen.getByText("Recebida")).toBeInTheDocument();
  });

  it("o botão Ouvir baixa a gravação e vira player", async () => {
    const api = callsApi({
      history: vi.fn().mockResolvedValue({ calls: [
        { callId: "a", direction: "outbound", status: "ended", startedAt: 1, endedAt: 2, endReason: null, recording: true },
      ] }),
    });
    render(<CallHistory conversationId="conv-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ouvir gravação" }));
    await waitFor(() => expect(api.recordingBlob).toHaveBeenCalledWith("a"));
    expect(await screen.findByLabelText("Gravação da chamada")).toHaveAttribute("src", "blob:recording");
  });

  it("falha ao baixar oferece nova tentativa", async () => {
    const api = callsApi({
      history: vi.fn().mockResolvedValue({ calls: [
        { callId: "a", direction: "outbound", status: "ended", startedAt: 1, endedAt: 2, endReason: null, recording: true },
      ] }),
      recordingBlob: vi.fn().mockRejectedValue(new Error("404")),
    });
    render(<CallHistory conversationId="conv-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ouvir gravação" }));
    expect(await screen.findByRole("button", { name: "Ouvir gravação" })).toHaveTextContent("Tentar de novo");
  });
});
