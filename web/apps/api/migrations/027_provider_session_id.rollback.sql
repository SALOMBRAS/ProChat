-- Rollback de 027_provider_session_id.sql
--
-- Seguro: a coluna é anulável, nada a referencia e nenhuma chave de unicidade
-- foi alterada. `wahaSession` seguiu sendo escrita o tempo todo, então derrubar
-- providerSessionId não deixa nenhuma linha sem escopo de sessão.
--
-- ATENÇÃO: DROP COLUMN descarta o vínculo já gravado. Reaplicar a migration
-- devolve as colunas vazias, e as linhas novas voltam a preenchê-las; linhas
-- antigas só recuperam o valor por backfill.

DROP INDEX IF EXISTS idx_conversations_provider_session;
DROP INDEX IF EXISTS idx_whatsapp_messages_provider_session;

ALTER TABLE inbox_outbox_jobs    DROP COLUMN providerSessionId;
ALTER TABLE whatsapp_sync_jobs   DROP COLUMN providerSessionId;
ALTER TABLE waha_webhook_events  DROP COLUMN providerSessionId;
ALTER TABLE whatsapp_groups      DROP COLUMN providerSessionId;
ALTER TABLE whatsapp_identities  DROP COLUMN providerSessionId;
ALTER TABLE whatsapp_messages    DROP COLUMN providerSessionId;
ALTER TABLE conversations        DROP COLUMN providerSessionId;

-- Sem esta linha o runner pula o arquivo e reaplicar vira no-op silencioso.
DELETE FROM schema_migrations WHERE id = '027_provider_session_id.sql';
