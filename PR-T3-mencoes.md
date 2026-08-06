# PR-T3 — Menções (@) em grupos — Passagem de Contexto

> **Data da investigação:** 2026-08-05 (~13:20–14:00, -03).
> **Estado:** implementação **0% — NENHUM código foi escrito**. O que existe é:
> (1) investigação completa e verificada do projeto, da WAHA e dos payloads reais;
> (2) plano aprovado pelo usuário, reproduzido na íntegra na seção 4 com blueprint
> arquivo a arquivo. Quem continuar **não precisa repetir nenhuma investigação** —
> só executar.
>
> **⚠️ AVISO CRÍTICO — SESSÕES CONCORRENTES:** este repositório está sendo editado
> AO VIVO por outras sessões de agente (verificado: 4 processos `kimi` ativos;
> working tree com +1.442 linhas não commitadas de features paralelas — link
> preview, reações, sync de contatos, "Conversar" do vCard etc.). Todos os números
> de linha citados abaixo referem-se ao estado da investigação e **vão derivar**.
> Use-os como ponto de partida e revalide com Grep antes de editar. Releia cada
> arquivo imediatamente antes de cada Edit.
>
> **Regras absolutas do projeto (AGENTS.md):** Supabase é SOMENTE consulta —
> proibido migrations, SQL de escrita, alterar tabelas/RPCs/policies/triggers/
> functions/storage. Reutilizar arquitetura existente; nunca criar fluxo paralelo;
> alterações mínimas; terminar com typecheck + testes + build + `git diff --check`.

---

## 1. Visão geral

### 1.1 Objetivo
Permitir que o operador, numa conversa de **grupo**, digite `@`, veja um
autocomplete de participantes (foto, nome, número, selo de admin), selecione por
teclado (Enter/Tab) ou mouse, e envie a mensagem com a menção **funcionando de
verdade no WhatsApp** do destinatário. Mensagens recebidas com menções devem ser
renderizadas com destaque visual semelhante ao WhatsApp Web. Múltiplas menções,
menções no início/meio/fim, grupos grandes.

### 1.2 Funcionamento (o mecanismo, em uma frase por camada)
- **Composer (dashboard):** digitar `@` abre popup com participantes do grupo
  (buscados 1× por conversa, filtro 100% local); selecionar insere `@Nome` no
  textarea e registra o par `{display, jid}`.
- **Submit:** o dashboard converte cada `@Nome` rastreado em `@<dígitos>` e envia
  `{ text, mentions: ["<dígitos>@c.us" | "<dígitos>@lid"] }`.
- **API:** valida (grupo, formato de JID, dedupe, presença do `@dígitos` no texto,
  pertencimento ao grupo com fail-open) e repassa `mentions` pelo pipeline de
  envio existente — **o mesmo `deliver` de sempre; nenhum fluxo paralelo**.
- **Worker:** repassa `mentions` até o client WAHA.
- **WAHA:** `POST /api/sendText` com `{ session, chatId, text, ..., mentions }`.
- **Recebimento:** nada a fazer na ingestão — a menção já chega e já é persistida
  em `payloadJson` (`_data.mentionedJidList`); só falta **renderizar** no dashboard.

### 1.3 Comportamento esperado (aceite)
Digitar `@` → lista abre → filtrar por nome/número → ↑/↓ navegam → Enter/Tab
selecionam → Esc fecha → clique seleciona → `@Nome` entra no texto → enviar →
destinatário é notificado como mencionado no WhatsApp → mensagens com menção
(recebidas e enviadas) exibem `@Nome` destacado → múltiplas menções funcionam.

### 1.4 Limitações (conhecidas e aceitas no plano)
1. **Menção é texto puro no textarea** (não é chip contenteditable). Apagar é por
   caractere; editar parcialmente um `@Nome` inserido descarta aquela menção no
   envio (o texto permanece correto como texto simples). Decisão deliberada:
   preservar o textarea e os fluxos existentes (anexo, colar, áudio, vCard).
2. **Participantes podem estar desatualizados:** `whatsapp_group_participants` só
   é escrita pelo `identity.sync` (TTL 24h, disparado por mensagens recebidas),
   **nunca há DELETE** de quem saiu do grupo, e eventos WAHA `group.v2.*` não são
   tratados. Mitigação no plano: endpoint enfileira `identitySync.enqueue`
   (fail-open) e o autocomplete usa o que há.
3. **JIDs `@lid`:** o WhatsApp atual usa LIDs; a menção sai com o JID armazenado
   do participante (seja `@c.us` ou `@lid`). Evidência de produção (seção 3.2)
   mostra o próprio WhatsApp usando `@lid` em `mentionedJidList`.
4. `mentions: ["all"]` (mencionar todos) existe na WAHA, mas **não** está no
   escopo.
5. Menções em conversa direta (1:1): rejeitadas com 400 (no WhatsApp são no-op).

---

## 2. Arquitetura

### 2.1 Visão de ponta a ponta

```
Dashboard (Inbox.tsx)
  textarea[composerText] ──"@"──▶ MentionAutocomplete (filtro local)
                                      │ dados: GET /inbox/conversations/:id/participants (1× por conversa, cache useRef)
  submitMessage ──converte @Nome→@dígitos──▶ api.sendMessage(id, text, mentions)
        │ POST /api/v1/inbox/conversations/:id/messages  { text, mentions }
        ▼
API  inbox.controller.sendMessage (zod + validações semânticas)
        ▼
     InternalInboxService.send → deliver (internal-inbox.service.ts)
        ├─ comando interno: { type:'message.send', payload:{ wahaSession, chatId, text, mentions } }
        │    (validado pelo zod estrito de packages/contracts — internalSendMessageCommandSchema)
        ├─ InternalWorkerClient POST /internal/transport
        ▼
Worker internal-transport-server → ports.ts (WorkerCommand) → waha-provider.sendText
        ▼
     waha-client.sendText(session, chatId, text, mentions)
        ▼
WAHA POST /api/sendText { session, chatId, text, linkPreview:true, linkPreviewHighQuality:true, mentions:[...] }
        │
        ▼  (echo message.any fromMe + resposta do send)
API  recordOutbound → ingest (mesma pipeline do webhook) → whatsapp_messages.payloadJson
     ganha metadata.mentions → realtime 'message.sent'/'conversation.updated' → dashboard
```

