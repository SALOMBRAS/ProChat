CREATE TABLE kanban_automation_deliveries (
  workspaceId TEXT NOT NULL,
  conversationId TEXT NOT NULL,
  messageId TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
  createdAt TEXT NOT NULL,
  PRIMARY KEY(workspaceId, conversationId, messageId, direction)
);
