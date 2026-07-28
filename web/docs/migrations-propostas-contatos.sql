-- =====================================================================
-- PROPOSTA — NÃO APLICAR
-- =====================================================================
-- Bloqueio e exclusão de contatos. Racional em docs/contatos-bloqueio-exclusao.md.
--
-- Este arquivo vive em docs/ de propósito: não é lido pelo runner de migrations.
--
-- ESTADO: escrito contra o SCHEMA REAL e VALIDADO POR EXECUÇÃO em bancos
-- descartáveis — PostgreSQL 16 em contêiner e SQLite 3.53.2 reproduzindo o
-- runner real. O banco remoto NÃO foi tocado, nem para leitura.
--
-- REVALIDADO em 28/07/2026 contra origin/main @ 98a984d, já com o INSERT
-- nomeado (998a871) e o opt-out mergeados. PostgreSQL 16.14 e SQLite 3.53.2.
-- Resultado: M1 e M2 aplicam limpo, são idempotentes e revertem por completo
-- nos dois bancos. Procedimento de aplicação em docs/migrations-m1-m2-aplicacao.md.
--
-- O QUE MUDOU DESDE A ÚLTIMA VALIDAÇÃO
--   1. O PRÉ-REQUISITO DE CÓDIGO abaixo está RESOLVIDO em main. O INSERT de
--      contacts e o de opt_out_history agora nomeiam colunas, e o catch nu virou
--      tratamento de UNIQUE. Confirmado por execução: após M1 e M2, o INSERT
--      nomeado funciona; o posicional quebra com "table contacts has 13 columns
--      but 8 values were supplied". A seção segue no arquivo como registro
--      histórico e porque explica POR QUE a ordem importa.
--   2. Nada no SQL de M1 ou M2 precisou mudar.
--   3. Um achado NOVO, que M2 não trata: ver "UNICIDADE DE TELEFONE" abaixo.
--
-- ---------------------------------------------------------------------
-- UNICIDADE DE TELEFONE vs SOFT DELETE — achado de 28/07/2026
-- ---------------------------------------------------------------------
-- contacts tem UNIQUE (workspace_id, phone_number) GLOBAL, não parcial. O soft
-- delete não apaga a linha, então o telefone CONTINUA OCUPADO depois de "apagar"
-- o contato. Reproduzido nos dois bancos:
--
--   SQLite  UNIQUE constraint failed: contacts.workspaceId, contacts.phoneNumber
--   PG16    duplicate key value violates unique constraint
--           "contacts_workspace_id_phone_number_key"
--
-- Consequência de produto: recadastrar o mesmo número exige restaurar o contato
-- (p_mode='restore') ou purgar (M3). Criar um contato novo com o mesmo telefone
-- falha com 409.
--
-- ISSO NÃO É DEFEITO DE M2 — é o comportamento correto para um delete
-- reversível: liberar o telefone permitiria dois contatos com o mesmo número, e
-- o restore passaria a poder colidir. Mas é comportamento OBSERVÁVEL pelo
-- operador e precisa de decisão de produto antes de M2 chegar à UI:
--
--   (a) manter como está e a UI oferecer "restaurar contato existente" quando o
--       telefone colidir com um contato soft-deleted;  <- recomendado
--   (b) trocar por UNIQUE parcial WHERE deleted_at IS NULL, o que libera o
--       telefone mas torna o restore falível. Exigiria rebuild da tabela no
--       SQLite, que é PAI de seis outras — caro e fora do escopo de M2.
--
-- Se (a), a listagem de contatos precisa poder buscar soft-deleted por telefone
-- para oferecer a restauração. Não há mudança de schema envolvida.
--
-- O bloqueio "schema não versionado" da versão anterior foi RESOLVIDO por duas
-- fontes independentes e concordantes:
--
--   1. dump do remoto via information_schema/pg_constraint (colunas de contacts,
--      nomes e ações das 6 FKs que a referenciam, 19 RPCs chatpro_*);
--   2. supabase/migrations/20260715000000_initial_chatpro_persistence.sql e
--      20260715000100_chatpro_domain_rpcs.sql na RAIZ do repositório, que
--      versionam o DDL de CRM e as RPCs. O documento anterior olhou apenas
--      web/supabase/migrations/ e por isso concluiu "não versionado".
--      A raiz versiona 18 RPCs; a 19ª do dump, chatpro_resolve_contact_identity,
--      está em web/supabase/migrations/20260723000100_contact_identity_atomic.sql.
--
-- As duas fontes batem coluna a coluna. Todo nome de constraint abaixo é real.
--
-- ORGANIZAÇÃO — três migrations MUTUAMENTE independentes:
--
--   M1  Bloqueio ...................... não depende de M2 nem de M3.
--   M2  Soft delete + RPC ............. não depende de M1 nem de M3.
--   M3  Purga LGPD .................... requer M1 e M2. Ver "DEPENDÊNCIAS" nela.
--
-- Mas independência ENTRE MIGRATIONS não é independência de tudo: as três têm
-- um PRÉ-REQUISITO DE CÓDIGO comum no lado SQLite, descrito logo abaixo, e M3
-- tem um PRÉ-REQUISITO DE CÓDIGO próprio sem o qual ela não entrega o que
-- promete. Leia os dois antes de aplicar qualquer coisa.
-- =====================================================================


-- #####################################################################
-- #  PRÉ-REQUISITO DE CÓDIGO — OBRIGATÓRIO ANTES DE M1, M2 OU M3      #
-- #####################################################################
--
-- O repositório usa INSERT POSICIONAL, sem lista de colunas, em 14 pontos de
-- apps/api/src/persistence/sqlite-domain.repository.ts. Dois deles são fatais
-- para esta proposta:
--
--   :29  INSERT INTO contacts VALUES
--          (@id,@workspaceId,@displayName,@phoneNumber,@email,@company,
--           @createdAt,@updatedAt)                                 -- 8 valores
--   :61  INSERT INTO opt_out_history VALUES
--          (@id,@workspaceId,@contactId,@reason,@source,@occurredAt,
--           @createdAt,@updatedAt)                                 -- 8 valores
--
-- QUALQUER ADD COLUMN em contacts quebra createContact, e o rebuild de
-- opt_out_history quebra optOut. Verificado por execução sobre a baseline real:
--
--   antes de M1 ......... createContact -> OK
--   depois de M1 ........ createContact -> "table contacts has 13 columns but
--                                           8 values were supplied"
--   depois de M2 ........ createContact -> "table contacts has 14 columns but
--                                           8 values were supplied"
--   depois de M3 ........ optOut -> "table opt_out_history has 9 columns but
--                                    8 values were supplied"
--
-- PIOR QUE FALHAR: o erro é MASCARADO. A linha :29 está envolvida em
--   catch { fail(409,'CONFLICT','Phone number already exists in this workspace'); }
-- um catch nu que engole qualquer exceção. O operador vê "telefone já existe"
-- para todo contato novo, e nada no log aponta para a migration.
--
-- CORREÇÃO, antes de aplicar (é código, não migration — não está neste arquivo):
--   INSERT INTO contacts
--     (id,workspaceId,displayName,phoneNumber,email,company,createdAt,updatedAt)
--     VALUES (@id,@workspaceId,@displayName,@phoneNumber,@email,@company,
--             @createdAt,@updatedAt)
--   INSERT INTO opt_out_history
--     (id,workspaceId,contactId,reason,source,occurredAt,createdAt,updatedAt)
--     VALUES (@id,@workspaceId,@contactId,@reason,@source,@occurredAt,
--             @createdAt,@updatedAt)
-- e estreitar o catch de :29 para SQLITE_CONSTRAINT_UNIQUE, para parar de
-- converter defeito em 409.
--
-- Os outros 12 INSERTs posicionais (activities, campaign_recipients, campaigns,
-- contact_tags, lead_notes, leads, pipelines, stages, tags, workspace_settings)
-- não são tocados por esta proposta, mas têm a mesma fragilidade. Vale auditar.
--
-- O lado Supabase NÃO tem esse problema: supabase-domain.repository.ts e as RPCs
-- nomeiam as colunas.
-- =====================================================================


