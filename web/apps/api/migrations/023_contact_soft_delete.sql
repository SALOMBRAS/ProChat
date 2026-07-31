-- M2 — extraída verbatim de web/docs/migrations-propostas-contatos.sql,
-- seção "M2 / SQLite". Racional em web/docs/contatos-bloqueio-exclusao.md,
-- procedimento em web/docs/migrations-m1-m2-aplicacao.md.

-- ---------------------------------------------------------------------

ALTER TABLE contacts ADD COLUMN deletedAt TEXT;

-- Índice PARCIAL alinhado à consulta real de listagem, que ordena por createdAt
-- e passa a filtrar deletedAt IS NULL. Um índice em (workspaceId, deletedAt) não
-- serviria: o predicado comum é IS NULL, que casa com quase toda a tabela.
-- COMPLEMENTA idx_contacts_workspace_created, não o substitui — o antigo é
-- MANTIDO de propósito, porque exportContacts (sqlite-domain.repository.ts:33) e
-- a contagem do dashboard (:75) não filtram deletedAt e não casam com o parcial.
-- Verificado com EXPLAIN QUERY PLAN:
--   SELECT c.* FROM contacts c WHERE c.workspaceId=? AND c.deletedAt IS NULL
--    ORDER BY c.createdAt DESC LIMIT 25
--   -> SEARCH c USING INDEX idx_contacts_workspace_created_active (workspaceId=?)
CREATE INDEX idx_contacts_workspace_created_active
  ON contacts(workspaceId, createdAt DESC) WHERE deletedAt IS NULL;

-- Sem FK de propósito: precisa sobreviver ao DELETE do contato no modo purge.
CREATE TABLE contact_deletion_log (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('soft', 'purge', 'restore')),
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

-- NOTA — não há RPC no SQLite.
-- O equivalente de chatpro_delete_contact é this.db.transaction(...) em
-- apps/api/src/persistence/sqlite-domain.repository.ts, com a MESMA ordem de
-- passos, os mesmos erros e o mesmo JSON de retorno da função da seção Supabase.
-- Isso é código, não migration, e não está neste arquivo.
--
-- Atenção ao implementar: o DELETE cru de hoje (linha 31) falha em SQLite para
-- qualquer contato com conversa OU com lead, porque a FK composta com SET NULL
-- tentaria anular workspaceId NOT NULL (Armadilha 1). A transação precisa
-- desvincular com UPDATE explícito antes do DELETE, como a RPC faz.


-- ---------------------------------------------------------------------
