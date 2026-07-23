# Navegação direta de conversas

## URL e contrato

Uma conversa pode ser aberta em `/inbox?conversationId=<uuid>`. A Inbox usa
`GET /api/v1/inbox/conversations/:conversationId` apenas se o item não estiver
na página já carregada. A resposta tem o mesmo formato de `InboxConversation`.

## Fluxo e escala

Para uma conversa presente na página, a Inbox reutiliza o objeto local. Para
uma conversa fora dela, consulta somente o identificador solicitado e então
carrega suas mensagens pelo fluxo normal. Nenhuma página adicional é buscada,
nenhuma lista inteira é carregada e a conversa direcionada não é inserida nem
reordena permanentemente a lista local.

## Segurança e ciclo de navegação

O endpoint delega a consulta ao `ConversationStore` com `workspaceId` do
contexto autenticado. Uma conversa inexistente ou de outro workspace retorna
404, sem revelar sua existência. A URL é atualizada ao selecionar uma conversa,
sobrevive ao refresh e responde a voltar/avançar. Consultas obsoletas são
abortadas e ignoradas.

## Consumidores futuros

`inboxUrlForConversation` e o parâmetro `conversationId` podem ser reutilizados
por Kanban, pesquisa global, notificações e alertas internos sem acoplar esses
consumidores à paginação da Inbox.

## Checklist manual

- Abrir uma conversa fora da primeira página a partir de um alerta SLA.
- Atualizar o navegador mantendo a conversa aberta.
- Testar voltar/avançar e links de workspace diferente.
- Conferir feedback de indisponibilidade e retry em falha de rede.
