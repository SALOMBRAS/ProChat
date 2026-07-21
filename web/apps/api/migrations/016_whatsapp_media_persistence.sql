ALTER TABLE whatsapp_messages ADD COLUMN mediaStoragePath TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN mediaChecksum TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN mediaPersistenceStatus TEXT NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS whatsapp_messages_media_persistence_idx ON whatsapp_messages(mediaPersistenceStatus, mediaUrl);
