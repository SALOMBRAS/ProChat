-- Renomeada de 20260806000100 para 20260806000200 em 2026-08-08.
--
-- A coluna version de supabase_migrations.schema_migrations e PRIMARY KEY:
-- duas migrations com o mesmo timestamp nao podem ambas ser registradas. O
-- push falhou com duplicate key logo apos gravar a outra (auth). Esta nunca
-- chegou a ser registrada, entao renomear nao cria drift, e o conteudo e um
-- GRANT idempotente.

-- 2026-08-06 — Merge LID ↔ número: o service_role não tinha DELETE em
-- conversation_kanban_state, e a FK (sem ação) bloqueava a remoção da conversa
-- duplicada @lid no reconcile de identidade (whatsapp-identity-sync.service.ts).
GRANT DELETE ON public.conversation_kanban_state TO service_role;
