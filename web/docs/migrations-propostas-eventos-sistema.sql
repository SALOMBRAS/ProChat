-- PROPOSTA — NÃO EXECUTADA em produção. Aguarda aprovação.
-- Contexto: docs/conversas-sem-resposta.md, seção 6 ("Limpeza retroativa").
-- Procedimento de execução passo a passo: docs/limpeza-eventos-sistema-procedimento.md
--
-- Limpeza retroativa dos eventos de sistema do WhatsApp que a ingestão gravava
-- como mensagem de entrada. A correção de código (messageFrom passa a ler o tipo
-- real em payload._data.type e descarta o evento técnico antes de persistir)
-- impede novos casos, mas não desfaz os já gravados.
--
-- Assinatura: o tipo real da mensagem — payload_json->>'type' quando existe,
-- senão payload_json->'_data'->>'type' — pertence ao vocabulário técnico. É
-- exatamente a mesma expressão que o código passa a aplicar
-- (conversation-identity.ts, technicalMessageTypes).
--
-- A coluna message_type NÃO serve para isto: ela já vem normalizada pela
-- ingestão e só contém text/document/image/audio/video. Conferido no espelho:
-- classificar por message_type acha zero mensagem técnica.
--
-- 'call_log' está FORA da lista de propósito. Uma chamada perdida é informação
-- operacional e decidir se ela pede resposta é decisão de produto. Medido: são
-- 197 mensagens em 30 conversas; incluí-las levaria as fantasmas de 160 para 167
-- e as mistas de 8 para 29.
--
-- ---------------------------------------------------------------------------
-- VALIDAÇÃO (2026-07-28)
-- ---------------------------------------------------------------------------
-- Este arquivo foi executado de ponta a ponta em PostgreSQL 16.14 num contêiner,
-- sobre o schema montado a partir de web/supabase/migrations (colunas conferidas
-- uma a uma contra a introspecção PostgREST do projeto remoto: idênticas) e
-- carregado com um espelho somente-leitura dos dados reais.
--
-- Números conferidos rodando ESTAS consultas sobre o espelho, não por agregação
-- em JS. Substituem a medição anterior (3 007 mensagens), que não é reproduzível
-- a partir da regra acima e cujos totais de conversa mista (17) e de SLA a
-- recalcular (6) não se obtêm com nenhuma variante testada da assinatura:
--
--   4 613 mensagens no total, 241 técnicas (5,2 %)
--     e2e_notification 141, notification_template 71, gp2 26, revoked 3
--   652 conversas: 160 ficam sem nenhuma mensagem (25 %), 8 são mistas
--     (têm técnica e real — apagar só a mensagem, preservar a conversa)
--     70 das 160 têm badge de não lida, somando 93 não lidas
--     29 outras já hoje não têm mensagem: NÃO são alvo (ver passo 5)
--   54 linhas de SLA: 41 em conversas que somem, 13 sobrevivem
--     das 13, 2 têm o relógio ancorado em mensagem técnica e precisam de ajuste
--   14 777 eventos brutos em waha_webhook_events — NÃO são tocados por nada
--     aqui: são o registro de auditoria e continuam explicando o que chegou.
--   1 workspace na base (default-workspace); mesmo assim tudo é filtrado.
--
-- A base é viva: reconfira antes de executar. As consultas 0 a 3 e o passo 8
-- existem para isso.
--
-- ---------------------------------------------------------------------------
-- O QUE MUDOU DEPOIS DA VALIDAÇÃO (a proposta anterior não rodava)
-- ---------------------------------------------------------------------------
-- 1. O DELETE de conversas ABORTAVA. Três FKs para conversations não são
--    CASCADE: conversation_kanban_state (NO ACTION), kanban_automation_deliveries
--    (NO ACTION) e inbox_outbox_jobs (RESTRICT). Como 625 das 652 conversas estão
--    no Kanban, as 160 alvo estão todas bloqueadas. Rodando a sequência original
--    o passo de mensagens commitava e o de conversas explodia, deixando a base
--    meio migrada. Agora o passo 6 remove o estado operacional antes.
-- 2. A conferência de conversas órfãs usava JOIN e por isso NÃO listava as 29
--    conversas que já hoje não têm mensagem — mas o DELETE apagava as 29 junto.
--    A conferência virou LEFT JOIN e classifica os dois casos; o DELETE agora
--    exige que a conversa tenha tido mensagem técnica.
-- 3. O UPDATE de SLA não tinha filtro: alcançava as 13 linhas vivas para
--    consertar 2, e o CASE só emite waiting_operator/waiting_customer, então
--    sobrescreveria status terminal. No espelho ele reabriu uma conversa
--    'resolved' como 'waiting_customer'. Agora só toca nas linhas ancoradas.
-- 4. Faltavam filtros de workspace_id nos DELETE.
-- 5. A conferência de SLA duplicava linha quando duas mensagens dividem o mesmo
--    instante de âncora (JOIN virou EXISTS) e casava conversa só por id,
--    ignorando workspace_id.
--
-- ORDEM OBRIGATÓRIA: 4) backup, 5) mensagens, 6) estado operacional das órfãs,
-- 7) conversas órfãs (a FK de conversation_sla_metrics é ON DELETE CASCADE e
-- leva as 41 linhas junto), 8) ajuste das linhas de SLA que sobrevivem.
-- Inverter a ordem deixa conversa sem mensagem ou métrica apontando para
-- mensagem inexistente.
--
-- Só o Supabase remoto tem dados reais. As bases SQLite locais são recriadas a
-- partir das migrations e não precisam de limpeza.

