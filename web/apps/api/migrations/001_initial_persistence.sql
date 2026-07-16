PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  appliedAt TEXT NOT NULL
);

CREATE TABLE contacts (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  displayName TEXT NOT NULL,
  phoneNumber TEXT NOT NULL,
  email TEXT,
  company TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, phoneNumber)
);
CREATE INDEX idx_contacts_workspace_created ON contacts(workspaceId, createdAt DESC);

CREATE TABLE tags (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, name)
);
CREATE TABLE contact_tags (
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  tagId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, contactId, tagId),
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE CASCADE,
  FOREIGN KEY (workspaceId, tagId) REFERENCES tags(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_contact_tags_tag ON contact_tags(workspaceId, tagId);

CREATE TABLE opt_out_history (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  occurredAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE RESTRICT
);
CREATE INDEX idx_opt_out_history_contact ON opt_out_history(workspaceId, contactId, occurredAt DESC);

CREATE TABLE templates (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  variablesJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(variablesJson) AND json_type(variablesJson) = 'array'),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, name)
);

CREATE TABLE pipelines (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, name)
);
CREATE TABLE stages (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  pipelineId TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, pipelineId, position),
  FOREIGN KEY (workspaceId, pipelineId) REFERENCES pipelines(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_stages_pipeline ON stages(workspaceId, pipelineId, position);
CREATE TABLE leads (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  stageId TEXT NOT NULL,
  contactId TEXT,
  title TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, stageId) REFERENCES stages(workspaceId, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE SET NULL
);
CREATE INDEX idx_leads_stage ON leads(workspaceId, stageId);
CREATE TABLE lead_tags (
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  tagId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, leadId, tagId),
  FOREIGN KEY (workspaceId, leadId) REFERENCES leads(workspaceId, id) ON DELETE CASCADE,
  FOREIGN KEY (workspaceId, tagId) REFERENCES tags(workspaceId, id) ON DELETE CASCADE
);
CREATE TABLE lead_notes (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, leadId) REFERENCES leads(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_lead_notes_lead ON lead_notes(workspaceId, leadId, createdAt DESC);
CREATE TABLE activities (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  leadId TEXT NOT NULL,
  type TEXT NOT NULL,
  detailsJson TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detailsJson) AND json_type(detailsJson) = 'object'),
  occurredAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, leadId) REFERENCES leads(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_activities_lead ON activities(workspaceId, leadId, occurredAt DESC);

CREATE TABLE campaigns (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  name TEXT NOT NULL,
  templateId TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'ready', 'blocked', 'cancelled')),
  scheduledAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, templateId) REFERENCES templates(workspaceId, id) ON DELETE SET NULL
);
CREATE INDEX idx_campaigns_workspace_status ON campaigns(workspaceId, status, scheduledAt);
CREATE TABLE campaign_recipients (
  workspaceId TEXT NOT NULL,
  campaignId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, campaignId, contactId),
  FOREIGN KEY (workspaceId, campaignId) REFERENCES campaigns(workspaceId, id) ON DELETE CASCADE,
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE RESTRICT
);

CREATE TABLE workspace_settings (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  settingsJson TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settingsJson) AND json_type(settingsJson) = 'object'),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId)
);
