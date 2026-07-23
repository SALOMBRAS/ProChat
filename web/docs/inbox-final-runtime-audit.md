# Auditoria final de runtime da Inbox

Data: 2026-07-23 (America/Sao_Paulo)
Project ref: `vhfixhqfwusobczmubfu`

## Escopo

Esta auditoria não alterou a identidade de contatos, o webhook de resolução,
grupos ou dados existentes. Não foram criadas ou aplicadas migrations, nem
foram executados limpeza, merge, backfill ou push.

## Kanban pós-persistência

Os logs mostraram que mensagens inbound eram persistidas e a conversa era
atualizada antes da falha `Kanban post-persistence automation failed`. A
consulta administrativa ao Supabase confirmou a causa: a tabela
`public.kanban_boards` não existe no projeto remoto. Por consequência, os
demais objetos dependentes da automação Kanban não podem ser consultados e a
automação não pode executar.

A falha permanece isolada por `KanbanAutomationCoordinator`: ela devolve
`failed` sem propagar a exceção ao fluxo de webhook ou de envio, portanto não
desfaz nem repete a persistência da Inbox.

O diagnóstico foi aprimorado para registrar a função responsável, mensagem,
stack, código, detalhes e hint do erro do banco. Nenhuma migration foi criada
ou aplicada nesta tarefa; restaurar o Kanban remoto exige uma tarefa separada,
com escopo explícito de migrations pendentes.

## Outbound

Não foi enviada mensagem real: não havia contato de teste autorizado. O caminho
foi auditado por código e testes. Ele separa as etapas WAHA/worker, persistência
de outbound, automação e realtime. Foram adicionados logs para distinguir
falha de transporte do worker (`worker_transport`) de rejeição da WAHA
(`worker_delivery`); falhas posteriores já indicavam persistência, automação ou
realtime.

## Frontend Inbox

O dashboard assina `conversation.updated` e `message.sent`, executa
`refreshConversations()` e recarrega a lista. A lista vem ordenada pela API com
preview e timestamp atuais, portanto uma conversa atualizada retorna à posição
correta. O Kanban tem assinatura própria para seus eventos; seu carregamento
continua indisponível enquanto a infraestrutura remota não existir.

## Resultado

- Mensagem e conversa: isolamento confirmado pela coordinator e pelos logs.
- Kanban: falha estrutural remota identificada; não bloqueia Inbox.
- Outbound: nenhum erro reproduzido e nenhuma mensagem real enviada.
- Realtime da Inbox: eventos e refresh verificados no código e na suíte.
