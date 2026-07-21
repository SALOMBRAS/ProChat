# Kanban operacional da Inbox

O Kanban compartilha a mesma Inbox: a lista tradicional permanece a visão padrão e o botão **Kanban** alterna a área operacional sem carregar mídia ou consultar WAHA.

## Persistência

`kanban_boards`, `kanban_stages`, `conversation_kanban_state` e `conversation_kanban_events` mantêm board, etapas, posição, override manual e auditoria. Só conversations com `visibility_state = visible` são inicializadas ou listadas. O board padrão possui as etapas Novo, Em atendimento, Aguardando cliente, Aguardando operador, Resolvido e Arquivado.

## API e realtime

Os endpoints ficam sob `/api/v1/inbox/kanban`. Movimentos usam concorrência otimista com `expectedUpdatedAt`; no Supabase, a RPC `chatpro_kanban_move` atualiza estado e histórico na mesma transação. Após persistência, são publicados `conversation.kanban.moved`, `kanban.stage.created`, `kanban.stage.updated` e `kanban.stage.reordered`.

## SLA e automação

Mover para Resolvido ou Arquivado chama o motor SLA existente para congelamento. As automações simples previstas são inbound de Aguardando cliente para Aguardando operador e outbound de Novo/Aguardando operador/Em atendimento para Aguardando cliente; mensagens históricas, conversations não visíveis e overrides manuais não devem ser automatizados.
# Automação pós-persistência

`WahaWebhookStore.ingest` normaliza, resolve a conversa e confirma a inserção em `whatsapp_messages` antes de delegar mensagens inbound novas ao `KanbanAutomationCoordinator`. `InternalInboxService.send` só delega mensagens outbound depois de `recordOutbound` devolver uma mensagem persistida com `messageInserted`.

O coordenador é uma fronteira de falha: registra apenas identificadores seguros e retorna `failed`, sem desfazer a mensagem nem provocar replay. O serviço central Kanban aplica as regras de estágio, preserva `manualOverride` e só emite `conversation.kanban.moved` quando há mudança real.

A tabela persistida `kanban_automation_deliveries` tem chave única por workspace, conversa, mensagem e direção. Portanto, replays/retries não dependem da memória do processo e não produzem um segundo evento Kanban.
