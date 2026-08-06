# PR-T1 — Passagem de Contexto: Sistema de Reações em Mensagens

> **Propósito deste documento:** permitir que outro engenheiro (ou agente) continue
> o trabalho da funcionalidade de reações **sem repetir nenhuma investigação**.
> Tudo o que foi explorado, decidido e planejado está aqui com caminhos, linhas e
> trechos exatos.
>
> **Estado da sessão que gerou este documento:**
> - Exploração/auditoria: **100% concluída** (3 subagentes exploradores + leituras
>   diretas de todos os arquivos críticos + inspeção do banco SQLite local).
> - Implementação: **0% — NENHUM arquivo foi alterado nesta sessão.**
> - Testes novos: **0 — nenhum teste foi criado nesta sessão.**
> - O `git status` sujo (57 arquivos) é **trabalho pré-existente de sessões
>   anteriores** — a própria feature de reações já estava não commitada antes
>   desta sessão (ver §estado_final).
>
> **Regras em vigor (AGENTS.md, prioridade máxima):** Supabase é SOMENTE CONSULTA —
> nunca criar/alterar/aplicar migration/executar SQL de escrita; reutilizar a
> arquitetura existente; modificar apenas arquivos necessários; toda alteração
> termina com typecheck + testes + build + `git diff --check`.

---

## 1. Visão geral

### 1.1 Objetivo da funcionalidade

Reações a mensagens da inbox (estilo WhatsApp Web): o operador reage com emoji a
uma mensagem, a reação vai para o WhatsApp via WAHA, persiste localmente, e aparece
em tempo real para todos os operadores do workspace. Reações feitas por contatos
(ou pelo próprio número, via telefone) chegam por webhook e aparecem na inbox.

### 1.2 Comportamento esperado (paridade com WhatsApp Web)

- Uma reação **por autor** por mensagem: reagir de novo com outro emoji **substitui**;
  reagir com o mesmo emoji **remove** (toggle).
- Remoção = emoji vazio (`""`) no protocolo WAHA.
- Do ponto de vista do WhatsApp, reações do operador (via dashboard) e do telefone
  são **da mesma conta** (`fromMe=true`): só existe UMA reação `fromMe` por mensagem.
- Reação aparece imediatamente para quem enviou (otimismo) e via realtime para os
  demais operadores; sobrevive a refresh e reconnect.

### 1.3 Fluxo completo (como está implementado hoje)

**Operador → WhatsApp (outbound):**

```
MessageBubble.handleReact (apps/dashboard/src/ui/Inbox.tsx:230)
  → InboxApi.react (apps/dashboard/src/api/inbox.ts:47)
    → POST /api/v1/inbox/conversations/:conversationId/messages/:messageId/reactions { emoji }
      → InboxController.sendReaction (apps/api/src/controllers/inbox.controller.ts:124)
        → InternalInboxService.sendReaction (apps/api/src/services/internal-inbox.service.ts:59)
          1. getConversation → 404 se não existir
          2. sessionActivity.assertActive
          3. busca mensagem via listMessages(workspaceId, conversationId, 1, 10_000)  ← BUG P10
          4. getOperatorReaction → toggle: mesmo emoji ⇒ alvo '' (remover); diferente ⇒ substituir
          5. worker.send({ type: 'message.sendReaction', payload: { wahaSession, chatId, messageId, reaction } })
             → internal-transport-server (apps/worker/src/internal-transport-server.ts:40)
             → WahaProvider.sendReaction (apps/worker/src/waha-provider.ts:92)
             → WahaClient.sendReaction = PUT /api/reaction no WAHA (apps/worker/src/waha-client.ts:126)
          6. após 200 do WAHA: recordOperatorReaction / removeOperatorReaction
             → ingestReaction (persistência otimista, fromMe=true, autor 'operator:<userId>')
          7. realtime.publish('message.reaction.updated', { conversationId, messageId, reactions })
          8. responde { messageId, reactions }  ← frontend DESCARTA (BUG F1)
```

**WhatsApp → operadores (inbound):**

```
WAHA emite evento message.reaction  ← NUNCA EMITE com a config atual (BUG P2)
  → POST /api/v1/webhooks/waha (apps/api/src/app.ts:118)
    → WahaWebhookController.receive (apps/api/src/controllers/waha-webhook.controller.ts:11)
      1. verifyWahaWebhook (HMAC sha512)
      2. parseWebhook (zod; acceptedEvents inclui 'message.reaction' — waha-webhook.service.ts:12)
      3. branch message.reaction (linhas 16-27): reactionFrom(stored) (linha 281)
         - emoji = payload.reaction.text ('' = remoção)
         - messageId = payload.reaction.messageId (formato WAHA verbatim, ex. false_5511...@c.us_3EB0...)
         - autor = payload.participant ?? payload.from (se from não for @g.us)
         - id = externalEventId do evento (string arbitrária)  ← BUG P3 no Supabase
      4. reactionStore.ingestReaction(reaction)
      5. se conversationId && action !== 'noop': publish 'message.reaction.updated'
      6. 202 { accepted, duplicate: action === 'noop' }
      (eventos de reação NÃO passam por store.ingest ⇒ não gravam waha_webhook_events — ver P12)
```

**Realtime → frontend:**

```
RealtimeHub.publish (apps/api/src/realtime.ts:10) — broadcast para TODOS os sockets do workspace
  → connectRealtime (apps/dashboard/src/api/realtime.ts) — WebSocket /ws?workspaceId=...&userId=...
    → handler no Inbox (Inbox.tsx:827): substitui message.reactions in-place por messageId
```

**Carga inicial:** `loadLatest` (Inbox.tsx:645) → `GET .../messages?page=1&pageSize=50` →
`listMessages` anexa `reactions` por mensagem em batch (SQLite: IN (...) na linha 113/126;
Supabase: `batchReactions` linha 264, com enriquecimento de nomes via `whatsapp_identities`).

### 1.4 Diferenças em relação ao WhatsApp (estado atual, antes das correções)

| Comportamento | WhatsApp Web | Sistema hoje |
|---|---|---|
| Aparição da própria reação | Imediata (otimista) | Só após round-trip WS; resposta do POST descartada |
| Uma reação por conta (`fromMe`) | Sim | Não — múltiplas linhas `fromMe` coexistem (`operator:A`, `operator:B`, número próprio) |
| Resiliência a queda de WS | Reconecta e ressincroniza | Não reconecta; congela até F5 |
| Reação recebida de contatos/telefone | Aparece | Nunca chega (WAHA não envia o evento com a config atual) |
| Ordem de eventos | Último estado vence | Último EVENTO ENTREGUE vence (sem LWW por timestamp) |

### 1.5 Estado atual (resumo executivo)

A feature **existe e está razoavelmente arquitetada** (tabela própria, PK composta,
upsert, toggle, batch sem N+1, contratos zod), mas tem **3 bugs bloqueantes** que a
impedem de funcionar de ponta a ponta no localhost, além de uma camada frontend
sem otimismo/reconnect e ausência de last-write-wins no backend. Detalhes no §4.

---

## 2. Arquitetura

### 2.1 Frontend (`apps/dashboard`)

- **Sem store global** (sem zustand/redux). Estado de mensagens: `useState<InboxMessage[]>`
  em `Inbox.tsx:312`; reações são o campo `reactions` de cada `InboxMessage`.
- **`MessageBubble`** (componente interno de `Inbox.tsx:224-305`) concentra TODA a UI
  de reações: pills/badges (246-272), tooltip no hover (252-256), popup de detalhes
  no clique (257-268), trigger 😊 (277-281), seletor rápido (282-293) e seletor
  completo (294-302, ~22 emojis). `MessageMedia.tsx` não tem nada de reações.
- Constantes/helpers (módulo, `Inbox.tsx:203-223`): `REACTION_EMOJIS = ["👍","❤️","😂","😮","😢","🙏"]`,
  `REACTION_MORE = "➕"`, `reactionSummary` (agrupa por emoji → {emoji,count,fromMe}),
  `reactionTooltip` (nomes: "Você"/reactorName/reactorPhone/"Contato"), `reactionDetails`.
