-- ###########################################################################
-- #  MANUAL · DESTRUCTIVE · NEVER RUN VIA DB PUSH                           #
-- #                                                                          #
-- #  CUTOVER 2026-08-08 (versão FAST) — zera a camada operacional do         #
-- #  WhatsApp legado (WAHA) para que os dados pós-pareamento GOWA nasçam     #
-- #  limpos, já com provider_session_id.                                     #
-- #                                                                          #
-- #  Substitui a versão por DELETE, que recebeu HTTP 524: 89 mil linhas não  #
-- #  cabem na janela de ~100 s do gateway. A transação reverteu inteira e o  #
-- #  banco ficou intacto — a atomicidade funcionou, faltou tempo.            #
-- #  TRUNCATE no PostgreSQL é transacional e não varre linha a linha.        #
-- #                                                                          #
-- #  SEM CASCADE, de propósito: a lista abaixo é explícita e fechada.        #
-- ###########################################################################
--
-- AUDITORIA DE FK (information_schema, 2026-08-08). Todas as referências às
-- tabelas truncadas partem de tabelas que TAMBÉM estão na lista — por isso o
-- TRUNCATE dispensa CASCADE. Nenhuma tabela de CRM ou configuração referencia
-- qualquer uma delas:
--
--   conversations        <- conversation_events, conversation_kanban_state,
--                           conversation_metadata, conversation_sla_metrics,
--                           inbox_outbox_jobs, kanban_automation_deliveries,
--                           routing_events, routing_jobs
--   waha_webhook_events  <- whatsapp_messages
--   whatsapp_messages    <- message_reactions
--   whatsapp_groups      <- whatsapp_group_participants
--
-- ESCOPO: cada tabela abaixo foi medida e contém exatamente 1 workspace
-- (`default-workspace`) ou 0 linhas. São 100% legado do WhatsApp, então o
-- TRUNCATE não descarta nada de outro contexto.
--
-- CONTAGENS ANTES (2026-08-08):
--   waha_webhook_events 59.113 · whatsapp_messages 30.157 · whatsapp_identities 9.706
--   whatsapp_group_participants 10.731 · conversations 1.079 · kanban_state 656
--   sla_metrics 98 · metadata 92 · whatsapp_groups 29 · kanban_automation 24
--   kanban_events 23 · outbox 28 · conversation_events 17 · pending 15
--   sync_jobs 3 · message_reactions 4 · routing_events 0 · routing_jobs 0
--
-- PRESERVA — não aparecem no TRUNCATE:
--   contacts (4.601) · contact_identifiers (12.987)  <- CRM global
--   whatsapp_provider_sessions (0)                   <- precisa existir p/ GOWA
--   workspaces · workspace_users · teams · team_members · auth_credentials
--   auth_sessions · routing_queues · routing_queue_members · workspace_sla_config
--   kanban_boards · kanban_stages · pipelines · stages · leads · activities
--   campaigns · templates · tags · workspace_settings
--
-- ANTES DE RODAR: a WAHA precisa estar parada, senão o webhook repopula em
-- seguida. Container `chatpro-waha` parado e API encerrada em 2026-08-08.

BEGIN;

-- PRÉ-CHECK: se um segundo workspace tiver aparecido, este script deixa de ser
-- seguro — TRUNCATE não filtra por workspace, e apagaria o do outro inquilino.
DO $$
DECLARE v_ws bigint;
BEGIN
  SELECT count(DISTINCT workspace_id) INTO v_ws FROM public.conversations;
  IF v_ws > 1 THEN
    RAISE EXCEPTION 'ABORTADO: % workspaces em conversations. TRUNCATE nao filtra por workspace; use a versao por DELETE.', v_ws;
  END IF;
END $$;

