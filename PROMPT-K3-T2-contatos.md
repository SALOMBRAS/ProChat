# PROMPT K3 — PR-T2: Compartilhamento de Contatos vCard

## ⚠️ REGRAS ABSOLUTAS (leia antes de tudo)
1. **Workspace:** `C:\Projeto Salo\ChatPro\ChatPro Main`
2. **Git:** já deu `git pull` de `https://github.com/SALOMBRAS/ProChat` — branch `feat/replace-repository-with-chatpro`, working tree atualizada.
3. **SUPABASE:** usar SEMPRE e APENAS as credenciais do `.env` / `.env.local` do projeto local. NUNCA acesse, modifique ou execute operações em qualquer instância Supabase externa, cloud ou cadastrada em você mesmo.
4. **NÃO criar migrations, NÃO alterar schema, NÃO aplicar SQL remoto** sem solicitação explícita.
5. **Terminar sempre com:** `npm run typecheck` + `npm test` + `npm run build` + `git diff --check`.
6. O projeto usa TypeScript, React 18/Vite, Express 5, Zod, Vitest, WebSocket, Supabase e `better-sqlite3`. Monorepo em `web/` (npm workspaces).
7. Leia `CLAUDE.md` na raiz antes de qualquer alteração.

---

## 📋 Contexto da Feature

A feature **T2 — Compartilhamento de Contatos vCard** está **~85% completa**. O que funciona:
- ✅ Envio de vCard (operador → WhatsApp) — 100%
- ✅ Recebimento + renderização de cartão — 100%
- ✅ "Conversar" a partir do cartão (abrir conversa) — 100%
- ✅ CRM a partir do cartão — 100%
- ✅ Sync da agenda → base interna (backend) — 100%
- ❌ **UI da sincronização da agenda** — **0%** (pendência obrigatória nº 1)
- ❌ Guarda `syncKind === 'contacts'` no handler realtime — ainda pendente

### Objetivo
Dar ao operador do ChatPro a mesma experiência de contatos do WhatsApp oficial: enviar contatos como cartão (vCard), receber cartões renderizados, agir sobre eles ("Conversar", "Ver no CRM"), e sincronizar a agenda do WhatsApp conectado.

---

## 📖 Documento de Contexto Completo

Leia INTEIRO o arquivo antes de qualquer ação:
**`C:\Users\Salombras\Downloads\PR-T2-contatos.md`**

Este documento contém:
- §1: Visão geral e fluxos completos (envio, recebimento, "Conversar", sync)
- §2: Arquitetura e mapa de componentes
- §3: Exploração realizada (auditorias A e B — NÃO refazer)
- §4: Implementações arquivo por arquivo (o que já existe vs. o que falta)
- §5: Sincronização da agenda (backend completo, UI pendente)
- §6-8: Operações, backend e frontend detalhados
- §9: Testes (todos verdes; pendentes listados)
- §10: Pendências — **a UI do sync é a prioridade**
- §11: Supabase (somente leitura)
- §12: Incidente de sessões concorrentes (lição obrigatória)
- §13: Roteiro de testes em localhost
- §14: Estado final

---

## ✅ O que você deve fazer

### PRIORIDADE 1 (obrigatório — bloqueia o objetivo "agenda do WhatsApp"):
1. **UI da sincronização da agenda** — O backend existe (`POST /api/v1/domain/contacts/sync`), mas só é chamável via `curl`. Implementar:
   - Botão no `ContactPicker` para disparar o sync
   - `DomainApi.startContactSync` / `contactSyncStatus` no frontend
   - Polling de 2s enquanto `pending`/`running`
   - Refresh da busca do picker ao concluir
   - Progresso via `progressLabel` do evento realtime
2. **Guarda `syncKind === 'contacts'`** no handler realtime do Inbox (`Inbox.tsx`) — 1 linha para não corromper o banner do history sync.

### PRIORIDADE 2 (melhorias — não bloqueiam):
3. Throttle + retry no `identity.sync` (flood de chamadas WAHA)
4. Atualizar `docs/inbox-cartao-de-contato.md` (documentação desatualizada)
5. Travas de teste pendentes da §9.2

### SEMPRE:
- Validar: typecheck → testes (497 API, 654 dashboard) → build → `git diff --check`
- Reportar: arquivos alterados, motivos, como testar

---

## 🚨 Atenções Especiais

- **O documento T2 foi escrito APÓS a consolidação de sessões concorrentes** — a árvore já foi limpa, mas o working tree ainda contém WIP de outras features (reações, link preview). Não misture.
- O estado dos portões no documento: typecheck 4/4 ✓ · testes contracts ✓ worker ✓ api 497/497 ✓ dashboard 654/654 ✓ · build ✓ · `git diff --check` ✓. Após o `git pull`, **revalide tudo**.
- A rota `POST /inbox/conversations/open` deve estar registrada **ANTES** de `/inbox/conversations/:conversationId` em `v1.ts` — senão "open" cai no parâmetro UUID.
- Nunca crie migration — a feature usa somente tabelas e RPCs já existentes.
- O `displayName` no schema de `openConversation` é aceito e **ignorado** (decisão documentada) — não tente usar sem ler a §10.2.

---

## 📁 Referências rápidas

- Documento completo: `C:\Users\Salombras\Downloads\PR-T2-contatos.md`
- CLAUDE.md (regras do projeto): `C:\Projeto Salo\ChatPro\ChatPro Main\CLAUDE.md`
- Diretório do projeto: `C:\Projeto Salo\ChatPro\ChatPro Main\web`
