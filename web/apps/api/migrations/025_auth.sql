CREATE TABLE auth_credentials (
  userId TEXT PRIMARY KEY,
  passwordHash TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES workspace_users(id) ON DELETE CASCADE
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  lastUsedAt TEXT,
  revokedAt TEXT,
  FOREIGN KEY (userId) REFERENCES workspace_users(id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_sessions_token ON auth_sessions(tokenHash);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(userId, revokedAt);
