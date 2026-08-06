import { useEffect, useRef, useState } from "react";
import { normalizedPhone, realName } from "./contactIdentity.js";
import { phoneDisplay } from "./messageMedia.js";

/** Escolha de contato para enviar como cartão, no padrão do WhatsApp: uma
 *  janela flutuante que abre VAZIA — nenhuma lista pré-carregada, porque a base
 *  mistura contatos de várias origens e despejar tudo sem filtro foi o que
 *  encheu a tela de linhas sem sentido. O operador dispara a sincronização
 *  (agenda do celular + histórico de conversas) e só então a lista aparece,
 *  em DUAS COLUNAS separadas por origem, com busca local nas duas.
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
 *  `origin` separa as duas colunas: 'phonebook' = veio da agenda do celular
 *  (sync com fonte 'waha_contact_sync'), 'history' = veio das conversas, do
 *  webhook ou de cadastro manual. */
export type PickableContact = { id: string; displayName: string; phoneNumber: string; photoUrl?: string | null; origin?: "phonebook" | "history" | null };

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
  /** Carrega TODOS os contatos do workspace (o Inbox pagina de 100 em 100 por
   *  dentro). Só é chamada depois de uma sincronização concluída ou do atalho
   *  "já sincronizei" — nunca na abertura, que é deliberadamente vazia. A
   *  busca é local sobre essa lista: digitar não bate no servidor. */
  loadAll: () => Promise<PickableContact[]>;
  onSend: (contactIds: string[]) => void;
  onClose: () => void;
  sending: boolean;
  /** Sincronização da agenda do WhatsApp conectado. Opcional: telas sem sessão
   *  de trabalho à mão (testes, usos futuros fora do Inbox) mostram só o
   *  atalho de carregar o que já está sincronizado. */
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
 *  As iniciais só existem quando há nome. Para quem não tem, um número dentro
 *  do círculo não identifica ninguém — o WhatsApp põe a silhueta, e é o que a
 *  ausência de `initials` manda desenhar. */
export type ContactRow = { title: string; subtitle?: string; initials?: string; photoUrl?: string };

