import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CallsApi, type CallPairingStatus } from "../api/calls.js";
import { ApiError } from "../api/client.js";

const defaultCallsApi = new CallsApi();
const POLL_MS = 2_500;

/** Painel de pareamento das chamadas de voz, ao lado do QR da WAHA na tela de
 *  sessões. São DUAS sessões WhatsApp independentes (WAHA = mensagens, Call
 *  Service = chamadas): um único scan não pareia as duas, então a tela mostra
 *  os dois QRs e o operador escaneia os dois no mesmo aparelho. */
export const CallPairingPanel = ({ api = defaultCallsApi }: { api?: CallsApi }) => {
  const [status, setStatus] = useState<CallPairingStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const polling = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api.pairing();
        if (cancelled) return;
        setStatus(next);
        setError("");
        if (next.paired) setQrOpen(false);
      } catch (nextError) {
        if (cancelled) return;
        // Serviço de chamadas fora do ar não pode derrubar a tela de sessões.
        setError(nextError instanceof ApiError ? nextError.message : "Serviço de chamadas indisponível.");
      }
    };
    void load();
    polling.current = setInterval(() => void load(), POLL_MS);
    return () => { cancelled = true; clearInterval(polling.current); };
  }, [api]);

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await api.startPairing();
      setStatus(next);
      setQrOpen(true);
    } catch (nextError) {
      setError(nextError instanceof ApiError ? nextError.message : "Não foi possível iniciar o pareamento de chamadas.");
    } finally {
      setBusy(false);
    }
  };

  if (status?.paired) {
    return (
      <section className="call-pairing panel">
        <h2>Chamadas de voz</h2>
        <p>Conectadas{status.jid ? ` como ${status.jid.split("@", 1)[0]}` : ""}. O botão 📞 das conversas usa esta sessão.</p>
      </section>
    );
  }

  return (
    <section className="call-pairing panel">
      <h2>Chamadas de voz</h2>
      {error ? <p className="call-pairing-error">{error}</p> : (
        <p>Pareie o MESMO WhatsApp da sessão de mensagens para habilitar o botão 📞 nas conversas.</p>
      )}
      <button type="button" disabled={busy} onClick={() => void connect()}>
        {busy ? "Gerando QR…" : status?.qr ? "Ver QR de chamadas" : "Conectar chamadas de voz"}
      </button>
      {qrOpen && status?.qr ? (
        <div className="modal-backdrop">
          <section className="modal form-modal" role="dialog" aria-modal="true" aria-label="QR de chamadas de voz">
            <button className="close" onClick={() => setQrOpen(false)} aria-label="Fechar">×</button>
            <h2>QR de chamadas de voz</h2>
            <p>Escaneie com o MESMO WhatsApp usado na sessão de mensagens. O QR se renova sozinho — se expirar, aguarde alguns segundos.</p>
            <QRCodeSVG value={status.qr} size={240} level="M" includeMargin />
          </section>
        </div>
      ) : null}
      {qrOpen && !status?.qr && !error ? <p>Gerando QR… ele aparece aqui em alguns segundos.</p> : null}
    </section>
  );
};
