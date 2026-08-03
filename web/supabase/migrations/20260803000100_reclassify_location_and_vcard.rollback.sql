-- Rollback de 20260803000100_reclassify_location_and_vcard.sql
--
-- Devolve as linhas ao estado anterior, que é o estado defeituoso: `text` com a
-- miniatura em base64 no corpo. Só faz sentido se a correção de ingestão for
-- revertida junto — com ela no ar, o próximo evento reclassifica de novo.
--
-- Nenhum dado foi perdido pela migration: a miniatura continua intacta em
-- `payload_json -> location ->> thumbnail`, e é de lá que o corpo é reconstruído.
-- Por isso a prévia da conversa também é lida do payload, e NÃO da coluna `body`
-- — na hora do rollback a coluna já está limpa, e lê-la devolveria nada.

BEGIN;

-- 1. A prévia da conversa, direto do payload (a ordem importa: ver acima).
UPDATE public.conversations AS c
   SET last_message = m.payload_json -> 'location' ->> 'thumbnail'
  FROM public.whatsapp_messages AS m
 WHERE c.last_message = 'Localização'
   AND m.workspace_id = c.workspace_id
   AND m.waha_session = c.waha_session
   AND m.chat_id      = c.chat_id
   AND m.occurred_at  = c.last_message_at
   AND m.message_type = 'location'
   AND COALESCE(m.payload_json -> 'location' ->> 'thumbnail', '') <> '';

-- 1b. A prévia contaminada pelo vCard, direto do payload.
UPDATE public.conversations AS c
   SET last_message = m.payload_json -> 'vCards' ->> 0
  FROM public.whatsapp_messages AS m
 WHERE c.last_message = 'Contato'
   AND m.workspace_id = c.workspace_id
   AND m.waha_session = c.waha_session
   AND m.chat_id      = c.chat_id
   AND m.occurred_at  = c.last_message_at
   AND m.message_type = 'contact'
   AND COALESCE(m.payload_json -> 'vCards' ->> 0, '') <> '';

-- 2. As mensagens de localização.
UPDATE public.whatsapp_messages
   SET message_type = 'text',
       body         = NULLIF(payload_json -> 'location' ->> 'thumbnail', '')
 WHERE payload_json -> '_data' ->> 'type' = 'location'
   AND message_type = 'location';

-- 3. Os cartões de contato.
UPDATE public.whatsapp_messages
   SET message_type = 'text'
 WHERE payload_json -> '_data' ->> 'type' IN ('vcard', 'multi_vcard')
   AND message_type = 'contact';

COMMIT;
