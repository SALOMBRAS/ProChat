-- 2026-08-06 — Merge LID ↔ número: o service_role não tinha DELETE em
-- conversation_kanban_state, e a FK (sem ação) bloqueava a remoção da conversa
-- duplicada @lid no reconcile de identidade (whatsapp-identity-sync.service.ts).
GRANT DELETE ON public.conversation_kanban_state TO service_role;
