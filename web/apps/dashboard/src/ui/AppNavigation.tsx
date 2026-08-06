export const routes = [
  ["/dashboard", "Painel", "▦"],
  ["/inbox", "Inbox", "◌"],
  ["/calls", "Chamadas", "✆"],
  ["/devices", "Dispositivos", "◈"],
  ["/team", "Equipe", "◉"],
  ["/departments", "Departamentos", "▣"],
  ["/queues", "Filas", "Q"],
  ["/crm", "CRM", "◇"],
  ["/contacts", "Contatos", "◎"],
  ["/templates", "Modelos de mensagem", "✦"],
  ["/campaigns", "Campanhas", "◒"],
  ["/settings", "Configurações", "⚙"],
] as const;

const futureRoutes = [
  ["Automações", "↗"],
  ["Relatórios", "◫"],
] as const;

type AppNavigationProps = {
  open: boolean;
  path: string;
  onNavigate: (path: string) => void;
  /** Papel do usuário logado. `agent` só vê as páginas de operação (Painel e
   *  Inbox); os demais papéis veem tudo, incluindo a gestão. */
  role?: 'owner' | 'admin' | 'manager' | 'agent';
};

export function AppNavigation({
  open,
  path,
  onNavigate,
  role,
}: AppNavigationProps) {
  const visibleRoutes = role === 'agent' ? routes.filter(([to]) => to === '/dashboard' || to === '/inbox') : routes;
  const navigationButton = ([to, name, icon]: (typeof routes)[number]) => (
    <button
      key={to}
      className={path === to ? "nav active" : "nav"}
      onClick={() => onNavigate(to)}
      aria-label={name}
      title={name}
    >
      <i>{icon}</i>
      <span className="nav-text">{name}</span>
    </button>
  );

  const central = visibleRoutes.slice(0, 4);
  const management = visibleRoutes.slice(4, -1);
  const settings = visibleRoutes.slice(-1).filter(([to]) => to === '/settings');

  return (
    <aside className={open ? "sidebar open" : "sidebar"}>
      <div className="brand">
        <span className="brand-mark">✦</span>
        <span>Chat</span>
        <b>Pro</b>
      </div>
      <p className="nav-label">CENTRAL</p>
      {central.map(navigationButton)}
      {management.length > 0 && <p className="nav-label">GESTÃO</p>}
      {management.map(navigationButton)}
      {role !== 'agent' && futureRoutes.map(([name, icon]) => (
        <button
          key={name}
          className="nav future"
          disabled
          aria-label={name}
          title="Recurso visual preparado para uma futura etapa"
        >
          <i>{icon}</i>
          <span className="nav-text">{name}</span>
          <small>Em breve</small>
        </button>
      ))}
      <div className="nav-spacer" />
      {settings.map(navigationButton)}
      <div className="sidebar-upgrade">
        <span>✦</span>
        <div>
          <strong>ChatPro IA</strong>
          <p>Automação que escala.</p>
        </div>
      </div>
    </aside>
  );
}
