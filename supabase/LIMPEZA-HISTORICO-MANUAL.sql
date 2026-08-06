-- ============================================================================
-- LIMPEZA MANUAL — histórico de conversas do workspace (Supabase)
-- ----------------------------------------------------------------------------
-- Rode no SQL Editor do Supabase (Dashboard > SQL Editor > New query > Run).
-- NÃO é uma migration — não colocar em supabase/migrations/.
--
-- O que apaga:   conversas, mensagens, identidades WhatsApp, grupos,
--                eventos de webhook, jobs de sync/outbox, estados de kanban,
--                métricas de SLA e eventos de roteamento das conversas.
-- O que preserva: contatos (agenda), usuários, equipes, filas, boards/estágios
--                de kanban e configuração de SLA.
--
-- Depois de rodar, reconecte a sessão no dashboard (Dispositivos): as
-- conversas voltam a existir conforme novas mensagens chegarem / sync rodar.
-- ============================================================================

BEGIN;

DELETE FROM conversation_kanban_state    WHERE workspace_id = 'default-workspace';
DELETE FROM conversation_kanban_events   WHERE workspace_id = 'default-workspace';
DELETE FROM kanban_automation_deliveries WHERE workspace_id = 'default-workspace';
DELETE FROM conversation_sla_metrics     WHERE workspace_id = 'default-workspace';
DELETE FROM routing_events               WHERE workspace_id = 'default-workspace';
DELETE FROM routing_jobs                 WHERE workspace_id = 'default-workspace';
DELETE FROM conversation_events          WHERE workspace_id = 'default-workspace';
DELETE FROM conversation_metadata        WHERE workspace_id = 'default-workspace';
DELETE FROM inbox_outbox_jobs            WHERE workspace_id = 'default-workspace';
DELETE FROM whatsapp_messages            WHERE workspace_id = 'default-workspace';
DELETE FROM conversations                WHERE workspace_id = 'default-workspace';
DELETE FROM whatsapp_group_participants  WHERE workspace_id = 'default-workspace';
DELETE FROM whatsapp_groups              WHERE workspace_id = 'default-workspace';
DELETE FROM whatsapp_identities          WHERE workspace_id = 'default-workspace';
DELETE FROM pending_contact_identities   WHERE workspace_id = 'default-workspace';
DELETE FROM whatsapp_sync_jobs           WHERE workspace_id = 'default-workspace';
DELETE FROM waha_webhook_events          WHERE workspace_id = 'default-workspace';

COMMIT;
