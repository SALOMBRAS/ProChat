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
} from "../api/inbox.js";
import { InboxApi } from "../api/inbox.js";
import { connectRealtime } from "../api/realtime.js";
import { ApiError } from "../api/client.js";

const defaultApi = new InboxApi();
const pageSize = 50;
const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : "Ocorreu um erro inesperado.";
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
const Media = ({ message }: { message: InboxMessage }) => {
  const url = message.mediaUrl;
  if (!url)
    return message.direction === "inbound" ? (
      <span className="message-received-label">Recebida</span>
    ) : null;
  if (message.messageType === "image" || message.messageType === "sticker")
    return (
      <a
        className="message-media image"
        href={url}
        target="_blank"
        rel="noreferrer"
      >
        <img
          src={message.thumbnailUrl ?? url}
          alt={message.mediaFilename ?? "Imagem recebida"}
        />
      </a>
    );
  if (message.messageType === "video")
    return (
      <video
        className="message-media video"
        controls
        preload="metadata"
        poster={message.thumbnailUrl ?? undefined}
      >
        <source src={url} type={message.mediaMimeType ?? undefined} />
      </video>
    );
  if (
    message.messageType === "audio" ||
    message.mediaMimeType?.startsWith("audio/")
  )
    return (
      <audio className="message-media audio" controls preload="metadata">
        <source src={url} type={message.mediaMimeType ?? undefined} />
      </audio>
    );
  return (
    <a className="message-document" href={url} target="_blank" rel="noreferrer">
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
  const [attachmentStatus, setAttachmentStatus] = useState("");
  const [context, setContext] = useState<ConversationContext>();
  const [notes, setNotes] = useState("");
  const [tag, setTag] = useState("");
  const [savingContext, setSavingContext] = useState(false);
  const [syncJob, setSyncJob] = useState<HistorySyncJob>();
  const [startingSync, setStartingSync] = useState(false);
  const [activity, setActivity] = useState<ConversationEvent[]>([]);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [changingManagement, setChangingManagement] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scrollAfterRender = useRef(false);
  const loadedContextId = useRef<string>();
  const activeConversationId = useRef<string>();
  const contextRequest = useRef(0);
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
      const first = await api.messages(conversationId, 1, pageSize);
      const lastPage = Math.max(1, Math.ceil(first.total / pageSize));
      const latest =
        lastPage === 1
          ? first
          : await api.messages(conversationId, lastPage, pageSize);
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
  useEffect(() => {
    const session = conversationPage.items[0]?.whatsappSessionId;
    if (!session || !api.syncStatus) return;
    void api
      .syncStatus(session)
      .then(setSyncJob)
      .catch(() => setSyncJob(undefined));
  }, [conversationPage.items, api]);
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
    contextRequest.current += 1;
    setContext(undefined);
    setActivity([]);
    setNotes("");
    setTag("");
    loadedContextId.current = undefined;
    if (selected) { void loadContext(selected.id); void loadActivity(selected.id); }
  }, [selected?.id, api]);
  useEffect(
    () =>
      connectRealtime((event) => {
        if (event.eventType === "conversation.context.updated") {
          if (selected && String(event.payload.conversationId) === selected.id)
            void loadContext(selected.id);
          return;
        }
        if (event.eventType === "conversation.management.updated") {
          const conversation = event.payload.conversation as InboxConversation | undefined;
          if (conversation?.id) {
            setConversationPage((current) => ({ ...current, items: current.items.map((item) => item.id === conversation.id ? conversation : item) }));
            if (selected?.id === conversation.id) { setSelected(conversation); void loadActivity(conversation.id); }
          }
          return;
        }
        if (event.eventType === "conversation.sync.updated") {
          setSyncJob((current) =>
            current
              ? {
                  ...current,
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
        if (selected && atBottomRef.current) void loadLatest(selected.id, true);
      }),
    [selected?.id, api],
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
        const job = await api.sendAttachment(selected.id, attachment, text);
        setAttachmentStatus(
          job.status === "failed"
            ? "Falhou"
            : "Enviado; aguardando confirmação",
        );
        setAttachment(undefined);
      } else await api.sendMessage(selected.id, text);
      form.reset();
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
                Histórico:{" "}
                {syncJob?.status === "running"
                  ? `sincronizando (${syncJob.chatsProcessed} conversas, ${syncJob.messagesProcessed} mensagens)`
                  : syncJob?.status === "completed"
                    ? "concluído"
                    : "não sincronizado"}
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
          </div>
          <button
            className="secondary"
            disabled={startingSync || syncJob?.status === "running"}
            onClick={() => void startSync()}
          >
            {startingSync ? "Iniciando…" : "Sincronizar histórico"}
          </button>
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
                  <span className="conversation-management-meta"><b className={`priority-${conversation.priority}`}>{priorityLabel[conversation.priority]}</b><small>{statusLabel[conversation.status]}</small><small>{conversation.assignedUserId === currentUserId ? "Minha" : conversation.assignedUserId ? "Responsável definido" : "Sem responsável"}</small></span>
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
                  <select aria-label="Responsável" value={selected.assignedUserId ? "me" : "none"} disabled={changingManagement} onChange={(event) => void applyManagement(() => event.target.value === "me" ? api.assign(selected.id) : api.unassign(selected.id))}>
                    <option value="none">Sem responsável</option><option value="me">{selected.assignedUserId === currentUserId ? "Minha conta" : "Assumir conversa"}</option>
                  </select>
                  <select aria-label="Status da conversa" value={selected.status} disabled={changingManagement} onChange={(event) => void applyManagement(() => api.updateStatus(selected.id, event.target.value as ConversationStatus))}>
                    {Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <select aria-label="Prioridade da conversa" value={selected.priority} disabled={changingManagement} onChange={(event) => void applyManagement(() => api.updatePriority(selected.id, event.target.value as ConversationPriority))}>
                    {Object.entries(priorityLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
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
                      <article className={`message-bubble ${item.direction}`}>
                        {isGroup(selected) && item.direction === "inbound" && (
                          <strong className="message-author">
                            {senderName(item.senderWhatsappId)}:
                          </strong>
                        )}
                        <Media message={item} />
                        {item.content && <p>{item.content}</p>}
                        <span className={`message-meta status-${item.status}`}>
                          {item.direction === "outbound" && (
                            <b aria-label={`Status: ${item.status}`}>
                              {statusIcon(item.status)}{" "}
                            </b>
                          )}
                          {new Date(item.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </article>
                    </div>
                  ))
                )}
              </div>
              <form
                className="message-composer"
                onSubmit={(event) => void submitMessage(event)}
              >
                <input className="attachment-input" type="file" aria-label="Anexar arquivo" onChange={(event) => { setAttachment(event.target.files?.[0]); setAttachmentStatus(''); }} disabled={sending} />
                <button type="button" className="composer-action" onClick={(event) => (event.currentTarget.previousElementSibling as HTMLInputElement | null)?.click()} disabled={sending} aria-label="Anexar arquivo">⌕</button>
                <textarea aria-label="Mensagem" name="text" placeholder={attachment ? 'Adicionar legenda (opcional)' : 'Digite uma mensagem'} maxLength={4096} disabled={sending} />
                {attachment && <span className="attachment-preview" title={attachment.name}>{attachment.name}</span>}
                {attachmentStatus && <span className="attachment-status">{attachmentStatus}</span>}
                <button
                  className="send-button"
                  disabled={sending}
                  aria-label={sending ? "Enviando mensagem" : "Enviar"}
                >
                  {sending ? "…" : "↑"}
                </button>
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
                <h3>{contactName(selected)}</h3>
                <p>
                  <i />{" "}
                  {selected.identity?.syncStatus === "synced"
                    ? "Dados do WhatsApp sincronizados"
                    : "Sincronizando dados do WhatsApp"}
                </p>
              </div>
              <div className="customer-details">
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
                    <strong>
                      {selected.identity?.phone ?? phoneFallback(selected)}
                    </strong>
                  </div>
                )}
                <div>
                  <span>Contato conhecido</span>
                  <strong>
                    {selected.identity?.knownContact ? "Sim" : "Não"}
                  </strong>
                </div>
                <div>
                  <span>Canal</span>
                  <strong>WhatsApp</strong>
                </div>
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
                <div className="context-heading"><span>HISTÓRICO OPERACIONAL</span></div>
                {activity.length ? activity.map((event) => <div className="operational-event" key={event.id}><strong>{operationLabel[event.action]}</strong><span>{event.previousValue ?? "—"} → {event.newValue ?? "—"}</span><small>{event.userId} · {activityLabel(event.createdAt)}</small></div>) : <p>Nenhuma alteração operacional ainda.</p>}
              </div>
              <div className="conversation-context activity">
                <div className="context-heading">
                  <span>ATIVIDADE</span>
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
