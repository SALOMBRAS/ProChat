import { useCallback, useEffect, useRef, useState } from "react";
import { InboxApi, type SlaOperationalSummary } from "../api/inbox.js";
import { connectRealtime } from "../api/realtime.js";

const defaultApi = new InboxApi();
const refreshIntervalMs = 60_000;
const realtimeDebounceMs = 750;
const workspaceId = import.meta.env.VITE_WORKSPACE_ID || "default-workspace";

type SlaOperationalDashboardProps = {
  api?: Pick<InboxApi, "slaSummary">;
  workspaceId?: string;
  onOpenConversation: (conversationId: string) => void;
};

export const formatSlaDuration = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const remainingSeconds = total % 60;
  if (minutes < 60)
    return remainingSeconds ? `${minutes} min ${remainingSeconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
};

export const formatSlaPercentage = (value: number) =>
  `${Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)))}%`;

const statusLabel: Record<SlaOperationalSummary["critical"][number]["status"], string> = {
  waiting_operator: "Aguardando atendente",
  waiting_customer: "Aguardando cliente",
  answered: "Respondida",
  resolved: "Resolvida",
  expired: "Atrasada",
  archived: "Arquivada",
};

const deadlineLabel = (deadlineAt: string | null, now: number) => {
  if (!deadlineAt) return "Sem prazo";
  const deadline = new Date(deadlineAt).getTime();
  if (Number.isNaN(deadline)) return "Sem prazo";
  const seconds = Math.round(Math.abs(deadline - now) / 1_000);
  return deadline < now
    ? `Atrasado há ${formatSlaDuration(seconds)}`
    : `Vence em ${formatSlaDuration(seconds)}`;
};

const generatedAtLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Atualização recente";
  return `Atualizado às ${date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

export function SlaOperationalDashboard({
  api = defaultApi,
  workspaceId: currentWorkspaceId = workspaceId,
  onOpenConversation,
}: SlaOperationalDashboardProps) {
  const [summary, setSummary] = useState<SlaOperationalSummary>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const refreshQueued = useRef(false);
  const requestVersion = useRef(0);
  const lastFetchAt = useRef(0);
  const realtimeTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      refreshQueued.current = true;
      return;
    }
    inFlight.current = true;
    const version = ++requestVersion.current;
    if (mounted.current) {
      if (lastFetchAt.current) setRefreshing(true);
      else setLoading(true);
      setError("");
    }
    try {
      const result = await api.slaSummary();
      if (!mounted.current || version !== requestVersion.current) return;
      setSummary(result);
      lastFetchAt.current = Date.now();
      setNow(lastFetchAt.current);
    } catch (nextError) {
      if (!mounted.current || version !== requestVersion.current) return;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Não foi possível atualizar o painel SLA.",
      );
    } finally {
      inFlight.current = false;
      if (mounted.current && version === requestVersion.current) {
        setLoading(false);
        setRefreshing(false);
      }
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refresh();
      }
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
      if (realtimeTimer.current) clearTimeout(realtimeTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.hidden) return;
      setNow(Date.now());
      void refresh();
    };
    const timer = window.setInterval(refreshIfVisible, refreshIntervalMs);
    const onVisibilityChange = () => {
      if (
        !document.hidden &&
        Date.now() - lastFetchAt.current >= refreshIntervalMs
      )
        refreshIfVisible();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  useEffect(
    () =>
      connectRealtime((event) => {
        if (
          event.workspaceId !== currentWorkspaceId ||
          ![
            "conversation.sla.updated",
            "conversation.kanban.moved",
            "conversation.updated",
          ].includes(event.eventType)
        )
          return;
        if (realtimeTimer.current) clearTimeout(realtimeTimer.current);
        realtimeTimer.current = window.setTimeout(() => {
          realtimeTimer.current = undefined;
          void refresh();
        }, realtimeDebounceMs);
      }),
    [currentWorkspaceId, refresh],
  );

  const metrics = summary
    ? [
        ["Atendimentos ativos", summary.totals.active, "Em operação", "neutral"],
        [
          "Aguardando atendente",
          summary.totals.waitingOperator,
          "Cliente aguardando resposta",
          "purple",
        ],
        ["Em atenção", summary.totals.warning, "Próximos do prazo", "yellow"],
        ["Fora do SLA", summary.totals.overdue, "Atendimentos atrasados", "red"],
        [
          "Dentro do SLA",
          formatSlaPercentage(summary.percentages.withinSla),
          "Do total ativo",
          "green",
        ],
        [
          "Tempo médio da primeira resposta",
          formatSlaDuration(summary.averages.firstResponseSeconds),
          "Tempo até o primeiro retorno",
          "neutral",
        ],
      ] as const
    : [];

  return (
    <section className="sla-operational" aria-labelledby="sla-operational-title">
      <div className="sla-operational-heading">
        <div>
          <p className="eyebrow">OPERAÇÃO SLA</p>
          <h2 id="sla-operational-title">Visão operacional do atendimento</h2>
        </div>
        {summary && (
          <small aria-live="polite">
            {refreshing ? "Atualizando…" : generatedAtLabel(summary.generatedAt)}
          </small>
        )}
      </div>

      {loading && !summary ? (
        <div className="sla-metric-grid" aria-label="Carregando métricas SLA">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="sla-skeleton" key={index} />
          ))}
        </div>
      ) : (
        <>
          <div className="sla-metric-grid">
            {metrics.map(([title, value, description, tone]) => (
              <article className={`sla-metric-card sla-${tone}`} key={title}>
                <span className="sla-metric-tone" aria-hidden="true" />
                <div>
                  <span>{title}</span>
                  <strong>{value}</strong>
                  <small>{description}</small>
                </div>
              </article>
            ))}
          </div>

          {summary && (
            <div className="sla-secondary-metrics">
              <span>
                Espera média do atendente: {formatSlaDuration(summary.averages.operatorWaitSeconds)}
              </span>
              <span>
                Espera média do cliente: {formatSlaDuration(summary.averages.customerWaitSeconds)}
              </span>
              <span>Congeladas: {summary.totals.frozen}</span>
            </div>
          )}

          <section className="sla-critical-list" aria-labelledby="sla-critical-title">
            <div className="sla-critical-heading">
              <div>
                <h3 id="sla-critical-title">Atendimentos que exigem atenção</h3>
                <p>Priorizados pelo prazo operacional atual.</p>
              </div>
              <span>{summary?.critical.length ?? 0} em foco</span>
            </div>
            {summary?.critical.length ? (
              <div className="sla-critical-items">
                {summary.critical.slice(0, 20).map((item) => {
                  const label = item.contactName?.trim() || `Conversa ${item.conversationId.slice(0, 8)}`;
                  return (
                    <button
                      type="button"
                      className={`sla-critical-item sla-${item.indicator}`}
                      key={item.conversationId}
                      onClick={() => onOpenConversation(item.conversationId)}
                      aria-label={`Abrir ${label}: ${statusLabel[item.status]}, ${deadlineLabel(item.deadlineAt, now)}`}
                    >
                      <span className="sla-critical-indicator" aria-hidden="true" />
                      <span className="sla-critical-copy">
                        <strong>{label}</strong>
                        <small>{statusLabel[item.status]}</small>
                      </span>
                      <span className="sla-critical-deadline">
                        {deadlineLabel(item.deadlineAt, now)}
                      </span>
                      <span className="sla-critical-action" aria-hidden="true">Abrir →</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="sla-critical-empty">
                <span aria-hidden="true">✓</span>
                <p>Nenhum atendimento exige atenção neste momento.</p>
              </div>
            )}
          </section>
        </>
      )}

      {error && (
        <div className="sla-operational-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void refresh()}>
            Tentar novamente
          </button>
        </div>
      )}
    </section>
  );
}
