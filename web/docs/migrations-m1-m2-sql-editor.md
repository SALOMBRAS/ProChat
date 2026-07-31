# Roteiro para o SQL Editor do Supabase — M1 (bloqueio) e M2 (soft delete)

> **ETAPA 3. Nada aqui foi executado no remoto.** Este é o pacote a colar no SQL
> Editor, bloco a bloco, na ordem. Cada um é colável isoladamente, traz o que
> esperar e tem rollback.

## Pré-condições, medidas no remoto em 31/07/2026 (somente leitura)

A base está **exatamente** no estado que o procedimento pressupõe:

| verificação | resultado |
| --- | --- |
| `contacts.block_state` | `42703 column does not exist` — **ainda não existe** |
| `contacts.deleted_at` | `42703` — ainda não existe |
| `conversations.blocked_at` | `42703` — ainda não existe |
| `contact_block_events` / `contact_deletion_log` | `PGRST205` — tabelas ausentes |
| `contacts` | **82 linhas** |
| `conversations` | 658 linhas |
| telefone duplicado no mesmo workspace | **0** — a unicidade de que M2 depende vale |
| contatos sem telefone | 0 |
| conversas com `contact_id` | 94, ligadas a **82 contatos distintos** |

**82 contatos** é o universo inteiro que M1 e M2 alteram. É pequeno, e todos têm
conversa vinculada — que é justamente o que o soft delete de M2 preserva.

> **Reexecute o BLOCO 1 imediatamente antes de aplicar.** Estas medições são de
> 31/07; a base recebe mensagem continuamente. O BLOCO 1 é o pré-voo e responde
> `SEGUIR` ou `PARE`.

## O que já foi validado antes de chegar aqui

| etapa | resultado |
| --- | --- |
| **ETAPA 1** — contêiner PostgreSQL 16.14 | M1 e M2 aplicam limpo (exit 0); **idempotentes** na reaplicação; rollback devolve `contacts` e `conversations` **idênticos** ao baseline (`diff` = 0 diferenças); ciclo aplicar → reverter → reaplicar fecha, com a suíte saindo 0 nas **três** execuções e 9 `NOTICE ok` em cada |
| **ETAPA 2** — SQLite | migrations `022_contact_block.sql` e `023_contact_soft_delete.sql` criadas a partir da proposta (SQL **idêntico**, conferido programaticamente) e aplicadas pelo runner real; suíte `.mjs`: **34 passaram, 0 falharam** |

### Revisão deste roteiro

Conferi antes de publicar: nenhum bloco usa meta-comando do psql; o SQL de M1 e
M2 é verbatim da proposta; e **toda escrita do BLOCO 6 está presa a
`workspace_id = '__verify_m1m2__' AND id = 'v1'`** — verifiquei linha a linha,
porque esse bloco escreve em `public.contacts` e `public.conversations` reais.

---

Validado por execução em PostgreSQL 16.14 (contêiner descartável `pg-pacote`),
sobre o schema reconstruído de `supabase/migrations/` + `web/supabase/migrations/`.
O banco remoto NÃO foi tocado.

REGRAS DO SQL EDITOR (por que este roteiro não é o `.md` do procedimento):
- `\echo`, `\set`, `\pset`, `\timing`, `\copy` são meta-comandos do psql e NÃO
  funcionam aqui. O procedimento em `web/docs/migrations-m1-m2-aplicacao.md` usa
  os cinco; a suíte `migrations-m1-m2-verificacao.sql` também. Nada disso foi
  colado neste roteiro.
- Cada bloco abaixo é colável e executável ISOLADAMENTE, na ordem.
- Toda conferência devolve UMA tabela só, com coluna `veredito`. Se o SQL Editor
  mostrar apenas o último resultado de um bloco com vários SELECT, isso não
  atrapalha: aqui não há bloco de conferência com mais de um SELECT.
- ANTES DE COMEÇAR: backup (Database -> Backups). Sem backup, não comece.

## BLOCO 1 — PRÉ-VOO (só lê)

