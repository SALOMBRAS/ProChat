# Painel de Dispositivos

`apps/dashboard` é a interface React/TypeScript do ChatPro, aberta diretamente no painel e sem autenticação. Consome `GET/POST /api/v1/sessions`, `status`, `qr`, `connect`, `stop`, `logout` e `DELETE` pela camada tipada `src/api/sessions.ts`.

QR é renderizado somente em memória pelo `qrcode.react`; não é persistido nem registrado. A conexão WhatsApp continua controlada pela API/worker e, com a feature flag padrão, não ocorre conexão externa.

## Modo de demonstração

`WHATSAPP_DEMO_MODE=false` é o padrão seguro. Com `WHATSAPP_DEMO_MODE=true` no worker, o transporte interno usa somente um adaptador em memória: ele cria sessões fictícias e percorre `connecting`, `waiting_qr`, `connected`, `stopped`, `disconnected` e remoção. Para exibir os controles e o aviso no painel, compile o dashboard com `VITE_WHATSAPP_DEMO_MODE=true`.

O QR contém apenas texto fixo de demonstração, sem credencial, sessão, autenticação ou conteúdo do WhatsApp. Ele não é QR real e não deve ser escaneado. As sessões demo desaparecem ao reiniciar e nunca compartilham armazenamento, credenciais ou runtime com sessões reais. Mantenha `WHATSAPP_CONNECTION_ENABLED=false`: este modo não inicia Baileys, não conecta ao WhatsApp e nunca deve receber dados reais.
