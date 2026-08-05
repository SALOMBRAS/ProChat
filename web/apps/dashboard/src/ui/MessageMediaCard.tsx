import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { InboxApi, InboxMessage } from "../api/inbox.js";
import type { DomainApi } from "../api/domain.js";
import { fileSizeLabel } from "./attachmentIntake.js";
import {
  browserOpenable,
  contactCards,
  coordinatesLabel,
  documentKind,
  documentThumbnail,
  downloadWithProgress,
  durationLabel,
  formatTextPreview,
  isVoiceNote,
  mediaDuration,
  mediaFilename,
  mediaKindLabel,
  locationOf,
  mapsUrl,
  mediaSize,
  phoneDigits,
  phoneDisplay,
  probeMedia,
  textPreviewable,
  voiceWaveform,
  type ContactCard,
  type MediaFailure,
} from "./messageMedia.js";

/** Corpo das mensagens de mídia na conversa.
 *
 *  Saiu de Inbox.tsx inteiro porque é o que esta mudança reescreve, e porque o
 *  arquivo já passava de mil e quinhentas linhas. Nada aqui fala com o envio: só
 *  renderiza o que chegou.
 */

/** Um áudio por vez. Dois tocando ao mesmo tempo é sempre acidente. */
let activeAudio: HTMLAudioElement | undefined;

/** Descobre, depois de o elemento já ter falhado, se o arquivo sumiu de vez.
 *
 *  A pergunta só é feita quando há falha, e uma vez por mídia: perguntar no
 *  render seria uma requisição por mensagem de mídia da conversa, que é o N+1 que
 *  o projeto proíbe. No caminho feliz o custo é zero.
 *
 *  A Inbox não recebe `mediaPersistenceStatus` — o `InboxMessage` que a API
 *  entrega não tem esse campo —, então o estado é descoberto pela única coisa
 *  observável daqui: o que o proxy responde. */
const useMediaFailure = (url: string) => {
  const [failure, setFailure] = useState<MediaFailure>();
  // A promessa fica guardada, e não só um "já perguntei": quem precisa da
  // resposta para decidir o que fazer em seguida — o clique no documento — assim
  // espera a mesma pergunta em vez de abrir outra.
  const asked = useRef<{ url: string; answer: Promise<MediaFailure> }>();
  const classify = useCallback(() => {
    if (asked.current?.url !== url) asked.current = { url, answer: probeMedia(url).then((value) => { setFailure(value); return value; }) };
    return asked.current.answer;
  }, [url]);
  return { failure, gone: failure === "gone", classify };
};

/** O cartão do arquivo que não volta.
 *
 *  Não é erro: é um fato sobre o histórico, e a linguagem tem de dizer isso. Não
 *  oferece "tentar de novo", porque não há o que tentar. E carrega os metadados
 *  que sobreviveram — nome, tamanho, duração —, que é o que ainda permite ao
 *  operador saber do que a conversa estava falando. A legenda continua abaixo,
 *  desenhada pelo balão. */
const MediaGone = ({ message }: { message: InboxMessage }) => {
  const kind = mediaKindLabel(message);
  const filename = mediaFilename(message);
  const seconds = mediaDuration(message);
  const size = mediaSize(message);
  const detail = [filename, seconds != null ? durationLabel(seconds) : undefined, size != null ? fileSizeLabel(size) : undefined].filter(Boolean).join(" · ");
  return (
    <div className="message-media-gone" role="status">
      <span className="message-media-gone-mark" aria-hidden="true">⃠</span>
      <span className="message-media-gone-copy">
        <strong>{kind} indisponível</strong>
        <small>O arquivo não chegou a ser guardado e o WhatsApp já o descartou.</small>
        {detail && <small className="message-media-gone-meta">{detail}</small>}
      </span>
    </div>
  );
};

const useAudio = (message: InboxMessage, url: string) => {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(mediaDuration(message) ?? 0);
  const [unavailable, setUnavailable] = useState(false);
  const media = useMediaFailure(url);
  const toggle = async () => {
    const node = audio.current;
    if (!node) return;
    if (node.paused) {
      if (activeAudio && activeAudio !== node) activeAudio.pause();
      activeAudio = node;
      // Não tocar pode ser o arquivo que sumiu ou o navegador de agora: quem
      // separa os dois é a pergunta ao proxy, não o `catch`.
      try { await node.play(); } catch { setUnavailable(true); media.classify(); }
    } else node.pause();
  };
  const seek = (value: number) => { if (audio.current) audio.current.currentTime = value; setCurrent(value); };
  return { audio, playing, current, duration, unavailable, media, toggle, seek };
};

