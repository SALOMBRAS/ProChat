-- ROLLBACK de 20260807000100_whatsapp_provider_sessions.sql (Supabase).
-- NÃO é migration: o runner do SQLite ignora ".rollback.sql", e o Supabase CLI
-- não aplica este arquivo. Rode À MÃO.
-- ATENÇÃO: DROP TABLE descarta os dados.
--
-- A tabela é nova e nenhuma tabela da Inbox a referencia: não existe FK para
-- public.whatsapp_provider_sessions em conversations, whatsapp_messages,
-- whatsapp_identities, whatsapp_groups, waha_webhook_events, whatsapp_sync_jobs
-- ou inbox_outbox_jobs. Derrubá-la não deixa referência órfã.
--
-- O que se perde é o mapa sessão ChatPro -> device do provider. O device segue
-- existindo no GOWA; sem o mapa, o worker não o reconcilia no boot e o webhook
-- passa a responder 404 ("GOWA webhook session is unknown") até que a sessão
-- seja recriada. O providerDeviceId é derivado por hash de
-- (workspaceId, sessionId), então a recriação reaproveita o mesmo device.
--
-- TRANSAÇÃO EXPLÍCITA, como nos demais rollbacks do diretório: colado em psql
-- com autocommit, um bloco solto executa os comandos SEGUINTES a um que falhou
-- e deixa o banco meio revertido. Rodar com `psql -v ON_ERROR_STOP=1` não
-- dispensa o envelope.

BEGIN;
DROP INDEX IF EXISTS public.idx_whatsapp_provider_sessions_provider_workspace;
DROP TABLE IF EXISTS public.whatsapp_provider_sessions;
COMMIT;

-- Não há REVOKE a fazer: o GRANT da migration é sobre a tabela e desaparece
-- com ela.