- Estilos: `apps/dashboard/src/ui/styles.css:637-657` (`.message-reactions`,
  `.message-reaction-badge`(+`.mine`), `.reaction-count`, `.reaction-popup`,
  `.reaction-picker`(+-full), `.reaction-details-popup`).
- HTTP: `InboxApi.react` (`api/inbox.ts:47`) retorna `{messageId, reactions}`;
  `InboxApi.listReactions` (`api/inbox.ts:48`) é **código morto** (nenhum uso).
- WS: `api/realtime.ts` (9 linhas) — ver §2.6.

### 2.2 Backend (`apps/api`)

- Rotas: `apps/api/src/routes/v1.ts:78-79`
  - `POST /inbox/conversations/:conversationId/messages/:messageId/reactions` → `inbox.sendReaction`
  - `GET /inbox/messages/:messageId/reactions` → `inbox.listReactions`
- `InboxController` (`controllers/inbox.controller.ts`):
  - L28: `sendReaction = z.object({ emoji: z.string().trim().min(1).max(32) })`
  - L124: valida conversationId (uuid) e messageId (1-200), delega ao service
  - L125: `listReactions` → `conversations.listReactions(workspaceId, messageId)` — **sem wahaSession** (P11)
- `InternalInboxService.sendReaction` (`services/internal-inbox.service.ts:59-78`) — ver §1.3.
  - `statusFor` (L11) mapeia códigos: VALIDATION_ERROR 400, NOT_FOUND 404, CONFLICT 409,
    TIMEOUT 504, SERVICE_UNAVAILABLE 503, PROVIDER_CONTRACT_ERROR 502.
- `WahaWebhookController.receive` (`controllers/waha-webhook.controller.ts:11-46`) —
  branch de reação nas linhas 16-27 (ver §1.3). Responde 202 sempre que o payload é
  válido; payload malformado ⇒ log `invalid_reaction_payload` + 202 (descarte silencioso).

### 2.3 Worker (`apps/worker`)

- Só participa do caminho de **saída**. Não há fila: transporte interno HTTP síncrono.
- `internal-transport-server.ts:40-43`: converte comando interno `message.sendReaction`
  em `WorkerCommand { type: 'sendReaction' }`; resposta envelopada `{ reactionSent: { timestamp } }`.
- `ports.ts:5`: tipo `WorkerCommand`.
- `waha-provider.ts:92-100`: resolve sessão por alias (`matchesWaha`), exige status
  `connected`, chama o client.
- `waha-client.ts:126-133`: **`PUT /api/reaction`** com `{ session, messageId, reaction }`;
  `reaction: ""` remove. `messageId` repassado verbatim (formato serializado WAHA,
  mesmo id gravado como `externalMessageId` — consistente com o webhook).
  (Nota histórica: `createSession` em `waha-client.ts:61` configura só `{ name }` —
  não registra webhook por sessão; os eventos vêm do env `WHATSAPP_HOOK_EVENTS`.)
- `baileys-whatsapp-worker.adapter.ts:13`: `sendReaction` lança `NOT_IMPLEMENTED`
  ("Reactions are available only for the WAHA provider"). Decisão: **manter assim**.

### 2.4 WAHA

- Contêiner via `docker-compose.waha.yml` (dev) e `deploy/docker-compose.prod.yml` (prod).
- Envio: `PUT /api/reaction` (correto, já funciona).
- Recebimento: depende de `WHATSAPP_HOOK_EVENTS` — **hoje sem `message.reaction`** (P2).
- Suposição do código (comentário em `internal-inbox.service.ts:54-58`): o WAHA **não
  ecoa** `message.reaction` para envios feitos pela API — por isso a persistência do
  operador é otimista. Reações feitas NO TELEFONE emitem o evento com `fromMe=true`.

### 2.5 WebSocket / Realtime

- `apps/api/src/realtime.ts:10-13`: `RealtimeHub.publish` itera sockets com
  `audience === workspaceId` — broadcast por workspace, **sem** direcionamento por
  conversa/operador. Evento: `message.reaction.updated`, payload
  `{ conversationId, messageId, reactions: MessageReaction[] }` (lista completa recalculada).
- `workspaceId` do webhook vem de config estática `WAHA_WEBHOOK_WORKSPACE_ID`
  (`apps/api/src/config.ts:53`).
- Frontend: `connectRealtime(onEvent)` abre `WebSocket` em
  `VITE_API_URL.replace(/^http/,'ws') + /ws?workspaceId=<VITE_WORKSPACE_ID|'default-workspace'>&userId=<VITE_USER_ID|'00000000-0000-4000-8000-000000000001'>`.
  **Sem reconnect, sem backoff, sem heartbeat, sem ressincronização.**

### 2.6 Persistência (dual: SQLite local OU Supabase, por `DATABASE_PROVIDER`)

- Mesma classe-objeto implementa `WahaWebhookStore` + `ConversationStore` + `ReactionStore`:
  `SqliteWahaWebhookStore` e `SupabaseWahaWebhookStore`, ambos em
  `apps/api/src/services/waha-webhook.service.ts` (arquivo de 496 linhas, com linhas
  longas de até 3.256 chars — **o Read trunca em 2.000 chars; para editar, extraia a
  linha exata com `sed -n '<N>p' | fold`**).
- Wiring: `apps/api/src/app.ts:102` escolhe o store por `databaseProvider`.
- **Tabela `message_reactions`** (uma reação por mensagem×autor):
  - SQLite (`apps/api/migrations/025_message_reactions.sql`): `id TEXT NOT NULL`,
    `workspaceId`, `wahaSession`, `messageId`, `authorWhatsappId`, `authorName TEXT NULL`,
    `emoji`, `fromMe INTEGER CHECK IN (0,1)`, `occurredAt`, `receivedAt`,
    **PK (workspaceId, wahaSession, messageId, authorWhatsappId)**,
    FK composta → `whatsapp_messages(workspaceId, wahaSession, externalMessageId)
    ON DELETE CASCADE`, índice `idx_message_reactions_lookup`.
  - Supabase (`supabase/migrations/20260804000100_message_reactions.sql`): gêmea em
    snake_case, mas **`id uuid PK DEFAULT gen_random_uuid()`** + `UNIQUE(workspace_id,
    waha_session, message_id, author_whatsapp_id)`, mesma FK, GRANT para `service_role`,
    **sem RLS** (acesso só via service_role).
- Interface `ReactionStore` (waha-webhook.service.ts:23):
  `ingestReaction(StoredReaction) → ReactionIngestResult`,
  `listReactions(workspaceId, messageId, wahaSession?)`,
  `getOperatorReaction?({workspaceId, wahaSession, messageId, authorWhatsappId})`,
  `recordOperatorReaction(...)`, `removeOperatorReaction(...)` (ambos delegam a
  `ingestReaction` com `fromMe: true` e `randomUUID()`).
- Tipos (linhas 21-22): `StoredReaction = { id, workspaceId, wahaSession, messageId,
  authorWhatsappId, authorName?, emoji, fromMe, occurredAt, receivedAt, conversationId? }`;
  `ReactionIngestResult = { action: 'inserted'|'updated'|'removed'|'noop',
  conversationId?, messageId, reactions }`.
- Semântica atual de `ingestReaction` (SQLite:152 / Supabase:265, espelhados):
  1. resolve `conversationId` a partir da mensagem (SQLite: JOIN único; Supabase: 2 queries)
  2. `SELECT emoji` da linha existente (para classificar ação)
  3. `emoji === ''` ⇒ `DELETE` pela PK ⇒ action `removed`/`noop`
  4. senão ⇒ upsert `ON CONFLICT (pk) DO UPDATE SET authorName, emoji, fromMe,
     occurredAt, receivedAt` ⇒ action `inserted`/`updated`/`noop`
  5. retorna `reactions` recalculadas via `listReactions`
