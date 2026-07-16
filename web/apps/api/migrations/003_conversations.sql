CREATE TABLE conversations (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  wahaSession TEXT NOT NULL,
  chatId TEXT NOT NULL,
  contactId TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  lastMessage TEXT,
  lastMessageAt TEXT NOT NULL,
  unreadCount INTEGER NOT NULL DEFAULT 0 CHECK (unreadCount >= 0),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, wahaSession, chatId),
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE SET NULL
);
CREATE INDEX idx_conversations_activity ON conversations(workspaceId, lastMessageAt DESC);
