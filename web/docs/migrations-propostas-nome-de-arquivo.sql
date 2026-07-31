-- PROPOSTA — NÃO APLICAR
-- PROPOSTA — NÃO EXECUTADA em produção. Aguarda aprovação.
--
-- Backfill de whatsapp_messages.media_filename a partir do payload cru já
-- gravado. Contexto e justificativa em web/docs/nome-de-arquivo-unificacao-proposta.md.
--
-- Isto é DML sobre dado de produção, não DDL: nenhuma coluna, tipo ou índice é
-- alterado. Não é lido pelo runner de migrations e não há como aplicá-lo por
-- acidente.
--
-- Motivo: o webhook lê o nome de `media.filename` e da raiz `filename`, e o
-- provedor o entrega em `_data.filename`. Medido por PostgREST: nulo em 1.252 de
-- 1.260 documentos. O nome nunca se perdeu — está no payload, que é gravado
-- inteiro e cuja redação só cobre chaves sensíveis (`token`, `secret`,
-- `password`, `authorization`...), nas quais `filename` não bate.
--
-- ───────────────────────────────────────────────────────────────────────────
-- VALIDAÇÃO
--
-- Executado em PostgreSQL 16.14 num contêiner descartável e em SQLite pelo
-- `better-sqlite3` do repositório, sobre uma fixture de oito linhas. O banco
-- remoto NÃO foi tocado. As duas árvores produziram resultado idêntico:
--
--   linha  cenário                              resultado
--   m1     nome só em `_data.filename`          recuperado
--   m2     coluna já preenchida                 PRESERVADA (não sobrescrita)
--   m3     nome na raiz `filename`              recuperado
--   m4     nome em `media.filename`             recuperado
--   m5     sem nome em lugar nenhum             continua nulo
--   m6     nome é string vazia                  barrado pelo guard `<> ''`
--   m7     espécie `image`                      intocada (fora do escopo)
--   m8     nome de 25.000 caracteres            cortado em exatamente 20.000
--
-- O ROLLBACK também foi executado: reverteu as 4 linhas que este backfill
-- escreveu e preservou a m2, cujo valor difere do que o payload fornece.

-- ═══════════════════════════════════════════════════════════════════════════
-- SUPABASE (PostgreSQL). payload_json é jsonb.
-- ═══════════════════════════════════════════════════════════════════════════

-- PASSO 1 — Conferência do ponto de partida. NÃO ESCREVE.
-- Confirma o 1.252/1.260 antes de qualquer escrita e mostra quantas linhas o
-- backfill de fato alcança. Se `recuperaveis` for muito menor que `sem_nome`, o
-- nome não está em `_data.filename` e o passo 2 NÃO deve ser executado.
SELECT
  count(*)                                                                   AS documentos,
  count(*) FILTER (WHERE media_filename IS NULL)                             AS sem_nome,
  count(*) FILTER (WHERE media_filename IS NULL
                     AND payload_json -> '_data' ->> 'filename' IS NOT NULL) AS recuperaveis
FROM public.whatsapp_messages
WHERE message_type = 'document';

-- PASSO 2 — Amostra do que seria escrito. NÃO ESCREVE.
-- Leia dez linhas antes de autorizar o UPDATE: é a única chance de ver se o
-- valor recuperado é um nome de arquivo de verdade e não um rótulo do protocolo.
SELECT
  external_message_id,
  occurred_at,
  COALESCE(
    payload_json -> 'media' ->> 'filename',
    payload_json           ->> 'filename',
    payload_json -> '_data' ->> 'filename'
  ) AS nome_recuperado
FROM public.whatsapp_messages
WHERE message_type = 'document'
  AND media_filename IS NULL
  AND COALESCE(
        payload_json -> 'media' ->> 'filename',
        payload_json           ->> 'filename',
        payload_json -> '_data' ->> 'filename'
      ) IS NOT NULL
ORDER BY occurred_at DESC
LIMIT 10;

