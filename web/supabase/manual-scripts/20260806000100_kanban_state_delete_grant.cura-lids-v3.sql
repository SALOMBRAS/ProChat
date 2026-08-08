-- ###########################################################################
-- #  MANUAL · DESTRUCTIVE · NEVER RUN VIA DB PUSH                           #
-- #                                                                          #
-- #  Isto NÃO é uma migration. É script de cura de uso único, e contém DML   #
-- #  destrutivo: DELETE em conversation_kanban_state e em conversations.     #
-- #                                                                          #
-- #  Ficava em supabase/migrations/, onde o Supabase CLI trata todo .sql     #
-- #  como migration — um db push o executaria. Medido em 2026-08-08: as 29   #
-- #  conversas @lid seguem no remoto (quarentenadas), então o push as        #
-- #  APAGARIA. Movido para cá em 2026-08-08 por isso.                        #
-- #                                                                          #
-- #  Execute só à mão, no SQL Editor, um passo por vez, conferindo contagem. #
-- ###########################################################################

-- 2026-08-06 — Cura LID v3, etapa final (rodar UMA vez no SQL Editor do Supabase).
--
-- O que já foi feito pela aplicação/scripts:
--   • whatsapp_identities corrigidas (canonical = número@c.us, phone real);
--   • mensagens movidas dos chats @lid para o chat canônico;
--   • 1.053 contatos duplicados (LID como telefone) fundidos nos contatos reais;
--   • as 29 conversas @lid viraram cascas vazias e foram ESCONDIDAS da inbox
--     (visibility_state = 'quarantined', motivo 'lid_alias_merged').
--
-- Este script: dá o grant que faltava e remove as 29 cascas (e seus cartões de
-- kanban órfãos), completando o merge. Idempotente — pode rodar mais de uma vez.

GRANT DELETE ON public.conversation_kanban_state TO service_role;

-- cartões de kanban das cascas @lid resolvidas (a conversa canônica já tem o seu)
DELETE FROM public.conversation_kanban_state k
USING public.conversations c
WHERE c.workspace_id = k.workspace_id
  AND c.id = k.conversation_id
  AND c.conversation_type = 'direct'
  AND c.chat_id LIKE '%@lid'
  AND EXISTS (
    SELECT 1 FROM public.whatsapp_identities i
    WHERE i.workspace_id = c.workspace_id
      AND i.waha_session = c.waha_session
      AND i.whatsapp_id = c.chat_id
      AND i.canonical_whatsapp_id IS NOT NULL
      AND i.canonical_whatsapp_id <> i.whatsapp_id
  );

-- envios de anexo pendentes passam para a conversa canônica (RESTRICT na FK)
UPDATE public.inbox_outbox_jobs j
SET conversation_id = canon.id, updated_at = now()
FROM public.conversations c
JOIN public.whatsapp_identities i
  ON i.workspace_id = c.workspace_id
 AND i.waha_session = c.waha_session
 AND i.whatsapp_id = c.chat_id
 AND i.canonical_whatsapp_id <> i.whatsapp_id
JOIN public.conversations canon
  ON canon.workspace_id = c.workspace_id
 AND canon.waha_session = c.waha_session
 AND canon.chat_id = i.canonical_whatsapp_id
WHERE c.workspace_id = j.workspace_id
  AND c.id = j.conversation_id
  AND c.conversation_type = 'direct'
  AND c.chat_id LIKE '%@lid';

-- remove as cascas @lid (mensagens já foram movidas para o canônico)
DELETE FROM public.conversations c
WHERE c.conversation_type = 'direct'
  AND c.chat_id LIKE '%@lid'
  AND EXISTS (
    SELECT 1 FROM public.whatsapp_identities i
    WHERE i.workspace_id = c.workspace_id
      AND i.waha_session = c.waha_session
      AND i.whatsapp_id = c.chat_id
      AND i.canonical_whatsapp_id IS NOT NULL
      AND i.canonical_whatsapp_id <> i.whatsapp_id
  );
