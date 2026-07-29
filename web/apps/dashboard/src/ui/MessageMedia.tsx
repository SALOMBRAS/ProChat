import { useEffect, useRef, useState } from "react";
import type { InboxApi, InboxMessage } from "../api/inbox.js";
import type { DomainApi } from "../api/domain.js";
import { fileSizeLabel } from "./attachmentIntake.js";
import {
  contactCards,
  coordinatesLabel,
  documentKind,
  durationLabel,
  isVoiceNote,
  mediaDuration,
  mediaFilename,
  locationOf,
  mapsUrl,
  mediaSize,
  phoneDigits,
  phoneDisplay,
  voiceWaveform,
  type ContactCard,
} from "./messageMedia.js";

/** Corpo das mensagens de mídia na conversa.
 *
 *  Saiu de Inbox.tsx inteiro porque é o que esta mudança reescreve, e porque o
 *  arquivo já passava de mil e quinhentas linhas. Nada aqui fala com o envio: só
 *  renderiza o que chegou.
 */

/** Um áudio por vez. Dois tocando ao mesmo tempo é sempre acidente. */
let activeAudio: HTMLAudioElement | undefined;

const useAudio = (message: InboxMessage) => {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(mediaDuration(message) ?? 0);
  const [unavailable, setUnavailable] = useState(false);
  const toggle = async () => {
    const node = audio.current;
    if (!node) return;
    if (node.paused) {
      if (activeAudio && activeAudio !== node) activeAudio.pause();
      activeAudio = node;
      try { await node.play(); } catch { setUnavailable(true); }
    } else node.pause();
  };
  const seek = (value: number) => { if (audio.current) audio.current.currentTime = value; setCurrent(value); };
  return { audio, playing, current, duration, unavailable, toggle, seek };
};

/** Nota de voz: forma de onda e velocidade de reprodução.
 *
 *  As barras são as 64 amplitudes que o próprio WhatsApp mandou — não é desenho
 *  decorativo nem amostragem feita aqui. Sem elas, cai numa barra de progresso
 *  simples em vez de fingir um traçado. */
const VoiceNoteMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const state = useAudio(message);
  const wave = voiceWaveform(message);
  const total = state.duration || mediaDuration(message) || 0;
  const progress = total ? Math.min(1, state.current / total) : 0;
  const [speed, setSpeed] = useState(1);
  const changeSpeed = () => { const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (state.audio.current) state.audio.current.playbackRate = next; };
  return (
    <div className="voice-note" aria-label="Mensagem de voz">
      <audio ref={state.audio} preload="metadata" src={url}
        onLoadedMetadata={() => { const node = state.audio.current; if (node && Number.isFinite(node.duration)) node.dataset.ready = "1"; }}
        onTimeUpdate={() => undefined} hidden />
      {state.unavailable ? <span className="media-error" role="status">Áudio indisponível.</span> : <>
        <button type="button" className="voice-note-play" onClick={() => void state.toggle()} aria-label={state.playing ? "Pausar mensagem de voz" : "Reproduzir mensagem de voz"}>{state.playing ? "Ⅱ" : "▶"}</button>
        <div className="voice-note-track">
          {wave
            ? <span className="voice-note-wave" aria-hidden="true">{wave.map((amplitude, index) => <i key={index} className={index / wave.length <= progress ? "played" : undefined} style={{ height: `${Math.round(12 + amplitude * 88)}%` }} />)}</span>
            : <span className="voice-note-wave flat" aria-hidden="true"><i style={{ width: `${progress * 100}%` }} /></span>}
          <input className="voice-note-seek" type="range" min="0" max={Math.max(total, 1)} step="0.1" value={Math.min(state.current, total || 0)} onChange={(event) => state.seek(Number(event.target.value))} aria-label="Progresso da mensagem de voz" />
        </div>
        <time className="voice-note-time">{durationLabel(state.playing || state.current ? state.current : total)}</time>
        <button type="button" className="voice-note-speed" onClick={changeSpeed} aria-label={`Velocidade ${speed}x`}>{speed}x</button>
      </>}
    </div>
  );
};

/** Arquivo de áudio: parece faixa. Nome, duração e um play — sem velocidade, que é
 *  gesto de quem ouve recado, não música. */
const AudioFileMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const state = useAudio(message);
  const name = mediaFilename(message) ?? "Arquivo de áudio";
  const total = state.duration || mediaDuration(message) || 0;
  const size = mediaSize(message);
  return (
    <div className="audio-track" aria-label="Arquivo de áudio">
      <audio ref={state.audio} preload="metadata" src={url} onLoadedMetadata={() => undefined} hidden />
      {state.unavailable ? <span className="media-error" role="status">Áudio indisponível.</span> : <>
        <button type="button" className="audio-track-play" onClick={() => void state.toggle()} aria-label={state.playing ? "Pausar áudio" : "Reproduzir áudio"}>{state.playing ? "Ⅱ" : "▶"}</button>
        <span className="audio-track-mark" aria-hidden="true">♬</span>
        <div className="audio-track-copy">
          <strong title={name}>{name}</strong>
          <span>{durationLabel(total)}{size != null ? ` · ${fileSizeLabel(size)}` : ""}</span>
          <input type="range" min="0" max={Math.max(total, 1)} step="0.1" value={Math.min(state.current, total || 0)} onChange={(event) => state.seek(Number(event.target.value))} aria-label="Progresso do áudio" />
        </div>
        <a className="audio-track-download" href={url} download={mediaFilename(message) ?? undefined} aria-label={`Baixar ${name}`} title="Baixar áudio">⇩</a>
      </>}
    </div>
  );
};

const ImageMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const [expanded, setExpanded] = useState(false);
  const filename = mediaFilename(message);
  const label = filename ?? "Imagem";
  const size = mediaSize(message);
  return <>
    <div className="message-image-card">
      <button type="button" className="message-image-preview" onClick={() => setExpanded(true)} aria-label={`Ampliar ${label}`}><img src={url} alt={label} /></button>
      <div className={`message-media-footer${filename ? "" : " icon-only"}`}>
        {filename ? <span title={filename}>{filename}{size != null ? ` · ${fileSizeLabel(size)}` : ""}</span> : size != null ? <span>{fileSizeLabel(size)}</span> : null}
        <a href={url} download={filename ?? undefined} aria-label={`Baixar ${label}`} title="Baixar imagem">⇩</a>
      </div>
    </div>
    {expanded && <div className="media-modal-backdrop" role="presentation" onClick={() => setExpanded(false)}><section className="media-modal" role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()}><div className="media-modal-head"><strong title={label}>{label}</strong><div><a href={url} download={filename ?? undefined} aria-label={`Baixar ${label}`} title="Baixar imagem">⇩</a><button type="button" onClick={() => setExpanded(false)} aria-label="Fechar imagem">×</button></div></div><img src={url} alt={label} /></section></div>}
  </>;
};

const VideoMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const [playbackError, setPlaybackError] = useState<string>();
  const filename = mediaFilename(message);
  const seconds = mediaDuration(message);
  const size = mediaSize(message);
  const detail = [seconds != null ? durationLabel(seconds) : undefined, size != null ? fileSizeLabel(size) : undefined].filter(Boolean).join(" · ");
  return <div className="message-video-card">
    <video className="message-media video" controls preload="metadata" poster={message.thumbnailUrl ?? undefined} playsInline onLoadedMetadata={() => setPlaybackError(undefined)} onStalled={() => setPlaybackError("O vídeo está demorando para carregar.")} onError={() => setPlaybackError("Formato de vídeo inválido ou não suportado.")}>
      <source src={url} type={message.mediaMimeType ?? undefined} />
    </video>
    <div className="message-media-footer">
      <span title={filename ?? undefined}>{filename ?? "Vídeo"}{detail ? ` · ${detail}` : ""}</span>
      <a href={url} download={filename ?? undefined} aria-label="Baixar vídeo" title="Baixar vídeo">⇩</a>
    </div>
    {playbackError && <span className="media-error" role="status">{playbackError}</span>}
  </div>;
};

const DocumentMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const filename = mediaFilename(message);
  const kind = documentKind(filename, message.mediaMimeType ?? (wahaMime(message) ?? null));
  const label = filename ?? `Documento ${kind.label}`;
  const size = mediaSize(message);
  return <a className="message-document-card" href={url} download={filename ?? undefined} aria-label={`Baixar ${label}`}>
    <span className={`message-document-icon tone-${kind.tone}`}>{kind.label}</span>
    <span className="message-document-details">
      <strong title={label}>{label}</strong>
      <span><small>{kind.label}</small><small>{size != null ? fileSizeLabel(size) : "Tamanho não informado"}</small></span>
    </span>
    <span className="message-document-download" aria-hidden="true">⇩</span>
  </a>;
};
const wahaMime = (message: InboxMessage) => {
  const value = (message.metadata as { _data?: { mimetype?: unknown } } | undefined)?._data?.mimetype;
  return typeof value === "string" ? value : undefined;
};

/** Cartão de contato com ação de CRM.
 *
 *  A busca só acontece quando o operador pede: um `domain.contacts` por cartão no
 *  render seria uma requisição por mensagem na conversa, que é exatamente o N+1
 *  que o projeto proíbe. Um clique resolve, e o resultado decide entre abrir e
 *  oferecer criar. */
const ContactCardMessage = ({ message, domain, onOpenContact }: { message: InboxMessage; domain?: DomainApi; onOpenContact: (search: string) => void }) => {
  const cards = contactCards(message);
  if (!cards.length) return <span className="message-received-label">{message.content?.trim() || "Contato"}</span>;
  return <ul className="message-contact-card">{cards.map((card, index) => <li key={`${card.phoneNumber ?? index}`}><ContactCardEntry card={card} domain={domain} onOpenContact={onOpenContact} /></li>)}</ul>;
};

