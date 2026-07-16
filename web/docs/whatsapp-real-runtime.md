# Runtime WhatsApp real local

Copie `web/.env.example` para o arquivo ignorado `web/.env.local` e configure nele o Supabase já validado, além destas flags existentes:

```dotenv
WHATSAPP_DEMO_MODE=false
WHATSAPP_CONNECTION_ENABLED=true
```

Inicie com `cd web && npm run dev:whatsapp`. O comando mantém API, dashboard e worker no runtime já coordenado; não há auto-connect. Crie uma sessão e solicite a conexão somente quando estiver diante da interface para exibir o QR.

O auth state é criado exclusivamente pelo worker em `CHATPRO_DATA_DIR/workspaces/{workspaceId}/whatsapp/sessions/{sessionId}/auth/` (por padrão, `web/.chatpro-data/...`) e é ignorado pelo Git. O QR usa apenas memória no worker, não é salvo em banco, disco ou logs, não é impresso no terminal e é encaminhado temporariamente pela API para renderização no frontend. Credenciais e auth state não trafegam pela API.