```sql
-- BLOCO 0 — PRÉ-VOO. Não altera nada. Esperado: coluna "veredito" = SEGUIR.
SELECT
  count(*) FILTER (WHERE c.table_name = 'contacts'
                     AND (c.column_name LIKE 'block%' OR c.column_name = 'deleted_at'))  AS cols_m1m2_em_contacts,
  count(*) FILTER (WHERE c.table_name = 'conversations' AND c.column_name = 'blocked_at') AS col_blocked_at,
  (SELECT count(*) FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
    WHERE n.nspname = 'public'
      AND k.relname IN ('contact_block_events','contact_deletion_log'))                   AS tabelas_novas,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'chatpro_delete_contact')                  AS rpc_ja_existe,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'chatpro_require_workspace')               AS dep_require_workspace,
  (SELECT count(*) FROM pg_roles WHERE rolname = 'service_role')                          AS dep_service_role,
  (SELECT count(*) FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
    WHERE n.nspname = 'public' AND k.relname = 'contact_identifiers')                     AS dep_020_aliases,
  CASE
    WHEN count(*) FILTER (WHERE c.table_name = 'contacts'
                            AND (c.column_name LIKE 'block%' OR c.column_name = 'deleted_at')) > 0
      OR count(*) FILTER (WHERE c.table_name = 'conversations' AND c.column_name = 'blocked_at') > 0
      OR (SELECT count(*) FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
           WHERE n.nspname = 'public'
             AND k.relname IN ('contact_block_events','contact_deletion_log')) > 0
      OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'chatpro_delete_contact') > 0
      THEN 'PARE: M1 ou M2 ja aplicada, no todo ou em parte'
    WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'chatpro_require_workspace') = 0
      THEN 'PARE: falta chatpro_require_workspace'
    WHEN (SELECT count(*) FROM pg_roles WHERE rolname = 'service_role') = 0
      THEN 'PARE: falta o role service_role'
    ELSE 'SEGUIR'
  END AS veredito
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name IN ('contacts','conversations');
```

Esperado: 1 linha, coluna `veredito` = `SEGUIR`.
Se vier `PARE: M1 ou M2 ja aplicada...` → alguém já aplicou parte. NÃO siga;
rode o BLOCO 3 e o BLOCO 5 para ver o que existe e decida com quem aplicou.
Se vier `PARE: falta chatpro_require_workspace` ou `falta o role service_role`,
você está conectado no projeto errado.

## BLOCO 2 — APLICAR M1

```sql
-- BLOCO 1 -- M1 / Supabase. Verbatim de web/docs/migrations-propostas-contatos.sql:406-461.
-- BEGIN/COMMIT explicito: se um comando falhar, nada fica pela metade.
BEGIN;

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_state text NOT NULL DEFAULT 'active';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_propagation text NOT NULL DEFAULT 'none';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_requested_at timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_confirmed_at timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_last_error_safe text;

-- CHECKs nomeados e separados do ADD COLUMN, para o bloco ser idempotente e o
-- rollback poder derrubá-los por nome.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.contacts'::regclass
                    AND conname = 'contacts_block_state_check') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_block_state_check
      CHECK (block_state IN ('active', 'blocking', 'blocked', 'unblocking', 'block_failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.contacts'::regclass
                    AND conname = 'contacts_block_propagation_check') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_block_propagation_check
      CHECK (block_propagation IN ('none', 'pending', 'confirmed', 'failed', 'unsupported'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_block_state
  ON public.contacts(workspace_id, block_state) WHERE block_state <> 'active';

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_conversations_blocked
  ON public.conversations(workspace_id, blocked_at) WHERE blocked_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.contact_block_events (
  id text NOT NULL,
  workspace_id text NOT NULL,
  contact_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('block', 'unblock')),
  outcome text NOT NULL
    CHECK (outcome IN ('requested', 'propagated', 'failed', 'skipped_unsupported')),
  waha_session text,
  actor_user_id text,
  reason_safe text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, contact_id)
    REFERENCES public.contacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_contact_block_events_contact
  ON public.contact_block_events(workspace_id, contact_id, occurred_at DESC);

-- Mesma postura das demais tabelas de CRM: RLS ligada, nenhuma policy, acesso
-- só por service_role (que ignora RLS). Espelha 013_contact_identity_aliases.sql.
ALTER TABLE public.contact_block_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_block_events TO service_role;



COMMIT;
```

Esperado: `Success. No rows returned`. `ADD COLUMN` com default constante não
reescreve a tabela (medido: `pg_relation_filenode(public.contacts)` = 16835
antes e depois), então é rápido mesmo com a tabela populada.
Se falhar: o `BEGIN/COMMIT` já reverteu tudo — nada ficou pela metade. Leia o
erro, corrija e recole o bloco inteiro. O bloco é idempotente (`IF NOT EXISTS`
em tudo, CHECKs dentro de `DO`): recolar só emite NOTICE `already exists, skipping`.

## BLOCO 3 — CONFERIR M1 (só lê)

