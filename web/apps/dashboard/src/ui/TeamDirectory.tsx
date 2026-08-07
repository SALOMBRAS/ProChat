import { useEffect, useState } from 'react';
import type { WorkspaceUser } from '@chatpro/contracts';
import { WorkspaceApi } from '../api/workspace';
import { AuthApi } from '../api/auth';
import { connectRealtime } from '../api/realtime';

const api = new WorkspaceApi(); const authApi = new AuthApi();
/** Diretório de operadores do workspace — só o dono chega aqui pela navegação.
 *  Setores viraram Departamentos e ganharam tela própria em /departments;
 *  o que sobra nesta tela é o cadastro de gente. */
export function TeamDirectory() {
  const [users, setUsers] = useState<WorkspaceUser[]>([]); const [error, setError] = useState('');
  const refresh = async () => { try { setUsers(await api.users()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível carregar a equipe.'); } };
  useEffect(() => { void refresh(); return connectRealtime(event => { if (event.eventType.startsWith('workspace.')) void refresh(); }); }, []);
  const createUser = async (form: HTMLFormElement) => { const data = new FormData(form); const password = String(data.get('password') ?? ''); await api.createUser({ email: String(data.get('email')), displayName: String(data.get('displayName')), role: data.get('role') as WorkspaceUser['role'], status: 'active', password: password || undefined }); form.reset(); await refresh(); };
  const resetPassword = async (user: WorkspaceUser) => { const password = prompt(`Nova senha para ${user.displayName} (mínimo 8 caracteres)`); if (!password) return; await authApi.resetUserPassword(user.id, password); };
  return <section className="page team-directory"><div className="toolbar"><div><h2>Equipe</h2><p>Operadores internos usados na distribuição de conversas.</p></div><button className="secondary" onClick={() => void refresh()}>Atualizar</button></div>{error && <p className="alert">{error}</p>}<section className="panel"><h2>Operadores</h2><form className="create" onSubmit={event => { event.preventDefault(); void createUser(event.currentTarget).catch(e => setError(e instanceof Error ? e.message : 'Não foi possível criar o operador.')); }}><label>Nome<input name="displayName" required maxLength={160} /></label><label>E-mail<input name="email" type="email" required /></label><label>Função<select name="role" defaultValue="agent"><option value="agent">Agente</option><option value="manager">Gestor</option><option value="admin">Administrador</option><option value="owner">Proprietário</option></select></label><label>Senha de acesso<input name="password" type="password" minLength={8} placeholder="Mínimo 8 caracteres" /></label><button>Novo operador</button></form><div className="directory-list">{users.map(user => <article key={user.id}><span className="directory-avatar">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.displayName.slice(0, 2).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>{user.email} · {user.role}</small></div><button className="secondary" onClick={() => void resetPassword(user).catch(e => setError(e instanceof Error ? e.message : 'Não foi possível redefinir a senha.'))}>Redefinir senha</button><button className="secondary" onClick={() => void (user.status === 'disabled' ? api.enableUser(user.id) : api.disableUser(user.id)).then(refresh)}> {user.status === 'disabled' ? 'Ativar' : 'Desativar'} </button></article>)}</div></section></section>;
}
