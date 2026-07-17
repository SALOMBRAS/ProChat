CREATE TABLE whatsapp_identities (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  wahaSession TEXT NOT NULL,
  whatsappId TEXT NOT NULL,
  phone TEXT,
  name TEXT,
  pushName TEXT,
  profilePictureUrl TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (workspaceId, wahaSession, whatsappId)
);

CREATE TABLE whatsapp_groups (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  wahaSession TEXT NOT NULL,
  chatId TEXT NOT NULL,
  name TEXT,
  pictureUrl TEXT,
  metadataJson TEXT CHECK (metadataJson IS NULL OR json_valid(metadataJson)),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  UNIQUE (id),
  UNIQUE (workspaceId, wahaSession, chatId)
);

CREATE TABLE whatsapp_group_participants (
  id TEXT NOT NULL PRIMARY KEY,
  groupId TEXT NOT NULL,
  participantWhatsappId TEXT NOT NULL,
  role TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (groupId, participantWhatsappId),
  FOREIGN KEY (groupId) REFERENCES whatsapp_groups(id) ON DELETE CASCADE
);

ALTER TABLE whatsapp_messages ADD COLUMN senderWhatsappId TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN senderContactId TEXT;

ALTER TABLE conversations ADD COLUMN conversationType TEXT NOT NULL DEFAULT 'direct' CHECK (conversationType IN ('direct', 'group'));
UPDATE conversations SET conversationType = CASE WHEN chatId LIKE '%@g.us' THEN 'group' ELSE 'direct' END;

CREATE INDEX idx_whatsapp_identities_lookup ON whatsapp_identities(workspaceId, wahaSession, whatsappId);
CREATE INDEX idx_whatsapp_groups_lookup ON whatsapp_groups(workspaceId, wahaSession, chatId);
CREATE INDEX idx_whatsapp_messages_sender ON whatsapp_messages(workspaceId, wahaSession, senderWhatsappId);
