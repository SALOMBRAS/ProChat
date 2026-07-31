-- =====================================================================
-- Verificação de M1 e M2 — Supabase / PostgreSQL
-- =====================================================================
-- Rode DEPOIS de aplicar M1 e M2 e DEPOIS de reiniciar a API.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=0 -f web/docs/migrations-m1-m2-verificacao.sql
--
-- Só escreve dentro do workspace '__verify_m1m2__' e apaga tudo no fim.
-- Não toca em dado real. Procedimento em migrations-m1-m2-aplicacao.md.
-- =====================================================================

\set ON_ERROR_STOP off
\pset pager off
\timing off

\echo ''
\echo '========================================================'
\echo ' Verificação M1 + M2'
\echo '========================================================'

-- ---------------------------------------------------------------- estrutura
\echo ''
\echo '-- 1. M1: colunas, índices, tabela --'
SELECT
  count(*) FILTER (WHERE column_name='block_state')          AS block_state,
  count(*) FILTER (WHERE column_name='block_propagation')    AS block_propagation,
  count(*) FILTER (WHERE column_name='block_requested_at')   AS block_requested_at,
  count(*) FILTER (WHERE column_name='block_confirmed_at')   AS block_confirmed_at,
  count(*) FILTER (WHERE column_name='block_last_error_safe') AS block_last_error_safe
FROM information_schema.columns
WHERE table_schema='public' AND table_name='contacts';
\echo '   esperado: 1 em todas'

SELECT to_regclass('public.contact_block_events') AS contact_block_events,
       to_regclass('public.contact_deletion_log') AS contact_deletion_log;
\echo '   esperado: os dois nao-nulos'

SELECT count(*) AS colunas_conversations_blocked_at
FROM information_schema.columns
WHERE table_schema='public' AND table_name='conversations' AND column_name='blocked_at';
\echo '   esperado: 1'

\echo ''
\echo '-- 2. M2: deleted_at + RPC --'
SELECT count(*) AS deleted_at FROM information_schema.columns
WHERE table_schema='public' AND table_name='contacts' AND column_name='deleted_at';
\echo '   esperado: 1'

SELECT p.prosecdef AS security_definer, p.proacl AS grants
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='chatpro_delete_contact';
\echo '   esperado: security_definer = f  e  grants apenas postgres + service_role'

-- --------------------------------------------------------- dados existentes
\echo ''
\echo '-- 3. Nenhum contato existente foi alterado --'
SELECT block_state, block_propagation, count(*) AS total
FROM public.contacts GROUP BY 1,2 ORDER BY 3 DESC;
\echo '   esperado: tudo em active/none (fora os que voce mesmo bloqueou depois)'

SELECT count(*) AS contatos_soft_deleted FROM public.contacts WHERE deleted_at IS NOT NULL;
\echo '   esperado: 0 logo apos aplicar'

-- ------------------------------------------------------------------- setup
\echo ''
\echo '-- 4. Setup do workspace de teste --'
DELETE FROM public.conversations WHERE workspace_id='__verify_m1m2__';
DELETE FROM public.contact_deletion_log WHERE workspace_id='__verify_m1m2__';
DELETE FROM public.contact_block_events WHERE workspace_id='__verify_m1m2__';
DELETE FROM public.contacts WHERE workspace_id='__verify_m1m2__';

INSERT INTO public.contacts (id,workspace_id,display_name,phone_number,created_at,updated_at)
VALUES ('v1','__verify_m1m2__','Verificacao','+000000000001',now(),now());
-- `last_status_change` e NOT NULL desde 20260719000200_multioperator_conversation_management.sql:11.
-- Sem ela o INSERT falha, a conversa nunca nasce, e o passo 10 -- que e a
-- asseracao central de M2 -- devolve (0 rows) em vez de v1. Como esta suite roda
-- com ON_ERROR_STOP off e e conferida a olho, isso lia como sucesso.
INSERT INTO public.conversations (id,workspace_id,waha_session,chat_id,contact_id,status,last_status_change,last_message_at,unread_count,created_at,updated_at)
VALUES (gen_random_uuid(),'__verify_m1m2__','verify','+000000000001@c.us','v1','open',now(),now(),0,now(),now());

-- ------------------------------------------------------------------- CHECKs
\echo ''
\echo '-- 5. CHECK de block_state recusa valor invalido (ERRO ESPERADO) --'
UPDATE public.contacts SET block_state='invalido' WHERE workspace_id='__verify_m1m2__' AND id='v1';
\echo '   esperado: ERROR ... contacts_block_state_check'

\echo ''
\echo '-- 6. CHECK de block_propagation idem (ERRO ESPERADO) --'
UPDATE public.contacts SET block_propagation='invalido' WHERE workspace_id='__verify_m1m2__' AND id='v1';
\echo '   esperado: ERROR ... contacts_block_propagation_check'

\echo ''
\echo '-- 7. Transicao valida de bloqueio --'
UPDATE public.contacts SET block_state='blocking', block_propagation='pending', block_requested_at=now()
WHERE workspace_id='__verify_m1m2__' AND id='v1';
SELECT block_state, block_propagation FROM public.contacts WHERE workspace_id='__verify_m1m2__' AND id='v1';
\echo '   esperado: blocking / pending'

