# Runtime WhatsApp real local

## Provider WAHA WEBJS

Enquanto o upstream do Baileys retorna `BAILEYS_405`, também há `WHATSAPP_PROVIDER=waha`. Ele usa WAHA Core `devlikeapro/waha:latest-2026.7.1` com `WEBJS` (Chromium/Puppeteer), sem alterar rotas ou frontend. Configure Supabase, `WHATSAPP_DEMO_MODE=false`, `WHATSAPP_CONNECTION_ENABLED=true`, `WHATSAPP_PROVIDER=waha` e uma `WAHA_API_KEY` local de ao menos 32 caracteres em `.env.local`; execute `npm run dev:waha`.

WAHA fica somente em `127.0.0.1:3002`; API, worker e dashboard mantêm 3000, 3101 e 5173. Sessões WEBJS ficam no volume ignorado `web/.waha-sessions`; QR e chave nunca são logados ou versionados, e dashboard/Swagger do WAHA permanecem desabilitados. Não há mensagens nesta integração. Após a correção upstream, defina `WHATSAPP_PROVIDER=baileys` e use `npm run dev:whatsapp`.

Copie `web/.env.example` para o arquivo ignorado `web/.env.local` e configure nele o Supabase já validado, além destas flags existentes:

```dotenv
WHATSAPP_DEMO_MODE=false
WHATSAPP_CONNECTION_ENABLED=true
```

Inicie com `cd web && npm run dev:whatsapp`. O comando mantém API, dashboard e worker no runtime já coordenado; não há auto-connect. Crie uma sessão e solicite a conexão somente quando estiver diante da interface para exibir o QR.

O auth state é criado exclusivamente pelo worker em `CHATPRO_DATA_DIR/workspaces/{workspaceId}/whatsapp/sessions/{sessionId}/auth/` (por padrão, `web/.chatpro-data/...`) e é ignorado pelo Git. O QR usa apenas memória no worker, não é salvo em banco, disco ou logs, não é impresso no terminal e é encaminhado temporariamente pela API para renderização no frontend. Credenciais e auth state não trafegam pela API.