-- =====================================================================
-- FATOS DO SCHEMA REAL QUE GOVERNAM ESTE ARQUIVO
-- =====================================================================
--
-- public.contacts (confirmado nas duas fontes):
--   id text NOT NULL, workspace_id text NOT NULL, display_name text NOT NULL,
--   phone_number text NOT NULL, email text, company text,
--   created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
--   PRIMARY KEY (workspace_id, id), UNIQUE (workspace_id, phone_number)
--   NÃO existe blocked_at. NÃO existe deleted_at. Tudo abaixo é aditivo.
--
-- FKs que referenciam contacts, por (workspace_id, contact_id):
--   contact_tags_workspace_id_contact_id_fkey ............. CASCADE
--   contact_identifiers_workspace_id_contact_id_fkey ...... CASCADE
--   leads_workspace_id_contact_id_fkey .................... SET NULL
--   conversations_workspace_id_contact_id_fkey ............ SET NULL
--   campaign_recipients_workspace_id_contact_id_fkey ...... RESTRICT
--   opt_out_history_workspace_id_contact_id_fkey .......... RESTRICT
--
-- CONSEQUÊNCIA CENTRAL: soft delete não apaga nada, então não esbarra em
-- RESTRICT. M1 e M2 entregam a funcionalidade principal SEM tocar em constraint
-- nenhuma. Só a purga precisa mexer em opt_out_history — e por isso ela é M3.
--
-- ---------------------------------------------------------------------
-- ARMADILHA 1 — ON DELETE SET NULL em FK composta (Postgres e SQLite)
-- ---------------------------------------------------------------------
-- A forma simples "ON DELETE SET NULL" anula TODAS as colunas da chave filha.
-- Em (workspace_id, contact_id) isso tenta anular workspace_id, que é NOT NULL,
-- e o DELETE falha. O Postgres 15+ tem a forma com lista de colunas, e a
-- baseline já a usa onde importa:
--
--   leads     ... on delete set null (contact_id)   <- forma correta (Postgres)
--   campaigns ... on delete set null (template_id)  <- forma correta (Postgres)
--
-- Mas web/supabase/migrations/003_conversations.sql:15 e
-- apps/api/migrations/003_conversations.sql:15 usam a forma SIMPLES. Isso é
-- DEFEITO PREEXISTENTE, reproduzido nos dois bancos:
--
--   PG16    ERROR: 23502: null value in column "workspace_id" of relation
--           "conversations" violates not-null constraint
--           CONTEXT: UPDATE ONLY "public"."conversations"
--                    SET "workspace_id" = NULL, "contact_id" = NULL
--   SQLite  NOT NULL constraint failed: conversations.workspaceId
--           NOT NULL constraint failed: leads.workspaceId
--
-- Ou seja: apagar um contato que tenha conversa OU lead JÁ FALHA hoje, antes de
-- qualquer coisa proposta aqui. No SQLite alcança leads também, porque a forma
-- com lista de colunas não existe lá (apps/api/migrations/001_initial_persistence.sql:101).
-- Verifique o remoto com leitura pura:
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.conversations'::regclass AND contype = 'f';
--
-- REPORTE, não conserte aqui. A purga de M3 não depende disso: ela desvincula
-- conversas e leads com UPDATE explícito antes do DELETE, então a ação da FK
-- nunca dispara. Confirmado por execução.
--
-- CONFIRMADO NOVAMENTE em 28/07/2026, em PG 16.14 reconstruído a partir das
-- migrations do repositório. O texto do erro é literal:
--
--   ERROR: null value in column "workspace_id" of relation "conversations"
--          violates not-null constraint
--   CONTEXT: SQL statement "UPDATE ONLY "public"."conversations"
--            SET "workspace_id" = NULL, "contact_id" = NULL ..."
--
-- E a CONTRAPROVA, no mesmo banco, mostra as duas formas lado a lado:
--
--   conversations | ... ON DELETE SET NULL               <- defeito
--   leads         | ... ON DELETE SET NULL (contact_id)  <- forma correta
--
-- Apagar um contato que só tem LEAD funciona (o lead fica com contact_id nulo e
-- workspace_id intacto). Apagar um que tem CONVERSA falha. No SQLite falha nos
-- dois casos, porque lá a forma com lista de colunas não existe na linguagem.
--
-- M2 PRECISA TRATAR ISSO? NÃO.
--   M2 é soft delete: nunca executa DELETE, então a ação da FK nunca dispara.
--   Verificado por execução — depois do soft delete, conversations.contact_id
--   continua apontando para o contato. M2 aplica e funciona sobre o schema
--   defeituoso, sem tocá-lo.
--
--   Quem precisa tratar é M3 (purga), e ela já trata, por UPDATE explícito antes
--   do DELETE. O conserto da constraint em si é trabalho SEPARADO de M1/M2/M3:
--   exige DROP + ADD CONSTRAINT no Postgres e rebuild de conversations no
--   SQLite. Não deve entrar no caminho crítico de M1/M2.
--
-- ---------------------------------------------------------------------
-- ARMADILHA 2 — o runner do SQLite já abre transação
-- ---------------------------------------------------------------------
-- apps/api/src/persistence/database.ts:31 executa cada arquivo dentro de
-- this.sqlite.transaction(...). Portanto, DENTRO de um arquivo de migration:
--
--   BEGIN TRANSACTION / COMMIT  -> ERRO "cannot start a transaction within a
--                                  transaction"; a migration inteira falha;
--   PRAGMA foreign_keys = OFF   -> NO-OP silencioso; o SQLite ignora a mudança
--                                  quando há transação pendente (o valor
--                                  permanece 1, sem erro algum).
--
-- Ambos reproduzidos textualmente. A versão anterior desta proposta usava os
-- dois no rebuild do opt_out_history e teria falhado na aplicação. Aqui nenhuma
-- seção de MIGRATION usa PRAGMA ou BEGIN/COMMIT — só as de ROLLBACK, que são
-- executadas à mão pelo sqlite3 CLI, fora do runner.
--
-- ---------------------------------------------------------------------
-- ARMADILHA 3 — o que o SQLite realmente recusa em DROP COLUMN
-- ---------------------------------------------------------------------
-- CORRIGIDO: a versão anterior deste arquivo afirmava que "coluna com CHECK não
-- sai por DROP COLUMN" e prescrevia, por causa disso, um rebuild da tabela
-- contacts — que é PAI de seis outras. A afirmação era falsa e o rebuild,
-- desnecessário. Verificado em SQLite 3.53.2:
--
--   ADD COLUMN st TEXT ... CHECK (st IN (...))  -> DROP COLUMN st  ACEITO
--   CREATE TABLE u (a TEXT, CHECK (a <> 'x'))   -> DROP COLUMN a   RECUSADO
--       "error in table u after drop column: no such column: a"
--   CREATE INDEX ix ON v(id) WHERE b IS NULL    -> DROP COLUMN b   RECUSADO
--       "error in index ix after drop column: no such column: b"
--
-- A regra correta: o SQLite recusa DROP COLUMN quando a coluna é indexada, ou
-- citada no WHERE de um índice PARCIAL, ou citada num CHECK de TABELA. Um CHECK
-- de COLUNA, que é o que ADD COLUMN produz, não impede nada.
--
-- Consequência prática: os rollbacks de M1 e M2 no SQLite saem por ALTER TABLE
-- limpo, desde que o índice parcial seja derrubado ANTES — e é o índice, não o
-- CHECK, que exige essa ordem.
--
-- ---------------------------------------------------------------------
-- CONVENÇÃO DAS RPCs — supabase/migrations/20260715000100_chatpro_domain_rpcs.sql
-- ---------------------------------------------------------------------
--   language plpgsql security invoker set search_path = public, pg_temp
--   p_workspace_id text SEMPRE primeiro
--   perform chatpro_require_workspace(p_workspace_id) como primeira instrução
--   select ... for update antes de mutar
--   revoke all ... from public;  grant execute ... to service_role;
--   NUNCA grant a anon/authenticated/PUBLIC
--   errcodes: 22023 argumento inválido (independente de estado)
--             P0002 não encontrado | P0001 regra de negócio (depende de estado)
--
-- É esse arquivo que define o molde — 16 ocorrências de "security invoker",
-- nenhuma de "security definer". As 4 RPCs de kanban/routing/identidade
-- (chatpro_kanban_move, chatpro_distribute_conversation,
-- chatpro_claim_routing_jobs, chatpro_resolve_contact_identity) são
-- SECURITY DEFINER e NÃO são o modelo a herdar aqui.
--
-- RLS: as tabelas de CRM têm ENABLE ROW LEVEL SECURITY e NENHUMA policy — não
-- existe um único CREATE POLICY no repositório. O acesso é exclusivamente por
-- service_role, que ignora RLS. As tabelas novas espelham essa postura.
--
-- ---------------------------------------------------------------------
-- ONDE ESTES ARQUIVOS VÃO MORAR — atenção aos dois diretórios
-- ---------------------------------------------------------------------
-- public.contacts é criada em supabase/migrations/ (raiz) e public.conversations
-- em web/supabase/migrations/. M1 altera AS DUAS. Num banco já migrado — o caso
-- do remoto — isso é irrelevante. Mas numa base reconstruída do zero, nenhum dos
-- dois diretórios sozinho reproduz o estado, e M2/M3 ainda dependem de
-- chatpro_require_workspace e do seu grant, que só existem na raiz.
-- Enquanto os diretórios não forem reconciliados, aplique no remoto (que tem o
-- estado completo) e trate reconstrução do zero como cenário não suportado.
-- =====================================================================




