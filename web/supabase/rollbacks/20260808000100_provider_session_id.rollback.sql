-- ROLLBACK de 20260808000100_provider_session_id.sql (Supabase).
-- NÃO é migration: o runner do SQLite ignora ".rollback.sql", e o Supabase CLI
-- não aplica este arquivo. Rode À MÃO.
-- ATENÇÃO: DROP COLUMN descarta o vínculo já gravado.
--
-- Ordem inversa: este rollback ANTES do rollback de
-- 20260807000100_whatsapp_provider_sessions, porque as FKs abaixo apontam para
-- a tabela que aquele derruba.
--
-- Seguro quanto a dado do cliente: a coluna é anulável, `waha_session` seguiu
-- sendo escrita o tempo todo, e nenhuma chave de unicidade foi alterada.

BEGIN;

DROP INDEX IF EXISTS public.idx_conversations_provider_session;
DROP INDEX IF EXISTS public.idx_whatsapp_messages_provider_session;

ALTER TABLE public.conversations     DROP CONSTRAINT IF EXISTS conversations_provider_session_fkey;
ALTER TABLE public.whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_provider_session_fkey;

ALTER TABLE public.inbox_outbox_jobs   DROP COLUMN IF EXISTS provider_session_id;
ALTER TABLE public.whatsapp_sync_jobs  DROP COLUMN IF EXISTS provider_session_id;
ALTER TABLE public.waha_webhook_events DROP COLUMN IF EXISTS provider_session_id;
ALTER TABLE public.whatsapp_groups     DROP COLUMN IF EXISTS provider_session_id;
ALTER TABLE public.whatsapp_identities DROP COLUMN IF EXISTS provider_session_id;
ALTER TABLE public.whatsapp_messages   DROP COLUMN IF EXISTS provider_session_id;
ALTER TABLE public.conversations       DROP COLUMN IF EXISTS provider_session_id;

COMMIT;
