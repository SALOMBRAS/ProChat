CREATE TABLE IF NOT EXISTS public.workspace_sla_config (
  workspace_id text PRIMARY KEY,
  first_response_threshold_ms bigint NOT NULL DEFAULT 300000 CHECK (first_response_threshold_ms > 0),
  operator_waiting_threshold_ms bigint NOT NULL DEFAULT 900000 CHECK (operator_waiting_threshold_ms > 0),
  customer_waiting_threshold_ms bigint NOT NULL DEFAULT 86400000 CHECK (customer_waiting_threshold_ms > 0),
  warning_ratio numeric NOT NULL DEFAULT 0.8 CHECK (warning_ratio > 0 AND warning_ratio < 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.conversation_sla_metrics (
  workspace_id text NOT NULL, conversation_id uuid NOT NULL,
  sla_status text NOT NULL CHECK (sla_status IN ('waiting_operator','waiting_customer','answered','resolved','expired','archived')),
  first_inbound_at timestamptz NOT NULL, first_response_at timestamptz NULL,
  last_inbound_at timestamptz NOT NULL, last_outbound_at timestamptz NULL, last_activity_at timestamptz NOT NULL,
  waiting_since_at timestamptz NULL, operator_waiting_ms bigint NOT NULL DEFAULT 0, customer_waiting_ms bigint NOT NULL DEFAULT 0,
  total_response_ms bigint NOT NULL DEFAULT 0, response_count integer NOT NULL DEFAULT 0,
  resolved_at timestamptz NULL, archived_at timestamptz NULL, frozen_at timestamptz NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES public.conversations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversation_sla_due ON public.conversation_sla_metrics(workspace_id, sla_status, waiting_since_at) WHERE frozen_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_sla_config, public.conversation_sla_metrics TO service_role;