-- #####################################################################
-- #                                                                   #
-- #  M1 — BLOQUEIO DE CONTATO                                         #
-- #                                                                   #
-- #####################################################################
--
-- HABILITA
--   As duas guardas locais bidirecionais: recusar envio para contato bloqueado
--   e manter fora da Inbox a conversa de contato bloqueado. Registra a intenção
--   (blockState) separada do efeito confirmado na WAHA (blockPropagation), para
--   a UI nunca escrever "Bloqueado" sem propagação bem-sucedida. Auditoria
--   append-only de quem bloqueou, em qual sessão e com qual desfecho.
--
-- REVERSÍVEL
--   Sim, nos dois bancos, por ALTER TABLE/DROP, desde que os índices parciais
--   saiam antes das colunas. Colunas aditivas, tabela nova, sem alteração de
--   constraint existente e sem migração de dados. Nenhum dado preexistente é
--   modificado.
--
-- SEM AS OUTRAS
--   Não depende de M2 nem de M3. Aplicada sozinha, entrega o bloqueio inteiro.
--   É a migration que carrega a funcionalidade principal e por isso foi mantida
--   livre de qualquer mudança de constraint.
--
--   MAS depende do PRÉ-REQUISITO DE CÓDIGO no topo deste arquivo: o ADD COLUMN
--   em contacts quebra createContact no SQLite enquanto o INSERT posicional de
--   sqlite-domain.repository.ts:29 não for corrigido.
--
--   Quem depende de M1: a purga de M3 zera conversations.blocked_at e apaga
--   contact_block_events — coluna e tabela criadas aqui.


-- ---------------------------------------------------------------------
-- M1 / SQLite   (destino: apps/api/migrations/021_contact_block.sql)
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
-- M1 / Supabase (destino: web/supabase/migrations/20260727000100_contact_block.sql)
-- ---------------------------------------------------------------------

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


-- ---------------------------------------------------------------------
-- M1 / ROLLBACK
-- ---------------------------------------------------------------------

-- ........................... Supabase ................................
-- TRANSAÇÃO EXPLÍCITA, aqui e nos outros dois rollbacks: colado em psql com
-- autocommit, um bloco solto executa os comandos SEGUINTES a um que falhou e
-- deixa o banco meio revertido. Ver a nota no rollback de M3, onde isso é
-- destrutivo. Rodar com `psql -v ON_ERROR_STOP=1` não dispensa o envelope.
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

-- ............................ SQLite .................................
-- À mão no sqlite3 CLI. Sem rebuild: os índices saem primeiro, e aí as colunas
-- saem por ALTER TABLE (ver Armadilha 3 — o CHECK de coluna não impede).
-- A ORDEM IMPORTA: idx_contacts_block_state cita blockState no seu WHERE, e é
-- por isso, e só por isso, que ele precisa cair antes.
DROP INDEX IF EXISTS idx_contact_block_events_contact;
DROP TABLE IF EXISTS contact_block_events;
DROP INDEX IF EXISTS idx_conversations_blocked;
DROP INDEX IF EXISTS idx_contacts_block_state;

