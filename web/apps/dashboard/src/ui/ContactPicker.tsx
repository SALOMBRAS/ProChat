import { useEffect, useRef, useState } from "react";
import { normalizedPhone, realName } from "./contactIdentity.js";
import { phoneDisplay } from "./messageMedia.js";

/** Escolha de contato para enviar como cartão, no padrão do WhatsApp: uma
 *  janela flutuante que abre MOSTRANDO os contatos salvos no celular (~150,
 *  filtro `origin=phonebook` no servidor) — não a base inteira, que já passa
 *  de dezenas de milhares. Para achar quem não está no celular, a lupa
 *  pesquisa NO SERVIDOR, em lotes: cada letra ou dígito dispara uma busca
 *  (com espera de 300 ms para não martelar o banco) que devolve os
 *  primeiros 150, e "Carregar mais" traz o lote seguinte. O botão
 *  "Sincronizar contatos" do cabeçalho puxa o que mudou (contato salvo
 *  agora, conversa nova) e recarrega a lista ao concluir.
 *
 *  Diferente do AttachmentComposer, que é presentacional e deixa todo o estado
 *  no Inbox, esta tela guarda o próprio termo e seleção. O motivo é que nenhum
 *  dos dois tem consumidor fora daqui — o Inbox só precisa saber quais ids
 *  sair enviando. Manter isso local também evita crescer um arquivo que já
 *  passa de duas mil linhas. */

/** Só o que a lista precisa. Estrutural de propósito: evita amarrar a tela ao
 *  formato completo de contato, que carrega workspaceId e datas sem uso aqui.
 *
 *  `photoUrl` é opcional porque nem todo contato tem foto: ela vem do
 *  enriquecimento de `/domain/contacts` com `whatsapp_identities` (a identidade
 *  mais recente do telefone), e só existe depois que o identity sync do WhatsApp
 *  enriqueceu aquela identidade.
 *
 *  `origin` diz de onde o contato veio: 'phonebook' = agenda do celular
 *  (sync com fonte 'waha_contact_sync'), 'history' = conversas, webhook ou
 *  cadastro manual. A lista é única e não separa por origem — o campo fica
 *  disponível para usos futuros (selo, filtro).
 *
 *  `whatsappName`/`whatsappPushName` são o nome que o WhatsApp conhece (o nome
 *  salvo na agenda do celular e o nome que a pessoa escolheu no perfil),
 *  anexados em lote pela listagem. Eles salvam a linha quando o `displayName`
 *  interno é só dígitos — o caso dos contatos criados de identidades LID, que
 *  são a maioria da base medida em 05/08/2026. */
export type PickableContact = { id: string; displayName: string; phoneNumber: string; photoUrl?: string | null; whatsappName?: string | null; whatsappPushName?: string | null; origin?: "phonebook" | "history" | null };

/** O que a tela sabe sobre o job de sincronização da agenda. Estrutural de
 *  propósito: o picker não se amarra ao contrato inteiro da API — só ao que
 *  mostra e ao que decide o polling. */
export type ContactSyncState = {
  wahaSession: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  contactsProcessed: number;
  progressLabel: string;
  lastErrorSafe: string | null;
};

/** As duas chamadas que o sync da agenda precisa. O `start` não recebe sessão:
 *  sem sessão explícita o servidor cai na sessão conectada do workspace, e a
 *  resposta já carrega o `wahaSession` que alimenta o polling. */
export type ContactSyncActions = {
  start: () => Promise<ContactSyncState>;
  status: (wahaSession: string) => Promise<ContactSyncState>;
};

