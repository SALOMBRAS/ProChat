ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid NULL,
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS last_status_change timestamptz NULL;

UPDATE public.conversations SET status = 'resolved' WHERE status = 'closed';
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_status_check CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'archived'));
ALTER TABLE public.conversations ADD CONSTRAINT conversations_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
UPDATE public.conversations SET last_status_change = COALESCE(last_status_change, updated_at);
ALTER TABLE public.conversations ALTER COLUMN last_status_change SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.conversation_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  workspace_id text NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('assigned', 'unassigned', 'status_changed', 'priority_changed', 'archived', 'reopened')),
  previous_value text NULL,
  new_value text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES public.conversations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_management ON public.conversations(workspace_id, status, assigned_user_id, priority);
CREATE INDEX IF NOT EXISTS idx_conversation_events_activity ON public.conversation_events(workspace_id, conversation_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.conversation_events TO service_role;