- `listReactions` enriquece com `whatsapp_identities` (reactorName/reactorPhone):
  SQLite via LEFT JOIN; Supabase via segunda query (`whatsapp_identities.in(...)`).
- Runner de migrations SQLite (`apps/api/src/persistence/database.ts:24-37`):
  **rastreia por nome de arquivo em `schema_migrations`, sem checksum** — migration
  editada depois de aplicada NUNCA é reaplicada (raiz do BUG P1).
- `PRAGMA foreign_keys = ON` (database.ts:21) — FK violada vira erro em runtime.

### 2.7 Contratos (`packages/contracts/src/index.ts`)

- L87-89: `messageReactionSchema` = `{ emoji: string(1..32), reactorWhatsappId:
  string|null, fromMe: boolean, reactorName: string|null, reactorPhone: string|null,
  reactedAt: string.datetime }`; `inboxMessageSchema.reactions` (default `[]`).
- L107: `eventTypes` inclui `'message.reaction.updated'`.
- L179-180: `internalSendReactionCommandSchema` (`message.sendReaction`: wahaSession,
  chatId, messageId, `reaction max(32)` — permite `''` para remoção).
- L195: resposta `{ reactionSent: { timestamp } }`.

---

## 3. Exploração realizada

### 3.1 Arquivos analisados (todos — não repetir)

**Frontend**
| Arquivo | Linhas/seções lidas |
|---|---|
| `apps/dashboard/src/ui/Inbox.tsx` | 1-40 (imports), 195-305 (helpers+MessageBubble), 307-334 (estado), 540-541/552 (refs), 640-769 (loadLatest/loadContext/loadActivity/efeitos), 770-847 (efeito WS), 848-885 (openConversation), 1495-1549 (render, uso do MessageBubble em 1522) |
| `apps/dashboard/src/api/realtime.ts` | inteiro (9 linhas) |
| `apps/dashboard/src/api/inbox.ts` | inteiro (57 linhas) |
| `apps/dashboard/src/ui/styles.css` | 637-657 (estilos de reação) |
| `apps/dashboard/src/ui/MessageMedia.tsx` | via grep: zero referências a reação |

**Backend / Worker / Contratos**
| Arquivo | Linhas/seções lidas |
|---|---|
| `apps/api/src/services/waha-webhook.service.ts` | inteiro (496 linhas; linhas longas em 57, 86, 126, 145, 152, 213, 241, 265, 292 extraídas com `sed`+`fold`) |
| `apps/api/src/services/internal-inbox.service.ts` | inteiro (147 linhas) |
| `apps/api/src/controllers/waha-webhook.controller.ts` | inteiro (48 linhas) |
| `apps/api/src/controllers/inbox.controller.ts` | L28, L73, L124-125 |
| `apps/api/src/routes/v1.ts` | L78-79 |
| `apps/api/src/realtime.ts` | L10-13 |
| `apps/api/src/config.ts` | L53 |
| `apps/api/src/app.ts` | L102, L118 |
| `apps/api/src/persistence/database.ts` | inteiro (45 linhas) |
| `apps/worker/src/internal-transport-server.ts` | L40-43 |
| `apps/worker/src/ports.ts` | L5 |
| `apps/worker/src/waha-provider.ts` | L92-100 |
| `apps/worker/src/waha-client.ts` | L61, L126-133 |
| `apps/worker/src/baileys-whatsapp-worker.adapter.ts` | L13 |
| `packages/contracts/src/index.ts` | L87-89, L107, L179-180, L195 |

**Persistência / Config / Testes / Scripts**
| Arquivo | O que foi verificado |
|---|---|
| `apps/api/migrations/025_message_reactions.sql` | inteiro (schema com `id`+`authorName`) |
| `supabase/migrations/20260804000100_message_reactions.sql` | inteiro (schema com `id uuid`) |
| `supabase/migrations/002_waha_webhook_store.sql` | L5 (CHECK de eventType) |
| `apps/api/migrations/002_waha_webhook_store.sql` | L5 (idem) |
| `.chatpro-data/backend.sqlite` | inspecionado via better-sqlite3 readonly: DDL real de `message_reactions`, contagem de linhas (0), `schema_migrations` (025 aplicada em 2026-08-04T16:27:28.457Z), `whatsapp_messages` (0 rows) |
| `docker-compose.waha.yml` | L35 (`WHATSAPP_HOOK_EVENTS`) |
| `deploy/docker-compose.prod.yml` | L98 (idem) |
| `apps/api/test/message-reactions.test.ts` | inteiro (119 linhas, 8 testes) |
| `apps/api/test/waha-webhook.test.ts` | L39 (teste que fixa "sem linha em webhook events") |
| `package.json` (raiz) + `apps/*/package.json` | scripts dev/build/typecheck/test |
| `scripts/waha-runtime.mjs` | L1-40 — **força `DATABASE_PROVIDER='supabase'`** e `WHATSAPP_PROVIDER='waha'` após subir o compose |
| `scripts/local-runtime.mjs` | L1-30 — default `DATABASE_PROVIDER ?? 'sqlite'`; API escuta em 127.0.0.1 + gateway docker0 |
| `docs/` | grep por "reaç/reaction/emoji": não existe doc da feature; menções a "reaction" em outros docs são o *tipo técnico de mensagem* (outro conceito). `docs/divergencias-sqlite-supabase.md` é anterior à feature e não cobre `message_reactions` |

### 3.2 Decisões já tomadas (não reabrir sem motivo)

1. **Corrigir a implementação existente, nunca criar fluxo paralelo** (restrição do
   usuário + REGRA 2 do AGENTS.md).
2. **Bug do `id uuid` no Supabase será corrigido EM CÓDIGO** (aceitar `input.id` só se
   for uuid válido; senão `randomUUID()`), e **NÃO** editando
   `supabase/migrations/20260804000100_message_reactions.sql` — o arquivo pode já ter
   sido aplicado no remoto; editá-lo criaria drift; e aplicar qualquer coisa é proibido.
3. **Last-write-wins em código** nos dois stores (comparar `occurredAt` antes de
   escrever/apagar). PostgREST não suporta upsert condicional e é proibido criar
   RPC/function no Supabase. No SQLite a sequência SELECT→write é atômica na prática
   (better-sqlite3 é síncrono, Node single-thread). Janela residual de corrida no
   Supabase fica documentada como limitação.
4. **Nova ação `'orphan'`** no union de `ReactionIngestResult.action` para reação a
   mensagem desconhecida: retorna 202 sem publish e sem escrever → mata o retry
   infinito do WAHA e a violação de FK.
5. **Reconciliação `fromMe`**: qualquer escrita `fromMe=true` remove as demais linhas
   `fromMe` da mesma mensagem (paridade WhatsApp: uma reação por conta). Cobre:
   telefone substituindo reação de operador, operador substituindo reação do telefone,
   e remoção vinda do telefone limpando reações de operadores.
6. **`getOperatorReaction` passa a casar por `fromMe` (qualquer autor)** em vez de
   `authorWhatsappId` — porque a UI trata qualquer reação `fromMe` como "mine"
   (badge `.mine`, tooltip "Você"). Mantém o NOME do método (diff mínimo); ajustar
   comentário. Assim o toggle no dashboard fica consistente com o que a UI mostra.
7. **SQLite local**: correção one-off manual (DROP TABLE + recriar conforme a 025
   atual; tabela tem 0 rows → perda zero). **Não criar migration 026** (SQLite não
   tem `ADD COLUMN IF NOT EXISTS`; uma 026 quebraria bancos frescos onde a 025 já
   cria as colunas).
8. **Frontend: otimismo verdadeiro com rollback** (o toggle é calculável no cliente:
   a reação `fromMe` atual está no estado), reconciliando com a resposta do POST.
9. **`realtime.ts`: reconnect com backoff exponencial (1s → ×2 → teto 15s) + callback
   `onReconnect`** → no Inbox, ressincroniza (`loadLatest` da conversa aberta +
   `refreshConversations`).
