import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { InboxConversation, InboxMessage, Page } from '../api/inbox.js';
import { InboxApi } from '../api/inbox.js';
import { connectRealtime } from '../api/realtime.js';
import { ApiError } from '../api/client.js';

const defaultApi = new InboxApi();
const pageSize = 50;
const errorMessage = (error: unknown) => error instanceof ApiError ? error.message : 'Ocorreu um erro inesperado.';
const isGroup = (conversation: InboxConversation) => conversation.conversationType === 'group';
const contactName = (conversation: InboxConversation) => isGroup(conversation) ? 'Grupo WhatsApp' : conversation.chatId.replace(/@.+$/, '');
const initials = (conversation: InboxConversation) => isGroup(conversation) ? 'GR' : contactName(conversation).slice(-2).toUpperCase();
const senderName = (value?: string | null) => value ? value.replace(/@.+$/, '') : 'Participante';
const dateLabel = (value: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }).format(new Date(value));
const chatLayoutCss = `.chat-inbox .inbox-layout{height:calc(100vh - 145px);min-height:0}.chat-inbox .inbox-list,.chat-inbox .customer-panel{min-height:0;overflow-y:auto}.chat-inbox .inbox-history{height:100%;min-height:0;overflow:hidden}.chat-inbox .message-list{min-height:0;overflow-y:auto;overscroll-behavior:contain}.chat-inbox .message-composer{flex:0 0 auto}.chat-inbox .message-row{display:flex;flex-direction:column;gap:7px}.chat-inbox .history-loading,.chat-inbox .history-hint{align-self:center;margin:0;color:#938da0;font-size:10px}.chat-inbox .message-author{display:block;margin-bottom:5px;color:#d9bdff;font-size:10px}@media(max-width:760px){.chat-inbox .inbox-layout{height:auto}.chat-inbox .inbox-history{height:calc(100vh - 190px);min-height:420px}}`;

