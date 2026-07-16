CREATE TABLE IF NOT EXISTS waha_webhook_events (
  workspace_id text NOT NULL,
  waha_session text NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('message', 'message.any', 'session.status')),
  occurred_at timestamptz NOT NULL,
  payload_json jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, waha_session, external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_waha_webhook_events_received ON waha_webhook_events(workspace_id, received_at DESC);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  workspace_id text NOT NULL,
  waha_session text NOT NULL,
  external_message_id text NOT NULL,
  external_event_id text NOT NULL,
  chat_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type text NOT NULL,
  body text,
  occurred_at timestamptz NOT NULL,
  payload_json jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, waha_session, external_message_id),
  FOREIGN KEY (workspace_id, waha_session, external_event_id) REFERENCES waha_webhook_events(workspace_id, waha_session, external_event_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_chat ON whatsapp_messages(workspace_id, waha_session, chat_id, occurred_at DESC);
