export const routes = [
  ["/dashboard", "Painel", "▦"],
  ["/inbox", "Inbox", "◌"],
  ["/devices", "Dispositivos", "◈"],
  ["/team", "Equipe", "◉"],
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
};

export function AppNavigation({
  open,
  path,
  onNavigate,
}: AppNavigationProps) {
  const navigationButton = ([to, name, icon]: (typeof routes)[number]) => (
    <button
      key={to}
      className={path === to ? "nav active" : "nav"}
      onClick={() => onNavigate(to)}
    >
      <i>{icon}</i>
      {name}
    </button>
  );

  return (
    <aside className={open ? "sidebar open" : "sidebar"}>
      <div className="brand">
        <span className="brand-mark">✦</span>
        <span>Chat</span>
        <b>Pro</b>
      </div>
      <p className="nav-label">CENTRAL</p>
      {routes.slice(0, 3).map(navigationButton)}
      <p className="nav-label">GESTÃO</p>
      {routes.slice(3, -1).map(navigationButton)}
      {futureRoutes.map(([name, icon]) => (
        <button
          key={name}
          className="nav future"
          disabled
          title="Recurso visual preparado para uma futura etapa"
        >
          <i>{icon}</i>
          {name}
          <small>Em breve</small>
        </button>
      ))}
      <div className="nav-spacer" />
      {routes.slice(-1).map(navigationButton)}
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
