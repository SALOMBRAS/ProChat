# PROMPT DE CONTINUAÇÃO — ChatPro (chamadas de voz implementadas, E2E pendente)

> Cole este arquivo inteiro como primeira mensagem no novo computador.
> Ele substitui o contexto da conversa anterior: conta o que foi feito,
> onde o trabalho parou e como continuar.

## ⚠️ REGRAS ABSOLUTAS (leia antes de tudo)

1. **Repositório:** `https://github.com/SALOMBRAS/ProChat` — branch de trabalho `develop/chatpro-main`.
2. **Setup no PC novo:** `git clone` (ou `git pull`), `git checkout develop/chatpro-main`, `cd web && npm install`.
3. **SUPABASE:** usar SEMPRE e APENAS as credenciais do `.env` / `.env.local` do projeto local. NUNCA acesse instância Supabase externa. O `.env.local` NÃO está no git — copie de um backup seguro ou recrie a partir do `web/.env.example` (agora inclui `CALL_SERVICE_URL` e `WHATSAPP_OWN_NUMBERS`).
4. **NÃO criar migrations, NÃO alterar schema, NÃO aplicar SQL remoto** sem solicitação explícita.
5. **Terminar sempre com:** `npm run typecheck` + `npm test` + `npm run build` + `git diff --check` (em `web/`).
6. Stack: TypeScript, React 18/Vite, Express 5, Zod, Vitest, WebSocket, Supabase + `better-sqlite3`. Monorepo em `web/` (npm workspaces). O **Call Service é Go** (vive em `auditoria/WaCalls/`, agora versionado no git).
7. Leia `CLAUDE.md` na raiz antes de qualquer alteração.
8. **Rodar local:** `npm run dev:waha` em `web/` (sobe WAHA + worker + API + dashboard; exige Docker e `.env.local` com `WHATSAPP_DEMO_MODE=false`, `WHATSAPP_CONNECTION_ENABLED=true`, `WAHA_API_KEY` ≥ 32 chars). Para chamadas, suba TAMBÉM o Call Service (ver abaixo).

## ✅ CHAMADAS DE VOZ — O que ESTÁ PRONTO (commits `a402cbe` → `8079ae5` + Call Service versionado)

Arquitetura: **WAHA segue dona das mensagens; o Call Service (Go, fork do WaCalls em `auditoria/WaCalls/`) é o provider paralelo de chamadas.** O dashboard nunca fala com o Go direto — sempre via API do ChatPro.

1. **Backend API (545/545 testes ✓, typecheck ✓):**
   - `web/apps/api/src/services/call.service.ts` — cliente HTTP do Go + ponte SSE `/api/events` → RealtimeHub publicando `call.updated`; mapa de chamadas ativas; resolve a sessão Go por `WHATSAPP_OWN_NUMBERS` ou sessão única.
   - `web/apps/api/src/controllers/calls.controller.ts` — `POST /calls` resolve o telefone DA PRÓPRIA CONVERSA (`identity.phone` ?? dígitos do `@c.us`); grupo → 409; **contato só-LID → chama pelo LID** (o Go resolve LID→PN via `GetAltJID` ou disca o `@lid` direto).
   - Rotas: `POST /calls`, `GET /calls/active`, `GET|POST /calls/pairing`, `POST /calls/:id/webrtc|accept|reject`, `DELETE /calls/:id`.
   - `startEventBridge()` só roda fora de `nodeEnv === 'test'`.
2. **Dashboard (713/713 testes ✓):**
   - Botão **📞 Ligar** no cabeçalho da conversa (diretas com telefone OU @lid).
   - `useCalls` (ciclo de vida) + `CallModal` (cartão flutuante: chamando/conectado com timer/encerrada; atender/recusar em chamada recebida) + `softphone.ts`/`pcm.ts` + worklets em `public/worklets/` (PCM 16 kHz por Data Channel WebRTC, portado do WaCalls).
   - **Pareamento unificado:** painel "Chamadas de voz" na tela Sessões mostra o QR do Call Service ao lado do QR da WAHA. ATENÇÃO: são DUAS sessões WhatsApp independentes — um scan cada, mesmo aparelho. Não existe scan único (processos e stores separados).
