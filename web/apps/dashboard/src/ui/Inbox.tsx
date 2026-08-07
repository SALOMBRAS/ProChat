import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationPriority,
  ConversationStatus,
  GroupParticipant,
  HistorySyncJob,
  InboxConversation,
  InboxMessage,
  MessageReaction,
  Page,
  SlaMetrics,
} from "../api/inbox.js";
import { InboxApi } from "../api/inbox.js";
import { connectRealtime } from "../api/realtime.js";
import { ApiError } from "../api/client.js";
import type { ActiveCall } from "../api/calls.js";
import { useCalls } from "./useCalls.js";
import { CallModal } from "./CallModal.js";
import { CallHistory } from "./CallHistory.js";
import { callEventText } from "./callEvent.js";
import { WorkspaceApi } from "../api/workspace.js";
import { SessionsApi, type Session } from "../api/sessions.js";
import { DomainApi } from "../api/domain.js";
import type { PersistenceContact, Team, WorkspaceUser } from "@chatpro/contracts";
import { InboxKanban } from "./InboxKanban.js";
import { MicrophonePermission } from "./MicrophonePermission.js";
import { audioInputs, isSilent, microphoneErrorMessage, microphoneState, signalLevel, SILENCE_WARNING } from "./microphone.js";
import { conversationIdFromLocation, inboxUrlForConversation } from "./conversationNavigation.js";
import { contactLabel, conversationPhone, participantLabel } from "./contactIdentity.js";
import { Media } from "./MessageMediaCard.js";
import { LinkPreview, linkify } from "./LinkPreviewCard.js";
import { cachedLinkPreview, domainFromUrl, findUrls, type LinkPreviewData } from "./linkPreview.js";
import { MentionAutocomplete } from "./MentionAutocomplete.js";
import { filterParticipants, insertMention, isGroupAdmin, mentionJidsOf, mentionTrigger, participantDisplay, serializeMentions, tokenizeMentions, type MentionRecord } from "./mentions.js";
import { bodyRepeatsCard, mapsUrl, phoneDisplay } from "./messageMedia.js";
// Os leitores de localização moram em messageMedia.ts junto dos outros; o
// reexporte mantém o caminho de importação que já existia.
export { coordinatesLabel, locationOf, mapsUrl } from "./messageMedia.js";
import { ImageAnnotator } from "./ImageAnnotator.js";
import { PRISTINE_EDIT, isEditableImage, isPristineEdit, type ImageEdit } from "./imageAnnotation.js";
import { isActiveSync, resumeAttribution, syncView, type SyncResume, type SyncStatus } from "./syncProgress.js";
import { messageLoadFailure, type LoadFailure } from "./messageLoadError.js";
import { AttachmentComposer } from "./AttachmentComposer.js";
import { ContactPicker } from "./ContactPicker.js";
import {
  ATTACHMENT_POLICY,
  HTML_IMAGE_ONLY_MESSAGE,
  acceptAttachment,
  attachmentKind,
  extraFilesMessage,
  fileSizeLabel,
  readTransfer,
  rejectedMessage,
  verdictMessage,
} from "./attachmentIntake.js";

const defaultApi = new InboxApi();
const workspaceApi = new WorkspaceApi();
const sessionsApi = new SessionsApi();
const defaultDomainApi = new DomainApi();
const pageSize = 50;
const workspaceId = import.meta.env.VITE_WORKSPACE_ID || "default-workspace";
const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : "Ocorreu um erro inesperado.";
const durationLabel = (milliseconds: number) => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}min`;
};
const slaStatusLabel: Record<SlaMetrics["status"], string> = { waiting_operator: "Aguardando atendente", waiting_customer: "Aguardando cliente", answered: "Respondida", resolved: "Resolvida", archived: "Arquivada", expired: "Atrasada" };
const isGroup = (value: InboxConversation) =>
  value.conversationType === "group";
const phoneFallback = (value: InboxConversation) =>
  conversationPhone(value) ?? "Contato sem identificação";
const contactName = (value: InboxConversation) => contactLabel(value);
const initials = (value: InboxConversation) =>
  isGroup(value) ? "GR" : contactName(value).slice(-2).toUpperCase();
const senderName = (value?: string | null) => participantLabel(value);
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
const activityLabel = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
/** Os limites que a captura consulta. Ultrapassar não corrompe nada — a API
 *  responde 413 "Arquivo excede o limite permitido" e o job nem é criado —, mas
 *  gravar dois minutos de vídeo para descobrir isso no envio é tempo perdido do
 *  operador, então a captura para sozinha ao atingir o teto. O espelho de `policy`
 *  agora é um só, em attachmentIntake.ts. */
const ATTACHMENT_LIMITS = { image: ATTACHMENT_POLICY.image.max, video: ATTACHMENT_POLICY.video.max } as const;
/** A allowlist do servidor é mais estreita que `image/*`: HEIC do iPhone e 3gpp de
 *  Android seriam recusados com 415. Pedir só o que é aceito evita que o seletor
 *  ofereça um arquivo que vai falhar depois do upload. */
const CAMERA_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/webm";
/** Quem abre a tela de composição.
 *
 *  Imagem e vídeo abrem porque têm o que olhar: a tela existe para o operador ver
 *  a mídia grande antes de mandar, e para a legenda ficar encostada nela.
 *
 *  Documento e áudio continuam no cartão. Documento porque a prévia que daria para
 *  desenhar aqui é ícone, nome e tamanho — exatamente o que o cartão já mostra, em
 *  dez vezes a área e sem nada a mais para ver; renderizar a primeira página de um
 *  PDF exigiria biblioteca nova. Áudio porque o próprio WhatsApp não abre tela para
 *  nota de voz: ela é gravada no compositor e sai dali, e tomar a conversa para
 *  mostrar uma barra de reprodução acrescentaria um passo sem nada em troca. */
const STAGE_KINDS: readonly string[] = ["image", "video"];
/** Os três motivos que a API de geolocalização distingue. O `code` é o contrato —
 *  `message` é texto do navegador, varia por fabricante e não é para o operador. */
const geolocationErrorMessage = (error: unknown) => {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === 1) return "Permissão de localização negada. Autorize o acesso nas configurações do navegador ou informe o ponto abaixo.";
  if (code === 2) return "Localização indisponível agora. Verifique se o GPS ou a rede estão ativos, ou informe o ponto abaixo.";
  if (code === 3) return "A localização demorou demais para responder. Tente de novo ou informe o ponto abaixo.";
  return "Não foi possível obter a localização. Informe o ponto abaixo.";
};
/** Lê "lat, lon" — e o problema é que, em português, a vírgula é ao mesmo tempo o
 *  separador do par e o separador decimal.
 *
 *  A versão anterior separava por vírgula antes de converter, então `-7,115`
 *  virava o par `{-7, 115}` — um ponto no Oceano Índico — e era ENVIADO, porque a
 *  função devolvia um objeto e o botão de enviar só olha se ela devolveu algo.
 *  Uma latitude sozinha, escrita no formato da própria língua, mandava o contato
 *  para outro continente sem uma linha de erro.
 *
 *  A regra que desfaz a ambiguidade é a que as pessoas já usam ao escrever:
 *
 *    vírgula colada num dígito  ->  é DECIMAL     (-7,115)
 *    vírgula seguida de espaço  ->  é SEPARADOR   (-7, 115)
 *    ponto-e-vírgula ou espaço  ->  é SEPARADOR   (-7,115; -34,861)
 *
 *  Com ela `-7,115` tem uma leitura só — um número — e um número só não é um par:
 *  é recusado, que era o objetivo. `-7, 115` continua valendo como par de
 *  inteiros, e `-7,115, -34,861` é lido como o brasileiro escreve.
 *
 *  A alternativa era exigir ponto decimal e recusar toda vírgula. Foi descartada:
 *  vírgula é o separador decimal da língua do produto, é o que sai de calculadora
 *  e de planilha em pt-BR, e recusá-la empurraria o operador a converter à mão —
 *  que é exatamente onde se erra um dígito.
 *
 *  Depois de separar, cada lado precisa ser um decimal simples. `Number` aceita
 *  `0x10` (16), `1e2` e `Infinity`; nenhum é coordenada que alguém digitou
 *  querendo, e `0x10, 0` passava antes. A faixa continua conferida: latitude fora
 *  de ±90 ou longitude fora de ±180 não é ponto nenhum. */
const DECIMAL_SIMPLES = /^[+-]?\d+(?:\.\d+)?$/;
export const parseCoordinates = (value: string) => {
  // A vírgula colada num dígito é decimal e vira ponto; a que sobrar é separador.
  const parts = value.trim().replace(/,(?=\d)/g, ".").split(/[;,\s]+/).filter(Boolean);
  if (parts.length !== 2) return undefined;
  if (!parts.every((part) => DECIMAL_SIMPLES.test(part))) return undefined;
  const [latitude, longitude] = parts.map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
};
const cameraErrorMessage = (error: unknown) => {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Permissão de câmera negada. Autorize o acesso à câmera nas configurações do navegador e tente de novo.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "Nenhuma câmera encontrada neste dispositivo.";
  if (name === "NotReadableError" || name === "TrackStartError") return "A câmera está em uso por outro aplicativo. Feche o outro programa e tente de novo.";
  if (name === "OverconstrainedError") return "Nenhuma câmera compatível com a resolução pedida.";
  return "Não foi possível acessar a câmera.";
};
const statusLabel: Record<ConversationStatus, string> = { open: "Aberta", in_progress: "Em atendimento", waiting_customer: "Aguardando cliente", resolved: "Resolvida", archived: "Arquivada" };
const priorityLabel: Record<ConversationPriority, string> = { low: "Baixa", normal: "Normal", high: "Alta", urgent: "Urgente" };
const operationLabel: Record<ConversationEvent["action"], string> = { assigned: "Responsável alterado", unassigned: "Conversa sem responsável", status_changed: "Status alterado", priority_changed: "Prioridade alterada", archived: "Conversa arquivada", reopened: "Conversa reaberta" };
type InboxFilter = "all" | "unread" | "mine" | "unassigned" | "in_progress" | "waiting_customer" | "resolved" | "archived" | "high_priority";
/** Rótulo do agrupamento por dia da lista, como na referência: HOJE, ONTEM e
 *  depois a data curta. A lista já vem ordenada por `lastMessageAt` desc, então
 *  os grupos saem em blocos contíguos. */
