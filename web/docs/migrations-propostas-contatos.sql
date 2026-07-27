-- =====================================================================
-- PROPOSTA — NÃO APLICAR
-- =====================================================================
-- Bloqueio e exclusão de contatos. Racional em docs/contatos-bloqueio-exclusao.md.
--
-- Este arquivo vive em docs/ de propósito: não é lido pelo runner de migrations.
-- Quando aprovado, as seções viram apps/api/migrations/021_*.sql e
-- supabase/migrations/<timestamp>_*.sql.
--
-- BLOQUEIO ATIVO: o schema CRM do Supabase não está versionado (contacts,
-- contact_tags, opt_out_history e 17 RPCs chatpro_* existem só no remoto).
-- A seção 2 depende de nomes de constraint que só o dump revela. Extraia o
-- schema real antes de qualquer aplicação — ver seção 5 do documento.
--
-- O schema é o MESMO nos cenários (a) WAHA suporta bloqueio e (b) não suporta.
-- Muda apenas se a etapa de propagação roda; em (b) grava-se
-- block_propagation='unsupported'.
-- =====================================================================


-- =====================================================================
-- SEÇÃO 1 — SQLite  (destino: apps/api/migrations/021_contact_block_and_delete.sql)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.1 Estado de bloqueio no contato
-- Separa intenção (blockState) de efeito confirmado na WAHA (blockPropagation),
-- para a Inbox nunca rotular "Bloqueado" sem propagação bem-sucedida.
-- ---------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN blockState TEXT NOT NULL DEFAULT 'active'
  CHECK (blockState IN ('active','blocking','blocked','unblocking','block_failed'));
ALTER TABLE contacts ADD COLUMN blockPropagation TEXT NOT NULL DEFAULT 'none'
  CHECK (blockPropagation IN ('none','pending','confirmed','failed','unsupported'));
ALTER TABLE contacts ADD COLUMN blockRequestedAt TEXT;
ALTER TABLE contacts ADD COLUMN blockConfirmedAt TEXT;
-- Mensagem de erro já saneada: nunca gravar corpo de resposta cru da WAHA aqui.
ALTER TABLE contacts ADD COLUMN blockLastErrorSafe TEXT;

-- Soft delete (seção 3 do documento).
ALTER TABLE contacts ADD COLUMN deletedAt TEXT;

CREATE INDEX idx_contacts_block_state ON contacts(workspaceId, blockState);
CREATE INDEX idx_contacts_deleted ON contacts(workspaceId, deletedAt);

-- ---------------------------------------------------------------------
-- 1.2 Auditoria append-only de bloqueio
-- Responde "quem bloqueou, quando, em qual sessão e a propagação funcionou?".
-- ---------------------------------------------------------------------
CREATE TABLE contact_block_events (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('block','unblock')),
  outcome TEXT NOT NULL CHECK (outcome IN ('requested','propagated','failed','skipped_unsupported')),
  wahaSession TEXT,
  actorUserId TEXT,
  reasonSafe TEXT,
  occurredAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE CASCADE
);
CREATE INDEX idx_contact_block_events_contact
  ON contact_block_events(workspaceId, contactId, occurredAt DESC);

-- ---------------------------------------------------------------------
-- 1.3 Bloqueio da conversa na Inbox
-- Coluna nova em vez de estender o CHECK de visibilityState: o SQLite não
-- altera CHECK sem reconstruir a tabela (12 passos), e `conversations` acumula
-- colunas de mais de dez migrations. Bloqueio e quarentena também são
-- ortogonais — uma conversa pode ser as duas coisas.
-- ---------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN blockedAt TEXT;
CREATE INDEX idx_conversations_blocked ON conversations(workspaceId, blockedAt);

-- ---------------------------------------------------------------------
-- 1.4 Log de exclusão que SOBREVIVE ao contato
-- Sem FK de propósito: precisa existir depois do DELETE no modo purge.
-- ---------------------------------------------------------------------
CREATE TABLE contact_deletion_log (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('soft','purge','restore')),
  actorUserId TEXT,
  identifierHash TEXT,
  affectedJson TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(affectedJson) AND json_type(affectedJson) = 'object'),
  occurredAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id)
);
CREATE INDEX idx_contact_deletion_log_contact
  ON contact_deletion_log(workspaceId, contactId, occurredAt DESC);

