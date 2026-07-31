-- M1 — extraída verbatim de web/docs/migrations-propostas-contatos.sql,
-- seção "M1 / SQLite". Racional em web/docs/contatos-bloqueio-exclusao.md,
-- procedimento em web/docs/migrations-m1-m2-aplicacao.md.

-- ---------------------------------------------------------------------

-- Máquina de estados: active -> blocking -> blocked | block_failed
--                     blocked -> unblocking -> active
ALTER TABLE contacts ADD COLUMN blockState TEXT NOT NULL DEFAULT 'active'
  CHECK (blockState IN ('active', 'blocking', 'blocked', 'unblocking', 'block_failed'));

-- Lado WAHA, registrado em separado da intenção.
ALTER TABLE contacts ADD COLUMN blockPropagation TEXT NOT NULL DEFAULT 'none'
  CHECK (blockPropagation IN ('none', 'pending', 'confirmed', 'failed', 'unsupported'));

ALTER TABLE contacts ADD COLUMN blockRequestedAt TEXT;
ALTER TABLE contacts ADD COLUMN blockConfirmedAt TEXT;

-- Mensagem já saneada. Nunca gravar corpo de resposta cru da WAHA aqui: pode
-- conter telefone, JID ou identificador interno, que a política de identificadores
-- proíbe expor.
ALTER TABLE contacts ADD COLUMN blockLastErrorSafe TEXT;

-- Índice PARCIAL: a esmagadora maioria dos contatos fica em 'active'. Só
-- interessa varrer os que não estão — reconciliação de sessão ao reconectar,
-- que reaplica o bloqueio antes de considerar a sessão operacional.
CREATE INDEX idx_contacts_block_state
  ON contacts(workspaceId, blockState) WHERE blockState <> 'active';

-- Conversa bloqueada. Coluna nova em vez de estender o CHECK de visibilityState:
-- alterar CHECK no SQLite exigiria rebuild, e bloqueio e quarentena de
-- integridade são ortogonais — uma conversa pode ser as duas coisas.
ALTER TABLE conversations ADD COLUMN blockedAt TEXT;
CREATE INDEX idx_conversations_blocked
  ON conversations(workspaceId, blockedAt) WHERE blockedAt IS NOT NULL;

CREATE TABLE contact_block_events (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('block', 'unblock')),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('requested', 'propagated', 'failed', 'skipped_unsupported')),
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

-- NOTA 1 — a guarda de ingestão não precisa de índice novo.
-- A consulta por chatId usa contact_identifiers, que já tem
-- UNIQUE (workspaceId, identifier), e alcança contacts pela PK. Uma leitura
-- indexada por mensagem ingerida. Sem varredura, sem N+1.
--
-- NOTA 2 — escreva o predicado de bloqueio como <>, não como IN.
-- O planner do SQLite só casa o índice parcial com a forma LITERAL do WHERE do
-- índice. Verificado com EXPLAIN QUERY PLAN em 3.53.2:
--   ... AND c.blockState IN ('blocking','blocked','block_failed')
--       -> SEARCH contacts USING INDEX idx_contacts_workspace_created  (ignora)
--   ... AND c.blockState <> 'active'
--       -> SEARCH contacts USING INDEX idx_contacts_block_state        (usa)
-- As duas formas são equivalentes, porque o CHECK tem exatamente 5 valores e
-- 'unblocking' também deve bloquear o envio (falha fechado). Use:
--
--   SELECT c.id, c.blockState
--     FROM contact_identifiers i
--     JOIN contacts c ON c.workspaceId = i.workspaceId AND c.id = i.contactId
--    WHERE i.workspaceId = ? AND i.identifier = ?
--      AND c.blockState <> 'active';


-- ---------------------------------------------------------------------
