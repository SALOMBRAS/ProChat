import type { GroupParticipant } from "../api/inbox.js";
import { participantDisplay } from "./mentions.js";

const initialsOf = (value: string) => value.trim().slice(0, 2).toUpperCase();
const isAdmin = (role: string | null) => role === "admin" || role === "superadmin";

export const MentionAutocomplete = ({
  items,
  activeIndex,
  loading = false,
  error = false,
  onSelect,
  onHover,
  onRetry,
}: {
  items: GroupParticipant[];
  activeIndex: number;
  loading?: boolean;
  error?: boolean;
  onSelect: (participant: GroupParticipant) => void;
  onHover: (index: number) => void;
  onRetry: () => void;
}) => (
  <div className="composer-mention" id="composer-mention-list" role="listbox" aria-label="Participantes do grupo">
    {loading ? (
      <p className="composer-mention-empty" role="status">Carregando participantes…</p>
    ) : error ? (
      <p className="composer-mention-empty" role="alert">
        Não foi possível carregar os participantes.{" "}
        <button type="button" onClick={onRetry}>Tentar novamente</button>
      </p>
    ) : !items.length ? (
      <p className="composer-mention-empty">Nenhum participante encontrado.</p>
    ) : (
      items.map((participant, index) => {
        const display = participantDisplay(participant);
        return (
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={`composer-mention-item${index === activeIndex ? " active" : ""}`}
            key={participant.whatsappId}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(participant);
            }}
            onMouseEnter={() => onHover(index)}
          >
            <span className="composer-mention-avatar">
              {participant.avatarUrl ? <img src={participant.avatarUrl} alt="" /> : initialsOf(display)}
            </span>
            <span className="composer-mention-copy">
              <strong>{display}</strong>
              <span>{participant.phone ?? participant.whatsappId.split("@", 1)[0]}</span>
            </span>
            {isAdmin(participant.role) && <em className="composer-mention-admin">admin</em>}
          </button>
        );
      })
    )}
  </div>
);
