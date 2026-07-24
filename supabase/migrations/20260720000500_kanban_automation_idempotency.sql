CREATE TABLE IF NOT EXISTS public.kanban_automation_deliveries (
  workspace_id text NOT NULL,
  conversation_id uuid NOT NULL,
  message_id text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, conversation_id, message_id, direction),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES public.conversations(workspace_id, id)
);
GRANT SELECT, INSERT ON public.kanban_automation_deliveries TO service_role;
