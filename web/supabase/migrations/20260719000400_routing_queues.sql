CREATE TABLE IF NOT EXISTS public.routing_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, team_id uuid NULL REFERENCES public.teams(id) ON DELETE RESTRICT,
  name text NOT NULL, description text NULL, is_active boolean NOT NULL DEFAULT true,
  strategy text NOT NULL DEFAULT 'round_robin' CHECK(strategy IN ('round_robin','least_loaded','manual')),
  max_open_conversations_per_agent integer NULL CHECK(max_open_conversations_per_agent > 0), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,name), UNIQUE(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS public.routing_queue_members (
  queue_id uuid NOT NULL REFERENCES public.routing_queues(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES public.workspace_users(id) ON DELETE RESTRICT,
  priority_weight integer NOT NULL DEFAULT 1 CHECK(priority_weight > 0), is_available boolean NOT NULL DEFAULT true, last_assigned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(queue_id,user_id)
);
CREATE TABLE IF NOT EXISTS public.routing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL, conversation_id uuid NOT NULL, queue_id uuid NULL, assigned_user_id uuid NULL,
  strategy text NOT NULL CHECK(strategy IN ('round_robin','least_loaded','manual')), result text NOT NULL CHECK(result IN ('assigned','skipped','failed','manual_override')),
  reason_safe text NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES public.conversations(workspace_id,id) ON DELETE CASCADE
);
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS routing_queue_id uuid NULL, ADD COLUMN IF NOT EXISTS auto_assigned_at timestamptz NULL, ADD COLUMN IF NOT EXISTS routing_locked_at timestamptz NULL;
CREATE INDEX IF NOT EXISTS idx_routing_queues_workspace ON public.routing_queues(workspace_id,is_active,name);
CREATE INDEX IF NOT EXISTS idx_routing_queue_members_eligible ON public.routing_queue_members(queue_id,is_available,last_assigned_at,user_id);
CREATE INDEX IF NOT EXISTS idx_routing_events_activity ON public.routing_events(workspace_id,conversation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_routing_pending ON public.conversations(workspace_id,routing_queue_id,status,assigned_user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.routing_queues, public.routing_queue_members, public.routing_events TO service_role;

CREATE OR REPLACE FUNCTION public.chatpro_distribute_conversation(p_workspace_id text, p_conversation_id uuid, p_queue_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE q public.routing_queues%ROWTYPE; c public.conversations%ROWTYPE; chosen uuid; result text := 'skipped'; reason text; assigned uuid; event_row public.routing_events%ROWTYPE;
BEGIN
  SELECT * INTO q FROM public.routing_queues WHERE workspace_id=p_workspace_id AND id=p_queue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'routing queue not found'; END IF;
  SELECT * INTO c FROM public.conversations WHERE workspace_id=p_workspace_id AND id=p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found'; END IF;
  IF p_force THEN UPDATE public.conversations SET assigned_user_id=NULL, assigned_at=NULL, routing_locked_at=NULL, updated_at=now() WHERE workspace_id=p_workspace_id AND id=p_conversation_id; c.assigned_user_id := NULL; c.routing_locked_at := NULL; END IF;
  IF NOT q.is_active THEN reason := 'queue_inactive';
  ELSIF q.strategy = 'manual' THEN reason := 'manual_strategy';
  ELSIF c.assigned_user_id IS NOT NULL THEN reason := 'already_assigned'; assigned := c.assigned_user_id;
  ELSIF c.routing_locked_at IS NOT NULL THEN reason := 'manual_assignment_locked';
  ELSIF c.status IN ('archived','resolved') THEN reason := 'conversation_not_routable';
  ELSE
    IF q.strategy = 'least_loaded' THEN
      SELECT m.user_id INTO chosen FROM public.routing_queue_members m JOIN public.workspace_users u ON u.id=m.user_id AND u.workspace_id=p_workspace_id
        LEFT JOIN public.conversations oc ON oc.workspace_id=p_workspace_id AND oc.assigned_user_id=m.user_id AND oc.status IN ('open','in_progress','waiting_customer')
        WHERE m.queue_id=q.id AND m.is_available AND u.status='active' AND (q.team_id IS NULL OR EXISTS(SELECT 1 FROM public.team_members tm WHERE tm.team_id=q.team_id AND tm.user_id=m.user_id))
        GROUP BY m.user_id,m.last_assigned_at HAVING q.max_open_conversations_per_agent IS NULL OR count(oc.id) < q.max_open_conversations_per_agent
        ORDER BY count(oc.id), m.last_assigned_at NULLS FIRST, m.user_id LIMIT 1;
    ELSE
      SELECT m.user_id INTO chosen FROM public.routing_queue_members m JOIN public.workspace_users u ON u.id=m.user_id AND u.workspace_id=p_workspace_id
        LEFT JOIN public.conversations oc ON oc.workspace_id=p_workspace_id AND oc.assigned_user_id=m.user_id AND oc.status IN ('open','in_progress','waiting_customer')
        WHERE m.queue_id=q.id AND m.is_available AND u.status='active' AND (q.team_id IS NULL OR EXISTS(SELECT 1 FROM public.team_members tm WHERE tm.team_id=q.team_id AND tm.user_id=m.user_id))
        GROUP BY m.user_id,m.last_assigned_at HAVING q.max_open_conversations_per_agent IS NULL OR count(oc.id) < q.max_open_conversations_per_agent
        ORDER BY m.last_assigned_at NULLS FIRST, m.user_id LIMIT 1;
    END IF;
    IF chosen IS NULL THEN reason := 'no_eligible_agent';
    ELSE
      UPDATE public.conversations SET assigned_user_id=chosen, assigned_at=now(), auto_assigned_at=now(), routing_locked_at=NULL, updated_at=now()
        WHERE workspace_id=p_workspace_id AND id=p_conversation_id AND assigned_user_id IS NULL AND routing_locked_at IS NULL AND status NOT IN ('archived','resolved');
      IF FOUND THEN UPDATE public.routing_queue_members SET last_assigned_at=now(),updated_at=now() WHERE queue_id=q.id AND user_id=chosen; result := 'assigned'; assigned := chosen;
      ELSE reason := 'assignment_raced'; END IF;
    END IF;
  END IF;
  INSERT INTO public.routing_events(workspace_id,conversation_id,queue_id,assigned_user_id,strategy,result,reason_safe) VALUES (p_workspace_id,p_conversation_id,q.id,assigned,q.strategy,result,reason) RETURNING * INTO event_row;
  RETURN jsonb_build_object('event',to_jsonb(event_row),'assigned_user_id',assigned,'reason_safe',reason);
END $$;
GRANT EXECUTE ON FUNCTION public.chatpro_distribute_conversation(text,uuid,uuid,boolean) TO service_role;
