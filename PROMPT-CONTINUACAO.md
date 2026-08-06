# PROMPT DE CONTINUAÇÃO — ChatPro (T2 contatos concluído, chamadas WIP)

> Cole este arquivo inteiro como primeira mensagem no novo computador.
> Ele substitui o contexto da conversa anterior: conta o que foi feito,
> onde o trabalho parou e como continuar.

## ⚠️ REGRAS ABSOLUTAS (leia antes de tudo)

1. **Repositório:** `https://github.com/SALOMBRAS/ProChat` — branch de trabalho `develop/chatpro-main`.
2. **Setup no PC novo:** `git clone` (ou `git pull` se já existir), `git checkout develop/chatpro-main`, `cd web && npm install`.
3. **SUPABASE:** usar SEMPRE e APENAS as credenciais do `.env` / `.env.local` do projeto local. NUNCA acesse instância Supabase externa. O `.env.local` NÃO está no git — copie o seu de um backup seguro ou recrie a partir do `web/.env.example`.
4. **NÃO criar migrations, NÃO alterar schema, NÃO aplicar SQL remoto** sem solicitação explícita.
5. **Terminar sempre com:** `npm run typecheck` + `npm test` + `npm run build` + `git diff --check` (em `web/`).
6. Stack: TypeScript, React 18/Vite, Express 5, Zod, Vitest, WebSocket, Supabase + `better-sqlite3`. Monorepo em `web/` (npm workspaces: `apps/api`, `apps/worker`, `apps/dashboard`, `packages/contracts`).
7. Leia `CLAUDE.md` na raiz antes de qualquer alteração.
8. **Rodar local:** `npm run dev:waha` em `web/` (sobe WAHA + worker + API + dashboard; exige Docker e `.env.local` com `WHATSAPP_DEMO_MODE=false`, `WHATSAPP_CONNECTION_ENABLED=true`, `WAHA_API_KEY` ≥ 32 chars). Reinício: Ctrl+C e rode de novo; ele recusa subir se as portas 3000/3101/5173 estiverem ocupadas — espere uns segundos.

## ✅ O que ESTÁ PRONTO (commit `6fc802f` — T2 compartilhamento de contatos vCard)

Feature T2 completa: enviar/receber cartões de contato, "Conversar" e CRM a partir do cartão, e **sincronização da agenda do WhatsApp com UI no picker**.

O que foi entregue nesta última rodada:

1. **Classificação correta da agenda:** `GET /api/contacts/all` da WAHA devolve TUDO que a sessão Web conhece (medido: 9.265 itens, dos quais só 182 são contatos salvos). O sync agora classifica **por item**: só `isMyContact === true` recebe origem `waha_contact_sync` (celular); o resto é `waha_chat_history`. Arquivo: `apps/api/src/services/whatsapp-contact-sync.service.ts`.
2. **Reparo de nome:** a resolução de identidade (RPC `chatpro_resolve_contact_identity`) só usa o nome na CRIAÇÃO do contato. Contatos antigos criados pelo webhook com LID como "nome" nunca ganhavam nome. Novo `ContactNameRepair` (`apps/api/src/services/contact-identity-resolver.service.ts`): após resolver, se o `display_name` atual é técnico (só dígitos/pontuação de telefone ou vazio), ele é trocado pelo `pushname`/`name` do WhatsApp. **Nome real (inclusive CRM/operador) NUNCA é sobrescrito.**
3. **LID → telefone real:** comando interno `lids.page` ponta a ponta (contracts → worker → WAHA) resolve o `pn` de cada `@lid` na ingestão.
4. **Picker em lotes (ideia do dono, para não sobrecarregar):** abre mostrando **só os contatos do celular** (`GET /domain/contacts?origin=phonebook`, ~150). A lupa pesquisa **no servidor** em lotes de 150 (`search` + `page` + `pageSize=150`), com debounce de 300 ms, botão "Carregar mais (N de total)", dedup por id entre lotes e ticket contra corrida de respostas. Arquivos: `apps/dashboard/src/ui/ContactPicker.tsx`, `Inbox.tsx` (`loadPhonebookContacts`, `searchContacts`).
5. **Filtro `origin` na listagem:** `EXISTS`/`NOT EXISTS` no SQLite; lote de ids + `in`/`not in` no Supabase. `pageSize` máximo subiu para 500.

**Estado dos portões no commit:** typecheck 4/4 ✓ · contracts 8/8 · API 545/545 · worker 101/101 · dashboard 713/713 ✓ · build ✓ · `git diff --check` ✓.

**Operações de dados já feitas no Supabase de produção (com backup JSON local na máquina de origem, não commitados):** cura LID→número em 3.325 contatos + 921 identidades; DELETE de 12.046 `contact_identifiers` com source `waha_contact_sync` errada (a reclassificação acontece no próximo "Sincronizar contatos").

## 🚧 O que está WIP (commit `a402cbe` — sessão paralela de chamadas de voz)

Call Service (Go) paralelo à WAHA para chamadas de voz WhatsApp: `calls.controller.ts`, `call.service.ts`, rotas `/calls`, softphone WebRTC no dashboard (`useCalls`, `CallModal`, `pcm`, worklets), evento realtime `call.updated`. **Não está validado ponta a ponta.** A auditoria está em `auditoria/` (só docs; a toolchain Go em `tools/` e os repos de referência clonados ficam fora do git — 327 MB + 277 MB, ver `.gitignore`).

Também já commitados antes: T1 reações, T3 menções em grupos, T4 documentos/link preview.

## 📋 Como continuar amanhã

1. **Valide o ambiente:** `cd web && npm install && npm run typecheck && npm test`.
2. **Teste manual do T2 (se ainda não validou em produção):** `npm run dev:waha`, Ctrl+Shift+R no navegador, abrir "Enviar contato" numa conversa:
   - abre só com os contatos do celular (~150);
   - "Sincronizar contatos" reclassifica tudo (celular × histórico) e preenche nomes faltantes;
   - lupa encontra qualquer um da base, 150 por vez, sem duplicar.
3. **Próximos passos naturais (nesta ordem):**
   - Se o dono relatar nomes/fotos faltando: enriquecimento assíncrono (fila `identitySync`, cache 24 h) — verificar se o worker está processando.
   - WIP chamadas: validar o Call Service de ponta a ponta (subir o serviço Go, testar `POST /calls`, aceitar/recusar no modal).
   - Problema conhecido nº 1 do produto: **mensagens de grupos aparecendo como conversas privadas** — corrigir no fluxo do webhook WAHA antes de criar contacts/conversations.
4. **Não misture** o trabalho de chamadas com correções de contatos: commits separados por feature.

## 📁 Referências rápidas

- Sync de contatos: `web/apps/api/src/services/whatsapp-contact-sync.service.ts` (testes: `web/apps/api/test/whatsapp-contact-sync.service.test.ts`)
- Reparo de nome: `web/apps/api/src/services/contact-identity-resolver.service.ts` (`isTechnicalDisplayName`, `ContactNameRepair`)
- Filtro de origem: `web/apps/api/src/persistence/contact-query.ts` + repositórios `sqlite-`/`supabase-domain.repository.ts`
- Picker: `web/apps/dashboard/src/ui/ContactPicker.tsx` (testes: `InboxContactPicker.test.tsx`, `ContactPickerSync.test.tsx`)
- Regras do projeto: `CLAUDE.md` na raiz
