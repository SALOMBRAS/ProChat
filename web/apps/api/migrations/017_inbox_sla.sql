CREATE TABLE workspace_sla_config (
  workspaceId TEXT PRIMARY KEY,
  firstResponseThresholdMs INTEGER NOT NULL DEFAULT 300000 CHECK (firstResponseThresholdMs > 0),
  operatorWaitingThresholdMs INTEGER NOT NULL DEFAULT 900000 CHECK (operatorWaitingThresholdMs > 0),
  customerWaitingThresholdMs INTEGER NOT NULL DEFAULT 86400000 CHECK (customerWaitingThresholdMs > 0),
  warningRatio REAL NOT NULL DEFAULT 0.8 CHECK (warningRatio > 0 AND warningRatio < 1),
  updatedAt TEXT NOT NULL
);
CREATE TABLE conversation_sla_metrics (
  workspaceId TEXT NOT NULL,
  conversationId TEXT NOT NULL,
  slaStatus TEXT NOT NULL CHECK (slaStatus IN ('waiting_operator','waiting_customer','answered','resolved','expired','archived')),
  firstInboundAt TEXT NOT NULL,
  firstResponseAt TEXT,
  lastInboundAt TEXT NOT NULL,
  lastOutboundAt TEXT,
  lastActivityAt TEXT NOT NULL,
  waitingSinceAt TEXT,
  operatorWaitingMs INTEGER NOT NULL DEFAULT 0,
  customerWaitingMs INTEGER NOT NULL DEFAULT 0,
  totalResponseMs INTEGER NOT NULL DEFAULT 0,
  responseCount INTEGER NOT NULL DEFAULT 0,
  resolvedAt TEXT,
  archivedAt TEXT,
  frozenAt TEXT,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, conversationId),
  FOREIGN KEY (workspaceId, conversationId) REFERENCES conversations(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_conversation_sla_due ON conversation_sla_metrics(workspaceId, slaStatus, waitingSinceAt) WHERE frozenAt IS NULL;
