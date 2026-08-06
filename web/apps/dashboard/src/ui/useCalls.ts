import { useCallback, useEffect, useRef, useState } from "react";
import { CallsApi, type ActiveCall } from "../api/calls.js";
import { openCall, type OpenCall } from "./softphone.js";
import { ApiError } from "../api/client.js";

/** Estado da chamada para a UI. `dialing` cobre a janela entre o clique no 📞
 *  e a resposta da API; `ringing`/`connected`/`ended` seguem os eventos
 *  `call.updated` vindos do Call Service pelo realtime. */
export type CallUiStatus = "dialing" | "ringing" | "connecting" | "connected" | "ended";

export type CallUiState = {
  callId: string;
  direction: "inbound" | "outbound";
  /** Telefone do outro lado, só dígitos (JID canônico sem o sufixo). */
  peer: string;
  /** Nome do contato, quando a conversa foi encontrada na inbox. */
  label?: string;
  status: CallUiStatus;
  connectedAt?: number;
  endedReason?: string;
  error?: string;
};

const digitsOf = (value: string) => value.replace(/\D/g, "");
const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "Não foi possível concluir a chamada.";

const defaultCallsApi = new CallsApi();

/** Dono do ciclo de vida de UMA chamada por vez: HTTP na API, softphone WebRTC
 *  (openCall) e eventos realtime `call.updated`. A inbox consome este hook e
 *  renderiza o CallModal; quem encerra a chamada (qualquer ponta) chega sempre
 *  pelo evento, então `finish` é o único caminho de limpeza. */
export function useCalls(api: CallsApi = defaultCallsApi) {
  const [call, setCall] = useState<CallUiState | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  /** Chamadas de OUTROS operadores na mesma instância (eventos `call.updated`
   *  que não pertencem à minha chamada). Enquanto houver uma ativa, o botão
   *  📞 fica desabilitado — a instância atende uma ligação por vez. */
  const otherCalls = useRef(new Set<string>());
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const connectionRef = useRef<OpenCall | null>(null);
  const dismissTimer = useRef<number | undefined>(undefined);
  /** Espelho síncrono do estado: o handler realtime não pode ler `call` do
   *  closure (ficaria preso à renderização de quando o socket abriu). */
  const callRef = useRef<CallUiState | null>(null);
  callRef.current = call;

  const closeConnection = useCallback(() => {
    connectionRef.current?.close();
    connectionRef.current = null;
    setRemoteStream(null);
  }, []);

  /** `reason` é o motivo vindo do WhatsApp (timeout, recusa...); `error` é a
   *  falha local/da API (mic negado, Call Service fora, 4xx/5xx). O modal
   *  mostra `error` quando existe — sem isso toda falha virava a genérica
   *  "Chamada encerrada" e o problema real ficava invisível. */
  const finish = useCallback((reason?: string, error?: string) => {
    closeConnection();
    setCall((current) => (current ? { ...current, status: "ended", endedReason: reason, error } : current));
    window.clearTimeout(dismissTimer.current);
    dismissTimer.current = window.setTimeout(() => setCall(null), 4_000);
  }, [closeConnection]);

  useEffect(
    () => () => {
      window.clearTimeout(dismissTimer.current);
      connectionRef.current?.close();
    },
    [],
  );

  /** Abre o softphone (mic + WebRTC + troca de SDP). Falhou, a chamada morre
   *  junto: sem áudio não faz sentido deixar o WhatsApp tocando no outro lado. */
  const attachAudio = useCallback(
    async (callId: string) => {
      try {
        const connection = await openCall(api, callId);
        connectionRef.current = connection;
        setRemoteStream(connection.remoteStream);
        return true;
      } catch (error) {
        await api.end(callId).catch(() => undefined);
        finish(undefined, errorText(error));
        return false;
      }
    },
    [api, finish],
  );

  const startCall = useCallback(
    async (conversationId: string, peer: string, label?: string) => {
      if (call && call.status !== "ended") return;
      window.clearTimeout(dismissTimer.current);
      setCall({ callId: "", direction: "outbound", peer, label, status: "dialing" });
      setBusy(true);
      try {
        const started = await api.start(conversationId);
        setCall({ callId: started.callId, direction: "outbound", peer, label, status: "ringing" });
        await attachAudio(started.callId);
      } catch (error) {
        finish(undefined, errorText(error));
      } finally {
        setBusy(false);
      }
    },
    [api, attachAudio, call, finish],
  );

  const accept = useCallback(async () => {
    if (!call || call.direction !== "inbound" || call.status !== "ringing") return;
    setBusy(true);
    try {
      await api.accept(call.callId);
      setCall((current) => (current ? { ...current, status: "connecting" } : current));
      await attachAudio(call.callId);
    } catch (error) {
      finish(undefined, errorText(error));
    } finally {
      setBusy(false);
    }
  }, [api, attachAudio, call, finish]);

  const reject = useCallback(async () => {
    if (!call || call.status === "ended") return;
    setBusy(true);
    try {
      await api.reject(call.callId);
    } catch { /* rejeição best-effort: o evento de encerramento reconcilia */ }
    finally {
      setBusy(false);
      setCall(null);
    }
  }, [api, call]);

  const hangup = useCallback(async () => {
    if (!call || call.status === "ended") return;
    setBusy(true);
    try {
      await api.end(call.callId);
    } catch { /* idem: o evento de encerramento reconcilia */ }
    finally {
      setBusy(false);
      finish();
    }
  }, [api, call, finish]);

  const dismiss = useCallback(() => {
    window.clearTimeout(dismissTimer.current);
    setCall(null);
  }, []);

  /** Alimentado pelo handler realtime da inbox com o payload de `call.updated`.
   *  `resolveLabel` mapeia o telefone da chamada recebida para o nome do
   *  contato na lista de conversas, quando existe. */
  const handleCallEvent = useCallback(
    (payload: ActiveCall, resolveLabel?: (peerDigits: string) => string | undefined) => {
      const current = callRef.current;
      const mine = Boolean(current && (!current.callId || current.callId === payload.callId));
      const opensMine = !current && payload.direction === "inbound" && payload.status === "ringing";
      if (!mine && !opensMine && payload.callId) {
        if (payload.status === "ended") otherCalls.current.delete(payload.callId);
        else otherCalls.current.add(payload.callId);
        setWorkspaceBusy(otherCalls.current.size > 0);
      }
      const peer = digitsOf(payload.peer ?? "");
      if (payload.status === "ended") {
        // Fecha o softphone mesmo quando o modal ainda está em `dialing` (sem
        // callId local): confere pelo callId apenas quando os dois existem.
        const current = callRef.current;
        if (current && (!current.callId || !payload.callId || current.callId === payload.callId)) finish(payload.reason);
        return;
      }
      setCall((current) => {
        if (!current) {
          if (payload.direction === "inbound" && payload.status === "ringing") {
            return {
              callId: payload.callId,
              direction: "inbound",
              peer,
              label: resolveLabel?.(peer),
              status: "ringing",
            };
          }
          return current;
        }
        if (current.callId && current.callId !== payload.callId) return current;
        if (payload.status === "connected" && current.status !== "connected") {
          return { ...current, callId: payload.callId, status: "connected", connectedAt: Date.now() };
        }
        if (payload.status === "ringing" && current.status === "dialing") {
          return { ...current, callId: payload.callId, status: "ringing" };
        }
        return current;
      });
    },
    [finish],
  );

  return { call, remoteStream, busy, workspaceBusy, startCall, accept, reject, hangup, dismiss, handleCallEvent };
}
