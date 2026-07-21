# Paginação da Inbox

`GET /api/v1/inbox/conversations` retorna no máximo 100 conversas visíveis,
ordenadas por `lastMessageAt DESC, id ASC`. A resposta inclui `hasMore` e
`nextCursor`; o cursor codifica a dupla estável `lastMessageAt/id` e substitui
OFFSET. `search` é processada no backend e não se restringe ao lote exibido.

`GET /api/v1/inbox/conversations/:id/messages` retorna as 50 mensagens mais
recentes inicialmente. Lotes anteriores usam o cursor `occurredAt/id`; a API
ordena a resposta em ordem cronológica para o histórico.

O carregamento da Inbox é independente da sincronização WAHA. A sincronização
histórica avança em ciclos com checkpoint persistido, sem o antigo teto global
de 500 conversas/977 mensagens; uma retomada continua do último chat e página
confirmados, sem reimportar o histórico já processado.
