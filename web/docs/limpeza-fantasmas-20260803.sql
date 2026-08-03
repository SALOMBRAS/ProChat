-- ###########################################################################
-- #  LIMPEZA DAS CONVERSAS FANTASMA — versão executável de 2026-08-03        #
-- #                                                                          #
-- #  RODE UM PASSO POR VEZ. NÃO COLE O ARQUIVO INTEIRO.                       #
-- #  Entre um passo e o outro há uma conferência com número esperado; se o    #
-- #  número não bater na FORMA descrita, PARE e leia o procedimento em        #
-- #  limpeza-eventos-sistema-procedimento.md.                                 #
-- ###########################################################################
--
-- Difere de migrations-propostas-eventos-sistema.sql em três pontos, todos
-- medidos em 2026-08-03 (ver o procedimento):
--
--   1. VOCABULÁRIO com 14 tipos, não 11. A PR #127 acrescentou 'album',
--      'pinned_message' e 'group-history' a technicalMessageTypes.
--   2. GUARD DA #73 por CAMPO de identificação do chat, não por
--      `payload_json::text LIKE '%chat_id%'`. O LIKE casa menção
--      (`_data.mentionedJidList`) e citação (`_data.quotedParticipant`), e com
--      isso protegeria 25 conversas quando só 2 têm evento bruto próprio.
--   3. HAVING com count(coluna), não count(*), na conferência — senão as
--      conversas já vazias somem do relatório.
--
-- Espelho da medição: 2026-08-03T18:05Z — 22.074 mensagens, 1.056 conversas,
-- 39.175 eventos brutos, 72 linhas de SLA, 630 cartões de Kanban.
-- A base ESCREVE continuamente: reconfira o passo A imediatamente antes de
-- executar o passo B, e compare FORMA, não valor.

-- ===========================================================================
-- A) CONFERÊNCIA — somente leitura. Rode as quatro consultas.
-- ===========================================================================

-- A1) Mensagens técnicas por tipo.  Esperado: 308 no total.
SELECT
  lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) AS tipo_real,
  direction, count(*) AS mensagens, count(DISTINCT chat_id) AS chats
FROM public.whatsapp_messages
WHERE workspace_id = 'default-workspace'
  AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
  ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
   'notification_template','gp2','ciphertext','biz_content_placeholder',
   'album','pinned_message','group-history')
GROUP BY 1, 2 ORDER BY 3 DESC;

-- A2) Classificação de todas as conversas.
--     Esperado: 163 'fantasma_alvo', 2 'protegida_73', 29 'ja_vazia_antes'.
--     count(m.external_message_id), não count(*): o LEFT JOIN produz uma linha
--     NULL na conversa vazia, e count(*) a contaria como mensagem real.
SELECT
  c.id, c.waha_session, c.chat_id, c.conversation_type, c.unread_count,
  count(m.external_message_id) AS mensagens_hoje,
  CASE
    WHEN count(m.external_message_id) = 0 THEN 'ja_vazia_antes'
    WHEN count(m.external_message_id) FILTER (
      WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) NOT IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
         'notification_template','gp2','ciphertext','biz_content_placeholder',
         'album','pinned_message','group-history')) > 0 THEN 'mista_ou_real'
    WHEN EXISTS (
      SELECT 1 FROM public.waha_webhook_events e
      WHERE e.workspace_id = c.workspace_id
        AND c.chat_id IN (
          e.payload_json->>'from', e.payload_json->>'to',
          e.payload_json->'_data'->>'from', e.payload_json->'_data'->>'to',
          e.payload_json->'_data'->'id'->>'remote',
          e.payload_json->>'participant', e.payload_json->'_data'->>'author')
        AND lower(coalesce(e.payload_json->>'type', e.payload_json->'_data'->>'type','')) NOT IN
          ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
           'notification_template','gp2','ciphertext','biz_content_placeholder',
           'album','pinned_message','group-history')
    ) THEN 'protegida_73'
    ELSE 'fantasma_alvo'
  END AS classe
FROM public.conversations c
LEFT JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
WHERE c.workspace_id = 'default-workspace'
GROUP BY c.workspace_id, c.id, c.waha_session, c.chat_id, c.conversation_type, c.unread_count
ORDER BY 7, 4;

