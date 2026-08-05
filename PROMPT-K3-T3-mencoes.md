# PROMPT K3 — PR-T3: Menções (@) em Grupos

## ⚠️ REGRAS ABSOLUTAS (leia antes de tudo)
1. **Workspace:** `C:\Projeto Salo\ChatPro\ChatPro Main`
2. **Git:** já deu `git pull` de `https://github.com/SALOMBRAS/ProChat` — branch `feat/replace-repository-with-chatpro`, working tree atualizada.
3. **SUPABASE:** usar SEMPRE e APENAS as credenciais do `.env` / `.env.local` do projeto local. NUNCA acesse, modifique ou execute operações em qualquer instância Supabase externa, cloud ou cadastrada em você mesmo.
4. **NÃO criar migrations, NÃO alterar schema, NÃO aplicar SQL remoto** sem solicitação explícita.
5. **Terminar sempre com:** `npm run typecheck` + `npm test` + `npm run build` + `git diff --check`.
6. O projeto usa TypeScript, React 18/Vite, Express 5, Zod, Vitest, WebSocket, Supabase e `better-sqlite3`. Monorepo em `web/` (npm workspaces).
7. Leia `CLAUDE.md` na raiz antes de qualquer alteração.
8. **ATENÇÃO:** este repositório está sendo editado por múltiplas sessões/agentes simultaneamente. Antes de editar qualquer arquivo "quente" (`Inbox.tsx`, `waha-webhook.service.ts`, `inbox.controller.ts`, `MessageMedia.tsx`, `v1.ts`), confirme que não há outro escritor ativo.

---

## 📋 Contexto da Feature

A feature **T3 — Menções (@) em Grupos** está **100% investigada e planejada**, mas **0% implementada** — NENHUM código foi escrito na sessão que gerou o documento.

### Objetivo
Permitir que o operador, numa conversa de **grupo**, digite `@`, veja um autocomplete de participantes, selecione e envie a mensagem com menção **funcionando de verdade no WhatsApp** do destinatário. Mensagens recebidas com menções devem ser renderizadas com destaque visual.

### Comportamento esperado
Digitar `@` → lista abre → filtrar por nome/número → ↑/↓ navegam → Enter/Tab selecionam → Esc fecha → `@Nome` entra no texto → enviar → destinatário é notificado → mensagens com menção exibem `@Nome` destacado → múltiplas menções funcionam.

### Limitações aceitas no plano
1. Menção é texto puro no textarea (não é chip contenteditable). Apagar descarta a menção no envio.
2. Participantes podem estar desatualizados (tabela `whatsapp_group_participants` nunca faz DELETE de quem saiu).
3. JIDs `@lid` são primeira classe — menções recebidas vêm `@lid`; envio usa o JID armazenado.
4. `mentions: ["all"]` (mencionar todos) está fora de escopo.
5. Menções em conversa direta (1:1) são rejeitadas com 400.

---

## 📖 Documento de Contexto Completo

Leia INTEIRO o arquivo antes de qualquer ação:
**`C:\Users\Salombras\Downloads\PR-T3-mencoes.md`**

Este documento contém:
- §1: Visão geral e funcionamento por camada
- §2: Arquitetura de ponta a ponta + onde cada dado mora
- §3: Exploração realizada (todos os arquivos já analisados — NÃO refazer)
- §4: **Blueprint de implementação arquivo por arquivo** (o coração do documento)
- §5: Mecânica completa (autocomplete, envio, renderização)
- §6-7: Resumo executivo backend e frontend
- §8: Testes — cenários a cobrir (planejado, nenhum criado)
- §9: Pendências
- §10: Supabase (somente leitura)
- §11: Roteiro de testes em localhost
- §12: Estado final (investigação 100%, implementação 0%)

---

## ✅ O que você deve fazer

### Ordem de implementação (seguir RIGOROSAMENTE):
1. **`packages/contracts/src/index.ts`** — `internalSendMessageCommandSchema.payload` ganha `mentions` opcional
2. **`apps/worker/src/ports.ts`** — `WorkerCommand` tipo carrega `mentions?: readonly string[]`
3. **`apps/worker/src/internal-transport-server.ts`** — repasse de `mentions` no comando
4. **`apps/worker/src/waha-provider.ts`** — `sendText` repassa `mentions` ao client
5. **`apps/worker/src/waha-client.ts`** — body da WAHA inclui `mentions` quando presente
6. **`apps/api/src/services/waha-webhook.service.ts`** — `listGroupParticipants` nas duas implementações (SQLite + Supabase)
7. **`apps/api/src/controllers/inbox.controller.ts`** — schema `mentions` + validações semânticas + endpoint GET participants
8. **`apps/api/src/services/internal-inbox.service.ts`** — `send` aceita e repassa `mentions`
9. **`apps/api/src/routes/v1.ts` + `app.ts`** — rota `/inbox/conversations/:conversationId/participants` + composição `identitySync`
10. **`apps/dashboard/src/api/inbox.ts`** — `sendMessage` com `mentions` + novo `participants()`
11. **`apps/dashboard/src/ui/mentions.ts` (novo)** — helpers puros testados
12. **`apps/dashboard/src/ui/MentionAutocomplete.tsx` (novo)** — componente de popup
13. **`apps/dashboard/src/ui/Inbox.tsx`** — integração completa (trigger, teclado, seleção, submit, render)
14. **`apps/dashboard/src/ui/styles.css`** — estilos `.composer-mention*` e `.message-mention` (somente hex já existentes)

### Testes (§8.2 do documento T3):
- Contracts: comando com mentions válido/inválido/ausente
- Worker: body inclui/exclui mentions; repasse ao client
- API: endpoint devolve participantes; envio persiste mentions; validações (grupo, formato, pertencimento)
- Dashboard: `@` abre lista; filtro; navegação ↑↓/Enter/Tab/Esc; submit serializa; render destaca; múltiplas menções

### SEMPRE:
- Validar: typecheck → testes (4 workspaces) → build → `git diff --check`
- Reportar: arquivos alterados, motivos, como testar, limitações

---

## 🚨 Atenções Especiais

- **Este é o documento mais detalhado dos 4.** A seção §4 tem o blueprint EXATO de cada arquivo, com "Antes" e "Depois". Siga-a rigorosamente.
- **Números de linha no documento referem-se ao estado da investigação e VÃO DERIVAR** após o `git pull`. Use-os como ponto de partida e **revalide com `Grep` antes de editar**.
- O arquivo `Inbox.tsx` está sob **edição concorrente ativa** — reler imediatamente antes de cada `Edit`.
- O contrato interno (`internalSendMessageCommandSchema`) é **estrito** — enviar `mentions` sem atualizar o schema quebra o parse no worker (400).
- A WAHA exige `@dígitos` no texto, não `@Nome` — o dashboard converte na serialização do submit.
- Nunca crie migration — usa apenas tabelas existentes (`whatsapp_group_participants`, `whatsapp_groups`, `whatsapp_identities`, `contacts`).
- A validação de pertencimento é **fail-open**: se o grupo não tem participantes sincronizados, não bloqueia o envio.

---

## 📁 Referências rápidas

- Documento completo: `C:\Users\Salombras\Downloads\PR-T3-mencoes.md`
- CLAUDE.md (regras do projeto): `C:\Projeto Salo\ChatPro\ChatPro Main\CLAUDE.md`
- Diretório do projeto: `C:\Projeto Salo\ChatPro\ChatPro Main\web`
- Docs WAHA (mentions): https://waha.devlike.pro/docs/how-to/send-messages/