```sql
-- BLOCO 2 — CONFERÊNCIA DE M1. Só lê. Esperado: 8 linhas, todas com veredito = OK.
SELECT item, obtido, esperado,
       CASE WHEN obtido = esperado THEN 'OK' ELSE 'FALHOU' END AS veredito
FROM (
  SELECT '1. colunas block* em contacts' AS item,
         (SELECT string_agg(column_name, ',' ORDER BY column_name)
            FROM information_schema.columns
           WHERE table_schema='public' AND table_name='contacts'
             AND column_name LIKE 'block%') AS obtido,
         'block_confirmed_at,block_last_error_safe,block_propagation,block_requested_at,block_state' AS esperado
  UNION ALL
  SELECT '2. conversations.blocked_at',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='public' AND table_name='conversations' AND column_name='blocked_at'), '1'
  UNION ALL
  SELECT '3. tabela contact_block_events',
         coalesce(to_regclass('public.contact_block_events')::text, 'AUSENTE'), 'contact_block_events'
  UNION ALL
  SELECT '4. CHECKs nomeados em contacts',
         (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint
           WHERE conrelid='public.contacts'::regclass AND contype='c'
             AND conname IN ('contacts_block_state_check','contacts_block_propagation_check')),
         'contacts_block_propagation_check,contacts_block_state_check'
  UNION ALL
  SELECT '5. indices parciais de M1',
         (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
           WHERE schemaname='public'
             AND indexname IN ('idx_contacts_block_state','idx_conversations_blocked',
                               'idx_contact_block_events_contact')),
         'idx_contact_block_events_contact,idx_contacts_block_state,idx_conversations_blocked'
  UNION ALL
  SELECT '6. RLS ligada em contact_block_events',
         (SELECT relrowsecurity::text FROM pg_class WHERE oid='public.contact_block_events'::regclass), 'true'
  UNION ALL
  SELECT '7. grant a service_role',
         (SELECT count(*)::text FROM information_schema.role_table_grants
           WHERE table_schema='public' AND table_name='contact_block_events'
             AND grantee='service_role'
             AND privilege_type IN ('SELECT','INSERT','UPDATE','DELETE')), '4'
  UNION ALL
  SELECT '8. nenhum contato existente alterado',
         (SELECT count(*)::text FROM public.contacts
           WHERE block_state <> 'active' OR block_propagation <> 'none'), '0'
) t
ORDER BY item;
```

Esperado: 8 linhas, TODAS com `veredito` = `OK`.
Qualquer `FALHOU` → recole o BLOCO 2 e confira de novo. Se persistir, aplique
o BLOCO 9 (rollback de M1) e pare.

## BLOCO 4 — APLICAR M2

