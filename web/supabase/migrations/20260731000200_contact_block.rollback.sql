-- ROLLBACK de M1 (Supabase). NÃO é migration: o runner do SQLite ignora
-- ".rollback.sql", e o Supabase CLI não aplica este arquivo.
-- Rode À MÃO, na ordem inversa: M2 antes de M1.
-- ATENÇÃO: derruba colunas e tabelas — DROP COLUMN descarta os dados.

-- TRANSAÇÃO EXPLÍCITA, aqui e nos outros dois rollbacks: colado em psql com
-- autocommit, um bloco solto executa os comandos SEGUINTES a um que falhou e
-- deixa o banco meio revertido. Ver a nota no rollback de M3, onde isso é
-- destrutivo. Rodar com `psql -v ON_ERROR_STOP=1` não dispensa o envelope.
BEGIN;
DROP INDEX IF EXISTS public.idx_contact_block_events_contact;
DROP TABLE IF EXISTS public.contact_block_events;
DROP INDEX IF EXISTS public.idx_conversations_blocked;
ALTER TABLE public.conversations DROP COLUMN IF EXISTS blocked_at;
DROP INDEX IF EXISTS public.idx_contacts_block_state;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_propagation_check;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_state_check;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_last_error_safe;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_confirmed_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_requested_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_propagation;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_state;
COMMIT;
