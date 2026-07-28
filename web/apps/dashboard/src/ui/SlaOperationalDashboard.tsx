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

const isTechnicalIdentifier = (value: string) => /@(?:lid|s\.whatsapp\.net|g\.us|broadcast|newsletter)\b/i.test(value) || /^(?:[a-z0-9_-]+:){2,}[a-z0-9_-]+$/i.test(value);
export const criticalContactLabel = (item: SlaOperationalSummary["critical"][number]) => {
  const name = item.displayName?.trim();
  if (name && !isTechnicalIdentifier(name)) return name;
  const phone = item.phoneNumber?.trim();
  if (phone && (!isTechnicalIdentifier(phone) || /@c\.us$/i.test(phone))) {
    const digits = phone.replace(/\D/g, "");
    if (digits.length >= 8 && digits.length <= 15) return digits;
  }
  return "Contato sem identificação";
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

  // A API corta `critical` numa amostra dos mais urgentes (`criticalSampleLimit`,
  // hoje 100), então o tamanho do payload não é o total real de atendimentos em
  // risco: esse total é a soma de amarelos e vermelhos ativos, a mesma população
  // que o serviço filtra antes do corte. Nada aqui depende do valor do corte — a
  // lista renderiza o que vier e a linha de truncagem compara com o total.
  const criticalItems = summary?.critical ?? [];
  const criticalTotal = summary
    ? Math.max(criticalItems.length, summary.totals.warning + summary.totals.overdue)
    : 0;

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

      {/* Sem nenhum resumo carregado não há o que afirmar: o painel mostra só o erro.
          Renderizar o corpo aqui exibiria "0 em foco" e o estado vazio positivo, que
          alegariam fila limpa quando na verdade a carga falhou. */}
      {loading && !summary ? (
        <div className="sla-metric-grid" aria-label="Carregando métricas SLA">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="sla-skeleton" key={index} />
          ))}
        </div>
      ) : summary ? (
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

          <div className="sla-secondary-metrics">
            <span>
              Espera média do atendente: {formatSlaDuration(summary.averages.operatorWaitSeconds)}
            </span>
            <span>
              Espera média do cliente: {formatSlaDuration(summary.averages.customerWaitSeconds)}
            </span>
            <span>Congeladas: {summary.totals.frozen}</span>
          </div>

          <section className="sla-critical-list" aria-labelledby="sla-critical-title">
            <div className="sla-critical-heading">
              <div>
                <h3 id="sla-critical-title">Atendimentos que exigem atenção</h3>
                <p>Priorizados pelo prazo operacional atual.</p>
              </div>
              <span>{criticalTotal} em foco</span>
            </div>
            {criticalItems.length ? (
              <>
                <div
                  className="sla-critical-scroll"
                  role="region"
                  aria-label="Lista rolável de atendimentos que exigem atenção"
                  tabIndex={0}
                >
                  <ul className="sla-critical-items">
                    {criticalItems.map((item) => {
                      const label = criticalContactLabel(item);
                      return (
                        <li key={item.conversationId}>
                          <button
                            type="button"
                            className={`sla-critical-item sla-${item.indicator}`}
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
                        </li>
                      );
                    })}
                  </ul>
                  <div className="sla-critical-fade" aria-hidden="true" />
                </div>
                {criticalItems.length < criticalTotal && (
                  <p className="sla-critical-truncated">
                    Mostrando os {criticalItems.length} mais urgentes de {criticalTotal}.
                  </p>
                )}
              </>
            ) : (
              <div className="sla-critical-empty">
                <span aria-hidden="true">✓</span>
                <p>Nenhum atendimento exige atenção neste momento.</p>
              </div>
            )}
          </section>
        </>
      ) : null}

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