```sql
-- BLOCO 3 -- M2 / Supabase. Verbatim de web/docs/migrations-propostas-contatos.sql:616-720.
BEGIN;


ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_contacts_workspace_created_active
  ON public.contacts(workspace_id, created_at DESC) WHERE deleted_at IS NULL;

-- affected_json, e não "affected": a convenção da casa mantém o sufixo _json /
-- Json nos DOIS bancos (variables_json/variablesJson, details_json/detailsJson,
-- settings_json/settingsJson), e o mapeamento snake<->camel de
-- supabase-domain.repository.ts:10-11 é mecânico — nomes divergentes entregariam
-- campos diferentes à camada de domínio conforme o provider.
CREATE TABLE IF NOT EXISTS public.contact_deletion_log (
  id text NOT NULL,
  workspace_id text NOT NULL,
  contact_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('soft', 'purge', 'restore')),
  actor_user_id text,
  identifier_hash text,
  affected_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(affected_json) = 'object'),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_contact_deletion_log_contact
  ON public.contact_deletion_log(workspace_id, contact_id, occurred_at DESC);

ALTER TABLE public.contact_deletion_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_deletion_log TO service_role;

-- .....................................................................
-- chatpro_delete_contact
--
-- ASSINATURA COMPLETA JÁ AQUI, INCLUSIVE p_identifier_hash, QUE M2 NÃO USA.
-- Deliberado. CREATE OR REPLACE FUNCTION não altera assinatura: se M3
-- acrescentasse um parâmetro, o Postgres criaria uma SEGUNDA função sobrecarregada
-- em vez de substituir esta. Verificado em PG16 — passaram a existir 2 funções e
-- a chamada de 4 argumentos falhou com "function ... is not unique", tanto
-- posicional quanto nomeada (estilo PostgREST); pior, a segunda nasceu com
-- proacl nulo, ou seja, executável por PUBLIC. Fixando a assinatura final agora,
-- M3 troca só o CORPO — e os GRANTs sobrevivem, porque CREATE OR REPLACE
-- preserva as permissões da função existente (também verificado).
-- .....................................................................
create or replace function public.chatpro_delete_contact(
  p_workspace_id text,
  p_contact_id text,
  p_mode text default 'soft',
  p_actor_user_id text default null,
  p_identifier_hash text default null
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_row contacts%rowtype;
  v_affected jsonb := '{}'::jsonb;
begin
  perform chatpro_require_workspace(p_workspace_id);

  if p_mode is null or p_mode not in ('soft', 'restore') then
    -- 'purge' cai aqui de propósito enquanto M3 não rodou.
    raise exception using errcode = '22023',
      message = format('invalid delete mode %L; expected soft or restore', p_mode);
  end if;

  select * into v_row from contacts
   where workspace_id = p_workspace_id and id = p_contact_id
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contact not found in workspace';
  end if;

  if p_mode = 'soft' then
    -- Idempotente: apagar duas vezes não move deleted_at nem duplica o log.
    if v_row.deleted_at is not null then
      return jsonb_build_object('mode', 'soft', 'contactId', p_contact_id,
                                'alreadyApplied', true, 'affected', v_affected);
    end if;
    update contacts set deleted_at = now(), updated_at = now()
     where workspace_id = p_workspace_id and id = p_contact_id;
    v_affected := jsonb_build_object('contactSoftDeleted', 1);
  else
    if v_row.deleted_at is null then
      return jsonb_build_object('mode', 'restore', 'contactId', p_contact_id,
                                'alreadyApplied', true, 'affected', v_affected);
    end if;
    update contacts set deleted_at = null, updated_at = now()
     where workspace_id = p_workspace_id and id = p_contact_id;
    v_affected := jsonb_build_object('contactRestored', 1);
  end if;

  -- identifier_hash fica NULL aqui DE PROPÓSITO, mesmo que p_identifier_hash
  -- tenha vindo preenchido: em soft/restore o contato e o telefone permanecem no
  -- banco, então não há manifestação a preservar sem PII. O parâmetro existe na
  -- assinatura apenas para M3 poder substituir o corpo sem sobrecarregar.
  insert into contact_deletion_log
    (id, workspace_id, contact_id, mode, actor_user_id, identifier_hash,
     affected_json, occurred_at, created_at)
  values (gen_random_uuid()::text, p_workspace_id, p_contact_id, p_mode,
          p_actor_user_id, null, v_affected, now(), now());

  return jsonb_build_object('mode', p_mode, 'contactId', p_contact_id,
                            'alreadyApplied', false, 'affected', v_affected);
end $$;

revoke all on function public.chatpro_delete_contact(text, text, text, text, text) from public;
grant execute on function public.chatpro_delete_contact(text, text, text, text, text) to service_role;



COMMIT;
```

Esperado: `Success. No rows returned`.
AVISO: este bloco tem `create or replace function`. NUNCA recole depois que M3
tiver sido aplicada — ele troca o corpo COM purga pelo corpo SEM purga, com
sucesso e sem aviso, e o modo `purge` some.

## BLOCO 5 — CONFERIR M2 (só lê)

```sql
-- BLOCO 4 — CONFERÊNCIA DE M2. Só lê. Esperado: 8 linhas, todas com veredito = OK.
SELECT item, obtido, esperado,
       CASE WHEN obtido = esperado THEN 'OK' ELSE 'FALHOU' END AS veredito
FROM (
  SELECT '1. contacts.deleted_at' AS item,
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='public' AND table_name='contacts' AND column_name='deleted_at') AS obtido,
         '1' AS esperado
  UNION ALL
  SELECT '2. tabela contact_deletion_log',
         coalesce(to_regclass('public.contact_deletion_log')::text, 'AUSENTE'), 'contact_deletion_log'
  UNION ALL
  SELECT '3. indices de M2',
         (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes
           WHERE schemaname='public'
             AND indexname IN ('idx_contacts_workspace_created_active','idx_contact_deletion_log_contact')),
         'idx_contact_deletion_log_contact,idx_contacts_workspace_created_active'
  UNION ALL
  SELECT '4. idx_contacts_workspace_created preservado',
         (SELECT count(*)::text FROM pg_indexes
           WHERE schemaname='public' AND indexname='idx_contacts_workspace_created'), '1'
  UNION ALL
  SELECT '5. RLS ligada em contact_deletion_log',
         (SELECT relrowsecurity::text FROM pg_class WHERE oid='public.contact_deletion_log'::regclass), 'true'
  UNION ALL
  SELECT '6. RPC chatpro_delete_contact existe, 1 so assinatura',
         (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='chatpro_delete_contact'), '1'
  UNION ALL
  SELECT '7. RPC e security invoker',
         (SELECT (NOT p.prosecdef)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='chatpro_delete_contact'), 'true'
  UNION ALL
  SELECT '8. execute: service_role sim, PUBLIC nao',
         (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                 || '/' ||
                 EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)::text
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='chatpro_delete_contact'), 'true/false'
) t
ORDER BY item;
```