-- Uma única instrução, lista explícita, SEM CASCADE.
TRUNCATE TABLE
  public.message_reactions,
  public.whatsapp_messages,
  public.waha_webhook_events,
  public.whatsapp_group_participants,
  public.whatsapp_groups,
  public.whatsapp_identities,
  public.conversation_kanban_state,
  public.conversation_kanban_events,
  public.kanban_automation_deliveries,
  public.conversation_events,
  public.conversation_metadata,
  public.conversation_sla_metrics,
  public.inbox_outbox_jobs,
  public.routing_events,
  public.routing_jobs,
  public.whatsapp_sync_jobs,
  public.pending_contact_identities,
  public.conversations;

-- GUARDA: a checagem não pode depender de olho humano, porque o SQL Editor
-- executa o lote inteiro e o COMMIT já teria acontecido quando o resultado
-- aparecesse. Aqui a exceção aborta a transação e nada é gravado.
DO $$
DECLARE
  v_contatos        bigint;
  v_identificadores bigint;
  v_legado          bigint;
  v_provider        bigint;
BEGIN
  SELECT count(*) INTO v_contatos        FROM public.contacts;
  SELECT count(*) INTO v_identificadores FROM public.contact_identifiers;
  SELECT count(*) INTO v_provider        FROM public.whatsapp_provider_sessions;

  SELECT (SELECT count(*) FROM public.whatsapp_messages)
       + (SELECT count(*) FROM public.waha_webhook_events)
       + (SELECT count(*) FROM public.conversations)
       + (SELECT count(*) FROM public.whatsapp_identities)
       + (SELECT count(*) FROM public.whatsapp_groups)
       + (SELECT count(*) FROM public.whatsapp_group_participants)
       + (SELECT count(*) FROM public.message_reactions)
       + (SELECT count(*) FROM public.conversation_kanban_state)
       + (SELECT count(*) FROM public.conversation_kanban_events)
       + (SELECT count(*) FROM public.kanban_automation_deliveries)
       + (SELECT count(*) FROM public.conversation_events)
       + (SELECT count(*) FROM public.conversation_metadata)
       + (SELECT count(*) FROM public.conversation_sla_metrics)
       + (SELECT count(*) FROM public.inbox_outbox_jobs)
       + (SELECT count(*) FROM public.whatsapp_sync_jobs)
       + (SELECT count(*) FROM public.pending_contact_identities)
    INTO v_legado;

  -- O CRM é o que não pode ser tocado: se sumiu, alguma tabela errada entrou
  -- na lista do TRUNCATE.
  IF v_contatos <> 4601 OR v_identificadores <> 12987 THEN
    RAISE EXCEPTION 'ABORTADO: CRM alterado (contacts=% esperado 4601, contact_identifiers=% esperado 12987). Nada foi gravado.',
      v_contatos, v_identificadores;
  END IF;

  IF v_legado <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: sobrou legado (% linhas). Nada foi gravado.', v_legado;
  END IF;

  -- A tabela precisa continuar existindo para o GOWA; vazia é o estado certo.
  IF v_provider <> 0 THEN
    RAISE EXCEPTION 'ABORTADO: whatsapp_provider_sessions tem % linhas, esperado 0.', v_provider;
  END IF;

  RAISE NOTICE 'OK — legado zerado; contacts=% e contact_identifiers=% preservados.',
    v_contatos, v_identificadores;
END $$;

-- Conferência final, já validada pela guarda acima.
SELECT
  (SELECT count(*) FROM public.whatsapp_messages)           AS mensagens,
  (SELECT count(*) FROM public.waha_webhook_events)         AS eventos,
  (SELECT count(*) FROM public.conversations)               AS conversas,
  (SELECT count(*) FROM public.whatsapp_identities)         AS identidades,
  (SELECT count(*) FROM public.whatsapp_groups)             AS grupos,
  (SELECT count(*) FROM public.message_reactions)           AS reacoes,
  (SELECT count(*) FROM public.contacts)                    AS contatos_preservados,
  (SELECT count(*) FROM public.contact_identifiers)         AS identificadores_preservados,
  (SELECT count(*) FROM public.whatsapp_provider_sessions)  AS provider_sessions_prontas,
  (SELECT count(*) FROM public.workspace_users)             AS usuarios_preservados,
  (SELECT count(*) FROM public.kanban_boards)               AS boards_preservados;

COMMIT;
