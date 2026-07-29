-- PROPOSTA — NÃO EXECUTADA em produção. Aguarda aprovação.
-- Contexto: docs/midia-colunas-dedicadas.md
--
-- Duas coisas separadas moram neste arquivo:
--
--   PARTE A — BACKFILL das colunas de mídia já gravadas nulas. Não cria nada e
--             não altera schema; só copia para a coluna o que já está no
--             payload da própria linha. O SELECT de conferência está liberado;
--             o UPDATE está comentado.
--
--   PARTE B — COLUNA DEDICADA PARA A FORMA DE ONDA. É a única parte que exigiria
--             migration, e a recomendação é NÃO criar. O DDL está escrito e
--             inteiramente comentado, para decisão.
--
-- A correção de código (waha-webhook.service.ts, messageFrom passa a ler cada
-- campo de mídia na raiz e depois em payload._data) impede novos casos, mas não
-- desfaz os já gravados — daí a PARTE A.
--
-- ---------------------------------------------------------------------------
-- MEDIÇÃO (2026-07-29)
-- ---------------------------------------------------------------------------
-- Método: leitura somente-leitura do Supabase de produção via PostgREST, com as
-- credenciais de web/.env.local. 6 833 linhas de whatsapp_messages baixadas em
-- páginas de 500 e conferidas localmente. O remoto NÃO foi escrito em momento
-- algum, e nenhuma migration foi aplicada.
--
-- Estado das colunas dedicadas, considerando só as 2 350 mensagens de mídia
-- (image, video, ptt, audio, document, sticker):
--
--   duration          nula em 100 % — inclusive nas 338 notas de voz
--   media_size        preenchida só onde o worker baixou o arquivo depois
--   media_filename    ausente em 59 dos 77 documentos
--   media_mime_type   nula em 1 270 das 2 350
--
-- O dado existia em todas: _data.duration, _data.size, _data.filename e
-- _data.mimetype. O que faltava era a leitura.
--
-- Linhas que este backfill preenche (contadas na base de produção):
--
--   duration           475
--   media_size       1 379   (as outras 971 já vieram do download, e conferem
--                             com _data.size em 971 de 971 — nenhuma diverge)
--   media_filename      59
--   media_mime_type  1 273   (1 256 vindas de _data e 17 da raiz do payload;
--                             nessas 17 raiz e _data dizem a mesma coisa)
--
-- NADA é sobrescrito: o COALESCE põe a coluna existente na frente. Onde ela já
-- tem valor, ela vence — é a mesma precedência do código.
--
-- ---------------------------------------------------------------------------
-- A REGRA, QUE É A MESMA DO CÓDIGO
-- ---------------------------------------------------------------------------
-- Campo a campo, raiz primeiro e _data depois, exatamente na ordem que
-- messageFrom aplica:
--
--   media_mime_type  media.mimetype -> media.mimeType -> _data.mimetype
--   media_filename   media.filename -> filename       -> _data.filename
--   media_size       media.filesize -> media.size     -> mediaSize -> _data.size
--   duration         media.duration -> duration       -> _data.duration
--
-- Ler só _data daria o mesmo resultado nesta base (as 17 linhas de mime em que a
-- raiz vence trazem o mesmo valor nas duas origens), mas prender a precedência
-- aqui é o que impede a coluna de ter duas verdades: a linha antiga preenchida
-- por uma regra e a nova por outra. Há teste em apps/api/test comparando o
-- resultado deste SQL com o da ingestão sobre o mesmo payload.
--
-- Os guardas de dígito existem por dois motivos: _data traz o número como TEXTO
-- ("size": "98301"), e um texto que não seja dígito puro não pode virar 0
-- silenciosamente — 0 chega na tela como "0 B". O limite de 15 dígitos é o
-- Number.isSafeInteger do código, arredondado para baixo; o de 9 é o teto do
-- integer de duration.
--
-- DIFERENÇA CONHECIDA E ACEITA: para os campos de texto o código exige que o
-- JSON seja string, e o SQL aceita também número (um "filename": 1234 viraria
-- '1234' aqui e NULL no código). Não ocorre em nenhuma das 6 833 linhas.
--
-- ---------------------------------------------------------------------------
-- VALIDAÇÃO (2026-07-29) — o SQL da PARTE A foi EXECUTADO, num espelho
-- ---------------------------------------------------------------------------
-- PostgreSQL 16 num contêiner descartável, carregado com um espelho
-- somente-leitura das 6 833 linhas de produção (as três colunas da chave, as
-- quatro colunas de mídia, media_storage_path e o payload). O remoto NÃO foi
-- escrito em momento algum.
--
--   conferência antes  ->  475 | 1 379 | 59 | 1 273, divergentes 0 e 0
--   UPDATE             ->  1 570 linhas afetadas (a união das quatro colunas:
--                          uma nota de voz preenche duração, tamanho e mime de
--                          uma vez)
--   conferência depois ->  0 | 0 | 0 | 0  (rodar de novo não faz nada)
--
-- E o teste que importa: comparando as 6 833 linhas do espelho já corrigido com
-- o que messageFrom extrairia do mesmo payload, campo a campo — 6 833 de 6 833
-- iguais, 0 divergentes. O backfill e a ingestão não deixam duas verdades na
-- mesma coluna.
--
-- A parte SQLite roda em teste, contra o schema do repositório:
-- apps/api/test/midia-colunas-backfill-sql.test.ts.
--
-- ###########################################################################
-- PARTE A — BACKFILL
-- ###########################################################################

