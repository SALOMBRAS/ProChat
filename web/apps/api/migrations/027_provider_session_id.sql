-- providerSessionId ANULÁVEL nas tabelas técnicas de WhatsApp.
--
-- Aditiva e não destrutiva: `wahaSession` continua existindo e continua sendo
-- escrita. Nenhuma chave de unicidade muda aqui — trocar PK/UNIQUE é uma fase
-- própria, depois de o backfill provar cobertura de 100%.
--
-- Durante a transição:
--   WRITE: providerSessionId quando houver + wahaSession legado, sempre.
--   READ : providerSessionId primeiro, com fallback legado para linha antiga.
--
-- `contacts` e `contact_identifiers` NÃO recebem a coluna de propósito: são
-- entidades de CRM do workspace, e o mesmo cliente pode existir em mais de uma
-- conexão de WhatsApp. Escopá-los por provider fragmentaria a base comercial.

ALTER TABLE conversations        ADD COLUMN providerSessionId TEXT;
ALTER TABLE whatsapp_messages    ADD COLUMN providerSessionId TEXT;
ALTER TABLE whatsapp_identities  ADD COLUMN providerSessionId TEXT;
ALTER TABLE whatsapp_groups      ADD COLUMN providerSessionId TEXT;
ALTER TABLE waha_webhook_events  ADD COLUMN providerSessionId TEXT;
ALTER TABLE whatsapp_sync_jobs   ADD COLUMN providerSessionId TEXT;
ALTER TABLE inbox_outbox_jobs    ADD COLUMN providerSessionId TEXT;

-- Índice que sustenta o ACK: hoje o status é localizado por
-- (workspaceId, externalMessageId), e um mesmo id de mensagem pode existir em
-- duas conexões diferentes — `WAHA vendas/msg-123` e `GOWA vendas/msg-123` são
-- mensagens distintas. Este índice permite a consulta correta sem varredura.
CREATE INDEX idx_whatsapp_messages_provider_session ON whatsapp_messages(workspaceId, providerSessionId, externalMessageId);
CREATE INDEX idx_conversations_provider_session ON conversations(workspaceId, providerSessionId, chatId);