Esperado: 8 linhas, TODAS com `veredito` = `OK`.
Item 6 = `2` significa duas assinaturas sobrecarregadas: PARE, é o modo de falha
que a proposta descreve (a segunda nasce executável por PUBLIC).
Item 8 diferente de `true/false` → PUBLIC pode executar a RPC: rode
`revoke all on function public.chatpro_delete_contact(text, text, text, text, text) from public;`

## BLOCO 6 — TESTE FUNCIONAL

Escreve e apaga só no workspace `__verify_m1m2__`. Rode DEPOIS de reiniciar a API.

```sql
-- BLOCO 5 — TESTE FUNCIONAL. Escreve e apaga só no workspace '__verify_m1m2__'.
-- Porta de migrations-m1-m2-verificacao.sql para o SQL Editor: sem \set, \echo,
-- \pset, \timing. Devolve UMA tabela; a última linha é o placar.
CREATE OR REPLACE FUNCTION pg_temp.espera_erro(p_comando text, p_trecho text)
RETURNS text LANGUAGE plpgsql AS $espera$
BEGIN
  EXECUTE p_comando;
  RETURN 'FALHOU: passou quando devia ter sido recusado';
EXCEPTION WHEN OTHERS THEN
  IF position(p_trecho in SQLERRM) > 0 THEN
    RETURN 'recusado [' || SQLSTATE || ']';
  END IF;
  RETURN 'FALHOU: recusou por outro motivo [' || SQLSTATE || '] ' || SQLERRM;
END $espera$;

CREATE OR REPLACE FUNCTION pg_temp.verifica_m1m2()
RETURNS TABLE (passo text, obtido text, esperado text, veredito text)
LANGUAGE plpgsql AS $suite$
DECLARE
  v_ws   text := '__verify_m1m2__';
  v_json jsonb;
  v_ok   int := 0;
  v_bad  int := 0;
  r      record;
BEGIN
  CREATE TEMP TABLE _res (ord int, passo text, obtido text, esperado text) ON COMMIT DROP;

  -- setup
  DELETE FROM public.conversations        WHERE workspace_id = v_ws;
  DELETE FROM public.contact_deletion_log WHERE workspace_id = v_ws;
  DELETE FROM public.contact_block_events WHERE workspace_id = v_ws;
  DELETE FROM public.contacts             WHERE workspace_id = v_ws;

  INSERT INTO public.contacts (id, workspace_id, display_name, phone_number, created_at, updated_at)
  VALUES ('v1', v_ws, 'Verificacao', '+000000000001', now(), now());
  -- last_status_change e NOT NULL desde 20260719000200_multioperator_conversation_management.sql:11
  INSERT INTO public.conversations
    (id, workspace_id, waha_session, chat_id, contact_id, status,
     last_status_change, last_message_at, unread_count, created_at, updated_at)
  VALUES (gen_random_uuid(), v_ws, 'verify', '+000000000001@c.us', 'v1', 'open',
          now(), now(), 0, now(), now());

  INSERT INTO _res VALUES (1, 'setup: contato e conversa criados',
    (SELECT count(*)::text FROM public.conversations WHERE workspace_id = v_ws), '1');

  INSERT INTO _res VALUES (2, 'CHECK de block_state recusa valor invalido',
    pg_temp.espera_erro(
      format('UPDATE public.contacts SET block_state=%L WHERE workspace_id=%L AND id=%L','invalido',v_ws,'v1'),
      'contacts_block_state_check'), 'recusado [23514]');

  INSERT INTO _res VALUES (3, 'CHECK de block_propagation recusa valor invalido',
    pg_temp.espera_erro(
      format('UPDATE public.contacts SET block_propagation=%L WHERE workspace_id=%L AND id=%L','invalido',v_ws,'v1'),
      'contacts_block_propagation_check'), 'recusado [23514]');

  UPDATE public.contacts SET block_state='blocking', block_propagation='pending', block_requested_at=now()
   WHERE workspace_id = v_ws AND id = 'v1';
  INSERT INTO _res
  SELECT 4, 'transicao valida de bloqueio', block_state || '/' || block_propagation, 'blocking/pending'
    FROM public.contacts WHERE workspace_id = v_ws AND id = 'v1';
  UPDATE public.contacts SET block_state='active', block_propagation='none'
   WHERE workspace_id = v_ws AND id = 'v1';

  INSERT INTO public.contact_block_events (id, workspace_id, contact_id, action, outcome, occurred_at, created_at)
  VALUES ('ev1', v_ws, 'v1', 'block', 'requested', now(), now());
  INSERT INTO _res
  SELECT 5, 'auditoria de bloqueio aceita insercao', action || '/' || outcome, 'block/requested'
    FROM public.contact_block_events WHERE workspace_id = v_ws AND id = 'ev1';

  INSERT INTO _res VALUES (6, 'CHECK de outcome recusa valor invalido',
    pg_temp.espera_erro(
      format($f$INSERT INTO public.contact_block_events (id,workspace_id,contact_id,action,outcome,occurred_at,created_at)
                VALUES ('ev2',%L,'v1','block','banana',now(),now())$f$, v_ws),
      'outcome'), 'recusado [23514]');

  v_json := public.chatpro_delete_contact(v_ws, 'v1', 'soft', 'verify-user');
  INSERT INTO _res VALUES (7, 'RPC soft delete',
    (v_json->>'mode') || '/' || (v_json#>>'{affected,contactSoftDeleted}'), 'soft/1');
  INSERT INTO _res
  SELECT 8, 'deleted_at marcado', (deleted_at IS NOT NULL)::text, 'true'
    FROM public.contacts WHERE workspace_id = v_ws AND id = 'v1';

  INSERT INTO _res
  SELECT 9, 'soft delete PRESERVA o vinculo da conversa', coalesce(contact_id,'NULO'), 'v1'
    FROM public.conversations WHERE workspace_id = v_ws;

  INSERT INTO _res
  SELECT 10, 'log de exclusao gravado', mode || '/' || actor_user_id, 'soft/verify-user'
    FROM public.contact_deletion_log WHERE workspace_id = v_ws AND contact_id = 'v1'
   ORDER BY occurred_at DESC LIMIT 1;

  INSERT INTO _res VALUES (11, 'idempotencia: soft duas vezes nao duplica log',
    (public.chatpro_delete_contact(v_ws,'v1','soft','verify-user')->>'alreadyApplied')
      || '/' || (SELECT count(*)::text FROM public.contact_deletion_log WHERE workspace_id=v_ws),
    'true/1');

  INSERT INTO _res VALUES (12, 'telefone CONTINUA ocupado apos soft delete',
    pg_temp.espera_erro(
      format($f$INSERT INTO public.contacts (id,workspace_id,display_name,phone_number,created_at,updated_at)
                VALUES ('v2',%L,'Recadastro','+000000000001',now(),now())$f$, v_ws),
      'phone_number'), 'recusado [23505]');

  v_json := public.chatpro_delete_contact(v_ws, 'v1', 'restore', 'verify-user');
  INSERT INTO _res VALUES (13, 'RPC restore', v_json->>'mode', 'restore');
  INSERT INTO _res
  SELECT 14, 'deleted_at limpo', (deleted_at IS NULL)::text, 'true'
    FROM public.contacts WHERE workspace_id = v_ws AND id = 'v1';

  INSERT INTO _res VALUES (15, 'purge RECUSADO (M3 nao aplicada)',
    pg_temp.espera_erro(format($f$SELECT public.chatpro_delete_contact(%L,'v1','purge','verify-user')$f$, v_ws),
      'invalid delete mode'), 'recusado [22023]');
  INSERT INTO _res VALUES (16, 'modo invalido recusado',
    pg_temp.espera_erro(format($f$SELECT public.chatpro_delete_contact(%L,'v1','banana','verify-user')$f$, v_ws),
      'invalid delete mode'), 'recusado [22023]');
  INSERT INTO _res VALUES (17, 'contato inexistente recusado',
    pg_temp.espera_erro(format($f$SELECT public.chatpro_delete_contact(%L,'nao-existe','soft',NULL)$f$, v_ws),
      'contact not found'), 'recusado [P0002]');
  INSERT INTO _res VALUES (18, 'guarda de workspace vazio',
    pg_temp.espera_erro($f$SELECT public.chatpro_delete_contact('','v1','soft',NULL)$f$,
      'workspace_id'), 'recusado [22023]');
  INSERT INTO _res VALUES (19, 'isolamento entre workspaces',
    pg_temp.espera_erro($f$SELECT public.chatpro_delete_contact('outro-workspace','v1','soft',NULL)$f$,
      'contact not found'), 'recusado [P0002]');

  -- limpeza
  DELETE FROM public.conversations        WHERE workspace_id = v_ws;
  DELETE FROM public.contact_deletion_log WHERE workspace_id = v_ws;
  DELETE FROM public.contact_block_events WHERE workspace_id = v_ws;
  DELETE FROM public.contacts             WHERE workspace_id = v_ws;
  INSERT INTO _res VALUES (20, 'limpeza: nada sobrou do workspace de teste',
    (SELECT (count(*))::text FROM public.contacts WHERE workspace_id = v_ws), '0');

  FOR r IN SELECT * FROM _res ORDER BY ord LOOP
    IF r.obtido IS NOT DISTINCT FROM r.esperado THEN v_ok := v_ok + 1; ELSE v_bad := v_bad + 1; END IF;
    passo := lpad(r.ord::text,2,'0') || '. ' || r.passo;
    obtido := r.obtido; esperado := r.esperado;
    veredito := CASE WHEN r.obtido IS NOT DISTINCT FROM r.esperado THEN 'OK' ELSE 'FALHOU' END;
    RETURN NEXT;
  END LOOP;

  passo := 'PLACAR'; obtido := v_ok || ' OK / ' || v_bad || ' FALHOU'; esperado := '20 OK / 0 FALHOU';
  veredito := CASE WHEN v_bad = 0 THEN 'OK' ELSE 'FALHOU' END;
  RETURN NEXT;
END $suite$;

SELECT * FROM pg_temp.verifica_m1m2();
```