-- ---------------------------------------------------------------------------
-- A1) Supabase / PostgreSQL — CONFERÊNCIA (liberada, apenas lê)
-- ---------------------------------------------------------------------------
-- Rode primeiro. Os quatro números têm de bater com a medição acima; se não
-- baterem, a base mudou desde 2026-07-29 e o UPDATE não deve ser executado sem
-- refazer a medição.
WITH extraido AS (
  SELECT
    media_mime_type,
    media_filename,
    media_size,
    duration,
    left(COALESCE(
      nullif(payload_json -> 'media' ->> 'mimetype', ''),
      nullif(payload_json -> 'media' ->> 'mimeType', ''),
      nullif(payload_json -> '_data' ->> 'mimetype', '')
    ), 20000) AS mime_do_payload,
    left(COALESCE(
      nullif(payload_json -> 'media' ->> 'filename', ''),
      nullif(payload_json ->> 'filename', ''),
      nullif(payload_json -> '_data' ->> 'filename', '')
    ), 20000) AS filename_do_payload,
    COALESCE(
      CASE WHEN payload_json -> 'media' ->> 'filesize' ~ '^[0-9]{1,15}$' THEN (payload_json -> 'media' ->> 'filesize')::bigint END,
      CASE WHEN payload_json -> 'media' ->> 'size'     ~ '^[0-9]{1,15}$' THEN (payload_json -> 'media' ->> 'size')::bigint END,
      CASE WHEN payload_json ->> 'mediaSize'           ~ '^[0-9]{1,15}$' THEN (payload_json ->> 'mediaSize')::bigint END,
      CASE WHEN payload_json -> '_data' ->> 'size'     ~ '^[0-9]{1,15}$' THEN (payload_json -> '_data' ->> 'size')::bigint END
    ) AS size_do_payload,
    COALESCE(
      CASE WHEN payload_json -> 'media' ->> 'duration' ~ '^[0-9]{1,9}$' THEN (payload_json -> 'media' ->> 'duration')::integer END,
      CASE WHEN payload_json ->> 'duration'            ~ '^[0-9]{1,9}$' THEN (payload_json ->> 'duration')::integer END,
      CASE WHEN payload_json -> '_data' ->> 'duration' ~ '^[0-9]{1,9}$' THEN (payload_json -> '_data' ->> 'duration')::integer END
    ) AS duration_do_payload
  FROM public.whatsapp_messages
)
SELECT
  count(*) FILTER (WHERE duration        IS NULL AND duration_do_payload IS NOT NULL) AS duration_a_preencher,
  count(*) FILTER (WHERE media_size      IS NULL AND size_do_payload     IS NOT NULL) AS media_size_a_preencher,
  count(*) FILTER (WHERE media_filename  IS NULL AND filename_do_payload IS NOT NULL) AS media_filename_a_preencher,
  count(*) FILTER (WHERE media_mime_type IS NULL AND mime_do_payload     IS NOT NULL) AS media_mime_type_a_preencher,
  -- Conferência de segurança: onde a coluna JÁ tem valor, o payload não pode
  -- discordar. Esperado: 0 nas duas.
  count(*) FILTER (WHERE media_size      IS NOT NULL AND size_do_payload IS NOT NULL AND media_size <> size_do_payload) AS size_divergente,
  count(*) FILTER (WHERE media_filename  IS NOT NULL AND filename_do_payload IS NOT NULL AND media_filename <> filename_do_payload) AS filename_divergente
