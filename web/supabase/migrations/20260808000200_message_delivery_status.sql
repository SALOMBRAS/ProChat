-- Amplia o CHECK de public.whatsapp_messages.status para aceitar recibos.
--
-- No Postgres não há reconstrução de tabela: troca-se a constraint. Nenhum dado
-- existente muda de valor e o conjunto permitido apenas cresce, então nenhuma
-- linha atual pode violar a nova regra.
--
-- Sem isto, gravar um recibo `delivered`/`read` falha em runtime com violação
-- de constraint — foi exatamente assim que a limitação apareceu.

BEGIN;

ALTER TABLE public.whatsapp_messages DROP CONSTRAINT IF EXISTS whatsapp_messages_status_check;
ALTER TABLE public.whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_status_check
  CHECK (status IN ('sending', 'received', 'sent', 'delivered', 'read', 'failed'));

COMMIT;
