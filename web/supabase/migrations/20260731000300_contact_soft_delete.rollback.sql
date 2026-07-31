-- ROLLBACK de M2 (Supabase). NÃO é migration: o runner do SQLite ignora
-- ".rollback.sql", e o Supabase CLI não aplica este arquivo.
-- Rode À MÃO, na ordem inversa: M2 antes de M1.
-- ATENÇÃO: derruba colunas e tabelas — DROP COLUMN descarta os dados.

BEGIN;
DROP FUNCTION IF EXISTS public.chatpro_delete_contact(text, text, text, text, text);
DROP INDEX IF EXISTS public.idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS public.contact_deletion_log;
DROP INDEX IF EXISTS public.idx_contacts_workspace_created_active;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS deleted_at;
COMMIT;
-- Contatos com deleted_at preenchido voltam a aparecer nas listagens. É o
-- comportamento correto: o rollback desfaz o recurso, não apaga ninguém.