10. **NÃO mexer no CHECK de `waha_webhook_events.eventType`** (exigiria migration no
    Supabase — proibido). Consequência aceita: reações seguem sem trilha de auditoria
    bruta (limitação documentada).
11. **GET `listReactions` sem `wahaSession`**: bug real mas o endpoint é código morto
    no frontend → prioridade baixa; correção proposta: query param opcional `wahaSession`.
12. **Baileys adapter**: manter `NOT_IMPLEMENTED` (provider não usado nos runtimes atuais).
13. **Publish do operador**: alinhar com o webhook — publicar só quando houver
    `conversationId`; manter publish mesmo em `noop` é aceitável (idempotente no
    frontend), mas preferir suprimir `noop` para simetria (decisão final na
    implementação; qualquer uma funciona).

### 3.3 Como a exploração foi feita

3 subagentes `explore` em paralelo (frontend / backend / persistência) + leituras
diretas do agente principal em todos os arquivos críticos + inspeção do SQLite local
via better-sqlite3 readonly + `git status` (confirmou que a sujeira é pré-existente).

---

## 4. Auditoria — problemas encontrados (todos AINDA NÃO CORRIGIDOS)

### 4.1 Bloqueantes (impedem o checklist de localhost hoje)

**P1 — SQLite local dessincronizado da migration 025.**
`.chatpro-data/backend.sqlite` tem `message_reactions` **sem as colunas `id` e
`authorName`** (DDL real verificada via `sqlite_master`): a migration foi aplicada em
2026-08-04T16:27 e depois o arquivo foi editado; o runner (`database.ts:24-37`)
rastreia só por nome → nunca reaplica. Consequência: o `INSERT INTO message_reactions
(id, ..., authorName, ...)` de `SqliteWahaWebhookStore.ingestReaction` (linha 152)
falha com `table message_reactions has no column named id` → **reação do operador
quebra no runtime SQLite** (500 após o WAHA já ter enviado — pior caso: WhatsApp
mostra, banco não). Tabela com **0 rows** → correção manual segura.
Nota: os testes passam porque o helper `create()` (`message-reactions.test.ts:9`)
cria banco fresco a partir das migrations atuais.

**P2 — WAHA nunca envia `message.reaction` com a config atual.**
`WHATSAPP_HOOK_EVENTS: message,message.any,session.status` em
`docker-compose.waha.yml:35` **e** `deploy/docker-compose.prod.yml:98`. A API aceita o
evento (`acceptedEvents`, waha-webhook.service.ts:12), mas o WAHA não o entrega →
**reações de contatos e do telefone nunca chegam**; só as do operador (persistidas
otimisticamente) aparecem.

**P3 — `id uuid` do Supabase recebe string não-uuid.**
`SupabaseWahaWebhookStore.ingestReaction` (linha 265) faz upsert de
`row = { id: input.id, ... }`; no caminho inbound `input.id` = `externalEventId` do
WAHA (string arbitrária, ex. `'evt-reaction-👍-...'`) → Postgres rejeita com
`22P02 invalid input syntax for type uuid` → webhook 500 → retry infinito. No SQLite
(TEXT) passa. O caminho do operador funciona nos dois (`randomUUID()`).
**Impacto real no localhost: o runtime `npm run dev:waha` FORÇA
`DATABASE_PROVIDER='supabase'`** (scripts/waha-runtime.mjs) — ou seja, o fluxo
"de verdade" com WAHA usa Supabase e esbarra neste bug; `npm run dev:local` usa
SQLite e esbarra no P1.

### 4.2 Backend — corretude e concorrência

**P4 — Sem last-write-wins por timestamp.** O `ON CONFLICT DO UPDATE` (SQLite:152 /
Supabase:265) sobrescreve `emoji/occurredAt` incondicionalmente; o `DELETE` de remoção
também não compara nada. Eventos fora de ordem (reagir→remover entregues invertidos,
retry antigo) revertem o estado. Contraste: `upsertConversation` já compara
`lastMessageAt`.

**P5 — Check-then-act no Supabase.** SELECT → DELETE/upsert em round-trips separados
sem transação: duas entregas concorrentes do mesmo autor/mensagem classificam `action`
errado — e como `action==='noop'` suprime o publish, uma mudança real pode ficar sem
evento WS. (No SQLite é síncrono — sem corrida.)

**P6 — Reação a mensagem desconhecida quebra a FK.** Se a mensagem alvo não existe em
`whatsapp_messages` (fora do histórico sincronizado), ambos os stores executam o
INSERT/upsert mesmo assim → violação de FK (SQLite tem `PRAGMA foreign_keys=ON`) →
500 no webhook → **retry infinito do WAHA**. O descarte silencioso atual só cobre
payload malformado, não mensagem ausente.

**P7 — Autor sintético + sem reconciliação `fromMe`.** O operador grava
`operator:<userId>` (internal-inbox.service.ts:68). Duas divergências do WhatsApp:
(a) dois operadores podem ter reações `fromMe` simultâneas na mesma mensagem — no
WhatsApp a conta tem uma só; (b) quando o telefone reage (evento `fromMe=true`,
autor = número próprio `@c.us`), nasce uma **segunda linha** para a mesma reação
lógica → emoji duplicado na UI. Também: `recordOperatorReaction` grava
`authorName: null` e o upsert sobrescreve `authorName` com null.

**P8 — Publish assimétrico.** Webhook suprime publish em `noop`
(waha-webhook.controller.ts:24); o fluxo do operador publica sempre que há
`conversationId` (internal-inbox.service.ts:76), inclusive `noop`.

**P9 — Toggle do operador não é atômico.** `getOperatorReaction` → decide → WAHA →
persiste (internal-inbox.service.ts:69-75). Dois cliques concorrentes leem o mesmo
estado; se o WAHA aceitar e a persistência falhar, banco e WhatsApp divergem (sem
reconciliação, já que o WAHA não ecoa). Mitigação parcial já existente: o flag
`reacting` no frontend serializa cliques.

**P10 — Lookup da mensagem no `sendReaction` usa `listMessages(1, 10_000)`.**
(internal-inbox.service.ts:65-66) — mas `listMessages` **clampa grupos a 100**
(SQLite:113 / Supabase:212: `limit = conversationType==='group' ? min(pageSize,100)
: 10_000`). Reagir a mensagem de grupo além das 100 recentes → 404 "Message not
found" mesmo ela existindo.

**P11 — GET `listReactions` sem `wahaSession`.** (inbox.controller.ts:125 →
SQLite:153 / Supabase:266) O filtro é só `(workspaceId, messageId)`; ids WAHA só são
únicos por sessão → após reemparelhamento, reações de sessões diferentes com o mesmo
`messageId` se misturam; o branch Supabase ainda usa `data[0].waha_session` arbitrária
para resolver nomes. **Código morto no frontend** — prioridade baixa.

**P12 — Reações não são auditáveis.** O controller retorna antes de `store.ingest` →
nenhuma linha em `waha_webhook_events` (comportamento fixado pelo teste
`waha-webhook.test.ts:39`). Efeitos: sem reprocessamento/quarentena de reações; o
`id` da linha (externalEventId do 1º evento) não é atualizado no `DO UPDATE`.
O CHECK de `eventType` (`002_waha_webhook_store.sql:5` nos dois bancos) nem inclui
`message.reaction`. **Não corrigir via schema (proibido no Supabase).**

### 4.3 Frontend

**F1 — Sem atualização otimista; resposta do POST descartada.**
`handleReact` (Inbox.tsx:230-236) é 100% pessimista e ignora o retorno
`{messageId, reactions}` — a UI só atualiza se/quando o WS entregar. Latência
percebida alta; WS morto ⇒ reação "some" silenciosamente.

**F2 — Erro invisível.** Falha ao reagir vai só para `console.error` — o operador não
sabe que falhou (comparar com `messagesError`/`messageLoadError` da carga,
Inbox.tsx:1503-1511).