-- PASSO 3 — O backfill. ESCREVE. Só execute depois dos passos 1 e 2.
--
-- `WHERE media_filename IS NULL` preserva as 8 linhas que já têm nome: o
-- backfill nunca sobrescreve o que o webhook conseguiu ler.
--
-- As duas primeiras chaves do COALESCE são as que o webhook já teria usado,
-- portanto são nulas nestas linhas. Estão aqui de propósito: onde a WAHA põe o
-- nome não está confirmado por payload cru, então a ordem de precedência fica
-- escrita e o resultado não depende de qual chave veio preenchida.
--
-- O limite de 20.000 caracteres espelha o corte do helper `text()` que o webhook
-- aplica na entrada, para que o backfill não grave um valor que o caminho normal
-- teria truncado.
UPDATE public.whatsapp_messages
SET media_filename = left(
      COALESCE(
        payload_json -> 'media' ->> 'filename',
        payload_json           ->> 'filename',
        payload_json -> '_data' ->> 'filename'
      ), 20000)
WHERE message_type = 'document'
  AND media_filename IS NULL
  AND COALESCE(
        payload_json -> 'media' ->> 'filename',
        payload_json           ->> 'filename',
        payload_json -> '_data' ->> 'filename'
      ) <> '';

-- PASSO 4 — Verificação. NÃO ESCREVE. `sem_nome` deve ter caído para o número de
-- documentos em que o payload realmente não traz nome nenhum.
SELECT
  count(*)                                       AS documentos,
  count(*) FILTER (WHERE media_filename IS NULL) AS sem_nome
FROM public.whatsapp_messages
WHERE message_type = 'document';

-- ROLLBACK — devolve ao estado anterior as linhas que ESTE backfill escreveu.
-- Só é correto enquanto nenhuma outra escrita tiver tocado a coluna depois: ele
-- reconhece as linhas pelo fato de o valor atual ser igual ao que o payload
-- fornece. Se o item 3 da proposta (gravar o nome do job na confirmação) já
-- estiver no ar, NÃO use este rollback.
-- UPDATE public.whatsapp_messages
-- SET media_filename = NULL
-- WHERE message_type = 'document'
--   AND media_filename IS NOT NULL
--   AND media_filename = left(COALESCE(
--         payload_json -> 'media' ->> 'filename',
--         payload_json           ->> 'filename',
--         payload_json -> '_data' ->> 'filename'
--       ), 20000);

-- ═══════════════════════════════════════════════════════════════════════════
-- SQLITE (ambiente local). payloadJson é TEXT com CHECK json_valid.
-- Mantido em paridade porque a regra crítica nº 1 do CLAUDE.md pede que os dois
-- provedores não divirjam. Em desenvolvimento a base é descartável, então aqui o
-- backfill é conveniência, não necessidade.
-- ═══════════════════════════════════════════════════════════════════════════

-- Conferência:
-- SELECT count(*) AS documentos,
--        sum(CASE WHEN mediaFilename IS NULL THEN 1 ELSE 0 END) AS sem_nome
-- FROM whatsapp_messages WHERE messageType = 'document';

-- Backfill:
-- UPDATE whatsapp_messages
-- SET mediaFilename = substr(COALESCE(
--       json_extract(payloadJson, '$.media.filename'),
--       json_extract(payloadJson, '$.filename'),
--       json_extract(payloadJson, '$._data.filename')
--     ), 1, 20000)
-- WHERE messageType = 'document'
--   AND mediaFilename IS NULL
--   AND COALESCE(
--       json_extract(payloadJson, '$.media.filename'),
--       json_extract(payloadJson, '$.filename'),
--       json_extract(payloadJson, '$._data.filename')
--     ) NOT IN ('');

-- ═══════════════════════════════════════════════════════════════════════════
-- ESCOPO ALTERNATIVO, se você preferir
-- ═══════════════════════════════════════════════════════════════════════════
--
-- O escrito acima cobre APENAS `message_type = 'document'`, que é o universo
-- medido. Imagem, áudio e vídeo também têm nome e também podem estar nulos.
--
-- Para cobrir toda a mídia, troque `message_type = 'document'` por
-- `message_type IN ('document','image','audio','video')` nos quatro passos. O
-- risco é maior e é conhecido: para essas espécies o provedor costuma mandar
-- rótulos do protocolo (`image`, `audio`, `video`) em vez de nome de arquivo, e
-- gravá-los deixaria a coluna não-nula e genérica — exatamente o estado que o
-- filtro de rótulos do dashboard existe para esconder. Rodar o PASSO 2 com o
-- escopo ampliado antes de decidir mostra se é esse o caso.
