ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'sent'));
