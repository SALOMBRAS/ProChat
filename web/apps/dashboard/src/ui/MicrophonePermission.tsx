import { deviceLabel, MICROPHONE_RECOVERY } from "./microphone.js";

/** O pedido de microfone, antes de o navegador pedir.
 *
 *  O navegador pergunta discretamente, num balão da barra de endereço que some
 *  sozinho. Quem ignora ou nega descobre pelo cliente reclamando de uma nota de
 *  voz muda — e depois de negar uma vez o navegador NÃO pergunta de novo, então o
 *  operador fica preso sem saber onde está o botão.
 *
 *  Este diálogo põe a decisão no caminho: ele cobre a tela, explica para que
 *  serve, e não deixa seguir sem escolher. É o padrão que o Google Meet usa antes
 *  de entrar numa reunião, e a razão é a mesma — permissão de mídia negada por
 *  distração custa a sessão inteira.
 *
 *  Ele NÃO é um pedido de permissão: quem pergunta continua sendo o navegador,
 *  no clique de "Permitir". O que este passo faz é garantir que o balão do
 *  navegador apareça quando o operador está olhando para ele. */
export type MicrophonePermissionProps = {
  /** `prompt` — ainda dá para perguntar. `denied` — o navegador não pergunta mais,
   *  e o texto passa a ser sobre como reverter. */
  state: "prompt" | "denied";
  /** Enquanto o navegador mostra o próprio balão. */
  asking: boolean;
  /** Erro da última tentativa, já traduzido por `microphoneErrorMessage`. */
  error?: string;
  /** Só depois de permitir os rótulos existem; com um dispositivo só, não há o
   *  que escolher e a lista não aparece. */
  devices: readonly MediaDeviceInfo[];
  deviceId?: string;
  onDevice: (deviceId: string) => void;
  onAllow: () => void;
  onCancel: () => void;
};

/** Ilustração inline. É SVG escrito à mão de propósito: uma imagem traria peso e
 *  uma biblioteca traria dependência, e o que ela precisa dizer — "isto é sobre o
 *  microfone" — cabe em duas formas. `currentColor` a deixa acompanhar o tema. */
const MicrophoneMark = () => (
  <svg className="mic-gate-art" viewBox="0 0 64 64" role="img" aria-label="" focusable="false">
    <rect x="25" y="10" width="14" height="26" rx="7" fill="currentColor" opacity=".9" />
    <path d="M18 30a14 14 0 0 0 28 0" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" opacity=".55" />
    <path d="M32 44v9M25 53h14" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" opacity=".55" />
  </svg>
);

export function MicrophonePermission({
  state, asking, error, devices, deviceId, onDevice, onAllow, onCancel,
}: MicrophonePermissionProps) {
  const denied = state === "denied";
  return (
    <div className="modal-backdrop mic-gate-backdrop" role="presentation">
      <div className="modal mic-gate" role="alertdialog" aria-modal="true"
           aria-labelledby="mic-gate-title" aria-describedby="mic-gate-copy">
        <MicrophoneMark />
        <h2 id="mic-gate-title">{denied ? "O microfone está bloqueado" : "Ativar o microfone?"}</h2>
        <p id="mic-gate-copy" className="mic-gate-copy">
          {denied
            // Sem isto, "permissão negada" é um beco sem saída: o navegador não
            // volta a perguntar e o botão que reverte não está na página.
            ? `Este navegador não vai perguntar de novo. ${MICROPHONE_RECOVERY}`
            : "Para gravar uma nota de voz, o ChatPro precisa do seu microfone. O navegador vai pedir a confirmação em seguida."}
        </p>

        {error && <p className="mic-gate-error" role="alert">{error}</p>}

        {devices.length > 1 && (
          <label className="mic-gate-device">
            <span>Microfone</span>
            <select value={deviceId ?? ""} onChange={(event) => onDevice(event.target.value)} aria-label="Escolher microfone">
              {devices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>{deviceLabel(device, index)}</option>
              ))}
            </select>
          </label>
        )}

        <div className="mic-gate-actions">
          {/* O primário é grande e é o caminho esperado; negar é um link discreto,
              como no Meet. Quem quer sair sai; quem só quer seguir não erra o
              alvo. */}
          <button type="button" className="mic-gate-allow" onClick={onAllow} disabled={asking} autoFocus>
            {asking ? "Aguardando o navegador…" : denied ? "Tentar de novo" : "Permitir microfone"}
          </button>
          <button type="button" className="mic-gate-dismiss" onClick={onCancel} disabled={asking}>
            Agora não
          </button>
        </div>
      </div>
    </div>
  );
}
