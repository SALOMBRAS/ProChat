CREATE TABLE routing_jobs (
  id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL, conversationId TEXT NOT NULL, queueId TEXT NOT NULL, strategy TEXT NOT NULL CHECK(strategy IN ('round_robin','least_loaded','manual')),
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed','skipped','failed','cancelled')), attemptCount INTEGER NOT NULL DEFAULT 0,
  availableAt TEXT NOT NULL, lockedAt TEXT, lockedBy TEXT, assignedUserId TEXT, lastErrorSafe TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, completedAt TEXT,
  FOREIGN KEY(workspaceId,conversationId) REFERENCES conversations(workspaceId,id) ON DELETE CASCADE, FOREIGN KEY(queueId) REFERENCES routing_queues(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_routing_jobs_active_conversation ON routing_jobs(workspaceId,conversationId) WHERE status IN ('pending','processing');
CREATE INDEX idx_routing_jobs_pending ON routing_jobs(status,availableAt,workspaceId);
