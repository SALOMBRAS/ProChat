-- Gêmea SQLite de supabase/migrations/20260803000100_reclassify_location_and_vcard.sql
--
-- Mesmo conserto, mesmo escopo, vocabulário do SQLite: colunas em camelCase e
-- `json_extract` no lugar dos operadores `->`/`->>`.
--
-- CONTEXTO
-- A ingestão classificava pela raiz `type` do payload, que o WAHA/WEBJS não
-- preenche. Sem tipo, uma localização caía em `text` — e o `body` da raiz de uma
-- localização é a MINIATURA do mapa em base64, então o blob ia para a coluna de
-- texto e para `conversations.lastMessage`.
--
-- A correção de ingestão está em apps/api/src/services/waha-webhook.service.ts
-- e vale para o que chegar daqui em diante. Este arquivo conserta o gravado.
--
--
-- OS NÚMEROS ACIMA SÃO UM INSTANTÂNEO, NÃO UM CONTRATO. A base está viva: durante
-- a investigação as linhas de `location` passaram de 13 para 17, porque a
-- sincronização continua ingerindo com o defeito até a correção subir. Os UPDATEs
-- são escritos por PREDICADO e não por contagem, então alcançam o que existir na
-- hora de aplicar. Rode a verificação do fim do arquivo depois: ela é a resposta
-- certa, não os números daqui.
-- NÃO adota o vocabulário cru do WEBJS: `chat` continua sendo `text`. Traduzir
-- tudo renomearia 83% das linhas — o precedente da #57.
--
-- Idempotente: rodar duas vezes não muda nada na segunda.
--
-- Sem BEGIN/COMMIT: o runner de migrations do SQLite já envolve cada arquivo
-- numa transação (apps/api/src/persistence/database.ts:34), e abrir outra por
-- dentro faz o better-sqlite3 recusar com "cannot start a transaction within a
-- transaction". Nenhuma outra migration desta árvore usa BEGIN.

-- 1. Localização: tipo correto, e o corpo deixa de ser a miniatura.
UPDATE whatsapp_messages
   SET messageType = 'location',
       body        = NULLIF(json_extract(payloadJson, '$.location.name'), '')
 WHERE json_extract(payloadJson, '$._data.type') = 'location'
   AND messageType <> 'location';

-- 2. Cartão de contato: mesmo defeito, mesma causa.
--    O `body` do cartão NÃO é limpo, ao contrário do da localização. Nos dois o
--    texto está duplicado no payload, mas aqui o corpo é o próprio vCard — dado,
--    não lixo — e a Inbox já o suprime na tela (`bodyRepeatsCard`). Apagar seria
--    destruir a única cópia legível fora do JSON, sem ganho.
UPDATE whatsapp_messages
   SET messageType = 'contact'
 WHERE json_extract(payloadJson, '$._data.type') IN ('vcard', 'multi_vcard')
   AND messageType <> 'contact';

-- 3. A prévia da conversa, que é gravada e não recalculada no render.
UPDATE conversations
   SET lastMessage = 'Localização'
 WHERE lastMessage LIKE '/9j/%'
   AND EXISTS (
         SELECT 1
           FROM whatsapp_messages m
          WHERE m.workspaceId = conversations.workspaceId
            AND m.wahaSession = conversations.wahaSession
            AND m.chatId      = conversations.chatId
            AND m.occurredAt  = conversations.lastMessageAt
            AND m.messageType = 'location');

-- 4. A mesma contaminação, pelo outro tipo: o WEBJS copia o vCard inteiro para
--    `body`, e daí ele foi para a prévia.
UPDATE conversations
   SET lastMessage = 'Contato'
 WHERE lastMessage LIKE 'BEGIN:VCARD%'
   AND EXISTS (
         SELECT 1
           FROM whatsapp_messages m
          WHERE m.workspaceId = conversations.workspaceId
            AND m.wahaSession = conversations.wahaSession
            AND m.chatId      = conversations.chatId
            AND m.occurredAt  = conversations.lastMessageAt
            AND m.messageType = 'contact');

-- VERIFICAÇÃO (deve devolver zero nas quatro)
--
--   SELECT count(*) FROM whatsapp_messages
--    WHERE json_extract(payloadJson,'$._data.type')='location' AND messageType<>'location';
--   SELECT count(*) FROM whatsapp_messages
--    WHERE json_extract(payloadJson,'$._data.type') IN ('vcard','multi_vcard') AND messageType<>'contact';
--   SELECT count(*) FROM whatsapp_messages WHERE body LIKE '/9j/%';
--   SELECT count(*) FROM conversations WHERE lastMessage LIKE '/9j/%';
--   SELECT count(*) FROM conversations WHERE lastMessage LIKE 'BEGIN:VCARD%';
