-- PROPOSTA — NÃO EXECUTADA em produção. Aguarda aprovação.
-- Contexto: docs/conversas-sem-resposta.md, seção 6 ("Limpeza retroativa").
-- Procedimento de execução passo a passo: docs/limpeza-eventos-sistema-procedimento.md
--
-- Limpeza retroativa dos eventos de sistema do WhatsApp que a ingestão gravava
-- como mensagem de entrada. A correção de código (messageFrom passa a ler o tipo
-- real em payload._data.type e descarta o evento técnico antes de persistir)
-- impede novos casos, mas não desfaz os já gravados.
--
-- Assinatura: o tipo real da mensagem — payload_json->>'type' quando existe,
-- senão payload_json->'_data'->>'type' — pertence ao vocabulário técnico. É
-- exatamente a mesma expressão que o código passa a aplicar
-- (conversation-identity.ts, technicalMessageTypes).
--
-- A coluna message_type NÃO serve para isto: ela já vem normalizada pela
-- ingestão e só contém text/document/image/audio/video. Conferido no espelho:
-- classificar por message_type acha zero mensagem técnica.
--
-- 'call_log' está FORA da lista de propósito. Uma chamada perdida é informação
-- operacional que o atendente precisa ver — decisão fechada em
-- docs/call-log-na-inbox.md. Medido agora: 259 mensagens em 31 conversas.
--
-- ---------------------------------------------------------------------------
-- REVALIDAÇÃO (2026-07-28, 18h) — SUBSTITUI a medição das 13h51
-- ---------------------------------------------------------------------------
-- Refeita porque DUAS coisas mudaram depois da validação anterior:
--
--   (a) O VOCABULÁRIO. A PR #46 acrescentou 'biz_content_placeholder' aos tipos
--       técnicos. A medição anterior não o alcançava.
--   (b) A BASE. A sincronização avançou de 4 613 para 6 811 mensagens.
--
-- Método: espelho somente-leitura das 6 tabelas envolvidas, baixado via
-- PostgREST, carregado em PostgreSQL 16.14 num contêiner, sobre o schema montado
-- a partir das migrations do repositório. O remoto NÃO foi escrito, em momento
-- algum. Todas as colunas do remoto têm par local — conferido na carga.
--
-- A medição anterior foi REPRODUZIDA antes de ser substituída: reconstruindo o
-- estado no instante em que a base tinha 4 613 mensagens (2026-07-28 13:51:28),
-- as consultas devolvem 652 conversas, 241 técnicas, 160 fantasmas, 8 mistas e
-- 29 já vazias — exatamente os números da versão anterior deste arquivo. É essa
-- coincidência que autoriza confiar nos números novos.
--
-- ESTADO ATUAL:
--
--   6 811 mensagens no total, 279 técnicas (4,1 %)
--     e2e_notification 142 (132 in + 10 out), notification_template 71
--     (47 in + 24 out), gp2 40 (34 out + 6 in), revoked 14,
--     biz_content_placeholder 12
--   655 conversas: 171 ficam sem nenhuma mensagem (26 %), 12 são mistas
--     (têm técnica e real — apagar só a mensagem, preservar a conversa)
--     69 das 171 têm badge de não lida, somando 92 não lidas
--     29 outras já hoje não têm mensagem: NÃO são alvo (ver passo 1)
--   59 linhas de SLA: 40 em conversas que somem, 19 sobrevivem
--     43 estão ancoradas em mensagem técnica: 40 somem por cascata e
--     3 sobrevivem e precisam de ajuste (passo 8)
--   17 778 eventos brutos em waha_webhook_events — NÃO são tocados por nada
--     aqui: são o registro de auditoria e continuam explicando o que chegou.
--   1 workspace na base (default-workspace); mesmo assim tudo é filtrado.
--
-- DE ONDE VEM CADA DIFERENÇA (medido, não estimado):
--
--   fantasmas 160 -> 171.  Duas causas somadas, em direções opostas:
--     -1  uma conversa que era fantasma recebeu mensagem real e virou mista;
--     +12 as doze conversas do 'biz_content_placeholder', que no vocabulário
--         anterior contavam como conversa real e agora são fantasmas.
--     Com o vocabulário ANTIGO sobre a base ATUAL dariam 159 — a diferença de
--     12 é inteiramente do vocabulário, e nenhuma outra virou fantasma.
--
--   mistas 8 -> 12.  +1 a ex-fantasma acima, +2 que eram só-real e receberam
--     evento técnico novo, +1 conversa criada depois do corte. Nenhuma mista
--     veio do 'biz_content_placeholder': as 12 conversas dele NÃO têm mensagem
--     real nenhuma, é por isso que caem inteiras na classe fantasma.
--
--   conversas 652 -> 655.  Três criadas depois do corte (duas só-real, uma mista).
--
--   SLA 54 -> 59 linhas.  Cinco novas. Já a CASCATA caiu de 41 para 40, porque a
--     conversa que deixou de ser fantasma tinha linha de SLA e agora sobrevive.
--     As 12 conversas do 'biz_content_placeholder' NÃO TÊM linha de SLA — por
--     isso o vocabulário novo não muda a cascata.
--
--   a recalcular 2 -> 3.  Uma linha a mais ficou ancorada em evento técnico
--     numa conversa que sobrevive. As três têm acumuladores zerados e nenhuma
--     está em status terminal — a condição que torna o passo 8 determinável.
--
-- A base é viva e está sincronizando: 2 160 mensagens entraram na última hora
-- antes desta medição. RECONFIRA imediatamente antes de executar. As consultas
-- 0 a 3 e o passo 9 existem para isso, e o passo 4 congela a lista para que o
-- que é apagado seja exatamente o que foi conferido.
--
-- ---------------------------------------------------------------------------
-- AS TRÊS CORREÇÕES — RECONFIRMADAS na revalidação de 18h
-- ---------------------------------------------------------------------------
-- Sem elas a proposta original não rodava. Todas continuam necessárias, e as
-- três foram reexecutadas contra o espelho novo.
--
-- 1. O DELETE de conversas ABORTAVA. Três FKs para conversations não são
--    CASCADE. RECONFIRMADO por introspecção do espelho:
--      conversation_kanban_state ......... sem ON DELETE (NO ACTION)
--      kanban_automation_deliveries ...... sem ON DELETE (NO ACTION)
--      inbox_outbox_jobs ................. ON DELETE RESTRICT
--    Hoje 628 das 655 conversas estão no Kanban, e as 171 alvo estão TODAS
--    lá (171 de 171) — a proporção piorou, não melhorou. Sem o passo 6 o
--    DELETE do passo 7 aborta inteiro. Reproduzido no espelho: o erro é
--    'update or delete on table "conversations" violates foreign key
--    constraint "conversation_kanban_state_workspace_id_conversation_id_fkey"'.
--    Agora o passo 6 remove o estado operacional antes.
--
-- 2. A conferência de conversas órfãs escondia as já vazias. RECONFIRMADO que o
--    problema existe — e, ao reexecutar, descobriu-se que a correção anterior
--    NÃO O RESOLVIA. Trocar JOIN por LEFT JOIN não bastava: o HAVING continuava
--    com count(*) FILTER, que conta a linha NULL do LEFT JOIN e elimina
--    justamente as conversas vazias. Medido: a consulta devolvia 171 linhas,
--    todas 'fantasma_desta_limpeza', com as 29 ainda invisíveis. O HAVING agora
--    usa count(m.external_message_id) FILTER e a consulta devolve 171 + 29.
--    Detalhe completo no comentário da própria consulta 1.
--    O DELETE nunca esteve em risco: o passo 7 usa a lista do passo 4, montada
--    com JOIN e exigindo mensagem técnica. As 29 nunca foram alvo.
--
-- 3. O UPDATE de SLA sobrescreve status terminal. Sem filtro, ele alcança todas
--    as linhas vivas para consertar poucas, e o CASE só emite
--    waiting_operator/waiting_customer. RECONFIRMADO no espelho novo, e o dano
--    HOJE é maior do que era: seriam 19 linhas vivas alcançadas para consertar
--    3, e a execução da versão sem filtro converte as 54 linhas 'expired' em
--    waiting_operator/waiting_customer — 54 violações de SLA apagadas de uma
--    vez (na medição anterior o dano visível era uma única conversa 'resolved';
--    hoje não há nenhuma 'resolved', mas há 54 'expired').
--    Medido: UPDATE 59; depois, 53 waiting_operator + 6 waiting_customer e
--    ZERO expired. O UPDATE atual só toca nas 3 linhas congeladas no passo 4.
--
-- 4. Faltavam filtros de workspace_id nos DELETE.
-- 5. A conferência de SLA duplicava linha quando duas mensagens dividem o mesmo
--    instante de âncora (JOIN virou EXISTS) e casava conversa só por id,
--    ignorando workspace_id.
--
-- ORDEM OBRIGATÓRIA: 4) backup, 5) mensagens, 6) estado operacional das órfãs,
-- 7) conversas órfãs (a FK de conversation_sla_metrics é ON DELETE CASCADE e
-- leva as 40 linhas junto), 8) ajuste das linhas de SLA que sobrevivem.
-- Inverter a ordem deixa conversa sem mensagem ou métrica apontando para
-- mensagem inexistente.
--
-- Só o Supabase remoto tem dados reais. As bases SQLite locais são recriadas a
-- partir das migrations e não precisam de limpeza.

