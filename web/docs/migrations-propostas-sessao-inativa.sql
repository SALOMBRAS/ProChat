-- PROPOSTA — NÃO EXECUTADA. Aguarda aprovação.
-- Contexto: docs/conversas-sessao-inativa.md, seção "Os cards já gravados".
--
-- Remove os cards de Kanban que o backfill criou para conversas presas a uma
-- sessão WhatsApp que a WAHA não conhece mais.
--
-- A correção de código impede novos casos por dois caminhos: o backfill de
-- `KanbanService.ensure` deixou de varrer conversa de sessão inativa, e o
-- contador de etapa deixou de contá-la. Mas o código não apaga linha nenhuma:
-- os cards já gravados continuam em conversation_kanban_state, e continuariam
-- aparecendo na lista de cards da etapa (que lê a tabela, não o contador).
--
-- Assinatura: o card aponta para uma conversa cujo waha_session não está entre
-- as sessões que a WAHA lista hoje. A lista de sessões vivas NÃO está no banco —
-- não existe tabela de sessões no ChatPro. Ela vem de
-- `GET {WAHA_BASE_URL}/api/sessions?all=true`, campo `name`, e precisa ser
-- conferida no momento de rodar isto. Em 2026-07-29 havia exatamente uma:
--
--   chatpro-87a9de0476d7df33378259135259bb5dfd16524f  (WORKING)
--
-- e o passo 2 selecionava 504 cards de 630, todos na etapa 'new' — 499 da sessão
-- chatpro-42217e8d030af3c738f272559e67befaf1533633 e 5 da sessão
-- chatpro-a14338b935f2838eabbccfa3c690fd6f344f38ab.
--
-- ORDEM OBRIGATÓRIA: rode 1, confira contra a WAHA, rode 2, confira o total, e
-- só então descomente o 3. Não há como desfazer o DELETE sem backup: o card
-- carrega posição e histórico de transição que não são reconstruíveis.
--
-- SUBSTITUA a lista de sessões vivas nos três passos. Ela aparece uma vez em
-- cada um, sempre com o mesmo conteúdo.

-- -----------------------------------------------------------------------------
-- 1) Conferência prévia: quais sessões existem no banco e qual o peso de cada uma.
--    Compare a coluna waha_session com o que a WAHA responde AGORA. Se alguma
--    sessão do banco estiver viva e não constar da sua lista, PARE.
SELECT
  c.waha_session,
  count(*)                                                        AS conversas,
  count(*) FILTER (WHERE c.visibility_state = 'visible')          AS visiveis,
  count(k.conversation_id)                                        AS cards_de_kanban,
  min(c.last_message_at)                                          AS mensagem_mais_antiga,
  max(c.last_message_at)                                          AS mensagem_mais_recente
FROM public.conversations c
LEFT JOIN public.conversation_kanban_state k
  ON k.workspace_id = c.workspace_id AND k.conversation_id = c.id
WHERE c.workspace_id = 'default-workspace'
GROUP BY c.waha_session
ORDER BY conversas DESC;

-- -----------------------------------------------------------------------------
-- 2) Conferência: exatamente quais cards o passo 3 apagaria, e de qual etapa.
--    O total desta consulta é o que o DELETE vai remover.
SELECT
  s.key                AS etapa,
  c.waha_session,
  count(*)             AS cards
FROM public.conversation_kanban_state k
JOIN public.conversations c
  ON c.workspace_id = k.workspace_id AND c.id = k.conversation_id
JOIN public.kanban_stages s ON s.id = k.stage_id
WHERE k.workspace_id = 'default-workspace'
  AND c.waha_session NOT IN (
    'chatpro-87a9de0476d7df33378259135259bb5dfd16524f'  -- <<< SUBSTITUA pela lista viva
  )
GROUP BY s.key, c.waha_session
ORDER BY cards DESC;

-- -----------------------------------------------------------------------------
-- 3) Remoção. Só os cards; nenhuma conversa, nenhuma mensagem, nenhum contato.
--    A conversa continua na Inbox, marcada como sessão inativa, e o histórico
--    continua pesquisável — é exatamente esta a diferença entre tirar do painel
--    e esconder da vista.
--
--    O evento de transição em conversation_kanban_events é preservado de
--    propósito: ele é registro do que aconteceu, e apagá-lo reescreveria a
--    trilha em vez de limpar o board.
--
-- DELETE FROM public.conversation_kanban_state k
-- USING public.conversations c
-- WHERE c.workspace_id = k.workspace_id
--   AND c.id = k.conversation_id
--   AND k.workspace_id = 'default-workspace'
--   AND c.waha_session NOT IN (
--     'chatpro-87a9de0476d7df33378259135259bb5dfd16524f'  -- <<< SUBSTITUA pela lista viva
--   );

-- -----------------------------------------------------------------------------
-- 4) Verificação posterior: o board deve ficar só com as conversas da sessão
--    viva, e o total tem que bater com o contador da etapa na API.
SELECT
  s.key      AS etapa,
  count(*)   AS cards
FROM public.conversation_kanban_state k
JOIN public.conversations c
  ON c.workspace_id = k.workspace_id AND c.id = k.conversation_id
JOIN public.kanban_stages s ON s.id = k.stage_id
WHERE k.workspace_id = 'default-workspace'
  AND c.visibility_state = 'visible'
GROUP BY s.key
ORDER BY cards DESC;

-- -----------------------------------------------------------------------------
-- NÃO PROPOSTO, e por quê.
--
-- Reapontar as conversas antigas para a sessão viva (UPDATE conversations SET
-- waha_session = ...) NÃO está aqui e não deve ser feito sem uma investigação
-- própria. A chave única é (workspace_id, waha_session, chat_id) e 62 chat_id
-- existem nas duas sessões: o UPDATE viola a constraint em 62 linhas, e resolver
-- cada colisão é decidir o que fazer com duas conversas que viram uma.
-- whatsapp_messages, whatsapp_identities e whatsapp_groups são todas chaveadas
-- pela mesma coluna e teriam de acompanhar. Além disso, não está estabelecido
-- que as três sessões parearam o mesmo número — só a viva expõe `me.id` hoje.
-- Se o número for outro, isso é corrupção de dado com aparência de conserto.
