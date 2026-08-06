-- Auth própria da API (login com e-mail + senha, sessões por token).
-- Espelho de web/apps/api/migrations/025_auth.sql. Aplicar manualmente no SQL
-- Editor do Supabase — a API usa service_role, então basta o GRANT abaixo.
CREATE TABLE IF NOT EXISTS public.auth_credentials (
  user_id uuid PRIMARY KEY REFERENCES public.workspace_users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.workspace_users(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON public.auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON public.auth_sessions(user_id, revoked_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_credentials, public.auth_sessions TO service_role;
