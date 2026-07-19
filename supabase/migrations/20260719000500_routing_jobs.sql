CREATE TABLE IF NOT EXISTS public.routing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, conversation_id uuid NOT NULL, queue_id uuid NOT NULL, strategy text NOT NULL CHECK(strategy IN ('round_robin','least_loaded','manual')),
  status text NOT NULL CHECK(status IN ('pending','processing','completed','skipped','failed','cancelled')), attempt_count integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz NULL, locked_by text NULL, assigned_user_id uuid NULL, last_error_safe text NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz NULL,
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES public.conversations(workspace_id,id) ON DELETE CASCADE, FOREIGN KEY(queue_id) REFERENCES public.routing_queues(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_routing_jobs_active_conversation ON public.routing_jobs(workspace_id,conversation_id) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_routing_jobs_pending ON public.routing_jobs(status,available_at,workspace_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.routing_jobs TO service_role;