3. **Call Service Go (`auditoria/WaCalls/`, build+testes ✓):**
   - `cmd/server/httpapi.go` — `doStartCall`: resolve JID canônico BR sem 9º dígito via `IsOnWhatsApp` (fix Fase 0: sem isso o offer era descartado em silêncio); aceita `{ phone }` ou `{ lid }`.
   - `SessionInfo` expõe `qr` (pareamento por HTTP, sem SSE).
   - **Chamadas recebidas JÁ existem ponta a ponta no código** (verificado, não testado ao vivo): `CallOffer` → SSE `incoming` → API publica `call.updated` inbound → dashboard abre modal → `accept` + troca SDP. Lacuna conhecida: o evento `incoming-claimed` (outra aba atendeu) ainda não é repassado pela API.
4. **Config:** `.env.local` precisa de `CALL_SERVICE_URL=http://127.0.0.1:8080` e `WHATSAPP_OWN_NUMBERS=558592369359`.

## ⚠️ FASE 0 VALIDADA / PENDÊNCIAS DE VALIDAÇÃO

- **Ligação de saída real FUNCIONOU** (celular tocou) com o WaCalls local. **Pré-requisito descoberto:** as duas contas precisam ter trocado mensagem de texto antes da 1ª chamada (offer com pkmsg é descartado; com msg directa funciona — issue tulir/whatsmeow#555).
- **NÃO validado ainda:** (a) áudio bidirecional > 30s (suspeita de regressão: áudio de entrada pode parar após o burst inicial — observar no E2E); (b) E2E pelo dashboard (botão 📞 na conversa); (c) chamada de ENTRADA ao vivo; (d) chamada para contato LID ao vivo; (e) pareamento pelo novo painel.

## 🛠️ Setup do Call Service no PC novo

1. **Instalar Go** (a toolchain portátil em `tools/` NÃO vai pro git — 327 MB): https://go.dev/dl/ (projeto usou Go 1.26.5).
2. `cd auditoria/WaCalls && go build -o wacalls.exe ./cmd/server`
3. Rodar: `wacalls.exe` (porta 8080; flags em `cmd/server/main.go`). O `INICIAR-WACALLS.bat` referencia modo debug na 8080.
4. **A sessão pareada (`wacalls.db`) NÃO vai pro git** — no PC novo, parear de novo pelo painel "Chamadas de voz" na tela Sessões do dashboard (ou pela UI própria do WaCalls), escaneando com o MESMO WhatsApp da sessão WAHA.
5. Sonda de diagnóstico JID: `go build -o probe.exe ./cmd/probe`.

## 📋 Como continuar amanhã (ordem)

1. `cd web && npm install && npm run typecheck && npm test` (guarda: API 545, dashboard 713, worker 101, contracts 8).
2. Subir Call Service (`wacalls.exe`) + `npm run dev:waha`.
3. **E2E saída:** conversa do contato `558585263532` → 📞 Ligar → conceder mic → validar toque + **áudio bidirecional > 30s** + encerrar pelo modal.
4. **E2E entrada:** ligar do celular → modal inbound no dashboard → atender → validar áudio.
5. **E2E LID:** conversa só-@lid → 📞 → validar (observar log do Go: "LID resolved to phone" ou discagem @lid direta).
6. **E2E pareamento:** Sessões → "Conectar chamadas de voz" → escanear QR → status "Conectadas".
7. Se o áudio de entrada morrer após o burst inicial: investigar `internal/voip/call/callmanager_media.go` e o relay RTP (referências em `auditoria/REFERENCIAS-CHAMADAS.md`; fork production-ready alternativo: `AstraOnlineWeb/AstraCalls`; PR tulir/whatsmeow#1201 trará control plane oficial).
8. Depois do E2E: repassar `incoming-claimed` na API (fechar modal nas outras abas) e registrar resultado em `auditoria/REFERENCIAS-CHAMADAS.md`.

## 📁 Referências rápidas

- Auditoria completa: `auditoria/RELATORIO-AUDITORIA-CHAMADAS-WHATSAPP.md`, `auditoria/PLANO-CALL-SERVICE.md`, `auditoria/REFERENCIAS-CHAMADAS.md`
- Chamadas API: `web/apps/api/src/services/call.service.ts` + `controllers/calls.controller.ts`
- Softphone: `web/apps/dashboard/src/ui/useCalls.ts`, `CallModal.tsx`, `softphone.ts`
- Pareamento: `web/apps/dashboard/src/ui/CallPairing.tsx` + Go `cmd/server/broker.go` (`SessionInfo.QR`)
- Regras do projeto: `CLAUDE.md` na raiz
