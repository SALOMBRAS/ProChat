import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { DomainApi } from '../api/domain';
import { WorkspaceApi } from '../api/workspace';
import { SessionsApi } from '../api/sessions';

const message = (error: unknown) => error instanceof ApiError ? error.message : 'Ocorreu um erro inesperado.';

const stableDependencies: unknown[] = [];
function useResource<T>(load: () => Promise<T>, deps: unknown[] = stableDependencies) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    setLoading(true);
    setError('');
    try { setData(await load()); } catch (e) { setError(message(e)); } finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, deps);
  return { data, error, loading, refresh };
}

const ErrorNotice = ({ error }: { error: string }) => error ? <p className="alert" role="alert">{error}</p> : null;

export function Devices({ api, domainApi, workspace }: { api?: SessionsApi; domainApi?: DomainApi; workspace?: WorkspaceApi }) {
  const sessionsApi = api ?? new SessionsApi();
  const domApi = domainApi ?? new DomainApi();
  const wsApi = workspace ?? new WorkspaceApi();

  const { data = [], error, loading, refresh } = useResource(() => sessionsApi.list());
  const { data: teams = [] } = useResource(() => wsApi.teams(), [wsApi]);

  /** Vínculo instância→departamento (`instanceTeam:<wahaName>` nos settings)
   *  aqui é SOMENTE LEITURA: quem vincula é a tela de Departamentos. */
  const [instanceTeams, setInstanceTeams] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let live = true;
    void domApi.settings().then(result => {
      if (!live) return;
      const map: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(result.settings.operational ?? {})) {
        if (key.startsWith('instanceTeam:') && typeof value === 'string') {
          const wahaName = key.slice('instanceTeam:'.length);
          // Suporta tanto string única (legado) quanto lista separada por vírgula
          map[wahaName] = value.split(',').filter(Boolean);
        }
      }
      setInstanceTeams(map);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [domApi]);

  const linkedSessions = data.filter(session => session.managed !== false);
  const [busy, setBusy] = useState<string>();
  const [menu, setMenu] = useState<string>();

  const statusLabel: Record<string, string> = { connected: 'Conectada', connecting: 'Conectando', waiting_qr: 'Aguardando QR', stopped: 'Parada', disconnected: 'Desconectada', error: 'Erro' };
  const [actionError, setActionError] = useState('');
  const [qr, setQr] = useState<{ sessionId: string; name: string; value: string; expiresAt: string }>();
  const [qrRequestedSessionId, setQrRequestedSessionId] = useState<string>();

  useEffect(() => {
    const session = data.find(item => item.status === 'waiting_qr');
    if (!session) { setQr(undefined); setQrRequestedSessionId(undefined); return; }
    if (qr?.sessionId === session.id || qrRequestedSessionId === session.id) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const current = await sessionsApi.status(session.id, controller.signal);
        if (current.status !== 'waiting_qr') { if (!controller.signal.aborted) setQr(undefined); return; }
        const next = await sessionsApi.qr(session.id, controller.signal);
        if (!controller.signal.aborted) { setQrRequestedSessionId(session.id); setQr({ sessionId: session.id, name: session.name, value: next.qr, expiresAt: next.expiresAt }); }
      } catch (nextError) {
        if (controller.signal.aborted) return;
        if (nextError instanceof ApiError && nextError.code === 'REQUEST_FAILED' && (nextError.details.status === 404 || nextError.details.status === 409)) { setQr(undefined); setQrRequestedSessionId(session.id); void refresh(); return; }
        setActionError(message(nextError));
      }
    })();
    return () => controller.abort();
  }, [sessionsApi, data, qr?.sessionId, qrRequestedSessionId]);

  useEffect(() => {
    if (!data.some(session => session.status === 'waiting_qr' || session.status === 'connecting')) return;
    const timer = window.setTimeout(() => void refresh(), 1_000);
    return () => window.clearTimeout(timer);
  }, [sessionsApi, data]);

  useEffect(() => {
    if (!qr) return;
    const timeout = window.setTimeout(() => setQr(undefined), Math.max(0, new Date(qr.expiresAt).getTime() - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [qr]);

  const execute = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setActionError('');
    try { await action(); await refresh(); } catch (e) { setActionError(message(e)); } finally { setBusy(undefined); }
  };

  const connect = async (id: string, name: string) => execute(`connect-${id}`, async () => {
    await sessionsApi.connect(id);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await sessionsApi.status(id);
      if (current.status !== 'waiting_qr') { if (current.status === 'connecting' || current.status === 'connected') { setQr(undefined); return; } await new Promise(resolve => window.setTimeout(resolve, 500)); continue; }
      try { const next = await sessionsApi.qr(id); setQrRequestedSessionId(id); setQr({ sessionId: id, name, value: next.qr, expiresAt: next.expiresAt }); return; }
      catch (e) { if (e instanceof ApiError && e.code === 'REQUEST_FAILED' && (e.details.status === 404 || e.details.status === 409)) return; if (!(e instanceof ApiError) || e.code !== 'REQUEST_FAILED') throw e; await new Promise(resolve => window.setTimeout(resolve, 500)); }
    }
    throw new ApiError('REQUEST_FAILED', 'O QR real ainda não foi disponibilizado pelo worker. Atualize a sessão em instantes.');
  });

  return (
    <section className="page devices">
      <div className="toolbar">
        <div>
          <h2>Dispositivos <span className="devices-count">({linkedSessions.length})</span></h2>
          <p>Configure os seus telefones para o atendimento e para as automações do WhatsApp.</p>
        </div>
        <button className="secondary" disabled={loading || Boolean(busy)} onClick={() => void refresh()}>Atualizar</button>
      </div>
      <div className="devices-stats">
        <article><i>▦</i><div><strong>{linkedSessions.length}</strong><small>Total</small></div></article>
        <article className="ok"><i>◉</i><div><strong>{linkedSessions.filter(s => s.status === 'connected').length}</strong><small>Conectadas</small></div></article>
        <article className="warn"><i>◌</i><div><strong>{linkedSessions.filter(s => s.status !== 'connected').length}</strong><small>Disponíveis</small></div></article>
      </div>
      <form className="create" onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const name = String(new FormData(form).get('name') ?? '').trim();
        if (!name) return;
        const clientRequestId = crypto.randomUUID();
        void execute('create', async () => {
          try { await sessionsApi.create(name, clientRequestId); form.reset(); }
          catch (nextError) { if (nextError instanceof ApiError && nextError.code === 'TIMEOUT') { form.reset(); await refresh(); return; } throw nextError; }
        });
      }}>
        <label>Nome da sessão<input name="name" required maxLength={120} placeholder="Ex.: Atendimento" /></label>
        <button disabled={Boolean(busy)}>{busy === 'create' ? 'Criando…' : 'Nova Sessão'}</button>
      </form>
      <ErrorNotice error={error || actionError} />
      {loading ? <p>Carregando sessões…</p> : linkedSessions.length ? (
        <div className="cards">
          {linkedSessions.map(s => {
            const depts = s.wahaName ? (instanceTeams[s.wahaName] ?? []) : [];
            const deptNames = depts.map(id => teams.find(t => t.id === id)?.name).filter(Boolean);
            return (
              <article className="card device-card" key={s.id}>
                <div className="card-head">
                  <div><h3>{s.name}</h3><p className="identifier">{s.wahaName ?? s.id}</p></div>
                  <span className={`status ${s.status}`}>{statusLabel[s.status] ?? s.status}</span>
                  <div className="device-menu-wrap">
                    <button
                      className="device-menu-button"
                      aria-label={`Ações da sessão ${s.name}`}
                      title="Ações"
                      onClick={() => setMenu(menu === s.id ? undefined : s.id)}
                    >⋯</button>
                    {menu === s.id && (
                      <div className="device-menu" role="menu">
                        <button disabled={Boolean(busy)} onClick={() => { setMenu(undefined); void connect(s.id, s.name); }}>
                          ⟡ Conectar / QR<small>{busy === `connect-${s.id}` ? 'Solicitando QR…' : 'Parear esta instância'}</small>
                        </button>
                        <button disabled={Boolean(busy)} onClick={() => { setMenu(undefined); void execute(`status-${s.id}`, async () => { await sessionsApi.status(s.id); }); }}>
                          ↻ Atualizar status<small>Recarrega o estado no WAHA</small>
                        </button>
                        <button disabled={Boolean(busy)} onClick={() => { setMenu(undefined); void execute(`stop-${s.id}`, () => sessionsApi.stop(s.id)); }}>
                          ⏸ Desconectar<small>Mantém sessão</small>
                        </button>
                        <button disabled={Boolean(busy)} onClick={() => { setMenu(undefined); void execute(`logout-${s.id}`, () => sessionsApi.logout(s.id)); }}>
                          ⎋ Deslogar sessão<small>Encerra no WhatsApp</small>
                        </button>
                        <button className="danger" disabled={Boolean(busy)} onClick={() => { setMenu(undefined); if (confirm(`Remover a sessão ${s.name}?`)) void execute(`remove-${s.id}`, () => sessionsApi.remove(s.id)); }}>
                          🗑 Deletar instância
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <dl>
                  <div><dt>Atualizada em</dt><dd>{new Date(s.updatedAt).toLocaleString()}</dd></div>
                  <div><dt>Departamentos</dt><dd>{deptNames.length ? deptNames.join(', ') : 'Todos (triagem)'}</dd></div>
                </dl>
              </article>
            );
          })}
        </div>
      ) : <p className="empty">Nenhuma sessão conectada.</p>}
      {qr && (
        <div className="modal-backdrop" onClick={() => setQr(undefined)}>
          <section className="modal qr-modal" role="dialog" aria-modal="true" aria-label="QR Code" onClick={e => e.stopPropagation()}>
            <button className="close" onClick={() => setQr(undefined)} aria-label="Fechar">×</button>
            <h2>QR: {qr.name}</h2>
            <p>Escaneie com o WhatsApp do celular.</p>
            <img src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr.value)}`} alt="QR Code" />
          </section>
        </div>
      )}
    </section>
  );
}