-- A3) Conversas MISTAS — a conversa fica, só as técnicas saem.
--     Esperado: 31 conversas. PARE se alguma vier com reais_preservadas = 0.
SELECT c.id, c.chat_id,
  count(*) FILTER (
    WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) IN
      ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
       'notification_template','gp2','ciphertext','biz_content_placeholder',
       'album','pinned_message','group-history')) AS tecnicas_a_remover,
  count(*) FILTER (
    WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) NOT IN
      ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
       'notification_template','gp2','ciphertext','biz_content_placeholder',
       'album','pinned_message','group-history')) AS reais_preservadas
FROM public.conversations c
JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
WHERE c.workspace_id = 'default-workspace'
GROUP BY c.id, c.chat_id
HAVING count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
     'notification_template','gp2','ciphertext','biz_content_placeholder',
     'album','pinned_message','group-history')) > 0
AND count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
     'notification_template','gp2','ciphertext','biz_content_placeholder',
     'album','pinned_message','group-history')) > 0
ORDER BY tecnicas_a_remover DESC;

-- A4) Linhas de SLA ancoradas em evento técnico.
--     Esperado: 41 linhas — 37 com conversa_sobrevive = false (somem por
--     cascata) e 4 com true (o passo F ajusta).
--     PARE se alguma linha vier com acumuladores_zerados = false.
SELECT s.conversation_id, s.sla_status, s.waiting_since_at,
  (s.operator_waiting_ms = 0 AND s.customer_waiting_ms = 0
   AND s.total_response_ms = 0 AND s.response_count = 0) AS acumuladores_zerados,
  EXISTS (
    SELECT 1 FROM public.whatsapp_messages r
    WHERE r.workspace_id = c.workspace_id AND r.waha_session = c.waha_session AND r.chat_id = c.chat_id
      AND lower(coalesce(r.payload_json->>'type', r.payload_json->'_data'->>'type','')) NOT IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
         'notification_template','gp2','ciphertext','biz_content_placeholder',
         'album','pinned_message','group-history')) AS conversa_sobrevive
FROM public.conversation_sla_metrics s
JOIN public.conversations c ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
WHERE s.workspace_id = 'default-workspace'
  AND EXISTS (
    SELECT 1 FROM public.whatsapp_messages m
    WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
      AND m.occurred_at = s.waiting_since_at
      AND lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
         'notification_template','gp2','ciphertext','biz_content_placeholder',
         'album','pinned_message','group-history'))
ORDER BY conversa_sobrevive DESC;

-- ===========================================================================
-- B) BACKUP — primeiro passo que escreve. Só cria schema novo; não altera nada
--    do que já existe. Rode inteiro, de uma vez.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS backup_eventos_sistema;

-- Chats com evento bruto REAL, por campo de identificação do chat.
-- É o guard da #73: uma conversa sem mensagem real pode ser chat vivo cujo
-- histórico nunca materializou, e essa NÃO pode ser apagada.
CREATE TABLE backup_eventos_sistema.chats_com_evento_real AS
SELECT DISTINCT e.workspace_id, j.jid
FROM public.waha_webhook_events e
CROSS JOIN LATERAL (VALUES
  (e.payload_json->>'from'), (e.payload_json->>'to'),
  (e.payload_json->'_data'->>'from'), (e.payload_json->'_data'->>'to'),
  (e.payload_json->'_data'->'id'->>'remote'),
  (e.payload_json->>'participant'), (e.payload_json->'_data'->>'author')
) AS j(jid)
WHERE j.jid IS NOT NULL
  AND lower(coalesce(e.payload_json->>'type', e.payload_json->'_data'->>'type','')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
     'notification_template','gp2','ciphertext','biz_content_placeholder',
     'album','pinned_message','group-history');

CREATE INDEX ON backup_eventos_sistema.chats_com_evento_real (workspace_id, jid);

CREATE TABLE backup_eventos_sistema.whatsapp_messages AS
SELECT * FROM public.whatsapp_messages
WHERE workspace_id = 'default-workspace'
  AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type','')) IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
     'notification_template','gp2','ciphertext','biz_content_placeholder',
     'album','pinned_message','group-history');

-- A lista congelada. Os passos D e E apagam ESTA lista, não uma condição
-- recalculada — assim o que sai é exatamente o que foi conferido.
CREATE TABLE backup_eventos_sistema.alvo AS
SELECT c.workspace_id, c.id AS conversation_id
FROM public.conversations c
JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
WHERE c.workspace_id = 'default-workspace'
  AND NOT EXISTS (
    SELECT 1 FROM backup_eventos_sistema.chats_com_evento_real r
    WHERE r.workspace_id = c.workspace_id AND r.jid = c.chat_id)
