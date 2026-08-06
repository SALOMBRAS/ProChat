import { useEffect, useState } from "react";
import { CallsApi, type CallHistoryEntry } from "../api/calls.js";

const defaultCallsApi = new CallsApi();

export const callWhen = (milliseconds: number) =>
  new Date(milliseconds).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const callDuration = (entry: Pick<CallHistoryEntry, "startedAt" | "endedAt">): string | null => {
  if (!entry.endedAt) return null;
  const total = Math.max(0, Math.round((entry.endedAt - entry.startedAt) / 1_000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export const callDirectionLabel = (entry: Pick<CallHistoryEntry, "direction">) => (entry.direction === "inbound" ? "Recebida" : "Feita");

/** Botão/player da gravação. O WAV só desce quando o operador pede para ouvir —
 *  o blob vira object URL local, revogada ao trocar. */
export const CallRecordingControl = ({ callId, api }: { callId: string; api: CallsApi }) => {
  const [audioUrl, setAudioUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const blob = await api.recordingBlob(callId);
      setAudioUrl(URL.createObjectURL(blob));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  if (audioUrl) return <audio controls autoPlay src={audioUrl} aria-label="Gravação da chamada" />;
  return (
    <button type="button" onClick={() => void load()} disabled={loading} aria-label="Ouvir gravação">
      {loading ? "Carregando…" : failed ? "Tentar de novo" : "Ouvir"}
    </button>
  );
};

/** Uma chamada do histórico no painel do cliente. */
const CallHistoryRow = ({ entry, api }: { entry: CallHistoryEntry; api: CallsApi }) => (
  <div className="customer-call">
    <div>
      <span>{callWhen(entry.startedAt)}</span>
      <strong>
        {callDirectionLabel(entry)}
        {callDuration(entry) ? ` · ${callDuration(entry)}` : ""}
      </strong>
    </div>
    {entry.recording && <CallRecordingControl callId={entry.callId} api={api} />}
  </div>
);

/** Lista de chamadas da conversa no painel do cliente: data, direção, duração
 *  e a gravação para o dono avaliar o atendimento. Sem chamadas, a seção some —
 *  o painel já é carregado demais para mostrar uma lista vazia. */
export const CallHistory = ({ conversationId, api = defaultCallsApi }: { conversationId: string; api?: CallsApi }) => {
  const [entries, setEntries] = useState<CallHistoryEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    setEntries(null);
    api.history(conversationId)
      .then((result) => { if (live) setEntries(result.calls); })
      .catch(() => { if (live) setEntries([]); });
    return () => { live = false; };
  }, [conversationId, api]);

  if (!entries || entries.length === 0) return null;
  return (
    <div className="customer-details customer-calls">
      <div className="customer-section-title">CHAMADAS</div>
      {entries.map((entry) => <CallHistoryRow key={entry.callId} entry={entry} api={api} />)}
    </div>
  );
};
