# Dashboard operacional de SLA

## Contrato

`GET /api/v1/inbox/operations/sla-summary` devolve uma projeção compacta:

- `generatedAt`
- `totals`: ativos, aguardando operador/cliente, dentro do SLA, atenção, atrasados e congelados
- `averages`: primeira resposta, espera do operador e espera do cliente em segundos
- `percentages.withinSla`
- `critical`: no máximo 20 conversas amarelas/vermelhas, com identificador, estado, indicador, prazo e última atividade

O endpoint não devolve `conversation_sla_metrics` integralmente. A configuração SLA é carregada uma vez por workspace e as métricas são agregadas no serviço. A lista crítica é ordenada por atrasados e, depois, por prazo.

## Escala e realtime

O dashboard deve consumir uma única requisição compacta na entrada e invalidá-la de forma agrupada para eventos `conversation.sla.updated`, `conversation.kanban.moved` e `conversation.updated`. Atualização periódica recomendada: 60 segundos, pausada em aba oculta e refeita em `visibilitychange`.

Não há N+1, mensagens completas, polling por card ou carregamento de toda a lista de métricas no navegador.

## Limitações atuais

O schema SLA não guarda nome, responsável ou fila no registro de métrica. A lista crítica mantém IDs seguros e pode receber esses dados por projeção paginada futura, sem consultas individuais. Validar visualmente amanhã: estados vazio/erro, abertura da conversa, atualização realtime agrupada e layout mobile.