**Websocket/realtime:** nenhuma mudança. Eventos existentes (`message.received`,
`message.sent`, `conversation.updated`) já cobrem menções — o conteúdo viaja no
payload da mensagem, não em evento próprio.

**Renderização:** o corpo já passa por `linkify(message.content)` no
`MessageBubble` (`apps/dashboard/src/ui/Inbox.tsx:242`). O renderer de menções
**compõe** com `linkify`: tokeniza `@<dígitos>` que constem na lista de JIDs da
mensagem e envolve em `<span class="message-mention">@Nome</span>`; os demais
segmentos seguem para `linkify` normalmente.

### 2.2 Onde cada dado mora
| Dado | Fonte |
|---|---|
| Participantes do grupo (id, role) | `whatsapp_group_participants` + `whatsapp_groups` (escritas pelo `identity.sync` → WAHA `participants/v2`) |
| Nome/foto/telefone de participante | `whatsapp_identities` (name/pushName/phone/profile_picture_url) → `contacts.displayName` → dígitos do JID (fallback) |
| Menções de mensagem recebida | `message.metadata._data.mentionedJidList` (payload cru WAHA, já persistido) |
| Menções de mensagem enviada por nós | `message.metadata.mentions` (incluído pelo `recordOutbound` no novo fluxo) |
| Texto com `@dígitos` | `whatsapp_messages.body` → `InboxMessage.content` |

### 2.3 WAHA — formato exato (evidência, não suposição)

**ENVIO — `POST /api/sendText` aceita `mentions: string[]`** (JIDs completos), e
exige o `@dígitos` correspondente dentro de `text`:

```jsonc
// https://waha.devlike.pro/docs/how-to/send-messages/ — "Mention contact"
{
  "session": "default",
  "chatId": "12132132130@g.us",
  "text": "Hi there! @2132132130",
  "mentions": ["2132132130@c.us"]
}
```