ALTER TABLE conversations DROP COLUMN blockedAt;
ALTER TABLE contacts DROP COLUMN blockLastErrorSafe;
ALTER TABLE contacts DROP COLUMN blockConfirmedAt;
ALTER TABLE contacts DROP COLUMN blockRequestedAt;
ALTER TABLE contacts DROP COLUMN blockPropagation;
ALTER TABLE contacts DROP COLUMN blockState;

-- Se o INSERT posicional de sqlite-domain.repository.ts:29 tiver sido corrigido
-- para a forma nomeada (pré-requisito de código), ele continua funcionando
-- depois do rollback — a forma nomeada é indiferente ao número de colunas.




-- #####################################################################
-- #                                                                   #
-- #  M2 — SOFT DELETE + RPC TRANSACIONAL                              #
-- #                                                                   #
-- #####################################################################
--
-- HABILITA
--   Exclusão reversível de contato e sua restauração, por uma RPC transacional
--   que substitui o DELETE cru de hoje (sqlite-domain.repository.ts:31 e
--   supabase-domain.repository.ts:72). Log de exclusão que sobrevive ao contato.
--
-- REVERSÍVEL
--   Sim, nos dois bancos, e em dois níveis: o schema sai por DROP COLUMN/DROP
--   TABLE, e o próprio soft delete é revertido por p_mode = 'restore'. Nenhum
--   dado é destruído em momento algum.
--
-- SEM AS OUTRAS
--   Não depende de M1 nem de M3. Aplicada sozinha, entrega soft delete e restore
--   completos. p_mode = 'purge' é REJEITADO com mensagem explícita até M3 rodar —
--   falha alto e cedo em vez de corromper em silêncio.
--
--   MAS depende do PRÉ-REQUISITO DE CÓDIGO no topo deste arquivo, pelo mesmo
--   motivo de M1: acrescenta coluna a contacts.
--
--   Quem depende de M2: M3 substitui o corpo desta função e usa
--   contact_deletion_log. Sem M2, M3 cria uma função que falha em runtime.
--
-- NUNCA REAPLICAR M2 DEPOIS DE M3.
--   O CREATE OR REPLACE substituiria o corpo COM purga pelo corpo SEM purga, sem
--   erro e sem aviso, e o modo purge sumiria. Verificado: a reaplicação retorna
--   exit 0 e depois `purge` passa a responder "invalid delete mode 'purge';
--   expected soft or restore". Se o runner puder reexecutar arquivos, registre as
--   migrations aplicadas.
--
-- ---------------------------------------------------------------------
-- DECISÃO — o soft delete NÃO desvincula conversas. Evidência, não gosto.
-- ---------------------------------------------------------------------
-- 1. Seria INÓCUO. waha-webhook.service.ts:117 (Supabase) e :82 (SQLite) gravam
--    contact_id: existing?.contact_id ?? contact?.id ?? null. O vínculo só é
--    escrito quando está nulo. Como o soft delete PRESERVA contact_identifiers,
--    a primeira mensagem seguinte do mesmo número resolve para o contato apagado
--    e regrava o vínculo. Desvincular seria desfeito pelo próximo inbound.
--
-- 2. Seria IRREVERSÍVEL. Zerar contact_id destrói a informação de quais conversas
--    pertenciam ao contato. O restore não teria como reconstruir o vínculo — o
--    soft delete deixaria de ser reversível, que é a sua única razão de existir.
--
-- Além disso a FK conversations -> contacts é SET NULL e o soft delete não
-- executa DELETE nenhum, então a ação da FK nunca dispara. Preservar o vínculo é
-- o comportamento que o schema real já produz sozinho.
--
-- Consequência de produto: a conversa CONTINUA na Inbox com a identidade do
-- WhatsApp. "Apagar o contato" no CRM não apaga a conversa.


-- ---------------------------------------------------------------------
-- M2 / SQLite   (destino: apps/api/migrations/022_contact_soft_delete.sql)
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
-- M2 / Supabase (destino: web/supabase/migrations/20260727000200_contact_soft_delete.sql)
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
-- M2 / ROLLBACK
-- ---------------------------------------------------------------------

-- ........................... Supabase ................................
BEGIN;
DROP FUNCTION IF EXISTS public.chatpro_delete_contact(text, text, text, text, text);
DROP INDEX IF EXISTS public.idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS public.contact_deletion_log;
DROP INDEX IF EXISTS public.idx_contacts_workspace_created_active;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS deleted_at;
COMMIT;
-- Contatos com deleted_at preenchido voltam a aparecer nas listagens. É o
-- comportamento correto: o rollback desfaz o recurso, não apaga ninguém.

-- ............................ SQLite .................................
-- O índice cita deletedAt no WHERE e por isso precisa sair antes da coluna.
DROP INDEX IF EXISTS idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS contact_deletion_log;
DROP INDEX IF EXISTS idx_contacts_workspace_created_active;
ALTER TABLE contacts DROP COLUMN deletedAt;




-- #####################################################################
-- #                                                                   #
-- #  M3 — PURGA LGPD                                                  #
-- #                                                                   #
-- #####################################################################
--
-- HABILITA
--   Exclusão real e irreversível do CADASTRO do contato, preservando a linha de
--   opt-out sem o telefone. Ver, logo abaixo, os dois limites honestos do que
--   isso entrega — o escopo da purga e o caminho de leitura que ainda falta.
--
-- REVERSÍVEL
--   O SCHEMA sim; os DADOS não. Enquanto nenhuma purga tiver rodado, o rollback
--   restaura NOT NULL e derruba identifier_hash. Depois da primeira purga,
--   restaurar NOT NULL FALHA — há linhas com contact_id nulo cujo contato não
--   existe mais. A partir daí a única volta é restore de backup.
--
-- DEPENDÊNCIAS — a única migration que tem alguma
--   Requer M1: a purga zera conversations.blocked_at (coluna de M1) E apaga
--              contact_block_events (tabela de M1). São dois objetos, nos passos
--              3 e 7. Sem M1, ambos falham com 42703 / relação inexistente.
--   Requer M2: substitui o corpo de chatpro_delete_contact e grava em
--              contact_deletion_log.
--
--   Aplique na ordem M1, M2, M3. Aplicar M3 isolada NÃO gera erro de DDL — o
--   validador do plpgsql não resolve nomes de tabela na criação, então a
--   migration aplica e a função só quebra na primeira chamada, com 42703.
--   Verificado. É o modo de falha mais traiçoeiro das três.


