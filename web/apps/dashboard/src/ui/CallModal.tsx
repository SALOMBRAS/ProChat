import { useEffect, useRef, useState } from "react";
import type { CallUiState } from "./useCalls.js";

type CallModalProps = {
  call: CallUiState;
  remoteStream: MediaStream | null;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onHangup: () => void;
  onDismiss: () => void;
};

const clock = (milliseconds: number) => {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const endedLabel = (reason?: string) => {
  if (!reason) return "Chamada encerrada";
  if (reason === "timeout" || reason === "missed") return "Chamada não atendida";
  if (reason === "reject" || reason === "rejected") return "Chamada recusada";
  return "Chamada encerrada";
};

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.61 21 3 13.39 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.25 1.01l-2.2 2.2Z" />
  </svg>
);

/** Cartão flutuante da chamada (canto inferior direito, como no WhatsApp Web).
 *  Componente burro: o ciclo de vida mora no useCalls; aqui só a apresentação,
 *  o cronômetro e o <audio> que toca o stream remoto do softphone. */
export const CallModal = ({ call, remoteStream, busy, onAccept, onReject, onHangup, onDismiss }: CallModalProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (audioRef.current && remoteStream) audioRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  useEffect(() => {
    if (call.status !== "connected" || !call.connectedAt) return undefined;
    setElapsed(Date.now() - call.connectedAt);
    const timer = window.setInterval(() => setElapsed(Date.now() - call.connectedAt!), 1_000);
    return () => window.clearInterval(timer);
  }, [call.status, call.connectedAt]);

  const title = call.label ?? call.peer;
  const subtitle = (() => {
    if (call.status === "dialing") return "Iniciando chamada…";
    if (call.status === "ringing") return call.direction === "inbound" ? "Chamada de voz recebida" : "Chamando…";
    if (call.status === "connecting") return "Conectando áudio…";
    if (call.status === "connected") return clock(elapsed);
    return call.error ?? endedLabel(call.endedReason);
  })();

  return (
    <div className={`call-modal call-modal-${call.status}`} role="dialog" aria-label="Chamada de voz">
      <audio ref={audioRef} autoPlay />
      <div className={`call-modal-avatar${call.status === "ringing" ? " ringing" : ""}`} aria-hidden="true">
        <PhoneIcon />
      </div>
      <div className="call-modal-info">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="call-modal-actions">
        {call.direction === "inbound" && call.status === "ringing" ? (
          <>
            <button type="button" className="call-modal-accept" onClick={onAccept} disabled={busy} aria-label="Atender chamada">Atender</button>
            <button type="button" className="call-modal-reject" onClick={onReject} disabled={busy} aria-label="Recusar chamada">Recusar</button>
          </>
        ) : call.status === "ended" ? (
          <button type="button" className="call-modal-close" onClick={onDismiss} aria-label="Fechar">Fechar</button>
        ) : (
          <button type="button" className="call-modal-hangup" onClick={onHangup} disabled={busy} aria-label="Encerrar chamada">Encerrar</button>
        )}
      </div>
    </div>
  );
};
