-- PROPOSTA — NÃO EXECUTADA. Aguarda aprovação.
-- Contexto: docs/conversas-sem-resposta.md, seção 6 ("Limpeza retroativa").
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
-- 'call_log' está FORA da lista de propósito. Uma chamada perdida é informação
-- operacional e decidir se ela pede resposta é decisão de produto. Se a decisão
-- for incluí-la, some 197 mensagens ao escopo e refaça a conferência.
--
-- Medido em 2026-07-28 no workspace default-workspace (Supabase remoto,
-- somente leitura). A base é viva; reconfira os números antes de executar.
--
--   3 007 mensagens no total, 237 técnicas (8 %)
--     e2e_notification 141, notification_template 71, gp2 24, revoked 1
--   650 conversas: 156 ficariam sem nenhuma mensagem, 17 são mistas
--     (têm técnica e real — apagar só a mensagem, preservar a conversa)
--   52 linhas de SLA: 37 em conversas que somem, 6 em conversas que sobrevivem
--   12 917 eventos brutos em waha_webhook_events — NÃO são tocados por nada
--     aqui: são o registro de auditoria e continuam explicando o que chegou.
--
-- ORDEM OBRIGATÓRIA: 1) mensagens, 2) conversas órfãs (a FK de
-- conversation_sla_metrics é ON DELETE CASCADE e leva as 37 linhas junto),
-- 3) recálculo das 6 linhas de SLA que sobrevivem. Inverter a ordem deixa
-- conversa sem mensagem ou métrica apontando para mensagem inexistente.
--
-- Só o Supabase remoto tem dados reais. As bases SQLite locais são recriadas a
-- partir das migrations e não precisam de limpeza.

-- ---------------------------------------------------------------------------
-- 0) Conferência geral: quantas mensagens a regra alcança, por tipo.
-- ---------------------------------------------------------------------------
SELECT
  lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) AS tipo_real,
  direction,
  count(*) AS mensagens,
  count(DISTINCT chat_id) AS chats
FROM public.whatsapp_messages
WHERE lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
  ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
GROUP BY 1, 2
ORDER BY mensagens DESC;

-- ---------------------------------------------------------------------------
-- 1) Conferência: conversas que ficariam SEM NENHUMA mensagem.
--    Estas são as conversas fantasma da Inbox — criadas por notificação de
--    sistema, muitas com badge de não lida.
-- ---------------------------------------------------------------------------
SELECT
  c.id,
  c.conversation_type,
  c.visibility_state,
  c.unread_count,
  c.last_message_at,
  count(m.external_message_id) AS mensagens_hoje
FROM public.conversations c
JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
GROUP BY c.id, c.conversation_type, c.visibility_state, c.unread_count, c.last_message_at
HAVING count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
) = 0
ORDER BY c.last_message_at DESC;

-- ---------------------------------------------------------------------------
-- 2) Conferência: conversas MISTAS. Têm mensagem real e também técnica.
--    A conversa fica; só as mensagens técnicas saem. Não apague estas conversas.
-- ---------------------------------------------------------------------------
SELECT
  c.id,
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
GROUP BY c.id
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
--    As que estão em conversa órfã somem no passo 5 por cascata. As que estão em
--    conversa que sobrevive precisam de RECÁLCULO (passo 6) — apagar a mensagem
--    não conserta a métrica, só a deixa apontando para o que não existe mais.
-- ---------------------------------------------------------------------------
SELECT
  s.conversation_id,
  s.sla_status,
  s.waiting_since_at,
  lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) AS tipo_da_ancora,
  round(extract(epoch FROM (now() - s.waiting_since_at)) / 3600.0, 1) AS horas_acumuladas,
  EXISTS (
    SELECT 1 FROM public.whatsapp_messages r
    JOIN public.conversations c2 ON c2.id = s.conversation_id
    WHERE r.workspace_id = c2.workspace_id AND r.waha_session = c2.waha_session AND r.chat_id = c2.chat_id
      AND lower(coalesce(r.payload_json->>'type', r.payload_json->'_data'->>'type', '')) NOT IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
  ) AS conversa_sobrevive