-- ---------------------------------------------------------------------------
-- Vocabulário técnico, num só lugar. Repetido literalmente nas consultas abaixo
-- porque o Supabase SQL Editor roda statement a statement e não guarda estado.
-- ---------------------------------------------------------------------------
--   ('ack','receipt','reaction','status','protocol','revoked',
--    'e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')

-- ---------------------------------------------------------------------------
-- 0) Conferência geral: quantas mensagens a regra alcança, por tipo.
--    Esperado hoje: 279 no total.
-- ---------------------------------------------------------------------------
SELECT
  lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) AS tipo_real,
  direction,
  count(*) AS mensagens,
  count(DISTINCT chat_id) AS chats
FROM public.whatsapp_messages
WHERE workspace_id = 'default-workspace'
  AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
  ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
GROUP BY 1, 2
ORDER BY mensagens DESC;

-- ---------------------------------------------------------------------------
-- 1) Conferência: conversas que ficam SEM NENHUMA mensagem, e por quê.
--    LEFT JOIN de propósito: com JOIN as conversas que já hoje não têm mensagem
--    ficariam invisíveis aqui, embora um DELETE por "não tem mensagem" as
--    alcançasse. A coluna motivo separa os dois casos.
--    Esperado hoje: 171 'fantasma_desta_limpeza' e 29 'ja_vazia_antes'.
--
--    CORRIGIDO na revalidação de 18h: o HAVING usava count(*) FILTER, e com isso
--    o LEFT JOIN NÃO resolvia o problema que ele foi introduzido para resolver.
--    Numa conversa sem mensagem o LEFT JOIN produz uma linha com m.* NULL;
--    coalesce(NULL, NULL, '') devolve '', que não pertence ao vocabulário
--    técnico, então count(*) FILTER (... NOT IN tecnicos) contava 1 e o
--    HAVING = 0 eliminava a linha. Medido antes da correção: a consulta
--    devolvia 171 linhas, TODAS 'fantasma_desta_limpeza', e as 29 continuavam
--    invisíveis — exatamente o defeito que a versão anterior dizia ter
--    consertado. count(m.external_message_id) FILTER ignora a linha NULL e
--    devolve 0, que é o que o HAVING espera. Depois da correção: 171 + 29.
--
--    O DELETE nunca esteve errado: o passo 7 usa a lista congelada no passo 4,
--    que é montada com JOIN e exige mensagem técnica. As 29 nunca correram
--    risco. Cego estava só o olho, não a mão.
-- ---------------------------------------------------------------------------
SELECT
  c.id,
  c.conversation_type,
  c.visibility_state,
  c.unread_count,
  c.last_message_at,
  count(m.external_message_id) AS mensagens_hoje,
  CASE WHEN count(m.external_message_id) = 0 THEN 'ja_vazia_antes'
       ELSE 'fantasma_desta_limpeza' END AS motivo