GROUP BY c.workspace_id, c.id
HAVING count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
     'notification_template','gp2','ciphertext','biz_content_placeholder',
     'album','pinned_message','group-history')) = 0;

CREATE TABLE backup_eventos_sistema.conversations AS
SELECT c.* FROM public.conversations c
JOIN backup_eventos_sistema.alvo a ON a.workspace_id = c.workspace_id AND a.conversation_id = c.id;

CREATE TABLE backup_eventos_sistema.conversation_sla_metrics AS
SELECT s.* FROM public.conversation_sla_metrics s
JOIN backup_eventos_sistema.alvo a ON a.workspace_id = s.workspace_id AND a.conversation_id = s.conversation_id;

CREATE TABLE backup_eventos_sistema.conversation_kanban_state AS
SELECT k.* FROM public.conversation_kanban_state k
JOIN backup_eventos_sistema.alvo a ON a.workspace_id = k.workspace_id AND a.conversation_id = k.conversation_id;

CREATE TABLE backup_eventos_sistema.kanban_automation_deliveries AS
SELECT d.* FROM public.kanban_automation_deliveries d
JOIN backup_eventos_sistema.alvo a ON a.workspace_id = d.workspace_id AND a.conversation_id = d.conversation_id;

CREATE TABLE backup_eventos_sistema.inbox_outbox_jobs AS
SELECT j.* FROM public.inbox_outbox_jobs j
JOIN backup_eventos_sistema.alvo a ON a.workspace_id = j.workspace_id AND a.conversation_id = j.conversation_id;

-- Linhas de SLA que SOBREVIVEM e serão ajustadas no passo F.
CREATE TABLE backup_eventos_sistema.sla_ajustadas AS
SELECT s.* FROM public.conversation_sla_metrics s
JOIN public.conversations c ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
WHERE s.workspace_id = 'default-workspace'
  AND NOT EXISTS (SELECT 1 FROM backup_eventos_sistema.alvo a
                  WHERE a.workspace_id = s.workspace_id AND a.conversation_id = s.conversation_id)
  AND EXISTS (
    SELECT 1 FROM public.whatsapp_messages m
    WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
      AND m.occurred_at = s.waiting_since_at
      AND lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type','')) IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
         'notification_template','gp2','ciphertext','biz_content_placeholder',
         'album','pinned_message','group-history'));

-- CONFERÊNCIA DO BACKUP. Esperado: 163 / 308 / 163 / 37 / 161 / 0 / 0 / 4.
-- `alvo` e `conversas` TÊM que ser iguais, e iguais ao 'fantasma_alvo' do A2.
SELECT 'alvo' t, count(*) FROM backup_eventos_sistema.alvo
UNION ALL SELECT 'mensagens', count(*) FROM backup_eventos_sistema.whatsapp_messages
UNION ALL SELECT 'conversas', count(*) FROM backup_eventos_sistema.conversations
UNION ALL SELECT 'sla_cascata', count(*) FROM backup_eventos_sistema.conversation_sla_metrics
UNION ALL SELECT 'kanban', count(*) FROM backup_eventos_sistema.conversation_kanban_state
UNION ALL SELECT 'deliveries', count(*) FROM backup_eventos_sistema.kanban_automation_deliveries
UNION ALL SELECT 'outbox', count(*) FROM backup_eventos_sistema.inbox_outbox_jobs
UNION ALL SELECT 'sla_ajustadas', count(*) FROM backup_eventos_sistema.sla_ajustadas;

-- ===========================================================================
-- C) MENSAGENS TÉCNICAS — primeiro passo destrutivo.  Esperado: DELETE 308.
--    waha_webhook_events NÃO é tocada: o evento bruto continua auditável.
-- ===========================================================================

DELETE FROM public.whatsapp_messages
WHERE workspace_id = 'default-workspace'
  AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type','')) IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
     'notification_template','gp2','ciphertext','biz_content_placeholder',
     'album','pinned_message','group-history');

-- Conferência: esperado 0 e 39.175 (ou o que o A tiver medido, inalterado).
SELECT
  (SELECT count(*) FROM public.whatsapp_messages
   WHERE workspace_id = 'default-workspace'
     AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type','')) IN
     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
      'notification_template','gp2','ciphertext','biz_content_placeholder',
      'album','pinned_message','group-history')) AS tecnicas_restantes,
  (SELECT count(*) FROM public.waha_webhook_events) AS eventos_brutos_intactos;