> "you MUST mention a number in the text as well in the format `@2132132130` and
> also mention it in `mentions` in format `2132132130@c.us`". Atalho documentado:
> `"mentions": ["all"]` menciona todos (fora de escopo). Corroborado pela sondagem
> da instância local em `docs/waha-capacidades-anexos.md:125-126` ("`sendText`
> aceita ainda `linkPreview`, `linkPreviewHighQuality`, `reply_to` e `mentions`").
> A instância (2026.7.1, WEBJS, CORE) **não** expõe OpenAPI (rotas de spec 404).
> Suporte a mentions existe desde o changelog 2023.6 da WAHA; a issue aberta de
> mentions é só para o engine GOWS (#1372) — WEBJS (o nosso) já converte
> `mentions` → `mentionedJID` do protocolo.

**RECEBIMENTO — `_data.mentionedJidList`** (medido em produção, backup sanitizado
`backups/inbox-integrity-2026-07-21T14-57-08-230Z.json`: 1.550 mensagens com o
campo, **14 com menção real**):

```jsonc
{
  "body": "Alias, @113709292749046 , tem a info pra nós, aonde está a rolinha Jackson?",
  "from": "120363328209240027@g.us",
  "participant": "80848665735294@lid",
  "_data": {
    "body": "Alias, @113709292749046 , tem a info...",
    "mentionedJidList": ["113709292749046@lid"],   // ← AS MENÇÕES
    "groupMentions": [],
    "statusMentioned": false
  }
}
// outro exemplo: "_data.mentionedJidList": ["271970432213028@lid","190589358366790@lid"],
// body: "@190589358366790 @271970432213028 pensa em uma mulher pcista"
```

Fatos medidos: (a) o campo é `mentionedJidList` **dentro de `_data`** (não existe
`mentionedIds` nesses payloads); (b) os JIDs vêm como **`@lid`** nesta instância;
(c) o `body` traz `@<dígitos-do-lid>` em texto puro; (d) o pipeline de ingestão
(`sanitize`, `waha-webhook.service.ts`) só mascara chaves sensíveis e trunca
strings em 20.000 chars — `mentionedJidList` **sobrevive intacto** em
`payloadJson` e chega ao dashboard como `message.metadata._data.mentionedJidList`.
Docs do projeto que citam o campo em produção:
`docs/limpeza-eventos-sistema-procedimento.md:124`, `docs/limpeza-fantasmas-20260803.sql:17`.

---

## 3. Exploração realizada (não refazer)

### 3.1 Arquivos analisados (todos lidos ou grepados na íntegra)

**Worker / transporte WAHA**
- `apps/worker/src/waha-client.ts` — `WahaHttpClient`; `sendText` (~:74-83) monta
  hoje `{ session, chatId, text, linkPreview: true, linkPreviewHighQuality: true }`
  em `POST /api/sendText`. `getGroup` (:91-96) chama `/api/{s}/groups/{chatId}`,
  `/picture`, `/participants/v2` e **descarta tudo dos participantes exceto
  `id` e `role`**. `getIdentity` (:87-89) resolve `@lid` via `/api/{s}/lids/{lid}`.
  Tipo `WahaGroup` (:12).
- `apps/worker/src/waha-provider.ts` — `sendText` (:56) resolve sessão por
  nome/alias, exige `connected`, chama o client.
- `apps/worker/src/ports.ts` — `WorkerCommand`: `{ type:'sendMessage'; wahaSession; chatId; text }`.
- `apps/worker/src/internal-transport-server.ts` — `message.send` → `execute({type:'sendMessage', ...})` (:32-35); **parse zod estrito em :89-90 rejeita campo desconhecido** (por isso o contrato PRECISA ser alterado).

**Contratos**
- `packages/contracts/src/index.ts` — `internalSendMessageCommandSchema` (:132):
  `{ type:'message.send', payload:{ wahaSession, chatId, text(1..4096) } }`;
  union discriminada em :180. `inboxMessageSchema` (:89): `metadata: z.record(z.unknown())`
  — menções cabem sem mudar o schema da mensagem. Precedente de payload extra:
  `message.sendContent` (:175) cobre location/vcard/poll.

**API**
- `apps/api/src/controllers/inbox.controller.ts` — zod `sendMessage` (:22) só
  `{ text }`; handler `sendMessage` (:108). `connectedWahaSession` (:134) =
  padrão para descobrir a sessão `connected` (409 se não houver).
- `apps/api/src/routes/v1.ts:21` — todas as rotas `/inbox/*` numa linha só.
- `apps/api/src/services/internal-inbox.service.ts` — `send` (:44-53) →
  `deliver` (:77-131): `getConversation` (404), `sessionActivity.assertActive`,
  comando ao worker, `recordOutbound` (:107) com `payload` extra que cai em
  `metadata` (precedente: `contacts` do vCard em :36-43).
- `apps/api/src/services/waha-webhook.service.ts` — `ConversationStore`
  (interface :57); `rows()` (:125) e `toConversationSummary` (:421) no SQLite;
  `remoteIdentityLookup` (:436+, batch anti-N+1 com `.in()`) e `withIdentities`
  no Supabase; `messageFrom` (:254) extrai `senderWhatsappId` de
  `participant`/`key.participant` em grupos; `sanitize` (:424) preserva
  `mentionedJidList`; `identityFor` (:420) = precedência nome:
  profileName → pushName → contactName → null.
- `apps/api/src/services/whatsapp-identity-sync.service.ts` — `enqueue` (:20,
  dedup `inFlight`); `stale` TTL 24h (:48); `persistGroup` (:33 SQLite / :44
  Supabase) faz upsert de participantes `ON CONFLICT(groupId,participantWhatsappId)
  DO UPDATE SET role=...`; **nunca deleta**; comentário: identidade de
  participante de grupo nunca vira contato.
- `apps/api/src/services/contact-identity-resolver.service.ts` —
  `normalizedPhone` (:15: 8–15 dígitos), `phoneFromIdentifier` (:16).
- `apps/api/src/app.ts:123` — composição do `InboxController` (deps posicionais;
  `identitySync` construído em :115 e NÃO é passado ao controller hoje).

**Persistência (schemas confirmados)**
- `apps/api/migrations/005_whatsapp_group_persistence.sql:16-39` e
  `supabase/migrations/005_whatsapp_group_persistence.sql:16-40`:
  `whatsapp_groups(id, workspace_id, waha_session, chat_id, name, picture_url,
  metadata, created_at, updated_at)` UNIQUE(workspace_id, waha_session, chat_id);
  `whatsapp_group_participants(id, group_id FK CASCADE, participant_whatsapp_id,
  role NULL, created_at)` UNIQUE(group_id, participant_whatsapp_id).
  **Sem coluna de nome/foto/updated_at em participantes.**
- Grants: `supabase/migrations/006_whatsapp_identity_sync.sql:10`.

**Dashboard**
- `apps/dashboard/src/ui/Inbox.tsx` (1.924 linhas, **oscilando sob edição
  concorrente**): `composerText` (:337); textarea `:1616` (controlada, sem ref,
  sem onKeyDown — Enter quebra linha, envio pelo botão); `submitMessage`
  (:951-984) lê `new FormData(form).get("text")`; popups dentro do
  `<form className="message-composer">` (:1527) por ordem flex (`order:-3`);
  `ContactPicker` (:1534-1539); corpo: `{message.content && !bodyRepeatsCard(message)
  && <p>{linkify(message.content)}</p>}` (:242); autor de grupo:
  `senderName(message.senderWhatsappId)` (:240) via `participantLabel`
  (`contactIdentity.ts:52`); `isGroup(selected)`; `slaCache` (padrão de cache
  por useRef Map, :405); realtime handler (:770-847).
- `apps/dashboard/src/ui/ContactPicker.tsx` — **modelo do popup**: props
  `search/onSend/onClose/sending` (:31-41); estado local + `requestRef`
  anti-corrida (:97-111); debounce 250ms (:113-136); infinite scroll por
  IntersectionObserver (:158-170); teclado só Esc (:181-183 — **não há
  navegação por setas; o MentionAutocomplete precisa criar esse padrão**);
  helpers puros exportados e testados (`contactInitials`, `contactRow`,
  `toggleSelection`).
- `apps/dashboard/src/ui/LinkPreview.tsx:9-26` — `linkify(content): ReactNode[]`,
  único renderer de destaque no corpo. Convenção: URLs viram
  `<a className="message-link">`.
- `apps/dashboard/src/ui/styles.css` — receita de popup `.composer-contact`
  (:514-547) e `.composer-location` (:291-304); `.chat-inbox .message-author`
  (:30, `#d9bdff`); `.message-link` (:667-668, `#8ac7ff`); composer (:92-120).
  **Convenção registrada (:659-663): "Nenhum hex novo: todos os valores já
  existem nesta folha"** — testes validam isso lendo o CSS bruto
  (`Inbox.test.tsx:325`).
- `apps/dashboard/src/api/inbox.ts` — `InboxApi`; `sendMessage` (:24) posta só
  `{ text }`; `Page<T>` (:5).

**Testes (padrões a seguir)**
- `apps/dashboard/src/ui/InboxContactPicker.test.tsx` (308 linhas) e
  `InboxMessageCards.test.tsx`: mocks de `../api/realtime.js` e
  `../api/workspace.js` ANTES de importar a Inbox; api = objeto de `vi.fn()` com
  `as unknown as InboxApi`; factories `conversation()`/`message(over)`;
  `abrirConversa` monta e abre conversa; queries por label/role; jsdom gaps
  mockados (`URL.createObjectURL`, `IntersectionObserver`).
- `apps/api/test/waha-webhook.test.ts` — `appFor()` (app real SQLite em tmpdir) +
  supertest; worker fake via `listenInternalTransport(createWorkerTransportHandler(port))`
  de `../../worker/src/internal-transport-server.js`; `seed`/HMAC helpers.
- `apps/api/test/sync-session-alias.test.ts` — instancia `InboxController`
  diretamente com deps stubadas (ideal para testar validações do handler).
- `apps/worker/test/waha-client.test.ts` / `waha-provider.test.ts` — já cobrem
  `sendText`; estender com `mentions`.

**Docs citadas:** `docs/waha-capacidades-anexos.md` (sondagem da instância),
`docs/whatsapp-flow.md`, `docs/inbox-flow.md`.

### 3.2 Descobertas-chave (as que mudam o design)
1. **Nada de menção existe no código** (grep `mention` case-insensitive em
   `apps/`, `packages/`, testes = 0; só 3 menções em docs).
2. **Recebimento é grátis:** `_data.mentionedJidList` já está persistido e
   disponível no frontend via `message.metadata`. Zero mudança de ingestão,
   zero migration, zero RPC.
3. **O contrato interno é estrito:** mandar `mentions` no comando `message.send`
   sem alterar `internalSendMessageCommandSchema` quebra o parse no worker (400).
4. **Participantes já existem no banco** (id + role), mas **nenhum endpoint os
   expõe** e **nomes/fotos de participantes de grupo geralmente não estão em
   `whatsapp_identities`** (sync de identidade só roda para conversas diretas) —
   o autocomplete precisa montar nome a partir de 3 fontes com fallback para os
   dígitos do JID.
5. **A WAHA exige `@dígitos` no texto**, não `@Nome`: o dashboard precisa
   serializar na saída (ver 5.4).
6. **LID é primeira classe nesta instância:** menções recebidas vêm `@lid`; o
   envio aceita o JID que estiver armazenado para o participante.

### 3.3 Decisões (e por quê)
- **Sem chip contenteditable** — manter o textarea e todos os fluxos do composer
  (requisito explícito do usuário + regra de alteração mínima). `@Nome` visível é
  texto; a fidelidade é garantida na serialização do submit.
- **Endpoint novo de participantes** em vez de reaproveitar `/domain/contacts`:
  participante de grupo não é necessariamente contato do CRM; a fonte correta é
  `whatsapp_group_participants` (já sincronizada).
- **`listGroupParticipants` no `ConversationStore`** (as duas implementações) —
  é o dono dessas tabelas; qualquer outro lugar seria fluxo paralelo.
- **Validação de pertencimento fail-open:** se o grupo não tem linhas de
  participantes (nunca sincronizado), não bloquear o envio; se tem, exigir
  subconjunto. Mesma filosofia do `WhatsAppSessionActivityService`.
- **Filtrar (não rejeitar) menção cujos dígitos não constam no texto** — a WAHA
  ignoraria de qualquer forma; o dashboard sempre os inclui.
- **Relevância = ativos recentes primeiro, depois alfabética** (comportamento do
  WhatsApp Web), computada no backend (`MAX(occurredAt)` por remetente).
- **Não tratar eventos `group.v2.*`** — fora de escopo; documentado como
  limitação.

---

## 4. Implementações (plano aprovado, blueprint por arquivo)

> Nada abaixo foi aplicado. "Antes" = código atual (verificado na investigação).
> "Depois" = o que deve ser escrito. Ordem recomendada: contracts → worker →
> api → dashboard → testes.

### 4.1 `packages/contracts/src/index.ts` — comando interno
- **Motivo:** fronteira estrita; sem isso o worker rejeita o comando.
- **Antes (:132):** `internalSendMessageCommandSchema = { type:'message.send', payload:{ wahaSession, chatId, text: string 1..4096 } }`.
- **Depois:** payload ganha
  `mentions: z.array(z.string().regex(/^\d{6,20}@(c\.us|lid)$/)).max(50).optional()`.
- **Impacto:** só o novo campo opcional; comandos sem `mentions` inalterados.
- **Riscos:** nenhum além de typecheck; workspaces dependentes recompilam.

### 4.2 `apps/worker/src/ports.ts` — tipo do comando
- **Motivo:** o tipo `WorkerCommand` precisa carregar o campo.
- **Antes (:5):** `{ type:'sendMessage'; wahaSession: string; chatId: string; text: string }`.
- **Depois:** `+ mentions?: readonly string[]`.
- **Impacto/riscos:** mínimo; demais comandos intactos.

### 4.3 `apps/worker/src/internal-transport-server.ts` — repasse
- **Motivo:** levar `mentions` do comando validado ao `execute`.
- **Antes (:32-35):** `message.send` → `worker.execute({ type:'sendMessage', wahaSession, chatId, text })`.
- **Depois:** incluir `mentions` no objeto repassado.
- **Impacto/riscos:** nenhum comportamental quando ausente.

### 4.4 `apps/worker/src/waha-provider.ts` — `sendText`
- **Motivo:** passar o array ao client HTTP.
- **Antes (:56):** `this.client.sendText(stored.wahaName, chatId, text)`.
- **Depois:** `sendText` recebe `mentions?: readonly string[]` do comando e
  repassa como 4º argumento.
- **Impacto/riscos:** sessão `connected` continua sendo exigida (inalterado).

### 4.5 `apps/worker/src/waha-client.ts` — body da WAHA
- **Motivo:** é onde o JSON da WAHA é montado.
- **Antes (:74-83):** `sendText(session, chatId, text)` → body
  `{ session, chatId, text, linkPreview: true, linkPreviewHighQuality: true }`.
- **Depois:** assinatura `sendText(session, chatId, text, mentions?: readonly string[])`;
  body ganha `...(mentions?.length ? { mentions: [...mentions] } : {})`.
- **Impacto:** envio com menção passa a notificar o mencionado (é o objetivo).
- **Riscos:** WAHA ignora/400 se o JID for inválido — mitigado pela validação na
  API (formato + pertencimento). Sem `mentions`, body idêntico ao de hoje.

### 4.6 `apps/api/src/services/waha-webhook.service.ts` — `listGroupParticipants`
- **Motivo:** única fonte correta de participantes; o store é o dono das tabelas.
- **Interface `ConversationStore` (:57)** ganha:
  `listGroupParticipants(workspaceId: string, conversationId: string): Promise<GroupParticipant[] | undefined>`
  com `GroupParticipant = { whatsappId: string; name: string | null; phone: string | null; role: string | null; avatarUrl: string | null; lastActiveAt: string | null }`
  (`undefined` = conversa inexistente ou não-grupo → controller responde 404/400).
- **SQLite (implementação):** resolver a conversa (`SELECT wahaSession, chatId,
  conversationType FROM conversations WHERE workspaceId=? AND id=?`); se não for
  grupo → `undefined`. Depois um JOIN:
  ```sql
  SELECT p.participantWhatsappId whatsappId, p.role,
         i.name identityName, i.pushName pushName, i.phone identityPhone, i.profilePictureUrl avatarUrl,
         c.displayName contactName
  FROM whatsapp_group_participants p
  JOIN whatsapp_groups g ON g.id = p.groupId AND g.workspaceId=? AND g.wahaSession=? AND g.chatId=?
  LEFT JOIN whatsapp_identities i ON i.workspaceId=g.workspaceId AND i.wahaSession=g.wahaSession
       AND (i.whatsappId = p.participantWhatsappId OR i.canonicalWhatsappId = p.participantWhatsappId)
  LEFT JOIN contacts c ON c.workspaceId=g.workspaceId
       AND c.phoneNumber = substr(p.participantWhatsappId, 1, instr(p.participantWhatsappId,'@')-1)
  ```
  mais recência:
  `SELECT senderWhatsappId, MAX(occurredAt) lastAt FROM whatsapp_messages WHERE workspaceId=? AND wahaSession=? AND chatId=? AND senderWhatsappId IS NOT NULL GROUP BY senderWhatsappId`.
  Montar `name = identityName ?? pushName ?? contactName ?? null`,
  `phone = identityPhone ?? (whatsappId @c.us ? dígitos : null)`; ordenar por
  `lastAt DESC NULLS LAST` (em JS), depois `name/dígitos` alfabético.
  Excluir `role='left'` da lista? **Sim** — ex-membro não deve ser sugerido
  (registrar a decisão no código com comentário).
- **Supabase (implementação):** mesmo resultado com consultas em lote no padrão
  `remoteIdentityLookup` (:436): 1) conversa; 2) `whatsapp_groups` por
  (workspace_id, waha_session, chat_id); 3) `whatsapp_group_participants` por
  group_id; 4) `whatsapp_identities` `.in('whatsapp_id', ids)` (+ consulta por
  `canonical_whatsapp_id` se necessário); 5) `contacts` `.in('phone_number',
  phones)`; 6) remetentes recentes: `whatsapp_messages.select('sender_whatsapp_id,occurred_at').eq(...).order('occurred_at',{ascending:false}).limit(300)`
  e derivar `lastActiveAt` em JS. Tudo SELECT — **permitido pelas regras**.