FROM public.conversations c
LEFT JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
WHERE c.workspace_id = 'default-workspace'
GROUP BY c.id, c.conversation_type, c.visibility_state, c.unread_count, c.last_message_at
HAVING count(m.external_message_id) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
) = 0
ORDER BY motivo, c.last_message_at DESC;

-- ---------------------------------------------------------------------------
-- 2) Conferência: conversas MISTAS. Têm mensagem real e também técnica.
--    A conversa fica; só as mensagens técnicas saem. Não apague estas conversas.
--    Esperado hoje: 12 conversas, 40 técnicas a remover, 4 792 reais preservadas.
--    O passo 7 não as alcança porque elas continuam com mensagem depois do
--    passo 5 — a coluna reais_preservadas é a prova disso, linha a linha.
-- ---------------------------------------------------------------------------
SELECT
  c.id,
  c.chat_id,
  count(*) FILTER (
    WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
      ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
  ) AS tecnicas_a_remover,
  count(*) FILTER (
    WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
      ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
  ) AS reais_preservadas
FROM public.conversations c
JOIN public.whatsapp_messages m
  ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
WHERE c.workspace_id = 'default-workspace'
GROUP BY c.id, c.chat_id
HAVING count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
) > 0
AND count(*) FILTER (
  WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
    ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
) > 0
ORDER BY tecnicas_a_remover DESC;

