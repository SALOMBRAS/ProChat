import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import {
  connectedSessionsCount,
  type Dashboard,
} from "../api/domain.js";
import { SlaOperationalDashboard } from "./SlaOperationalDashboard.js";

type HomeDashboardProps = {
  loadDashboard: () => Promise<Dashboard>;
  onOpenInbox: () => void;
  onOpenConversation: (conversationId: string) => void;
};

const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : "Ocorreu um erro inesperado.";

const Empty = ({ children }: { children: ReactNode }) => (
  <div className="empty">{children}</div>
);

const Panel = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section className="panel">
    <h2>{title}</h2>
    {children}
  </section>
);

export function HomeDashboard({
  loadDashboard,
  onOpenInbox,
  onOpenConversation,
}: HomeDashboardProps) {
  const [data, setData] = useState<Dashboard>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void loadDashboard()
      .then((result) => {
        if (active) setData(result);
      })
      .catch((nextError) => {
        if (active) setError(errorMessage(nextError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadDashboard]);

  if (loading)
    return <p className="page loading-page">Carregando seu painel…</p>;
  if (error)
    return (
      <section className="page">
        <p className="alert" role="alert">
          {error}
        </p>
      </section>
    );

  const dashboard = data!;
  const sessionsByStatus = Array.isArray(dashboard.sessionsByStatus)
    ? dashboard.sessionsByStatus
    : [];
  const sessions = connectedSessionsCount(sessionsByStatus);
  const metrics = [
    [
      "◌",
      "Conversas",
      "Conversas ativas e pendentes",
      dashboard.leads,
    ],
    [
      "◈",
      "WhatsApps conectados",
      "Sessões WhatsApp disponíveis",
      sessions,
    ],
    [
      "✉",
      "Mensagens",
      "Quantidade de mensagens processadas",
      dashboard.recentActivities.length,
    ],
    ["◎", "Contatos", "Clientes cadastrados", dashboard.contacts],
  ] as const;
  const features = [
    ["◌", "Atendimento", "Gerencie conversas e equipes.", "Inbox"],
    [
      "✦",
      "Inteligência Artificial",
      "Automatize respostas e fluxos.",
      "Em breve",
    ],
    ["◒", "Campanhas", "Organize disparos e resultados.", "Campanhas"],
    ["◇", "CRM", "Controle clientes e oportunidades.", "CRM"],
  ] as const;

  return (
    <section className="page dashboard-page">
      <section className="hero">
        <div>
          <p className="hero-kicker">✦ INTELIGÊNCIA COMERCIAL</p>
          <h2>
            Bem-vindo ao <em>ChatPro</em>
          </h2>
          <p>
            Sua central inteligente de atendimento, automação e vendas pelo
            WhatsApp.
          </p>
          <button onClick={onOpenInbox}>
            Abrir Inbox <span>→</span>
          </button>
        </div>
        <div className="hero-orbit" aria-hidden="true">
          <span>✦</span>
          <i />
          <b />
        </div>
      </section>

      <div className="stats">
        {metrics.map(([icon, name, description, total]) => (
          <article className="stat" key={name}>
            <span className="stat-icon">{icon}</span>
            <div>
              <span>{name}</span>
              <strong>{total}</strong>
              <small>{description}</small>
            </div>
          </article>
        ))}
      </div>

      <SlaOperationalDashboard onOpenConversation={onOpenConversation} />

      <section className="section-heading">
        <div>
          <p className="eyebrow">CENTRAL DE OPERAÇÕES</p>
          <h2>Tudo que você precisa para crescer</h2>
        </div>
        <span>
          Atualizado em tempo real <i>●</i>
        </span>
      </section>

      <div className="feature-grid">
        {features.map(([icon, title, description, action]) => (
          <article className="feature-card" key={title}>
            <span>{icon}</span>
            <h3>{title}</h3>
            <p>{description}</p>
            <button className="text-button">
              {action} <b>→</b>
            </button>
          </article>
        ))}
      </div>

      <div className="dashboard-grid">
        <Panel title="Leads por etapa">
          {dashboard.leadsByStage.length ? (
            dashboard.leadsByStage.map((item) => (
              <p className="metric" key={item.stageId}>
                <span>{item.name}</span>
                <b>{item.total}</b>
              </p>
            ))
          ) : (
            <Empty>Nenhuma etapa inicializada.</Empty>
          )}
        </Panel>
        <Panel title="Atividades recentes">
          {dashboard.recentActivities.length ? (
            dashboard.recentActivities.map((item) => (
              <p key={item.id}>{item.type}</p>
            ))
          ) : (
            <Empty>Sem atividades recentes.</Empty>
          )}
        </Panel>
        <Panel title="Campanhas por status">
          {dashboard.campaignsByStatus.length ? (
            dashboard.campaignsByStatus.map((item) => (
              <p className="metric" key={item.status}>
                <span>{item.status}</span>
                <b>{item.total}</b>
              </p>
            ))
          ) : (
            <Empty>Sem campanhas.</Empty>
          )}
        </Panel>
        <Panel title="Sessões por status">
          {sessionsByStatus.length ? (
            sessionsByStatus.map((item) => (
              <p className="metric" key={item.status}>
                <span>{item.status}</span>
                <b>{item.total}</b>
              </p>
            ))
          ) : (
            <Empty>Sem sessões.</Empty>
          )}
        </Panel>
      </div>
    </section>
  );
}