- **Impacto:** nenhum consumidor novo além do endpoint; leitura barata e em lote.
- **Riscos:** grupo nunca sincronizado → lista vazia (autocomplete mostra estado
  vazio informativo; envio segue fail-open).

### 4.7 `apps/api/src/controllers/inbox.controller.ts` — envio + endpoint
- **Schema (:22):** `sendMessage` ganha
  `mentions: z.array(z.string().regex(/^\d{6,20}@(c\.us|lid)$/)).max(50).optional()`.
- **Handler `sendMessage` (:108):** validações semânticas antes de chamar o service:
  1. `conversation = getConversation(...)` (o service já faria 404; aqui é para
     validar tipo) — se `mentions?.length` e `conversationType !== 'group'` →
     `400 VALIDATION_ERROR` ("mentions só em grupos", mensagem segura);
  2. dedupe preservando ordem;
  3. descartar menção cujos dígitos `@<user>` não aparecem em `text`
     (requisito da WAHA — seção 2.3);
  4. pertencimento: `listGroupParticipants`; se a lista **existir e não for
     vazia**, toda menção precisa estar nela, senão 400; lista vazia → segue
     (fail-open, comentário explicando);
  5. `this.inbox.send(context, conversationId, text, mentions)`.
- **Handler novo `listParticipants`:** `GET` → resolve `listGroupParticipants`;
  `undefined` → 404 (conversa inexistente) ou 400 (não é grupo — distinguir pelo
  retorno ou por `getConversation` prévio); responde `{ items }`; enfileira
  `this.identitySync?.enqueue({ workspaceId, wahaSession, chatId })` (frescor
  futuro, fail-open) — requer a dep opcional `identitySync` no construtor
  (ver 4.9). Resposta embrulhada sem `withSessionActivity` (não é conversa).