**F3 — WS sem reconnect nem ressync.** `realtime.ts` inteiro (9 linhas): qualquer
queda silenciosa congela reações e mensagens até F5.

**F4 — Handler de reação não valida payload.** Inbox.tsx:827-833: cast direto e
`reactions ?? []` — payload malformado sem `reactions` **apaga** as reações da
mensagem na UI.

**F5 — Evento de reação não dispara catch-up.** Diferente de `message.received/sent`
(Inbox.tsx:835-844), o handler de reação dá `return` antes de `refreshConversations()/
loadLatest()` — ok para o caso feliz, mas não há nenhuma ressincronização pós-queda.

**F6 — Pickers não fecham ao clicar fora nem com Esc**; o "➕" faz toggle do seletor
completo sem fechar o rápido (Inbox.tsx:289) → os dois podem ficar abertos.

**F7 — `reacting` desabilita também os badges** (Inbox.tsx:249), bloqueando abrir os
detalhes durante o envio — efeito colateral de reutilizar o mesmo flag.

**F8 — Chave React fraca no popup de detalhes** (Inbox.tsx:260): `reactorWhatsappId
?? 'anonymous'` + `reactedAt` + `index` — funciona pelo `index`, mas frágil.

**F9 — `listReactions` morto** (`api/inbox.ts:48`) e paginação de mensagens
inexistente no frontend (`messagePage` setado e não usado; `onScroll` 1247-1252 só
atualiza `atBottomRef`) — reações em mensagens fora da última página de 50 nunca são
vistas/atualizadas. (Paginação: fora do escopo desta tarefa; registrar como dívida.)

---

## 5. Implementações (PLANO DETALHADO — nada aplicado ainda)

> Cada item: arquivo, motivo, ANTES (trecho atual), DEPOIS (o que fazer), impacto e
> riscos. Âncoras exatas para localizar o código. Lembrar: `waha-webhook.service.ts`
> tem linhas >2000 chars — extrair a linha com `sed -n '<N>p' <arq> | fold -w 180 -s`
> antes de montar o `old_string` do Edit.

### I1 — `apps/api/src/services/waha-webhook.service.ts` — união de ação + SQLite `ingestReaction` (linha 152)

- **Motivo:** P4 (LWW), P6 (órfãos), P7 (reconciliação fromMe).
- **Antes (estrutura da linha 152, resumo fiel):**
  `const conversation = this.database.prepare('SELECT c.id FROM conversations c JOIN
  whatsapp_messages m ON ... WHERE m.workspaceId=? AND m.wahaSession=? AND
  m.externalMessageId=?').get(...)` — JOIN puro: mensagem ausente e conversa ausente
  são indistinguíveis; `existing = SELECT emoji ...`; `if (emoji==='') DELETE ...`
  sem comparar timestamp; upsert incondicional.
- **Depois:**
  1. Trocar a resolução para distinguir mensagem inexistente:
     `SELECT m.chatId AS chatId, c.id AS conversationId FROM whatsapp_messages m LEFT
     JOIN conversations c ON c.workspaceId=m.workspaceId AND c.wahaSession=m.wahaSession
     AND c.chatId=m.chatId WHERE m.workspaceId=? AND m.wahaSession=? AND
     m.externalMessageId=?` → **sem linha ⇒ `return { action: 'orphan', messageId:
     input.messageId, reactions: [] }`** (sem escrever nada).
  2. `existing` passa a selecionar `emoji, occurredAt`.
  3. **LWW:** se `existing && existing.occurredAt > input.occurredAt` ⇒
     `return { action: 'noop', conversationId, messageId, reactions: await
     this.listReactions(...) }` (estado atual é mais novo que o evento).
  4. **Reconciliação fromMe:** se `input.fromMe` ⇒ antes do delete/upsert, executar
     `DELETE FROM message_reactions WHERE workspaceId=? AND wahaSession=? AND
     messageId=? AND fromMe=1 AND authorWhatsappId != ?` (garante uma única reação
     da conta — paridade WhatsApp; cobre telefone×operador e operador×operador).
  5. Resto inalterado (delete por emoji `''`, upsert ON CONFLICT, classificação
     `inserted/updated/noop` a partir de `existing`).
- **Impacto:** fecha P4/P6/P7 no runtime SQLite; comportamento idempotente e
  ordenado por timestamp.
- **Riscos:** baixo — better-sqlite3 síncrono mantém a sequência atômica; testes
  existentes continuam passando (nenhum cobre órfão/LWW/fromMe cruzado).
  Atualizar o comentário acima do método para refletir LWW+reconciliação.

### I2 — o mesmo arquivo — Supabase `ingestReaction` (linha 265)

- **Motivo:** P3 (uuid), P4, P5 (mitigar), P6, P7.
- **Antes:** `SELECT chat_id FROM whatsapp_messages...` (mensagem ausente não faz
  guarda) → `SELECT emoji` existente → delete/upsert incondicionais →
  `row = { id: input.id, ... }`.
- **Depois (espelhar I1):**
  1. `if (!message) return { action: 'orphan', messageId: input.messageId, reactions: [] }`.
  2. `existingResult` seleciona `'emoji, occurred_at'`.
  3. LWW em código: `existing.occurred_at > input.occurredAt` ⇒ `noop` sem escrever.
  4. Reconciliação: `await this.client.from('message_reactions').delete()
     .eq('workspace_id',...).eq('waha_session',...).eq('message_id',...)
     .eq('from_me', true).neq('author_whatsapp_id', input.authorWhatsappId)`.
  5. **uuid-safe:** `const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)
     ? input.id : randomUUID();` e usar no `row`.
- **Impacto:** fecha P3/P4/P6/P7 no runtime Supabase (o usado por `dev:waha`).
- **Riscos:** check-then-act residual (P5) permanece — janela de ms, documentada;
  sem transação disponível via PostgREST e proibido criar RPC. Aceito.

### I3 — o mesmo arquivo — `getOperatorReaction` (SQLite:154 / Supabase:267)

- **Motivo:** P7 + paridade de toggle com a UI (decisão 6).
- **Antes:** `.find(reaction => reaction.reactorWhatsappId === input.authorWhatsappId)`.
- **Depois:** `.find(reaction => reaction.fromMe)` (qualquer autor fromMe) — a reação
  "do operador" é a reação da CONTA. Manter assinatura/nome; ajustar comentário.
- **Impacto:** clicar no emoji que a conta já reagiu (ex.: feito no telefone) remove,
  em vez de no-op divergente.
- **Riscos:** mínimo; nenhum teste atual exercita o método diretamente.

### I4 — o mesmo arquivo — tipo `ReactionIngestResult` (linha 22)

- **Antes:** `action: 'inserted' | 'updated' | 'removed' | 'noop'`.
- **Depois:** adicionar `'orphan'` ao union.
- **Impacto/riscos:** ampliação de union é retrocompatível; o controller já trata
  (ver I5).

### I5 — `apps/api/src/controllers/waha-webhook.controller.ts` (linhas 23-26)

- **Motivo:** P6 — resposta adequada a órfãos.
- **Antes:** publish se `conversationId && action !== 'noop'`; resposta
  `duplicate: action === 'noop'`.
