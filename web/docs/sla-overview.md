# SLA operacional e Kanban

`SlaService` registra o ciclo real após persistência de mensagens: inbound abre
espera do atendente; outbound registra resposta e abre espera do cliente;
resolver/arquivar congela a métrica. A falha do SLA é isolada do fluxo Inbox.

## Status operacional e o relógio de SLA

Resolver pelo seletor da Inbox e arrastar o card para Resolvido no Kanban são a
mesma decisão operacional, então param o mesmo relógio. As duas alavancas passam
por `SlaService.applyOperationalStatus`, que é o único ponto que traduz status
para relógio — a Inbox manda o status da conversa e o Kanban manda a chave da
etapa, e os dois vocabulários coincidem nos nomes terminais.

| transição | efeito no SLA |
| --- | --- |
| → `resolved` / `archived` | congela; cobra a espera em aberto uma única vez |
| `resolved` → `archived` (já congelada) | só troca o rótulo terminal, sem recobrar |
| sair de terminal (`in_progress`, `open`, qualquer etapa não terminal) | descongela |
| `open` ↔ `in_progress` | nenhum |
| `in_progress` → `waiting_customer` | **nenhum, de propósito** |

Marcar "aguardando cliente" no seletor não vira `waiting_customer` no SLA. A
espera só troca de lado quando sai uma mensagem: se o seletor parasse o relógio,
um atendente poderia zerar o próprio prazo de primeira resposta sem responder.

Ao descongelar, o relógio recomeça no instante da reabertura — o tempo parado não
é dívida do time. De quem é a vez sai do histórico preservado: se a última
mensagem foi do atendente, a conversa volta como `waiting_customer`; caso
contrário, como `waiting_operator`.

Residual conhecido, ainda sem correção: `SlaService.message` ignora conversas
congeladas (`if (row.frozenAt) return`). Uma conversa resolvida que recebe nova
mensagem do cliente continua congelada e fora do SLA até alguém reabri-la por
status. Reabrir automaticamente nesse caso é decisão de produto pendente.

O timer da API avalia SLA a cada 60 segundos e publica
`conversation.sla.updated` quando aplicável. Estados do ciclo e severidade são
conceitos diferentes: `slaStatus` descreve a espera; `indicator` define
verde/amarelo/vermelho/neutro.

`GET /api/v1/inbox/operations/sla-summary` retorna agregados compactos e uma
amostra crítica limitada por `criticalSampleLimit` (hoje 100). A identidade
desses críticos é resolvida em lote no
servidor, nunca por chamada individual no dashboard. O dashboard usa um único
timer de 60 segundos, debounce de realtime e `visibilitychange`.

O Kanban persistente consome boards, stages e cards próprios. Drag-and-drop é
otimista com rollback em erro/conflito; eventos Kanban atualizam o item afetado.
Não use a lista geral da Inbox como fonte de cards.
