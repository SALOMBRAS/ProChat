CREATE TABLE IF NOT EXISTS conversation_metadata (
  workspace_id text NOT NULL,
  conversation_id uuid NOT NULL,
  notes text NULL,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_interaction_at timestamptz NOT NULL,
  last_interaction_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, conversation_id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);
