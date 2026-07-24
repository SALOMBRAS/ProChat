# Inbox, mensagens e operação

`Inbox.tsx` renderiza lista paginada de conversas, histórico, composer,
contexto do cliente, operação da conversa e SLA detalhado. O endpoint de uma
conversa por ID permite deep links sem carregar todas as páginas.

## Mensagens

- Texto inbound/outbound é persistido antes das automações complementares.
- Imagem, documento e áudio usam renderizadores específicos no frontend.
- Anexos pendentes têm preview local e só são enviados pela ação explícita.
- A gravação de áudio usa `MediaRecorder`; a entrega depende do suporte já
  existente no backend/outbox.
- Falhas de Kanban/SLA não podem impedir persistência, Inbox ou realtime.

## Contexto e identidade

Etiquetas usam o endpoint de contexto existente. Observações internas são
rascunhos locais e só persistem pelo botão **Salvar observação**. Não reintroduza
autosave sem análise de perda de conteúdo.

Nomes de conversa, participantes e CRM passam por sanitização de identidade.
Nunca derive um nome visível removendo o sufixo de `chatId`: um LID não é um
telefone válido.

## Realtime e escala

Eventos relevantes incluem `message.received`, `message.sent`,
`conversation.updated`, `conversation.context.updated`,
`conversation.kanban.moved` e `conversation.sla.updated`. Atualize somente o
item afetado quando o contrato permitir; evite refresh de listas inteiras para
eventos de detalhe.
