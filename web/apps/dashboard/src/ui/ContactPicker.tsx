import { useEffect, useRef, useState } from "react";
import { safeContactText, safePhoneText } from "./contactIdentity.js";

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
 *  formato completo de contato, que carrega workspaceId e datas sem uso aqui. */
export type PickableContact = { id: string; displayName: string; phoneNumber: string };

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

/** Iniciais do nome. A listagem de contatos não devolve foto — `contactSchema`
 *  tem id, workspaceId, displayName, phoneNumber e datas, e nada mais —, então
 *  este é o único avatar possível aqui, não um fallback. */
export const contactInitials = (displayName: string) => {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1]?.[0] ?? "" : "";
  const label = `${first}${last}`.toUpperCase();
  return label || "?";
};

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
                return (
                  <li key={contact.id}>
                    <label className={`composer-contact-row${checked ? " selected" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!checked && atLimit}
                        onChange={() => toggle(contact.id)}
                        aria-label={safeContactText(contact.displayName)}
                      />
                      <span className="composer-contact-avatar" aria-hidden="true">{contactInitials(contact.displayName)}</span>
                      <span className="composer-contact-identity">
                        <strong>{safeContactText(contact.displayName)}</strong>
                        <span>{safePhoneText(contact.phoneNumber)}</span>
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