-- ===========================================================================
-- D) ESTADO OPERACIONAL DAS CONVERSAS ALVO.  Esperado: 161 / 0 / 0.
--    SEM ESTE PASSO O E ABORTA: estas três FKs não são CASCADE.
-- ===========================================================================

DELETE FROM public.conversation_kanban_state k
USING backup_eventos_sistema.alvo a
WHERE a.workspace_id = k.workspace_id AND a.conversation_id = k.conversation_id;

DELETE FROM public.kanban_automation_deliveries d
USING backup_eventos_sistema.alvo a
WHERE a.workspace_id = d.workspace_id AND a.conversation_id = d.conversation_id;

DELETE FROM public.inbox_outbox_jobs j
USING backup_eventos_sistema.alvo a
WHERE a.workspace_id = j.workspace_id AND a.conversation_id = j.conversation_id;

-- ===========================================================================
-- E) CONVERSAS FANTASMA.  Esperado: DELETE 163.
--    A FK de conversation_sla_metrics é CASCADE e leva 37 linhas junto.
--    contact_id NÃO é seguido: limpar contatos é decisão separada.
-- ===========================================================================

DELETE FROM public.conversations c
USING backup_eventos_sistema.alvo a
WHERE a.workspace_id = c.workspace_id AND a.conversation_id = c.id;

-- Conferência: esperado 893 conversas e 35 linhas de SLA.
SELECT
  (SELECT count(*) FROM public.conversations WHERE workspace_id = 'default-workspace') AS conversas,
  (SELECT count(*) FROM public.conversation_sla_metrics WHERE workspace_id = 'default-workspace') AS linhas_de_sla;

-- Se o DELETE falhar por FK, NÃO force — apareceu dependência nova:
-- SELECT c.conrelid::regclass AS tabela, c.confdeltype
-- FROM pg_constraint c
-- WHERE c.contype = 'f' AND c.confrelid = 'public.conversations'::regclass
--   AND c.confdeltype <> 'c';

-- ===========================================================================
-- F) AJUSTE DAS LINHAS DE SLA QUE SOBREVIVEM.  Esperado: UPDATE 4.
--    O JOIN com sla_ajustadas e o guard de acumulador são o que impede este
--    UPDATE de alcançar as outras 31 linhas vivas: sem eles são 35 linhas
--    tocadas e as 25 violações 'expired' restantes viram zero.
-- ===========================================================================

WITH reais AS (
  SELECT c.workspace_id, c.id AS conversation_id,
         min(m.occurred_at) FILTER (WHERE m.direction = 'inbound')  AS primeiro_inbound,
         max(m.occurred_at) FILTER (WHERE m.direction = 'inbound')  AS ultimo_inbound,
         max(m.occurred_at) FILTER (WHERE m.direction = 'outbound') AS ultimo_outbound,
         max(m.occurred_at)                                         AS ultima_atividade
  FROM public.conversations c
  JOIN public.whatsapp_messages m
    ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
  GROUP BY c.workspace_id, c.id
)
UPDATE public.conversation_sla_metrics s
SET first_inbound_at = coalesce(r.primeiro_inbound, s.first_inbound_at),
    last_inbound_at  = coalesce(r.ultimo_inbound, s.last_inbound_at),
    last_outbound_at = coalesce(r.ultimo_outbound, s.last_outbound_at),
    last_activity_at = coalesce(r.ultima_atividade, s.last_activity_at),
    waiting_since_at = coalesce(r.ultimo_outbound, r.ultimo_inbound, s.waiting_since_at),
    sla_status       = CASE WHEN r.ultimo_outbound IS NOT NULL
                             AND r.ultimo_outbound >= coalesce(r.ultimo_inbound, r.ultimo_outbound)
                            THEN 'waiting_customer' ELSE 'waiting_operator' END,
    updated_at       = now()
FROM reais r
JOIN backup_eventos_sistema.sla_ajustadas b
  ON b.workspace_id = r.workspace_id AND b.conversation_id = r.conversation_id
WHERE s.workspace_id = r.workspace_id
  AND s.conversation_id = r.conversation_id
  AND s.frozen_at IS NULL
  AND b.operator_waiting_ms = 0 AND b.customer_waiting_ms = 0
  AND b.total_response_ms = 0 AND b.response_count = 0;

