CREATE TABLE routing_queues (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, teamId TEXT, name TEXT NOT NULL,
  description TEXT, isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0,1)),
  strategy TEXT NOT NULL DEFAULT 'round_robin' CHECK (strategy IN ('round_robin','least_loaded','manual')),
  maxOpenConversationsPerAgent INTEGER CHECK (maxOpenConversationsPerAgent IS NULL OR maxOpenConversationsPerAgent > 0),
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(workspaceId, name), UNIQUE(workspaceId, id),
  FOREIGN KEY(teamId) REFERENCES teams(id) ON DELETE RESTRICT
);
CREATE INDEX idx_routing_queues_workspace ON routing_queues(workspaceId, isActive, name);
CREATE TABLE routing_queue_members (
  queueId TEXT NOT NULL, userId TEXT NOT NULL, priorityWeight INTEGER NOT NULL DEFAULT 1 CHECK(priorityWeight > 0),
  isAvailable INTEGER NOT NULL DEFAULT 1 CHECK(isAvailable IN (0,1)), lastAssignedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  PRIMARY KEY(queueId,userId), FOREIGN KEY(queueId) REFERENCES routing_queues(id) ON DELETE CASCADE, FOREIGN KEY(userId) REFERENCES workspace_users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_routing_queue_members_eligible ON routing_queue_members(queueId, isAvailable, lastAssignedAt, userId);
CREATE TABLE routing_events (
  id TEXT NOT NULL, workspaceId TEXT NOT NULL, conversationId TEXT NOT NULL, queueId TEXT, assignedUserId TEXT,
  strategy TEXT NOT NULL CHECK(strategy IN ('round_robin','least_loaded','manual')),
  result TEXT NOT NULL CHECK(result IN ('assigned','skipped','failed','manual_override')),
  reasonSafe TEXT, createdAt TEXT NOT NULL, PRIMARY KEY(workspaceId,id),
  FOREIGN KEY(workspaceId,conversationId) REFERENCES conversations(workspaceId,id) ON DELETE CASCADE
);
CREATE INDEX idx_routing_events_activity ON routing_events(workspaceId,conversationId,createdAt DESC);
ALTER TABLE conversations ADD COLUMN routingQueueId TEXT;
ALTER TABLE conversations ADD COLUMN autoAssignedAt TEXT;
ALTER TABLE conversations ADD COLUMN routingLockedAt TEXT;
CREATE INDEX idx_conversations_routing_pending ON conversations(workspaceId,routingQueueId,operationalStatus,assignedUserId);
