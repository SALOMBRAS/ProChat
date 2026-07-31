-- M1 — bloqueio de contato
-- Extraída verbatim de web/docs/migrations-propostas-contatos.sql, seção "M1 / Supabase".
-- Procedimento: web/docs/migrations-m1-m2-aplicacao.md
-- Roteiro do SQL Editor: web/docs/migrations-m1-m2-sql-editor.md
-- Rollback: arquivo .rollback.sql ao lado.

-- ---------------------------------------------------------------------

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_state text NOT NULL DEFAULT 'active';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_propagation text NOT NULL DEFAULT 'none';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_requested_at timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_confirmed_at timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_last_error_safe text;

-- CHECKs nomeados e separados do ADD COLUMN, para o bloco ser idempotente e o
-- rollback poder derrubá-los por nome.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.contacts'::regclass
                    AND conname = 'contacts_block_state_check') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_block_state_check
      CHECK (block_state IN ('active', 'blocking', 'blocked', 'unblocking', 'block_failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.contacts'::regclass
                    AND conname = 'contacts_block_propagation_check') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_block_propagation_check
      CHECK (block_propagation IN ('none', 'pending', 'confirmed', 'failed', 'unsupported'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_block_state
  ON public.contacts(workspace_id, block_state) WHERE block_state <> 'active';

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_conversations_blocked
  ON public.conversations(workspace_id, blocked_at) WHERE blocked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.contact_block_events (
  id text NOT NULL,
  workspace_id text NOT NULL,
  contact_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('block', 'unblock')),
  outcome text NOT NULL
    CHECK (outcome IN ('requested', 'propagated', 'failed', 'skipped_unsupported')),
  waha_session text,
  actor_user_id text,
  reason_safe text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES public.contacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_contact_block_events_contact
  ON public.contact_block_events(workspace_id, contact_id, occurred_at DESC);

-- Mesma postura das demais tabelas de CRM: RLS ligada, nenhuma policy, acesso
-- só por service_role (que ignora RLS). Espelha 013_contact_identity_aliases.sql.
ALTER TABLE public.contact_block_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_block_events TO service_role;


-- ---------------------------------------------------------------------