export type ContactPickerProps = {
  /** A abertura: os contatos salvos no celular (origem `phonebook`), que são
   *  poucos por definição — centenas, não milhares. Chamada ao abrir e de
   *  novo quando um sync conclui. */
  loadInitial: () => Promise<PickableContact[]>;
  /** A lupa: busca no SERVIDOR sobre a base inteira, em lotes — `page` 1
   *  devolve os primeiros ~150, `page` 2 o lote seguinte, e `total` diz
   *  quando "Carregar mais" some. Digitar não varre a base local: cada
   *  termo é uma consulta nova. */
  searchContacts: (term: string, page: number) => Promise<{ items: PickableContact[]; total: number }>;
  onSend: (contactIds: string[]) => void;
  onClose: () => void;
  sending: boolean;
  /** Sincronização da agenda do WhatsApp conectado, pelo botão do cabeçalho.
   *  Opcional: telas sem sessão de trabalho à mão (testes, usos futuros fora
   *  do Inbox) mostram só a lista já sincronizada. */
  sync?: ContactSyncActions;
  /** Teto do contrato: `sendableVcardSchema` aceita de 1 a 20 cartões, e o
   *  controller repete o mesmo `.min(1).max(20)`. Passar de 20 seria 400. */
  max?: number;
};

/** Iniciais do nome, quando há nome. Sem foto e sem nome não há inicial que
 *  signifique alguma coisa — ver `contactRow`. */
export const contactInitials = (displayName: string) => {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1]?.[0] ?? "" : "";
  const label = `${first}${last}`.toUpperCase();
  return label || "?";
};

/** O que a linha mostra. Uma linha, dois campos no máximo, e nunca o mesmo
 *  texto duas vezes:
 *
 *  - com nome  → nome em cima, telefone formatado embaixo;
 *  - sem nome  → só o telefone formatado, e nada embaixo;
 *  - sem os dois → o rótulo de sempre, que é o que a Inbox já usa.
 *
 *  "Nome" é o `displayName` interno quando ele é um nome de verdade (nome que o
 *  operador deu no CRM vence); sendo só dígitos — o caso dos contatos LID —,
 *  vale o nome que o WhatsApp conhece (`whatsappName`, o salvo no celular, e
 *  depois `whatsappPushName`, o do perfil). É o que faz a linha mostrar a
 *  pessoa em vez de uma sequência de 15 dígitos.
 *
 *  As iniciais só existem quando há nome. Para quem não tem, um número dentro
 *  do círculo não identifica ninguém — o WhatsApp põe a silhueta, e é o que a
 *  ausência de `initials` manda desenhar. */
export type ContactRow = { title: string; subtitle?: string; initials?: string; photoUrl?: string };

export const contactRow = (contact: PickableContact): ContactRow => {
  const name = realName(contact.displayName) ?? realName(contact.whatsappName) ?? realName(contact.whatsappPushName);
  const phone = normalizedPhone(contact.phoneNumber) ? phoneDisplay(contact.phoneNumber) : undefined;
  const photoUrl = contact.photoUrl?.trim() || undefined;
  if (name) return { title: name, ...(phone ? { subtitle: phone } : {}), initials: contactInitials(name), ...(photoUrl ? { photoUrl } : {}) };
  return { title: phone ?? "Contato sem identificação", ...(photoUrl ? { photoUrl } : {}) };
};

/** A silhueta de quem não tem nome nem foto.
 *
 *  Desenho e não glifo: nenhum caractere disponível é uma pessoa, e o que estava
 *  no lugar era o telefone em algarismos dentro do círculo — que não identifica
 *  ninguém e ainda repetia o texto ao lado. Herda a cor do círculo por
 *  `currentColor`, então não traz cor nova. */
const ContactSilhouette = () => (
  <svg className="composer-contact-silhouette" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
    <circle cx="12" cy="8" r="4" fill="currentColor" />
    <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7z" fill="currentColor" />
  </svg>
);

/** Marca e desmarca respeitando o teto. Vive fora do componente porque a caixa
 *  de marcação já chega `disabled` no teto: pela tela este limite é inalcançável,
 *  e só uma função pura pode provar que ele existe. Ele fica porque é o que
 *  separa um envio de 21 cartões de um 400 do servidor, caso o `disabled` saia. */
