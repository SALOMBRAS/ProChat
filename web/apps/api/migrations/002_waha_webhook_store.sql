CREATE TABLE waha_webhook_events (
  workspaceId TEXT NOT NULL,
  wahaSession TEXT NOT NULL,
  externalEventId TEXT NOT NULL,
  eventType TEXT NOT NULL CHECK (eventType IN ('message', 'message.any', 'session.status')),
  occurredAt TEXT NOT NULL,
  payloadJson TEXT NOT NULL CHECK (json_valid(payloadJson)),
  receivedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, wahaSession, externalEventId)
);
CREATE INDEX idx_waha_webhook_events_received ON waha_webhook_events(workspaceId, receivedAt DESC);

CREATE TABLE whatsapp_messages (
  workspaceId TEXT NOT NULL,
  wahaSession TEXT NOT NULL,
  externalMessageId TEXT NOT NULL,
  externalEventId TEXT NOT NULL,
  chatId TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  messageType TEXT NOT NULL,
  body TEXT,
  occurredAt TEXT NOT NULL,
  payloadJson TEXT NOT NULL CHECK (json_valid(payloadJson)),
  receivedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, wahaSession, externalMessageId),
  FOREIGN KEY (workspaceId, wahaSession, externalEventId) REFERENCES waha_webhook_events(workspaceId, wahaSession, externalEventId) ON DELETE CASCADE
);
CREATE INDEX idx_whatsapp_messages_chat ON whatsapp_messages(workspaceId, wahaSession, chatId, occurredAt DESC);
