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

## Dashboard visual

`SlaOperationalDashboard` é composto pela `HomeDashboard` e consome apenas
`GET /api/v1/inbox/operations/sla-summary`. A seção mantém os demais módulos da
Home visíveis durante loading, preserva o último resumo válido em falhas de
atualização e oferece retry manual isolado.

O componente usa um único intervalo de 60 segundos, que não atualiza com a aba
oculta. Ao retornar à aba, atualiza somente se o último carregamento tiver mais
de 60 segundos. Eventos `conversation.sla.updated`,
`conversation.kanban.moved` e `conversation.updated` são agrupados por 750 ms
antes de uma única atualização do resumo.

Os itens críticos usam a ordem devolvida pelo servidor e navegam para a Inbox
com `conversationId` na URL. A seleção é feita sem pré-carregar mensagens ou
métricas individuais. Quando a conversa ainda não está na página atual, a Inbox
faz uma única consulta direcionada a
`GET /api/v1/inbox/conversations/:conversationId` e reutiliza o carregamento
normal de mensagens.

## Limitações atuais

O schema SLA não guarda nome, responsável ou fila no registro de métrica. A lista crítica mantém IDs seguros e pode receber esses dados por projeção paginada futura, sem consultas individuais. Validar visualmente amanhã: estados vazio/erro, abertura por link direto, atualização realtime agrupada, layout mobile e atualização multiusuário.