Esperado: 21 linhas; a última é `PLACAR` = `20 OK / 0 FALHOU`.
Se der erro `new row violates row-level security policy for table "contacts"`:
o papel do SQL Editor não está ignorando RLS. Não é defeito da migration —
os BLOCOS 3 e 5 já provaram o schema. Rode o teste pela API com `service_role`,
ou por `psql` com a suíte `web/docs/migrations-m1-m2-verificacao.sql`.
Qualquer linha `FALHOU`: leia `obtido` contra `esperado`. Linha 15 `FALHOU` com
`passou quando devia ter sido recusado` = M3 já está aplicada; pare.

## DEPOIS DOS BLOCOS 1-6: REINICIE A API

Não pule. A sondagem de capacidade de schema é cacheada por cliente; sem
reiniciar, o processo antigo continua achando que M1 e M2 não existem, em
silêncio. Settings -> API -> Restart server, ou reinicie `apps/api`.

---

# ROLLBACK

## BLOCO 7 — EXPORTE ANTES DE REVERTER (só lê)

Quatro consultas. Rode UMA DE CADA VEZ e use o botão "Download CSV" do SQL
Editor em cada resultado. `\copy` do procedimento não funciona aqui.

```sql
-- BLOCO 6 — EXPORTE ANTES DE REVERTER. Só lê. Rode as duas, uma de cada vez,
-- e use o botão "Download CSV" do SQL Editor em cada resultado.
-- (\copy é meta-comando do psql e NÃO funciona aqui.)
SELECT * FROM public.contact_deletion_log ORDER BY occurred_at;
```

