ALTER TABLE public.inbox_outbox_jobs ADD COLUMN IF NOT EXISTS client_request_id uuid NULL;
ALTER TABLE public.inbox_outbox_jobs ADD COLUMN IF NOT EXISTS provider_accepted_at timestamptz NULL;
UPDATE public.inbox_outbox_jobs SET client_request_id = id WHERE client_request_id IS NULL;
ALTER TABLE public.inbox_outbox_jobs ALTER COLUMN client_request_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_outbox_jobs_client_request_idx ON public.inbox_outbox_jobs(workspace_id, client_request_id);

CREATE OR REPLACE FUNCTION public.claim_inbox_outbox_job(p_workspace_id text, p_id uuid)
RETURNS SETOF public.inbox_outbox_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.inbox_outbox_jobs
     SET status = 'processing', attempt_count = attempt_count + 1, updated_at = now()
   WHERE workspace_id = p_workspace_id AND id = p_id AND status = 'pending'
  RETURNING *;
$$;
GRANT EXECUTE ON FUNCTION public.claim_inbox_outbox_job(text, uuid) TO service_role;
