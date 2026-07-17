ALTER TABLE whatsapp_messages ADD COLUMN mediaUrl TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN mediaMimeType TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN mediaFilename TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN mediaSize INTEGER;
ALTER TABLE whatsapp_messages ADD COLUMN thumbnailUrl TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN duration INTEGER;
ALTER TABLE whatsapp_messages ADD COLUMN quotedMessageId TEXT;