FROM public.conversation_sla_metrics s
JOIN public.conversations c ON c.id = s.conversation_id
JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
  AND m.occurred_at = s.waiting_since_at
WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
  ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')
ORDER BY horas_acumuladas DESC;

-- ---------------------------------------------------------------------------
-- 4) REMOÇÃO DAS MENSAGENS TÉCNICAS. Roda primeiro.
--    Não toca em waha_webhook_events: o evento bruto continua auditável.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.whatsapp_messages
-- WHERE lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
--   ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext');

-- ---------------------------------------------------------------------------
-- 5) REMOÇÃO DAS CONVERSAS ÓRFÃS. Roda depois do passo 4, quando a conversa
--    fantasma já não tem nenhuma mensagem. A FK de conversation_sla_metrics é
--    ON DELETE CASCADE e leva as linhas de SLA junto.
--
--    ATENÇÃO 1: a condição é "não tem mais nenhuma mensagem", não "é órfã de
--    origem". Existem 29 conversas que já hoje não têm mensagem por outros
--    motivos e que esta condição também alcançaria. Se elas devem ficar,
--    restrinja pela lista de ids conferida no passo 1.
--
--    ATENÇÃO 2: 69 dessas conversas têm contact_id preenchido. O contato NÃO é
--    removido aqui de propósito — ele pode ser compartilhado com outra conversa
--    ou ter sido criado à mão. Limpar contatos é decisão separada.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.conversations c
-- WHERE NOT EXISTS (
--   SELECT 1 FROM public.whatsapp_messages m
--   WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
-- );

-- ---------------------------------------------------------------------------
-- 6) RECÁLCULO DAS LINHAS DE SLA QUE SOBREVIVEM (6 em 2026-07-28).
--    São conversas com mensagem real cujo relógio foi ancorado num evento
--    técnico. Reancora em last_inbound/last_outbound reais.
--
--    Isto NÃO recompõe operator_waiting_ms nem customer_waiting_ms: os
--    acumuladores absorveram intervalos medidos a partir de eventos técnicos e
--    não há como separá-los sem reprocessar a conversa inteira. Se a exatidão
--    dos acumuladores importar, o caminho honesto é apagar a linha e deixar a
--    próxima mensagem real recriá-la — SlaService.message recria a linha em
--    qualquer inbound não histórico.
-- ---------------------------------------------------------------------------
--
-- WITH real AS (
--   SELECT c.id AS conversation_id, c.workspace_id,
--          max(m.occurred_at) FILTER (WHERE m.direction = 'inbound')  AS ultimo_inbound,
--          max(m.occurred_at) FILTER (WHERE m.direction = 'outbound') AS ultimo_outbound
--   FROM public.conversations c
--   JOIN public.whatsapp_messages m
--     ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
--   GROUP BY c.id, c.workspace_id
-- )
-- UPDATE public.conversation_sla_metrics s
-- SET last_inbound_at  = coalesce(real.ultimo_inbound, s.last_inbound_at),
--     last_outbound_at = real.ultimo_outbound,
--     waiting_since_at = coalesce(real.ultimo_outbound, real.ultimo_inbound, s.waiting_since_at),
--     sla_status       = CASE WHEN real.ultimo_outbound IS NOT NULL
--                               AND real.ultimo_outbound >= coalesce(real.ultimo_inbound, real.ultimo_outbound)
--                             THEN 'waiting_customer' ELSE 'waiting_operator' END,
--     updated_at       = now()
-- FROM real
-- WHERE real.conversation_id = s.conversation_id
--   AND real.workspace_id = s.workspace_id
--   AND s.frozen_at IS NULL;

-- ---------------------------------------------------------------------------
-- 7) Conferência final, depois de executar.
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.whatsapp_messages
   WHERE lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext')) AS mensagens_tecnicas_restantes,
  (SELECT count(*) FROM public.conversations c
   WHERE NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m
     WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id)) AS conversas_sem_mensagem,
  (SELECT count(*) FROM public.conversation_sla_metrics) AS linhas_de_sla,
  (SELECT count(*) FROM public.waha_webhook_events) AS eventos_brutos_preservados;
