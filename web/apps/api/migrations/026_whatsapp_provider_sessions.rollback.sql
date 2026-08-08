-- Rollback de 026_whatsapp_provider_sessions.sql
--
-- A tabela é nova e nenhuma tabela da Inbox a referencia: não existe FK para
-- `whatsapp_provider_sessions` em conversations, whatsapp_messages,
-- whatsapp_identities, whatsapp_groups, waha_webhook_events, whatsapp_sync_jobs
-- ou inbox_outbox_jobs. Derrubá-la não deixa referência órfã.
--
-- ATENÇÃO: descarta o vínculo sessão ChatPro -> device do provider. Para GOWA,
-- o device continua existindo no lado do provider; o que se perde é o mapa que
-- permite reconciliá-lo no boot. Reaplicar a migration devolve a tabela vazia e
-- o worker recria o vínculo no próximo `createSession` — com o MESMO
-- providerDeviceId, porque ele é derivado por hash de (workspaceId, sessionId)
-- em GowaSessionRegistry, e não sorteado.
--
-- O índice cai junto com a tabela; o DROP INDEX explícito existe só para o caso
-- de a tabela já ter sido removida à mão e o índice ter sobrado.

DROP INDEX IF EXISTS idx_whatsapp_provider_sessions_provider_workspace;
DROP TABLE IF EXISTS whatsapp_provider_sessions;

-- O runner grava cada arquivo aplicado em `schema_migrations` e pula o que já
-- está lá. Sem esta linha, reaplicar a migration é um no-op silencioso e a
-- tabela não volta.
DELETE FROM schema_migrations WHERE id = '026_whatsapp_provider_sessions.sql';