-- ---------------------------------------------------------------------------
-- 3) Conferência: linhas de SLA cujo relógio está ancorado num evento técnico.
--    As que estão em conversa órfã somem no passo 7 por cascata. As que estão em
--    conversa que sobrevive precisam de AJUSTE (passo 8) — apagar a mensagem não
--    conserta a métrica, só a deixa apontando para o que não existe mais.
--    EXISTS em vez de JOIN: com JOIN, duas mensagens no mesmo instante
--    duplicariam a linha e inflariam a contagem.
--    Esperado hoje: 43 linhas, 40 em conversa que some, 3 que sobrevivem.
--    acumuladores_zerados = true significa que a linha não tem histórico
--    acumulado a separar — é o que torna o passo 8 determinável. Ver o
--    procedimento para o caso false.
-- ---------------------------------------------------------------------------
SELECT
  s.conversation_id,
  s.sla_status,
  s.waiting_since_at,
  round(extract(epoch FROM (now() - s.waiting_since_at)) / 3600.0, 1) AS horas_acumuladas,
  (s.operator_waiting_ms = 0 AND s.customer_waiting_ms = 0
   AND s.total_response_ms = 0 AND s.response_count = 0) AS acumuladores_zerados,
  EXISTS (
    SELECT 1 FROM public.whatsapp_messages r
    WHERE r.workspace_id = c.workspace_id AND r.waha_session = c.waha_session AND r.chat_id = c.chat_id
      AND lower(coalesce(r.payload_json->>'type', r.payload_json->'_data'->>'type', '')) NOT IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
  ) AS conversa_sobrevive
FROM public.conversation_sla_metrics s
JOIN public.conversations c
  ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
WHERE s.workspace_id = 'default-workspace'
  AND EXISTS (
    SELECT 1 FROM public.whatsapp_messages m
    WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
      AND m.occurred_at = s.waiting_since_at
      AND lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
        ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
  )
ORDER BY conversa_sobrevive DESC, horas_acumuladas DESC;

