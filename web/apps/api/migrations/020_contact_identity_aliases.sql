CREATE TABLE contact_identifiers (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  identifier TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, identifier),
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_contact_identifiers_contact ON contact_identifiers(workspaceId, contactId);
CREATE TABLE pending_contact_identities (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  identifier TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, identifier)
);
INSERT OR IGNORE INTO contact_identifiers (id,workspaceId,contactId,identifier,type,source,createdAt)
SELECT lower(hex(randomblob(16))), workspaceId, id, phoneNumber, 'phone', 'migration', createdAt FROM contacts;