-- #####################################################################
-- #  PRÉ-REQUISITO DE CÓDIGO DE M3 — SEM ELE, A PURGA REVOGA O OPT-OUT #
-- #####################################################################
--
-- identifier_hash, hoje, seria uma coluna WRITE-ONLY. Um grep por
-- "identifier_hash|identifierHash" em todo o repositório (.ts/.tsx/.sql), fora
-- este arquivo de proposta, retorna ZERO ocorrências. Não existe leitor.
--
-- E os três consumidores de opt-out casam EXCLUSIVAMENTE por contact_id:
--   sqlite-domain.repository.ts:70   prepareCampaign
--     EXISTS (SELECT 1 FROM opt_out_history o
--              WHERE o.workspaceId=r.workspaceId AND o.contactId=r.contactId)
--   supabase/migrations/20260715000100_chatpro_domain_rpcs.sql:102
--     chatpro_prepare_campaign, mesma forma
--   sqlite-domain.repository.ts:27   filtro optOut da listagem
--
-- Logo, depois do passo 1 da purga (contact_id = null) a linha deixa de casar
-- com QUALQUER predicado existente, e uma reimportação do mesmo número gera um
-- contact_id novo que nada liga ao hash. Na prática, purgar REVOGA o opt-out —
-- que é exatamente o dano que esta migration existe para impedir, e o mesmo
-- defeito que motivou recusar o ON DELETE SET NULL mais abaixo.
--
-- M3 NÃO DEVE SER APLICADA antes de as duas leituras existirem:
--
--   (a) prepareCampaign e chatpro_prepare_campaign passam a excluir TAMBÉM por
--       hash: EXISTS (SELECT 1 FROM opt_out_history o
--                      WHERE o.workspace_id = r.workspace_id
--                        AND o.identifier_hash = <hash do telefone do destinatário>)
--   (b) createContact / chatpro_create_contact e o resolvedor de identidade
--       consultam opt_out_history por identifier_hash ao materializar um contato
--       novo, e propagam o opt-out encontrado para o contact_id novo.
--
-- Sem (a) e (b), a coluna é custo sem efeito e a alegação "o opt-out sobrevive"
-- é falsa. É código, não migration, e não está neste arquivo.
--
-- ---------------------------------------------------------------------
-- ESCOPO DA PURGA — o que ela NÃO apaga
-- ---------------------------------------------------------------------
-- A purga desvincula e apaga o CADASTRO de CRM. O telefone PERMANECE em claro
-- em pelo menos quatro lugares que a RPC não toca:
--
--   whatsapp_identities.phone .............. 005_whatsapp_group_persistence.sql:6
--   pending_contact_identities.identifier .. 020_contact_identity_aliases.sql:17
--   conversations.chatId ................... formato 55...@c.us
--   whatsapp_messages.chatId ............... idem
--
-- Verificado após a purga completa: conversations.chatId permanece
-- "5511999998888@c.us" com contactId nulo.
--
-- CONSEQUÊNCIA PARA A ALEGAÇÃO DE LGPD: o pepper protege contra quem obtenha
-- APENAS a tabela opt_out_history, não contra um dump completo do banco — onde o
-- telefone está em claro ao lado. Portanto o que M3 entrega hoje é
-- DESVINCULAÇÃO DE CADASTRO, não "direito à eliminação". Para alcançar a
-- eliminação de fato é preciso estender a purga a pending_contact_identities e
-- whatsapp_identities e decidir o que fazer com os chatId — outro escopo,
-- que precisa de decisão jurídica antes de desenho.
--
-- ---------------------------------------------------------------------
-- A FK RESTRICT: o que É e o que NÃO É obrigatório mudar
-- ---------------------------------------------------------------------
-- Só uma coisa é obrigatória: soltar o NOT NULL de opt_out_history.contact_id.
--
-- Trocar a AÇÃO da FK de RESTRICT para SET NULL NÃO é necessário, e recomendo
-- NÃO trocar. A purga desvincula as linhas com UPDATE explícito ANTES do DELETE
-- do contato; quando o DELETE roda, nenhuma linha de opt_out_history referencia
-- o contato e o RESTRICT nunca dispara. Mantê-lo é ganho de segurança:
--
--   com RESTRICT ... qualquer caminho que apague um contato SEM passar pela RPC
--                    falha alto. O opt-out nunca é órfão por acidente. E esses
--                    caminhos existem: sqlite-domain.repository.ts:31 e
--                    supabase-domain.repository.ts:72 ainda fazem DELETE cru.
--   com SET NULL ... esse mesmo caminho SUCEDE em silêncio e desvincula a linha
--                    SEM gravar identifier_hash. O opt-out sobrevive como lixo.
--
-- SET NULL, aqui, derrota o próprio desenho. O bloco que faz a troca está abaixo
-- comentado, porque foi pedido — não porque seja recomendado.
--
-- ---------------------------------------------------------------------
-- HASH DO TELEFONE — a estratégia e por que ela, e não SHA-256 no banco
-- ---------------------------------------------------------------------
-- O hash é calculado NA APLICAÇÃO e chega como parâmetro p_identifier_hash.
-- Nem o Postgres nem o SQLite o calculam. Quatro razões, em ordem de peso:
--
-- 1. SHA-256 puro de telefone NÃO anonimiza. O espaço de busca de um celular
--    brasileiro tem ordem de 10^9 a 10^11 preimagens; uma GPU comum reverte o
--    conjunto inteiro em minutos. Sob a LGPD, dado pseudonimizado reversível
--    continua sendo dado pessoal. Guardar SHA-256(telefone) e chamar de "sem PII"
--    seria falso — e falso justamente no artefato criado para provar conformidade.
--    A aplicação usa HMAC-SHA256 com um pepper de ambiente. O pepper NUNCA entra
--    no banco, em migration, em log ou neste arquivo. Um dump da tabela de
--    opt-out, sozinho, deixa de ser suficiente para reverter o hash.
--    (Ressalva honesta: um dump COMPLETO ainda tem o telefone em claro em outras
--    tabelas — ver "ESCOPO DA PURGA" acima.)
--
-- 2. Paridade SQLite/Supabase, que é a regra 1 do CLAUDE.md. O SQLite não tem
--    SHA-256 nativo. Calcular no Postgres obrigaria uma segunda implementação em
--    Node, e as duas teriam de produzir byte a byte o mesmo resultado para
--    sempre. Uma implementação só, em TypeScript, elimina a classe inteira de
--    divergência.
--
-- 3. Some a dependência de pgcrypto. Sem digest() não há extensão a habilitar.
--
-- 4. O backfill histórico já teria de ser de aplicação de qualquer forma — é ela
--    que tem o pepper. Uma rotina serve aos dois bancos.
--
-- ENTRADA CANÔNICA DO HASH, que precisa ser fixada de uma vez:
--   contacts.phone_number, exatamente como está armazenado. Já é normalizado —
--   normalizedPhoneNumberSchema em packages/contracts/src/index.ts:49 exige
--   /^\d{8,15}$/, e normalizedPhone() em contact-identity-resolver.service.ts:14
--   produz esse formato. Só dígitos, sem '+', sem sufixo @c.us.
--   hash = hex(HMAC-SHA256(key = OPT_OUT_HASH_PEPPER, message = phone_number))
--   Mudar pepper ou normalização invalida todo hash já gravado. Versione o
--   prefixo (ex.: "v1:") se algum dia precisar rodar os dois em paralelo.
--
-- CONTRATO: packages/contracts/src/index.ts:52 precisa acompanhar —
--   optOutHistorySchema tem hoje contactId: z.string().uuid() (não anulável) e
--   não conhece identifierHash. Depois de M3 o tipo passa a mentir sobre o
--   schema. Ajustar para contactId: z.string().uuid().nullable() e acrescentar
--   identifierHash: z.string().nullable().optional().