-- ---------------------------------------------------------------------------
-- 4) BACKUP. Roda ANTES de qualquer DELETE, em transação própria, e fica na
--    base para o rollback. Guarda a linha inteira de tudo que será removido ou
--    alterado. Não custa nada manter: são poucas centenas de linhas.
-- ---------------------------------------------------------------------------
--
-- CREATE SCHEMA IF NOT EXISTS backup_eventos_sistema;
--
-- CREATE TABLE backup_eventos_sistema.whatsapp_messages AS
-- SELECT * FROM public.whatsapp_messages
-- WHERE workspace_id = 'default-workspace'
--   AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
--     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder');
--
-- -- Alvo das remoções de conversa: só as que TIVERAM mensagem técnica e ficam
-- -- sem nenhuma real. As 29 já vazias de antes ficam de fora de propósito.
-- CREATE TABLE backup_eventos_sistema.alvo AS
-- SELECT c.workspace_id, c.id AS conversation_id
-- FROM public.conversations c
-- JOIN public.whatsapp_messages m
--   ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
-- WHERE c.workspace_id = 'default-workspace'
-- GROUP BY c.workspace_id, c.id
-- HAVING count(*) FILTER (
--   WHERE lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) NOT IN
--     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
-- ) = 0;
--
-- CREATE TABLE backup_eventos_sistema.conversations AS
-- SELECT c.* FROM public.conversations c
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = c.workspace_id AND a.conversation_id = c.id;
--
-- CREATE TABLE backup_eventos_sistema.conversation_sla_metrics AS
-- SELECT s.* FROM public.conversation_sla_metrics s
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = s.workspace_id AND a.conversation_id = s.conversation_id;
--
-- CREATE TABLE backup_eventos_sistema.conversation_kanban_state AS
-- SELECT k.* FROM public.conversation_kanban_state k
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = k.workspace_id AND a.conversation_id = k.conversation_id;
--
-- CREATE TABLE backup_eventos_sistema.kanban_automation_deliveries AS
-- SELECT d.* FROM public.kanban_automation_deliveries d
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = d.workspace_id AND a.conversation_id = d.conversation_id;
--
-- CREATE TABLE backup_eventos_sistema.inbox_outbox_jobs AS
-- SELECT j.* FROM public.inbox_outbox_jobs j
-- JOIN backup_eventos_sistema.alvo a ON a.workspace_id = j.workspace_id AND a.conversation_id = j.conversation_id;
--
-- -- Linhas de SLA que SOBREVIVEM e serão ajustadas no passo 8.
-- CREATE TABLE backup_eventos_sistema.sla_ajustadas AS
-- SELECT s.* FROM public.conversation_sla_metrics s
-- JOIN public.conversations c ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
-- WHERE s.workspace_id = 'default-workspace'
--   AND NOT EXISTS (SELECT 1 FROM backup_eventos_sistema.alvo a
--                   WHERE a.workspace_id = s.workspace_id AND a.conversation_id = s.conversation_id)
--   AND EXISTS (
--     SELECT 1 FROM public.whatsapp_messages m
--     WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
--       AND m.occurred_at = s.waiting_since_at
--       AND lower(coalesce(m.payload_json->>'type', m.payload_json->'_data'->>'type', '')) IN
--         ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder'));

-- ---------------------------------------------------------------------------
-- 5) REMOÇÃO DAS MENSAGENS TÉCNICAS. Primeiro passo destrutivo.
--    Não toca em waha_webhook_events: o evento bruto continua auditável — e é
--    ele que permite reconstruir a mensagem no rollback.
--    Esperado hoje: DELETE 279.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.whatsapp_messages
-- WHERE workspace_id = 'default-workspace'
--   AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
--     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder');

-- ---------------------------------------------------------------------------
-- 6) REMOÇÃO DO ESTADO OPERACIONAL DAS CONVERSAS ALVO. Sem isto o passo 7
--    ABORTA: estas três FKs não são CASCADE (NO ACTION / RESTRICT).
--    É estado derivado de uma conversa que deixa de existir — cartão no Kanban,
--    entrega de automação e job de envio. Está todo no backup.
--    Esperado hoje: 171 no Kanban, 0 nas outras duas.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.conversation_kanban_state k
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = k.workspace_id AND a.conversation_id = k.conversation_id;
--
-- DELETE FROM public.kanban_automation_deliveries d
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = d.workspace_id AND a.conversation_id = d.conversation_id;
--
-- DELETE FROM public.inbox_outbox_jobs j
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = j.workspace_id AND a.conversation_id = j.conversation_id;

-- ---------------------------------------------------------------------------
-- 7) REMOÇÃO DAS CONVERSAS FANTASMA. Usa a lista congelada no passo 4, não uma
--    condição recalculada — assim o que é apagado é exatamente o que foi
--    conferido e salvo, mesmo que uma mensagem nova chegue no meio do caminho.
--    A FK de conversation_sla_metrics é ON DELETE CASCADE e leva as 40 linhas
--    junto; conversation_metadata, conversation_events, routing_events e
--    routing_jobs também são CASCADE.
--
--    ATENÇÃO: contact_id NÃO é seguido. O contato pode ser compartilhado com
--    outra conversa ou ter sido criado à mão. Limpar contatos é decisão separada.
--    Esperado hoje: DELETE 171.
-- ---------------------------------------------------------------------------
--
-- DELETE FROM public.conversations c
-- USING backup_eventos_sistema.alvo a
-- WHERE a.workspace_id = c.workspace_id AND a.conversation_id = c.id;

