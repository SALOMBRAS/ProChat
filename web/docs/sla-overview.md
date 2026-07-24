# SLA operacional e Kanban

`SlaService` registra o ciclo real após persistência de mensagens: inbound abre
espera do atendente; outbound registra resposta e abre espera do cliente;
resolver/arquivar congela a métrica. A falha do SLA é isolada do fluxo Inbox.

O timer da API avalia SLA a cada 60 segundos e publica
`conversation.sla.updated` quando aplicável. Estados do ciclo e severidade são
conceitos diferentes: `slaStatus` descreve a espera; `indicator` define
verde/amarelo/vermelho/neutro.

`GET /api/v1/inbox/operations/sla-summary` retorna agregados compactos e no
máximo 20 críticos. A identidade desses críticos é resolvida em lote no
servidor, nunca por chamada individual no dashboard. O dashboard usa um único
timer de 60 segundos, debounce de realtime e `visibilitychange`.

O Kanban persistente consome boards, stages e cards próprios. Drag-and-drop é
otimista com rollback em erro/conflito; eventos Kanban atualizam o item afetado.
Não use a lista geral da Inbox como fonte de cards.