-- ---------------------------------------------------------------------
-- 1.5 opt_out_history sobrevive à purga do contato
--
-- ÚNICA alteração estrutural obrigatória da proposta. Hoje a FK é
-- ON DELETE RESTRICT (001_initial_persistence.sql:53), então apagar um contato
-- que já deu opt-out FALHA. Cascatear seria pior: reimportar o número
-- revogaria na prática a manifestação do titular.
--
-- Solução: contactId passa a aceitar NULL, FK vira SET NULL, e identifierHash
-- (SHA-256 do telefone normalizado) mantém o opt-out consultável sem PII.
--
-- O SQLite não altera FK: exige o rebuild de 12 passos.
--
-- ATENÇÃO — identifierHash NÃO é preenchido aqui. O SQLite não tem SHA-256
-- nativo. Precisa de backfill de aplicação; enquanto não rodar, as linhas
-- históricas ficam com NULL e o opt-out purgado não é recuperável por número.
-- ---------------------------------------------------------------------
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE opt_out_history_new (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT,
  identifierHash TEXT,
  reason TEXT,
  source TEXT NOT NULL,
  occurredAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE SET NULL
);

INSERT INTO opt_out_history_new
  (id, workspaceId, contactId, identifierHash, reason, source, occurredAt, createdAt, updatedAt)
SELECT id, workspaceId, contactId, NULL, reason, source, occurredAt, createdAt, updatedAt
  FROM opt_out_history;

DROP TABLE opt_out_history;
ALTER TABLE opt_out_history_new RENAME TO opt_out_history;

CREATE INDEX idx_opt_out_history_contact
  ON opt_out_history(workspaceId, contactId, occurredAt DESC);
CREATE INDEX idx_opt_out_history_identifier
  ON opt_out_history(workspaceId, identifierHash);

COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;

-- ---------------------------------------------------------------------
-- 1.6 NOTA — não há RPC no SQLite
-- O equivalente de chatpro_delete_contact é db.transaction(...) em
-- apps/api/src/persistence/sqlite-domain.repository.ts, com a mesma ordem de
-- passos e o mesmo retorno da função Postgres da seção 2.4.
-- campaign_recipients continua RESTRICT de propósito: a transação apaga as
-- linhas antes do contato, o que contorna o RESTRICT sem mudar o schema.
-- ---------------------------------------------------------------------