-- ===========================================================================
-- G) CONFERÊNCIA FINAL
--    Esperado: 0 / 31 / 893 / 35 / 0 / 39.175
--    As 31 sem mensagem são as 29 que já estavam assim MAIS as 2 protegidas
--    pela #73, cujas únicas mensagens eram técnicas e saíram no passo C.
--    Elas continuam existindo de propósito: têm histórico por materializar.
-- ===========================================================================

SELECT
  (SELECT count(*) FROM public.whatsapp_messages WHERE workspace_id = 'default-workspace'
     AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type','')) IN
     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification',
      'notification_template','gp2','ciphertext','biz_content_placeholder',
      'album','pinned_message','group-history')) AS tecnicas_restantes,
  (SELECT count(*) FROM public.conversations c WHERE c.workspace_id = 'default-workspace'
     AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m
       WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id)) AS conversas_sem_mensagem,
  (SELECT count(*) FROM public.conversations WHERE workspace_id = 'default-workspace') AS conversas_totais,
  (SELECT count(*) FROM public.conversation_sla_metrics WHERE workspace_id = 'default-workspace') AS linhas_de_sla,
  (SELECT count(*) FROM public.conversation_sla_metrics s
     JOIN public.conversations c ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
   WHERE s.workspace_id = 'default-workspace' AND s.waiting_since_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m
       WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
         AND m.occurred_at = s.waiting_since_at)) AS sla_com_ancora_inexistente,
  (SELECT count(*) FROM public.waha_webhook_events) AS eventos_brutos_preservados;

-- Esperado: expired 21, waiting_customer 10, waiting_operator 4.
SELECT sla_status, count(*) FROM public.conversation_sla_metrics
WHERE workspace_id = 'default-workspace' GROUP BY 1 ORDER BY 2 DESC;

-- ===========================================================================
-- ROLLBACK — ordem importa: conversas antes das tabelas que apontam para elas.
-- ANTES DE RESTAURAR, confira se a conversa já voltou a existir (a ingestão
-- recria conversa de grupo): restaurar por cima colide com a UNIQUE
-- (workspace_id, waha_session, chat_id).
-- ===========================================================================
--
-- -- Quais do backup já voltaram sozinhas? Se vier > 0, NÃO rode o INSERT de
-- -- conversations: restaure só as tabelas dependentes.
-- SELECT count(*) FROM backup_eventos_sistema.conversations b
-- WHERE EXISTS (SELECT 1 FROM public.conversations c
--               WHERE c.workspace_id = b.workspace_id AND c.waha_session = b.waha_session
--                 AND c.chat_id = b.chat_id);
--
-- BEGIN;
-- INSERT INTO public.conversations                SELECT * FROM backup_eventos_sistema.conversations;
-- INSERT INTO public.conversation_sla_metrics     SELECT * FROM backup_eventos_sistema.conversation_sla_metrics;
-- INSERT INTO public.conversation_kanban_state    SELECT * FROM backup_eventos_sistema.conversation_kanban_state;
-- INSERT INTO public.kanban_automation_deliveries SELECT * FROM backup_eventos_sistema.kanban_automation_deliveries;
-- INSERT INTO public.inbox_outbox_jobs            SELECT * FROM backup_eventos_sistema.inbox_outbox_jobs;
-- INSERT INTO public.whatsapp_messages            SELECT * FROM backup_eventos_sistema.whatsapp_messages;
-- -- Desfaz o passo F, coluna a coluna.
-- UPDATE public.conversation_sla_metrics s
-- SET sla_status = b.sla_status, first_inbound_at = b.first_inbound_at,
--     first_response_at = b.first_response_at, last_inbound_at = b.last_inbound_at,
--     last_outbound_at = b.last_outbound_at, last_activity_at = b.last_activity_at,
--     waiting_since_at = b.waiting_since_at, operator_waiting_ms = b.operator_waiting_ms,
--     customer_waiting_ms = b.customer_waiting_ms, total_response_ms = b.total_response_ms,
--     response_count = b.response_count, resolved_at = b.resolved_at,
--     archived_at = b.archived_at, frozen_at = b.frozen_at, updated_at = b.updated_at
-- FROM backup_eventos_sistema.sla_ajustadas b
-- WHERE b.workspace_id = s.workspace_id AND b.conversation_id = s.conversation_id;
-- COMMIT;
--
-- Rollback parcial: rode só as linhas dos passos já executados, na mesma ordem.
-- Reverter o E exige reverter também o D, e nessa ordem.
--
-- Depois de tudo conferido na Inbox:
-- DROP SCHEMA backup_eventos_sistema CASCADE;
