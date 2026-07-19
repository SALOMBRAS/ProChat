CREATE TABLE workspace_users (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  email TEXT NOT NULL,
  displayName TEXT NOT NULL,
  avatarUrl TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'agent')),
  status TEXT NOT NULL CHECK (status IN ('active', 'invited', 'disabled')),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastSeenAt TEXT,
  UNIQUE (workspaceId, email),
  UNIQUE (workspaceId, id)
);
CREATE INDEX idx_workspace_users_directory ON workspace_users(workspaceId, status, displayName);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0, 1)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE (workspaceId, name),
  UNIQUE (workspaceId, id)
);
CREATE INDEX idx_teams_directory ON teams(workspaceId, isActive, name);

CREATE TABLE team_members (
  teamId TEXT NOT NULL,
  userId TEXT NOT NULL,
  membershipRole TEXT NOT NULL DEFAULT 'member' CHECK (membershipRole IN ('member', 'leader')),
  createdAt TEXT NOT NULL,
  PRIMARY KEY (teamId, userId),
  FOREIGN KEY (teamId) REFERENCES teams(id) ON DELETE RESTRICT,
  FOREIGN KEY (userId) REFERENCES workspace_users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_team_members_user ON team_members(userId, teamId);

ALTER TABLE conversations ADD COLUMN assignedTeamId TEXT;
CREATE INDEX idx_conversations_assigned_team ON conversations(workspaceId, assignedTeamId);
