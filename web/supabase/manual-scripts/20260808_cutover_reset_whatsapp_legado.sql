-- ###########################################################################
-- #  MANUAL · DESTRUCTIVE · NEVER RUN VIA DB PUSH                           #
-- #                                                                          #
-- #  CUTOVER 2026-08-08 — apaga a camada operacional do WhatsApp legado      #
-- #  (WAHA) para que os dados pós-pareamento GOWA nasçam limpos, já no       #
-- #  modelo com provider_session_id.                                         #
-- #                                                                          #
-- #  Decisão do proprietário: as ~30 mil mensagens são do WhatsApp pessoal   #
-- #  dele, seguem no celular, e não precisam ser preservadas no ChatPro.     #
-- #                                                                          #
-- #  NÃO apaga produto, CRM nem configuração. Ver a lista PRESERVA abaixo.   #
-- ###########################################################################
--
-- ANTES DE RODAR:
--   1. A WAHA precisa estar parada, senão o webhook repopula o banco logo em
--      seguida. Em 2026-08-08 o container `chatpro-waha` foi parado com
--      `docker stop` e a API do ChatPro foi encerrada; a contagem de
--      waha_webhook_events ficou estável em 59.113 por 15 s, confirmando.
--   2. Confira as contagens do bloco de verificação no fim.
--
-- ESCOPO medido em 2026-08-08: existe UM workspace (`default-workspace`) e a
-- totalidade das conversas vem do WhatsApp. Ainda assim todo DELETE é filtrado
-- por workspace onde a coluna existe — um filtro explícito custa nada e evita
-- que este script faça estrago se um segundo workspace aparecer depois.
--
-- CONTAGENS ANTES (2026-08-08):
--   whatsapp_messages 30.157 · waha_webhook_events 59.113 · conversations 1.079
--   whatsapp_identities 9.706 · whatsapp_groups 29 · group_participants 10.731
--   conversation_kanban_state 656 · sla_metrics 98 · metadata 92 · events 17
--   outbox_jobs 28 · sync_jobs 3 · pending_contact_identities 15
--   message_reactions 4
--
-- PRESERVA (não aparecem em nenhum DELETE abaixo):
--   workspaces · workspace_users · teams · team_members · auth_credentials
--   auth_sessions · routing_queues · routing_queue_members · workspace_sla_config
--   kanban_boards · kanban_stages · pipelines · stages · leads · activities
--   campaigns · templates · tags · workspace_settings
--   contacts · contact_identifiers   <-- CRM global, decisão explícita
--
-- As 29 conversas @lid em quarentena saem junto, como parte do legado. O
-- arquivo cura-lids-v3.sql NÃO é usado: ele continua apenas como artefato.

BEGIN;

-- 1. Filhos de whatsapp_messages e de whatsapp_groups.
DELETE FROM public.message_reactions WHERE workspace_id = 'default-workspace';
DELETE FROM public.whatsapp_group_participants
 WHERE group_id IN (SELECT id FROM public.whatsapp_groups WHERE workspace_id = 'default-workspace');

-- 2. Filhos de conversations. O estado de Kanban sai; os boards e stages ficam.
DELETE FROM public.conversation_kanban_state  WHERE workspace_id = 'default-workspace';
DELETE FROM public.conversation_events        WHERE workspace_id = 'default-workspace';
DELETE FROM public.conversation_metadata      WHERE workspace_id = 'default-workspace';
DELETE FROM public.conversation_sla_metrics   WHERE workspace_id = 'default-workspace';
DELETE FROM public.inbox_outbox_jobs          WHERE workspace_id = 'default-workspace';

-- 3. Mensagens antes dos eventos: a FK de whatsapp_messages aponta para
--    waha_webhook_events. A ordem inversa funcionaria por CASCADE, mas o
--    explícito é auditável e não depende de o CASCADE estar onde se supõe.
DELETE FROM public.whatsapp_messages   WHERE workspace_id = 'default-workspace';
DELETE FROM public.waha_webhook_events WHERE workspace_id = 'default-workspace';

-- 4. Identidade técnica e grupos. `contacts` e `contact_identifiers` NÃO saem.
DELETE FROM public.whatsapp_identities WHERE workspace_id = 'default-workspace';
DELETE FROM public.whatsapp_groups     WHERE workspace_id = 'default-workspace';

-- 5. Conversas, já sem nenhum filho.
DELETE FROM public.conversations       WHERE workspace_id = 'default-workspace';

-- 6. Jobs técnicos do ciclo antigo.
DELETE FROM public.whatsapp_sync_jobs  WHERE workspace_id = 'default-workspace';

-- 7. Pendências de identidade: são estritamente técnicas (LID aguardando
--    telefone) e sem as mensagens que as originaram não significam mais nada.
DELETE FROM public.pending_contact_identities WHERE workspace_id = 'default-workspace';

-- VERIFICAÇÃO — leia antes do COMMIT. Os seis primeiros devem ser 0; os dois
-- últimos devem continuar 4.601 e 12.987. Se `contacts` vier 0, algo saiu
-- muito errado: ROLLBACK.
SELECT
  (SELECT count(*) FROM public.whatsapp_messages)      AS mensagens,
  (SELECT count(*) FROM public.waha_webhook_events)    AS eventos,
  (SELECT count(*) FROM public.conversations)          AS conversas,
  (SELECT count(*) FROM public.whatsapp_identities)    AS identidades,
  (SELECT count(*) FROM public.whatsapp_groups)        AS grupos,
  (SELECT count(*) FROM public.message_reactions)      AS reacoes,
  (SELECT count(*) FROM public.contacts)               AS contatos_preservados,
  (SELECT count(*) FROM public.contact_identifiers)    AS identificadores_preservados;

COMMIT;
-- Se qualquer número acima destoar do esperado: ROLLBACK; em vez de COMMIT;