FROM extraido;

-- ---------------------------------------------------------------------------
-- A2) Supabase / PostgreSQL — BACKFILL (COMENTADO — não executar sem aprovação)
-- ---------------------------------------------------------------------------
-- Um único UPDATE, com a expressão escrita uma vez só na CTE. O COALESCE com a
-- própria coluna é o que garante que nada preenchido seja sobrescrito; o WHERE
-- é o que impede reescrever linha que não muda.
--
-- Linhas afetadas esperadas: 1 570 (a união das quatro colunas — uma linha de
-- nota de voz preenche duração, tamanho e mime de uma vez). Medido no espelho.
--
-- BEGIN;
--
-- WITH extraido AS (
--   SELECT
--     workspace_id, waha_session, external_message_id,
--     left(COALESCE(
--       nullif(payload_json -> 'media' ->> 'mimetype', ''),
--       nullif(payload_json -> 'media' ->> 'mimeType', ''),
--       nullif(payload_json -> '_data' ->> 'mimetype', '')
--     ), 20000) AS mime_do_payload,
--     left(COALESCE(
--       nullif(payload_json -> 'media' ->> 'filename', ''),
--       nullif(payload_json ->> 'filename', ''),
--       nullif(payload_json -> '_data' ->> 'filename', '')
--     ), 20000) AS filename_do_payload,
--     COALESCE(
--       CASE WHEN payload_json -> 'media' ->> 'filesize' ~ '^[0-9]{1,15}$' THEN (payload_json -> 'media' ->> 'filesize')::bigint END,
--       CASE WHEN payload_json -> 'media' ->> 'size'     ~ '^[0-9]{1,15}$' THEN (payload_json -> 'media' ->> 'size')::bigint END,
--       CASE WHEN payload_json ->> 'mediaSize'           ~ '^[0-9]{1,15}$' THEN (payload_json ->> 'mediaSize')::bigint END,
--       CASE WHEN payload_json -> '_data' ->> 'size'     ~ '^[0-9]{1,15}$' THEN (payload_json -> '_data' ->> 'size')::bigint END
--     ) AS size_do_payload,
--     COALESCE(
--       CASE WHEN payload_json -> 'media' ->> 'duration' ~ '^[0-9]{1,9}$' THEN (payload_json -> 'media' ->> 'duration')::integer END,
--       CASE WHEN payload_json ->> 'duration'            ~ '^[0-9]{1,9}$' THEN (payload_json ->> 'duration')::integer END,
--       CASE WHEN payload_json -> '_data' ->> 'duration' ~ '^[0-9]{1,9}$' THEN (payload_json -> '_data' ->> 'duration')::integer END
--     ) AS duration_do_payload
--   FROM public.whatsapp_messages
--   WHERE media_mime_type IS NULL OR media_filename IS NULL OR media_size IS NULL OR duration IS NULL
-- )
-- UPDATE public.whatsapp_messages m
--    SET media_mime_type = COALESCE(m.media_mime_type, e.mime_do_payload),
--        media_filename  = COALESCE(m.media_filename,  e.filename_do_payload),
--        media_size      = COALESCE(m.media_size,      e.size_do_payload),
--        duration        = COALESCE(m.duration,        e.duration_do_payload)
--   FROM extraido e
--  WHERE m.workspace_id = e.workspace_id
--    AND m.waha_session = e.waha_session
--    AND m.external_message_id = e.external_message_id
--    AND ((m.media_mime_type IS NULL AND e.mime_do_payload     IS NOT NULL)
--      OR (m.media_filename  IS NULL AND e.filename_do_payload IS NOT NULL)
--      OR (m.media_size      IS NULL AND e.size_do_payload     IS NOT NULL)
--      OR (m.duration        IS NULL AND e.duration_do_payload IS NOT NULL));
--
-- COMMIT;
--
-- REVERSÃO: depois do COMMIT não há desfazer seletivo, porque a coluna não
-- guarda de onde o valor veio. O que existe é reproduzir o estado anterior, já
-- que todo valor gravado é derivado do payload da própria linha — apagar de
-- volta só onde a coluna é IGUAL ao que o payload diz e o worker nunca baixou o
-- arquivo (media_storage_path IS NULL é o que separa este backfill do que a
-- persistência de mídia gravou):
--
-- UPDATE public.whatsapp_messages
--    SET duration = NULL
--  WHERE media_storage_path IS NULL
--    AND duration IS NOT NULL
--    AND duration = (payload_json -> '_data' ->> 'duration')::integer;
--
-- (idem para media_size, media_filename e media_mime_type.)