- **Depois:** manter tudo; garantir que o log diferencie órfão (ex.: incluir
  `discardReason: action === 'orphan' ? 'message_not_found' : null` no log "WAHA
  reaction accepted", ou logar "WAHA reaction discarded" com essa razão). Órfão ⇒
  sem `conversationId` ⇒ já não publica; 202 normal.
- **Riscos:** nenhum funcional.

### I6 — `apps/api/src/services/internal-inbox.service.ts` (linhas 65-66)

- **Motivo:** P10 (404 falso em grupos), P8 (publish assimétrico).
- **Antes:** `const messagePage = await this.conversations.listMessages(
  context.workspaceId, conversationId, 1, 10_000); const existing =
  messagePage.items.find(m => m.id === messageId); if (!existing) throw 404`.
- **Depois:** lookup direto, sem paginação. Opção escolhida: **adicionar método ao
  `ConversationStore`** (interface em waha-webhook.service.ts:57), implementado nos
  dois stores, ex.:
  `messageExists?(workspaceId: string, conversationId: string, messageId: string):
  Promise<boolean>` (SQLite: `SELECT 1 FROM whatsapp_messages m JOIN conversations c
  ON c.workspaceId=m.workspaceId AND c.wahaSession=m.wahaSession AND c.chatId=m.chatId
  WHERE c.workspaceId=? AND c.id=? AND m.externalMessageId=?`; Supabase: duas queries
  ou embed). Opcional (`?`) com fallback para o `listMessages` atual se ausente —
  test doubles em `apps/api/test/*` usam casts `as unknown as ConversationStore`
  (inbox-contact.service.test.ts:88, internal-inbox-content.service.test.ts:17), que
  não quebram com método opcional. Se preferir obrigatório, verificar todos os
  implementadores (só os dois stores em produção).
  Publicar apenas se `result.action !== 'noop'` OU manter — decidir conforme
  decisão 13; ambos corretos.
- **Riscos:** novo método na interface pública do store; testes que mockam
  `listMessages` para este fluxo (verificar `apps/api/test/` por `sendReaction`) —
  se existirem, precisam do mock do novo método.

### I7 — `docker-compose.waha.yml:35` e `deploy/docker-compose.prod.yml:98`

- **Motivo:** P2.
- **Antes:** `WHATSAPP_HOOK_EVENTS: message,message.any,session.status`
- **Depois:** `WHATSAPP_HOOK_EVENTS: message,message.any,session.status,message.reaction`
- **Impacto:** WAHA passa a entregar reações inbound (contatos e telefone).
  **Requer recriar o contêiner** (`docker compose -f docker-compose.waha.yml up -d
  --force-recreate` ou derrubar e subir via `npm run dev:waha`).
- **Riscos:** volume de eventos maior no webhook — mitigado pelo branch dedicado
  (não grava `waha_webhook_events`).

### I8 — SQLite local `.chatpro-data/backend.sqlite` (one-off, NÃO é migration)

- **Motivo:** P1.
- **Como:** com a API parada (ou antes de subir), executar:
  ```bash
  node -e "
  const Database = require('better-sqlite3');
  const db = new Database('.chatpro-data/backend.sqlite');
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TABLE IF EXISTS message_reactions');
  db.exec(require('fs').readFileSync('apps/api/migrations/025_message_reactions.sql','utf8'));
  console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE name='message_reactions'\").get().sql);
  "
  ```
  (0 rows → perda zero; `schema_migrations` já marca 025 como aplicada e o DDL
  recriado é idêntico ao da migration → sem drift.)
- **Riscos:** nenhum além de executar com a API rodando (evitar).

### I9 — `apps/dashboard/src/api/realtime.ts` (reescrita pequena)

- **Motivo:** F3 (+F5 parcialmente).
- **Antes (arquivo inteiro, 9 linhas):** abre `new WebSocket(url)` uma vez;
  `onmessage` faz parse e chama `onEvent`; cleanup = `socket.close()`. Sem reconnect.
- **Depois (manter assinatura compatível + callback opcional):**
  ```ts
  export function connectRealtime(onEvent: (event: RealtimeEvent) => void, onReconnect?: () => void): () => void {
    if (typeof WebSocket === 'undefined') return () => undefined;
    // ...mesma montagem de url...
    let socket: WebSocket | undefined, retries = 0, closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      socket = new WebSocket(url);
      socket.onopen = () => { if (retries > 0) onReconnect?.(); retries = 0; };
      socket.onmessage = event => { /* parse atual, inalterado */ };
      socket.onclose = () => { if (closed) return; const delay = Math.min(15_000, 1_000 * 2 ** retries++); timer = setTimeout(open, delay); };
    };
    open();
    return () => { closed = true; if (timer) clearTimeout(timer); socket?.close(); };
  }
  ```
- **Impacto:** reconexão automática com backoff 1s→15s; `onReconnect` dispara só em
  reaberturas (não na primeira conexão).
- **Riscos:** efeitos que chamam `connectRealtime` continuam válidos; verificar se
  existe teste de `realtime.ts` (grep em `apps/dashboard/src` — nenhum encontrado na
  exploração).

### I10 — `apps/dashboard/src/ui/Inbox.tsx` — handler WS + ressync (linhas 770-847)

- **Motivo:** F4, F5.
- **Depois:**
  1. Passar `onReconnect` ao `connectRealtime`:
     `() => { void refreshConversations(); if (selectedRef.current) void
     loadLatest(selectedRef.current.id, atBottomRef.current); }`.
  2. Handler `message.reaction.updated` (827-833): validar antes de aplicar —
     `if (!Array.isArray(reactions)) return;` (remove o `?? []` que apaga estado);
     manter replace in-place por `message.id` (idempotente ⇒ dedup natural).
- **Riscos:** closures do efeito (deps `[api]`) capturam `loadLatest`/
  `refreshConversations` da primeira render — ambos usam só setters/refs estáveis ⇒ ok.

### I11 — `apps/dashboard/src/ui/Inbox.tsx` — `MessageBubble` otimista (linhas 224-305 + uso em 1522)

- **Motivo:** F1, F2, F6, F7.
- **Depois:**
  1. Nova prop `onReactionsChange: (messageId: string, reactions:
     InboxMessage["reactions"]) => void`; no pai (1522):
     `onReactionsChange={(messageId, reactions) => setMessages(current =>
     current.map(m => m.id === messageId ? { ...m, reactions } : m))}`.
  2. `handleReact` otimista:
     ```ts
     const previous = message.reactions ?? [];
     const mine = previous.find(r => r.fromMe);
     const removing = mine?.emoji === emoji;
     const optimistic = removing
       ? previous.filter(r => !r.fromMe)
       : [...previous.filter(r => !r.fromMe), { emoji, reactorWhatsappId: null, fromMe: true, reactorName: null, reactorPhone: null, reactedAt: new Date().toISOString() }];
     onReactionsChange(message.id, optimistic);
     setReacting(true); setReactionError(false);
     try { const result = await api.react(conversationId, message.id, emoji); onReactionsChange(message.id, result.reactions); }
     catch { onReactionsChange(message.id, previous); setReactionError(true); }
     finally { setReacting(false); }
     ```
     (o WS subsequente reescreve o mesmo array — idempotente, sem flicker).
  3. Erro visível: novo estado `reactionError` + indicador inline (ex.:
     `{reactionError && <span className="message-reaction-error" role="alert"
     title="Falha ao enviar reação">⚠</span>}`) + classe CSS nova em styles.css junto
     ao bloco 637-657.
  4. Badges NÃO desabilitam com `reacting` (remover `disabled={reacting}` da linha
     249); manter nos botões dos pickers e no trigger.
  5. Fechar pickers: `ref` no `<article>` + `useEffect` que, quando algum picker
     estiver aberto, registra `mousedown` no document (fecha se o clique for fora do
     bubble) e `keydown` Escape; `➕` passa a abrir o completo e fechar o rápido.
- **Riscos:** `MessageBubble` só tem um uso (1522); tipo do objeto otimista precisa
  satisfazer `MessageReaction` (campos nullables ok). Se o backend mudar a semântica
  de toggle (decisão 6), o otimismo continua coerente porque ambos usam `fromMe`.

### I12 — Testes: `apps/api/test/message-reactions.test.ts` (adicionar cenários)

- **Motivo:** cobrir I1/I3/I4 e evitar regressão.
- **Adicionar (SQLite store, mesmo padrão dos 8 testes atuais):**
  1. órfão: `ingestReaction` em mensagem inexistente ⇒ `action === 'orphan'`, sem
     throw, `listReactions` vazio.
  2. LWW: inserir com `occurredAt` novo; reenviar o MESMO autor com emoji diferente e
     `occurredAt` mais ANTIGO ⇒ `noop` e emoji preservado. (Controlar `occurredAt`
     via `payload.timestamp` no `reactionEvent` ou montar `StoredReaction` direto.)
  3. reconciliação fromMe: `recordOperatorReaction` + evento inbound `fromMe=true`
     (autor número próprio) ⇒ uma única linha `fromMe`; remoção inbound `fromMe`
     (emoji `''`) limpa também a reação do operador.
  4. toggle por fromMe: `getOperatorReaction` encontra reação cujo autor não é
     `operator:*` (decisão 6).
- **Manter passando:** os 8 testes atuais (listados em §7) e `waha-webhook.test.ts:39`.

---

## 6. Sincronização (como deve funcionar depois das correções)

- **Envio (operador):** UI aplica otimista → POST → API envia `PUT /api/reaction` ao
  WAHA → persiste (`fromMe=true`, reconciliando outras linhas fromMe) → resposta
  reconcilia a UI → publish WS atualiza os outros operadores.
- **Remoção:** toggle (mesmo emoji) → `reaction: ""` no WAHA → DELETE no store →
  idem. Remoção vinda do telefone (`fromMe`, emoji `''`) limpa TODAS as linhas
  `fromMe` da mensagem.
- **Troca:** emoji diferente ⇒ mesmo caminho; upsert substitui pela PK composta;
  LWW impede que evento antigo reverta estado novo.
- **WebSocket:** broadcast por workspace; handler substitui o array inteiro da
  mensagem ⇒ **idempotente, dedup natural** (evento duplicado não corrompe).
- **Reconnect:** backoff exponencial; na reabertura, `loadLatest` + `refreshConversations`
  ⇒ reações e mensagens ressincronizam; nada se perde silenciosamente.
- **Atualização otimista:** cálculo local do toggle por `fromMe`; resposta do POST
  reconcilia; WS confirma.
- **Rollback:** falha do POST ⇒ restaura `message.reactions` anterior + indicador ⚠.
- **Deduplicação:** (a) upsert por PK composta + classificação `noop` suprime publish
  no webhook; (b) LWW por `occurredAt`; (c) replace no frontend; (d) reconciliação
  `fromMe` impede dupla contagem operador×telefone.

---

## 7. Backend — detalhes de referência rápida

- **Controller webhook** (`waha-webhook.controller.ts:16-27`): HMAC antes de tudo;
  parse zod; payload de reação malformado ⇒ log + 202 (descarte silencioso);
  publish condicionado a `conversationId && action !== 'noop'`.
- **Service inbox** (`internal-inbox.service.ts:59-78`): ordem das operações =
  conversa → sessão ativa → lookup mensagem → toggle → WAHA → persistência → publish.
  Persistência é DEPOIS do 200 do WAHA (otimista em relação ao eco, pessimista em
  relação ao envio).
- **Stores:** SQLite síncrono (sem corrida); Supabase com check-then-act residual
  (P5, aceito). `listReactions` e `batchReactions` enriquecem nomes via
  `whatsapp_identities` (COALESCE authorName, name, pushName).
- **Validações:** emoji 1-32 chars (controller + contrato); conversationId uuid;
  messageId 1-200. `reactionFrom` (linha 281) rejeita: sem `reaction.messageId`,
  `reaction.text` não-string, autor indeterminável (grupo sem participant / from
  `@g.us`).
- **Worker:** apenas outbound; sessão por alias; exige `connected`; Baileys sem
  suporte (manter).

---

## 8. Frontend — detalhes de referência rápida

- **Estados por bolha (MessageBubble):** `reactionPickerOpen`, `fullReactionPickerOpen`,
  `reacting`, `reactionPopup` (hover), `reactionDetailsPopup` (clique); **a adicionar:**
  `reactionError`.
- **Estados da Inbox relevantes:** `messages` (fonte das reações), `selectedRef`,
  `atBottomRef`, `activeConversationId`.
- **Atualização:** replace in-place por `message.id` tanto no WS quanto no otimismo.
- **Loading:** `reacting` desabilita botões dos pickers (manter) e NÃO os badges
  (corrigir).
- **Erros:** hoje só console; depois: ⚠ inline com `role="alert"` + rollback.

---

## 9. Testes

### 9.1 Existentes (não quebrar)

`apps/api/test/message-reactions.test.ts` (8 testes, SQLite apenas; helper `create()`
cria banco fresco das migrations — por isso não pega o P1):
1. parse do webhook de reação sem criar linha de mensagem;
2. persiste reação recebida (`inserted`);
3. remove com emoji vazio (`removed`);
4. aceita emoji vazio como payload de remoção válido;
5. substitui reação do mesmo autor;
6. mantém reações de autores diferentes (3 autores);
7. persiste e remove reação de operador (`recordOperatorReaction`/`removeOperatorReaction`);
8. `listMessages` inclui reações em batch sem N+1.

`apps/api/test/waha-webhook.test.ts:39`: "accepts message.reaction without inserting
a whatsapp message or webhook event row" — fixa o comportamento P12 (não mudar).

### 9.2 A criar (ver I12)

órfão / LWW fora de ordem / reconciliação fromMe / toggle por fromMe.

### 9.3 Cenários pendentes (sem cobertura automatizada prevista nesta tarefa)

- Supabase store (nenhum teste hoje cobre `SupabaseWahaWebhookStore.ingestReaction` —
  o P3 passou despercebido por isso; se houver infra de teste com mock do
  supabase-js, adicionar caso do `id` não-uuid).
- Frontend: não há testes de reação no dashboard (grep em `*.test.ts*` = zero).
- E2E com WAHA real: manual, roteiro no §11.

---

## 10. Pendências

### 10.1 Obrigatórias (bloqueiam o critério de conclusão)

1. I1-I4 (stores: órfão, LWW, reconciliação fromMe, uuid-safe, union `'orphan'`).
2. I5 (log/resposta de órfão no controller).
3. I6 (lookup direto da mensagem no `sendReaction`).
4. I7 (`WHATSAPP_HOOK_EVENTS` nos dois compose) + recriar contêiner.
5. I8 (recriar `message_reactions` no SQLite local).
6. I9-I11 (reconnect+ressync, validação de payload, otimismo+rollback+erro+pickers).
7. I12 (testes novos) + suíte inteira verde.
8. Gates: `npm run typecheck`, `npm run test`, `npm run build`, `git diff --check`.

### 10.2 Melhorias (não bloqueiam)

- P11: query param `wahaSession` opcional no GET `listReactions` (ou remover o
  endpoint morto do frontend).
- F8: chave React mais robusta no popup de detalhes.
- P8: simetria fina de publish em `noop` (decisão 13).

### 10.3 Dívida técnica

- Paginação de mensagens no frontend (F9) — reações fora da última página de 50 não
  são vistas; pré-requisito: cursor já existe no backend para grupos.
- P12: auditoria bruta de reações em `waha_webhook_events` — bloqueada pela regra de
  não alterar o Supabase (CHECK de `eventType`). Se um dia o usuário aplicar a
  migration manualmente, registrar reações passa a ser possível.
- P5: corrida residual no Supabase (check-then-act) — eliminável apenas com função
  no banco (proibido criar); janela de ms.
- `docs/divergencias-sqlite-supabase.md` não menciona `message_reactions` — atualizar
  quando as correções forem aplicadas.

### 10.4 Riscos

- **WAHA pode não ecoar reações de envios via API** (suposição do código). Se ecoar,
  a reconciliação fromMe (I1/I2) absorve o eco sem duplicar — risco mitigado pelo
  próprio design novo.
- Formato do `messageId` precisa ser idêntico nas duas vias (envio usa o id gravado;
  webhook usa `reaction.messageId`). Não há normalização defensiva (trim,
  `@lid`/`@c.us`) — se surgir divergência de formato, adicionar normalização em
  `reactionFrom` (linha 281).
- Edição de `waha-webhook.service.ts` exige cuidado com linhas >2000 chars (Edit
  precisa de `old_string` exata — extrair com `sed`/`fold` antes).

---

## 11. Supabase

- **Nada foi alterado no Supabase nesta sessão. Nenhuma migration foi criada, editada
  ou aplicada.** (Regra absoluta do AGENTS.md respeitada; qualquer mudança de schema
  fica como instrução manual para o usuário — e, para esta feature, NENHUMA mudança
  de schema é necessária: o bug P3 é corrigido em código.)
- O que depende do Supabase: runtime `dev:waha`/`dev:supabase` (DATABASE_PROVIDER);
  tabelas `message_reactions`, `whatsapp_messages`, `conversations`,
  `whatsapp_identities` (todas já existentes remotamente — presumir aplicadas; a
  migration `20260804000100` está untracked no repo, ou seja, é recente).
- O que conscientemente NÃO foi/feito: CHECK de `waha_webhook_events` (P12), RPC para
  upsert condicional (P5), edição da `20260804000100` (drift).

---

## 12. Localhost — roteiro completo de testes

### 12.0 Preparação (uma vez, ANTES de testar)

1. Aplicar I7 (compose) e recriar o WAHA; aplicar I8 (SQLite local).
2. Runtimes disponíveis (`package.json` raiz):
   - `npm run dev:waha` — sobe WAHA (docker) + API + worker + dashboard; **força
     Supabase**. Requer em `.env.local`: `WHATSAPP_DEMO_MODE=false`,
     `WHATSAPP_CONNECTION_ENABLED=true`, `WAHA_API_KEY` (≥32 chars).
     Variante `dev:waha:keep` mantém o contêiner após Ctrl-C.
   - `npm run dev:local` — mesma stack com **SQLite** (`.chatpro-data/backend.sqlite`).
   - Dashboard: Vite (porta padrão 5173); API: 3000; WS: `/ws`.
3. Sessão WAHA conectada (pareada) — verificar na tela de sessões da dashboard.

### 12.1 Cenários (mapeados do checklist do usuário)

| # | Cenário | Passos | Esperado |
|---|---|---|---|
| 1 | Reagir | abrir conversa → 😊 → 👍 | badge 👍 aparece **imediatamente** (otimista); sem erro no console |
| 2 | Remover | clicar 👍 de novo (mesmo emoji) | badge some imediatamente |
| 3 | Trocar | reagir 👍 → reagir ❤️ | só ❤️ permanece (nunca os dois) |
| 4 | Imediatismo | observar badge sem F5 | sem depender de reload |
| 5 | Entre operadores | dois navegadores (mesma workspace) | reação de um aparece no outro via WS |
| 6 | Entre dispositivos | reagir no TELEFONE numa mensagem da conversa | aparece na inbox como "Você"/fromMe; e reação do painel não duplica quando o telefone mexe |
| 7 | Persistência | F5 na página | reações intactas (vêm do `listMessages`) |
| 8 | Reconnect | derrubar a API (ou `docker stop` do proxy) com a página aberta → subir de novo | WS reconecta sozinho (backoff); reações ressincronizam sem F5; sem erro de WS no console além da queda esperada |
| 9 | Webhook inbound | contato externo reage a uma mensagem | aparece imediatamente na inbox (requer I7) |
| 10 | Reação própria | outbound (mensagem enviada pelo painel) | reagir/remover funciona |
| 11 | Sem duplicação | clicar rápido; telefone+painel na mesma mensagem | contadores corretos; uma só linha fromMe |
| 12 | Erro | parar a API e reagir | rollback (badge volta ao estado anterior) + ⚠ visível |
| 13 | Mensagem antiga de grupo | reagir a mensagem fora das 100 recentes | funciona (I6), sem 404 falso |
| 14 | Órfão | (via curl) POST de webhook de reação para messageId inexistente | 202, sem 500, sem retry storm nos logs do WAHA |
| 15 | Ordem invertida | (simular) remover→reagir com timestamps invertidos | estado final = mais novo (LWW) |

Verificação de banco (SQLite, somente leitura):
```bash
node -e "const D=require('better-sqlite3');const db=new D('.chatpro-data/backend.sqlite',{readonly:true});console.log(db.prepare('SELECT messageId,authorWhatsappId,emoji,fromMe,occurredAt FROM message_reactions').all())"
```

### 12.2 Gates de qualidade (obrigatórios ao final)

```bash
npm run typecheck && npm run test && npm run build && git diff --check
```

---

## 13. Estado final

- **Exploração/auditoria: 100%. Implementação: 0%. Validação: 0%.**
  Estimativa global da tarefa: **~30%** (todo o diagnóstico e o plano de correção
  estão prontos e decididos; falta aplicar e validar).
- **Funcionamento atual (sem as correções):** reação do operador quebra no runtime
  SQLite (P1) e inbound quebra no runtime Supabase (P3); inbound nunca chega por
  config (P2); frontend sem otimismo/reconnect. Ou seja: **no localhost, hoje, a
  feature não funciona de ponta a ponta em nenhum dos dois runtimes.**
- **Nenhum arquivo foi modificado nesta sessão.** O `git status` (57 arquivos:
  43 modificados + 14 untracked, incluindo `apps/api/migrations/025_message_reactions.sql`,
  `supabase/migrations/20260804000100_message_reactions.sql` e
  `apps/api/test/message-reactions.test.ts`) é trabalho pré-existente de sessões
  anteriores — a feature já estava não commitada.
- **Próximos passos (nesta ordem):**
  1. I8 (SQLite local) e I7 (composes) — destravam o ambiente.
  2. I1-I6 (backend) + I12 (testes backend) — `npm run test -w @chatpro/api`.
  3. I9-I11 (frontend).
  4. Gates completos + roteiro §12.
  5. Reportar: arquivos alterados, motivos, problemas corrigidos, limitações
     restantes (P5, P12, F9) e evidências do roteiro de localhost.

---

## Apêndice A — Trechos-chave do código atual (âncoras para edição)

**SQLite `ingestReaction` — linha 152 (prefixo):**
`async ingestReaction(input: StoredReaction): Promise<ReactionIngestResult> { const
conversation = this.database.prepare('SELECT c.id FROM conversations c JOIN
whatsapp_messages m ON m.workspaceId = c.workspaceId AND m.wahaSession = c.wahaSession
AND m.chatId = c.chatId WHERE m.workspaceId = ? ...`

**Supabase `ingestReaction` — linha 265 (prefixo):**
`async ingestReaction(input: StoredReaction): Promise<ReactionIngestResult> { const
{ data: message, error: messageError } = await this.client.from('whatsapp_messages')
.select('chat_id')...`

**`reactionFrom` — linha 281 (prefixo):**
`export function reactionFrom(event: StoredWebhook): StoredReaction | undefined { if
(event.eventType !== 'message.reaction') return undefined; const payload =
event.payload; const reaction = record(payload.reaction); ...`

**Comando WAHA — `waha-client.ts:126-133`:** `PUT /api/reaction`, body `{ session,
messageId, reaction }` (`""` remove).

**Evento WS:** `message.reaction.updated` — payload `{ conversationId, messageId,
reactions: MessageReaction[] }`; broadcast por workspace (`realtime.ts:10-13`).

## Apêndice B — Convenções do projeto observadas

- Comentários de código em português, explicando o "porquê" (ver exemplos em
  `internal-inbox.service.ts:54-58`, `waha-webhook.service.ts` acima da linha 152).
- Migrations SQLite com cabeçalho comentado e sem BEGIN/COMMIT (runner envolve em
  transação — `database.ts:34`).
- Logs estruturados via `log('info'|'error', '<msg>', { ...campos })`.
- Testes: vitest; stores SQLite testados com banco temporário real
  (`mkdtempSync` + `SqlitePersistenceDatabase.migrate()`); `OPT_OUT_HASH_PEPPER`
  precisa estar setado nos testes (ver `message-reactions.test.ts:11-13`).
- Sem framework de estado no dashboard; padrão é `useState` + refs + efeitos.