export default function Inbox({ api = defaultApi }: { api?: InboxApi }) {
  const [conversationPage, setConversationPage] = useState<Page<InboxConversation>>({ items: [], page: 1, pageSize: 50, total: 0 });
  const [selected, setSelected] = useState<InboxConversation>();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [messagePage, setMessagePage] = useState(1);
  const [messageTotal, setMessageTotal] = useState(0);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const scrollAfterRender = useRef(false);

  const refreshConversations = async () => {
    setLoadingConversations(true);
    try { setConversationPage(await api.conversations()); } catch (nextError) { setError(errorMessage(nextError)); } finally { setLoadingConversations(false); }
  };
  const scrollToEnd = () => { const list = listRef.current; if (list) list.scrollTop = list.scrollHeight; };
  const loadLatest = async (conversationId: string, stickToEnd: boolean) => {
    setLoadingMessages(true);
    try {
      const first = await api.messages(conversationId, 1, pageSize);
      const lastPage = Math.max(1, Math.ceil(first.total / pageSize));
      const latest = lastPage === 1 ? first : await api.messages(conversationId, lastPage, pageSize);
      setMessages(latest.items); setMessagePage(latest.page); setMessageTotal(latest.total); scrollAfterRender.current = stickToEnd;
    } catch (nextError) { setError(errorMessage(nextError)); } finally { setLoadingMessages(false); }
  };
  const loadOlder = async () => {
    if (!selected || loadingOlder || loadingMessages || messagePage <= 1) return;
    const list = listRef.current; const before = list ? { height: list.scrollHeight, top: list.scrollTop } : undefined;
    setLoadingOlder(true);
    try {
      const previous = await api.messages(selected.id, messagePage - 1, pageSize);
      setMessages(current => [...previous.items.filter(item => !current.some(existing => existing.id === item.id)), ...current]);
      setMessagePage(previous.page); setMessageTotal(previous.total);
      requestAnimationFrame(() => { const currentList = listRef.current; if (currentList && before) currentList.scrollTop = before.top + currentList.scrollHeight - before.height; });
    } catch (nextError) { setError(errorMessage(nextError)); } finally { setLoadingOlder(false); }
  };

  useEffect(() => { void refreshConversations(); }, [api]);
  useEffect(() => { if (scrollAfterRender.current) { scrollAfterRender.current = false; requestAnimationFrame(scrollToEnd); } }, [messages]);
  useEffect(() => connectRealtime(event => {
    if (event.eventType !== 'message.received' && event.eventType !== 'message.sent' && event.eventType !== 'conversation.updated') return;
    void refreshConversations();
    if (selected && atBottomRef.current) void loadLatest(selected.id, true);
  }), [selected?.id, api, messagePage]);

  const openConversation = async (conversation: InboxConversation) => {
    setSelected(conversation); setMessages([]); setMessagePage(1); setMessageTotal(0); setError(''); atBottomRef.current = true;
    await Promise.all([loadLatest(conversation.id, true), conversation.unreadCount ? api.markRead(conversation.id).then(refreshConversations).catch(nextError => setError(errorMessage(nextError))) : Promise.resolve()]);
  };
  const submitMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selected || sending) return;
    const form = event.currentTarget; const text = String(new FormData(form).get('text') ?? '').trim(); if (!text) return;
    setSending(true); setError('');
    try { await api.sendMessage(selected.id, text); form.reset(); atBottomRef.current = true; await Promise.all([loadLatest(selected.id, true), refreshConversations()]); } catch (nextError) { setError(errorMessage(nextError)); } finally { setSending(false); }
  };
  const onScroll = () => {
    const list = listRef.current; if (!list) return;
    atBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    if (list.scrollTop < 48) void loadOlder();
  };
  const grouped = messages.map((item, index) => ({ item, date: index === 0 || dateLabel(messages[index - 1].timestamp) !== dateLabel(item.timestamp) }));

  return <section className="page inbox chat-inbox"><style>{chatLayoutCss}</style><div className="inbox-layout"><aside className="inbox-list" aria-label="Conversas"><div className="inbox-list-head"><div><p className="inbox-eyebrow">ATENDIMENTO</p><h2>Conversas <span>{conversationPage.total}</span></h2></div><button className="secondary refresh-button" disabled={loadingConversations} onClick={() => void refreshConversations()} aria-label="Atualizar conversas">↻</button></div><div className="inbox-filter"><span>⌕</span><input aria-label="Buscar conversa" placeholder="Buscar conversa" /></div>{error && <p className="alert" role="alert">{error}</p>}{loadingConversations ? <p className="inbox-loading">Carregando conversas…</p> : conversationPage.items.map(conversation => <button className={selected?.id === conversation.id ? 'conversation-item selected' : 'conversation-item'} key={conversation.id} onClick={() => void openConversation(conversation)} aria-label={`Abrir conversa ${conversation.chatId}`}><span className="conversation-avatar">{initials(conversation)}<i className={conversation.status === 'open' ? 'online' : ''} /></span><span className="conversation-content"><span className="conversation-top"><strong>{contactName(conversation)}{isGroup(conversation) && ' · Grupo'}</strong><time>{new Date(conversation.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></span><span className="conversation-bottom"><span className="conversation-preview">{conversation.lastMessage ?? 'Sem mensagens de texto'}</span>{conversation.unreadCount > 0 && <span className="unread">{conversation.unreadCount}</span>}</span></span></button>)}</aside><section className="inbox-history" aria-live="polite">{selected ? <><div className="inbox-history-head"><div className="chat-contact"><span className="conversation-avatar large">{initials(selected)}<i className={selected.status === 'open' ? 'online' : ''} /></span><div><h2>{contactName(selected)}</h2><span>{isGroup(selected) ? 'Grupo · WhatsApp' : 'WhatsApp'} · {selected.status === 'open' ? 'Em atendimento' : 'Conversa encerrada'}</span></div></div><div className="chat-actions"><button className="chat-icon" aria-label="Buscar na conversa">⌕</button><button className="chat-icon" aria-label="Mais opções">•••</button></div></div><div className="message-list" ref={listRef} onScroll={onScroll} aria-label="Histórico de mensagens">{loadingOlder && <p className="history-loading">Carregando mensagens anteriores…</p>}{loadingMessages ? <p className="inbox-loading">Carregando mensagens…</p> : grouped.length ? grouped.map(({ item, date }) => <div className="message-row" key={item.id}>{date && <div className="chat-date">{dateLabel(item.timestamp)}</div>}<article className={`message-bubble ${item.direction}`}>{isGroup(selected) && item.direction === 'inbound' && <strong className="message-author">{senderName(item.senderWhatsappId)}:</strong>}<p>{item.content ?? 'Mensagem sem texto'}</p><span className="message-meta">{item.direction === 'outbound' ? 'Enviada' : 'Recebida'} · <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></span></article></div>) : <div className="inbox-welcome"><div className="welcome-orb">✦</div><h2>Conversa pronta para começar</h2><p>Envie a primeira mensagem para este contato.</p></div>}{messageTotal > messages.length && messagePage > 1 && <p className="history-hint">Role para cima para carregar mensagens anteriores.</p>}</div><form className="message-composer" onSubmit={event => void submitMessage(event)}><button type="button" className="composer-action" aria-label="Anexar arquivo">＋</button><textarea aria-label="Mensagem" name="text" placeholder="Digite uma mensagem" maxLength={4096} required disabled={sending} /><button className="send-button" disabled={sending} aria-label={sending ? 'Enviando mensagem' : 'Enviar mensagem'}>{sending ? '…' : '↑'}</button></form></> : <div className="inbox-welcome"><div className="welcome-orb">✦</div><h2>Seu atendimento inteligente começa aqui</h2><p>Selecione uma conversa para visualizar o histórico e responder seus clientes.</p></div>}</section><aside className="customer-panel">{selected ? <><div className="customer-panel-head"><span>{isGroup(selected) ? 'INFORMAÇÕES DO GRUPO' : 'INFORMAÇÕES DO CLIENTE'}</span></div><div className="customer-profile"><span className="customer-avatar">{initials(selected)}</span><h3>{contactName(selected)}</h3><p><i /> {selected.status === 'open' ? 'Conversa ativa' : 'Conversa encerrada'}</p></div><div className="customer-details"><div><span>{isGroup(selected) ? 'Grupo' : 'Telefone'}</span><strong>{contactName(selected)}</strong></div><div><span>Canal</span><strong>WhatsApp</strong></div></div></> : <div className="customer-empty"><span className="empty-icon">◎</span><strong>Perfil do cliente</strong><p>Seleciona uma conversa para ver seus dados.</p></div>}</aside></div></section>;
}