-- ---------------------------------------------------------------------------
-- Vocabulário técnico, num só lugar. Repetido literalmente nas consultas abaixo
-- porque o Supabase SQL Editor roda statement a statement e não guarda estado.
-- ---------------------------------------------------------------------------
--   ('ack','receipt','reaction','status','protocol','revoked',
--    'e2e_notification','notification_template','gp2','ciphertext')

-- ---------------------------------------------------------------------------
-- 0) Conferência geral: quantas mensagens a regra alcança, por tipo.
--    Esperado hoje: 241 no total.
-- ---------------------------------------------------------------------------
SELECT
  lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) AS tipo_real,
  direction,
  count(*) AS mensagens,
  count(DISTINCT chat_id) AS chats
FROM public.whatsapp_messages
WHERE workspace_id = 'default-workspace'
  AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
  ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
GROUP BY 1, 2
ORDER BY mensagens DESC;

-- ---------------------------------------------------------------------------
-- 1) Conferência: conversas que ficam SEM NENHUMA mensagem, e por quê.
--    LEFT JOIN de propósito: com JOIN as conversas que já hoje não têm mensagem
--    ficariam invisíveis aqui, embora um DELETE por "não tem mensagem" as
--    alcançasse. A coluna motivo separa os dois casos.
--    Esperado hoje: 160 'fantasma_desta_limpeza' e 29 'ja_vazia_antes'.
-- ---------------------------------------------------------------------------
SELECT
  c.id,
  c.conversation_type,
  c.visibility_state,
  c.unread_count,
  c.last_message_at,
  count(m.external_message_id) AS mensagens_hoje,
  CASE WHEN count(m.external_message_id) = 0 THEN 'ja_vazia_antes'
       ELSE 'fantasma_desta_limpeza' END AS motivo
FROM public.conversations c
LEFT JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
WHERE c.workspace_id = 'default-workspace'
GROUP BY c.id, c.conversation_type, c.visibility_state, c.unread_count, c.last_message_at
HAVING count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
) = 0
ORDER BY motivo, c.last_message_at DESC;