-- ---------------------------------------------------------------------------
-- 8) AJUSTE DAS LINHAS DE SLA QUE SOBREVIVEM (3 em 2026-07-28, 18h).
--    Só as linhas ancoradas em evento técnico, congeladas no passo 4 — e só as
--    que não têm acumulador. O UPDATE reancora tudo que a mensagem técnica havia
--    definido nos instantes das mensagens REAIS que restaram.
--
--    Por que os acumuladores não precisam ser recompostos nestas linhas: elas
--    têm operator_waiting_ms = customer_waiting_ms = total_response_ms =
--    response_count = 0. A linha não foi contaminada, ela foi CRIADA pelo evento
--    técnico e nunca viu uma transição. Não há intervalo medido a partir de
--    evento técnico embutido em acumulador nenhum — não há o que separar.
--    O guard `AND b.operator_waiting_ms = 0 AND ...` garante isso: se na hora de
--    executar alguma linha tiver acumulador, ela fica de fora e vai para o
--    tratamento descrito no procedimento.
--
--    first_response_at continua NULL quando não houver outbound real: nunca
--    houve resposta, e inventar uma seria pior que não ter.
--    sla_status vira waiting_operator/waiting_customer conforme quem falou por
--    último. Nenhuma das linhas alcançadas está 'resolved' ou 'archived' — o
--    passo 3 mostra o status de cada uma antes de executar.
--
--    SOBRE 'expired' — leia antes de aprovar. Na execução de 18h as 3 linhas
--    ajustadas estavam TODAS em sla_status='expired', e o passo 8 as converte
--    em 'waiting_operator'. Isso é DELIBERADO e é o objetivo da limpeza, não um
--    efeito colateral: são exatamente as violações fantasma descritas em
--    docs/sla-historico-investigacao.md — o relógio começou a correr num evento
--    de sistema que ninguém enviou e ninguém podia responder, estourou sozinho,
--    e a mensagem que o ancorava deixa de existir no passo 5. Reancorar na
--    mensagem real remanescente é o conserto.
--    O que NÃO pode acontecer é isso alcançar linhas fora dessa lista: o UPDATE
--    sem filtro converteria as 54 'expired' da base, apagando 54 violações,
--    das quais só 3 são fantasma. Daí o JOIN com backup_eventos_sistema.sla_ajustadas.
--    Efeito medido no espelho: expired 54 -> 11 (40 somem por cascata com as
--    conversas fantasma, 3 são reancoradas), waiting_customer 5 -> 5,
--    waiting_operator 0 -> 3. Total 19.
-- ---------------------------------------------------------------------------
--
-- WITH reais AS (
--   SELECT c.workspace_id, c.id AS conversation_id,
--          min(m.occurred_at) FILTER (WHERE m.direction = 'inbound')  AS primeiro_inbound,
--          max(m.occurred_at) FILTER (WHERE m.direction = 'inbound')  AS ultimo_inbound,
--          max(m.occurred_at) FILTER (WHERE m.direction = 'outbound') AS ultimo_outbound,
--          max(m.occurred_at)                                         AS ultima_atividade
--   FROM public.conversations c
--   JOIN public.whatsapp_messages m
--     ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
--   GROUP BY c.workspace_id, c.id
-- )
-- UPDATE public.conversation_sla_metrics s
-- SET first_inbound_at  = coalesce(r.primeiro_inbound, s.first_inbound_at),
--     last_inbound_at   = coalesce(r.ultimo_inbound, s.last_inbound_at),
--     last_outbound_at  = coalesce(r.ultimo_outbound, s.last_outbound_at),
--     last_activity_at  = coalesce(r.ultima_atividade, s.last_activity_at),
--     waiting_since_at  = coalesce(r.ultimo_outbound, r.ultimo_inbound, s.waiting_since_at),
--     sla_status        = CASE WHEN r.ultimo_outbound IS NOT NULL
--                               AND r.ultimo_outbound >= coalesce(r.ultimo_inbound, r.ultimo_outbound)
--                              THEN 'waiting_customer' ELSE 'waiting_operator' END,
--     updated_at        = now()
-- FROM reais r
-- JOIN backup_eventos_sistema.sla_ajustadas b
--   ON b.workspace_id = r.workspace_id AND b.conversation_id = r.conversation_id
-- WHERE s.workspace_id = r.workspace_id
--   AND s.conversation_id = r.conversation_id
--   AND s.frozen_at IS NULL
--   AND b.operator_waiting_ms = 0 AND b.customer_waiting_ms = 0
--   AND b.total_response_ms = 0 AND b.response_count = 0;

