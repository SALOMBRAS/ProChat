import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Team, TeamMember, WorkspaceUser } from '@chatpro/contracts';
import { WorkspaceApi } from '../api/workspace';
import { SessionsApi, type Session } from '../api/sessions';
import { DomainApi } from '../api/domain';
import { connectRealtime } from '../api/realtime';

/** Paleta fixa do seletor — a cor escolhida vai para `teams.color` como hex,
 *  o mesmo campo que o CRM já usa. O roxo do ChatPro é o padrão de criação. */
const DEPT_COLORS = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#eab308', '#ef4444', '#94a3b8'];
const DEPT_ICONS = ['👥', '🎧', '💼', '❤️', '📋', '💬', '🔧', '⚡', '🚀', '🎯', '⭐', '👑', '🏅', '🛡️', '💻', '☕'];
const DEFAULT_COLOR = '#a855f7';
const DEFAULT_ICON = '👥';

/** O ícone do departamento não tem coluna no backend: mora nos settings do
 *  workspace como `teamIcon:<teamId>`, mesmo padrão do `instanceTeam:` que o
 *  vínculo instância→departamento já usa. Sem migration, sem contrato novo. */
const iconKey = (teamId: string) => `teamIcon:${teamId}`;
const instanceKey = (wahaName: string) => `instanceTeam:${wahaName}`;

type Draft = { id?: string; name: string; color: string; icon: string; instances: string[]; collaborators: string[] };

const initials = (name: string) => name.trim().slice(0, 2).toUpperCase();