const inboxDayLabel = (iso: string): string => {
  const value = new Date(iso); const today = new Date();
  const key = (day: Date) => `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
  if (key(value) === key(today)) return "HOJE";
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (key(value) === key(yesterday)) return "ONTEM";
  return value.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).replace(/\./g, "").toUpperCase();
};
const currentUserId = import.meta.env.VITE_USER_ID || "00000000-0000-4000-8000-000000000001";
const Avatar = ({
  conversation,
  large = false,
  customer = false,
}: {
  conversation: InboxConversation;
  large?: boolean;
  customer?: boolean;
}) => (
  <span
    className={`${customer ? "customer-avatar" : "conversation-avatar"}${large ? " large" : ""}`}
  >
    {conversation.identity?.avatarUrl ? (
      <img src={conversation.identity.avatarUrl} alt="" />
    ) : (
      initials(conversation)
    )}
    {!customer && (
      <i className={conversation.status === "open" ? "online" : ""} />
    )}
  </span>
);
const statusIcon = (status: InboxMessage["status"]) =>
  status === "read" || status === "delivered"
    ? "✓✓"
    : status === "failed"
      ? "!"
      : status === "sending"
        ? "◌"
        : "✓";
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const reactionGroups = (reactions: MessageReaction[] | undefined) => {
  const groups = new Map<string, { emoji: string; count: number; mine: boolean; authors: string[] }>();
  for (const reaction of reactions ?? []) {
    const group = groups.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false, authors: [] };
    group.count += 1;
    group.mine = group.mine || reaction.fromMe;
    group.authors.push(reaction.fromMe ? "Você" : reaction.reactorName ?? reaction.reactorPhone ?? reaction.reactorWhatsappId ?? "Contato");
    groups.set(reaction.emoji, group);
  }
  return [...groups.values()];
};
/** Badges agrupados por emoji (como no WhatsApp Web) + gatilho/seletor rápido.
 *  As classes seguem o bloco "Reações (T1)" do styles.css: gatilho absoluto no
 *  hover da bolha, seletor flutuante, `.mine` marca a reação da própria conta.
 *  Clicar num badge repete a reação daquele emoji — e o toggle do servidor a
 *  remove. */
const MessageReactions = ({ message, onReact, failed }: { message: InboxMessage; onReact: (emoji: string) => void; failed: boolean }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { const target = event.target as Node; if (!triggerRef.current?.contains(target) && !pickerRef.current?.contains(target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const groups = reactionGroups(message.reactions);
  return (
    <>
      <button ref={triggerRef} type="button" className="reaction-trigger" aria-label="Reagir à mensagem" aria-expanded={open} onClick={() => setOpen((current) => !current)}>😊</button>
      {open && (
        <span ref={pickerRef} className="reaction-picker" role="menu">
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" role="menuitem" onClick={() => { setOpen(false); onReact(emoji); }}>{emoji}</button>
          ))}
        </span>
      )}
      {failed && <span className="message-reaction-error" role="alert" title="Reação não enviada">⚠</span>}
      {groups.length > 0 && (
        <span className="message-reactions">
          {groups.map((group) => (
            <button key={group.emoji} type="button" className={`message-reaction-badge${group.mine ? " mine" : ""}`} title={group.authors.join(", ")} onClick={() => onReact(group.emoji)}>
              {group.emoji}{group.count > 1 && <span className="reaction-count">{group.count}</span>}
            </button>
          ))}
        </span>
      )}
    </>
  );
};
/** Corpo da mensagem: menções conhecidas viram destaque (`@dígitos` →
 *  `@Nome`, com fallback nos dígitos); os demais segmentos seguem para o
 *  linkify, então URL ao lado de menção continua virando link. */
const renderMessageBody = (message: InboxMessage, mentionResolver?: (jid: string) => string | null) => {
  const content = message.content;
  if (!content) return null;
  const jids = mentionJidsOf(message.metadata);
  if (!jids.length) return linkify(content);
  return tokenizeMentions(content, jids, (jid) => mentionResolver?.(jid) ?? null).map((segment, index) =>
    typeof segment === "string" ? <Fragment key={index}>{linkify(segment)}</Fragment> : <span key={index} className="message-mention">{segment.label}</span>);
};
const MessageBubble = ({ message, api, domain, onOpenContact, showAuthor, highlighted = false, onReact, reactionFailed = false, mentionResolver }: { message: InboxMessage; api: InboxApi; domain?: DomainApi; onOpenContact?: (search: string) => void; showAuthor: boolean; highlighted?: boolean; onReact?: (message: InboxMessage, emoji: string) => void; reactionFailed?: boolean; mentionResolver?: (jid: string) => string | null }) => (
  <article id={`conversation-search-result-${message.id}`} className={`message-bubble ${message.direction}${highlighted ? " search-highlighted" : ""}`}>
    {showAuthor && <strong className="message-author">{senderName(message.senderWhatsappId)}:</strong>}
    {message.messageType === "call" && <p className="message-call"><span aria-hidden="true">📞</span> {callEventText(message.metadata)}</p>}
    <Media message={message} api={api} domain={domain} onOpenContact={onOpenContact} />
    {message.content && !bodyRepeatsCard(message) && <p>{renderMessageBody(message, mentionResolver)}</p>}
    {/* Uma prévia por mensagem, sempre do primeiro link: nativa do WhatsApp
        quando existe, retaguarda OG da API quando não. */}
    <LinkPreview message={message} api={api} />
    <span className={`message-meta status-${message.status}`}>
      {message.direction === "outbound" && <b aria-label={`Status: ${message.status}`}>{statusIcon(message.status)}{" "}</b>}
      {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </span>
    {onReact && <MessageReactions message={message} onReact={(emoji) => onReact(message, emoji)} failed={reactionFailed} />}
  </article>
);

export default function Inbox({ api = defaultApi, domain = defaultDomainApi }: { api?: InboxApi; domain?: DomainApi }) {
  const [conversationPage, setConversationPage] = useState<
    Page<InboxConversation>
  >({ items: [], page: 1, pageSize: 50, total: 0 });
  const [selected, setSelected] = useState<InboxConversation>();
  /** Chamadas de voz: o hook é dono do softphone e dos eventos `call.updated`;
   *  a inbox só renderiza o CallModal e dispara o 📞 do cabeçalho. */
  const calls = useCalls();
  /** Espelho síncrono da lista: o handler do socket lê daqui (o estado dentro
   *  do closure do `connectRealtime` ficaria preso à renderização de abertura). */
  const conversationsRef = useRef<InboxConversation[]>([]);
  conversationsRef.current = conversationPage.items;
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [messagePage, setMessagePage] = useState(1);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [attachment, setAttachment] = useState<File>();
  /** O arquivo como foi escolhido, antes de qualquer marcação. O editor sempre
   *  parte dele: reeditar a partir da exportação anterior empilharia perda de
   *  qualidade a cada rodada. A edição aplicada — traços, giro e recorte — volta
   *  por `attachmentEdit`, e é o que permite reabrir sem recodificar de novo. */
  const [attachmentSource, setAttachmentSource] = useState<File>();
  const [attachmentEdit, setAttachmentEdit] = useState<ImageEdit>(PRISTINE_EDIT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<string>();
  const [attachmentStatus, setAttachmentStatus] = useState("");
  /** Percentual do upload em curso. Só existe enquanto o XHR relata progresso:
   *  fora de um envio é `undefined`, e a barra some — nunca fica um resíduo de
   *  "100%" preso na tela depois que a resposta chegou. */
  const [uploadProgress, setUploadProgress] = useState<number>();
  /** Recado de colar ou arrastar. Fica separado de `attachmentStatus` porque
   *  recusa precisa ser anunciada (`role="alert"`) e não pode passar despercebida
   *  como o "Anexo em processamento" passa. */
  const [intakeMessage, setIntakeMessage] = useState<{ text: string; failed: boolean }>();
  const [dropping, setDropping] = useState(false);
  const dropDepth = useRef(0);
  const [composerText, setComposerText] = useState("");
  // Prévia do link no compositor (como o WhatsApp): o primeiro URL do texto
  // mostra o cartão acima do campo e o X envia o link puro, sem prévia.
  const [composerPreview, setComposerPreview] = useState<LinkPreviewData | null | undefined>(undefined);
  const [dismissedPreviewUrl, setDismissedPreviewUrl] = useState<string | null>(null);
  // Menções (T3): o `@` abre autocomplete só em grupo; os registros {display,
  // jid} vivem num ref porque são derivados do texto no submit — apagar o
  // `@Nome` descarta a menção (decisão: textarea de texto puro, sem chips).
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionActive, setMentionActive] = useState(0);
  const mentionsRef = useRef<MentionRecord[]>([]);
  const participantsCache = useRef(new Map<string, GroupParticipant[]>());
  const [participantsState, setParticipantsState] = useState<{ loading: boolean; failed: boolean }>({ loading: false, failed: false });
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  // A busca reusa o cache de sessão dos cartões já renderizados na conversa, e
  // o debounce de 400 ms poupa a API a cada tecla. URL dispensada (X) não
  // dispara busca nem cartão até o link mudar.
  const composerFirstUrl = useMemo(() => findUrls(composerText)[0], [composerText]);
  useEffect(() => {
    if (!composerFirstUrl || composerFirstUrl === dismissedPreviewUrl) { setComposerPreview(undefined); return; }
    let active = true;
    setComposerPreview(undefined);
    const timer = setTimeout(() => { void cachedLinkPreview(api, composerFirstUrl).then((data) => { if (active) setComposerPreview(data); }); }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [api, composerFirstUrl, dismissedPreviewUrl]);
  const [attachmentAccept, setAttachmentAccept] = useState<string>();
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder>();
  const recordingStreamRef = useRef<MediaStream>();
  const recordingTimerRef = useRef<ReturnType<typeof setInterval>>();
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [locatingNow, setLocatingNow] = useState(false);
  const [locationCoords, setLocationCoords] = useState("");
  const [locationTitle, setLocationTitle] = useState("");
  const [locationPoint, setLocationPoint] = useState<{ latitude: number; longitude: number }>();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [cameraRecording, setCameraRecording] = useState(false);
  const [cameraSeconds, setCameraSeconds] = useState(0);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream>();
  const cameraRecorderRef = useRef<MediaRecorder>();
  const cameraTimerRef = useRef<ReturnType<typeof setInterval>>();
  const discardRecordingRef = useRef(false);
  const discardCameraRef = useRef(false);
  const [attachmentCapture, setAttachmentCapture] = useState<"environment" | "user">();
  const [isRecording, setIsRecording] = useState(false);
  /** O portão de permissão do microfone. `undefined` = fechado. */
  const [micGate, setMicGate] = useState<{ state: "prompt" | "denied" | "choose"; asking: boolean; error?: string }>();
  /** O operador já passou pelo portão até o fim NESTA sessão.
   *
   *  Sem isto, a permissão do navegador era a única condição de entrada — e ela
   *  responde "dá para gravar?", não "o operador quer, e com qual microfone?".
   *  Quem concedia ao navegador e depois recusava no portão voltava a gravar no
   *  clique seguinte, porque o navegador já dizia `granted`. Ver o teste de
   *  regressão em InboxMicrophone.test.tsx. */
  const [micConsent, setMicConsent] = useState(false);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>();
  /** Nível do sinal durante a gravação, 0–1, e o aviso da causa 3. */
  const [micLevel, setMicLevel] = useState(0);
  const [micSilent, setMicSilent] = useState(false);
  const micMeterRef = useRef<{ context: AudioContext; raf: number }>();
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchInput, setConversationSearchInput] = useState("");
  const [conversationSearchTerm, setConversationSearchTerm] = useState("");
  const [listSearch, setListSearch] = useState("");
  /** Funil da lista: recorta a inbox por instância (whatsappSessionId) e/ou por
   *  departamento (assignedTeamId). Vazio = sem recorte. */
  const [sessions, setSessions] = useState<Session[]>([]);
  const [funnelSession, setFunnelSession] = useState("");
  const [funnelTeam, setFunnelTeam] = useState("");
  const [activeConversationMatch, setActiveConversationMatch] = useState(0);
  const [visualQueue, setVisualQueue] = useState("");
  const [creatingContact, setCreatingContact] = useState(false);
  const [contact, setContact] = useState<PersistenceContact>();
  const [editingContact, setEditingContact] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [contactError, setContactError] = useState("");
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics>();
  const [loadingSla, setLoadingSla] = useState(false);
  const [requestedConversationId, setRequestedConversationId] = useState(() => conversationIdFromLocation());
  /** A conversa aberta a partir de um card do Kanban. Estado separado de
   *  `selected` porque `selected` responde a outra pergunta — qual conversa a
   *  Inbox está mostrando —, e aqui é preciso saber se a **janela** está no ar,
   *  inclusive enquanto a conversa ainda está carregando ou falhou. */
  const [cardConversationOpen, setCardConversationOpen] = useState(false);
  const [cardConversationError, setCardConversationError] = useState("");
  const cardWindowRef = useRef<HTMLDivElement>(null);
  const cardOpenerRef = useRef<HTMLElement>();
  const [resolvingConversationId, setResolvingConversationId] = useState<string>();
  const [deepLinkError, setDeepLinkError] = useState("");
  const [deepLinkAttempt, setDeepLinkAttempt] = useState(0);
  const slaCache = useRef(new Map<string, SlaMetrics>());
  const slaRequest = useRef(0);
  const slaAbort = useRef<AbortController>();
  // Vídeo também ganha URL agora: a tela de composição mostra o clipe, não só o
  // nome do arquivo.
  useEffect(() => { if (!attachment || !STAGE_KINDS.includes(attachmentKind(attachment.type) ?? "")) { setAttachmentPreview(undefined); return; } const url = URL.createObjectURL(attachment); setAttachmentPreview(url); return () => URL.revokeObjectURL(url); }, [attachment]);
  /** Ponto único por onde um anexo entra ou sai do composer. Trocar o arquivo tem
   *  de descartar a marcação da imagem anterior junto, senão os traços de uma foto
   *  reapareceriam sobre a próxima. */
  /** Abre o CRM já filtrado no telefone do cartão. Mesmo idioma de navegação que
   *  o resto do app usa: `pushState` e um `popstate` para o App reagir. */
  const openContactInCrm = (search: string) => {
    history.pushState({}, "", `/contacts?search=${encodeURIComponent(search)}`);
    dispatchEvent(new PopStateEvent("popstate"));
  };
  const applyAttachment = (file?: File) => { setAttachment(file); setAttachmentSource(file); setAttachmentEdit(PRISTINE_EDIT); setEditorOpen(false); setIntakeMessage(undefined); setUploadProgress(undefined); };
  /** Só imagem da allowlist entra no editor: vídeo e documento não têm o que
   *  marcar, e um mime fora dela voltaria 415 depois de reexportado. */
  const editableAttachment = isEditableImage(attachmentSource?.type) ? attachmentSource : undefined;
  /** A tela de composição está no ar: a conversa deu lugar ao preview. */
  const stageOpen = Boolean(attachment) && STAGE_KINDS.includes(attachmentKind(attachment?.type) ?? "");
  /** O ponto que o painel de localização vai enviar. Uma fonte só para as três
   *  perguntas — habilitar o botão, montar o link de conferência e enviar —,
   *  porque foram duas que fizeram o link conferir um ponto e o envio mandar
   *  outro. */
  const locationTarget = parseCoordinates(locationCoords);
  /** Há legenda ou edição de imagem a perder ao descartar. */
  const stageDirty = Boolean(composerText.trim()) || !isPristineEdit(attachmentEdit);
  /** Fechar devolve a legenda ao compositor: quem escreveu a frase ainda pode
   *  mandá-la como texto. Remover joga fora as duas coisas. */
  const closeStage = () => clearAttachment();
  const removeStage = () => { clearAttachment(); setComposerText(""); };
  /** Anexa o que veio de colar ou arrastar. É a mesma função para os dois porque
   *  `clipboardData` e `dataTransfer` são o mesmo `DataTransfer`; o que muda é só
   *  quem chamou. Termina no mesmo `applyAttachment` do menu "+". */
  const takeTransfer = async (data: DataTransfer | null) => {
    const intake = readTransfer(data);
    if (!intake.accepted.length) {
      setIntakeMessage({ text: intake.rejected.length ? rejectedMessage(intake.rejected) : HTML_IMAGE_ONLY_MESSAGE, failed: true });
      return;
    }
    const [first] = intake.accepted;
    const verdict = await acceptAttachment(first, Date.now());
    if (!verdict.ok) { setIntakeMessage({ text: verdictMessage(verdict, first), failed: true }); return; }
    applyAttachment(verdict.file);
    setAttachmentStatus("");
    const extra = intake.accepted.length + intake.rejected.length;
    setIntakeMessage(extra > 1 ? { text: extraFilesMessage(extra), failed: false } : undefined);
    // O editor de traço não abre sozinho: colar e enviar é o caso dominante. Imagem
    // e vídeo caem na tela de composição, e o traço fica no botão Editar da barra.
  };
  const pasteIntoComposer = (event: ClipboardEvent<HTMLFormElement>) => {
    if (sending) return;
    const intake = readTransfer(event.clipboardData);
    // Sem arquivo e sem imagem órfã no HTML é colagem de texto: sair sem
    // `preventDefault` é o que deixa o textarea receber o texto normalmente.
    if (!intake.accepted.length && !intake.rejected.length && !(intake.imageWithoutFile && !intake.text)) return;
    event.preventDefault();
    void takeTransfer(event.clipboardData);
  };
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const dragEnter = (event: DragEvent<HTMLElement>) => { if (!carriesFiles(event) || sending || stageOpen) return; dropDepth.current += 1; setDropping(true); };
  // Sem `preventDefault` no dragover o navegador recusa o drop e abre o arquivo
  // numa aba, jogando fora a conversa aberta.
  const dragOver = (event: DragEvent<HTMLElement>) => { if (!carriesFiles(event) || sending || stageOpen) return; event.preventDefault(); };
  // `dragleave` dispara também ao passar de um filho para outro; o contador evita
  // que a moldura pisque no meio do arrasto.
  const dragLeave = (event: DragEvent<HTMLElement>) => { if (!carriesFiles(event)) return; dropDepth.current = Math.max(0, dropDepth.current - 1); if (!dropDepth.current) setDropping(false); };
  const drop = (event: DragEvent<HTMLElement>) => {
    // Com a tela de composição aberta o alvo já tem anexo: um por vez.
    if (!carriesFiles(event) || sending || stageOpen) return;
    event.preventDefault();
    dropDepth.current = 0;
    setDropping(false);
    void takeTransfer(event.dataTransfer);
  };
  useEffect(() => () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    // O AudioContext sobrevive ao desmonte e mantém o microfone ativo.
    const meter = micMeterRef.current;
    if (meter) { cancelAnimationFrame(meter.raf); void meter.context.close().catch(() => undefined); }
    // A câmera fica com a luz acesa se o stream sobreviver ao desmonte.
    if (cameraTimerRef.current) clearInterval(cameraTimerRef.current);
    discardCameraRef.current = true;
    if (cameraRecorderRef.current?.state === "recording") cameraRecorderRef.current.stop();
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setConversationSearchTerm(conversationSearchInput.trim().toLocaleLowerCase("pt-BR"));
      setActiveConversationMatch(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [conversationSearchInput]);
  useEffect(() => { setVisualQueue(""); }, [selected?.id]);
  const [context, setContext] = useState<ConversationContext>();
  const [notes, setNotes] = useState("");
  const [tag, setTag] = useState("");
  const [savingContext, setSavingContext] = useState(false);
  const [noteSaveState, setNoteSaveState] = useState<"editing" | "saving" | "saved" | "error">("saved");
  const [syncJob, setSyncJob] = useState<HistorySyncJob>();
  const [startingSync, setStartingSync] = useState(false);
  /** A quem creditar a retomada. Não vem do servidor — o job não guarda quem o
   *  disparou —, então é o que esta tela observou: um clique daqui, ou o job
   *  voltando a andar sozinho. */
  const [syncResume, setSyncResume] = useState<SyncResume>("unknown");
  const operatorAskedSync = useRef(false);
  const previousSyncStatus = useRef<SyncStatus>();
  /** A falha de carregamento das mensagens desta conversa. Limpa no começo de todo
   *  carregamento, e só gravada quando a conversa que falhou ainda é a aberta. */
  const [messagesError, setMessagesError] = useState<LoadFailure>();
  /** Lido de dentro do `catch`, que corre depois de a requisição ter ido e voltado
   *  — a essa altura o `syncJob` daquela renderização já pode estar velho. */
  const syncingRef = useRef(false);
  const [activity, setActivity] = useState<ConversationEvent[]>([]);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [view, setView] = useState<"list" | "kanban">("list");
  const [changingManagement, setChangingManagement] = useState(false);
  const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scrollAfterRender = useRef(false);
  const noteDrafts = useRef(new Map<string, string>());
  const activeConversationId = useRef<string>();
  const selectedRef = useRef<InboxConversation>();
  const contextRequest = useRef(0);
  const deepLinkAbort = useRef<AbortController>();
  const deepLinkRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; deepLinkAbort.current?.abort(); }, []);
  useEffect(() => {
    const sync = () => {
      const conversationId = conversationIdFromLocation();
      setRequestedConversationId(conversationId);
      if (!conversationId) {
        activeConversationId.current = undefined;
        setSelected(undefined);
        setMessages([]);
      }
    };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  const loadSla = async (conversationId: string) => {
    if (!api.slaMetrics) return;
    const cached = slaCache.current.get(conversationId);
    if (cached) { setSlaMetrics(cached); setLoadingSla(false); return; }
    slaAbort.current?.abort();
    const controller = new AbortController();
    slaAbort.current = controller;
    const request = ++slaRequest.current;
    setLoadingSla(true);
    try {
      const metrics = await api.slaMetrics(conversationId, controller.signal);
      slaCache.current.set(conversationId, metrics);
      if (activeConversationId.current === conversationId && request === slaRequest.current) setSlaMetrics(metrics);
    } catch {
      if (activeConversationId.current === conversationId && request === slaRequest.current) setSlaMetrics(undefined);
    } finally {
      if (activeConversationId.current === conversationId && request === slaRequest.current) setLoadingSla(false);
    }
  };
  // The conversation carries only the resolved identity; the editable ChatPro
  // contact behind it has to be read on its own.
  useEffect(() => {
    const contactId = selected?.contactId;
    setEditingContact(false);
    setContactError("");
    if (!contactId) { setContact(undefined); return; }
    let cancelled = false;
    void (async () => {
      try { const loaded = await domain.contact(contactId); if (!cancelled) setContact(loaded); }
      catch (nextError) { if (!cancelled) { setContact(undefined); setContactError(errorMessage(nextError)); } }
    })();
    return () => { cancelled = true; };
  }, [domain, selected?.contactId]);
  const createContact = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const conversationId = selected?.id;
    if (!conversationId) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const phoneNumber = text("phoneNumber");
    setSavingContact(true);
    setContactError("");
    try {
      // The API links the new contact to this conversation; without that the
      // binding would only happen when the contact wrote again.
      const created = await api.createContact(conversationId, { displayName: text("displayName"), ...(phoneNumber ? { phoneNumber } : {}), email: text("email") || null, company: text("company") || null });
      setSelected(created.conversation);
      setConversationPage((current) => ({ ...current, items: current.items.map((item) => item.id === created.conversation.id ? created.conversation : item) }));
      setCreatingContact(false);
    } catch (nextError) {
      setContactError(errorMessage(nextError));
    } finally {
      setSavingContact(false);
    }
  };
  const saveContact = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const contactId = selected?.contactId;
    if (!contactId) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    setSavingContact(true);
    setContactError("");
    try {
      // No tagIds: the Inbox edits identity fields only, and sending an
      // explicit list would replace the contact's CRM tags.
      setContact(await domain.updateContact(contactId, { displayName: text("displayName"), email: text("email") || null, company: text("company") || null }));
      setEditingContact(false);
      await refreshConversations();
    } catch (nextError) {
      setContactError(errorMessage(nextError));
    } finally {
      setSavingContact(false);
    }
  };
  const refreshConversations = async () => {
    setLoadingConversations(true);
    try {
      setConversationPage(await api.conversations());
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoadingConversations(false);
    }
  };
  const loadLatest = async (conversationId: string, stickToEnd: boolean) => {
    setLoadingMessages(true);
    setMessagesError(undefined);
    try {
      // The API returns the most recent reverse-cursor page first. Do not
      // request the whole history merely to find its final offset page.
      const latest = await api.messages(conversationId, 1, pageSize);
      setMessages(latest.items);
      setMessagePage(latest.page);
      scrollAfterRender.current = stickToEnd;
    } catch (nextError) {
      // Esta falha é *desta* conversa e vai para o painel dela, não para o alerta
      // do topo da lista — que fica na outra coluna e sobrevive à troca de
      // conversa, deixando um erro velho pendurado sobre uma conversa que abriu
      // bem. A conversa fica registrada junto para o aviso não vazar para a
      // próxima que o operador abrir.
      if (activeConversationId.current === conversationId)
        setMessagesError(messageLoadFailure(nextError, syncingRef.current));
    } finally {
      setLoadingMessages(false);
    }
  };
  const [reactionFailures, setReactionFailures] = useState<ReadonlySet<string>>(new Set());
  const applyReactions = (messageId: string, reactions: MessageReaction[]) =>
    setMessages((list) => list.map((item) => (item.id === messageId ? { ...item, reactions } : item)));
  /** Reação do operador com UI otimista: aplica o toggle local (mesmo emoji da
   *  conta = remoção; outro emoji substitui), reconcilia com a resposta do
   *  servidor e desfaz marcando a mensagem com ⚠ se o envio falhar. */
  const reactToMessage = async (message: InboxMessage, emoji: string) => {
    const conversation = selectedRef.current;
    if (!conversation) return;
    const previous = message.reactions ?? [];
    const mine = previous.find((reaction) => reaction.fromMe);
    const optimistic: MessageReaction[] = mine?.emoji === emoji
      ? previous.filter((reaction) => !reaction.fromMe)
      : [...previous.filter((reaction) => !reaction.fromMe), { emoji, reactorWhatsappId: null, fromMe: true, reactorName: null, reactorPhone: null, reactedAt: new Date().toISOString() }];
    applyReactions(message.id, optimistic);
    setReactionFailures((failures) => { const next = new Set(failures); next.delete(message.id); return next; });
    try {
      const result = await api.react(conversation.id, message.id, emoji);
      if (Array.isArray(result.reactions)) applyReactions(result.messageId, result.reactions);
    } catch {
      applyReactions(message.id, previous);
      setReactionFailures((failures) => new Set(failures).add(message.id));
    }
  };
  const loadContext = async (conversationId: string) => {
    if (!api.context) return;
    const request = ++contextRequest.current;
    try {
      const result = await api.context(conversationId);
      if (
        activeConversationId.current !== conversationId ||
        request !== contextRequest.current
      )
        return;
      setContext(result);
      const draft = noteDrafts.current.get(conversationId);
      setNotes(draft ?? result.notes ?? "");
      setNoteSaveState(draft === undefined ? "saved" : "editing");
    } catch (nextError) {
      if (
        activeConversationId.current === conversationId &&
        request === contextRequest.current
      )
        setError(errorMessage(nextError));
    }
  };
  const loadActivity = async (conversationId: string) => {
    if (!api.activity) return;
    try {
      const result = await api.activity(conversationId);
      if (activeConversationId.current === conversationId) setActivity(result);
    } catch (nextError) {
      if (activeConversationId.current === conversationId) setError(errorMessage(nextError));
    }
  };
  useEffect(() => {
    void refreshConversations();
  }, [api]);
  const refreshDirectory = async () => { try { const [users, nextTeams] = await Promise.all([workspaceApi.users(), workspaceApi.teams()]); setWorkspaceUsers(users); setTeams(nextTeams); } catch (nextError) { setError(errorMessage(nextError)); } };
  /** Instâncias para o funil da lista. Separado do refreshDirectory de propósito:
   *  se /api/v1/sessions falhar, usuários e equipes continuam carregando. */
  const refreshSessions = async () => { try { setSessions(await sessionsApi.list()); } catch { setSessions([]); } };
  useEffect(() => { void refreshDirectory(); void refreshSessions(); }, []);
  useEffect(() => {
    const session = syncJob?.wahaSession ?? conversationPage.items[0]?.whatsappSessionId;
    if (!session || !api.syncStatus) return;
    let disposed = false;
    const load = () => void api.syncStatus!(session).then((job) => { if (!disposed) setSyncJob(job); }).catch(() => { if (!disposed) setSyncJob(undefined); });
    load();
    const polling = isActiveSync(syncJob?.status);
    syncingRef.current = polling;
    const timer = polling ? window.setInterval(load, 2_000) : undefined;
    return () => { disposed = true; if (timer) window.clearInterval(timer); };
  }, [conversationPage.items, api, syncJob?.status, syncJob?.wahaSession]);
  // Quem retomou o job só se descobre olhando a transição: de parado para ativo
  // com um clique daqui é do operador; sem clique, foi o servidor sozinho.
  useEffect(() => {
    const next = syncJob?.status;
    // O status anterior e o pedido são lidos AGORA, não dentro do atualizador: o
    // atualizador funcional do React só corre na renderização seguinte, e a essa
    // altura as duas referências já teriam sido sobrescritas aqui embaixo — a
    // transição pareceria "mesmo status" e nunca creditaria ninguém.
    const previous = previousSyncStatus.current;
    const asked = operatorAskedSync.current;
    previousSyncStatus.current = next;
    // O pedido vale por uma transição: consumido, o próximo reinício sem clique
    // volta a contar como automático.
    if (isActiveSync(next)) operatorAskedSync.current = false;
    setSyncResume((current) => resumeAttribution(previous, next, asked, current));
  }, [syncJob?.status]);
  useEffect(() => {
    document
      .querySelectorAll<HTMLButtonElement>(".chat-inbox .conversation-item")
      .forEach((button, index) =>
        button.setAttribute(
          "aria-label",
          `Abrir conversa ${conversationPage.items[index]?.chatId ?? ""}`,
        ),
      );
  }, [conversationPage.items]);
  useEffect(() => {
    if (scrollAfterRender.current) {
      scrollAfterRender.current = false;
      requestAnimationFrame(() => {
        if (listRef.current)
          listRef.current.scrollTop = listRef.current.scrollHeight;
      });
    }
  }, [messages]);
  useEffect(() => {
    if (selected)
      setSelected(
        conversationPage.items.find((item) => item.id === selected.id) ??
          selected,
      );
  }, [conversationPage]);
  /** Participantes do grupo, 1× por conversa (cache em ref): autocomplete,
   *  resolver de `@Nome` no corpo e painel de membros leem daqui. Falha não
   *  cacheia — o próximo `@` tenta de novo. */
  const loadParticipants = async (conversationId: string) => {
    if (participantsCache.current.has(conversationId)) return;
    setParticipantsState({ loading: true, failed: false });
    try {
      const result = await api.participants(conversationId);
      participantsCache.current.set(conversationId, result.items);
      setParticipantsState({ loading: false, failed: false });
    } catch {
      setParticipantsState({ loading: false, failed: true });
    }
  };
  /** Itens do popup: filtro local (nome/número/dígitos, sem acento) sobre o
   *  cache da conversa. A ordem é a do backend: recência → alfabética. */
  const mentionItems = mention && selected ? filterParticipants(participantsCache.current.get(selected.id) ?? [], mention.query) : [];
  /** Troca o `@query` pelo `@Nome `, registra o JID para a serialização do
   *  submit (que converte para `@dígitos`, formato que a WAHA exige) e devolve
   *  o cursor para depois do espaço. */
  const selectMention = (participant: GroupParticipant) => {
    if (!mention) return;
    const textarea = composerRef.current;
    const current = textarea?.value ?? composerText;
    const caret = textarea?.selectionStart ?? current.length;
    const display = participantDisplay(participant);
    const inserted = insertMention(current, caret, mention.start, display);
    setComposerText(inserted.text);
    mentionsRef.current = [...mentionsRef.current.filter((entry) => entry.jid !== participant.whatsappId), { display, jid: participant.whatsappId }];
    setMention(null);
    setMentionActive(0);
    requestAnimationFrame(() => {
      const target = composerRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(inserted.caret, inserted.caret);
    });
  };
  /** Teclado do composer: com o popup aberto, ↑/↓ navegam, Enter/Tab
   *  selecionam e Esc fecha (stopPropagation para não disparar atalhos da
   *  tela). Fechado, nada muda — Enter segue quebrando linha. */
  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!mention) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (mentionItems.length > 0) {
        setMentionActive((current) => (event.key === "ArrowDown" ? (current + 1) % mentionItems.length : (current - 1 + mentionItems.length) % mentionItems.length));
      }
    } else if (event.key === "Enter" || event.key === "Tab") {
      const participant = mentionItems[mentionActive] ?? mentionItems[0];
      if (participant) {
        event.preventDefault();
        selectMention(participant);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMention(null);
    }
  };
  useEffect(() => {
    activeConversationId.current = selected?.id;
    selectedRef.current = selected;
    contextRequest.current += 1;
    setContext(undefined);
    setActivity([]);
    setSlaMetrics(undefined);
    setLoadingSla(Boolean(selected));
    const draft = selected ? noteDrafts.current.get(selected.id) : undefined;
    setNotes(draft ?? "");
    setNoteSaveState(draft === undefined ? "saved" : "editing");
    setTag("");
    if (selected) { void loadContext(selected.id); void loadActivity(selected.id); void loadSla(selected.id); }
    // Grupo: os participantes alimentam o autocomplete de menções, o destaque
    // de `@Nome` no corpo e o painel de membros — 1 fetch por conversa.
    if (selected && isGroup(selected)) void loadParticipants(selected.id);
  }, [selected?.id, api]);
  useEffect(
    () =>
      connectRealtime((event) => {
        if (event.workspaceId !== workspaceId) return;
        if (event.eventType === "call.updated") {
          // Chamada recebida ou mudança de estado da ativa. O nome sai da
          // lista já carregada: o telefone do peer casa com o da conversa.
          calls.handleCallEvent(event.payload as unknown as ActiveCall, (peerDigits) => {
            const match = conversationsRef.current.find((item) => {
              const phone = conversationPhone(item);
              return Boolean(phone && peerDigits && (phone === peerDigits || phone.endsWith(peerDigits) || peerDigits.endsWith(phone)));
            });
            return match ? contactName(match) : undefined;
          });
          return;
        }
        if (event.eventType === "conversation.sla.updated") {
          const conversationId = typeof event.payload.conversationId === "string" ? event.payload.conversationId : "";
          const metrics = event.payload.metrics as SlaMetrics | undefined;
          if (conversationId && metrics?.conversationId === conversationId) {
            slaCache.current.set(conversationId, metrics);
            if (selectedRef.current?.id === conversationId) { setSlaMetrics(metrics); setLoadingSla(false); }
          }
          return;
        }
        if (event.eventType === "conversation.context.updated") {
          const current = selectedRef.current;
          if (current && String(event.payload.conversationId) === current.id)
            void loadContext(current.id);
          return;
        }
        if (event.eventType === "conversation.management.updated") {
          const conversation = event.payload.conversation as InboxConversation | undefined;
          if (conversation?.id) {
            setConversationPage((current) => ({ ...current, items: current.items.map((item) => item.id === conversation.id ? conversation : item) }));
            if (selectedRef.current?.id === conversation.id) { setSelected(conversation); void loadActivity(conversation.id); }
          }
          return;
        }
        if (["workspace.user.created", "workspace.user.updated", "workspace.team.created", "workspace.team.updated", "workspace.team.members.updated"].includes(event.eventType)) { void refreshDirectory(); return; }
        if (event.eventType === "conversation.sync.updated") {
          /** O sync de contatos divide o mesmo tipo de evento. Sem esta saída
           *  ele pisaria no banner do history sync (que lê chatsProcessed e
           *  messagesProcessed) e dispararia refreshConversations a cada
           *  página de contatos. O picker acompanha o próprio job por polling. */
          if (event.payload.syncKind === "contacts") return;
          const wahaSession = String(event.payload.wahaSession ?? "");
          setSyncJob((current) =>
            current && current.wahaSession === wahaSession
              ? {
                  ...current,
                  jobId: String(event.payload.jobId ?? current.jobId),
                  status: String(
                    event.payload.status,
                  ) as HistorySyncJob["status"],
                  chatsProcessed: Number(
                    event.payload.chatsProcessed ?? current.chatsProcessed,
                  ),
                  messagesProcessed: Number(
                    event.payload.messagesProcessed ??
                      current.messagesProcessed,
                  ),
                  chatsTotal: typeof event.payload.chatsTotal === "number" ? event.payload.chatsTotal : current.chatsTotal,
                  currentChat: typeof event.payload.currentChat === "string" ? event.payload.currentChat : null,
                  hasMore: Boolean(event.payload.hasMore ?? current.hasMore),
                  progressLabel: String(event.payload.progressLabel ?? current.progressLabel),
                  lastErrorSafe: typeof event.payload.lastErrorSafe === "string" ? event.payload.lastErrorSafe : null,
                  updatedAt: String(event.payload.updatedAt ?? current.updatedAt),
                }
              : current,
          );
          void refreshConversations();
          return;
        }
        if (event.eventType === "message.reaction.updated") {
          // Atualização em place: a reação não muda a lista de conversas nem
          // cria mensagem, então não há reload — só a mensagem visível troca.
          const messageId = typeof event.payload.messageId === "string" ? event.payload.messageId : "";
          if (messageId && Array.isArray(event.payload.reactions))
            applyReactions(messageId, event.payload.reactions as MessageReaction[]);
          return;
        }
        if (event.eventType === "conversation.updated" && event.payload.identitySynchronized === true) {
          // Identidade sincronizada em segundo plano: se foi o grupo aberto ou
          // um participante dele, o painel de membros e o autocomplete ganham
          // nomes novos — o cache é derrubado e a lista relida. Sem return: o
          // refresh genérico de conversas logo abaixo continua valendo.
          const current = selectedRef.current;
          const chatId = typeof event.payload.chatId === "string" ? event.payload.chatId : "";
          const cached = current && isGroup(current) ? participantsCache.current.get(current.id) : undefined;
          if (current && cached && (chatId === current.chatId || cached.some((entry) => entry.whatsappId === chatId))) {
            participantsCache.current.delete(current.id);
            void loadParticipants(current.id);
          }
        }
        if (
          ![
            "message.received",
            "message.sent",
            "conversation.updated",
          ].includes(event.eventType)
        )
          return;
        void refreshConversations();
        if (selectedRef.current && atBottomRef.current) void loadLatest(selectedRef.current.id, true);
      }, () => {
        // O socket caiu e voltou: eventos se perderam no intervalo, então a
        // lista e a conversa aberta são relidas em vez de confiar no delta.
        void refreshConversations();
        if (selectedRef.current) void loadLatest(selectedRef.current.id, true);
      }),
    [api],
  );
  const openConversation = async (conversation: InboxConversation, syncUrl = true) => {
    if (syncUrl) {
      history.pushState({ conversationId: conversation.id }, "", inboxUrlForConversation(conversation.id));
      setRequestedConversationId(conversation.id);
    }
    activeConversationId.current = conversation.id;
    contextRequest.current += 1;
    setContext(undefined);
    const draft = noteDrafts.current.get(conversation.id);
    setNotes(draft ?? "");
    setNoteSaveState(draft === undefined ? "saved" : "editing");
    setTag("");
    // Trocar de conversa fecha o formulário de contato meio preenchido, e isso
    // acontece *aqui*, na mesma atualização que troca `selected` — não num
    // efeito com dependência `[selected?.id]`.
    //
    // O efeito parecia equivalente e não era: ele corre depois da pintura, e a
    // primeira conversa a abrir faz a dependência ir de `undefined` para um id.
    // Nessa transição não há nada a limpar, mas o `setCreatingContact(false)`
    // chegava depois de o painel já estar na tela — tempo suficiente para o
    // operador clicar em "Criar contato" e ver o formulário fechar sozinho.
    setCreatingContact(false);
    setContactError("");
    setSelected(conversation);
    setMessages([]);
    setMessagePage(1);
    setError("");
    atBottomRef.current = true;
    await Promise.all([
      loadLatest(conversation.id, true),
      conversation.unreadCount
        ? api
            .markRead(conversation.id)
            .then(refreshConversations)
            .catch((nextError) => setError(errorMessage(nextError)))
        : Promise.resolve(),
    ]);
  };
  /** Abrir a conversa de um card **sem sair do quadro**: `openConversation` com
   *  `syncUrl: false` é o mesmo caminho do deep link, menos o `pushState` — a
   *  rota continua sendo a do Kanban, e fechar a janela não precisa desfazer
   *  histórico nenhum.
   *
   *  A conversa vem da página já carregada quando estiver lá, e por `id` quando
   *  não estiver. Nunca por varredura de páginas: o card do Kanban pode ser de
   *  uma conversa que a primeira página da lista não alcança. */
  const openFromCard = async (conversationId: string) => {
    cardOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setCardConversationError("");
    setCardConversationOpen(true);
    if (selected?.id === conversationId) return;
    setSelected(undefined);
    try {
      const conversation = conversationPage.items.find(item => item.id === conversationId) ?? await api.conversation(conversationId);
      if (!mounted.current) return;
      await openConversation(conversation, false);
    } catch (failure) {
      if (!mounted.current) return;
      const status = failure instanceof ApiError ? Number(failure.details.status) : 0;
      setCardConversationError(status === 404 ? "A conversa não está disponível." : "Não foi possível abrir esta conversa. Tente novamente.");
    }
  };
  const closeCardConversation = useCallback(() => { setCardConversationOpen(false); setCardConversationError(""); cardOpenerRef.current?.focus(); cardOpenerRef.current = undefined; }, []);
  // `Esc` fecha, e o foco entra na janela ao abrir e volta para o card ao
  // fechar. Sem isso, quem navega por teclado abriria a conversa e continuaria
  // com o foco perdido no quadro atrás dela.
  useEffect(() => {
    if (!cardConversationOpen) return;
    cardWindowRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); closeCardConversation(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cardConversationOpen, closeCardConversation]);
  useEffect(() => {
    // A janela do Kanban manda enquanto está aberta. Sem esta guarda, abrir um
    // card depois de ter vindo da Inbox com uma conversa na URL faria o deep
    // link reabrir a conversa da URL por cima da que o operador clicou — o
    // `setSelected(undefined)` de `openFromCard` é exatamente o gatilho.
    if (cardConversationOpen) return;
    if (loadingConversations || !requestedConversationId || selected?.id === requestedConversationId) return;
    const loaded = conversationPage.items.find((item) => item.id === requestedConversationId);
    if (loaded) { void openConversation(loaded, false); return; }
    deepLinkAbort.current?.abort();
    const controller = new AbortController();
    deepLinkAbort.current = controller;
    const request = ++deepLinkRequest.current;
    setResolvingConversationId(requestedConversationId);
    setDeepLinkError("");
    void api.conversation(requestedConversationId, controller.signal)
      .then((conversation) => {
        if (!mounted.current || request !== deepLinkRequest.current || requestedConversationId !== conversationIdFromLocation()) return;
        void openConversation(conversation, false);
      })
      .catch((nextError) => {
        if (!mounted.current || controller.signal.aborted || request !== deepLinkRequest.current) return;
        const status = nextError instanceof ApiError ? Number(nextError.details.status) : 0;
        setDeepLinkError(status === 404 ? "A conversa não está disponível." : "Não foi possível abrir esta conversa. Tente novamente.");
      })
      .finally(() => {
        if (mounted.current && request === deepLinkRequest.current) setResolvingConversationId(undefined);
      });
    return () => controller.abort();
  }, [api, cardConversationOpen, conversationPage.items, deepLinkAttempt, loadingConversations, requestedConversationId, selected?.id]);
  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || sending) return;
    const form = event.currentTarget;
    const text = String(new FormData(form).get("text") ?? "").trim();
    if (!text && !attachment) return;
    setSending(true);
    try {
      if (attachment) {
        setAttachmentStatus("Preparando anexo…");
        setUploadProgress(0);
        const clientRequestId = crypto.randomUUID();
        const job = await api.sendAttachment(selected.id, attachment, clientRequestId, text, undefined, (pct) => { if (mounted.current) setUploadProgress(pct); });
        setUploadProgress(undefined);
        setAttachmentStatus(
          job.status === "failed"
            ? "Falhou"
            : "Anexo em processamento; aguardando confirmação",
        );
        applyAttachment(undefined);
      } else {
        // Serialização: cada `@Nome` rastreado vira `@dígitos` no texto e o JID
        // entra em `mentions` — é o par que a WAHA usa para notificar de verdade.
        // Sem menção, a chamada segue de 2 argumentos, como sempre foi.
        // `linkPreview: false` só viaja quando o operador dispensou o cartão do
        // compositor — argumento a mais (nem `undefined`) quebraria os espiões
        // dos testes que conferem a aridade exata da chamada.
        const serialized = serializeMentions(text, mentionsRef.current);
        const withoutPreview = composerFirstUrl !== undefined && composerFirstUrl === dismissedPreviewUrl;
        if (serialized.mentions.length > 0 && withoutPreview) await api.sendMessage(selected.id, serialized.text, serialized.mentions, false);
        else if (serialized.mentions.length > 0) await api.sendMessage(selected.id, serialized.text, serialized.mentions);
        else if (withoutPreview) await api.sendMessage(selected.id, serialized.text, undefined, false);
        else await api.sendMessage(selected.id, serialized.text);
      }
      form.reset();
      setComposerText("");
      setDismissedPreviewUrl(null);
      setComposerPreview(undefined);
      mentionsRef.current = [];
      setMention(null);
      await Promise.all([
        loadLatest(selected.id, true),
        refreshConversations(),
      ]);
    } catch (nextError) {
      setUploadProgress(undefined);
      setAttachmentStatus("Falhou");
      setError(errorMessage(nextError));
    } finally {
      setSending(false);
    }
  };
  const clearAttachment = () => {
    applyAttachment(undefined);
    setAttachmentStatus("");
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  };
  const copyPhone = async () => {
    if (!selected || isGroup(selected)) return;
    const phone = conversationPhone(selected);
    if (!phone) { setError("O contato não possui um telefone identificável."); return; }
    try {
      if (!navigator.clipboard) throw new Error("Clipboard indisponível");
      await navigator.clipboard.writeText(phone);
      setCopiedPhone(true);
      window.setTimeout(() => setCopiedPhone(false), 1800);
    } catch {
      setError("Não foi possível copiar o número.");
    }
  };
  const finishRecording = (discard = false) => {
    discardRecordingRef.current = discard;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };
  /** Liga o medidor de sinal ao stream. É a defesa contra a causa 3 — dispositivo
   *  certo, permissão dada, e nenhum som chegando —, que é a única das três que
   *  não falha em lugar nenhum: o MediaRecorder grava silêncio com o mesmo
   *  tamanho e o mesmo formato de uma nota de voz de verdade.
   *
   *  Degrada em silêncio onde não há `AudioContext` (jsdom, navegador antigo): o
   *  medidor é diagnóstico, e derrubar a gravação por falta dele seria trocar um
   *  problema raro por um certo. */
  const startMeter = (stream: MediaStream) => {
    const Context = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    try {
      const context = new Context();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const levels: number[] = [];
      let lastSecond = -1;
      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        const level = signalLevel(samples);
        setMicLevel(level);
        // Uma amostra por segundo alimenta a decisão: `isSilent` conta segundos,
        // e empilhar 60 leituras por segundo mediria o quadro, não o tempo.
        const second = Math.floor(context.currentTime);
        if (second !== lastSecond) { lastSecond = second; levels.push(level); setMicSilent(isSilent(levels)); }
        micMeterRef.current = { context, raf: requestAnimationFrame(tick) };
      };
      micMeterRef.current = { context, raf: requestAnimationFrame(tick) };
    } catch { /* medidor é diagnóstico, não requisito */ }
  };
  const stopMeter = () => {
    const meter = micMeterRef.current;
    micMeterRef.current = undefined;
    if (!meter) return;
    cancelAnimationFrame(meter.raf);
    void meter.context.close().catch(() => undefined);
    setMicLevel(0);
    setMicSilent(false);
  };

  /** Abre o portão quando ainda dá para explicar, e grava direto quando não há o
   *  que explicar. Só `granted` dispensa o diálogo: em `prompt` ele existe para o
   *  balão do navegador não aparecer sozinho, e em `denied` para dizer como
   *  reverter — que é a informação que falta em "permissão negada". */
  const startRecording = async () => {
    if (sending || isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("A gravação de áudio não é suportada neste navegador.");
      return;
    }
    // Quem já passou pelo portão nesta sessão grava direto; quem não passou vê o
    // portão, INDEPENDENTE do que o navegador responda. É a correção do defeito:
    // a escolha do operador manda sobre o estado da permissão, porque as duas
    // perguntas são diferentes e só uma delas é sobre querer.
    if (micConsent) { await captureMicrophone(); return; }
    const state = await microphoneState();
    if (state === "denied") { setMicGate({ state: "denied", asking: false }); return; }
    // `granted` sem consentimento é o caso de quem já autorizou o navegador
    // antes: o portão ainda aparece, mas para escolher o microfone, não para
    // pedir o que já foi dado.
    setMicGate({ state: state === "granted" ? "choose" : "prompt", asking: false });
  };

  /** Pede ao navegador e começa a gravar. Chamada direto quando a permissão já
   *  existe, e pelo botão do portão quando não. */
  const captureMicrophone = async () => {
    try {
      setMicGate((gate) => (gate ? { ...gate, asking: true, error: undefined } : gate));
      const stream = await navigator.mediaDevices.getUserMedia(
        micDeviceId ? { audio: { deviceId: { exact: micDeviceId } } } : { audio: true });
      // Os rótulos só existem depois de permitir: é aqui que a lista fica útil.
      const devices = await audioInputs();
      setMicDevices(devices);
      // Com mais de um microfone, escolher é parte da decisão — e é a causa 2.
      // O portão fica aberto mostrando a lista em vez de gravar do dispositivo
      // que o navegador escolheu sozinho.
      if (devices.length > 1 && !micDeviceId) {
        stream.getTracks().forEach((track) => track.stop());
        // O primeiro fica pré-selecionado no seletor, mas isso NÃO é
        // consentimento: `micConsent` só é marcado quando a gravação começa de
        // fato, e é ele que a entrada consulta. Gravar do dispositivo que o
        // navegador calhou de devolver, sem o operador confirmar, era a causa 2
        // de volta — e foi assim que o defeito da #137 apareceu.
        setMicDeviceId(devices[0]?.deviceId);
        setMicGate({ state: "choose", asking: false });
        return;
      }
      setMicGate(undefined);
      setMicConsent(true);
      beginRecording(stream);
    } catch (nextError) {
      const message = microphoneErrorMessage(nextError);
      const name = nextError instanceof Error ? nextError.name : "";
      const denied = name === "NotAllowedError" || name === "SecurityError";
      setMicGate({ state: denied ? "denied" : "prompt", asking: false, error: message });
    }
  };

  const beginRecording = (stream: MediaStream) => {
    try {
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      discardRecordingRef.current = false;
      recordingStreamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = undefined;
        recorderRef.current = undefined;
        setIsRecording(false);
        stopMeter();
        if (discardRecordingRef.current) return;
        // Sem nenhum bloco, o `onstop` antigo simplesmente não fazia nada: a
        // barra sumia e o operador ficava sem áudio e sem explicação.
        if (!chunks.length) { setError("A gravação não capturou nenhum áudio. Verifique o microfone e tente de novo."); return; }
        const type = recorder.mimeType || "audio/webm";
        const extension = type.includes("ogg") ? "ogg" : "webm";
        applyAttachment(new File([new Blob(chunks, { type })], `audio-${Date.now()}.${extension}`, { type }));
        setAttachmentStatus("Áudio pronto para envio");
      };
      setRecordingSeconds(0);
      setIsRecording(true);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
      recorder.start();
      startMeter(stream);
    } catch (nextError) {
      stream.getTracks().forEach((track) => track.stop());
      setError(microphoneErrorMessage(nextError));
    }
  };
  const stopCamera = () => {
    if (cameraTimerRef.current) clearInterval(cameraTimerRef.current);
    cameraTimerRef.current = undefined;
    if (cameraRecorderRef.current?.state === "recording") cameraRecorderRef.current.stop();
    cameraRecorderRef.current = undefined;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = undefined;
    setCameraRecording(false);
    setCameraSeconds(0);
  };
  const closeCamera = () => { stopCamera(); setCameraOpen(false); setCameraError(""); };
  const openCamera = async () => {
    if (sending || isRecording) return;
    setAttachmentMenuOpen(false);
    // Sem `mediaDevices` não há preview possível: é navegador antigo ou origem
    // insegura (HTTPS ou localhost são exigidos). Aí o input com `capture` ainda
    // resolve no celular, então caímos nele em vez de só recusar.
    if (!navigator.mediaDevices?.getUserMedia) {
      setAttachmentAccept(CAMERA_ACCEPT);
      setAttachmentCapture("environment");
      setAttachmentStatus("Câmera indisponível neste navegador (exige HTTPS ou localhost). Abrindo o seletor de arquivos.");
      requestAnimationFrame(() => attachmentInputRef.current?.click());
      return;
    }
    setCameraOpen(true);
    setCameraError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: true });
      cameraStreamRef.current = stream;
      if (cameraVideoRef.current) { cameraVideoRef.current.srcObject = stream; void cameraVideoRef.current.play().catch(() => undefined); }
    } catch (nextError) {
      setCameraError(cameraErrorMessage(nextError));
    }
  };
  const takePhoto = () => {
    const video = cameraVideoRef.current;
    if (!video || !video.videoWidth) { setCameraError("A câmera ainda não está pronta. Aguarde a imagem aparecer."); return; }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) { setCameraError("Não foi possível capturar a imagem neste navegador."); return; }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // JPEG porque é o que o servidor aceita para imagem, e é o que a checagem de
    // magic bytes espera (ff d8 ff).
    canvas.toBlob((blob) => {
      if (!blob) { setCameraError("Não foi possível capturar a imagem."); return; }
      if (blob.size > ATTACHMENT_LIMITS.image) { setCameraError(`A foto tem ${fileSizeLabel(blob.size)} e o limite é ${fileSizeLabel(ATTACHMENT_LIMITS.image)}.`); return; }
      applyAttachment(new File([blob], `foto-${Date.now()}.jpg`, { type: "image/jpeg" }));
      setAttachmentStatus("Foto pronta para envio");
      closeCamera();
    }, "image/jpeg", 0.92);
  };
  const stopCameraRecording = (discard = false) => {
    const recorder = cameraRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    discardCameraRef.current = discard;
    recorder.stop();
  };
  const startCameraRecording = () => {
    const stream = cameraStreamRef.current;
    if (!stream || cameraRecording) return;
    if (typeof MediaRecorder === "undefined") { setCameraError("Este navegador não grava vídeo."); return; }
    // webm é o que o MediaRecorder produz e está na allowlist do servidor; mp4
    // sairia da allowlist em boa parte dos navegadores.
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try { recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
    catch { setCameraError("Este navegador não grava vídeo no formato aceito."); return; }
    const chunks: BlobPart[] = [];
    let recorded = 0;
    let overLimit = false;
    discardCameraRef.current = false;
    cameraRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      recorded += event.data.size;
      // Vídeo de câmera cresce rápido: parar no limite evita gravar minutos que o
      // servidor recusaria com 413 no envio.
      if (recorded > ATTACHMENT_LIMITS.video && recorder.state === "recording") {
        overLimit = true;
        setCameraError(`Gravação encerrada: o vídeo passou do limite de ${fileSizeLabel(ATTACHMENT_LIMITS.video)}. Grave um trecho mais curto.`);
        recorder.stop();
      }
    };
    recorder.onstop = () => {
      if (cameraTimerRef.current) clearInterval(cameraTimerRef.current);
      cameraTimerRef.current = undefined;
      cameraRecorderRef.current = undefined;
      setCameraRecording(false);
      // A mensagem do limite já explica o que houve; não sobrescrever com outra.
      if (discardCameraRef.current || overLimit || !chunks.length) return;
      const type = recorder.mimeType?.split(";", 1)[0] || "video/webm";
      const blob = new Blob(chunks, { type });
      if (blob.size > ATTACHMENT_LIMITS.video) { setCameraError(`O vídeo tem ${fileSizeLabel(blob.size)} e o limite é ${fileSizeLabel(ATTACHMENT_LIMITS.video)}.`); return; }
      applyAttachment(new File([blob], `video-${Date.now()}.webm`, { type }));
      setAttachmentStatus("Vídeo pronto para envio");
      closeCamera();
    };
    setCameraError("");
    setCameraSeconds(0);
    setCameraRecording(true);
    cameraTimerRef.current = setInterval(() => setCameraSeconds((seconds) => seconds + 1), 1000);
    recorder.start(1000);
  };
  const onScroll = () => {
    const list = listRef.current;
    if (list)
      atBottomRef.current =
        list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  };
  /** A abertura do picker: só os contatos salvos no CELULAR (origem
   *  `phonebook`, filtrada no servidor), paginando de 150 em 150 por dentro
   *  — são centenas por definição, não a base inteira de dezenas de
   *  milhares. O resto chega pela lupa, que pesquisa no servidor em lotes.
   *  Estável por `useCallback` porque a tela de contato os recebe como prop. */
  const loadPhonebookContacts = useCallback(async () => {
    const all = [];
    for (let page = 1; ; page += 1) {
      const result = await domain.contacts({ origin: "phonebook", page, pageSize: 150 });
      all.push(...result.items);
      if (!result.items.length || all.length >= result.total) return all;
    }
  }, [domain]);
  const searchContacts = useCallback(async (term: string, page: number) => {
    const result = await domain.contacts({ search: term, page, pageSize: 150 });
    return { items: result.items, total: result.total };
  }, [domain]);
  /** Memorizado porque o efeito de polling do picker depende da identidade
   *  deste objeto: recriado a cada render, o intervalo de 2 s seria desmontado
   *  e remontado sem necessidade. O start vai sem sessão — o servidor resolve a
   *  sessão conectada e devolve o `wahaSession` que alimenta o polling. */
  const contactSync = useMemo(
    () => ({ start: () => domain.startContactSync(), status: (wahaSession: string) => domain.contactSyncStatus(wahaSession) }),
    [domain],
  );
  const openContactPicker = () => { setAttachmentMenuOpen(false); setContactPickerOpen(true); };
  const sendContactCards = async (contactIds: string[]) => {
    const conversationId = selected?.id;
    if (!conversationId || !api.sendVcard || !contactIds.length) return;
    setContactPickerOpen(false);
    setAttachmentStatus(contactIds.length > 1 ? "Enviando contatos…" : "Enviando contato…");
    try {
      await api.sendVcard(conversationId, contactIds);
      setAttachmentStatus("");
    } catch (nextError) { setAttachmentStatus(errorMessage(nextError)); }
  };
  const deliverLocation = async (latitude: number, longitude: number, title?: string) => {
    const conversationId = selected?.id;
    if (!conversationId || !api.sendLocation) return;
    setAttachmentStatus("Enviando localização…");
    try {
      await api.sendLocation(conversationId, { latitude, longitude, ...(title ? { title } : {}) });
      setAttachmentStatus("");
    } catch (nextError) { setAttachmentStatus(errorMessage(nextError)); }
  };
  const openLocation = () => { setAttachmentMenuOpen(false); setLocationOpen(true); setLocationError(""); setLocationPoint(undefined); setLocationCoords(""); setLocationTitle(""); };
  const closeLocation = () => { setLocationOpen(false); setLocationError(""); setLocatingNow(false); };
  const useCurrentLocation = () => {
    if (!navigator.geolocation) { setLocationError("Este navegador não expõe localização. Informe o ponto abaixo."); return; }
    setLocationError("");
    setLocatingNow(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocatingNow(false);
        setLocationPoint({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        setLocationCoords(`${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`);
      },
      (failure) => { setLocatingNow(false); setLocationError(geolocationErrorMessage(failure)); },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  };
  const confirmLocation = async () => {
    const point = parseCoordinates(locationCoords);
    if (!point) { setLocationError("Coordenadas inválidas. Use latitude, longitude — por exemplo -7.115, -34.861."); return; }
    setLocationError("");
    setLocationOpen(false);
    await deliverLocation(point.latitude, point.longitude, locationTitle.trim() || undefined);
  };
  const startSync = async () => {
    const session = conversationPage.items[0]?.whatsappSessionId;
    if (!api.startSync) return;
    // Marcado antes da chamada: o job pode voltar já ativo, e a atribuição é lida
    // na transição de status que vem logo atrás.
    operatorAskedSync.current = true;
    setStartingSync(true);
    try {
      setSyncJob(await api.startSync(session));
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setStartingSync(false);
    }
  };
  const cancelSync = async () => {
    const session = syncJob?.wahaSession ?? conversationPage.items[0]?.whatsappSessionId;
    if (!session || !api.cancelSync) return;
    try {
      setSyncJob(await api.cancelSync(session));
    } catch (nextError) {
      setError(errorMessage(nextError));
    }
  };
  const saveNotes = async () => {
    const conversationId = selected?.id;
    if (!conversationId || !api.updateContext || noteSaveState === "saving") return;
    const savedNotes = notes;
    setNoteSaveState("saving");
    try {
      const result = await api.updateContext(conversationId, { notes: savedNotes });
      if (activeConversationId.current !== conversationId) return;
      setContext(result);
      if (noteDrafts.current.get(conversationId) === savedNotes) {
        noteDrafts.current.delete(conversationId);
        setNoteSaveState("saved");
      } else {
        setNoteSaveState("editing");
      }
    } catch (nextError) {
      if (activeConversationId.current === conversationId) {
        setNoteSaveState("error");
        setError(errorMessage(nextError));
      }
    }
  };
  const addTag = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const conversationId = selected?.id;
    const next = tag.trim();
    if (!conversationId || !next || !api.updateContext) return;
    const tags = [...(context?.tags ?? []), next];
    setSavingContext(true);
    try {
      const result = await api.updateContext(conversationId, { tags });
      if (activeConversationId.current === conversationId) {
        setContext(result);
        setTag("");
      }
    } catch (nextError) {
      if (activeConversationId.current === conversationId)
        setError(errorMessage(nextError));
    } finally {
      if (activeConversationId.current === conversationId)
        setSavingContext(false);
    }
  };
  const removeTag = async (value: string) => {
    const conversationId = selected?.id;
    if (!conversationId || !api.updateContext) return;
    const tags = (context?.tags ?? []).filter((item) => item !== value);
    setSavingContext(true);
    try {
      const result = await api.updateContext(conversationId, { tags });
      if (activeConversationId.current === conversationId) setContext(result);
    } catch (nextError) {
      if (activeConversationId.current === conversationId)
        setError(errorMessage(nextError));
    } finally {
      if (activeConversationId.current === conversationId)
        setSavingContext(false);
    }
  };
  const grouped = messages.map((item, index) => ({
    item,
    date:
      index === 0 ||
      dateLabel(messages[index - 1].timestamp) !== dateLabel(item.timestamp),
  }));
  const conversationMatches = conversationSearchTerm
    ? messages.filter((item) => item.content?.toLocaleLowerCase("pt-BR").includes(conversationSearchTerm)).slice(0, 100)
    : [];
  const activeMatchId = conversationMatches[activeConversationMatch]?.id;
  const selectConversationMatch = (index: number) => {
    if (!conversationMatches.length) return;
    const next = (index + conversationMatches.length) % conversationMatches.length;
    setActiveConversationMatch(next);
    document.getElementById(`conversation-search-result-${conversationMatches[next].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const applyManagement = async (operation: () => Promise<{ conversation: InboxConversation }>) => {
    if (!selected || changingManagement) return;
    setChangingManagement(true);
    try {
      const result = await operation();
      setSelected(result.conversation);
      setConversationPage((current) => ({ ...current, items: current.items.map((item) => item.id === result.conversation.id ? result.conversation : item) }));
      await loadActivity(result.conversation.id);
    } catch (nextError) { setError(errorMessage(nextError)); }
    finally { setChangingManagement(false); }
  };
  const filteredConversations = conversationPage.items.filter((conversation) => {
    // Funil: instância e departamento recortam a lista antes do filtro de status.
    if (funnelSession && conversation.whatsappSessionId !== funnelSession) return false;
    if (funnelTeam && conversation.assignedTeamId !== funnelTeam) return false;
    if (filter === "unread") return conversation.unreadCount > 0;
    if (filter === "mine") return conversation.assignedUserId === currentUserId;
    if (filter === "unassigned") return !conversation.assignedUserId;
    if (filter === "in_progress") return conversation.status === "in_progress";
    if (filter === "waiting_customer") return conversation.status === "waiting_customer";
    if (filter === "resolved") return conversation.status === "resolved";
    if (filter === "archived") return conversation.status === "archived";
    if (filter === "high_priority") return conversation.priority === "high" || conversation.priority === "urgent";
    return conversation.status !== "archived";
  });
  // Busca da lista (referência Trynux): nome do contato, telefone e prévia da
  // última mensagem, no cliente — instantâneo sobre a página já carregada.
  const listSearchTerm = listSearch.trim().toLocaleLowerCase("pt-BR");
  const searchedConversations = listSearchTerm
    ? filteredConversations.filter((conversation) =>
        contactName(conversation).toLocaleLowerCase("pt-BR").includes(listSearchTerm)
        || (conversation.lastMessage ?? "").toLocaleLowerCase("pt-BR").includes(listSearchTerm)
        || (conversation.identity?.phone ?? "").includes(listSearchTerm)
        || conversation.chatId.includes(listSearchTerm))
    : filteredConversations;
  // Contadores dos chips, calculados sobre a página carregada.
  const allItems = conversationPage.items;
  const chipCounts = {
    active: allItems.filter((conversation) => conversation.status !== "archived").length,
    unread: allItems.filter((conversation) => conversation.unreadCount > 0).length,
    mine: allItems.filter((conversation) => conversation.assignedUserId === currentUserId).length,
    unassigned: allItems.filter((conversation) => !conversation.assignedUserId).length,
    inProgress: allItems.filter((conversation) => conversation.status === "in_progress").length,
    highPriority: allItems.filter((conversation) => conversation.priority === "high" || conversation.priority === "urgent").length,
    archived: allItems.filter((conversation) => conversation.status === "archived").length,
  };
  const filterChips: Array<{ key: InboxFilter; icon: string; label: string; count: number }> = [
    { key: "all", icon: "✓", label: "Ativos", count: chipCounts.active },
    { key: "unread", icon: "✉", label: "Não lidos", count: chipCounts.unread },
    { key: "mine", icon: "◉", label: "Minhas", count: chipCounts.mine },
    { key: "unassigned", icon: "◌", label: "Sem responsável", count: chipCounts.unassigned },
    { key: "in_progress", icon: "▶", label: "Em atendimento", count: chipCounts.inProgress },
    { key: "high_priority", icon: "⚑", label: "Prioridade", count: chipCounts.highPriority },
  ];
  const moreFilters: InboxFilter[] = ["waiting_customer", "resolved"];
  // Agrupamento por dia (HOJE / ONTEM / data), preservando a ordem da lista.
  const conversationGroups: Array<{ label: string; items: typeof searchedConversations }> = [];
  for (const conversation of searchedConversations) {
    const label = inboxDayLabel(conversation.lastMessageAt);
    const last = conversationGroups[conversationGroups.length - 1];
    if (last && last.label === label) last.items.push(conversation);
    else conversationGroups.push({ label, items: [conversation] });
  }
  const sync = syncView(syncJob, syncResume, startingSync);
  /** A conversa da Inbox, uma vez só. A coluna do meio da lista e a janela
   *  flutuante do Kanban renderizam ESTE bloco — não uma cópia dele. É closure
   *  e não componente de propósito: o painel usa dezenas de estados e
   *  manipuladores desta função (composição, anexos, editor, áudio, notas), e
   *  passá-los por props seria reescrever a fiação para não reescrever a tela. */
  const conversationPane = () => (
        <section
          className={`inbox-history${dropping ? " dropping" : ""}`}
          onDragEnter={dragEnter}
          onDragOver={dragOver}
          onDragLeave={dragLeave}
          onDrop={drop}
        >
          {dropping && <div className="conversation-drop-hint" aria-hidden="true"><strong>Solte para anexar</strong><span>Um arquivo por vez</span></div>}
          {selected ? (
            <>
              <div className="inbox-history-head">
                <div className="chat-contact">
                  <Avatar conversation={selected} large />
                  <div>
                    <h2>{contactName(selected)}</h2>
                    <span>
                      {isGroup(selected)
                        ? "Grupo · WhatsApp"
                        : `${selected.identity?.phone ?? phoneFallback(selected)} · WhatsApp`}{" "}
                      ·{" "}
                      {selected.status === "open"
                        ? "Em atendimento"
                        : "Conversa encerrada"}
                    </span>
                  </div>
                </div>
                <div className="conversation-controls">
                  <label><span>Responsável</span><select aria-label="Responsável" value={selected.assignedUserId ?? ""} disabled={changingManagement} onChange={(event) => void applyManagement(() => event.target.value ? api.assign(selected.id, event.target.value) : api.unassign(selected.id))}>
                    <option value="">Sem responsável</option>{workspaceUsers.filter(user => user.status === "active").map(user => <option value={user.id} key={user.id}>{user.displayName}</option>)}
                  </select></label>
                  <label><span>Equipe</span><select aria-label="Equipe responsável" value={selected.assignedTeamId ?? ""} disabled={changingManagement} onChange={(event) => void applyManagement(() => api.assignTeam(selected.id, event.target.value || null))}>
                    <option value="">Sem equipe</option>{teams.filter(team => team.isActive).map(team => <option value={team.id} key={team.id}>{team.name}</option>)}
                  </select></label>
                  <label><span>Status</span><select aria-label="Status da conversa" value={selected.status} disabled={changingManagement} onChange={(event) => void applyManagement(() => api.updateStatus(selected.id, event.target.value as ConversationStatus))}>
                    {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select></label>
                  <label><span>Prioridade</span><select aria-label="Prioridade da conversa" value={selected.priority} disabled={changingManagement} onChange={(event) => void applyManagement(() => api.updatePriority(selected.id, event.target.value as ConversationPriority))}>
                    {Object.entries(priorityLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select></label>
                </div>
                {!isGroup(selected) && (conversationPhone(selected) ?? (selected.chatId.endsWith("@lid") ? selected.chatId.split("@", 1)[0] : undefined)) ? (
                  <button
                    type="button"
                    className="conversation-call-trigger"
                    onClick={() => void calls.startCall(selected.id, conversationPhone(selected) ?? selected.chatId.split("@", 1)[0]!, contactName(selected))}
                    disabled={Boolean(calls.call && calls.call.status !== "ended") || calls.workspaceBusy}
                    aria-label={`Ligar para ${contactName(selected)}`}
                    title={calls.workspaceBusy ? "Em ligação — outro operador está em chamada nesta instância" : "Chamada de voz pelo WhatsApp"}
                  >📞 Ligar</button>
                ) : null}
                <button type="button" className="conversation-search-trigger" onClick={() => setConversationSearchOpen((open) => !open)} aria-expanded={conversationSearchOpen}>⌕ Buscar nesta conversa</button>
                {conversationSearchOpen && <div className="conversation-search-panel"><div className="conversation-search-field"><span>⌕</span><input value={conversationSearchInput} onChange={(event) => setConversationSearchInput(event.target.value)} placeholder="Buscar nas mensagens carregadas" aria-label="Buscar nesta conversa" autoFocus /><button type="button" onClick={() => { setConversationSearchInput(""); setConversationSearchOpen(false); }} aria-label="Fechar busca">×</button></div>{conversationSearchTerm ? <div className="conversation-search-results"><div><span>{conversationMatches.length} resultado{conversationMatches.length === 1 ? "" : "s"} nesta página</span><span className="conversation-search-nav"><button type="button" onClick={() => selectConversationMatch(activeConversationMatch - 1)} disabled={!conversationMatches.length} aria-label="Resultado anterior">↑</button><button type="button" onClick={() => selectConversationMatch(activeConversationMatch + 1)} disabled={!conversationMatches.length} aria-label="Próximo resultado">↓</button></span></div>{conversationMatches.length ? <p>{conversationMatches[activeConversationMatch]?.content}</p> : <p>Nenhum resultado nas mensagens já carregadas.</p>}<small>A busca completa será paginada pela API, com até 100 resultados por consulta.</small></div> : <p className="conversation-search-hint">Digite para pesquisar somente a página atual; o termo é refinado após uma breve pausa.</p>}</div>}
              </div>
              {stageOpen && attachment ? <AttachmentComposer
                file={attachment}
                previewUrl={attachmentPreview}
                caption={composerText}
                onCaption={setComposerText}
                sending={sending}
                status={attachmentStatus}
                notice={intakeMessage}
                canEdit={Boolean(editableAttachment)}
                onEdit={() => setEditorOpen(true)}
                editor={editorOpen && editableAttachment ? <ImageAnnotator
                  file={editableAttachment}
                  initialEdit={attachmentEdit}
                  onCancel={() => setEditorOpen(false)}
                  onConfirm={(edited, edit) => { setAttachment(edited); setAttachmentEdit(edit); setEditorOpen(false); }}
                /> : undefined}
                onEditorClose={() => setEditorOpen(false)}
                dirty={stageDirty}
                onClose={closeStage}
                onRemove={removeStage}
                onSubmit={(event) => void submitMessage(event)}
              /> : <>
              <div className="message-list" ref={listRef} onScroll={onScroll}>
                {/* O aviso mora aqui, dentro da conversa que falhou, e só enquanto
                    ela é a conversa aberta — não na coluna da lista, onde ficava
                    longe do problema e sobrevivia à troca de conversa. */}
                {messagesError && !loadingMessages && (
                  <div className="message-load-error" role="alert">
                    <strong>{messagesError.text}</strong>
                    {messagesError.hint && <span>{messagesError.hint}</span>}
                    <button type="button" className="secondary" onClick={() => void loadLatest(selected.id, true)}>
                      Tentar novamente
                    </button>
                  </div>
                )}
                {loadingMessages ? (
                  <p className="inbox-loading">Carregando mensagens…</p>
                ) : (
                  grouped.map(({ item, date }) => (
                    <div className="message-row" key={item.id}>
                      {date && (
                        <div className="chat-date">
                          {dateLabel(item.timestamp)}
                        </div>
                      )}
                      <MessageBubble message={item} api={api} domain={domain} onOpenContact={openContactInCrm} showAuthor={isGroup(selected) && item.direction === "inbound"} highlighted={item.id === activeMatchId} onReact={reactToMessage} reactionFailed={reactionFailures.has(item.id)} mentionResolver={(jid) => { const participant = participantsCache.current.get(selected.id)?.find((entry) => entry.whatsappId === jid); return participant ? participantDisplay(participant) : null; }} />
                    </div>
                  ))
                )}
              </div>
              <form
                className="message-composer"
                onSubmit={(event) => void submitMessage(event)}
                onPaste={pasteIntoComposer}
              >
                {intakeMessage && <p className={`composer-intake-message${intakeMessage.failed ? " failed" : ""}`} role={intakeMessage.failed ? "alert" : "status"}>{intakeMessage.text}</p>}
                <input ref={attachmentInputRef} className="attachment-input" type="file" accept={attachmentAccept} capture={attachmentCapture} aria-label="Selecionar anexo" onChange={(event) => { applyAttachment(event.target.files?.[0]); setAttachmentStatus(""); setAttachmentMenuOpen(false); setAttachmentCapture(undefined); }} disabled={sending} />
                {contactPickerOpen && <ContactPicker
                  loadInitial={loadPhonebookContacts}
                  searchContacts={searchContacts}
                  onSend={(contactIds) => void sendContactCards(contactIds)}
                  onClose={() => setContactPickerOpen(false)}
                  sending={sending}
                  sync={contactSync}
                />}
                {locationOpen && <div className="composer-location" role="dialog" aria-label="Enviar localização">
                  <div className="composer-location-head"><strong>Enviar localização</strong><button type="button" onClick={closeLocation} aria-label="Fechar localização">×</button></div>
                  <button type="button" className="composer-location-current" onClick={useCurrentLocation} disabled={locatingNow}>{locatingNow ? "Obtendo localização…" : "Usar minha localização atual"}</button>
                  {locationError && <p className="composer-location-error" role="alert">{locationError}</p>}
                  <label className="composer-location-field"><span>Latitude, longitude</span><input value={locationCoords} onChange={(event) => { setLocationCoords(event.target.value); setLocationError(""); }} placeholder="-7.115, -34.861" inputMode="decimal" aria-label="Latitude, longitude" /></label>
                  <label className="composer-location-field"><span>Nome do ponto (opcional)</span><input value={locationTitle} onChange={(event) => setLocationTitle(event.target.value)} placeholder="Loja centro" maxLength={120} aria-label="Nome do ponto" /></label>
                  {/* O link confere o que VAI SER ENVIADO, e por isso lê o campo —
                      a mesma fonte do botão de enviar. Lendo `locationPoint`, que
                      só a geolocalização preenche, quem digitava a coordenada
                      nunca via o link (a conferência faltava justamente na
                      entrada que mais precisa dela), e quem usava o GPS e depois
                      editava conferia o ponto antigo. */}
                  {locationTarget && <a className="composer-location-check" href={mapsUrl(locationTarget.latitude, locationTarget.longitude)} target="_blank" rel="noreferrer noopener">Conferir no mapa antes de enviar</a>}
                  {/* Desabilitar só quando o campo está vazio deixava passar
                      "abc": o operador clicava e só então lia o erro. Agora o
                      botão exige coordenada que resolve, e a dica explica por
                      que ele está apagado — senão o botão morto não diz nada. */}
                  {locationCoords.trim() && !locationTarget && <p className="composer-location-error" role="status">Coordenadas inválidas. Use latitude, longitude — por exemplo -7.115, -34.861.</p>}
                  <div className="composer-location-actions"><button type="button" onClick={closeLocation}>Cancelar</button><button type="button" className="composer-location-send" onClick={() => void confirmLocation()} disabled={!locationTarget}>Enviar localização</button></div>
                </div>}
                {cameraOpen && <div className="composer-camera" role="dialog" aria-label="Capturar pela câmera">
                  <video ref={cameraVideoRef} className="composer-camera-preview" autoPlay playsInline muted aria-label="Prévia da câmera" />
                  {cameraError && <p className="composer-camera-error" role="alert">{cameraError}</p>}
                  <div className="composer-camera-actions">
                    {cameraRecording
                      ? <><span className="composer-recording-indicator" aria-hidden="true" /><time>{`${Math.floor(cameraSeconds / 60)}:${String(cameraSeconds % 60).padStart(2, "0")}`}</time><button type="button" onClick={() => stopCameraRecording(true)}>Descartar</button><button type="button" className="composer-recording-send" onClick={() => stopCameraRecording()}>Concluir vídeo</button></>
                      : <><button type="button" className="composer-camera-shoot" onClick={takePhoto} disabled={Boolean(cameraError) && !cameraStreamRef.current}>Tirar foto</button><button type="button" onClick={startCameraRecording} disabled={Boolean(cameraError) && !cameraStreamRef.current}>Gravar vídeo</button><button type="button" onClick={closeCamera}>Fechar</button></>}
                  </div>
                </div>}
                {micGate && <MicrophonePermission
                  state={micGate.state}
                  asking={micGate.asking}
                  error={micGate.error}
                  devices={micDevices}
                  deviceId={micDeviceId}
                  onDevice={setMicDeviceId}
                  onAllow={() => void captureMicrophone()}
                  onCancel={() => setMicGate(undefined)}
                />}
                {isRecording && <div className="composer-recording" role="status" aria-live="polite"><span className="composer-recording-indicator" aria-hidden="true" /><strong>Gravando áudio</strong>
                  {/* O medidor é o retorno que faltava: sem ele, gravar mudo e
                      gravar falando têm exatamente a mesma aparência. */}
                  <span className="composer-recording-level" aria-hidden="true"><i style={{ transform: `scaleX(${Math.min(1, micLevel * 12)})` }} /></span>
                  <time>{`${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`}</time><button type="button" onClick={() => finishRecording(true)} aria-label="Cancelar gravação">Cancelar</button><button type="button" className="composer-recording-send" onClick={() => finishRecording()} aria-label="Concluir gravação">Enviar</button></div>}
                {isRecording && micSilent && <p className="composer-recording-silent" role="alert">{SILENCE_WARNING}</p>}
                {/* Só documento e áudio chegam aqui: imagem e vídeo abrem a tela de
                    composição, onde o editor de traço passou a ser acionado. */}
                {/* Prévia do link antes de enviar, como o WhatsApp: aparece sobre
                    o campo enquanto digita e o X envia o link puro, sem prévia.
                    Some com anexo pendente (legenda não gera prévia) e quando a
                    busca não encontra cartão para o link. */}
                {!attachment && composerFirstUrl && composerFirstUrl !== dismissedPreviewUrl && composerPreview !== null && (
                  <div className="composer-link-preview" aria-label="Prévia do link">
                    {composerPreview === undefined ? (
                      <span className="link-preview-card is-loading" aria-hidden="true"><i /><i /><i /></span>
                    ) : (
                      <>
                        {composerPreview.imageUrl && <span className="link-preview-image"><img src={composerPreview.imageUrl} alt="" loading="lazy" /></span>}
                        <span className="link-preview-body">
                          {composerPreview.title && <strong className="link-preview-title">{composerPreview.title}</strong>}
                          {composerPreview.description && <span className="link-preview-description">{composerPreview.description}</span>}
                          <span className="link-preview-domain">{composerPreview.siteName ?? domainFromUrl(composerFirstUrl)}</span>
                        </span>
                      </>
                    )}
                    <button type="button" className="composer-link-preview-dismiss" onClick={() => setDismissedPreviewUrl(composerFirstUrl)} disabled={sending} aria-label="Enviar sem a prévia do link" title="Enviar sem a prévia do link">×</button>
                  </div>
                )}
                {attachment && <div className="composer-pending-attachment" aria-label={`Anexo pendente: ${attachment.name}`}>
                  <span className="composer-pending-file-icon" aria-hidden="true">{attachmentKind(attachment.type) === "audio" ? "◖" : "▤"}</span>
                  <div className="composer-pending-details"><strong title={attachment.name}>{attachment.name}</strong><span>{fileSizeLabel(attachment.size)}</span>
                    {uploadProgress !== undefined && <span className="composer-upload-progress" role="status" aria-label="Progresso do envio"><span className="composer-upload-progress-track"><i style={{ width: `${uploadProgress}%` }} /></span>{uploadProgress < 100 ? `Enviando… ${uploadProgress}%` : "Anexo em processamento…"}</span>}
                  </div>
                  <span className="composer-pending-tools">
                    <button type="button" className="composer-pending-remove" onClick={clearAttachment} disabled={sending} aria-label={`Remover ${attachment.name}`} title="Remover anexo">×</button>
                  </span>
                </div>}
                <div className="composer-attachment-menu">
                  <button type="button" className="composer-action composer-add-action" onClick={() => setAttachmentMenuOpen((open) => !open)} disabled={sending} aria-label="Adicionar anexo" aria-expanded={attachmentMenuOpen} aria-controls="composer-attachment-options"><span aria-hidden="true">+</span></button>
                  {attachmentMenuOpen && <div className="composer-attachment-options" id="composer-attachment-options" role="menu" aria-label="Opções de anexo">
                    <button type="button" role="menuitem" onClick={() => { setAttachmentAccept("*/*"); attachmentInputRef.current?.click(); }}><span className="attachment-option-icon document" aria-hidden="true">▤</span><span>Documento</span></button>{/* Documento é o coringa: qualquer formato até 50 MB, paridade com o WhatsApp. */}
                    <button type="button" role="menuitem" onClick={() => { setAttachmentAccept(CAMERA_ACCEPT); setAttachmentCapture(undefined); attachmentInputRef.current?.click(); }}><span className="attachment-option-icon media" aria-hidden="true">▣</span><span>Fotos/Vídeos</span></button>
                    <button type="button" role="menuitem" className="future-option" title="Gravação de áudio será disponibilizada em breve"><span className="attachment-option-icon audio" aria-hidden="true">◖</span><span>Áudio</span><small>Em breve</small></button>
                    <button type="button" role="menuitem" onClick={() => void openCamera()}><span className="attachment-option-icon camera" aria-hidden="true">◉</span><span>Câmera</span></button>
                    <button type="button" role="menuitem" onClick={openLocation}><span className="attachment-option-icon location" aria-hidden="true">◎</span><span>Localização</span></button>
                    <button type="button" role="menuitem" onClick={openContactPicker}><span className="attachment-option-icon" aria-hidden="true">👤</span><span>Contato</span></button>
                  </div>}
                </div>
                <button type="button" className="composer-action composer-emoji-action" title="Emojis serão disponibilizados em breve" aria-label="Escolher emoji" disabled={sending}><span aria-hidden="true">☺</span></button>
                <div className="composer-input-wrap">
                  {/* O popup fica dentro do wrap (position:relative) para abrir
                      acima do campo; `mention` só existe em conversa de grupo. */}
                  {mention && selected && isGroup(selected) && (
                    <MentionAutocomplete
                      items={mentionItems}
                      loading={participantsState.loading && !participantsCache.current.has(selected.id)}
                      failed={participantsState.failed && !participantsCache.current.has(selected.id)}
                      activeIndex={mentionActive}
                      onSelect={selectMention}
                      onHover={setMentionActive}
                      onClose={() => setMention(null)}
                    />
                  )}
                  <textarea
                    aria-label="Mensagem"
                    name="text"
                    ref={composerRef}
                    value={composerText}
                    onChange={(event) => {
                      const next = event.target.value;
                      setComposerText(next);
                      if (selected && isGroup(selected)) {
                        const trigger = mentionTrigger(next, event.target.selectionStart ?? next.length);
                        setMention(trigger);
                        setMentionActive(0);
                        if (trigger) void loadParticipants(selected.id);
                      }
                    }}
                    onKeyDown={handleComposerKeyDown}
                    placeholder={attachment ? "Adicionar legenda (opcional)" : "Digite uma mensagem"}
                    maxLength={4096}
                    disabled={sending}
                  />
                  {attachmentStatus && <span className="attachment-status">{attachmentStatus}</span>}
                </div>
                {isRecording ? <button type="button" className="send-button composer-send-action" onClick={() => finishRecording()} aria-label="Concluir gravação">■</button> : composerText.trim() || attachment ? <button className="send-button composer-send-action" disabled={sending} aria-label={sending ? "Enviando mensagem" : "Enviar"}>{sending ? "…" : "➤"}</button> : <button type="button" className="composer-action composer-mic-action" onClick={() => void startRecording()} title="Gravar áudio" aria-label="Gravar áudio" disabled={sending}><span aria-hidden="true">♩</span></button>}
              </form>
              </>}
            </>
          ) : (
            <div className="inbox-welcome">
              <h2>Selecione uma conversa</h2>
            </div>
          )}
        </section>
  );
  if (view === "kanban") return <section className="page inbox">
    <button className="secondary" onClick={() => setView("list")}>Lista</button>
    <InboxKanban onOpenConversation={openFromCard} />
    {/* Sobreposição, e não painel lateral nem janela arrastável. O Kanban é
      * horizontal: uma gaveta lateral encolheria justamente as colunas que o
      * operador está lendo. E o que ele quer é **voltar rápido** para o quadro
      * — problema de fechar, não de ver as duas coisas ao mesmo tempo. `Esc`,
      * clique fora e o botão fecham; nada de arrastar, redimensionar e ordem
      * de empilhamento para manter. O quadro continua montado por trás, então
      * fechar não recarrega nada. */}
    {cardConversationOpen && <div className="kanban-conversation-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeCardConversation(); }}>
      <div className="kanban-conversation-window" role="dialog" aria-modal="true" aria-label={selected ? `Conversa com ${contactName(selected)}` : "Abrindo conversa"} ref={cardWindowRef} tabIndex={-1}>
        <button type="button" className="kanban-conversation-close" onClick={closeCardConversation} aria-label="Fechar conversa e voltar ao quadro">×</button>
        {cardConversationError ? <p className="alert" role="alert">{cardConversationError}</p> : selected ? conversationPane() : <p className="inbox-loading">Abrindo conversa…</p>}
      </div>
    </div>}
  </section>;
  return (
    <section className="page inbox chat-inbox">
      <div className="inbox-layout">
        <aside className="inbox-list" aria-label="Conversas">
          <div className="inbox-list-head">
            <div>
              <p className="inbox-eyebrow">ATENDIMENTO</p>
              <h2>
                Conversas <span>{conversationPage.total}</span>
              </h2>
            </div>
            <button
              className="secondary refresh-button"
              disabled={loadingConversations}
              onClick={() => void refreshConversations()}
              aria-label="Atualizar conversas"
            >
              ↻
            </button>
            <button className="secondary" onClick={() => setView("kanban")} aria-label="Abrir Kanban">Kanban</button>
          </div>
          {/* O estado da sincronização em uma faixa só: o que está acontecendo
              agora, quanto já veio, e a ação que cabe neste estado. Antes daqui a
              tela repetia o último `progressLabel` gravado, então um job que
              falhou e voltou a rodar continuava anunciando "Falhou". */}
          {/* Região viva sem `role="status"`: o papel já existe no compositor, e
              dois `status` na mesma tela deixam qualquer busca por papel ambígua —
              para a leitura em voz alta o `aria-live` sozinho basta. */}
          <div className={`inbox-sync is-${sync.tone}`} aria-live="polite">
            <div className="inbox-sync-copy">
              <strong>{sync.headline}</strong>
              {sync.detail && <span>{sync.detail}</span>}
              {sync.note && <small>{sync.note}</small>}
            </div>
            <div className="inbox-sync-actions">
              {sync.canStart && (
                <button className="secondary" disabled={sync.busy} onClick={() => void startSync()}>
                  {sync.startLabel}
                </button>
              )}
              {sync.canCancel && (
                <button className="secondary" onClick={() => void cancelSync()}>
                  Cancelar sincronização
                </button>
              )}
            </div>
          </div>
          <label className="inbox-list-search">
            <span>⌕</span>
            <input value={listSearch} onChange={(event) => setListSearch(event.target.value)} placeholder="Pesquisar ou começar uma nova conversa" aria-label="Pesquisar conversas" />
          </label>
          <div className="inbox-filter-chips" role="group" aria-label="Filtrar conversas">
            {filterChips.map((chip) => (
              <button key={chip.key} type="button" className={filter === chip.key ? "chip active" : "chip"} onClick={() => setFilter(chip.key)} aria-pressed={filter === chip.key}>
                <i aria-hidden="true">{chip.icon}</i>{chip.label}<b>{chip.count}</b>
              </button>
            ))}
            <select
              className={moreFilters.includes(filter) ? "chip chip-select active" : "chip chip-select"}
              aria-label="Mais filtros de conversas"
              value={moreFilters.includes(filter) ? filter : ""}
              onChange={(event) => setFilter((event.target.value || "all") as InboxFilter)}
            >
              <option value="">Mais ▾</option>
              <option value="waiting_customer">Aguardando cliente</option>
              <option value="resolved">Resolvidas</option>
            </select>
          </div>
          <button type="button" className={filter === "archived" ? "inbox-archived-row active" : "inbox-archived-row"} onClick={() => setFilter("archived")} aria-pressed={filter === "archived"}>
            <i aria-hidden="true">▣</i>Arquivadas<b>{chipCounts.archived}</b>
          </button>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {resolvingConversationId && <p className="inbox-loading" role="status">Abrindo conversa…</p>}
          {deepLinkError && <div className="alert" role="alert"><span>{deepLinkError}</span><button type="button" className="secondary" onClick={() => setDeepLinkAttempt((attempt) => attempt + 1)}>Tentar novamente</button></div>}
          {loadingConversations ? (
            <p className="inbox-loading">Carregando conversas…</p>
          ) : searchedConversations.length === 0 ? (
            <p className="inbox-loading">{listSearchTerm ? `Nenhuma conversa para “${listSearch.trim()}”.` : "Nenhuma conversa neste filtro."}</p>
          ) : (
            conversationGroups.map((group) => (
              <div className="conversation-day-group" key={group.label}>
                <p className="conversation-day-label">{group.label}</p>
                {group.items.map((conversation) => {
                  const assignedUser = conversation.assignedUserId ? workspaceUsers.find((user) => user.id === conversation.assignedUserId) : undefined;
                  return (
                    <button
                      className={
                        selected?.id === conversation.id
                          ? "conversation-item selected"
                          : "conversation-item"
                      }
                      key={conversation.id}
                      onClick={() => void openConversation(conversation)}
                    >
                      <Avatar conversation={conversation} />
                      <span className="conversation-content">
                        <span className="conversation-top">
                          <strong>
                            {contactName(conversation)}
                            {isGroup(conversation) && " · Grupo"}
                          </strong>
                          <time className={conversation.unreadCount > 0 ? "has-unread" : ""}>
                            {new Date(conversation.lastMessageAt).toLocaleTimeString(
                              [],
                              { hour: "2-digit", minute: "2-digit" },
                            )}
                          </time>
                        </span>
                        <span className="conversation-bottom">
                          <span className="conversation-preview">
                            {(conversation.priority === "high" || conversation.priority === "urgent") && (
                              <i className={`conversation-flag priority-${conversation.priority}`} title={`Prioridade ${priorityLabel[conversation.priority]}`}>⚑</i>
                            )}
                            {conversation.lastMessage ?? "Sem mensagens de texto"}
                          </span>
                          <span className="conversation-side">
                            {assignedUser && <span className="conversation-agent" title={`Responsável: ${assignedUser.displayName}`}>{assignedUser.displayName.trim().charAt(0).toUpperCase()}</span>}
                            <span className={`conversation-status status-${conversation.status}`}>{statusLabel[conversation.status]}</span>
                            {conversation.unreadCount > 0 && (
                              <span className="unread">{conversation.unreadCount}</span>
                            )}
                          </span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </aside>
        {conversationPane()}
        <aside className="customer-panel">
          {selected ? (
            <>
              <div className="customer-panel-head">
                <span>
                  {isGroup(selected)
                    ? "INFORMAÇÕES DO GRUPO"
                    : "INFORMAÇÕES DO CLIENTE"}
                </span>
              </div>
              <div className="customer-profile">
                <Avatar conversation={selected} customer />
                <div className="customer-profile-copy"><h3>{contactName(selected)}</h3><p>{isGroup(selected) ? "Grupo do WhatsApp" : selected.identity?.phone ?? phoneFallback(selected)}</p><span><i />{selected.identity?.syncStatus === "synced" ? "WhatsApp conectado" : "Sincronizando WhatsApp"}</span></div>
              </div>
              <div className="customer-details">
                <div className="customer-section-title">PERFIL</div>
                <div>
                  <span>
                    {isGroup(selected) ? "Nome do grupo" : "Nome WhatsApp"}
                  </span>
                  <strong>
                    {selected.identity?.profileName ??
                      selected.identity?.pushName ??
                      "Não informado"}
                  </strong>
                </div>
                {!isGroup(selected) && (
                  <div>
                    <span>Número</span>
                    <strong className="customer-phone"><b>{selected.identity?.phone ?? phoneFallback(selected)}</b><button type="button" onClick={() => void copyPhone()} aria-label="Copiar número">{copiedPhone ? "Copiado" : "Copiar"}</button></strong>
                  </div>
                )}
                <div>
                  <span>Canal</span>
                  <strong className="customer-channel"><i /> WhatsApp</strong>
                </div>
                <div className="customer-future-fields"><div className="customer-section-title">CAMPOS PERSONALIZADOS</div><div><span>Origem do lead</span><strong>Não informado</strong></div><div><span>Responsável</span><strong>{workspaceUsers.find((user) => user.id === selected.assignedUserId)?.displayName ?? teams.find((team) => team.id === selected.assignedTeamId)?.name ?? "Não atribuído"}</strong></div><div><span>Status</span><strong>{statusLabel[selected.status]}</strong></div><div><span>Informações extras</span><strong>Disponível em breve</strong></div></div>
              </div>
              {/* Chamadas da conversa com as gravações (avaliação de
                  atendimento). Só conversa direta: grupo não tem chamada. */}
              {!isGroup(selected) && <CallHistory conversationId={selected.id} />}
              {/* Membros do grupo: a mesma fonte do autocomplete de menções
                  (cache 1× por conversa). Nome + número, com selo de admin. */}
              {isGroup(selected) && (
                <div className="customer-details customer-members">
                  <div className="customer-section-title">MEMBROS{participantsCache.current.has(selected.id) ? ` (${participantsCache.current.get(selected.id)?.length ?? 0})` : ""}</div>
                  {participantsState.loading && !participantsCache.current.has(selected.id) && <p className="customer-members-hint">Carregando participantes…</p>}
                  {participantsState.failed && !participantsCache.current.has(selected.id) && <p className="customer-members-hint">Não foi possível carregar os participantes.</p>}
                  {participantsCache.current.has(selected.id) && (participantsCache.current.get(selected.id)?.length ?? 0) === 0 && <p className="customer-members-hint">Nenhum participante sincronizado ainda — a lista se completa conforme o grupo interage.</p>}
                  {(participantsCache.current.get(selected.id) ?? []).map((participant) => (
                    <div key={participant.whatsappId} className="customer-member">
                      <strong>{participantDisplay(participant)}</strong>
                      <span>{participant.phone ? phoneDisplay(participant.phone) : "sem número visível"}{isGroupAdmin(participant.role) ? " · admin" : ""}</span>
                    </div>
                  ))}
                </div>
              )}
              {!isGroup(selected) && !selected.contactId && (
                <div className="customer-details customer-contact">
                  <div className="customer-section-title"><span>CONTATO</span>{!creatingContact && <button type="button" onClick={() => setCreatingContact(true)}>Criar contato</button>}</div>
                  {contactError && <p className="customer-contact-error">{contactError}</p>}
                  {creatingContact ? (
                    <form className="customer-contact-form" onSubmit={createContact}>
                      <label>Nome ChatPro<input name="displayName" required maxLength={160} defaultValue={contactName(selected)} /></label>
                      <label>Telefone<input name="phoneNumber" defaultValue={selected.identity?.phone ?? phoneFallback(selected) ?? ""} placeholder="Somente números" /></label>
                      <label>E-mail<input name="email" type="email" /></label>
                      <label>Empresa<input name="company" maxLength={160} /></label>
                      <div className="customer-contact-actions">
                        <button type="button" className="secondary" onClick={() => { setCreatingContact(false); setContactError(""); }}>Cancelar</button>
                        <button disabled={savingContact}>{savingContact ? "Salvando…" : "Salvar"}</button>
                      </div>
                    </form>
                  ) : (
                    <p className="customer-contact-hint">Esta conversa ainda não tem contato no ChatPro.</p>
                  )}
                </div>
              )}
              {!isGroup(selected) && selected.contactId && (
                <div className="customer-details customer-contact">
                  <div className="customer-section-title"><span>DADOS DO CONTATO</span>{!editingContact && <button type="button" onClick={() => setEditingContact(true)}>Editar</button>}</div>
                  {contactError && <p className="customer-contact-error" role="alert">{contactError}</p>}
                  {editingContact ? (
                    <form className="customer-contact-form" onSubmit={saveContact}>
                      <label>Nome ChatPro<input name="displayName" required maxLength={160} defaultValue={contact?.displayName ?? ""} /></label>
                      <label>E-mail<input name="email" type="email" defaultValue={contact?.email ?? ""} /></label>
                      <label>Empresa<input name="company" maxLength={160} defaultValue={contact?.company ?? ""} /></label>
                      <div className="customer-contact-actions">
                        <button type="button" className="secondary" onClick={() => { setEditingContact(false); setContactError(""); }}>Cancelar</button>
                        <button disabled={savingContact}>{savingContact ? "Salvando…" : "Salvar"}</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div><span>Nome ChatPro</span><strong>{contact?.displayName ?? "Não informado"}</strong></div>
                      <div><span>E-mail</span><strong>{contact?.email ?? "Não informado"}</strong></div>
                      <div><span>Empresa</span><strong>{contact?.company ?? "Não informado"}</strong></div>
                    </>
                  )}
                </div>
              )}
              <div className="conversation-context sla-detail" aria-live="polite">
                <div className="context-heading"><span>SLA OPERACIONAL</span><small>{loadingSla ? "Atualizando…" : "Tempo real"}</small></div>
                {slaMetrics ? <div className={`sla-detail-card sla-${slaMetrics.slaIndicator}`}><span className="sla-detail-dot" /><div><strong>{slaStatusLabel[slaMetrics.status]}</strong><small>{slaMetrics.deadlineAt ? new Date(slaMetrics.deadlineAt).getTime() <= Date.now() ? `Atrasado há ${durationLabel(Date.now() - new Date(slaMetrics.deadlineAt).getTime())}` : `Prazo restante: ${durationLabel(new Date(slaMetrics.deadlineAt).getTime() - Date.now())}` : slaMetrics.frozenAt ? "Métrica congelada" : `Em espera há ${durationLabel(slaMetrics.waitingTime)}`}</small></div></div> : !loadingSla ? <p className="sla-detail-empty">Sem métrica SLA para esta conversa.</p> : <p className="sla-detail-empty">Carregando SLA…</p>}
              </div>
              <div className="conversation-context team-operations">
                <div className="context-heading"><span>OPERAÇÃO DA CONVERSA</span><small>Visual local</small></div>
                <label className="queue-selector"><span>Fila</span><select value={visualQueue} onChange={(event) => setVisualQueue(event.target.value)} aria-label="Fila visual da conversa"><option value="">Sem fila definida</option><option value="Comercial">Comercial</option><option value="Suporte">Suporte</option><option value="Financeiro">Financeiro</option><option value="Jurídico">Jurídico</option></select></label>
                <div className="team-panel-heading"><span>Equipe</span><small>Presença preparada</small></div>
                <div className="team-members-preview">{workspaceUsers.length ? workspaceUsers.slice(0, 6).map((user) => <div key={user.id}><span className={`team-member-status ${user.status === "active" ? "online" : user.status === "invited" ? "away" : "offline"}`} /><strong>{user.displayName}</strong><small>{user.status === "active" ? "online" : user.status === "invited" ? "ausente" : "offline"}</small></div>) : <p>Nenhum atendente disponível no workspace.</p>}</div>
              </div>
              <div className="conversation-context">
                <div className="context-heading">
                  <span>ETIQUETAS</span>
                </div>
                <div className="context-tags">
                  {(context?.tags ?? []).map((item) => (
                    <button
                      type="button"
                      className="context-tag"
                      key={item}
                      onClick={() => void removeTag(item)}
                    >
                      {item} ×
                    </button>
                  ))}
                </div>
                <form
                  className="context-tag-form"
                  onSubmit={(event) => void addTag(event)}
                >
                  <input
                    value={tag}
                    onChange={(event) => setTag(event.target.value)}
                    placeholder="Adicionar etiqueta"
                    maxLength={64}
                    aria-label="Nova etiqueta"
                  />
                  <button disabled={savingContext || !tag.trim()}>
                    Adicionar
                  </button>
                </form>
              </div>
              <div className="conversation-context">
                <div className="context-heading">
                  <span>OBSERVAÇÃO INTERNA</span>
                  <small aria-live="polite">{({ editing: "Editando", saving: "Salvando…", saved: "Salvo", error: "Erro" } as const)[noteSaveState]}</small>
                </div>
                <textarea
                  className="context-notes"
                  value={notes}
                  onChange={(event) => {
                    const nextNotes = event.target.value;
                    setNotes(nextNotes);
                    if (selected) noteDrafts.current.set(selected.id, nextNotes);
                    setNoteSaveState("editing");
                  }}
                  placeholder="Adicionar observação para a equipe"
                  maxLength={10000}
                  aria-label="Observação interna"
                />
                <div className="context-notes-actions">
                  <button type="button" onClick={() => void saveNotes()} disabled={!selected || !api.updateContext || noteSaveState === "saving" || notes === (context?.notes ?? "")}>
                    {noteSaveState === "saving" ? "Salvando…" : "Salvar observação"}
                  </button>
                </div>
              </div>
              <div className="conversation-context operational-history">
                <div className="context-heading"><span>HISTÓRICO E ATIVIDADES</span></div>
                {activity.length ? activity.map((event) => <div className="operational-event" key={event.id}><strong>{operationLabel[event.action]}</strong><span>{event.previousValue ?? "—"} → {event.newValue ?? "—"}</span><small>{event.userId} · {activityLabel(event.createdAt)}</small></div>) : <p>Nenhuma alteração operacional ainda.</p>}
              </div>
              <div className="conversation-context activity">
                <div className="context-heading">
                  <span>ÚLTIMAS INTERAÇÕES</span>
                </div>
                <div>
                  <span>Primeiro contato</span>
                  <strong>{activityLabel(context?.firstInteractionAt)}</strong>
                </div>
                <div>
                  <span>Última interação</span>
                  <strong>{activityLabel(context?.lastInteractionAt)}</strong>
                </div>
              </div>
            </>
          ) : (
            <div className="customer-empty">
              <strong>Perfil do cliente</strong>
              <p>Seleciona uma conversa para ver seus dados.</p>
            </div>
          )}
        </aside>
      </div>
      {calls.call ? (
        <CallModal
          call={calls.call}
          remoteStream={calls.remoteStream}
          busy={calls.busy}
          onAccept={() => void calls.accept()}
          onReject={() => void calls.reject()}
          onHangup={() => void calls.hangup()}
          onDismiss={calls.dismiss}
        />
      ) : null}
    </section>
  );
}
