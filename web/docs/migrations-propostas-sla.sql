-- PROPOSTA — NÃO EXECUTADA. Aguarda aprovação.
-- Contexto: docs/sla-historico-investigacao.md, seção 5.
--
-- Corrige as linhas de SLA que o SlaService.tick promoveu indevidamente a
-- 'expired' enquanto estavam em 'waiting_customer'. Nessas linhas o silêncio do
-- cliente passou a ser reportado como espera do atendente.
--
-- A correção de código (tick só promove 'waiting_operator') impede novos casos,
-- mas não desfaz os existentes: o tick nunca reverte status.
--
-- Assinatura do defeito: a linha está 'expired' e o seu waiting_since_at é o
-- horário do último outbound. Uma expiração legítima tem waiting_since_at igual
-- ao último inbound, porque quem estava esperando era o atendente.
--
-- Em 2026-07-27 isto seleciona 3 linhas de 49 'expired' no workspace
-- default-workspace. Confira o SELECT antes de rodar o UPDATE.

-- 1) Conferência: quais linhas seriam afetadas, e há quanto tempo.
SELECT
  workspace_id,
  conversation_id,
  sla_status,
  last_inbound_at,
  last_outbound_at,
  waiting_since_at,
  round(extract(epoch FROM (now() - waiting_since_at)) / 3600.0, 1) AS horas_de_silencio_do_cliente
FROM public.conversation_sla_metrics
WHERE sla_status = 'expired'
  AND frozen_at IS NULL
  AND last_outbound_at IS NOT NULL
  AND waiting_since_at = last_outbound_at
ORDER BY waiting_since_at;

-- 2) Correção. Devolve o status; não toca em nenhum acumulador
--    (operator_waiting_ms, customer_waiting_ms, total_response_ms,
--    response_count), porque o tick não os alterou ao promover a linha.
--    updated_at é atualizado para que a Inbox receba o novo estado.
--
-- UPDATE public.conversation_sla_metrics
-- SET sla_status = 'waiting_customer',
--     updated_at = now()
-- WHERE sla_status = 'expired'
--   AND frozen_at IS NULL
--   AND last_outbound_at IS NOT NULL
--   AND waiting_since_at = last_outbound_at;

-- 3) Reversão, caso necessário. Só é fiel se rodada antes de qualquer novo
--    tick, que pode legitimamente reexpirar outras linhas.
--
-- UPDATE public.conversation_sla_metrics
-- SET sla_status = 'expired',
--     updated_at = now()
-- WHERE sla_status = 'waiting_customer'
--   AND frozen_at IS NULL
--   AND last_outbound_at IS NOT NULL
--   AND waiting_since_at = last_outbound_at;

-- Equivalente SQLite, para o provedor local. Mesma assinatura, mesma ressalva.
--
-- UPDATE conversation_sla_metrics
-- SET slaStatus = 'waiting_customer',
--     updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
-- WHERE slaStatus = 'expired'
--   AND frozenAt IS NULL
--   AND lastOutboundAt IS NOT NULL
--   AND waitingSinceAt = lastOutboundAt;