- **Impacto:** `POST .../messages` sem `mentions` é byte-a-byte o comportamento
  atual.
- **Riscos:** validação 4 depende da tabela estar populada; documentado.

### 4.8 `apps/api/src/services/internal-inbox.service.ts` — `send` com mentions
- **Antes (:44-53):** `send(context, conversationId, text)` → `deliver` com
  comando `{ type:'message.send', payload:{ wahaSession, chatId, text } }`,
  `messageType:'text'`, `body:text`.
- **Depois:** `send(context, conversationId, text, mentions?: string[])`; comando
  ganha `...(mentions?.length ? { mentions } : {})`; quarto campo do `deliver`
  (`payload`) ganha `{ mentions }` quando houver → `recordOutbound` grava em
  `payloadJson` → vira `metadata.mentions` na nossa própria mensagem (é o que
  permite renderizar destaque nas ENVIADAS sem heurística).
- **Impacto/riscos:** nenhum para envios sem menção; `deliver` em si não muda.

### 4.9 `apps/api/src/routes/v1.ts` e `apps/api/src/app.ts`
- **Rota:** na linha única de rotas inbox (:21), registrar
  `router.get('/inbox/conversations/:conversationId/participants', inbox.listParticipants);`
  ao lado das demais `:conversationId` (GET — sem conflito com `/open` do outro
  time, que é POST).