/** Nota de voz: forma de onda e velocidade de reprodução.
 *
 *  As barras são as 64 amplitudes que o próprio WhatsApp mandou — não é desenho
 *  decorativo nem amostragem feita aqui. Sem elas, cai numa barra de progresso
 *  simples em vez de fingir um traçado. */
const VoiceNoteMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const state = useAudio(message, url);
  const wave = voiceWaveform(message);
  const total = state.duration || mediaDuration(message) || 0;
  const progress = total ? Math.min(1, state.current / total) : 0;
  const [speed, setSpeed] = useState(1);
  const changeSpeed = () => { const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (state.audio.current) state.audio.current.playbackRate = next; };
  if (state.media.gone) return <MediaGone message={message} />;
  return (
    <div className="voice-note" aria-label="Mensagem de voz">
      <audio ref={state.audio} preload="metadata" src={url}
        onLoadedMetadata={() => { const node = state.audio.current; if (node && Number.isFinite(node.duration)) node.dataset.ready = "1"; }}
        onError={state.media.classify}
        onTimeUpdate={() => undefined} hidden />
      {state.unavailable ? <span className="media-error" role="status">Não foi possível reproduzir o áudio agora.</span> : <>
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
  const state = useAudio(message, url);
  const name = mediaFilename(message) ?? "Arquivo de áudio";
  const total = state.duration || mediaDuration(message) || 0;
  const size = mediaSize(message);
  if (state.media.gone) return <MediaGone message={message} />;
  return (
    <div className="audio-track" aria-label="Arquivo de áudio">
      <audio ref={state.audio} preload="metadata" src={url} onLoadedMetadata={() => undefined} onError={state.media.classify} hidden />
      {state.unavailable ? <span className="media-error" role="status">Não foi possível reproduzir o áudio agora.</span> : <>
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
  const media = useMediaFailure(url);
  const filename = mediaFilename(message);
  const label = filename ?? "Imagem";
  const size = mediaSize(message);
  if (media.gone) return <MediaGone message={message} />;
  return <>
    <div className="message-image-card">
      <button type="button" className="message-image-preview" onClick={() => setExpanded(true)} aria-label={`Ampliar ${label}`}><img src={url} alt={label} onError={media.classify} /></button>
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
  const media = useMediaFailure(url);
  const filename = mediaFilename(message);
  const seconds = mediaDuration(message);
  const size = mediaSize(message);
  const detail = [seconds != null ? durationLabel(seconds) : undefined, size != null ? fileSizeLabel(size) : undefined].filter(Boolean).join(" · ");
  if (media.gone) return <MediaGone message={message} />;
  // O erro do elemento não distingue "arquivo sumiu" de "formato que não toca", e
  // dizer "formato inválido" sobre um arquivo que já não existe manda o operador
  // procurar defeito onde não há. Por isso o `onError` também pergunta ao proxy.
  return <div className="message-video-card">
    <video className="message-media video" controls preload="metadata" poster={message.thumbnailUrl ?? undefined} playsInline onLoadedMetadata={() => setPlaybackError(undefined)} onStalled={() => setPlaybackError("O vídeo está demorando para carregar.")} onError={() => { setPlaybackError("Formato de vídeo inválido ou não suportado."); media.classify(); }}>
      <source src={url} type={message.mediaMimeType ?? undefined} />
    </video>
    <div className="message-media-footer">
      <span title={filename ?? undefined}>{filename ?? "Vídeo"}{detail ? ` · ${detail}` : ""}</span>
      <a href={url} download={filename ?? undefined} aria-label="Baixar vídeo" title="Baixar vídeo">⇩</a>
    </div>
    {playbackError && <span className="media-error" role="status">{playbackError}</span>}
  </div>;
};

/** Entrega o blob ao navegador como arquivo.
 *
 *  A âncora ganha `rel="noopener"` como qualquer outra que este projeto abre — o
 *  objectURL é interno, mas o hábito é barato e uniforme. A revogação espera um
 *  segundo: revogar na hora cancela o download em alguns navegadores, porque o
 *  clique só agenda a navegação. */
const saveBlob = (blob: Blob, name: string) => {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
};

/** Janela de prévia de texto, aberta só quando o operador pede.
 *
 *  O conteúdo é buscado uma única vez — o arquivo já está no proxy e o `fetch`
 *  não se repete a cada render. Reusa a moldura da imagem: mesma semântica de
 *  diálogo, mesmo fechar no clique fora. */
const DocumentTextPreview = ({ message, url, label, onClose }: { message: InboxMessage; url: string; label: string; onClose: () => void }) => {
  const [content, setContent] = useState<string | null>();
  useEffect(() => {
    let active = true;
    void fetch(url)
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => { if (active) setContent(text == null ? null : formatTextPreview(text, message.mediaMimeType ?? (wahaMime(message) ?? null), mediaFilename(message))); })
      .catch(() => { if (active) setContent(null); });
    return () => { active = false; };
  }, [message, url]);
  return <div className="media-modal-backdrop" role="presentation" onClick={onClose}>
    <section className="media-modal" role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()}>
      <div className="media-modal-head"><strong title={label}>{label}</strong><div><button type="button" onClick={onClose} aria-label="Fechar visualização">×</button></div></div>
      {content === undefined
        ? <span className="media-loading" role="status">Carregando conteúdo…</span>
        : content === null
          ? <span className="media-error" role="status">Não foi possível carregar o conteúdo.</span>
          : <pre className="document-text-preview">{content}</pre>}
    </section>
  </div>;
};

/** Documento é o único tipo sem carga passiva: um link não avisa que o destino
 *  sumiu, e sem isto o operador clica e recebe um JSON de 404 na cara.
 *
 *  O Baixar pergunta antes de ir — 0,1 s, medido —, e ou troca o cartão pelo
 *  aviso ou baixa com barra de progresso, entregando o blob com o nome original.
 *  Se a sondagem ou a leitura falharem, o clique seguinte vai direto à âncora
 *  nativa: é o comportamento de sempre, degradado. Perguntar na montagem seria
 *  uma requisição por documento da conversa, que é o N+1 que o projeto proíbe. */
const DocumentMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const filename = mediaFilename(message);
  const mime = message.mediaMimeType ?? (wahaMime(message) ?? null);
  const kind = documentKind(filename, mime);
  const label = filename ?? `Documento ${kind.label}`;
  const size = mediaSize(message);
  const thumbnail = documentThumbnail(message);
  const openable = browserOpenable(filename, mime);
  const previewable = textPreviewable(filename, mime);
  // Etiqueta vem do tipo real; a extensão só vira chip quando conta algo a mais
  // (relatorio.xlsx mostra XLS + XLSX; relatorio.xls mostra só XLS).
  const extension = filename?.split(".").pop()?.toUpperCase();
  const extensionChip = extension && extension !== kind.label ? extension : undefined;
  const media = useMediaFailure(url);
  const anchor = useRef<HTMLAnchorElement>(null);
  const nativeFallback = useRef(false);
  const [preview, setPreview] = useState(false);
  const [download, setDownload] = useState<{ active: boolean; pct: number | null }>({ active: false, pct: null });
  const check = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    // Depois de uma falha de rede o próximo clique vai direto à âncora, como
    // sempre foi — não se segura o operador refém de uma sondagem quebrada.
    if (nativeFallback.current || download.active) { if (download.active) event.preventDefault(); return; }
    event.preventDefault();
    void media.classify().then(async (failure) => {
      // Sumiu: o próprio `classify` já marcou, e o cartão troca sozinho.
      if (failure === "gone") return;
      try {
        setDownload({ active: true, pct: null });
        const blob = await downloadWithProgress(url, size ?? undefined, (pct) => setDownload({ active: true, pct }));
        saveBlob(blob, label);
      } catch {
        nativeFallback.current = true;
        anchor.current?.click();
      } finally {
        setDownload({ active: false, pct: null });
      }
    });
  };
  if (media.gone) return <MediaGone message={message} />;
  return <div className="message-document-card">
    {thumbnail && <img className="message-document-thumb" src={thumbnail} alt="" loading="lazy" />}
    <span className={`message-document-icon tone-${kind.tone}`}>{kind.label}</span>
    <span className="message-document-details">
      <strong title={label}>{label}</strong>
      <span>
        <small>{kind.label}</small>
        {extensionChip && <small>{extensionChip}</small>}
        <small>{size != null ? fileSizeLabel(size) : "Tamanho não informado"}</small>
      </span>
      {download.active && (
        <span className="document-progress" role="status">
          <span className="document-progress-track"><i style={download.pct == null ? undefined : { width: `${download.pct}%` }} /></span>
          {download.pct == null ? "Baixando…" : `${download.pct}%`}
        </span>
      )}
    </span>
    <span className="message-document-actions">
      {openable && <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${label} em nova aba`} title="Abrir em nova aba">↗</a>}
      {previewable && <button type="button" onClick={() => setPreview(true)} aria-label={`Visualizar ${label}`} title="Visualizar conteúdo">≡</button>}
      <a ref={anchor} href={url} download={filename ?? undefined} onClick={check} aria-label={`Baixar ${label}`} title="Baixar">⇩</a>
    </span>
    {preview && <DocumentTextPreview message={message} url={url} label={label} onClose={() => setPreview(false)} />}
  </div>;
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