-- ---------------------------------------------------------------------
-- M3 / SQLite   (destino: apps/api/migrations/023_contact_purge_lgpd.sql)
-- ---------------------------------------------------------------------
--
-- O SQLite não altera coluna nem FK: é rebuild de tabela. opt_out_history é
-- FILHA de contacts e nenhuma tabela a referencia, então o rebuild não órfã
-- ninguém e dispensa mexer em foreign_keys — o que é essencial, porque dentro do
-- runner o PRAGMA seria no-op e o BEGIN daria erro (Armadilha 2).
--
-- SEM PRAGMA E SEM BEGIN/COMMIT AQUI. A transação é a do runner.
-- As linhas copiadas já satisfazem a FK, então a checagem imediata passa.
-- Verificado: aplica limpo, PRAGMA foreign_key_check volta vazio e
-- PRAGMA integrity_check volta ok.
--
-- NUNCA REAPLICAR ESTE BLOCO. Ao contrário de M1 e M2, que falham alto na
-- segunda vez ("duplicate column name"), M3 SUCEDE e destrói dados: o
-- INSERT ... SELECT abaixo grava NULL em identifierHash, e como o DROP TABLE
-- leva junto os índices, nada colide. Verificado — reaplicar zera todo o
-- backfill de hash com exit 0 e sem um único aviso.
-- O runner automático está protegido (database.ts:26-31 registra em
-- schema_migrations e nunca reexecuta um arquivo aplicado); o risco é execução
-- manual do bloco ou renomeação do arquivo de migration.

