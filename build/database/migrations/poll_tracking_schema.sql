-- Migration: Add poll tracking tables for comprehensive poll reports
-- This creates tables to track poll messages, options, and votes

-- Poll Messages table for tracking sent polls
CREATE TABLE IF NOT EXISTS poll_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE, -- WhatsApp message ID
  session_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL, -- Sender's WhatsApp JID
  recipient_jid TEXT NOT NULL, -- Recipient's WhatsApp JID (individual or group)
  poll_question TEXT NOT NULL,
  poll_options TEXT NOT NULL, -- JSON array of poll options
  selectable_count INTEGER DEFAULT 1,
  campaign_id INTEGER, -- Link to bulk campaign if sent via campaign
  template_id INTEGER, -- Link to template if sent via template
  sent_at DATETIME NOT NULL,
  expires_at DATETIME, -- When poll expires (if applicable)
  is_active BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES bulk_campaigns(id),
  FOREIGN KEY (template_id) REFERENCES message_templates(id)
);

-- Poll Options table for storing individual poll options
CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_message_id INTEGER NOT NULL,
  option_text TEXT NOT NULL,
  option_index INTEGER NOT NULL, -- Order of option in poll
  option_hash TEXT, -- SHA256 hash used by WhatsApp for voting
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (poll_message_id) REFERENCES poll_messages(id) ON DELETE CASCADE
);

-- Poll Votes table for tracking individual votes
CREATE TABLE IF NOT EXISTS poll_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_message_id INTEGER NOT NULL,
  poll_option_id INTEGER NOT NULL,
  voter_jid TEXT NOT NULL, -- Voter's WhatsApp JID
  voter_name TEXT, -- Voter's display name
  vote_message_id TEXT, -- WhatsApp message ID of the vote
  voted_at DATETIME NOT NULL,
  sender_timestamp_ms BIGINT, -- Original timestamp from WhatsApp
  server_timestamp_ms BIGINT, -- Server timestamp from WhatsApp
  is_valid BOOLEAN DEFAULT 1, -- Whether vote is valid (not retracted)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (poll_message_id) REFERENCES poll_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (poll_option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
  UNIQUE(poll_message_id, voter_jid, poll_option_id) -- Prevent duplicate votes for same option
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_poll_messages_session ON poll_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_poll_messages_sender ON poll_messages(sender_jid);
CREATE INDEX IF NOT EXISTS idx_poll_messages_recipient ON poll_messages(recipient_jid);
CREATE INDEX IF NOT EXISTS idx_poll_messages_sent_at ON poll_messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_poll_messages_active ON poll_messages(is_active);
CREATE INDEX IF NOT EXISTS idx_poll_messages_campaign ON poll_messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_message_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_message_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter_jid);
CREATE INDEX IF NOT EXISTS idx_poll_votes_voted_at ON poll_votes(voted_at);
CREATE INDEX IF NOT EXISTS idx_poll_votes_valid ON poll_votes(is_valid);