export const contactRow = (contact: PickableContact): ContactRow => {
  const name = realName(contact.displayName);
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

/** As fases da tela. `idle` é a abertura vazia; `syncing` acompanha o job;
 *  `loading` busca a base depois do sync (ou do atalho); `ready` mostra as
 *  duas colunas. */
type Phase = "idle" | "syncing" | "loading" | "ready";

/** Uma coluna de contatos (celular ou histórico). Mesmas classes de linha do
 *  picker antigo — o teste de CSS que impede a volta da linha empilhada mede
 *  exatamente esses seletores. */
const ContactColumn = ({ title, contacts, selected, atLimit, onToggle }: {
  title: string;
  contacts: PickableContact[];
  selected: readonly string[];
  atLimit: boolean;
  onToggle: (id: string) => void;
}) => (
  <section className="composer-contact-column">
    <h3>{title} <span className="composer-contact-count">{contacts.length}</span></h3>
    {contacts.length === 0
      ? <p className="composer-contact-state" role="status">Nenhum contato encontrado.</p>
      : <ul className="composer-contact-list" aria-label={title}>
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
        </ul>}
  </section>
);

export const ContactPicker = ({ loadAll, onSend, onClose, sending, sync, max = 20 }: ContactPickerProps) => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [items, setItems] = useState<PickableContact[]>([]);
  const [term, setTerm] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [syncJob, setSyncJob] = useState<ContactSyncState | null>(null);
  /** O último estado que o polling viu, para a transição para `completed`
   *  disparar o carregamento uma única vez mesmo com ticks de 2 s. */
  const syncRef = useRef<ContactSyncState | null>(null);
  syncRef.current = syncJob;
  /** Referência estável para o carregamento disparado pelo polling — o efeito
   *  não pode depender da função senão rearmaria o intervalo a cada render. */
  const loadRef = useRef<() => Promise<void>>(async () => {});

  const loadContacts = async () => {
    setPhase("loading");
    setError("");
    try {
      setItems(await loadAll());
      setPhase("ready");
    } catch {
      setError("Não foi possível carregar os contatos. Tente de novo.");
      setPhase("idle");
    }
  };
  loadRef.current = loadContacts;

  useEffect(() => {
    if (!sync || phase !== "syncing" || !syncJob) return;
    const handle = setInterval(() => {
      void (async () => {
        try {
          const latest = await sync.status(syncJob.wahaSession);
          const wasActive = syncRef.current?.status === "pending" || syncRef.current?.status === "running";
          setSyncJob(latest);
          if (wasActive && latest.status === "completed") {
            setPhase("loading");
            await loadRef.current();
          }
          if (wasActive && (latest.status === "failed" || latest.status === "cancelled")) {
            setError(latest.lastErrorSafe ?? "A sincronização de contatos falhou. Tente de novo.");
            setPhase("idle");
          }
        } catch {
          /** Sem o status não há o que mostrar nem o que decidir — parar o
           *  polling é melhor que girar para sempre sobre um job que o
           *  servidor já esqueceu (o store é em memória) ou que a rede
           *  derrubou. O operador dispara de novo pelo botão. */
          setError("Perdemos o andamento da sincronização. Se ela concluiu, carregue os contatos pelo atalho.");
          setPhase("idle");
        }
      })();
    }, 2000);
    return () => clearInterval(handle);
  }, [sync, phase, syncJob?.wahaSession]); // eslint-disable-line react-hooks/exhaustive-deps -- syncJob inteiro rearmaria o intervalo a cada tick; a sessão é a única parte que o efeito consome

  const startSync = () => {
    if (!sync || phase === "syncing") return;
    setError("");
    void (async () => {
      try {
        setSyncJob(await sync.start());
        setPhase("syncing");
      } catch {
        setError("Não foi possível iniciar a sincronização. Verifique se há uma sessão WhatsApp conectada.");
      }
    })();
  };

  const toggle = (id: string) => setSelected((current) => toggleSelection(current, id, max));

  const query = term.trim().toLowerCase();
  const digits = query.replace(/\D/g, "");
  const matches = (contact: PickableContact) => {
    if (!query) return true;
    if (contact.displayName.toLowerCase().includes(query)) return true;
    return digits.length > 0 && contact.phoneNumber.includes(digits);
  };
  const phonebook = items.filter((contact) => contact.origin === "phonebook" && matches(contact));
  const history = items.filter((contact) => contact.origin !== "phonebook" && matches(contact));

  const atLimit = selected.length >= max;

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
          <button type="button" onClick={onClose} aria-label="Fechar envio de contato">×</button>
        </div>

        {phase === "idle" && (
          <div className="composer-contact-empty">
            <p><strong>Nenhum contato carregado.</strong></p>
            <p className="composer-contact-hint">
              Sincronize para puxar os contatos salvos no celular e os contatos do histórico de conversas — cada um na sua coluna.
            </p>
            {sync && (
              <button type="button" className="composer-contact-sync-primary" onClick={startSync}>
                Sincronizar contatos
              </button>
            )}
            <button type="button" className="composer-contact-load" onClick={() => void loadContacts()}>
              Já sincronizei — carregar contatos
            </button>
            {error && <p className="composer-contact-error" role="alert">{error}</p>}
          </div>
        )}

        {phase === "syncing" && (
          <div className="composer-contact-empty" role="status">
            <p><strong>Sincronizando contatos…</strong></p>
            <p className="composer-contact-hint">
              {syncJob ? `${syncJob.progressLabel} · ${syncJob.contactsProcessed} contatos` : "Iniciando a sincronização…"}
            </p>
          </div>
        )}

        {phase === "loading" && <p className="composer-contact-state" role="status">Carregando contatos…</p>}

        {phase === "ready" && (
          <>
            {syncJob?.status === "completed" && syncJob.lastErrorSafe && (
              <p className="composer-contact-sync-state warn" role="status">{syncJob.lastErrorSafe}</p>
            )}
            <label className="composer-contact-search">
              <span>Buscar contato</span>
              <input
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Nome ou telefone"
                aria-label="Buscar contato por nome ou telefone"
                autoFocus
              />
            </label>
            <div className="composer-contact-columns">
              <ContactColumn title="Salvos no celular" contacts={phonebook} selected={selected} atLimit={atLimit} onToggle={toggle} />
              <ContactColumn title="Histórico de conversas" contacts={history} selected={selected} atLimit={atLimit} onToggle={toggle} />
            </div>
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
