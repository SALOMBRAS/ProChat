# WhatsApp connector

Serviço Node.js independente reservado para hospedar futuramente adaptadores do contrato `WhatsAppProvider`.

Nesta fase, ele apenas inicia, informa que está ativo, aguarda `SIGINT` ou `SIGTERM` e encerra de forma controlada. Não há Baileys, QR Code, sessão, conexão com WhatsApp, Supabase, HTTP, WebSocket, fila ou serviço externo.

Comandos a partir da raiz:

```powershell
npm run dev:connector
npm run build:connector
npm run typecheck
```

Depois do build, o artefato pode ser iniciado com:

```powershell
npm run start --workspace @chatpro/whatsapp-connector
```
