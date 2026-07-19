CREATE TABLE IF NOT EXISTS whatsapp_sync_jobs (
  id uuid NOT NULL,
  workspace_id text NOT NULL,
  waha_session text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  current_chat_id text NULL,
  chat_cursor text NULL,
  message_cursor text NULL,
  chats_processed integer NOT NULL DEFAULT 0,
  messages_processed integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  last_error_safe text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, waha_session)
);
GRANT SELECT, INSERT, UPDATE ON TABLE public.whatsapp_sync_jobs TO service_role;