-- ---------------------------------------------------------------------------
-- A3) SQLite local — CONFERÊNCIA (liberada, apenas lê)
-- ---------------------------------------------------------------------------
-- Mesma regra, sintaxe do provedor local. json_extract devolve o valor como
-- TEXT quando ele foi serializado como texto, que é o caso de size e duration em
-- _data; GLOB '*[^0-9]*' é o "contém não-dígito" do SQLite.
WITH extraido AS (
  SELECT
    mediaMimeType,
    mediaFilename,
    mediaSize,
    duration,
    substr(COALESCE(
      nullif(json_extract(payloadJson, '$.media.mimetype'), ''),
      nullif(json_extract(payloadJson, '$.media.mimeType'), ''),
      nullif(json_extract(payloadJson, '$._data.mimetype'), '')
    ), 1, 20000) AS mimeDoPayload,
    substr(COALESCE(
      nullif(json_extract(payloadJson, '$.media.filename'), ''),
      nullif(json_extract(payloadJson, '$.filename'), ''),
      nullif(json_extract(payloadJson, '$._data.filename'), '')
    ), 1, 20000) AS filenameDoPayload,
    COALESCE(
      CASE WHEN CAST(json_extract(payloadJson, '$.media.filesize') AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.media.filesize') AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$.media.filesize') AS INTEGER) END,
      CASE WHEN CAST(json_extract(payloadJson, '$.media.size')     AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.media.size')     AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$.media.size')     AS INTEGER) END,
      CASE WHEN CAST(json_extract(payloadJson, '$.mediaSize')       AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.mediaSize')       AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$.mediaSize')       AS INTEGER) END,
      CASE WHEN CAST(json_extract(payloadJson, '$._data.size')      AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$._data.size')      AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$._data.size')      AS INTEGER) END
    ) AS sizeDoPayload,
    COALESCE(
      CASE WHEN CAST(json_extract(payloadJson, '$.media.duration') AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.media.duration') AS TEXT)) BETWEEN 1 AND 9 THEN CAST(json_extract(payloadJson, '$.media.duration') AS INTEGER) END,
      CASE WHEN CAST(json_extract(payloadJson, '$.duration')        AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.duration')        AS TEXT)) BETWEEN 1 AND 9 THEN CAST(json_extract(payloadJson, '$.duration')        AS INTEGER) END,
      CASE WHEN CAST(json_extract(payloadJson, '$._data.duration')  AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$._data.duration')  AS TEXT)) BETWEEN 1 AND 9 THEN CAST(json_extract(payloadJson, '$._data.duration')  AS INTEGER) END
    ) AS durationDoPayload
  FROM whatsapp_messages
)
SELECT
  sum(CASE WHEN duration      IS NULL AND durationDoPayload IS NOT NULL THEN 1 ELSE 0 END) AS duration_a_preencher,
  sum(CASE WHEN mediaSize     IS NULL AND sizeDoPayload     IS NOT NULL THEN 1 ELSE 0 END) AS media_size_a_preencher,
  sum(CASE WHEN mediaFilename IS NULL AND filenameDoPayload IS NOT NULL THEN 1 ELSE 0 END) AS media_filename_a_preencher,
  sum(CASE WHEN mediaMimeType IS NULL AND mimeDoPayload     IS NOT NULL THEN 1 ELSE 0 END) AS media_mime_type_a_preencher
FROM extraido;

-- ---------------------------------------------------------------------------
-- A4) SQLite local — BACKFILL (COMENTADO — não executar sem aprovação)
-- ---------------------------------------------------------------------------
-- BEGIN;
--
-- UPDATE whatsapp_messages AS m
--    SET mediaMimeType = COALESCE(m.mediaMimeType, e.mimeDoPayload),
--        mediaFilename = COALESCE(m.mediaFilename, e.filenameDoPayload),
--        mediaSize     = COALESCE(m.mediaSize,     e.sizeDoPayload),
--        duration      = COALESCE(m.duration,      e.durationDoPayload)
--   FROM (
--     SELECT
--       workspaceId, wahaSession, externalMessageId,
--       substr(COALESCE(
--         nullif(json_extract(payloadJson, '$.media.mimetype'), ''),
--         nullif(json_extract(payloadJson, '$.media.mimeType'), ''),
--         nullif(json_extract(payloadJson, '$._data.mimetype'), '')
--       ), 1, 20000) AS mimeDoPayload,
--       substr(COALESCE(
--         nullif(json_extract(payloadJson, '$.media.filename'), ''),
--         nullif(json_extract(payloadJson, '$.filename'), ''),
--         nullif(json_extract(payloadJson, '$._data.filename'), '')
--       ), 1, 20000) AS filenameDoPayload,
--       COALESCE(
--         CASE WHEN CAST(json_extract(payloadJson, '$.media.filesize') AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.media.filesize') AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$.media.filesize') AS INTEGER) END,
--         CASE WHEN CAST(json_extract(payloadJson, '$.media.size')     AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.media.size')     AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$.media.size')     AS INTEGER) END,
--         CASE WHEN CAST(json_extract(payloadJson, '$.mediaSize')       AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.mediaSize')       AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$.mediaSize')       AS INTEGER) END,
--         CASE WHEN CAST(json_extract(payloadJson, '$._data.size')      AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$._data.size')      AS TEXT)) BETWEEN 1 AND 15 THEN CAST(json_extract(payloadJson, '$._data.size')      AS INTEGER) END
--       ) AS sizeDoPayload,
--       COALESCE(
--         CASE WHEN CAST(json_extract(payloadJson, '$.media.duration') AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.media.duration') AS TEXT)) BETWEEN 1 AND 9 THEN CAST(json_extract(payloadJson, '$.media.duration') AS INTEGER) END,
--         CASE WHEN CAST(json_extract(payloadJson, '$.duration')        AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$.duration')        AS TEXT)) BETWEEN 1 AND 9 THEN CAST(json_extract(payloadJson, '$.duration')        AS INTEGER) END,
--         CASE WHEN CAST(json_extract(payloadJson, '$._data.duration')  AS TEXT) NOT GLOB '*[^0-9]*' AND length(CAST(json_extract(payloadJson, '$._data.duration')  AS TEXT)) BETWEEN 1 AND 9 THEN CAST(json_extract(payloadJson, '$._data.duration')  AS INTEGER) END
--       ) AS durationDoPayload
--     FROM whatsapp_messages
--     WHERE mediaMimeType IS NULL OR mediaFilename IS NULL OR mediaSize IS NULL OR duration IS NULL
--   ) AS e
--  WHERE m.workspaceId = e.workspaceId
--    AND m.wahaSession = e.wahaSession
--    AND m.externalMessageId = e.externalMessageId
--    AND ((m.mediaMimeType IS NULL AND e.mimeDoPayload     IS NOT NULL)
--      OR (m.mediaFilename IS NULL AND e.filenameDoPayload IS NOT NULL)
--      OR (m.mediaSize     IS NULL AND e.sizeDoPayload     IS NOT NULL)
--      OR (m.duration      IS NULL AND e.durationDoPayload IS NOT NULL));
--
-- COMMIT;

-- ###########################################################################
-- PARTE B — COLUNA DEDICADA PARA A FORMA DE ONDA
-- ###########################################################################
--
-- RECOMENDAÇÃO: NÃO CRIAR. O raciocínio inteiro está em
-- docs/midia-colunas-dedicadas.md, seção "Forma de onda". Em resumo:
--
--   - a onda existe em 340 das 6 833 linhas (5,0 %), e só em nota de voz;
--   - são sempre exatamente 64 amplitudes, ~496 bytes de JSON;
--   - o payload já é devolvido inteiro ao dashboard pelo leitor de mensagens,
--     então a onda JÁ CHEGA À TELA hoje, sem coluna nenhuma;
--   - uma coluna nova custaria duas migrations e um backfill para entregar o
--     mesmo byte que já está chegando.
--
-- O que justificaria criar: FILTRAR ou ORDENAR por forma de onda, que ninguém
-- faz nem pediu; ou parar de devolver o payload inteiro ao dashboard, que é uma
-- decisão maior e teria de vir antes.
--
-- O DDL abaixo fica escrito para o caso de a decisão ser outra. Está inteiro
-- comentado e NÃO foi executado.
--
-- -- Supabase / PostgreSQL
-- ALTER TABLE public.whatsapp_messages
--   ADD COLUMN IF NOT EXISTS media_waveform smallint[] NULL;
-- COMMENT ON COLUMN public.whatsapp_messages.media_waveform IS
--   '64 amplitudes 0-100 da nota de voz, como o WhatsApp as manda em _data.waveform.';
--
-- -- Backfill: _data.waveform chega como OBJETO de chaves numéricas
-- -- ({"0":0,"1":27,...}), não como array — é assim que o JSON do WhatsApp
-- -- atravessa a WAHA. Por isso o jsonb_each e o ORDER BY numérico da chave.
-- WITH onda AS (
--   SELECT workspace_id, waha_session, external_message_id,
--          array_agg((value #>> '{}')::smallint ORDER BY (key)::int) AS amplitudes
--     FROM public.whatsapp_messages,
--          LATERAL jsonb_each(payload_json -> '_data' -> 'waveform')
--    WHERE jsonb_typeof(payload_json -> '_data' -> 'waveform') = 'object'
--    GROUP BY workspace_id, waha_session, external_message_id
-- )
-- UPDATE public.whatsapp_messages m
--    SET media_waveform = o.amplitudes
--   FROM onda o
--  WHERE m.workspace_id = o.workspace_id
--    AND m.waha_session = o.waha_session
--    AND m.external_message_id = o.external_message_id
--    AND m.media_waveform IS NULL;   -- esperado: 340
--
-- -- SQLite local
-- ALTER TABLE whatsapp_messages ADD COLUMN mediaWaveform TEXT;
-- UPDATE whatsapp_messages
--    SET mediaWaveform = json_extract(payloadJson, '$._data.waveform')
--  WHERE mediaWaveform IS NULL
--    AND json_extract(payloadJson, '$._data.waveform') IS NOT NULL;
