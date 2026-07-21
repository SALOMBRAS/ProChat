# Paginação da Inbox

`GET /api/v1/inbox/conversations` retorna no máximo 100 conversas visíveis,
ordenadas por `lastMessageAt DESC, id ASC`. A resposta inclui `hasMore` e
`nextCursor`; o cursor codifica a dupla estável `lastMessageAt/id` e substitui
OFFSET. `search` é processada no backend e não se restringe ao lote exibido.

`GET /api/v1/inbox/conversations/:id/messages` retorna as 50 mensagens mais
recentes inicialmente. Lotes anteriores usam o cursor `occurredAt/id`; a API
ordena a resposta em ordem cronológica para o histórico.
