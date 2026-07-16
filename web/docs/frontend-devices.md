# Painel de Dispositivos

`apps/dashboard` é a interface React/TypeScript do ChatPro, aberta diretamente no painel e sem autenticação. Consome `GET/POST /api/v1/sessions`, `status`, `qr`, `connect`, `stop`, `logout` e `DELETE` pela camada tipada `src/api/sessions.ts`.

QR é renderizado somente em memória pelo `qrcode.react`; não é persistido nem registrado. A conexão WhatsApp continua controlada pela API/worker e, com a feature flag padrão, não ocorre conexão externa.
