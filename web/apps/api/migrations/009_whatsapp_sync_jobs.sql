CREATE TABLE whatsapp_sync_jobs (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  wahaSession TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
  currentChatId TEXT,
  chatCursor TEXT,
  messageCursor TEXT,
  chatsProcessed INTEGER NOT NULL DEFAULT 0,
  messagesProcessed INTEGER NOT NULL DEFAULT 0,
  startedAt TEXT NOT NULL,
  completedAt TEXT,
  lastErrorSafe TEXT,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, wahaSession)
);