- **Composição (:123):** passar `identitySync` (já construído em :115) como
  último parâmetro opcional do `new InboxController(...)`; construtor do
  controller ganha `private readonly identitySync?: WhatsAppIdentitySyncService`.
- **Riscos:** arquivo disputado por outras sessões — reler antes de editar.

### 4.10 `apps/dashboard/src/api/inbox.ts`
- `sendMessage=(id,text,mentions?)=>...post(...,{ text, ...(mentions?.length ? { mentions } : {}) })`.
- Novo: `participants=(id)=>this.http.get<{ items: GroupParticipant[] }>('/api/v1/inbox/conversations/'+id+'/participants')`;
  exportar tipo `GroupParticipant` (espelho do definido no store da API; se
  preferir, declarar em `@chatpro/contracts` e reexportar — seguir o padrão dos
  tipos `InboxConversation`).

### 4.11 `apps/dashboard/src/ui/mentions.ts` (novo) — helpers puros
Funções testadas isoladamente (padrão `messageMedia.ts`/`contactIdentity.ts`):
- `mentionTrigger(text: string, caret: number): { start: number; query: string } | null`
  — `@` no início ou após `\s`; query = `[\p{L}\p{N} ]*` até o caret, sem `\n`,
  tamanho ≤ 30.
- `insertMention(text, caret, start, display): { text, caret }` — substitui
  `@query` por `@Nome ` e devolve a posição nova do cursor.
- `serializeMentions(text, mentions: {display,jid}[]): { text, mentions: string[] }`
  — para cada registro, troca a **primeira** ocorrência restante de `@display`
  por `@<user(jid)>`; coleta JIDs (dedup). Registro cujo `@display` não existe
  mais → descartado (foi apagado/alterado).
- `mentionJidsOf(metadata): string[]` — lê `_data.mentionedJidList` (recebidas)
  e `mentions` (nossas enviadas); normaliza para array de strings.
- `tokenizeMentions(content, jids, resolve): Array<string | { jid, label }>` —
  acha `@<user>` de cada JID no texto (início/meio/fim, múltiplas).

### 4.12 `apps/dashboard/src/ui/MentionAutocomplete.tsx` (novo)
- Props: `items: GroupParticipant[]`, `query: string`, `activeIndex`,
  `onSelect(participant)`, `onClose`, `onHover(index)`.
- Visual: mesma receita `.composer-contact` (classe própria `.composer-mention`
  herdando a cascata de estilo — criar regra copiando os valores existentes, sem
  hex novo); item: avatar (foto ou iniciais), `<strong>` nome, `<span>` número
  formatado (`phoneDisplay` de `messageMedia.ts` já existe), selo `admin` para
  `role==='admin'|'superadmin'`; estados "Carregando…" / "Nenhum participante".
- A11y: `role="listbox"` / `role="option"` + `aria-selected`; o textarea ganha
  `aria-expanded`/`aria-controls` se trivial, senão documentar.
- Filtragem local no pai (Inbox): `name`, `phone`, dígitos do JID — case/acento-insensível (`toLocaleLowerCase('pt-BR')` + normalização como `normalizeTags`
  faz; avaliar `normalize('NFD').replace(/\p{Diacritic}/gu,'')` — decidir e
  cobrir com teste).

### 4.13 `apps/dashboard/src/ui/Inbox.tsx` — integração
- **Ref do textarea** (não existe hoje): `composerRef = useRef<HTMLTextAreaElement>(null)`.
- **Estado:** `mention = useState<{ start:number; query:string } | null>`;
  `mentionActive = useState(0)`; `participantsRef = useRef(new Map<string,
  GroupParticipant[]>())`; `mentionsRef = useRef<Array<{display:string;jid:string}>>`
  (reset ao trocar de conversa — junto de onde `setComposerText("")` acontece em
  `openConversation`).
- **Trigger:** no `onChange` do textarea, além de `setComposerText`, computar
  `mentionTrigger(value, selectionStart)`; só em `isGroup(selected)`. Primeira
  abertura dispara `api.participants(selected.id)` (cache por conversationId;
  falha → popup com erro e retry no próximo `@`).