export const toggleSelection = (current: readonly string[], id: string, max: number) => {
  if (current.includes(id)) return current.filter((value) => value !== id);
  return current.length >= max ? [...current] : [...current, id];
};

/** As fases da tela. `loading` é a abertura, buscando a última sincronização;
 *  `ready` mostra a lista; `error` é só a abertura que falhou (com a
 *  lista pronta, uma recarga que falha vira linha de erro, não tela). O sync
 *  NÃO é fase: roda em paralelo, com a lista visível. */
type Phase = "loading" | "ready" | "error";

/** Junta o lote novo sem repetir contato. A paginação do servidor é por data
 *  de criação, e um contato criado (ou atualizado) entre duas páginas pode
 *  aparecer nas duas — a união por id é o que impede a linha duplicada. */
export const mergeById = (current: readonly PickableContact[], next: readonly PickableContact[]) => {
  const seen = new Set(current.map((contact) => contact.id));
  return [...current, ...next.filter((contact) => !seen.has(contact.id))];
};

/** A lista única de contatos. Mesmas classes de linha do picker antigo — o
 *  teste de CSS que impede a volta da linha empilhada mede exatamente esses
 *  seletores. */
const ContactList = ({ contacts, selected, atLimit, emptyMessage, onToggle }: {
  contacts: PickableContact[];
  selected: readonly string[];
  atLimit: boolean;
  emptyMessage: string;
  onToggle: (id: string) => void;
}) => (
  contacts.length === 0
    ? <p className="composer-contact-state" role="status">{emptyMessage}</p>
    : <ul className="composer-contact-list" aria-label="Contatos">
        {contacts.map((contact) => {
          const checked = selected.includes(contact.id);
          const row = contactRow(contact);
          return (
            <li key={contact.id}>
              <label className={`composer-contact-row${checked ? " selected" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && atLimit}
                  onChange={() => onToggle(contact.id)}
                  aria-label={row.title}
                />
                <span className="composer-contact-avatar" aria-hidden="true">
                  {row.photoUrl ? <img src={row.photoUrl} alt="" /> : row.initials ?? <ContactSilhouette />}
                </span>
                <span className="composer-contact-identity">
                  <strong>{row.title}</strong>
                  {row.subtitle && <span>{row.subtitle}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
);

export const ContactPicker = ({ loadInitial, searchContacts, onSend, onClose, sending, sync, max = 20 }: ContactPickerProps) => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<PickableContact[]>([]);
  const [term, setTerm] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [syncJob, setSyncJob] = useState<ContactSyncState | null>(null);
  /** Sync em andamento (disparo + polling). Não é fase: a lista fica visível
   *  enquanto a agenda atualiza, e é só ela que recarrega quando o job
   *  conclui. */
  const [syncing, setSyncing] = useState(false);
  /** Estado da busca no servidor: null = a tela mostra a lista inicial (os
   *  contatos do celular); número = o total da última busca, que manda no
   *  "Carregar mais". */
  const [searchTotal, setSearchTotal] = useState<number | null>(null);
  const [searchPage, setSearchPage] = useState(1);
  const [searching, setSearching] = useState(false);
  /** A lista do celular fica em cache: limpar a lupa volta para ela sem nova
   *  ida ao servidor. */
  const initialRef = useRef<PickableContact[]>([]);
  /** Ticket contra corrida: digitar rápido dispara buscas em sequência e só
   *  a resposta da ÚLTIMA pode mexer na tela — uma resposta velha que chega
   *  atrasada não sobrescreve um termo que já mudou. */
  const searchSeq = useRef(0);
  const termRef = useRef("");
  termRef.current = term;
  /** O último estado que o polling viu, para a transição para `completed`
   *  disparar o carregamento uma única vez mesmo com ticks de 2 s. */
  const syncRef = useRef<ContactSyncState | null>(null);
  syncRef.current = syncJob;
  /** Referências estáveis para o carregamento e a busca disparados por
   *  efeitos — o efeito não pode depender da função senão rearmaria o
   *  intervalo/debounce a cada render. */
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const searchRef = useRef<(value: string, page: number) => Promise<void>>(async () => {});

  const loadContacts = async () => {
    setError("");
    try {
      const list = await loadInitial();
      initialRef.current = list;
      // Com busca ativa a tela é da busca: a recarga troca o cache do
      // celular, e quem chamou (abertura, fim de sync) refaz a busca se
      // preciso. Sem busca, a lista nova entra direto.
      if (!termRef.current.trim()) setItems(list);
      setPhase("ready");
    } catch {
      setError("Não foi possível carregar os contatos. Tente de novo.");
      // Só a abertura vira tela de erro com "Tentar novamente": com a lista
      // pronta, uma recarga que falha mantém o que estava na tela.
      setPhase((current) => (current === "loading" ? "error" : current));
    }
  };
  loadRef.current = loadContacts;

  const runSearch = async (value: string, page: number) => {
    const ticket = ++searchSeq.current;
    setSearching(true);
    setError("");
    try {
      const result = await searchContacts(value, page);
      if (ticket !== searchSeq.current) return;
      setItems((current) => (page === 1 ? result.items : mergeById(current, result.items)));
      setSearchTotal(result.total);
      setSearchPage(page);
    } catch {
      if (ticket === searchSeq.current) setError("Não foi possível pesquisar os contatos. Tente de novo.");
    } finally {
      if (ticket === searchSeq.current) setSearching(false);
    }
  };
  searchRef.current = runSearch;

  // Abertura: os contatos do celular já estão na base — mostrar é o padrão,
  // e o botão do cabeçalho é quem busca o que mudou desde então.
  useEffect(() => {
    void loadRef.current();
  }, []);

  // A lupa: 300 ms de silêncio antes de bater no servidor, para uma palavra
  // digitada virar UMA busca e não uma por tecla. Limpar o campo derruba
  // qualquer busca em voo e devolve a lista do celular, sem consulta.
  useEffect(() => {
    if (phase !== "ready") return;
    const value = term.trim();
    if (!value) {
      searchSeq.current += 1;
      setSearchTotal(null);
      setSearchPage(1);
      setItems(initialRef.current);
      return;
    }
    const handle = setTimeout(() => { void searchRef.current(value, 1); }, 300);
    return () => clearTimeout(handle);
  }, [term, phase]); // eslint-disable-line react-hooks/exhaustive-deps -- searchRef é estável por desenho; depender dele rearmaria o debounce a cada render

  useEffect(() => {
    if (!sync || !syncing || !syncJob) return;
    const handle = setInterval(() => {
      void (async () => {
        try {
          const latest = await sync.status(syncJob.wahaSession);
          const wasActive = syncRef.current?.status === "pending" || syncRef.current?.status === "running";
          setSyncJob(latest);
          if (wasActive && latest.status === "completed") {
            await loadRef.current();
            // Sync novo muda a base: a busca ativa é refeita do lote 1 para
            // trazer quem acabou de entrar (e sumir com quem saiu).
            const value = termRef.current.trim();
            if (value) await searchRef.current(value, 1);
            setSyncing(false);
          }
          if (wasActive && (latest.status === "failed" || latest.status === "cancelled")) {
            setError(latest.lastErrorSafe ?? "A sincronização de contatos falhou. Tente de novo.");
            setSyncing(false);
          }
        } catch {
          /** Sem o status não há o que mostrar nem o que decidir — parar o
           *  polling é melhor que girar para sempre sobre um job que o
           *  servidor já esqueceu (o store é em memória) ou que a rede
           *  derrubou. O operador dispara de novo pelo botão. */
          setError("Perdemos o andamento da sincronização. Se ela concluiu, os contatos novos aparecem na próxima abertura.");
          setSyncing(false);
        }
      })();
    }, 2000);
    return () => clearInterval(handle);
  }, [sync, syncing, syncJob?.wahaSession]); // eslint-disable-line react-hooks/exhaustive-deps -- syncJob inteiro rearmaria o intervalo a cada tick; a sessão é a única parte que o efeito consome

  const startSync = () => {
    if (!sync || syncing) return;
    setError("");
    setSyncJob(null);
    setSyncing(true);
    void (async () => {
      try {
        setSyncJob(await sync.start());
      } catch {
        setError("Não foi possível iniciar a sincronização. Verifique se há uma sessão WhatsApp conectada.");
        setSyncing(false);
      }
    })();
  };

  const toggle = (id: string) => setSelected((current) => toggleSelection(current, id, max));

  // Ordem alfabética pelo que a linha mostra (nome ou telefone), como a
  // lista de contatos do WhatsApp. A filtragem NÃO é local: é o servidor
  // que devolve os lotes — aqui só se ordena o que está na tela.
  const visible = [...items].sort((a, b) => contactRow(a).title.localeCompare(contactRow(b).title, "pt-BR", { sensitivity: "base" }));

  const atLimit = selected.length >= max;
  const emptyMessage = searchTotal !== null
    ? `Nenhum contato encontrado para “${term.trim()}”.`
    : sync
      ? "Nenhum contato do celular por aqui — toque em Sincronizar contatos para puxar a agenda."
      : "Nenhum contato encontrado.";
  const hasMore = searchTotal !== null && items.length < searchTotal;

  return (
    <div className="composer-contact-overlay" onClick={onClose}>
      <div
        className="composer-contact"
        role="dialog"
        aria-label="Enviar contato"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        }}
      >
        <div className="composer-contact-head">
          <strong>Enviar contato</strong>
          {sync && (
            <button type="button" className="composer-contact-sync" onClick={startSync} disabled={syncing}>
              {syncing ? "Sincronizando…" : "Sincronizar contatos"}
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Fechar envio de contato">×</button>
        </div>

        {syncing && (
          <p className="composer-contact-sync-state" role="status">
            {syncJob ? `${syncJob.progressLabel} · ${syncJob.contactsProcessed} contatos` : "Iniciando a sincronização…"}
          </p>
        )}
        {!syncing && syncJob?.status === "completed" && syncJob.lastErrorSafe && (
          <p className="composer-contact-sync-state warn" role="status">{syncJob.lastErrorSafe}</p>
        )}
        {error && <p className="composer-contact-error" role="alert">{error}</p>}

        {phase === "loading" && <p className="composer-contact-state" role="status">Carregando contatos…</p>}

        {phase === "error" && (
          <div className="composer-contact-empty">
            <button type="button" className="composer-contact-load" onClick={() => { setPhase("loading"); void loadRef.current(); }}>
              Tentar novamente
            </button>
          </div>
        )}

        {phase === "ready" && (
          <>
            <label className="composer-contact-search">
              <span>Buscar em todos os contatos</span>
              <input
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Nome ou telefone"
                aria-label="Buscar contato por nome ou telefone"
                autoFocus
              />
            </label>
            {searching && <p className="composer-contact-state" role="status">Buscando…</p>}
            <ContactList contacts={visible} selected={selected} atLimit={atLimit} emptyMessage={emptyMessage} onToggle={toggle} />
            {hasMore && (
              <button
                type="button"
                className="composer-contact-more"
                onClick={() => void searchRef.current(term.trim(), searchPage + 1)}
                disabled={searching}
              >
                Carregar mais ({items.length} de {searchTotal})
              </button>
            )}
            {atLimit && <p className="composer-contact-limit" role="status">Máximo de {max} contatos por envio.</p>}
          </>
        )}

        <div className="composer-contact-actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button
            type="button"
            className="composer-contact-send"
            onClick={() => onSend(selected)}
            disabled={!selected.length || sending}
          >
            {sending ? "Enviando…" : selected.length > 1 ? `Enviar ${selected.length} contatos` : "Enviar contato"}
          </button>
        </div>
      </div>
    </div>
  );
};