```sql
SELECT id, workspace_id, deleted_at, block_state, block_propagation,
       block_requested_at, block_confirmed_at, block_last_error_safe
  FROM public.contacts
 WHERE deleted_at IS NOT NULL OR block_state <> 'active' OR block_propagation <> 'none'
 ORDER BY workspace_id, id;
```

```sql
SELECT * FROM public.contact_block_events ORDER BY occurred_at;
```

```sql
SELECT workspace_id, id, chat_id, blocked_at FROM public.conversations
 WHERE blocked_at IS NOT NULL ORDER BY workspace_id, id;
```

Se as quatro voltarem 0 linhas, nada de M1/M2 foi usado ainda e o rollback não
destrói informação nenhuma.

## BLOCO 8 — ROLLBACK DE M2

```sql
-- BLOCO 7 — ROLLBACK DE M2. Verbatim de web/docs/migrations-propostas-contatos.sql:726-732.
BEGIN;
DROP FUNCTION IF EXISTS public.chatpro_delete_contact(text, text, text, text, text);
DROP INDEX IF EXISTS public.idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS public.contact_deletion_log;
DROP INDEX IF EXISTS public.idx_contacts_workspace_created_active;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS deleted_at;
COMMIT;
```

## BLOCO 9 — ROLLBACK DE M1

