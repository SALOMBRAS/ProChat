-- Denominador do progresso da sincronização de histórico. Ver o par SQLite em
-- apps/api/migrations/021_whatsapp_sync_chats_total.sql.
--
-- Nulo é o estado honesto: "esta corrida não sabe o total". Sem NOT NULL e sem
-- DEFAULT — um zero seria lido como "nenhuma conversa", que é outra coisa.
ALTER TABLE public.whatsapp_sync_jobs ADD COLUMN IF NOT EXISTS chats_total integer NULL;