-- ---------------------------------------------------------------------------
-- 2) Conferência: conversas MISTAS. Têm mensagem real e também técnica.
--    A conversa fica; só as mensagens técnicas saem. Não apague estas conversas.
--    Esperado hoje: 8 conversas, 13 técnicas a remover, 2 531 reais preservadas.
--    O passo 7 não as alcança porque elas continuam com mensagem depois do
--    passo 5 — a coluna reais_preservadas é a prova disso, linha a linha.
-- ---------------------------------------------------------------------------
SELECT
  c.id,
  c.chat_id,
  count(*) FILTER (
    WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
      ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
  ) AS tecnicas_a_remover,
  count(*) FILTER (
    WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
      ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
  ) AS reais_preservadas
FROM public.conversations c
JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
WHERE c.workspace_id = 'default-workspace'
GROUP BY c.id, c.chat_id
HAVING count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
) > 0
AND count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
) > 0
ORDER BY tecnicas_a_remover DESC;

-- ---------------------------------------------------------------------------
-- 3) Conferência: linhas de SLA cujo relógio está ancorado num evento técnico.
--    As que estão em conversa órfã somem no passo 7 por cascata. As que estão em
--    conversa que sobrevive precisam de AJUSTE (passo 8) — apagar a mensagem não
--    conserta a métrica, só a deixa apontando para o que não existe mais.
--    EXISTS em vez de JOIN: com JOIN, duas mensagens no mesmo instante
--    duplicariam a linha e inflariam a contagem.
--    Esperado hoje: 43 linhas, 41 em conversa que some, 2 que sobrevivem.
--    acumuladores_zerados = true significa que a linha não tem histórico
--    acumulado a separar — é o que torna o passo 8 determinável. Ver o
--    procedimento para o caso false.
-- ---------------------------------------------------------------------------
SELECT
  s.conversation_id,
  s.sla_status,
  s.waiting_since_at,
  round(extract(epoch FROM (now() - s.waiting_since_at)) / 3600.0, 1) AS horas_acumuladas,
  (s.operator_waiting_ms = 0 AND s.customer_waiting_ms = 0
   AND s.total_response_ms = 0 AND s.response_count = 0) AS acumuladores_zerados,
  EXISTS (
    SELECT 1 FROM public.whatsapp_messages r
    WHERE r.workspace_id = c.workspace_id AND r.waha_session = c.waha_session AND r.chat_id = c.chat_id
      AND lower(coalesce(r.payload_json->>'type', r.payload_json->'_data'->>'type', '')) NOT IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
  ) AS conversa_sobrevive
FROM public.conversation_sla_metrics s
JOIN public.conversations c
  ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
WHERE s.workspace_id = 'default-workspace'
  AND EXISTS (
    SELECT 1 FROM public.whatsapp_messages m
    WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
      AND m.occurred_at = s.waiting_since_at
      AND lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
  )
ORDER BY conversa_sobrevive DESC, horas_acumuladas DESC;