-- ---------------------------------------------------------------------------
-- 9) Conferência final, depois de executar.
--    Esperado: 0 técnicas, 29 conversas sem mensagem (as que já estavam assim),
--    484 conversas, 19 linhas de SLA, 17 778 eventos brutos intactos, e nenhuma
--    linha de SLA ancorada em mensagem que não existe mais.
--
--    MEDIDO na execução completa da sequência sobre o espelho (2026-07-28, 18h):
--      tecnicas_restantes ....... 0
--      conversas_sem_mensagem ... 29   (as que já estavam assim; nenhuma nova)
--      conversas_totais ......... 484  (655 - 171)
--      linhas_de_sla ............ 19   (59 - 40 por cascata)
--      sla_ancora_inexistente ... 0
--      sla_status ............... expired 11, waiting_customer 5, waiting_operator 3
--      backup ................... alvo 171, mensagens 279, conversas 171,
--                                 sla_ajustadas 3
--    A sequência terminou sem erro, na ordem 4-5-6-7-8.
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.whatsapp_messages
   WHERE workspace_id = 'default-workspace'
     AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
     ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')) AS mensagens_tecnicas_restantes,
  (SELECT count(*) FROM public.conversations c
   WHERE c.workspace_id = 'default-workspace'
     AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m
       WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id)) AS conversas_sem_mensagem,
  (SELECT count(*) FROM public.conversations WHERE workspace_id = 'default-workspace') AS conversas_totais,
  (SELECT count(*) FROM public.conversation_sla_metrics WHERE workspace_id = 'default-workspace') AS linhas_de_sla,
  (SELECT count(*) FROM public.conversation_sla_metrics s
   JOIN public.conversations c ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
   WHERE s.workspace_id = 'default-workspace' AND s.waiting_since_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m
       WHERE m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
         AND m.occurred_at = s.waiting_since_at)) AS sla_com_ancora_inexistente,
  (SELECT count(*) FROM public.waha_webhook_events) AS eventos_brutos_preservados;

-- #####################################################################
-- #  REVALIDAÇÃO DE 2026-07-31 — CONSULTAS CORRIGIDAS                 #
-- #  PROPOSTA — NÃO APLICAR. NÃO EXECUTADA em produção.               #
-- #####################################################################
--
-- Motivo: a PR #73 passou a aceitar mensagem de grupo cujo único identificador
-- de chat é o JID do grupo em from/to. Entre 20/07 e 31/07 essas mensagens
-- morriam como `missing_chat_id` — 10.372 descartes, 9.686 recuperáveis, com o
-- payload inteiro preservado em `waha_webhook_events`.
--
-- Consequência: "zero mensagem real" num chat de GRUPO deixou de ser evidência
-- sobre o chat e passou a ser evidência sobre o bug. As consultas abaixo
-- substituem as originais; as diretas não mudam de veredito.
--
-- Validado em PostgreSQL 16 descartável, com fixture de três conversas. NÃO foi
-- executado contra o Supabase remoto.