CREATE TABLE opt_out_history_new (
  id TEXT NOT NULL,
  workspaceId TEXT NOT NULL,
  contactId TEXT,                 -- passa a aceitar NULL: a única mudança exigida
  identifierHash TEXT,            -- HMAC-SHA256 hex do telefone, vindo da aplicação
  reason TEXT,
  source TEXT NOT NULL,
  occurredAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (workspaceId, id),
  -- RESTRICT MANTIDO de propósito. Ver "A FK RESTRICT" acima.
  FOREIGN KEY (workspaceId, contactId) REFERENCES contacts(workspaceId, id) ON DELETE RESTRICT
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
  ON opt_out_history(workspaceId, identifierHash) WHERE identifierHash IS NOT NULL;

-- identifierHash nasce NULL em toda linha histórica. Até o backfill de aplicação
-- rodar, purgar um contato cujo opt-out não tenha hash é RECUSADO pela RPC — o
-- comportamento correto, e o motivo de a recusa existir.


-- ---------------------------------------------------------------------
-- M3 / Supabase (destino: web/supabase/migrations/20260727000300_contact_purge_lgpd.sql)
-- ---------------------------------------------------------------------

ALTER TABLE public.opt_out_history ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE public.opt_out_history ADD COLUMN IF NOT EXISTS identifier_hash text;
CREATE INDEX IF NOT EXISTS idx_opt_out_history_identifier
  ON public.opt_out_history(workspace_id, identifier_hash) WHERE identifier_hash IS NOT NULL;

-- OPCIONAL E NÃO RECOMENDADO — troca da ação da FK para SET NULL.
-- Nome real confirmado no dump: opt_out_history_workspace_id_contact_id_fkey.
-- Reusa o mesmo nome, para o rollback ser simétrico. Leia "A FK RESTRICT" antes
-- de descomentar: isto REMOVE a garantia de que nenhum opt-out é desvinculado
-- sem hash.
--
-- ALTER TABLE public.opt_out_history
--   DROP CONSTRAINT opt_out_history_workspace_id_contact_id_fkey;
-- ALTER TABLE public.opt_out_history
--   ADD CONSTRAINT opt_out_history_workspace_id_contact_id_fkey
--   FOREIGN KEY (workspace_id, contact_id)
--   REFERENCES public.contacts(workspace_id, id)
--   ON DELETE SET NULL (contact_id);   -- lista de colunas obrigatória: Armadilha 1

-- .....................................................................
-- chatpro_delete_contact — MESMA assinatura de M2, corpo substituído.
-- Acrescenta 'purge'. Os GRANTs de M2 sobrevivem ao CREATE OR REPLACE; são
-- repetidos ao final só para M3 ser autossuficiente.
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
  v_n integer;
  v_hash text;
begin
  perform chatpro_require_workspace(p_workspace_id);

  if p_mode is null or p_mode not in ('soft', 'restore', 'purge') then
    raise exception using errcode = '22023',
      message = format('invalid delete mode %L; expected soft, restore or purge', p_mode);
  end if;

  select * into v_row from contacts
   where workspace_id = p_workspace_id and id = p_contact_id
     for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'contact not found in workspace';
  end if;

  if p_mode <> 'purge' then
    -- ---------------- soft / restore: idêntico a M2 ----------------
    if p_mode = 'soft' then
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

    -- identifier_hash NULL de propósito fora da purga: o telefone permanece.
    insert into contact_deletion_log
      (id, workspace_id, contact_id, mode, actor_user_id, identifier_hash,
       affected_json, occurred_at, created_at)
    values (gen_random_uuid()::text, p_workspace_id, p_contact_id, p_mode,
            p_actor_user_id, null, v_affected, now(), now());

    return jsonb_build_object('mode', p_mode, 'contactId', p_contact_id,
                              'alreadyApplied', false, 'affected', v_affected);
  end if;

  -- --------------------------- purge -----------------------------
  -- Irreversível. Ordem escolhida para nunca depender de ação de FK: cada
  -- dependente é resolvido por comando explícito ANTES do DELETE do contato.

  -- Recusa antes de destruir qualquer coisa. O predicado conta só as linhas que
  -- FICARIAM sem hash: exigir o parâmetro quando todas já têm hash de backfill
  -- seria pedir um valor que o coalesce abaixo descartaria.
  select count(*) into v_n from opt_out_history
   where workspace_id = p_workspace_id and contact_id = p_contact_id
     and (identifier_hash is null or btrim(identifier_hash) = '');
  if v_n > 0 and (p_identifier_hash is null or btrim(p_identifier_hash) = '') then
    -- P0001, não 22023: a recusa depende do ESTADO do banco, não do argumento.
    raise exception using errcode = 'P0001',
      message = 'identifier hash is required to purge a contact with opt-out history';
  end if;

  -- Hash que EFETIVAMENTE vai sustentar o opt-out: o de backfill, se houver, ou
  -- o do parâmetro. Calculado antes do UPDATE para poder ir também ao log — sem
  -- isso, o caminho "já tinha hash, chamou sem parâmetro" gravaria NULL na
  -- auditoria e ela mentiria sobre o que preservou.
  --
  -- PRECEDÊNCIA, explícita para não surpreender: O BACKFILL VENCE O PARÂMETRO.
  -- Se o contato tem uma linha com hash e outra sem, a guarda abaixo EXIGE
  -- p_identifier_hash (por causa da linha sem) e este select em seguida o
  -- DESCARTA, aplicando o hash de backfill às duas. E quando as linhas trazem
  -- hashes divergentes, max() escolhe um por ordem lexicográfica, não por
  -- recência. É aceitável enquanto o pepper for único; se ele for versionado
  -- ("v1:", "v2:"), reveja esta escolha antes de rodar a primeira purga, porque
  -- preservar o hash velho torna a linha inalcançável pelo leitor novo.
  select nullif(btrim(max(identifier_hash)), '') into v_hash
    from opt_out_history
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  v_hash := coalesce(v_hash, nullif(btrim(p_identifier_hash), ''));

  -- 1. o opt-out SOBREVIVE, sem o telefone. É o núcleo do desenho — e depende do
  --    caminho de leitura descrito no pré-requisito de código de M3.
  --    nullif(btrim(...)) e não coalesce puro: a guarda acima trata hash EM
  --    BRANCO como ausente, e o UPDATE precisa tratar igual. Com coalesce simples,
  --    uma linha com identifier_hash = '   ' sobreviveria à purga preservando o
  --    branco e descartando o hash recebido — desvinculada e inalcançável, que é
  --    exatamente o dano que a guarda existe para impedir.
  update opt_out_history
     set contact_id = null,
         identifier_hash = coalesce(nullif(btrim(identifier_hash), ''), v_hash),
         updated_at = now()
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  get diagnostics v_n = row_count;
  v_affected := v_affected || jsonb_build_object('optOutRowsDetached', v_n);

  -- 2. contorna o RESTRICT de campaign_recipients sem alterar o schema.
  delete from campaign_recipients
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  get diagnostics v_n = row_count;
  v_affected := v_affected || jsonb_build_object('campaignRecipientsDeleted', v_n);

  -- 3. conversas e mensagens PERMANECEM; perdem só o vínculo e o bloqueio.
  --    blocked_at precisa zerar: sem contato não há como desbloquear depois.
  --    Coluna de M1 — é uma das duas dependências de M3 em M1.
  update conversations
     set contact_id = null, blocked_at = null, updated_at = now()
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  get diagnostics v_n = row_count;
  v_affected := v_affected || jsonb_build_object('conversationsDetached', v_n);

  -- 4. explícito apesar do CASCADE, para devolver contagem e não depender da ação.
  delete from contact_identifiers
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  get diagnostics v_n = row_count;
  v_affected := v_affected || jsonb_build_object('identifiersDeleted', v_n);

  -- 5. idem.
  delete from contact_tags
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  get diagnostics v_n = row_count;
  v_affected := v_affected || jsonb_build_object('tagLinksDeleted', v_n);

  -- 6. explícito em vez de confiar na forma da FK (Armadilha 1).
  update leads set contact_id = null, updated_at = now()
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  get diagnostics v_n = row_count;
  v_affected := v_affected || jsonb_build_object('leadsDetached', v_n);

  -- 7. explícito apesar do CASCADE, para devolver contagem.
  --    Tabela de M1 — a segunda dependência de M3 em M1.
  delete from contact_block_events
   where workspace_id = p_workspace_id and contact_id = p_contact_id;
  get diagnostics v_n = row_count;
  v_affected := v_affected || jsonb_build_object('blockEventsDeleted', v_n);

  -- 8. contabiliza o próprio contato ANTES de gravar o log, para que a linha de
  --    auditoria reproduza exatamente o JSON devolvido ao chamador. A contagem é
  --    determinística: o select ... for update já garantiu que a linha existe.
  v_affected := v_affected || jsonb_build_object('contactDeleted', 1);

  -- 9. log ANTES do DELETE. Tabela sem FK: sobrevive ao contato.
  insert into contact_deletion_log
    (id, workspace_id, contact_id, mode, actor_user_id, identifier_hash,
     affected_json, occurred_at, created_at)
  values (gen_random_uuid()::text, p_workspace_id, p_contact_id, 'purge',
          p_actor_user_id, v_hash, v_affected, now(), now());

  -- 10. nenhum dependente resta; nenhuma ação de FK dispara.
  delete from contacts
   where workspace_id = p_workspace_id and id = p_contact_id;

  return jsonb_build_object('mode', 'purge', 'contactId', p_contact_id,
                            'alreadyApplied', false, 'affected', v_affected);
end $$;

revoke all on function public.chatpro_delete_contact(text, text, text, text, text) from public;
grant execute on function public.chatpro_delete_contact(text, text, text, text, text) to service_role;


-- ---------------------------------------------------------------------
-- M3 / ROLLBACK
-- ---------------------------------------------------------------------
-- LIMITE DE REVERSIBILIDADE: desfaz o SCHEMA, não os DADOS. Se alguma purga já
-- rodou, os contatos não voltam e as linhas de opt_out_history com contact_id
-- nulo não podem ser religadas. Nesse caso a via é restore de backup.
--
-- E a trava é mais estreita do que parece: ela dispara por CONTACT_ID NULO, não
-- por "houve purga". Uma purga de contato SEM opt-out não deixa nenhum nulo, e o
-- rollback então commita normalmente e derruba identifier_hash — levando junto os
-- hashes de backfill de contatos que nunca foram purgados. Verificado.
-- Essa perda é RECUPERÁVEL: telefone e contato continuam em contacts, então
-- basta reexecutar a rotina de backfill da aplicação. Se preferir trava dura,
-- prefixe o bloco, DENTRO do BEGIN, com:
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM contact_deletion_log WHERE mode = 'purge') THEN
--       RAISE EXCEPTION 'purge already ran; rollback would drop backfilled hashes';
--     END IF;
--   END $$;

-- ........................... Supabase ................................
-- Devolve a função ao corpo de M2 (sem purge). Se M2 também for revertida,
-- use o DROP FUNCTION do rollback de M2 em vez disto.
-- >>> reaplique o bloco "chatpro_delete_contact" da seção M2 / Supabase <<<