-- ---------------------------------------------------------------------------
-- 4) BACKUP. Roda ANTES de qualquer DELETE, em transação própria, e fica na
--    base para o rollback. Guarda a linha inteira de tudo que será removido ou
--    alterado. Não custa nada manter: são poucas centenas de linhas.
-- ---------------------------------------------------------------------------
--
-- CREATE SCHEMA IF NOT EXISTS backup_eventos_sistema;
--
-- CREATE TABLE backup_eventos_sistema.whatsapp_messages AS
-- SELECT * FROM public.whatsapp_messages
-- WHERE workspace_id = 'default-workspace'
--   AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
--     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext');
--
-- -- Alvo das remoções de conversa: só as que TIVERAM mensagem técnica e ficam
-- -- sem nenhuma real. As 29 já vazias de antes ficam de fora de propósito.
-- CREATE TABLE backup_eventos_sistema.alvo AS
-- SELECT c.workspace_id, c.id AS conversation_id
-- FROM public.conversations c
-- JOIN public.whatsapp_messages m
--   ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
-- WHERE c.workspace_id = 'default-workspace'
-- GROUP BY c.workspace_id, c.id
-- HAVING count(*) FILTER (
--   WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
--     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
-- ) = 0;
--
-- CREATE TABLE backup_eventos_sistema.conversations AS
-- SELECT c.* FROM public.conversations c
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = c.workspace_id AND a.conversation_id = c.id;
--
-- CREATE TABLE backup_eventos_sistema.conversation_sla_metrics AS
-- SELECT s.* FROM public.conversation_sla_metrics s
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = s.workspace_id AND a.conversation_id = s.conversation_id;
--
-- CREATE TABLE backup_eventos_sistema.conversation_kanban_state AS
-- SELECT k.* FROM public.conversation_kanban_state k
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = k.workspace_id AND a.conversation_id = k.conversation_id;
--
-- CREATE TABLE backup_eventos_sistema.kanban_automation_deliveries AS
-- SELECT d.* FROM public.kanban_automation_deliveries d
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = d.workspace_id AND a.conversation_id = d.conversation_id;
--
-- CREATE TABLE backup_eventos_sistema.inbox_outbox_jobs AS
-- SELECT j.* FROM public.inbox_outbox_jobs j
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = j.workspace_id AND a.conversation_id = j.conversation_id;
--
-- -- Linhas de SLA que SOBREVIVEM e serão ajustadas no passo 8.
-- CREATE TABLE backup_eventos_sistema.sla_ajustadas AS
-- SELECT s.* FROM public.conversation_sla_metrics s
-- JOIN public.conversations c ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
-- WHERE s.workspace_id = 'default-workspace'
--   AND NOT EXISTS (SELECT 1 FROM backup_eventos_sistema.alvo a
--                   WHERE a.workspace_id = s.workspace_id AND a.conversation_id = s.conversation_id)
--   AND EXISTS (
--     SELECT 1 FROM public.whatsapp_messages m
--     WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
--       AND m.occurred_at = s.waiting_since_at
--       AND lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
--         ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext'));

-- ---------------------------------------------------------------------------
-- 5) REMOÇÃO DAS MENSAGENS TÉCNICAS. Primeiro passo destrutivo.
--    Não toca em waha_webhook_events: o evento bruto continua auditável — e é
--    ele que permite reconstruir a mensagem no rollback.
--    Esperado hoje: DELETE 241.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.whatsapp_messages
-- WHERE workspace_id = 'default-workspace'
--   AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
--     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext');

-- ---------------------------------------------------------------------------
-- 6) REMOÇÃO DO ESTADO OPERACIONAL DAS CONVERSAS ALVO. Sem isto o passo 7
--    ABORTA: estas três FKs não são CASCADE (NO ACTION / RESTRICT).
--    É estado derivado de uma conversa que deixa de existir — cartão no Kanban,
--    entrega de automação e job de envio. Está todo no backup.
--    Esperado hoje: 160 no Kanban, 0 nas outras duas.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.conversation_kanban_state k
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = k.workspace_id AND a.conversation_id = k.conversation_id;
--
-- DELETE FROM public.kanban_automation_deliveries d
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = d.workspace_id AND a.conversation_id = d.conversation_id;
--
-- DELETE FROM public.inbox_outbox_jobs j
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = j.workspace_id AND a.conversation_id = j.conversation_id;

-- ---------------------------------------------------------------------------
-- 7) REMOÇÃO DAS CONVERSAS FANTASMA. Usa a lista congelada no passo 4, não uma
--    condição recalculada — assim o que é apagado é exatamente o que foi
--    conferido e salvo, mesmo que uma mensagem nova chegue no meio do caminho.
--    A FK de conversation_sla_metrics é ON DELETE CASCADE e leva as 41 linhas
--    junto; conversation_metadata, conversation_events, routing_events e
--    routing_jobs também são CASCADE.
--
--    ATENÇÃO: contact_id NÃO é seguido. O contato pode ser compartilhado com
--    outra conversa ou ter sido criado à mão. Limpar contatos é decisão separada.
--    Esperado hoje: DELETE 160.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.conversations c
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = c.workspace_id AND a.conversation_id = c.id;