export function Departments({ workspace = new WorkspaceApi(), sessionsApi = new SessionsApi(), domainApi = new DomainApi() } = {}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [members, setMembers] = useState<Record<string, TeamMember[]>>({});
  const [sessions, setSessions] = useState<Session[]>([]);
  const [instanceTeams, setInstanceTeams] = useState<Record<string, string>>({});
  const [teamIcons, setTeamIcons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft>();

  const refresh = async () => {
    try {
      const [nextTeams, nextUsers, nextSessions, settings] = await Promise.all([workspace.teams(), workspace.users(), sessionsApi.list(), domainApi.settings()]);
      const memberLists = await Promise.all(nextTeams.map(async team => [team.id, await workspace.members(team.id)] as const));
      const operational = (settings.settings.operational ?? {}) as Record<string, unknown>;
      const nextInstanceTeams: Record<string, string> = {};
      const nextIcons: Record<string, string> = {};
      for (const [key, value] of Object.entries(operational)) {
        if (key.startsWith('instanceTeam:') && typeof value === 'string') nextInstanceTeams[key.slice('instanceTeam:'.length)] = value;
        if (key.startsWith('teamIcon:') && typeof value === 'string') nextIcons[key.slice('teamIcon:'.length)] = value;
      }
      setTeams(nextTeams); setUsers(nextUsers); setSessions(nextSessions); setMembers(Object.fromEntries(memberLists));
      setInstanceTeams(nextInstanceTeams); setTeamIcons(nextIcons); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível carregar os departamentos.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); return connectRealtime(event => { if (event.eventType.startsWith('workspace.')) void refresh(); }); }, []);

  /** Só sessões gerenciadas com nome WAHA entram na lista de instâncias — órfãs
   *  não recebem conversa nova, então vínculo com elas seria decorativo. */
  const instances = useMemo(() => sessions.filter(session => session.managed !== false && session.wahaName), [sessions]);
  const teamById = useMemo(() => new Map(teams.map(team => [team.id, team])), [teams]);
  const userById = useMemo(() => new Map(users.map(user => [user.id, user])), [users]);
  const filtered = useMemo(() => { const query = search.trim().toLowerCase(); return query ? teams.filter(team => team.name.toLowerCase().includes(query)) : teams; }, [teams, search]);

  const openCreate = () => setDraft({ name: '', color: DEFAULT_COLOR, icon: DEFAULT_ICON, instances: [], collaborators: [] });
  const openEdit = (team: Team) => setDraft({
    id: team.id,
    name: team.name,
    color: team.color ?? DEFAULT_COLOR,
    icon: teamIcons[team.id] ?? DEFAULT_ICON,
    instances: instances.filter(session => instanceTeams[session.wahaName!] === team.id).map(session => session.wahaName!),
    collaborators: (members[team.id] ?? []).map(member => member.userId),
  });

  const toggle = (list: string[], value: string) => list.includes(value) ? list.filter(item => item !== value) : [...list, value];

  const save = async () => {
    if (!draft || busy) return;
    const name = draft.name.trim();
    if (!name) return;
    setBusy(true); setError('');
    try {
      const team = draft.id
        ? await workspace.updateTeam(draft.id, { name, color: draft.color })
        : await workspace.createTeam({ name, color: draft.color });
      // Settings frescos antes de mesclar: Dispositivos edita as mesmas chaves
      // e um operational velho sobrescreveria o vínculo feito por lá.
      const current = await domainApi.settings();
      const operational: Record<string, string | number | boolean | null> = { ...((current.settings.operational ?? {}) as Record<string, string | number | boolean | null>) };
      operational[iconKey(team.id)] = draft.icon;
      for (const session of instances) {
        const key = instanceKey(session.wahaName!);
        if (draft.instances.includes(session.wahaName!)) operational[key] = team.id;
        else if (operational[key] === team.id) delete operational[key];
      }
      await domainApi.saveSettings({ operational });
      const before = new Set(draft.id ? (members[draft.id] ?? []).map(member => member.userId) : []);
      const after = new Set(draft.collaborators);
      for (const userId of after) if (!before.has(userId)) await workspace.addMember(team.id, { userId });
      for (const userId of before) if (!after.has(userId)) await workspace.removeMember(team.id, userId);
      setDraft(undefined);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar o departamento.'); }
    finally { setBusy(false); }
  };

  return <section className="page departments">
    <div className="toolbar">
      <div><h2>Departamentos</h2><p>Organize instâncias, colaboradores e filas de atendimento.</p></div>
      <button className="secondary" disabled={loading} onClick={() => void refresh()}>Atualizar</button>
    </div>
    <div className="departments-banner">👥 <strong>{teams.length}</strong>&nbsp;{teams.length === 1 ? 'departamento' : 'departamentos'}</div>
    <div className="departments-toolbar">
      <input aria-label="Buscar departamento" placeholder="Buscar departamento" value={search} onChange={event => setSearch(event.target.value)} />
      <button onClick={openCreate}>＋ Criar departamento</button>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {loading ? <p>Carregando departamentos…</p> : filtered.length ? <div className="departments-grid">{filtered.map(team => {
      const color = team.color ?? DEFAULT_COLOR;
      const instanceCount = instances.filter(session => instanceTeams[session.wahaName!] === team.id).length;
      const teamMembers = members[team.id] ?? [];
      const visible = teamMembers.slice(0, 3);
      return <article className="department-card" style={{ '--dept-color': color } as CSSProperties} key={team.id}>
        <span className="department-icon">{teamIcons[team.id] ?? DEFAULT_ICON}</span>
        <h3>{team.name}</h3>
        <p className="department-meta"><span>▦ {instanceCount} {instanceCount === 1 ? 'instância' : 'instâncias'}</span><span>👥 {teamMembers.length} {teamMembers.length === 1 ? 'membro' : 'membros'}</span></p>
        <div className="department-avatars">{visible.map(member => <span key={member.userId} title={userById.get(member.userId)?.displayName ?? member.userId}>{initials(userById.get(member.userId)?.displayName ?? '?')}</span>)}{teamMembers.length > visible.length && <span>+{teamMembers.length - visible.length}</span>}</div>
        <button className="department-edit" aria-label={`Editar departamento ${team.name}`} title="Editar" onClick={() => openEdit(team)}>✎</button>
      </article>;
    })}</div> : <div className="empty"><span className="empty-icon">👥</span><strong>Nenhum departamento</strong><p>Crie o primeiro para organizar instâncias e colaboradores.</p></div>}
    {draft && <div className="modal-backdrop"><section className="modal form-modal dept-modal" role="dialog" aria-modal="true" aria-label={draft.id ? 'Editar departamento' : 'Criar departamento'}>
      <button className="close" onClick={() => setDraft(undefined)} aria-label="Fechar">×</button>
      <h2>{draft.id ? 'Editar departamento' : 'Criar departamento'}</h2>
      <div className="dept-modal-grid">
        <div className="dept-col">
          <div className="dept-field"><span>NOME</span><input aria-label="Nome do departamento" value={draft.name} maxLength={120} onChange={event => setDraft({ ...draft, name: event.target.value })} /></div>
          <div className="dept-field"><span>PRÉVIA</span><div className="dept-preview"><b className="dept-chip" style={{ '--dept-color': draft.color } as CSSProperties}>{draft.icon} {draft.name.trim() || 'Departamento'}</b></div></div>
          <div className="dept-field"><span>COR</span><div className="dept-colors">{DEPT_COLORS.map(color => <button key={color} type="button" className={draft.color === color ? 'selected' : ''} style={{ background: color }} aria-label={`Cor ${color}`} onClick={() => setDraft({ ...draft, color })} />)}</div></div>
          <div className="dept-field"><span>ÍCONE</span><div className="dept-icons">{DEPT_ICONS.map(icon => <button key={icon} type="button" className={draft.icon === icon ? 'selected' : ''} aria-label={`Ícone ${icon}`} onClick={() => setDraft({ ...draft, icon })}>{icon}</button>)}</div></div>
        </div>
        <div className="dept-col">
          <DeptPicker label="INSTÂNCIAS" items={instances.map(session => ({ id: session.wahaName!, title: session.name, hint: instanceTeams[session.wahaName!] && instanceTeams[session.wahaName!] !== draft.id ? `→ ${teamById.get(instanceTeams[session.wahaName!])?.name ?? 'outro departamento'}` : undefined }))} selected={draft.instances} onToggle={id => setDraft({ ...draft, instances: toggle(draft.instances, id) })} searchLabel="Buscar instância" />
          <DeptPicker label="COLABORADORES" items={users.filter(user => user.status !== 'disabled').map(user => ({ id: user.id, title: user.displayName, hint: user.role }))} selected={draft.collaborators} onToggle={id => setDraft({ ...draft, collaborators: toggle(draft.collaborators, id) })} searchLabel="Buscar colaborador" />
        </div>
      </div>
      <div className="confirm-actions"><button type="button" className="secondary" onClick={() => setDraft(undefined)}>Cancelar</button><button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? 'Salvando…' : 'Salvar'}</button></div>
    </section></div>}
  </section>;
}

/** Lista multi-seleção com busca e contador, usada para instâncias e
 *  colaboradores — o mesmo padrão do modal de referência. */
function DeptPicker({ label, items, selected, onToggle, searchLabel }: { label: string; items: Array<{ id: string; title: string; hint?: string }>; selected: string[]; onToggle: (id: string) => void; searchLabel: string }) {
  const [query, setQuery] = useState('');
  const filtered = query.trim() ? items.filter(item => item.title.toLowerCase().includes(query.trim().toLowerCase())) : items;
  return <div className="dept-field"><span>{label}</span>
    <input aria-label={searchLabel} placeholder={`${searchLabel}…`} value={query} onChange={event => setQuery(event.target.value)} />
    <div className="dept-list">{filtered.length ? filtered.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={() => onToggle(item.id)} />{item.title}{item.hint && <small>{item.hint}</small>}</label>) : <p className="dept-list-empty">Nada encontrado.</p>}</div>
    <p className="dept-count">{selected.length} de {items.length} selecionados</p>
  </div>;
}
