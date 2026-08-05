import type { GroupParticipant } from "../api/inbox.js";
import { isGroupAdmin, participantDisplay } from "./mentions.js";
import { phoneDisplay } from "./messageMedia.js";

/**
 * Popup do `@` em grupos — a filtragem e o índice ativo ficam no pai (Inbox),
 * que é quem conhece o textarea; aqui só a lista e a seleção. Visual na mesma
 * receita do `.composer-contact`, com classe própria `.composer-mention`.
 */
export type MentionAutocompleteProps = {
  items: GroupParticipant[];
  loading: boolean;
  failed: boolean;
  activeIndex: number;
  onSelect: (participant: GroupParticipant) => void;
  onHover: (index: number) => void;
  onClose: () => void;
};

const initials = (display: string): string => {
  const parts = display.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "@";
};

export const MentionAutocomplete = ({ items, loading, failed, activeIndex, onSelect, onHover, onClose }: MentionAutocompleteProps) => (
  <span className="composer-mention" role="listbox" aria-label="Participantes do grupo" onKeyDown={(event) => event.key === "Escape" && onClose()}>
    {loading && <span className="composer-mention-empty">Carregando participantes…</span>}
    {!loading && failed && <span className="composer-mention-empty">Não foi possível carregar — feche e tente o @ de novo</span>}
    {!loading && !failed && items.length === 0 && <span className="composer-mention-empty">Nenhum participante encontrado</span>}
    {!loading && !failed && items.map((participant, index) => {
      const display = participantDisplay(participant);
      return (
        <button
          key={participant.whatsappId}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`composer-mention-item${index === activeIndex ? " active" : ""}`}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(participant)}
        >
          {participant.avatarUrl ? <img src={participant.avatarUrl} alt="" /> : <i>{initials(display)}</i>}
          <span>
            <strong>{display}</strong>
            {participant.phone && <small>{phoneDisplay(participant.phone)}</small>}
          </span>
          {isGroupAdmin(participant.role) && <em>admin</em>}
        </button>
      );
    })}
  </span>
);
