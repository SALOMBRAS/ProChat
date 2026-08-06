import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { AuthApi } from '../api/auth';
import { saveAuthSession, type AuthSession } from '../api/auth-storage';

const authApi = new AuthApi();

export function LoginScreen({ onLogin }: { onLogin: (session: AuthSession) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError('');
    try {
      const session = await authApi.login(String(data.get('email') ?? '').trim(), String(data.get('password') ?? ''));
      saveAuthSession(session);
      onLogin(session);
    } catch (nextError) {
      setError(nextError instanceof ApiError ? nextError.message : 'Não foi possível entrar. Tente novamente.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-screen">
      <section className="login-card" aria-label="Entrar no ChatPro">
        <div className="brand"><span className="brand-mark">✦</span><span>Chat</span><b>Pro</b></div>
        <h1>Entrar</h1>
        <p className="login-hint">Acesse com o e-mail e a senha cadastrados pelo administrador.</p>
        <form onSubmit={event => void submit(event)}>
          <label>E-mail<input name="email" type="email" required autoComplete="username" autoFocus /></label>
          <label>Senha<input name="password" type="password" required autoComplete="current-password" /></label>
          {error && <p className="alert" role="alert">{error}</p>}
          <button disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        </form>
      </section>
    </div>
  );
}
