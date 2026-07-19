-- SQLite cannot change the original status CHECK constraint without rebuilding
-- tables referenced by metadata and attachment jobs. Keep it as transport
-- legacy state and use operationalStatus as the Inbox status projection.
ALTER TABLE conversations ADD COLUMN assignedUserId TEXT;
ALTER TABLE conversations ADD COLUMN assignedAt TEXT;
ALTER TABLE conversations ADD COLUMN operationalStatus TEXT NOT NULL DEFAULT 'open' CHECK (operationalStatus IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'archived'));
ALTER TABLE conversations ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE conversations ADD COLUMN lastStatusChange TEXT;
UPDATE conversations SET operationalStatus = CASE WHEN status = 'closed' THEN 'resolved' ELSE 'open' END, lastStatusChange = updatedAt;
CREATE INDEX idx_conversations_management ON conversations(workspaceId, operationalStatus, assignedUserId, priority);

CREATE TABLE conversation_events (
  id TEXT NOT NULL,
  conversationId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  userId TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('assigned', 'unassigned', 'status_changed', 'priority_changed', 'archived', 'reopened')),
  previousValue TEXT,
  newValue TEXT,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, conversationId) REFERENCES conversations(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_conversation_events_activity ON conversation_events(workspaceId, conversationId, createdAt DESC);
