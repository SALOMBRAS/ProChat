CREATE TABLE IF NOT EXISTS conversations (
  id uuid NOT NULL,
  workspace_id text NOT NULL,
  waha_session text NOT NULL,
  chat_id text NOT NULL,
  contact_id uuid NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  last_message text NULL,
  last_message_at timestamptz NOT NULL,
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, waha_session, chat_id),
  FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_activity ON conversations(workspace_id, last_message_at DESC);