-- ORDEM CRÍTICA + TRANSAÇÃO — as duas coisas, e nenhuma delas basta sozinha.
--
-- O SET NOT NULL vem PRIMEIRO porque ELE É A TRAVA: aborta com 23502 se alguma
-- purga já deixou contact_id nulo. Uma versão anterior deste arquivo derrubava
-- identifier_hash ANTES da trava e produzia o pior desfecho possível — o
-- DROP COLUMN commitava, a trava falhava depois, e a linha de opt-out ficava
-- órfã E sem hash, o estado exato que M3 existe para impedir.
--
-- Mas reordenar não bastou. Reproduzido em PG16: colado em psql com autocommit
-- e SEM ON_ERROR_STOP — que é como um rollback manual normalmente é colado —,
-- o SET NOT NULL falha com
--   ERROR: 23502: column "contact_id" of relation "opt_out_history"
--          contains null values
-- e os DOIS comandos seguintes executam assim mesmo, destruindo identifier_hash.
-- Com BEGIN/COMMIT o erro aborta a transação inteira e nada se perde:
--   BEGIN / ERROR 23502 / current transaction is aborted x2 / ROLLBACK
-- e os hashes permanecem intactos. Verificado nos dois modos.
BEGIN;
ALTER TABLE public.opt_out_history ALTER COLUMN contact_id SET NOT NULL;
DROP INDEX IF EXISTS public.idx_opt_out_history_identifier;
ALTER TABLE public.opt_out_history DROP COLUMN IF EXISTS identifier_hash;
COMMIT;

-- Se o bloco OPCIONAL de SET NULL tiver sido aplicado, desfaça também:
-- ALTER TABLE public.opt_out_history
--   DROP CONSTRAINT opt_out_history_workspace_id_contact_id_fkey;
-- ALTER TABLE public.opt_out_history
--   ADD CONSTRAINT opt_out_history_workspace_id_contact_id_fkey
--   FOREIGN KEY (workspace_id, contact_id)
--   REFERENCES public.contacts(workspace_id, id) ON DELETE RESTRICT;

-- ............................ SQLite .................................
--
-- ATENÇÃO — ".bail on" NA PRIMEIRA LINHA NÃO É ENFEITE.
-- Uma versão anterior deste bloco dizia que a trava era "estrutural, porque o
-- INSERT ... SELECT falha antes de qualquer DROP". ERRADO: o sqlite3 CLI, por
-- padrão, IMPRIME o erro e CONTINUA. Sem .bail, num banco onde a purga já rodou,
-- o INSERT falha com
--   [SQLITE_CONSTRAINT_NOTNULL] NOT NULL constraint failed: opt_out_history_old.contactId
-- e o DROP TABLE seguinte executa assim mesmo. Reproduzido: o COMMIT confirma a
-- destruição, sobram ZERO linhas em opt_out_history, e foreign_key_check e
-- integrity_check voltam limpos — o banco fica íntegro e VAZIO, sem sinal nenhum
-- de que o histórico inteiro de opt-out se perdeu.
--
-- Duas defesas, aplicadas juntas:
--   1. .bail on (ou `sqlite3 -bail banco.db < rollback.sql`), para parar no erro;
--   2. uma CÓPIA DE SEGURANÇA feita ANTES da trava, por CREATE TABLE ... AS
--      SELECT. Assim, mesmo que o script siga adiante após o erro e derrube a
--      tabela viva, os dados continuam existindo.
--
-- POR QUE CTAS E NÃO "RENAME PARA BACKUP": uma tentativa anterior renomeava a
-- tabela original em vez de apagá-la. Parecia mais seguro e era pior — a tabela
-- renomeada LEVA JUNTO a FK composta ON DELETE RESTRICT, e passa a bloquear a
-- exclusão de qualquer contato que um dia teve opt-out, com um erro opaco:
--   DELETE FROM contacts ... -> "FOREIGN KEY constraint failed"
--                               [SQLITE_CONSTRAINT_TRIGGER]
-- O operador olha para opt_out_history, que está correta, e não encontra a
-- causa. Verificado: derrubando a tabela de backup, o mesmo DELETE passa.
-- CREATE TABLE ... AS SELECT não copia FK, NOT NULL nem PRIMARY KEY — a cópia
-- fica inerte, que é o que uma cópia de segurança precisa ser.
--
-- NÃO É IDEMPOTENTE. A segunda execução para no CREATE TABLE ... AS SELECT com
-- "table opt_out_history_purge_backup already exists" — com .bail on isso é uma
-- parada segura. Sem .bail, vira bagunça.
--
-- Rode com:  sqlite3 -bail .chatpro-data/chatpro.db < este-bloco.sql
-- A forma one-shot é a única suportada, e não é preciosismo: quando o bloco
-- aborta na trava, o `PRAGMA foreign_keys = ON` do fim NÃO é alcançado e a
-- conexão fica com as FKs desligadas. Num processo que morre em seguida isso é
-- inócuo; numa sessão interativa reaproveitada, não.

.bail on
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- 1. CÓPIA INERTE, antes de qualquer coisa destrutiva. Sem FK, sem NOT NULL.
CREATE TABLE opt_out_history_purge_backup AS SELECT * FROM opt_out_history;

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

-- 2. A TRAVA. Falha por NOT NULL se houver linha órfã de purga; com .bail on o
--    script para exatamente aqui e nada abaixo executa.
INSERT INTO opt_out_history_old
  (id, workspaceId, contactId, reason, source, occurredAt, createdAt, updatedAt)
SELECT id, workspaceId, contactId, reason, source, occurredAt, createdAt, updatedAt
  FROM opt_out_history;

-- 3. Os índices pertencem à tabela viva e colidiriam com o CREATE INDEX abaixo.
DROP INDEX IF EXISTS idx_opt_out_history_contact;
DROP INDEX IF EXISTS idx_opt_out_history_identifier;

DROP TABLE opt_out_history;
ALTER TABLE opt_out_history_old RENAME TO opt_out_history;
CREATE INDEX idx_opt_out_history_contact
  ON opt_out_history(workspaceId, contactId, occurredAt DESC);

PRAGMA foreign_key_check;   -- inspecione a saída ANTES do COMMIT
COMMIT;
PRAGMA foreign_keys = ON;

-- CONFERÊNCIA OBRIGATÓRIA antes de liberar a aplicação. Se o script tiver
-- seguido após um erro, opt_out_history pode ter terminado VAZIA — e nem
-- foreign_key_check nem integrity_check acusam isso, porque um banco vazio é
-- um banco íntegro. As contagens têm de bater:
--   SELECT (SELECT count(*) FROM opt_out_history) AS vivas,
--          (SELECT count(*) FROM opt_out_history_purge_backup) AS backup;
-- Divergiu, não libere: os predicados de opt-out do código
-- (sqlite-domain.repository.ts:27 e :70) leem a tabela VIVA, e uma campanha
-- voltaria a enviar para quem pediu para sair.
--
-- Conferido e batendo, a cópia pode sair (é inerte, não urge):
-- DROP TABLE opt_out_history_purge_backup;