-- =====================================================================
-- SEÇÃO 2 — Supabase / PostgreSQL
-- (destino: supabase/migrations/<timestamp>_contact_block_and_delete.sql)
--
-- REVISAR CONTRA O DUMP antes de aplicar. Cada ponto marcado
-- "NÃO IDENTIFICADO" depende do schema remoto.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 2.1 Estado de bloqueio
-- ---------------------------------------------------------------------
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_state text NOT NULL DEFAULT 'active';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_propagation text NOT NULL DEFAULT 'none';
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_requested_at timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_confirmed_at timestamptz;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS block_last_error_safe text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- CHECKs separados do ADD COLUMN para serem idempotentes e nomeados.
-- NÃO IDENTIFICADO: confirmar no dump que public.contacts ainda não tem
-- nenhuma coluna de bloqueio antes de rodar isto.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_block_state_check') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_block_state_check
      CHECK (block_state IN ('active','blocking','blocked','unblocking','block_failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_block_propagation_check') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_block_propagation_check
      CHECK (block_propagation IN ('none','pending','confirmed','failed','unsupported'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_block_state
  ON public.contacts(workspace_id, block_state);
CREATE INDEX IF NOT EXISTS idx_contacts_deleted
  ON public.contacts(workspace_id, deleted_at);

-- ---------------------------------------------------------------------
-- 2.2 Auditoria e log de exclusão
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_block_events (
  id text NOT NULL,
  workspace_id text NOT NULL,
  contact_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('block','unblock')),
  outcome text NOT NULL CHECK (outcome IN ('requested','propagated','failed','skipped_unsupported')),
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

CREATE TABLE IF NOT EXISTS public.contact_deletion_log (
  id text NOT NULL,
  workspace_id text NOT NULL,
  contact_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('soft','purge','restore')),
  actor_user_id text,
  identifier_hash text,
  affected jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_contact_deletion_log_contact
  ON public.contact_deletion_log(workspace_id, contact_id, occurred_at DESC);

ALTER TABLE public.contact_block_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_deletion_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.contact_block_events, public.contact_deletion_log TO service_role;
-- NÃO IDENTIFICADO: espelhar as políticas RLS das tabelas de CRM existentes.
-- O dump (item d da seção 5) informa quais são.

-- ---------------------------------------------------------------------
-- 2.3 Bloqueio da conversa + opt_out_history resiliente
-- ---------------------------------------------------------------------
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_conversations_blocked
  ON public.conversations(workspace_id, blocked_at);

ALTER TABLE public.opt_out_history ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE public.opt_out_history ADD COLUMN IF NOT EXISTS identifier_hash text;
CREATE INDEX IF NOT EXISTS idx_opt_out_history_identifier
  ON public.opt_out_history(workspace_id, identifier_hash);

-- >>> PONTO QUE EXIGE O DUMP <<<
-- Trocar a FK de opt_out_history para ON DELETE SET NULL exige o nome exato da
-- constraint atual, que só existe no banco remoto. NÃO IDENTIFICADO.
-- Descobrir com:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.opt_out_history'::regclass AND contype = 'f';
-- e só então substituir o placeholder abaixo. Rodar às cegas pode derrubar a
-- constraint errada.
--
-- ALTER TABLE public.opt_out_history DROP CONSTRAINT <NOME_REAL_DA_FK>;
-- ALTER TABLE public.opt_out_history
--   ADD CONSTRAINT opt_out_history_contact_fkey
--   FOREIGN KEY (workspace_id, contact_id)
--   REFERENCES public.contacts(workspace_id, id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- 2.4 RPC transacional de exclusão
-- Mesmo padrão de chatpro_resolve_contact_identity
-- (supabase/migrations/20260723000100_contact_identity_atomic.sql):
-- SECURITY DEFINER, search_path fixo, GRANT para service_role.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chatpro_delete_contact(
  p_workspace_id text,
  p_contact_id text,
  p_mode text DEFAULT 'soft',
  p_actor_user_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_contact public.contacts%ROWTYPE;
  v_affected jsonb := '{}'::jsonb;
  v_n integer;
BEGIN
  IF p_mode NOT IN ('soft','purge') THEN
    RAISE EXCEPTION 'invalid mode %', p_mode USING ERRCODE = '22023';
  END IF;

  -- Serializa contra resolução de identidade concorrente para o mesmo contato.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id || ':' || p_contact_id, 0));

  SELECT * INTO v_contact FROM public.contacts
   WHERE workspace_id = p_workspace_id AND id = p_contact_id;
  IF v_contact.id IS NULL THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_mode = 'soft' THEN
    -- Reversível. Aliases, conversas, mensagens, tags, opt-out e campanhas
    -- ficam intactos; o contato apenas sai das listagens.
    UPDATE public.contacts SET deleted_at = now(), updated_at = now()
     WHERE workspace_id = p_workspace_id AND id = p_contact_id;
    v_affected := jsonb_build_object('contactSoftDeleted', 1);

  ELSE
    -- purge: irreversível. Ordem escolhida para respeitar as FKs existentes.

    -- 1. opt-out SOBREVIVE sem PII — o núcleo do desenho.
    UPDATE public.opt_out_history SET contact_id = NULL, updated_at = now()
     WHERE workspace_id = p_workspace_id AND contact_id = p_contact_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_affected := v_affected || jsonb_build_object('optOutRowsDetached', v_n);

    -- 2. contorna o RESTRICT de campaign_recipients sem mudar o schema.
    DELETE FROM public.campaign_recipients
     WHERE workspace_id = p_workspace_id AND contact_id = p_contact_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_affected := v_affected || jsonb_build_object('campaignRecipientsDeleted', v_n);

    -- 3. conversas e mensagens permanecem; perdem só o vínculo e o bloqueio.
    UPDATE public.conversations
       SET contact_id = NULL, blocked_at = NULL, updated_at = now()
     WHERE workspace_id = p_workspace_id AND contact_id = p_contact_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_affected := v_affected || jsonb_build_object('conversationsDetached', v_n);

    -- 4-5. explícitos apesar do CASCADE, para devolver contagem.
    DELETE FROM public.contact_identifiers
     WHERE workspace_id = p_workspace_id AND contact_id = p_contact_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_affected := v_affected || jsonb_build_object('identifiersDeleted', v_n);

    DELETE FROM public.contact_tags
     WHERE workspace_id = p_workspace_id AND contact_id = p_contact_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_affected := v_affected || jsonb_build_object('tagLinksDeleted', v_n);

    -- 6. contact_block_events sai por cascata no passo 8.
    -- 7. log sem FK, sobrevive ao DELETE.
    INSERT INTO public.contact_deletion_log
      (id, workspace_id, contact_id, mode, actor_user_id, identifier_hash,
       affected, occurred_at, created_at)
    VALUES (gen_random_uuid()::text, p_workspace_id, p_contact_id, 'purge',
            p_actor_user_id, encode(digest(v_contact.phone_number, 'sha256'), 'hex'),
            v_affected, now(), now());

    -- 8. leads.contact_id cai para NULL pela FK existente.
    DELETE FROM public.contacts
     WHERE workspace_id = p_workspace_id AND id = p_contact_id;
    v_affected := v_affected || jsonb_build_object('contactDeleted', 1);
  END IF;

  IF p_mode = 'soft' THEN
    INSERT INTO public.contact_deletion_log
      (id, workspace_id, contact_id, mode, actor_user_id, identifier_hash,
       affected, occurred_at, created_at)
    VALUES (gen_random_uuid()::text, p_workspace_id, p_contact_id, 'soft',
            p_actor_user_id, NULL, v_affected, now(), now());
  END IF;

  RETURN jsonb_build_object('mode', p_mode, 'contactId', p_contact_id, 'affected', v_affected);
END;
$$;

GRANT EXECUTE ON FUNCTION public.chatpro_delete_contact(text,text,text,text) TO service_role;

-- NÃO IDENTIFICADO: digest() exige a extensão pgcrypto. Confirmar no dump
--   (SELECT * FROM pg_extension WHERE extname = 'pgcrypto')
-- e, se ausente, decidir entre habilitá-la ou calcular o hash na aplicação.


-- =====================================================================
-- SEÇÃO 3 — ROLLBACK
-- =====================================================================
-- LIMITE DE REVERSIBILIDADE, explícito: o rollback desfaz o SCHEMA, não os
-- DADOS. Se alguma purga já rodou, os contatos apagados não voltam e as linhas
-- de opt_out_history com contact_id NULL não podem ser religadas — restaurar o
-- NOT NULL falharia. Nesse caso, restaurar de backup em vez de reverter.
-- ---------------------------------------------------------------------

-- --------------------------- SQLite ---------------------------------
DROP INDEX IF EXISTS idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS contact_deletion_log;
DROP INDEX IF EXISTS idx_contact_block_events_contact;
DROP TABLE IF EXISTS contact_block_events;
DROP INDEX IF EXISTS idx_conversations_blocked;
DROP INDEX IF EXISTS idx_contacts_block_state;
DROP INDEX IF EXISTS idx_contacts_deleted;

-- SQLite >= 3.35 suporta DROP COLUMN. Confirme a versão do better-sqlite3 antes.
ALTER TABLE conversations DROP COLUMN blockedAt;
ALTER TABLE contacts DROP COLUMN deletedAt;
ALTER TABLE contacts DROP COLUMN blockLastErrorSafe;
ALTER TABLE contacts DROP COLUMN blockConfirmedAt;
ALTER TABLE contacts DROP COLUMN blockRequestedAt;
ALTER TABLE contacts DROP COLUMN blockPropagation;
ALTER TABLE contacts DROP COLUMN blockState;

-- Restaura opt_out_history ao formato original (contactId NOT NULL, FK RESTRICT).
-- ABORTA se alguma purga já tiver deixado contactId NULL.
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

CREATE TABLE opt_out_history_old (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  reason TEXT,
  source TEXT NOT NULL,
  occurredAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE RESTRICT
);

INSERT INTO opt_out_history_old
  (id, workspaceId, contactId, reason, source, occurredAt, createdAt, updatedAt)
SELECT id, workspaceId, contactId, reason, source, occurredAt, createdAt, updatedAt
  FROM opt_out_history;   -- falha por NOT NULL se houver linha órfã de purga

DROP TABLE opt_out_history;
ALTER TABLE opt_out_history_old RENAME TO opt_out_history;
CREATE INDEX idx_opt_out_history_contact
  ON opt_out_history(workspaceId, contactId, occurredAt DESC);

COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;

-- -------------------------- Supabase --------------------------------
DROP FUNCTION IF EXISTS public.chatpro_delete_contact(text,text,text,text);

DROP INDEX IF EXISTS public.idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS public.contact_deletion_log;
DROP INDEX IF EXISTS public.idx_contact_block_events_contact;
DROP TABLE IF EXISTS public.contact_block_events;

DROP INDEX IF EXISTS public.idx_conversations_blocked;
ALTER TABLE public.conversations DROP COLUMN IF EXISTS blocked_at;

DROP INDEX IF EXISTS public.idx_opt_out_history_identifier;
ALTER TABLE public.opt_out_history DROP COLUMN IF EXISTS identifier_hash;

-- Só executar se NENHUMA purga rodou; caso contrário levanta erro de NOT NULL.
-- ALTER TABLE public.opt_out_history ALTER COLUMN contact_id SET NOT NULL;
-- ALTER TABLE public.opt_out_history DROP CONSTRAINT opt_out_history_contact_fkey;
-- ALTER TABLE public.opt_out_history
--   ADD CONSTRAINT <NOME_ORIGINAL_DA_FK>
--   FOREIGN KEY (workspace_id, contact_id)
--   REFERENCES public.contacts(workspace_id, id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.idx_contacts_deleted;
DROP INDEX IF EXISTS public.idx_contacts_block_state;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_propagation_check;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_state_check;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_last_error_safe;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_confirmed_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_requested_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_propagation;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_state;