UPDATE public.contacts SET block_state='active', block_propagation='none' WHERE workspace_id='__verify_m1m2__' AND id='v1';

\echo ''
\echo '-- 8. Auditoria de bloqueio aceita insercao --'
INSERT INTO public.contact_block_events (id,workspace_id,contact_id,action,outcome,occurred_at,created_at)
VALUES ('ev1','__verify_m1m2__','v1','block','requested',now(),now());
SELECT action, outcome FROM public.contact_block_events WHERE workspace_id='__verify_m1m2__';
\echo '   esperado: block / requested'

INSERT INTO public.contact_block_events (id,workspace_id,contact_id,action,outcome,occurred_at,created_at)
VALUES ('ev2','__verify_m1m2__','v1','block','banana',now(),now());
\echo '   esperado acima: ERROR no CHECK de outcome'

-- ---------------------------------------------------------------- RPC: soft
\echo ''
\echo '-- 9. RPC soft delete --'
SELECT public.chatpro_delete_contact('__verify_m1m2__','v1','soft','verify-user') AS soft;
\echo '   esperado: {"mode":"soft","affected":{"contactSoftDeleted":1},...}'

SELECT deleted_at IS NOT NULL AS marcado FROM public.contacts WHERE workspace_id='__verify_m1m2__' AND id='v1';
\echo '   esperado: t'

\echo ''
\echo '-- 10. Soft delete PRESERVA o vinculo da conversa (FK nao dispara) --'
SELECT contact_id FROM public.conversations WHERE workspace_id='__verify_m1m2__';
\echo '   esperado: v1'

\echo ''
\echo '-- 11. Log de exclusao gravado --'
SELECT mode, actor_user_id FROM public.contact_deletion_log
WHERE workspace_id='__verify_m1m2__' AND contact_id='v1' ORDER BY occurred_at DESC LIMIT 1;
\echo '   esperado: soft / verify-user'

\echo ''
\echo '-- 12. Telefone CONTINUA ocupado apos soft delete (ERRO ESPERADO) --'
INSERT INTO public.contacts (id,workspace_id,display_name,phone_number,created_at,updated_at)
VALUES ('v2','__verify_m1m2__','Recadastro','+000000000001',now(),now());
\echo '   esperado: ERROR duplicate key ... contacts_workspace_id_phone_number_key'
\echo '   comportamento conhecido, ver "unicidade de telefone" na proposta'

-- ------------------------------------------------------------- RPC: restore
\echo ''
\echo '-- 13. RPC restore --'
SELECT public.chatpro_delete_contact('__verify_m1m2__','v1','restore','verify-user') AS restore;
SELECT deleted_at IS NULL AS restaurado FROM public.contacts WHERE workspace_id='__verify_m1m2__' AND id='v1';
\echo '   esperado: t'

-- ---------------------------------------------------------- contrato de erro
\echo ''
\echo '-- 14. purge REJEITADO (M3 nao aplicada) --'
SELECT public.chatpro_delete_contact('__verify_m1m2__','v1','purge','verify-user');
\echo '   esperado: ERROR invalid delete mode ''purge''; expected soft or restore'
\echo '   SE ISSO PASSAR, M3 ja foi aplicada — pare e confira'

\echo ''
\echo '-- 15. modo invalido --'
SELECT public.chatpro_delete_contact('__verify_m1m2__','v1','banana','verify-user');
\echo '   esperado: ERROR invalid delete mode'

\echo ''
\echo '-- 16. contato inexistente --'
SELECT public.chatpro_delete_contact('__verify_m1m2__','nao-existe','soft','verify-user');
\echo '   esperado: ERROR contact not found in workspace'

\echo ''
\echo '-- 17. guarda de workspace --'
SELECT public.chatpro_delete_contact('','v1','soft','verify-user');
\echo '   esperado: ERROR workspace_id is required'

\echo ''
\echo '-- 18. isolamento entre workspaces --'
SELECT public.chatpro_delete_contact('outro-workspace','v1','soft','verify-user');
\echo '   esperado: ERROR contact not found in workspace'

-- ----------------------------------------------------------------- limpeza
\echo ''
\echo '-- 19. Limpeza --'
DELETE FROM public.conversations WHERE workspace_id='__verify_m1m2__';
DELETE FROM public.contact_deletion_log WHERE workspace_id='__verify_m1m2__';
DELETE FROM public.contact_block_events WHERE workspace_id='__verify_m1m2__';
DELETE FROM public.contacts WHERE workspace_id='__verify_m1m2__';
SELECT count(*) AS sobrou FROM public.contacts WHERE workspace_id='__verify_m1m2__';
\echo '   esperado: 0'

\echo ''
\echo '========================================================'
\echo ' Fim. Os ERROR dos passos 5, 6, 8(ev2), 12, 14-18 sao'
\echo ' ESPERADOS. Qualquer outro ERROR e falha real.'
\echo '========================================================'