- **Teclado (novo `onKeyDown` no textarea):** popup aberto ⇒ ArrowDown/ArrowUp
  (preventDefault, move ativo), Enter/Tab (seleciona ativo, preventDefault),
  Esc (fecha, stopPropagation). Popup fechado ⇒ comportamento atual intacto
  (Enter continua quebrando linha).
- **Seleção:** `insertMention` → `setComposerText` → reposiciona o cursor via
  `composerRef` em `requestAnimationFrame`; push em `mentionsRef`
  (`{display: participant.name ?? phoneDigits, jid: whatsappId}`).
- **Submit (`submitMessage` :951-984):** após ler o texto do FormData, aplicar
  `serializeMentions(text, mentionsRef.current)` → `api.sendMessage(id, text',
  mentions')`; limpar `mentionsRef` junto com `setComposerText("")`.
  **Atenção:** o fluxo de anexo usa o mesmo `submitMessage` — menções valem só
  para o ramo `api.sendMessage` (sem anexo); não misturar com caption de anexo.
- **Render:** em `MessageBubble` (:242) trocar `{linkify(message.content)}` por
  `{renderBody(message.content)}` onde `renderBody` = composição de
  `tokenizeMentions` + `linkify` por segmento; `resolve` vem do cache de
  participantes da conversa aberta (buscar participantes também quando a conversa
  de grupo abre, se houver menção nas mensagens — ou simplesmente sempre que for
  grupo; 1 request por abertura é aceitável e segue o anti-N+1). Passar o resolver
  por prop do Inbox → MessageBubble (ex.: `mentionResolver`).
- **Riscos:** arquivo sob edição concorrente — reler antes de cada Edit;
  `submitMessage` é compartilhado com anexo — isolar o ramo.

### 4.14 `apps/dashboard/src/ui/styles.css`
- Bloco `.composer-mention*` (copiar valores de `.composer-contact`) e
  `.chat-inbox .message-mention { ... }` usando **somente hex já existentes**
  (sugestão: texto `#d9bdff`, fundo `#a855f744`, borda `#d8b4fe88` — todos já
  usados); testes de estilo leem o CSS bruto, manter a convenção do bloco
  link-preview (:659-663).
- Atualizar o comentário de cabeçalho do bloco, seguindo o idioma do arquivo.

---

## 5. Menções — mecânica completa

### 5.1 Autocomplete
Abre somente em conversa de grupo, quando o texto antes do cursor casa
`/(?:^|\s)@([\p{L}\p{N} ]{0,30})$/` (sem `\n`). Fecha: Esc, seleção, cursor sair
do token, query > 30, conversa trocar. Conteúdo: participantes ordenados por
recência de atividade → alfabética; filtro local por nome/telefone/dígitos.

### 5.2 Busca de participantes
`GET /api/v1/inbox/conversations/:id/participants` — 1× por conversa (cache
`useRef(Map)` no Inbox). Backend lê `whatsapp_group_participants` + identidades +
contatos (seção 4.6). Sem N+1, sem WAHA ao vivo (frescor via identity.sync já
existente + enqueue fail-open).

### 5.3 Seleção
Enter/Tab/clique: insere `@Nome ` no lugar de `@query`, cursor após o espaço,
registra `{ display, jid }`. Múltiplas seleções acumulam registros.

### 5.4 Envio e payload WAHA
Submit: `serializeMentions` converte `@Nome`→`@5511999990001` e produz
`mentions:["5511999990001@c.us"]`. API valida e repassa; WAHA recebe:
```json
{ "session": "<wahaName>", "chatId": "<grupo>@g.us", "text": "oi @5511999990001 ...",
  "linkPreview": true, "linkPreviewHighQuality": true, "mentions": ["5511999990001@c.us"] }
```

### 5.5 Renderização / recebimento / destaque
- Recebida: `metadata._data.mentionedJidList` → cada `@dígitos` do corpo vira
  `<span class="message-mention">@Nome</span>` (nome via participantes/identidades;
  fallback mantém `@dígitos`).
- Enviada por nós: `metadata.mentions` (gravado pelo `recordOutbound`).
- Múltiplas/início/meio/fim: tokenização cobre todos; segmentos não-menção seguem
  para `linkify` (URLs continuam virando link).

---

## 6. Backend — resumo executivo
- **Controller:** schema `mentions` + 4 validações (grupo, formato JID, presença
  no texto, pertencimento fail-open) + endpoint GET participants (+enqueue sync).
- **Service (`internal-inbox`):** `send` aceita e repassa; `payload.mentions`
  persiste nas nossas mensagens. `deliver` intocado.
- **Store (`waha-webhook`):** `listGroupParticipants` nas duas implementações.
- **Contratos:** `internalSendMessageCommandSchema.payload.mentions` opcional.
- **Worker:** repasse `ports → transport-server → provider → client`.
- **WAHA:** `POST /api/sendText` + `mentions` (formato confirmado, seção 2.3).
- **Validações:** zod (shape), semânticas (controller), WAHA (última linha).

## 7. Frontend — resumo executivo
- **Componentes novos:** `MentionAutocomplete` (popup), helpers `mentions.ts`;
  renderer de corpo composto (menção + linkify) — pode ser função em
  `mentions.ts` + `<span>` inline, sem arquivo extra se preferir.
- **Estados novos na Inbox:** `mention` (trigger), `mentionActive` (índice),
  `participantsRef` (cache), `mentionsRef` (registros). Tudo local; zero
  alteração em realtime, Kanban, SLA, anexos, vCard, reações.
- **Edição:** texto livre; apagar o `@Nome` remove a menção no submit
  (serialização só converte o que ainda está no texto).

## 8. Testes

