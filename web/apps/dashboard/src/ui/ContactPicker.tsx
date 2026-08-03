import { useEffect, useRef, useState } from "react";
import { normalizedPhone, realName } from "./contactIdentity.js";
import { phoneDisplay } from "./messageMedia.js";

/** Escolha de contato para enviar como cartão.
 *
 *  O que havia aqui era `window.prompt` duas vezes: uma pedindo o termo de busca
 *  e outra pedindo o número do item numa lista numerada colada dentro da caixa do
 *  sistema. A PR #53 deixou isso de propósito, como UI mínima para validar o
 *  caminho de envio. O caminho está validado; a caixa branca do Chrome não
 *  pertence ao produto.
 *
 *  Diferente do AttachmentComposer, que é presentacional e deixa todo o estado no
 *  Inbox, esta tela guarda o próprio termo, página e seleção. O motivo é que
 *  nenhum desses três tem consumidor fora daqui — o Inbox só precisa saber quais
 *  ids sair enviando. Manter isso local também evita crescer um arquivo que já
 *  tem 1500 linhas.
 */

/** Só o que a lista precisa. Estrutural de propósito: evita amarrar a tela ao
 *  formato completo de contato, que carrega workspaceId e datas sem uso aqui.
 *
 *  `photoUrl` é opcional porque hoje **não chega**: `/domain/contacts` devolve
 *  id, workspaceId, displayName, phoneNumber, email, company e datas, e nada
 *  mais. A foto existe na base — `whatsapp_identities.profile_picture_url`, em
 *  552 das 748 identidades medidas em 03/08/2026 —, só não passa por este
 *  contrato. O campo fica declarado para a lista já saber desenhá-la: expor a
 *  coluna é mudança de `apps/api/src`. */
export type PickableContact = { id: string; displayName: string; phoneNumber: string; photoUrl?: string | null };

export type ContactPickerProps = {
  /** A busca já filtra no banco (PR #22) — só o que casa viaja pela rede. Recebe
   *  a página porque a base cresce; hoje são 79 contatos. */
  search: (term: string, page: number) => Promise<{ items: PickableContact[]; total: number }>;
  onSend: (contactIds: string[]) => void;
  onClose: () => void;
  sending: boolean;
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

export const ContactPicker = ({ search, onSend, onClose, sending, max = 20 }: ContactPickerProps) => {
  const [term, setTerm] = useState("");
  const [items, setItems] = useState<PickableContact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  /** Cada busca leva um selo. Uma resposta antiga que chegue depois de uma nova
   *  ter sido disparada é descartada, senão digitar rápido deixa a lista
   *  mostrando o resultado do termo anterior. */
  const requestRef = useRef(0);

  useEffect(() => {
    const handle = setTimeout(() => {
      const token = ++requestRef.current;
      setLoading(true);
      setError("");
      void (async () => {
        try {
          const result = await search(term.trim(), 1);
          if (token !== requestRef.current) return;
          setItems(result.items);
          setTotal(result.total);
          setPage(1);
        } catch {
          if (token !== requestRef.current) return;
          setError("Não foi possível buscar os contatos. Tente de novo.");
          setItems([]);
          setTotal(0);
        } finally {
          if (token === requestRef.current) setLoading(false);
        }
      })();
    }, term ? 250 : 0);
    return () => clearTimeout(handle);
  }, [term, search]);

  const loadMore = async () => {
    const token = ++requestRef.current;
    setLoading(true);
    try {
      const next = page + 1;
      const result = await search(term.trim(), next);
      if (token !== requestRef.current) return;
      setItems((current) => [...current, ...result.items]);
      setTotal(result.total);
      setPage(next);
    } catch {
      if (token === requestRef.current) setError("Não foi possível carregar mais contatos.");
    } finally {
      if (token === requestRef.current) setLoading(false);
    }
  };

  const toggle = (id: string) => setSelected((current) => toggleSelection(current, id, max));

  const atLimit = selected.length >= max;
  const hasMore = items.length < total;

  return (
    <div
      className="composer-contact"
      role="dialog"
      aria-label="Enviar contato"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      }}
    >
      <div className="composer-contact-head">
        <strong>Enviar contato</strong>
        <button type="button" onClick={onClose} aria-label="Fechar envio de contato">×</button>
      </div>
      <label className="composer-contact-search">
        <span>Buscar contato</span>
        <input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Nome, telefone ou e-mail"
          aria-label="Buscar contato por nome, telefone ou e-mail"
          autoFocus
        />
      </label>
      {error && <p className="composer-contact-error" role="alert">{error}</p>}
      {loading && !items.length
        ? <p className="composer-contact-state" role="status">Carregando contatos…</p>
        : !items.length
          ? <p className="composer-contact-state" role="status">Nenhum contato encontrado.</p>
          : <ul className="composer-contact-list" aria-label="Contatos encontrados" aria-busy={loading}>
              {items.map((contact) => {
                const checked = selected.includes(contact.id);
                const row = contactRow(contact);
                return (
                  <li key={contact.id}>
                    <label className={`composer-contact-row${checked ? " selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && atLimit}
                        onChange={() => toggle(contact.id)}
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
      {hasMore && <button type="button" className="composer-contact-more" onClick={() => void loadMore()} disabled={loading}>
        {loading ? "Carregando…" : `Carregar mais (${items.length} de ${total})`}
      </button>}
      {atLimit && <p className="composer-contact-limit" role="status">Máximo de {max} contatos por envio.</p>}
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
  );
};