-- --------------------------------------------------------------- C1
-- Substitui a CONSULTA 1. Acrescenta `waha_session` e a classe nova.
--
-- `chat_real_com_historico_nao_materializado`: a conversa não tem mensagem real
-- em `whatsapp_messages`, MAS existe evento bruto não técnico para o mesmo chat.
-- É grupo vivo esperando materialização — NÃO é fantasma e NÃO pode ser alvo.
--
-- SELECT
--   c.id, c.waha_session, c.conversation_type, c.visibility_state,
--   c.unread_count, c.last_message_at,
--   count(m.external_message_id) AS mensagens_hoje,
--   CASE
--     WHEN count(m.external_message_id) = 0 THEN 'ja_vazia_antes'
--     WHEN EXISTS (
--       SELECT 1 FROM public.waha_webhook_events e
--       WHERE e.workspace_id = c.workspace_id
--         AND e.payload_json::text LIKE '%' || c.chat_id || '%'
--         AND coalesce(e.payload_json ->> 'type', e.payload_json -> '_data' ->> 'type') NOT IN (
--           'ack','receipt','reaction','status','protocol','revoked',
--           'e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
--     ) AND count(m.external_message_id) FILTER (WHERE m.external_message_id IS NOT NULL) = 0
--       THEN 'chat_real_com_historico_nao_materializado'
--     WHEN count(*) FILTER (WHERE <mensagem real>) = 0 THEN 'fantasma_desta_limpeza'
--     ELSE 'mista'
--   END AS classe
-- FROM public.conversations c
-- LEFT JOIN public.whatsapp_messages m
--   ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
-- WHERE c.workspace_id = 'default-workspace'
-- GROUP BY c.workspace_id, c.id, c.chat_id, c.waha_session, c.conversation_type,
--          c.visibility_state, c.unread_count, c.last_message_at;
--
-- O GROUP BY precisa listar workspace_id e chat_id: a PK é (workspace_id, id) e
-- o EXISTS correlaciona por chat_id. Sem isso o PostgreSQL recusa a consulta.

-- --------------------------------------------------------------- C2
-- Substitui a montagem de `backup_eventos_sistema.alvo` (passo 4).
-- CORREÇÃO OBRIGATÓRIA: `alvo` é a lista congelada que os passos D e E apagam.
-- Sem o NOT EXISTS, a limpeza remove conversas de grupos vivos cujo histórico a
-- PR #73 acabou de destravar. Medido em fixture: a original devolve 2 conversas,
-- esta devolve 1.
--
-- CREATE TABLE backup_eventos_sistema.alvo AS
-- SELECT c.workspace_id, c.id AS conversation_id
-- FROM public.conversations c
-- JOIN public.whatsapp_messages m
--   ON m.workspace_id = c.workspace_id AND m.waha_session = c.waha_session AND m.chat_id = c.chat_id
-- WHERE c.workspace_id = 'default-workspace'
--   -- ... demais condições originais ...
--   AND NOT EXISTS (
--     SELECT 1 FROM public.waha_webhook_events e
--     WHERE e.workspace_id = c.workspace_id
--       AND e.payload_json::text LIKE '%' || c.chat_id || '%'
--       AND coalesce(e.payload_json ->> 'type', e.payload_json -> '_data' ->> 'type') NOT IN (
--         'ack','receipt','reaction','status','protocol','revoked',
--         'e2e_notification','notification_template','gp2','ciphertext','biz_content_placeholder')
--   )
-- GROUP BY c.workspace_id, c.id;

-- --------------------------------------------------------------- C3
-- Conferência nova, a rodar ANTES do passo B. Quantifica a população que a #73
-- protege. Se vier > 0, a lista de alvo mudou e os números do procedimento não
-- valem mais.
--
-- SELECT count(*) AS grupos_vivos_protegidos
-- FROM public.conversations c
-- WHERE c.workspace_id = 'default-workspace'
--   AND c.conversation_type = 'group'
--   AND NOT EXISTS (SELECT 1 FROM public.whatsapp_messages m
--                   WHERE m.workspace_id = c.workspace_id AND m.chat_id = c.chat_id)
--   AND EXISTS (SELECT 1 FROM public.waha_webhook_events e
--               WHERE e.workspace_id = c.workspace_id
--                 AND e.payload_json::text LIKE '%' || c.chat_id || '%');

-- --------------------------------------------------------------- NOTA DE FRESCOR
-- Todas as contagens deste arquivo são de 2026-07-28 18h, com ~6.811 mensagens.
-- Hoje a base passa de 16.900 eventos brutos. Reexecute as consultas de
-- conferência IMEDIATAMENTE ANTES de aplicar, não antes de revisar: a
-- sincronização escreve continuamente e a #73 destravou 9.686 mensagens
-- recuperáveis. Compare FORMA (proporções, relações entre passos), não valor.
