ALTER TABLE whatsapp_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'sent'));
