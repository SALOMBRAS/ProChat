# Filas e distribuiÃ§Ã£o automÃ¡tica

Cada fila pertence a um workspace e pode ser vinculada a uma equipe. Operadores sÃ³ entram na seleÃ§Ã£o quando estÃ£o ativos no workspace, sÃ£o membros disponÃ­veis da fila e, quando houver equipe vinculada, tambÃ©m pertencem Ã  equipe.

As estratÃ©gias disponÃ­veis sÃ£o:

- `round_robin`: escolhe o operador com `lastAssignedAt` mais antigo; empates usam `userId`.
- `least_loaded`: escolhe a menor quantidade de conversas operacionais abertas; empates usam o cursor e `userId`.
- `manual`: mantÃ©m a conversa na fila sem responsÃ¡vel.

O limite da fila Ã© aplicado Ã  quantidade de conversas `open`, `in_progress` ou `waiting_customer` do operador. UsuÃ¡rios desativados e indisponÃ­veis nunca entram na consulta.

## ConcorrÃªncia e auditoria

No SQLite, seleÃ§Ã£o, revalidaÃ§Ã£o de conversa sem responsÃ¡vel, atualizaÃ§Ã£o de `lastAssignedAt` e gravaÃ§Ã£o de `routing_events` sÃ£o uma Ãºnica transaÃ§Ã£o. No Supabase, a RPC `chatpro_distribute_conversation` bloqueia fila e conversa com `FOR UPDATE` antes de selecionar o operador. Assim, a atribuiÃ§Ã£o condicional sÃ³ ocorre se a conversa continuar sem responsÃ¡vel e desbloqueada.

Toda decisÃ£o registra fila, estratÃ©gia, resultado, operador (quando houver) e um motivo seguro, sem conteÃºdo de mensagem. A atribuiÃ§Ã£o manual grava `routingLockedAt`; a distribuiÃ§Ã£o automÃ¡tica nÃ£o a sobrescreve. A aÃ§Ã£o explÃ­cita de redistribuiÃ§Ã£o Ã© a Ãºnica que pode limpar esse bloqueio.

## LimitaÃ§Ãµes atuais

A elegibilidade usa o status administrativo e a disponibilidade configurada na fila. Enquanto a autenticaÃ§Ã£o e a presenÃ§a reais nÃ£o estiverem ativas, o fallback de desenvolvimento continua sendo o ator administrativo. A estrutura jÃ¡ tem `autoAssignedAt`, `routingLockedAt`, disponibilidade e limite de carga para suportar presenÃ§a, SLA e regras de roteamento futuras; nÃ£o hÃ¡ cÃ¡lculo de SLA nem anÃ¡lise de conteÃºdo nesta etapa.

## Jobs no worker

Filas automáticas criam `routing_jobs` e a API retorna `202`. Configure o worker com `ROUTING_DATABASE_PATH` apontando para o SQLite compartilhado; `ROUTING_POLL_MS` (1000) e `ROUTING_BATCH_SIZE` (10) regulam o consumo. O lease usa `lockedAt` e `lockedBy`; leases expirados são recuperáveis. Falhas transitórias recebem até três tentativas com backoff exponencial. Atribuição manual cancela jobs pendentes ou em processamento da conversa.