-- ---------------------------------------------------------------------------
-- 8) AJUSTE DAS LINHAS DE SLA QUE SOBREVIVEM (2 em 2026-07-28).
--    Só as linhas ancoradas em evento técnico, congeladas no passo 4 — e só as
--    que não têm acumulador. O UPDATE reancora tudo que a mensagem técnica havia
--    definido nos instantes das mensagens REAIS que restaram.
--
--    Por que os acumuladores não precisam ser recompostos nestas linhas: elas
--    têm operator_waiting_ms = customer_waiting_ms = total_response_ms =
--    response_count = 0. A linha não foi contaminada, ela foi CRIADA pelo evento
--    técnico e nunca viu uma transição. Não há intervalo medido a partir de
--    evento técnico embutido em acumulador nenhum — não há o que separar.
--    O guard `AND b.operator_waiting_ms = 0 AND ...` garante isso: se na hora de
--    executar alguma linha tiver acumulador, ela fica de fora e vai para o
--    tratamento descrito no procedimento.
--
--    first_response_at continua NULL quando não houver outbound real: nunca
--    houve resposta, e inventar uma seria pior que não ter.
--    sla_status vira waiting_operator/waiting_customer conforme quem falou por
--    último. Status terminal não é alcançado porque a lista do passo 4 só tem
--    linhas ancoradas em técnica, e nenhuma delas está resolvida ou arquivada —
--    o passo 3 mostra o status de cada uma antes de executar.
-- ---------------------------------------------------------------------------
--
-- WITH reais AS (
--   SELECT c.workspace_id, c.id AS conversation_id,
--          min(m.occurred_at) FILTER (WHERE m.direction = 'inbound')  AS primeiro_inbound,
--          max(m.occurred_at) FILTER (WHERE m.direction = 'inbound')  AS ultimo_inbound,
--          max(m.occurred_at) FILTER (WHERE m.direction = 'outbound') AS ultimo_outbound,
--          max(m.occurred_at)                                         AS ultima_atividade
--   FROM public.conversations c
--   JOIN public.whatsapp_messages m
--     ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
--   GROUP BY c.workspace_id, c.id
-- )
-- UPDATE public.conversation_sla_metrics s
-- SET first_inbound_at  = coalesce(r.primeiro_inbound, s.first_inbound_at),
--     last_inbound_at   = coalesce(r.ultimo_inbound, s.last_inbound_at),
--     last_outbound_at  = coalesce(r.ultimo_outbound, s.last_outbound_at),
--     last_activity_at  = coalesce(r.ultima_atividade, s.last_activity_at),
--     waiting_since_at  = coalesce(r.ultimo_outbound, r.ultimo_inbound, s.waiting_since_at),
--     sla_status        = CASE WHEN r.ultimo_outbound IS NOT NULL
--                               AND r.ultimo_outbound >= coalesce(r.ultimo_inbound, r.ultimo_outbound)
--                              THEN 'waiting_customer' ELSE 'waiting_operator' END,
--     updated_at        = now()
-- FROM reais r
-- JOIN backup_eventos_sistema.sla_ajustadas b
--   ON b.workspace_id = r.workspace_id AND b.conversation_id = r.conversation_id
-- WHERE s.workspace_id = r.workspace_id
--   AND s.conversation_id = r.conversation_id
--   AND s.frozen_at IS NULL
--   AND b.operator_waiting_ms = 0 AND b.customer_waiting_ms = 0
--   AND b.total_response_ms = 0 AND b.response_count = 0;

-- ---------------------------------------------------------------------------
-- 9) Conferência final, depois de executar.
--    Esperado: 0 técnicas, 29 conversas sem mensagem (as que já estavam assim),
--    492 conversas, 13 linhas de SLA, 14 777 eventos brutos intactos, e nenhuma
--    linha de SLA ancorada em mensagem que não existe mais.
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.whatsapp_messages
   WHERE workspace_id = 'default-workspace'
     AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')) AS mensagens_tecnicas_restantes,
  (SELECT count(*) FROM public.conversations c
   WHERE c.workspace_id = 'default-workspace'
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
