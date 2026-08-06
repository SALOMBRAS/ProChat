import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.js";
import type { CallsApi } from "../api/calls.js";
import { useCalls } from "./useCalls.js";

const softphoneMocks = vi.hoisted(() => ({ openCall: vi.fn() }));

vi.mock("./softphone.js", () => ({
  openCall: softphoneMocks.openCall,
}));

const callsApi = (overrides: Partial<CallsApi>): CallsApi =>
  ({
    start: vi.fn(),
    active: vi.fn(),
    webrtc: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    pairing: vi.fn(),
    startPairing: vi.fn(),
    ...overrides,
  }) as unknown as CallsApi;

describe("useCalls", () => {
  it("falha ao iniciar mostra o motivo real no lugar da genérica 'Chamada encerrada'", async () => {
    const api = callsApi({
      start: vi.fn().mockRejectedValue(new ApiError("REQUEST_FAILED", "Call Service indisponível. Verifique se o serviço de chamadas está rodando.")),
    });
    const { result } = renderHook(() => useCalls(api));

    await act(async () => {
      await result.current.startCall("10000000-0000-4000-8000-000000000001", "5585999990000");
    });

    expect(result.current.call?.status).toBe("ended");
    expect(result.current.call?.error).toBe("Call Service indisponível. Verifique se o serviço de chamadas está rodando.");
    expect(result.current.call?.endedReason).toBeUndefined();
  });

  it("falha do softphone encerra a chamada no Call Service e expõe o erro", async () => {
    softphoneMocks.openCall.mockRejectedValue(new Error("NotAllowedError"));
    const end = vi.fn().mockResolvedValue(undefined);
    const api = callsApi({
      start: vi.fn().mockResolvedValue({ callId: "call-1", sessionId: "s-1", direction: "outbound", peer: "5585999990000", status: "ringing", startedAt: Date.now() }),
      end,
    });
    const { result } = renderHook(() => useCalls(api));

    await act(async () => {
      await result.current.startCall("10000000-0000-4000-8000-000000000001", "5585999990000");
    });

    await waitFor(() => expect(result.current.call?.status).toBe("ended"));
    expect(end).toHaveBeenCalledWith("call-1");
    expect(result.current.call?.error).toBe("Não foi possível concluir a chamada.");
    expect(result.current.call?.endedReason).toBeUndefined();
  });

  it("ligações de outro operador marcam workspaceBusy até o encerramento", () => {
    const api = callsApi({});
    const { result } = renderHook(() => useCalls(api));
    expect(result.current.workspaceBusy).toBe(false);
    act(() => result.current.handleCallEvent({ callId: "other-1", sessionId: "s", direction: "outbound", peer: "5511999999999", status: "connected", startedAt: 1 }));
    expect(result.current.workspaceBusy).toBe(true);
    act(() => result.current.handleCallEvent({ callId: "other-1", sessionId: "s", direction: "outbound", peer: "5511999999999", status: "ended", startedAt: 1 }));
    expect(result.current.workspaceBusy).toBe(false);
  });

  it("a minha própria chamada não marca workspaceBusy", async () => {
    softphoneMocks.openCall.mockResolvedValue({ pc: null, micStream: null, remoteStream: null, close: vi.fn() });
    const api = callsApi({
      start: vi.fn().mockResolvedValue({ callId: "mine-1", sessionId: "s-1", direction: "outbound", peer: "5585999990000", status: "ringing", startedAt: Date.now() }),
    });
    const { result } = renderHook(() => useCalls(api));
    await act(async () => {
      await result.current.startCall("10000000-0000-4000-8000-000000000001", "5585999990000");
    });
    act(() => result.current.handleCallEvent({ callId: "mine-1", sessionId: "s-1", direction: "outbound", peer: "5585999990000", status: "connected", startedAt: Date.now() }));
    expect(result.current.workspaceBusy).toBe(false);
    expect(result.current.call?.status).toBe("connected");
  });

  it("encerramento vindo do WhatsApp segue em endedReason, sem erro", async () => {
    softphoneMocks.openCall.mockResolvedValue({ pc: null, micStream: null, remoteStream: null, close: vi.fn() });
    const api = callsApi({
      start: vi.fn().mockResolvedValue({ callId: "call-1", sessionId: "s-1", direction: "outbound", peer: "5585999990000", status: "ringing", startedAt: Date.now() }),
    });
    const { result } = renderHook(() => useCalls(api));

    await act(async () => {
      await result.current.startCall("10000000-0000-4000-8000-000000000001", "5585999990000");
    });
    act(() => {
      result.current.handleCallEvent({ callId: "call-1", sessionId: "s-1", direction: "outbound", peer: "5585999990000", status: "ended", startedAt: Date.now(), reason: "reject" });
    });

    expect(result.current.call?.status).toBe("ended");
    expect(result.current.call?.endedReason).toBe("reject");
    expect(result.current.call?.error).toBeUndefined();
  });
});
