# Eventos WebSocket e eventos do worker

A API aceita conexões em `GET /ws`. `workspaceId` e `userId` por query string são contexto temporário de desenvolvimento, não autenticação. API e worker continuam desacoplados nesta etapa: os eventos abaixo já são produzidos e validados pelo worker, mas ainda não são encaminhados ao WebSocket.

Todo evento usa o envelope:

```json
{"eventId":"uuid","eventType":"session.status.changed","workspaceId":"workspace-a","timestamp":"2026-07-15T21:00:00.000Z","correlationId":"uuid","payload":{}}
```

## Status de sessão

- `disconnected`: sem socket ativo; credenciais podem existir.
- `connecting`: socket inicial criado e aguardando atualização.
- `qr_pending`: QR temporário disponível.
- `connected`: conexão aberta.
- `reconnecting`: tentativa limitada agendada ou em andamento.
- `logged_out`: logout informado pelo WhatsApp ou remoção explícita.
- `error`: falha de conexão ou tentativas esgotadas.

O worker não publica novamente um status idêntico. `updatedAt` e `changedAt` registram a última mudança.

## `session.status.changed`

```json
{"eventId":"uuid","eventType":"session.status.changed","workspaceId":"workspace-a","timestamp":"2026-07-15T21:00:00.000Z","correlationId":"uuid","payload":{"sessionId":"session-a","status":"connected","previousStatus":"connecting","changedAt":"2026-07-15T21:00:00.000Z"}}
```

Em `reconnecting`, o payload pode incluir `attempt`.

## `session.qr.updated`

```json
{"eventId":"uuid","eventType":"session.qr.updated","workspaceId":"workspace-a","timestamp":"2026-07-15T21:00:00.000Z","correlationId":"uuid","payload":{"sessionId":"session-a","qr":"temporary-rendering-value","expiresAt":"2026-07-15T21:02:00.000Z"}}
```

`qr` é o valor temporário mínimo necessário para renderização futura. Ele não é salvo em disco, banco ou logs e é descartado ao expirar ou conectar. Clientes não devem persistir nem retransmitir o valor.

## `worker.error`

```json
{"eventId":"uuid","eventType":"worker.error","workspaceId":"workspace-a","timestamp":"2026-07-15T21:00:00.000Z","correlationId":"uuid","payload":{"sessionId":"session-a","operation":"reconnect","code":"Error","message":"WhatsApp worker operation failed"}}
```

O payload expõe uma descrição segura, sem erro interno completo, QR, tokens, chaves ou auth state.

## Ciclo de vida

`create` prepara metadados como `disconnected`, sem socket. `connect` só funciona com `WHATSAPP_CONNECTION_ENABLED=true`. `disconnect` encerra o socket local e preserva `CHATPRO_DATA_DIR/workspaces/{workspaceId}/whatsapp/sessions/{sessionId}/auth/`. `remove` tenta logout, encerra o socket, remove auth e metadados; repetir a remoção é seguro.

Reconexão usa máximo e atraso-base configuráveis, backoff exponencial e um único timer por sessão. Disconnect, remove, shutdown, logout e feature flag desligada impedem novas tentativas. Sessões descobertas no bootstrap ficam `disconnected` e não conectam automaticamente.

O armazenamento local é provisório: produção precisa de volume persistente/cofre, permissões, backup e estratégia para afinidade/concorrência entre réplicas. A integração futura deverá transportar comandos e envelopes entre API e worker e então distribuir eventos apenas ao workspace autorizado. Até lá, rotas da API permanecem 501.

Tipos reservados ainda não conectados: `message.received` e `message.status.updated`. `system.connected` continua sendo emitido somente pela API ao abrir o WebSocket.