```sql
-- BLOCO 8 — ROLLBACK DE M1. Verbatim de web/docs/migrations-propostas-contatos.sql:471-484.
-- A ORDEM IMPORTA: indices e CHECKs saem ANTES das colunas que eles citam.
BEGIN;
DROP INDEX IF EXISTS public.idx_contact_block_events_contact;
DROP TABLE IF EXISTS public.contact_block_events;
DROP INDEX IF EXISTS public.idx_conversations_blocked;
ALTER TABLE public.conversations DROP COLUMN IF EXISTS blocked_at;
DROP INDEX IF EXISTS public.idx_contacts_block_state;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_propagation_check;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_state_check;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_last_error_safe;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_confirmed_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_requested_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_propagation;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_state;
COMMIT;
```

Ordem inversa da aplicação: M2 primeiro, M1 depois. Medido: a ordem trocada
também funciona (M1 e M2 não se citam), mas siga a inversa.
Ambos são `IF EXISTS` em tudo: recolar não dá erro.

## BLOCO 10 — CONFERIR O ROLLBACK (só lê)

```sql
-- BLOCO 9 — CONFERÊNCIA DO ROLLBACK. Só lê. Esperado: 6 linhas, todas com veredito = OK.
SELECT item, obtido, esperado,
       CASE WHEN obtido = esperado THEN 'OK' ELSE 'FALHOU' END AS veredito
FROM (
  SELECT '1. colunas block*/deleted_at em contacts' AS item,
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='public' AND table_name='contacts'
             AND (column_name LIKE 'block%' OR column_name='deleted_at')) AS obtido, '0' AS esperado
  UNION ALL
  SELECT '2. conversations.blocked_at',
         (SELECT count(*)::text FROM information_schema.columns
           WHERE table_schema='public' AND table_name='conversations' AND column_name='blocked_at'), '0'
  UNION ALL
  SELECT '3. tabelas de M1/M2',
         (SELECT count(*)::text FROM pg_class k JOIN pg_namespace n ON n.oid=k.relnamespace
           WHERE n.nspname='public' AND k.relname IN ('contact_block_events','contact_deletion_log')), '0'
  UNION ALL
  SELECT '4. indices de M1/M2',
         (SELECT count(*)::text FROM pg_indexes WHERE schemaname='public'
           AND indexname IN ('idx_contacts_block_state','idx_conversations_blocked',
                             'idx_contact_block_events_contact','idx_contacts_workspace_created_active',
                             'idx_contact_deletion_log_contact')), '0'
  UNION ALL
  SELECT '5. RPC chatpro_delete_contact',
         (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='chatpro_delete_contact'), '0'
  UNION ALL
  SELECT '6. indice pre-existente idx_contacts_workspace_created intacto',
         (SELECT count(*)::text FROM pg_indexes
           WHERE schemaname='public' AND indexname='idx_contacts_workspace_created'), '1'
) t
ORDER BY item;
```

Esperado: 6 linhas, TODAS `OK`. Item 6 prova que o índice pré-existente
`idx_contacts_workspace_created` sobreviveu.
Depois do rollback, REINICIE A API DE NOVO, pelo mesmo motivo, na direção contrária.

## O QUE O ROLLBACK NÃO DESFAZ

Medido no contêiner: um contato marcado com `deleted_at`, `block_state=blocked`,
1 linha em `contact_deletion_log` e 1 em `contact_block_events`. Depois dos
BLOCOS 8 e 9:

- o CONTATO continua lá (`count(*)` = 1) — o rollback não apaga ninguém;
- `contact_deletion_log`: TABELA SUMIU, com a linha dentro;
- `contact_block_events`: TABELA SUMIU, com a linha dentro;
- `deleted_at`, `block_state`, `block_propagation`, `block_requested_at`,
  `block_confirmed_at`, `block_last_error_safe` e `conversations.blocked_at`:
  colunas descartadas com todo o conteúdo. Quem estava soft-deleted VOLTA a
  aparecer nas listagens como ativo, e não há como saber quem era.
- a RPC `chatpro_delete_contact` deixa de existir: qualquer código que a chame
  passa a receber erro de função inexistente.

O SCHEMA, esse, volta byte a byte: `pg_dump --schema-only --schema=public`
antes e depois do ciclo completo tem o mesmo md5 (`7639fbf23aa84832e60fb12abf05492d`).
