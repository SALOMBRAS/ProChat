CREATE OR REPLACE FUNCTION public.chatpro_claim_routing_jobs(p_worker_id text,p_limit integer,p_lease_seconds integer)
RETURNS SETOF public.routing_jobs LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH candidates AS (
    SELECT id FROM public.routing_jobs WHERE (status='pending' AND available_at<=now()) OR (status='processing' AND locked_at < now() - make_interval(secs => p_lease_seconds))
    ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT greatest(1,least(p_limit,100))
  ) UPDATE public.routing_jobs j SET status='processing',locked_at=now(),locked_by=p_worker_id,attempt_count=j.attempt_count+1,updated_at=now()
  FROM candidates WHERE j.id=candidates.id RETURNING j.*;
$$;
GRANT EXECUTE ON FUNCTION public.chatpro_claim_routing_jobs(text,integer,integer) TO service_role;
