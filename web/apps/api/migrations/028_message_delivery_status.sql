-- Amplia o CHECK de whatsapp_messages.status para aceitar recibos de entrega.
--
-- A 004 fixou `status IN ('received','sent')`. Era coerente enquanto ninguém
-- persistia recibo: o status era decidido no INSERT pela direção e nunca mais
-- mudava. É também a razão pela qual o ACK nunca foi gravado — e a falha só
-- aparecia em runtime, como `CHECK constraint failed`, nunca em typecheck.
--
-- Os valores novos são os que `InboxMessage.status` já declara no contrato
-- compartilhado: sending, received, sent, delivered, read, failed. Nenhum dado
-- existente muda de valor; o conjunto permitido apenas cresce.
--
-- SQLite não altera um CHECK: é preciso reconstruir a tabela. A lista de
-- colunas e de índices abaixo foi extraída do schema real após as migrations
-- 001–027, não do arquivo de criação original — a tabela recebeu colunas por
-- ALTER em pelo menos quatro migrations posteriores.

PRAGMA foreign_keys = OFF;

CREATE TABLE whatsapp_messages_new (
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
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('sending', 'received', 'sent', 'delivered', 'read', 'failed')),
  senderWhatsappId TEXT,
  senderContactId TEXT,
  mediaUrl TEXT,
  mediaMimeType TEXT,
  mediaFilename TEXT,
  mediaSize INTEGER,
  thumbnailUrl TEXT,
  duration INTEGER,
  quotedMessageId TEXT,
  mediaStoragePath TEXT,
  mediaChecksum TEXT,
  mediaPersistenceStatus TEXT NOT NULL DEFAULT 'pending',
  providerSessionId TEXT,
  PRIMARY KEY (workspaceId, wahaSession, externalMessageId),
  FOREIGN KEY (workspaceId, wahaSession, externalEventId) REFERENCES waha_webhook_events(workspaceId, wahaSession, externalEventId) ON DELETE CASCADE
);

INSERT INTO whatsapp_messages_new SELECT workspaceId, wahaSession, externalMessageId, externalEventId, chatId, direction, messageType, body, occurredAt, payloadJson, receivedAt, status, senderWhatsappId, senderContactId, mediaUrl, mediaMimeType, mediaFilename, mediaSize, thumbnailUrl, duration, quotedMessageId, mediaStoragePath, mediaChecksum, mediaPersistenceStatus, providerSessionId FROM whatsapp_messages;

DROP TABLE whatsapp_messages;
ALTER TABLE whatsapp_messages_new RENAME TO whatsapp_messages;

CREATE INDEX idx_whatsapp_messages_chat ON whatsapp_messages(workspaceId, wahaSession, chatId, occurredAt DESC);
CREATE INDEX idx_whatsapp_messages_sender ON whatsapp_messages(workspaceId, wahaSession, senderWhatsappId);
CREATE INDEX whatsapp_messages_media_persistence_idx ON whatsapp_messages(mediaPersistenceStatus, mediaUrl);
CREATE INDEX idx_whatsapp_messages_provider_session ON whatsapp_messages(workspaceId, providerSessionId, externalMessageId);

PRAGMA foreign_keys = ON;