### 8.1 Criados
**Nenhum** (implementação não iniciada).

### 8.2 Cenários a cobrir (planejado no plano aprovado)
- **contracts:** comando `message.send` com `mentions` válido passa; JID inválido
  falha; ausência do campo inalterada.
- **worker:** `waha-client.test.ts` — body inclui `mentions` quando passado e não
  inclui quando ausente; `waha-provider.test.ts` — repasse do comando ao client.
- **api (novo `test/inbox-group-participants.test.ts`, harness `appFor` +
  worker fake de `waha-webhook.test.ts`):** endpoint devolve participantes com
  nome de identidade/contato e ordenação recência→alfabética; 404 conversa
  inexistente; 400 não-grupo; envio com mentions: comando carrega o array,
  `metadata.mentions` persistido, 400 em conversa direta, 400 menção fora do
  grupo (quando tabela populada), filtro de menção ausente do texto.
- **dashboard (novo `ui/InboxMentions.test.tsx`, molde de
  `InboxContactPicker.test.tsx`):** `@` abre lista (mock `api.participants`);
  filtro por nome; ↑↓/Enter/Tab/Esc; clique; insere `@Nome`; submit envia
  `{text com @dígitos, mentions}`; apagar menção remove do envio; render destaca
  menção recebida (`metadata._data.mentionedJidList`) e enviada
  (`metadata.mentions`); múltiplas menções; não-grupo não abre popup.
- **estilos:** regra `.message-mention` usa só hex existentes (padrão
  `Inbox.test.tsx:325`).

### 8.3 Pendentes / fora de escopo
Teste E2E real contra WAHA (manual, roteiro na seção 11); eventos `group.v2.*`;
`mentions:["all"]`.

## 9. Pendências
### 9.1 Obrigatórias (para o aceite)
Toda a seção 4 (contracts → worker → api → dashboard) + testes da seção 8.2 +
verificação (typecheck, testes dos 4 workspaces, build, `git diff --check`).
### 9.2 Melhorias (não escopadas)
Tratar `group.v2.participants` (join/leave/promote) para frescor real; DELETE de
ex-participantes no sync; chip visual no composer (contenteditable) com remoção
atômica; `mentions:["all"]`; destaque diferenciado quando o mencionado é o
próprio workspace; avatar real de participantes (hoje quase sempre null).
### 9.3 Limitações (aceitas)
Ver seção 1.4 (texto puro no textarea; tabela de participantes potencialmente
stale; JIDs `@lid`; menção 1:1 rejeitada).

## 10. Supabase — confirmações
- **Nenhuma migration criada.** **Nenhuma tabela modificada.** **Nenhuma policy,
  RPC, trigger, function ou storage alterados.**
- A implementação planejada usa apenas SELECT (participants/identities/contacts)
  e INSERT runtime da própria aplicação (mensagens/conversas) — como já ocorre
  hoje. Se qualquer continuação exigir alteração de schema, **PARE** e entregue o
  SQL para o usuário aplicar manualmente (regra absoluta do projeto).

## 11. Roteiro de testes em localhost
Pré-requisitos: stack local rodando (`npm run dev:waha` ou `dev:local`),
sessão WhatsApp conectada, e pelo menos um grupo com mensagens recentes (para
`whatsapp_group_participants` estar populada — se o autocomplete abrir vazio,
aguarde/forwarde mensagens no grupo para disparar o identity.sync, ou valide com
o grupo que já recebeu mensagens nas últimas 24h).

1. **Abrir conversa normalmente:** lista de conversas carrega; conversa direta
   abre; envio de texto comum funciona (regressão).
2. **Abrir um grupo** → digitar `@` → lista de participantes abre com nome/
   número/admin; digitar 2–3 letras → filtra; `↓`/`↑` navegam; `Enter` insere
   `@Nome`; repetir com `Tab` e com clique.
3. **Mencionar um usuário:** completar a frase e enviar → no WhatsApp do
   destinatário a mensagem chega COM menção (notificação de mencionado);
   no balão enviado, `@Nome` aparece destacado.
4. **Mencionar vários usuários** na mesma mensagem (início, meio e fim do texto)
   → todos recebem menção; destaque em todas.
5. **Apagar menção:** inserir `@Nome`, apagar o texto da menção e enviar →
   mensagem sai sem menção (payload sem aquele JID).
6. **Receber menções:** de outro aparelho, enviar mensagem mencionando alguém no
   grupo → a Inbox exibe `@Nome` destacado (tempo real, sem refresh).
7. **Grupo grande:** abrir autocomplete em grupo com muitas dezenas de
   participantes → lista filtra sem travar (filtro local, 1 fetch).
8. **Esc/cancelamento:** abrir `@` e apertar Esc → popup fecha e o texto fica
   intacto; Enter continua quebrando linha quando o popup está fechado.
9. **Regressão rápida:** anexo com legenda, vCard, localização, reação e áudio
   continuam funcionando no mesmo composer.

## 12. Estado final
- **Porcentagem:** investigação 100%; planejamento 100% (aprovado); implementação
  **0%**; testes 0%; validação manual 0%.
- **Funcionamento atual:** sistema intacto — nenhuma linha desta feature foi
  escrita por esta sessão; nada foi quebrado.
- **Próximos passos (em ordem):**
  1. Confirmar que nenhuma outra sessão começou menções (`grep -ri mention apps/ packages/`).
  2. Aplicar seção 4 na ordem: contracts → worker → api → dashboard → estilos.
  3. Escrever os testes da seção 8.2 (podem ir junto de cada camada).
  4. Rodar verificação completa (REGRA 5) e o roteiro da seção 11.
  5. Reportar: arquivos alterados, motivos, como testar, limitações (1.4/9.3) e
     o formato WAHA (2.3).
