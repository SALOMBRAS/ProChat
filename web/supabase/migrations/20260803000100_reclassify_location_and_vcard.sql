-- Reclassifica as mensagens recebidas cujo tipo real só existe em `_data.type`.
--
-- CONTEXTO
-- A ingestão classificava pela raiz `type` do payload, que o WAHA/WEBJS não
-- preenche (15 de 12.851 linhas, e as 15 são envios nossos). Sem tipo, uma
-- localização caía em `text` — e o `body` da raiz de uma localização é a
-- MINIATURA do mapa em base64, então 4 KB de `/9j/4AAQ…` iam para a coluna de
-- texto e para `conversations.last_message`.
--
-- A correção de ingestão está em apps/api/src/services/waha-webhook.service.ts
-- (`canonicalRawTypes` + `bodyFrom`) e vale para o que chegar daqui em diante.
-- Este arquivo conserta o que já está gravado.
--
-- ESCOPO MEDIDO na base em 2026-08-03, somente leitura:
--   13 linhas com _data.type = 'location'   (0 já classificadas como location)
--    6 linhas com _data.type = 'vcard'
--    0 linhas com _data.type = 'multi_vcard'
--    1 conversa com last_message em base64
--
-- NÃO adota o vocabulário cru do WEBJS: `chat` continua sendo `text`. Traduzir
-- tudo renomearia 10.714 das 12.851 linhas (83%) — o precedente da #57.
--
-- Idempotente: rodar duas vezes não muda nada na segunda.

BEGIN;

-- 1. Localização: tipo correto, e o corpo deixa de ser a miniatura.
--    O texto útil é o nome do lugar (raiz `location.name`), que existe só quando
--    o remetente escolheu um ponto nomeado. Sem nome, a localização não tem
--    corpo: o cartão do mapa já diz tudo.
UPDATE public.whatsapp_messages
   SET message_type = 'location',
       body         = NULLIF(payload_json -> 'location' ->> 'name', '')
 WHERE payload_json -> '_data' ->> 'type' = 'location'
   AND message_type IS DISTINCT FROM 'location';

-- 2. Cartão de contato: mesmo defeito, mesma causa. O renderizador desenha a
--    partir do payload (MessageMedia.tsx:332); faltava só a classificação.
UPDATE public.whatsapp_messages
   SET message_type = 'contact'
 WHERE payload_json -> '_data' ->> 'type' IN ('vcard', 'multi_vcard')
   AND message_type IS DISTINCT FROM 'contact';

-- 3. A prévia da conversa. `last_message` é gravada, não recalculada no render,
--    então a miniatura sobreviveria à correção acima. Reescreve apenas as
--    conversas cuja prévia é o base64 de uma miniatura JPEG, e apenas quando a
--    última mensagem da conversa é de fato a localização.
UPDATE public.conversations AS c
   SET last_message = 'Localização'
 WHERE c.last_message LIKE '/9j/%'
   AND EXISTS (
         SELECT 1
           FROM public.whatsapp_messages AS m
          WHERE m.workspace_id = c.workspace_id
            AND m.waha_session = c.waha_session
            AND m.chat_id      = c.chat_id
            AND m.occurred_at  = c.last_message_at
            AND m.message_type = 'location');

COMMIT;

-- VERIFICAÇÃO (rodar depois; deve devolver zero em todas as linhas)
--
--   SELECT 'location mal classificada' AS check, count(*) FROM public.whatsapp_messages
--    WHERE payload_json -> '_data' ->> 'type' = 'location' AND message_type <> 'location'
--   UNION ALL
--   SELECT 'vcard mal classificado', count(*) FROM public.whatsapp_messages
--    WHERE payload_json -> '_data' ->> 'type' IN ('vcard','multi_vcard') AND message_type <> 'contact'
--   UNION ALL
--   SELECT 'corpo com base64', count(*) FROM public.whatsapp_messages
--    WHERE body LIKE '/9j/%'
--   UNION ALL
--   SELECT 'previa com base64', count(*) FROM public.conversations
--    WHERE last_message LIKE '/9j/%';
