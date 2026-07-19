# Filas e distribuição automática

Cada fila pertence a um workspace e pode ser vinculada a uma equipe. Operadores só entram na seleção quando estão ativos no workspace, são membros disponíveis da fila e, quando houver equipe vinculada, também pertencem à equipe.

As estratégias disponíveis são:

- `round_robin`: escolhe o operador com `lastAssignedAt` mais antigo; empates usam `userId`.
- `least_loaded`: escolhe a menor quantidade de conversas operacionais abertas; empates usam o cursor e `userId`.
- `manual`: mantém a conversa na fila sem responsável.

O limite da fila é aplicado à quantidade de conversas `open`, `in_progress` ou `waiting_customer` do operador. Usuários desativados e indisponíveis nunca entram na consulta.

## Concorrência e auditoria

No SQLite, seleção, revalidação de conversa sem responsável, atualização de `lastAssignedAt` e gravação de `routing_events` são uma única transação. No Supabase, a RPC `chatpro_distribute_conversation` bloqueia fila e conversa com `FOR UPDATE` antes de selecionar o operador. Assim, a atribuição condicional só ocorre se a conversa continuar sem responsável e desbloqueada.

Toda decisão registra fila, estratégia, resultado, operador (quando houver) e um motivo seguro, sem conteúdo de mensagem. A atribuição manual grava `routingLockedAt`; a distribuição automática não a sobrescreve. A ação explícita de redistribuição é a única que pode limpar esse bloqueio.

## Limitações atuais

A elegibilidade usa o status administrativo e a disponibilidade configurada na fila. Enquanto a autenticação e a presença reais não estiverem ativas, o fallback de desenvolvimento continua sendo o ator administrativo. A estrutura já tem `autoAssignedAt`, `routingLockedAt`, disponibilidade e limite de carga para suportar presença, SLA e regras de roteamento futuras; não há cálculo de SLA nem análise de conteúdo nesta etapa.
