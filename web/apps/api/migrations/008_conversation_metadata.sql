CREATE TABLE conversation_metadata (
  workspaceId TEXT NOT NULL,
  conversationId TEXT NOT NULL,
  notes TEXT,
  tagsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tagsJson)),
  firstInteractionAt TEXT NOT NULL,
  lastInteractionAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, conversationId),
  FOREIGN KEY (workspaceId, conversationId) REFERENCES conversations(workspaceId, id) ON DELETE CASCADE
);