type CrmState = { step: "idle" | "checking" | "missing" | "creating" | "created" | "error"; message?: string };
const ContactCardEntry = ({ card, domain, onOpenContact }: { card: ContactCard; domain?: DomainApi; onOpenContact: (search: string) => void }) => {
  const [crm, setCrm] = useState<CrmState>({ step: "idle" });
  const name = card.fullName?.trim() || "Contato sem identificação";
  const phone = phoneDigits(card.phoneNumber);
  const find = async () => {
    if (!domain || !phone) { setCrm({ step: "error", message: "Este cartão não tem telefone para procurar." }); return; }
    setCrm({ step: "checking" });
    try {
      const page = await domain.contacts({ search: phone, pageSize: 1 });
      if (page.items.length) { onOpenContact(phone); setCrm({ step: "idle" }); return; }
      setCrm({ step: "missing" });
    } catch { setCrm({ step: "error", message: "Não foi possível consultar o CRM agora." }); }
  };
  const create = async () => {
    if (!domain) return;
    setCrm({ step: "creating" });
    try {
      await domain.createContact({ displayName: name, phoneNumber: phone, ...(card.organization ? { company: card.organization } : {}) });
      setCrm({ step: "created" });
    } catch { setCrm({ step: "error", message: "Não foi possível criar o contato." }); }
  };
  return <>
    <span className="message-contact-avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
    <span className="message-contact-copy">
      <strong title={name}>{name}</strong>
      <span>{phoneDisplay(card.phoneNumber)}</span>
      {card.organization ? <small>{card.organization}</small> : null}
    </span>
    <span className="message-contact-actions">
      {card.phoneNumber ? <a href={`tel:${phone}`} aria-label={`Ligar para ${name}`} title="Ligar">☏</a> : null}
      {crm.step === "missing"
        ? <button type="button" onClick={() => void create()} aria-label={`Criar ${name} no CRM`}>Criar contato</button>
        : crm.step === "created"
          ? <button type="button" onClick={() => onOpenContact(phone)} aria-label={`Abrir ${name} no CRM`}>Criado · abrir</button>
          : <button type="button" onClick={() => void find()} disabled={crm.step === "checking" || crm.step === "creating"} aria-label={`Ver ${name} no CRM`}>{crm.step === "checking" ? "Procurando…" : crm.step === "creating" ? "Criando…" : "Ver no CRM"}</button>}
    </span>
    {crm.step === "missing" && <small className="message-contact-hint" role="status">Ainda não está no CRM.</small>}
    {crm.step === "error" && <small className="message-contact-hint failed" role="alert">{crm.message}</small>}
  </>;
};

const LocationMessage = ({ message }: { message: InboxMessage }) => {
  const point = locationOf(message.metadata);
  if (!point) return <span className="message-received-label">Localização sem coordenadas</span>;
  const coordinates = coordinatesLabel(point.latitude, point.longitude);
  // Cartão inteiro clicável, com destino explícito: o operador precisa saber que
  // sai do ChatPro para o mapa antes de clicar.
  return (
    <a className="message-location" href={mapsUrl(point.latitude, point.longitude)} target="_blank" rel="noreferrer noopener" aria-label={`Abrir no mapa: ${point.title || point.address || coordinates}`}>
      {point.thumbnail && <img className="message-location-thumb" src={point.thumbnail} alt="" />}
      <span className="message-location-copy">
        <strong><span className="message-location-pin" aria-hidden="true">◎</span>{point.title || "Localização"}{point.live && <em> · ao vivo</em>}</strong>
        {point.address && <span>{point.address}</span>}
        <small>{coordinates}</small>
      </span>
      <span className="message-location-open">Abrir no mapa ↗</span>
    </a>
  );
};

export const Media = ({ message, api, domain, onOpenContact }: { message: InboxMessage; api: InboxApi; domain?: DomainApi; onOpenContact?: (search: string) => void }) => {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!message.mediaUrl) return;
    let active = true;
    setUrl(undefined);
    setFailed(false);
    void api.mediaUrl(message.id).then((access) => { if (active) setUrl(access.url); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [api, message.id, message.mediaUrl]);

  // Localização e cartão não têm mídia para buscar: viajam no payload guardado.
  if (message.messageType === "location") return <LocationMessage message={message} />;
  if (message.messageType === "contact") return <ContactCardMessage message={message} domain={domain} onOpenContact={onOpenContact ?? (() => undefined)} />;
  if (!message.mediaUrl) return message.direction === "inbound" ? <span className="message-received-label">Recebida</span> : null;
  if (failed) return <span className="media-error" role="status">Não foi possível carregar a mídia.</span>;
  if (!url) return <span className="media-loading" role="status">Carregando mídia…</span>;
  if (message.messageType === "image" || message.messageType === "sticker") return <ImageMessage message={message} url={url} />;
  if (message.messageType === "video") return <VideoMessage message={message} url={url} />;
  if (message.messageType === "audio" || message.messageType === "ptt" || message.mediaMimeType?.startsWith("audio/"))
    return isVoiceNote(message) ? <VoiceNoteMessage message={message} url={url} /> : <AudioFileMessage message={message} url={url} />;
  return <DocumentMessage message={message} url={url} />;
};
