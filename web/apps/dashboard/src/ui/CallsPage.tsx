import { useCallback, useEffect, useState } from "react";
import { CallsApi, type CallHistoryEntry } from "../api/calls.js";
import { CallRecordingControl, callDirectionLabel, callDuration, callWhen } from "./CallHistory.js";

const defaultCallsApi = new CallsApi();

/** Nome de exibição da ponta: contato conhecido > telefone real > fallback.
 *  Dígitos de @lid nunca aparecem (identificador técnico — regra 6). */
const peerLabel = (entry: CallHistoryEntry) => entry.contactName ?? entry.phone ?? "Contato sem identificação";

const statusLabel = (entry: CallHistoryEntry): string => {
  if (entry.status !== "ended") return "Em andamento";
  if (entry.endReason === "timeout" || entry.endReason === "missed") return "Não atendida";
  if (entry.endReason === "reject" || entry.endReason === "rejected") return "Recusada";
  return "Encerrada";
};

/** Aba Chamadas: o histórico do Call Service inteiro — quem ligou para quem,
 *  quando, quanto durou e a gravação para ouvir. */
export const CallsPage = ({ api = defaultCallsApi }: { api?: CallsApi }) => {
  const [entries, setEntries] = useState<CallHistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api.historyAll();
      setEntries(result.calls);
    } catch {
      setError("Não foi possível carregar as chamadas. Verifique se o serviço de chamadas está rodando.");
      setEntries([]);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="page calls-page">
      <div className="toolbar">
        <h2>Chamadas</h2>
        <button type="button" className="secondary" onClick={() => void load()} aria-label="Atualizar chamadas">↻</button>
      </div>
      {error && <p role="alert" className="calls-error">{error}</p>}
      {entries === null ? (
        <p className="calls-loading">Carregando chamadas…</p>
      ) : entries.length === 0 && !error ? (
        <p className="calls-loading">Nenhuma chamada ainda — as ligações feitas e recebidas aparecem aqui.</p>
      ) : (
        <div className="calls-list">
          {entries.map((entry) => (
            <div className="call-row" key={entry.callId}>
              <span className={`call-row-icon ${entry.direction}`} aria-hidden="true">{entry.direction === "inbound" ? "↙" : "↗"}</span>
              <div className="call-row-main">
                <strong>{peerLabel(entry)}</strong>
                <span>
                  {callDirectionLabel(entry)} · {statusLabel(entry)}
                  {callDuration(entry) ? ` · ${callDuration(entry)}` : ""} · {callWhen(entry.startedAt)}
                </span>
              </div>
              {entry.recording && <CallRecordingControl callId={entry.callId} api={api} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
