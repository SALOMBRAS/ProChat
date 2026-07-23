import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceUser } from "@chatpro/contracts";
import { InboxApi, type KanbanBoard, type KanbanCard } from "../api/inbox.js";
import { connectRealtime } from "../api/realtime.js";
import { WorkspaceApi } from "../api/workspace.js";

const api = new InboxApi();
const workspaceApi = new WorkspaceApi();
const pageSize = 30;
const workspaceId = import.meta.env.VITE_WORKSPACE_ID || "default-workspace";
type CardsByStage = Record<string, KanbanCard[]>;

const priorityLabel: Record<KanbanCard["priority"], string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};

function cardName(card: KanbanCard) {
  return card.conversationType === "group" ? `Grupo · ${card.maskedId}` : card.maskedId;
}

function initials(card: KanbanCard) {
  const digits = card.maskedId.replace(/\D/g, "");
  return (digits.slice(-2) || "CP").toUpperCase();
}

const slaClass = (card: KanbanCard) => card.sla ? `sla-${card.sla.indicator}` : "sla-neutral";
const minutesLabel = (milliseconds: number) => { const minutes = Math.max(0, Math.floor(milliseconds / 60_000)); return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}min`; };
const slaLabel = (card: KanbanCard, now: number) => {
  if (!card.sla) return "Sem métrica SLA";
  if (card.sla.status === "waiting_operator") return card.sla.deadlineAt && new Date(card.sla.deadlineAt).getTime() < now ? `Atrasado há ${minutesLabel(now - new Date(card.sla.deadlineAt).getTime())}` : "Aguardando atendente";
  if (card.sla.status === "waiting_customer") return "Aguardando cliente";
  if (card.sla.status === "resolved") return "Resolvido";
  if (card.sla.status === "archived") return "Arquivado";
  return card.sla.indicator === "yellow" ? "Atenção" : card.sla.indicator === "red" ? "Atrasado" : "Dentro do prazo";
};

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Agora" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function InboxKanban() {
  const [board, setBoard] = useState<KanbanBoard>();
  const [cards, setCards] = useState<CardsByStage>({});
  const [users, setUsers] = useState<Record<string, WorkspaceUser>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [movingId, setMovingId] = useState<string>();
  const [draggedCard, setDraggedCard] = useState<KanbanCard>();
  const [clock, setClock] = useState(() => Date.now());
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const [nextBoard] = await api.kanbanBoards();
      if (!nextBoard) throw new Error("Nenhum quadro Kanban está configurado para este workspace.");
      const stagePages = await Promise.all(nextBoard.stages.map(async (stage) => [stage.id, await api.kanbanCards(nextBoard.id, stage.id, 1, pageSize)] as const));
      if (version !== requestVersion.current) return;
      setBoard(nextBoard);
      setCards(Object.fromEntries(stagePages.map(([stageId, page]) => [stageId, page.items])));
      setError("");
    } catch {
      if (version === requestVersion.current) {
        setBoard(undefined);
        setCards({});
        setError("Não foi possível carregar o Kanban persistido. Tente novamente.");
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void workspaceApi.users().then((directory) => setUsers(Object.fromEntries(directory.map((user) => [user.id, user])))).catch(() => undefined);
    return connectRealtime((event) => {
      if (event.workspaceId !== workspaceId) return;
      if (event.eventType === "conversation.sla.updated") {
        const conversationId = typeof event.payload.conversationId === "string" ? event.payload.conversationId : "";
        const metrics = event.payload.metrics as { status?: KanbanCard["slaStatus"]; slaIndicator?: "green" | "yellow" | "red"; deadlineAt?: string | null } | undefined;
        const status = metrics?.status;
        const indicator = metrics?.slaIndicator;
        if (conversationId && status && indicator) setCards((current) => Object.fromEntries(Object.entries(current).map(([stageId, items]) => [stageId, items.map((card) => card.conversationId === conversationId ? { ...card, slaStatus: status, sla: { status: status as NonNullable<KanbanCard["sla"]>["status"], indicator, deadlineAt: metrics?.deadlineAt ?? null } } : card)])));
        return;
      }
      if (["conversation.kanban.moved", "kanban.stage.created", "kanban.stage.updated", "kanban.stage.reordered"].includes(event.eventType)) void load();
    });
  }, [load]);
  useEffect(() => {
    const refreshClock = () => setClock(Date.now());
    const onVisibilityChange = () => { if (!document.hidden) refreshClock(); };
    const timer = window.setInterval(refreshClock, 60_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, []);

  const move = async (card: KanbanCard, targetStageId: string) => {
    if (!board || movingId || card.stageId === targetStageId) return;
    const snapshot = cards;
    const destination = cards[targetStageId] ?? [];
    const anchor = destination[0];
    const optimistic = { ...card, stageId: targetStageId, position: (anchor?.position ?? 0) + 1 };
    setMovingId(card.conversationId);
    setCards((current) => ({
      ...current,
      [card.stageId]: (current[card.stageId] ?? []).filter((item) => item.conversationId !== card.conversationId),
      [targetStageId]: [optimistic, ...(current[targetStageId] ?? []).filter((item) => item.conversationId !== card.conversationId)],
    }));
    try {
      const persisted = await api.moveKanban(card.conversationId, {
        boardId: board.id,
        stageId: targetStageId,
        ...(anchor ? { afterConversationId: anchor.conversationId } : {}),
        source: "manual",
        expectedUpdatedAt: card.updatedAt,
      }) as { updatedAt?: string; updated_at?: string };
      const updatedAt = persisted.updatedAt ?? persisted.updated_at;
      if (updatedAt) setCards((current) => Object.fromEntries(Object.entries(current).map(([stageId, items]) => [stageId, items.map((item) => item.conversationId === card.conversationId ? { ...item, updatedAt } : item)])));
    } catch {
      setCards(snapshot);
      setError("A movimentação conflitou ou falhou. O card foi restaurado.");
      void load();
    } finally {
      setMovingId(undefined);
      setDraggedCard(undefined);
    }
  };

  return <section className="page local-kanban">
    <div className="kanban-toolbar">
      <div>
        <p className="eyebrow">INBOX OPERACIONAL</p>
        <h2>{board?.name ?? "Kanban de atendimento"}</h2>
        <p>Quadro persistido e sincronizado para todos os atendentes.</p>
      </div>
      <div className="kanban-sla-legend" aria-label="Legenda de SLA"><span className="sla-green">Dentro do prazo</span><span className="sla-yellow">Atenção</span><span className="sla-red">Atrasado</span></div>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading && !board ? <p className="inbox-loading">Carregando quadro persistido…</p> : !board ? null : <div className="local-kanban-board">
      {board.stages.map((stage) => {
        const stageCards = cards[stage.id] ?? [];
        return <section className="local-kanban-column" key={stage.id} aria-label={stage.name} onDragOver={(event) => event.preventDefault()} onDrop={() => draggedCard && void move(draggedCard, stage.id)}>
          <header><div><h3>{stage.name}</h3><small>{stage.count} conversa{stage.count === 1 ? "" : "s"}</small></div><b>{stageCards.length}</b></header>
          <div className="local-kanban-cards">
            {stageCards.map((card) => {
              const assignee = card.assignedUserId ? users[card.assignedUserId] : undefined;
              return <article className="local-kanban-card" key={card.conversationId} draggable={movingId === undefined} aria-grabbed={draggedCard?.conversationId === card.conversationId} onDragStart={() => setDraggedCard(card)} onDragEnd={() => setDraggedCard(undefined)}>
                <div className="local-kanban-card-head"><span className="local-kanban-avatar">{initials(card)}</span><div><strong title={cardName(card)}>{cardName(card)}</strong><time>{timeLabel(card.lastMessageAt)}</time></div><i className={`local-sla ${slaClass(card)}`} title={slaLabel(card, clock)} /></div>
                <p>{card.lastMessage || "Sem mensagem de texto"}</p>
                <small className={`local-kanban-sla-copy ${slaClass(card)}`}>{slaLabel(card, clock)}</small>
                <div className="local-kanban-meta"><span title={assignee?.displayName ?? "Nenhum responsável atribuído"}>{assignee ? `Responsável: ${assignee.displayName}` : "Sem responsável"}</span><b className={`priority-${card.priority}`}>{priorityLabel[card.priority]}</b></div>
                <div className="local-kanban-tags">{card.tags.length ? card.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>) : <span>Sem etiquetas</span>}</div>
              </article>;
            })}
            {!stageCards.length && <p className="local-kanban-empty">Solte conversas aqui</p>}
            {stage.count > stageCards.length && <p className="kanban-page-note">Mostrando {stageCards.length} de {stage.count}</p>}
          </div>
        </section>;
      })}
    </div>}
  </section>;
}
