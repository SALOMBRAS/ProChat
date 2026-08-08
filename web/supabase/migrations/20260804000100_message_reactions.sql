-- Gêmea Supabase de apps/api/migrations/025_message_reactions.sql
--
-- message_reactions: uma reação por (mensagem, autor).
-- O par (message_id, author_whatsapp_id) é único — reagir de novo substitui
-- a reação anterior, igual ao WhatsApp. Emoji vazio não chega aqui: a
-- camada de ingestão interpreta a remoção (reaction.text = "") como DELETE.

-- ---------------------------------------------------------------------------
-- RECONSTRUÍDA EM 2026-08-08 a partir de `supabase_migrations.schema_migrations`
-- (version 20260804000100, name `message_reactions`), porque o arquivo local
-- havia se perdido e o CLI recusava qualquer push com o histórico divergente.
-- O SQL abaixo é o registrado no campo `statements`, na mesma ordem. O
-- timestamp é o original, de propósito: isto restaura uma migration existente,
-- não introduz uma nova.
--
-- Duas observações levantadas na reconstrução, ambas para decisão posterior —
-- nenhuma altera o SQL:
--
--   1. `apps/api/migrations/025_message_reactions.sql`, citada no cabeçalho
--      original, NÃO existe neste repositório e nunca existiu no histórico do
--      git. O SQLite não tem `message_reactions`; o slot 025 local é
--      `025_auth.sql`. Os dois bancos divergem neste ponto.
--
--   2. Nenhum código em `apps/api/src` referencia `message_reactions`. As
--      reações que a Inbox exibe vêm de `payloadJson` da própria mensagem, via
--      `splitReactions`. A tabela existe no remoto (4 linhas) e está ociosa.
--
-- Reaplicar é inofensivo: tudo aqui é `IF NOT EXISTS` ou GRANT idempotente.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_reactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       text NOT NULL,
  waha_session       text NOT NULL,
  message_id         text NOT NULL,
  author_whatsapp_id text NOT NULL,
  author_name        text,
  emoji              text NOT NULL,
  from_me            boolean NOT NULL DEFAULT false,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL,
  UNIQUE (workspace_id, waha_session, message_id, author_whatsapp_id),
  FOREIGN KEY (workspace_id, waha_session, message_id)
    REFERENCES whatsapp_messages(workspace_id, waha_session, external_message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_lookup
  ON message_reactions(workspace_id, waha_session, message_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.message_reactions TO service_role;
