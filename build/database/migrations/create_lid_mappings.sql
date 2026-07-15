-- Create LID mappings table for WhatsApp LID to JID resolution
CREATE TABLE IF NOT EXISTS lid_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  lid TEXT NOT NULL,
  jid TEXT NOT NULL,
  contact_name TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, lid)
);

CREATE INDEX IF NOT EXISTS idx_lid_mappings_session_lid ON lid_mappings(session_id, lid);
CREATE INDEX IF NOT EXISTS idx_lid_mappings_jid ON lid_mappings(jid);

