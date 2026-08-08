-- provider_session_id ANULÁVEL nas tabelas técnicas de WhatsApp (Supabase).
--
-- Depende de 20260807000100_whatsapp_provider_sessions.sql, que precisa ser
-- aplicada ANTES: é ela que cria a tabela referenciada pela FK abaixo.
--
-- Aditiva e não destrutiva: `waha_session` continua existindo e sendo escrita.
-- Nenhuma chave de unicidade muda aqui; a troca de PK/UNIQUE é fase própria,
-- depois de o backfill provar cobertura de 100%.
--
-- `contacts` e `contact_identifiers` NÃO recebem a coluna: são entidades de CRM
-- do workspace e o mesmo cliente pode existir em mais de uma conexão.

BEGIN;

ALTER TABLE public.conversations       ADD COLUMN IF NOT EXISTS provider_session_id uuid NULL;
ALTER TABLE public.whatsapp_messages   ADD COLUMN IF NOT EXISTS provider_session_id uuid NULL;
ALTER TABLE public.whatsapp_identities ADD COLUMN IF NOT EXISTS provider_session_id uuid NULL;
ALTER TABLE public.whatsapp_groups     ADD COLUMN IF NOT EXISTS provider_session_id uuid NULL;
ALTER TABLE public.waha_webhook_events ADD COLUMN IF NOT EXISTS provider_session_id uuid NULL;
ALTER TABLE public.whatsapp_sync_jobs  ADD COLUMN IF NOT EXISTS provider_session_id uuid NULL;
ALTER TABLE public.inbox_outbox_jobs   ADD COLUMN IF NOT EXISTS provider_session_id uuid NULL;

-- FK com ON DELETE SET NULL: apagar uma provider session é operação de
-- infraestrutura e não pode levar junto conversa ou mensagem do cliente.
-- NOT VALID evita varrer 30k linhas no ALTER; as linhas antigas são todas NULL
-- e a validação pode ser feita depois, fora da janela de deploy.
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_provider_session_fkey
  FOREIGN KEY (provider_session_id) REFERENCES public.whatsapp_provider_sessions(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_provider_session_fkey
  FOREIGN KEY (provider_session_id) REFERENCES public.whatsapp_provider_sessions(id) ON DELETE SET NULL NOT VALID;

-- Índice que sustenta o ACK. Sem ele, localizar a mensagem por
-- (workspace, provider session, external id) vira varredura.
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_provider_session
  ON public.whatsapp_messages(workspace_id, provider_session_id, external_message_id);
CREATE INDEX IF NOT EXISTS idx_conversations_provider_session
  ON public.conversations(workspace_id, provider_session_id, chat_id);

COMMIT;
