CREATE TABLE IF NOT EXISTS public.whatsapp_provider_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL,
  provider text NOT NULL,
  session_id text NOT NULL,
  session_name text NOT NULL,
  provider_device_id text NOT NULL,
  provider_status text NOT NULL,
  chatpro_status text NOT NULL CHECK (chatpro_status IN ('disconnected','connecting','waiting_qr','connected','stopped','error')),
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities_json) = 'array'),
  provider_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_metadata_json) = 'object'),
  reconciliation_state text NOT NULL CHECK (reconciliation_state IN ('healthy','missing','unverified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_reconciled_at timestamptz NULL,
  UNIQUE (workspace_id, provider, session_id),
  UNIQUE (provider, provider_device_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_provider_sessions_provider_workspace ON public.whatsapp_provider_sessions(provider, workspace_id);
GRANT SELECT, INSERT, UPDATE ON public.whatsapp_provider_sessions TO service_role;
