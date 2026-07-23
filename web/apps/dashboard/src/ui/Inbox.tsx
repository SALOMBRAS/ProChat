import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  ConversationContext,
  ConversationEvent,
  ConversationPriority,
  ConversationStatus,
  HistorySyncJob,
  InboxConversation,
  InboxMessage,
  Page,
  SlaMetrics,
} from "../api/inbox.js";
import { InboxApi } from "../api/inbox.js";
import { connectRealtime } from "../api/realtime.js";
import { ApiError } from "../api/client.js";
import { WorkspaceApi } from "../api/workspace.js";
import type { Team, WorkspaceUser } from "@chatpro/contracts";
import { InboxKanban } from "./InboxKanban.js";

const defaultApi = new InboxApi();
const workspaceApi = new WorkspaceApi();
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
  value.chatId.replace(/@.+$/, "");
const contactName = (value: InboxConversation) =>
  value.identity?.displayName ??
  (isGroup(value) ? "Grupo WhatsApp" : phoneFallback(value));
const initials = (value: InboxConversation) =>
  isGroup(value) ? "GR" : contactName(value).slice(-2).toUpperCase();
const senderName = (value?: string | null) =>
  value ? value.replace(/@.+$/, "") : "Participante";
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
const statusLabel: Record<ConversationStatus, string> = { open: "Aberta", in_progress: "Em atendimento", waiting_customer: "Aguardando cliente", resolved: "Resolvida", archived: "Arquivada" };
const priorityLabel: Record<ConversationPriority, string> = { low: "Baixa", normal: "Normal", high: "Alta", urgent: "Urgente" };
const operationLabel: Record<ConversationEvent["action"], string> = { assigned: "Responsável alterado", unassigned: "Conversa sem responsável", status_changed: "Status alterado", priority_changed: "Prioridade alterada", archived: "Conversa arquivada", reopened: "Conversa reaberta" };
type InboxFilter = "all" | "mine" | "unassigned" | "in_progress" | "waiting_customer" | "resolved" | "archived" | "high_priority";
const currentUserId = import.meta.env.VITE_USER_ID || "00000000-0000-4000-8000-000000000001";
const fileSizeLabel = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** index).toFixed(index === 1 ? 0 : 1)} ${units[index - 1]}`;
};
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
let activeAudio: HTMLAudioElement | undefined;
const AudioMessage = ({ url, message }: { url: string; message: InboxMessage }) => {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(message.duration ?? 0);
  const [speed, setSpeed] = useState(1);
  const [unavailable, setUnavailable] = useState(false);
  const format = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const toggle = async () => { const node = audio.current; if (!node) return; if (node.paused) { if (activeAudio && activeAudio !== node) activeAudio.pause(); activeAudio = node; try { await node.play(); } catch { setUnavailable(true); } } else node.pause(); };
  const changeSpeed = () => { const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1; setSpeed(next); if (audio.current) audio.current.playbackRate = next; };
  return <div className="audio-player" aria-label="Mensagem de áudio"><audio ref={audio} preload="metadata" onLoadedMetadata={() => setDuration(audio.current?.duration || message.duration || 0)} onTimeUpdate={() => setCurrent(audio.current?.currentTime || 0)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCurrent(0); }} onError={() => setUnavailable(true)}><source src={url} type={message.mediaMimeType ?? undefined} /></audio>{unavailable ? <span className="media-error" role="status">Áudio indisponível.</span> : <><button type="button" className="audio-play" onClick={() => void toggle()} aria-label={playing ? "Pausar áudio" : "Reproduzir áudio"}>{playing ? "Ⅱ" : "▶"}</button><span className="audio-mark" aria-hidden="true">♬</span><input aria-label="Progresso do áudio" type="range" min="0" max={Math.max(duration, 1)} step="0.1" value={Math.min(current, duration || 0)} onChange={event => { const value = Number(event.target.value); if (audio.current) audio.current.currentTime = value; setCurrent(value); }} /><time>{format(current)} / {format(duration)}</time><button type="button" className="audio-speed" onClick={changeSpeed} aria-label={`Velocidade ${speed}x`}>{speed}x</button></>}</div>;
};
const documentIcon = (filename?: string | null, mimeType?: string | null) => {
  const extension = filename?.split(".").pop()?.toLowerCase();
  if (mimeType?.includes("pdf") || extension === "pdf") return "PDF";
  if (["doc", "docx", "odt"].includes(extension ?? "")) return "DOC";
  if (["xls", "xlsx", "csv"].includes(extension ?? "")) return "XLS";
  if (["ppt", "pptx"].includes(extension ?? "")) return "PPT";
  return "FILE";
};
const ImageMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const [expanded, setExpanded] = useState(false);
  const filename = message.mediaFilename?.trim();
  const hasMeaningfulFilename = Boolean(filename && !/^(image|imagem)(\.[a-z0-9]+)?$/i.test(filename));
  const label = hasMeaningfulFilename ? filename! : "Imagem";
  return <>
    <div className="message-image-card">
      <button type="button" className="message-image-preview" onClick={() => setExpanded(true)} aria-label={`Ampliar ${label}`}><img src={url} alt={label} /></button>
      <div className={`message-media-footer${hasMeaningfulFilename ? "" : " icon-only"}`}>{hasMeaningfulFilename && <span title={filename}>{filename}</span>}<a href={url} download={message.mediaFilename ?? undefined} aria-label={`Baixar ${label}`} title="Baixar imagem">⇩</a></div>
    </div>
    {expanded && <div className="media-modal-backdrop" role="presentation" onClick={() => setExpanded(false)}><section className="media-modal" role="dialog" aria-modal="true" aria-label={label} onClick={(event) => event.stopPropagation()}><div className="media-modal-head"><strong title={label}>{label}</strong><div><a href={url} download={message.mediaFilename ?? undefined} aria-label={`Baixar ${label}`} title="Baixar imagem">⇩</a><button type="button" onClick={() => setExpanded(false)} aria-label="Fechar imagem">×</button></div></div><img src={url} alt={label} /></section></div>}
  </>;
};
const DocumentMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const filename = message.mediaFilename ?? "Documento";
  const type = documentIcon(message.mediaFilename, message.mediaMimeType);
  return <a className="message-document-card" href={url} download={message.mediaFilename ?? undefined} aria-label={`Baixar ${filename}`}><span className="message-document-icon">{type}</span><span className="message-document-details"><strong title={filename}>{filename}</strong><span><small>{type}</small><small>{message.mediaSize != null ? fileSizeLabel(message.mediaSize) : "Tamanho não informado"}</small></span></span><span className="message-document-download" aria-hidden="true">⇩</span></a>;
};
const VideoMessage = ({ message, url }: { message: InboxMessage; url: string }) => {
  const [playbackError, setPlaybackError] = useState<string>();
  return <div className="message-video-card"><video className="message-media video" controls preload="metadata" poster={message.thumbnailUrl ?? undefined} playsInline onLoadedMetadata={() => setPlaybackError(undefined)} onStalled={() => setPlaybackError("O vídeo está demorando para carregar.")} onError={() => setPlaybackError("Formato de vídeo inválido ou não suportado.")}><source src={url} type={message.mediaMimeType ?? undefined} /></video><div className="message-media-footer"><span title={message.mediaFilename ?? undefined}>{message.mediaFilename ?? "Vídeo"}</span><a href={url} download={message.mediaFilename ?? undefined} aria-label="Baixar vídeo" title="Baixar vídeo">⇩</a></div>{playbackError && <span className="media-error" role="status">{playbackError}</span>}</div>;
};
const Media = ({ message, api }: { message: InboxMessage; api: InboxApi }) => {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [playbackError, setPlaybackError] = useState<string>();
  useEffect(() => { if (!message.mediaUrl) return; let active = true; setUrl(undefined); setFailed(false); setPlaybackError(undefined); void api.mediaUrl(message.id).then(access => { if (active) setUrl(access.url); }).catch(() => { if (active) setFailed(true); }); return () => { active = false; }; }, [api, message.id, message.mediaUrl]);
  if (!message.mediaUrl)
    return message.direction === "inbound" ? (
      <span className="message-received-label">Recebida</span>
    ) : null;
  if (failed) return <span className="media-error" role="status">NÃ£o foi possÃ­vel carregar a mÃ­dia.</span>;
  if (!url) return <span className="media-loading" role="status">Carregando mÃ­diaâ€¦</span>;
  if (message.messageType === "image" || message.messageType === "sticker")
    return <ImageMessage message={message} url={url} />;
  if (message.messageType === "video")
    return <VideoMessage message={message} url={url} />;
  if (false)
    return (
      <>
      <video
        className="message-media video"
        controls
        preload="metadata"
        poster={message.thumbnailUrl ?? undefined}
        playsInline
        onLoadedMetadata={() => setPlaybackError(undefined)}
        onStalled={() => setPlaybackError("O vÃ­deo estÃ¡ demorando para carregar.")}
        onError={() => setPlaybackError("Formato de vÃ­deo invÃ¡lido ou nÃ£o suportado.")}
      >
        <source src={url} type={message.mediaMimeType ?? undefined} />
      </video>
      {playbackError && <span className="media-error" role="status">{playbackError}</span>}
      </>
    );
  if (
    message.messageType === "audio" ||
    message.mediaMimeType?.startsWith("audio/")
  )
    return <AudioMessage url={url} message={message} />;
  return <DocumentMessage message={message} url={url} />;
  if (false) return (
    <a className="message-document" href={url} download={message.mediaFilename ?? undefined}>
      <span>▧</span>
      <strong>{message.mediaFilename ?? "Documento"}</strong>
      <small>{message.mediaMimeType ?? "Abrir arquivo"}</small>
    </a>
  );
};
const statusIcon = (status: InboxMessage["status"]) =>
  status === "read" || status === "delivered"
    ? "✓✓"
    : status === "failed"
      ? "!"
      : status === "sending"
        ? "◌"
        : "✓";
const MessageBubble = ({ message, api, showAuthor, highlighted = false }: { message: InboxMessage; api: InboxApi; showAuthor: boolean; highlighted?: boolean }) => (
  <article id={`conversation-search-result-${message.id}`} className={`message-bubble ${message.direction}${highlighted ? " search-highlighted" : ""}`}>
    {showAuthor && <strong className="message-author">{senderName(message.senderWhatsappId)}:</strong>}
    <Media message={message} api={api} />
    {message.content && <p>{message.content}</p>}
    <span className={`message-meta status-${message.status}`}>
      {message.direction === "outbound" && <b aria-label={`Status: ${message.status}`}>{statusIcon(message.status)}{" "}</b>}
      {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </span>
  </article>
);

export default function Inbox({ api = defaultApi }: { api?: InboxApi }) {
  const [conversationPage, setConversationPage] = useState<
    Page<InboxConversation>
  >({ items: [], page: 1, pageSize: 50, total: 0 });
  const [selected, setSelected] = useState<InboxConversation>();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [messagePage, setMessagePage] = useState(1);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [attachment, setAttachment] = useState<File>();
  const [attachmentPreview, setAttachmentPreview] = useState<string>();
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [composerText, setComposerText] = useState("");
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentAccept, setAttachmentAccept] = useState<string>();
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder>();
  const recordingStreamRef = useRef<MediaStream>();
  const recordingTimerRef = useRef<ReturnType<typeof setInterval>>();
  const discardRecordingRef = useRef(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchInput, setConversationSearchInput] = useState("");
  const [conversationSearchTerm, setConversationSearchTerm] = useState("");
  const [activeConversationMatch, setActiveConversationMatch] = useState(0);
  const [visualQueue, setVisualQueue] = useState("");
  const [slaMetrics, setSlaMetrics] = useState<SlaMetrics>();
  const [loadingSla, setLoadingSla] = useState(false);
  const slaCache = useRef(new Map<string, SlaMetrics>());
  const slaRequest = useRef(0);
  const slaAbort = useRef<AbortController>();
  useEffect(() => { if (!attachment?.type.startsWith('image/')) { setAttachmentPreview(undefined); return; } const url = URL.createObjectURL(attachment); setAttachmentPreview(url); return () => URL.revokeObjectURL(url); }, [attachment]);
  useEffect(() => () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
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
  const [syncJob, setSyncJob] = useState<HistorySyncJob>();
  const [startingSync, setStartingSync] = useState(false);
  const [activity, setActivity] = useState<ConversationEvent[]>([]);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [view, setView] = useState<"list" | "kanban">("list");
  const [changingManagement, setChangingManagement] = useState(false);
  const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUser[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scrollAfterRender = useRef(false);
  const loadedContextId = useRef<string>();
  const activeConversationId = useRef<string>();
  const selectedRef = useRef<InboxConversation>();
  const contextRequest = useRef(0);
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
    try {
      // The API returns the most recent reverse-cursor page first. Do not
      // request the whole history merely to find its final offset page.
      const latest = await api.messages(conversationId, 1, pageSize);
      setMessages(latest.items);
      setMessagePage(latest.page);
      scrollAfterRender.current = stickToEnd;
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoadingMessages(false);
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
      setNotes(result.notes ?? "");
      loadedContextId.current = conversationId;
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
  useEffect(() => { void refreshDirectory(); }, []);
  useEffect(() => {
    const session = syncJob?.wahaSession ?? conversationPage.items[0]?.whatsappSessionId;
    if (!session || !api.syncStatus) return;
    let disposed = false;
    const load = () => void api.syncStatus!(session).then((job) => { if (!disposed) setSyncJob(job); }).catch(() => { if (!disposed) setSyncJob(undefined); });
    load();
    const polling = syncJob?.status === "running" || syncJob?.status === "pending";
    const timer = polling ? window.setInterval(load, 2_000) : undefined;
    return () => { disposed = true; if (timer) window.clearInterval(timer); };
  }, [conversationPage.items, api, syncJob?.status, syncJob?.wahaSession]);
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
  useEffect(() => {
    activeConversationId.current = selected?.id;
    selectedRef.current = selected;
    contextRequest.current += 1;
    setContext(undefined);
    setActivity([]);
    setSlaMetrics(undefined);
    setLoadingSla(Boolean(selected));
    setNotes("");
    setTag("");
    loadedContextId.current = undefined;
    if (selected) { void loadContext(selected.id); void loadActivity(selected.id); void loadSla(selected.id); }
  }, [selected?.id, api]);
  useEffect(
    () =>
      connectRealtime((event) => {
        if (event.workspaceId !== workspaceId) return;
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
      }),
    [api],
  );
  useEffect(() => {
    const conversationId = selected?.id;
    if (
      !conversationId ||
      !api.updateContext ||
      loadedContextId.current !== conversationId ||
      notes === (context?.notes ?? "")
    )
      return;
    const timer = window.setTimeout(() => {
      setSavingContext(true);
      void api
        .updateContext(conversationId, { notes })
        .then((result) => {
          if (activeConversationId.current === conversationId)
            setContext(result);
        })
        .catch((nextError) => {
          if (activeConversationId.current === conversationId)
            setError(errorMessage(nextError));
        })
        .finally(() => {
          if (activeConversationId.current === conversationId)
            setSavingContext(false);
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [notes, selected?.id, context?.notes, api]);
  const openConversation = async (conversation: InboxConversation) => {
    activeConversationId.current = conversation.id;
    contextRequest.current += 1;
    setContext(undefined);
    setNotes("");
    setTag("");
    loadedContextId.current = undefined;
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
        const clientRequestId = crypto.randomUUID();
        const job = await api.sendAttachment(selected.id, attachment, clientRequestId, text);
        setAttachmentStatus(
          job.status === "failed"
            ? "Falhou"
            : "Anexo em processamento; aguardando confirmação",
        );
        setAttachment(undefined);
      } else await api.sendMessage(selected.id, text);
      form.reset();
      setComposerText("");
      await Promise.all([
        loadLatest(selected.id, true),
        refreshConversations(),
      ]);
    } catch (nextError) {
      setAttachmentStatus("Falhou");
      setError(errorMessage(nextError));
    } finally {
      setSending(false);
    }
  };
  const clearAttachment = () => {
    setAttachment(undefined);
    setAttachmentStatus("");
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  };
  const copyPhone = async () => {
    if (!selected || isGroup(selected)) return;
    const phone = selected.identity?.phone ?? phoneFallback(selected);
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
  const startRecording = async () => {
    if (sending || isRecording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("A gravação de áudio não é suportada neste navegador.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        if (!discardRecordingRef.current && chunks.length) {
          const type = recorder.mimeType || "audio/webm";
          const extension = type.includes("ogg") ? "ogg" : "webm";
          setAttachment(new File([new Blob(chunks, { type })], `audio-${Date.now()}.${extension}`, { type }));
          setAttachmentStatus("Áudio pronto para envio");
        }
      };
      setRecordingSeconds(0);
      setIsRecording(true);
      recordingTimerRef.current = setInterval(() => setRecordingSeconds((seconds) => seconds + 1), 1000);
      recorder.start();
    } catch (nextError) {
      setError(nextError instanceof Error ? `Não foi possível acessar o microfone: ${nextError.message}` : "Não foi possível acessar o microfone.");
    }
  };
  const onScroll = () => {
    const list = listRef.current;
    if (list)
      atBottomRef.current =
        list.scrollHeight - list.scrollTop - list.clientHeight < 48;
  };
  const startSync = async () => {
    const session = conversationPage.items[0]?.whatsappSessionId;
    if (!api.startSync) return;
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
    if (filter === "mine") return conversation.assignedUserId === currentUserId;
    if (filter === "unassigned") return !conversation.assignedUserId;
    if (filter === "in_progress") return conversation.status === "in_progress";
    if (filter === "waiting_customer") return conversation.status === "waiting_customer";
    if (filter === "resolved") return conversation.status === "resolved";
    if (filter === "archived") return conversation.status === "archived";
    if (filter === "high_priority") return conversation.priority === "high" || conversation.priority === "urgent";
    return true;
  });
  if (view === "kanban") return <section className="page inbox"><button className="secondary" onClick={() => setView("list")}>Lista</button><InboxKanban /></section>;
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
              <small>
          Histórico: {syncJob ? `${syncJob.progressLabel}${syncJob.status === 'running' ? ` (${syncJob.chatsProcessed} conversas, ${syncJob.messagesProcessed} mensagens)` : ''}` : "não sincronizado"}
              </small>
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
          <button
            className="secondary"
            disabled={startingSync || syncJob?.status === "running" || syncJob?.status === "pending"}
            onClick={() => void startSync()}
          >
            {startingSync ? "Iniciando…" : syncJob?.status === "failed" || syncJob?.status === "cancelled" ? "Retomar sincronização" : "Sincronizar histórico"}
          </button>
          {(syncJob?.status === "running" || syncJob?.status === "pending") && (
            <button className="secondary" onClick={() => void cancelSync()}>
              Cancelar sincronização
            </button>
          )}
          <label className="inbox-management-filter">
            <span>Filtro</span>
            <select aria-label="Filtrar conversas" value={filter} onChange={(event) => setFilter(event.target.value as InboxFilter)}>
              <option value="all">Todas</option><option value="mine">Minhas</option><option value="unassigned">Sem responsável</option><option value="in_progress">Em atendimento</option><option value="waiting_customer">Aguardando cliente</option><option value="resolved">Resolvidas</option><option value="archived">Arquivadas</option><option value="high_priority">Alta prioridade</option>
            </select>
          </label>
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          {loadingConversations ? (
            <p className="inbox-loading">Carregando conversas…</p>
          ) : (
            filteredConversations.map((conversation) => (
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
                    <time>
                      {new Date(conversation.lastMessageAt).toLocaleTimeString(
                        [],
                        { hour: "2-digit", minute: "2-digit" },
                      )}
                    </time>
                  </span>
                  <span className="conversation-bottom">
                    <span className="conversation-preview">
                      {conversation.lastMessage ?? "Sem mensagens de texto"}
                    </span>
                    {conversation.unreadCount > 0 && (
                      <span className="unread">{conversation.unreadCount}</span>
                    )}
                  </span>
                  <span className="conversation-management-meta"><b className={`priority-${conversation.priority}`}>{priorityLabel[conversation.priority]}</b><small>{statusLabel[conversation.status]}</small><small>{conversation.assignedUserId ? workspaceUsers.find(user => user.id === conversation.assignedUserId)?.displayName ?? "Responsável definido" : "Sem responsável"}</small>{conversation.assignedTeamId && <small>{teams.find(team => team.id === conversation.assignedTeamId)?.name ?? "Equipe"}</small>}</span>
                </span>
              </button>
            ))
          )}
        </aside>
        <section className="inbox-history">
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
                <button type="button" className="conversation-search-trigger" onClick={() => setConversationSearchOpen((open) => !open)} aria-expanded={conversationSearchOpen}>⌕ Buscar nesta conversa</button>
                {conversationSearchOpen && <div className="conversation-search-panel"><div className="conversation-search-field"><span>⌕</span><input value={conversationSearchInput} onChange={(event) => setConversationSearchInput(event.target.value)} placeholder="Buscar nas mensagens carregadas" aria-label="Buscar nesta conversa" autoFocus /><button type="button" onClick={() => { setConversationSearchInput(""); setConversationSearchOpen(false); }} aria-label="Fechar busca">×</button></div>{conversationSearchTerm ? <div className="conversation-search-results"><div><span>{conversationMatches.length} resultado{conversationMatches.length === 1 ? "" : "s"} nesta página</span><span className="conversation-search-nav"><button type="button" onClick={() => selectConversationMatch(activeConversationMatch - 1)} disabled={!conversationMatches.length} aria-label="Resultado anterior">↑</button><button type="button" onClick={() => selectConversationMatch(activeConversationMatch + 1)} disabled={!conversationMatches.length} aria-label="Próximo resultado">↓</button></span></div>{conversationMatches.length ? <p>{conversationMatches[activeConversationMatch]?.content}</p> : <p>Nenhum resultado nas mensagens já carregadas.</p>}<small>A busca completa será paginada pela API, com até 100 resultados por consulta.</small></div> : <p className="conversation-search-hint">Digite para pesquisar somente a página atual; o termo é refinado após uma breve pausa.</p>}</div>}
              </div>
              <div className="message-list" ref={listRef} onScroll={onScroll}>
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
                      <MessageBubble message={item} api={api} showAuthor={isGroup(selected) && item.direction === "inbound"} highlighted={item.id === activeMatchId} />
                    </div>
                  ))
                )}
              </div>
              <form
                className="message-composer"
                onSubmit={(event) => void submitMessage(event)}
              >
                <input ref={attachmentInputRef} className="attachment-input" type="file" accept={attachmentAccept} aria-label="Selecionar anexo" onChange={(event) => { setAttachment(event.target.files?.[0]); setAttachmentStatus(""); setAttachmentMenuOpen(false); }} disabled={sending} />
                {isRecording && <div className="composer-recording" role="status" aria-live="polite"><span className="composer-recording-indicator" aria-hidden="true" /><strong>Gravando áudio</strong><time>{`${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`}</time><button type="button" onClick={() => finishRecording(true)} aria-label="Cancelar gravação">Cancelar</button><button type="button" className="composer-recording-send" onClick={() => finishRecording()} aria-label="Concluir gravação">Enviar</button></div>}
                {attachment && <div className="composer-pending-attachment" aria-label={`Anexo pendente: ${attachment.name}`}>
                  {attachmentPreview ? <img className="composer-pending-thumbnail" src={attachmentPreview} alt={`Prévia de ${attachment.name}`} /> : <span className="composer-pending-file-icon" aria-hidden="true">{attachment.type.startsWith("video/") ? "▣" : "▤"}</span>}
                  <div className="composer-pending-details"><strong title={attachment.name}>{attachment.name}</strong><span>{fileSizeLabel(attachment.size)}</span></div>
                  <button type="button" className="composer-pending-remove" onClick={clearAttachment} disabled={sending} aria-label={`Remover ${attachment.name}`} title="Remover anexo">×</button>
                </div>}
                <div className="composer-attachment-menu">
                  <button type="button" className="composer-action composer-add-action" onClick={() => setAttachmentMenuOpen((open) => !open)} disabled={sending} aria-label="Adicionar anexo" aria-expanded={attachmentMenuOpen} aria-controls="composer-attachment-options"><span aria-hidden="true">+</span></button>
                  {attachmentMenuOpen && <div className="composer-attachment-options" id="composer-attachment-options" role="menu" aria-label="Opções de anexo">
                    <button type="button" role="menuitem" onClick={() => { setAttachmentAccept(".pdf,.doc,.docx,.xls,.xlsx,.txt"); attachmentInputRef.current?.click(); }}><span className="attachment-option-icon document" aria-hidden="true">▤</span><span>Documento</span></button>
                    <button type="button" role="menuitem" onClick={() => { setAttachmentAccept("image/*,video/*"); attachmentInputRef.current?.click(); }}><span className="attachment-option-icon media" aria-hidden="true">▣</span><span>Fotos/Vídeos</span></button>
                    <button type="button" role="menuitem" className="future-option" title="Gravação de áudio será disponibilizada em breve"><span className="attachment-option-icon audio" aria-hidden="true">◖</span><span>Áudio</span><small>Em breve</small></button>
                    <button type="button" role="menuitem" className="future-option" title="Captura pela câmera será disponibilizada em breve"><span className="attachment-option-icon camera" aria-hidden="true">◉</span><span>Câmera</span><small>Em breve</small></button>
                  </div>}
                </div>
                <button type="button" className="composer-action composer-emoji-action" title="Emojis serão disponibilizados em breve" aria-label="Escolher emoji" disabled={sending}><span aria-hidden="true">☺</span></button>
                <div className="composer-input-wrap">
                  <textarea aria-label="Mensagem" name="text" value={composerText} onChange={(event) => setComposerText(event.target.value)} placeholder={attachment ? "Adicionar legenda (opcional)" : "Digite uma mensagem"} maxLength={4096} disabled={sending} />
                  {attachmentStatus && <span className="attachment-status">{attachmentStatus}</span>}
                </div>
                {isRecording ? <button type="button" className="send-button composer-send-action" onClick={() => finishRecording()} aria-label="Concluir gravação">■</button> : composerText.trim() || attachment ? <button className="send-button composer-send-action" disabled={sending} aria-label={sending ? "Enviando mensagem" : "Enviar"}>{sending ? "…" : "➤"}</button> : <button type="button" className="composer-action composer-mic-action" onClick={() => void startRecording()} title="Gravar áudio" aria-label="Gravar áudio" disabled={sending}><span aria-hidden="true">♩</span></button>}
              </form>
            </>
          ) : (
            <div className="inbox-welcome">
              <h2>Selecione uma conversa</h2>
            </div>
          )}
        </section>
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
                <div className="customer-future-fields"><div className="customer-section-title">CAMPOS PERSONALIZADOS</div><div><span>Empresa</span><strong>Não informado</strong></div><div><span>Origem do lead</span><strong>Não informado</strong></div><div><span>Responsável</span><strong>{workspaceUsers.find((user) => user.id === selected.assignedUserId)?.displayName ?? teams.find((team) => team.id === selected.assignedTeamId)?.name ?? "Não atribuído"}</strong></div><div><span>Status</span><strong>{statusLabel[selected.status]}</strong></div><div><span>Informações extras</span><strong>Disponível em breve</strong></div></div>
              </div>
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
                  <small>
                    {savingContext ? "Salvando…" : "Salvo automaticamente"}
                  </small>
                </div>
                <textarea
                  className="context-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Adicionar observação para a equipe"
                  maxLength={10000}
                  aria-label="Observação interna"
                />
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
    </section>
  );
}
