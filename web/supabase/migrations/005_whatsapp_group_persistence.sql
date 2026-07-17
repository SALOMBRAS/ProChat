CREATE TABLE IF NOT EXISTS whatsapp_identities (
  id uuid NOT NULL,
  workspace_id text NOT NULL,
  waha_session text NOT NULL,
  whatsapp_id text NOT NULL,
  phone text NULL,
  name text NULL,
  push_name text NULL,
  profile_picture_url text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, waha_session, whatsapp_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  id uuid NOT NULL,
  workspace_id text NOT NULL,
  waha_session text NOT NULL,
  chat_id text NOT NULL,
  name text NULL,
  picture_url text NULL,
  metadata jsonb NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (workspace_id, waha_session, chat_id)
);

CREATE TABLE IF NOT EXISTS whatsapp_group_participants (
  id uuid NOT NULL,
  group_id uuid NOT NULL,
  participant_whatsapp_id text NOT NULL,
  role text NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (group_id, participant_whatsapp_id),
  FOREIGN KEY (group_id) REFERENCES whatsapp_groups(id) ON DELETE CASCADE
);

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS sender_whatsapp_id text NULL;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS sender_contact_id uuid NULL;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_type text NOT NULL DEFAULT 'direct' CHECK (conversation_type IN ('direct', 'group'));
UPDATE conversations SET conversation_type = CASE WHEN chat_id LIKE '%@g.us' THEN 'group' ELSE 'direct' END;

CREATE INDEX IF NOT EXISTS idx_whatsapp_identities_lookup ON whatsapp_identities(workspace_id, waha_session, whatsapp_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_lookup ON whatsapp_groups(workspace_id, waha_session, chat_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_sender ON whatsapp_messages(workspace_id, waha_session, sender_whatsapp_id);
