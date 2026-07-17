ALTER TABLE whatsapp_identities ADD COLUMN shortName TEXT;
ALTER TABLE whatsapp_identities ADD COLUMN canonicalWhatsappId TEXT;
UPDATE whatsapp_identities SET canonicalWhatsappId = CASE WHEN whatsappId LIKE '%@c.us' THEN whatsappId WHEN phone IS NOT NULL AND phone <> '' THEN phone || '@c.us' ELSE whatsappId END;
CREATE INDEX idx_whatsapp_identities_canonical ON whatsapp_identities(workspaceId, wahaSession, canonicalWhatsappId);

ALTER TABLE conversations ADD COLUMN canonicalChatId TEXT;
ALTER TABLE conversations ADD COLUMN deliveryChatId TEXT;
UPDATE conversations SET canonicalChatId = chatId, deliveryChatId = chatId;
CREATE UNIQUE INDEX idx_conversations_direct_canonical ON conversations(workspaceId, wahaSession, canonicalChatId) WHERE conversationType = 'direct';
