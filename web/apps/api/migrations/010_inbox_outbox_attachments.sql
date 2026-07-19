CREATE TABLE IF NOT EXISTS inbox_outbox_jobs (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  conversationId TEXT NOT NULL,
  wahaSession TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image','audio','video','document')),
  storageObjectPath TEXT,
  filename TEXT,
  mimeType TEXT,
  sizeBytes INTEGER,
  caption TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','processing','sent','confirmed','failed','cancelled')),
  attemptCount INTEGER NOT NULL DEFAULT 0,
  externalMessageId TEXT,
  lastErrorSafe TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, conversationId) REFERENCES conversations(workspaceId, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_inbox_outbox_workspace_status ON inbox_outbox_jobs(workspaceId, status, createdAt);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_outbox_external_message ON inbox_outbox_jobs(workspaceId, externalMessageId) WHERE externalMessageId IS NOT NULL;
