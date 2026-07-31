-- M2 — soft delete + chatpro_delete_contact
-- Extraída verbatim de web/docs/migrations-propostas-contatos.sql, seção "M2 / Supabase".
-- Procedimento: web/docs/migrations-m1-m2-aplicacao.md
-- Roteiro do SQL Editor: web/docs/migrations-m1-m2-sql-editor.md
-- Rollback: arquivo .rollback.sql ao lado.

-- ---------------------------------------------------------------------

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


-- ---------------------------------------------------------------------
