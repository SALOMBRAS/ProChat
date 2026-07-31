# Conversas de sessão WhatsApp inativa — tratamento

**29/07/2026.** Implementa o que a investigação de `conversas-sessao-anterior.md`
levantou, e corrige uma das conclusões dela.

Nenhuma escrita no banco. Nenhuma migration. As 531 conversas continuam onde
estão, visíveis e pesquisáveis.

---

## O que mudou, em uma frase

A API passa a saber quais sessões WhatsApp ainda existem, **marca** a conversa
presa a uma sessão que não existe mais, **recusa** o envio nela, e **para de
contá-la** nas métricas do painel. Nada é escondido e nada é apagado.

---

## Correção à investigação

A seção 5 daquele documento conclui que o envio numa conversa antiga falha com
`404 NOT_FOUND`. **Isso não vale para 526 das 531 conversas.**

O registro do worker em disco tem esta forma:

```json
{ "sessionId": "9dfec9e5…", "workspaceId": "default-workspace",
  "wahaName": "chatpro-87a9de04…",
  "aliases": ["chatpro-42217e8d…"] }
```

`WahaProvider.matchesWaha` (`apps/worker/src/waha-provider.ts:107`) casa por
alias, e `sendText` (`:57`) chama a WAHA com `stored.wahaName` — o nome **vivo**.
A investigação mediu `GET /api/sessions/chatpro-42217e8d…` → 404 na WAHA, mas o
worker resolve o alias antes de chegar lá; o alias foi escrito por `reconcile()`
(`:97`) quando o pareamento antigo sumiu e havia exatamente um candidato.

O que acontecia de verdade ao responder numa dessas conversas:

1. a mensagem **saía**, pelo número atual;
2. o outbound era gravado sob a sessão morta, porque `recordOutbound` usa
   `conversation.whatsappSessionId` (`internal-inbox.service.ts:74`);
3. a resposta do cliente chegava pelo webhook carimbada com a sessão **viva** e
   caía em **outra** conversa.

Thread partida, silenciosamente. Isso é pior que a recusa limpa que o documento
descreve, e é o motivo pelo qual a marcação sozinha não bastava.

As 5 conversas de `chatpro-a14338b9…` não têm alias e falham no worker, com
`NOT_FOUND`, antes de qualquer chamada à WAHA.

---

## De onde vem a verdade sobre "qual sessão está viva"

Não do banco: não existe tabela de sessões no ChatPro, e `waha_session` é um nome
denormalizado em sete tabelas. **Mas não é preciso criar uma.**

`SessionSummary` já carrega `wahaName` e `status`
(`packages/contracts/src/index.ts:28`), e `InternalSessionService.list()` já
estava injetado no `InboxController` e no `DomainController`. O novo
`WhatsAppSessionActivityService` só passa a usá-lo, com cache de 30 s por
workspace — sem isso a lista de conversas viraria uma chamada à WAHA por
requisição.

Duas decisões dentro dele merecem leitura:

**Falha aberto.** Worker fora do ar, timeout, provider que não preenche
`wahaName` (Baileys, demo) — em todos, `activeSessions` devolve `undefined` e
todo chamador trata tudo como ativo. Marcar como morta uma conversa viva é o
único erro que não pode acontecer: há 62 números com conversa nas duas sessões, e
a viva não pode perder o envio por causa de uma falha de infraestrutura.

**O status não entra na conta.** O problema são sessões que *deixaram de
existir*. Uma que está apenas `stopped` ou reconectando continua na lista e volta
sozinha; filtrar por `connected` faria a marcação piscar a cada reconexão e
bloquearia envio na sessão certa. Sessão que existe mas não está conectada já é
recusada adiante pelo worker, com `CONFLICT`.

---

## O que a API passou a fazer

### 1. Marcar, sem esconder

`ConversationSummary` ganhou `whatsappSessionActive`. A listagem devolve os
mesmos itens, na mesma ordem, com o mesmo total — o campo é o único acréscimo.
Vale para `GET /inbox/conversations`, `GET /inbox/conversations/:id` e
`GET /inbox/integrity/quarantine`.

Ausente significa "não perguntei"; o consumidor deve tratar como ativa.

> **Pendente no dashboard.** A marcação visual e o desabilitar do compositor
> ficam para um PR seguinte: `apps/dashboard/src/ui/Inbox.tsx` está em edição por
> outra frente. Enquanto isso o operador descobre pela recusa do envio, que é
> tipada e explícita — não é falha silenciosa.

### 2. Recusar o envio

`InternalInboxService.deliver` e `AttachmentOutboxService.create` recusam com
`409 CONFLICT` e `details.reason = 'whatsapp_session_inactive'` antes de chamar o
worker. O código de erro reaproveita `CONFLICT` de propósito: `errorCodes` é uma
união fechada no contrato, e o `reason` distingue esta recusa sem mexer nela. A
mensagem não cita o nome da sessão — identificador técnico não chega ao operador.

No anexo a recusa vem **antes** da linha de outbox e do upload: recusar depois
deixaria um job `failed` e um arquivo no storage por até 24 h para um envio que a
conversa nunca deveria ter permitido.

### 3. Parar de contar no painel

| painel | antes | depois | onde |
|---|---:|---:|---|
| Kanban, etapa "Novo" | 627 | **123** | `kanban.service.ts`, `supabase-kanban.service.ts` |
| Kanban, cards no board | 630 | **126** | idem |
| `/domain/dashboard` → Conversas | 630 | **126** | `sqlite-domain.repository.ts`, `supabase-domain.repository.ts` |
| `/inbox/operations/sla-summary` | 61 ativas, 54 vencidas | **61 e 54 — igual** | nenhuma mudança |
| Inbox, total da lista | 630 | **630 — igual** | marcação, não filtro |

O Kanban era a fonte real do problema, e a investigação não chegou a olhar: 504
dos 630 cards são de sessão morta, todos na etapa "Novo". Eles entraram porque
`KanbanService.ensure()` faz backfill de **toda** conversa visível a cada
`GET /inbox/kanban/boards` — sem filtro de sessão. Limpar a tabela sem corrigir
isso seria desfeito no GET seguinte.

> **Estado em 2026-07-31:** o mecanismo descrito no parágrafo acima mudou de
> lugar. A **#92** dividiu `ensure()` em `ensureBoard()`, O(1), e
> `backfillStates()`, O(conversas) — e tirou a varredura do `GET` e da ingestão:
> hoje ela só roda por `POST /api/v1/inbox/kanban/backfill`, sob comando.
>
> O filtro de sessão desta PR acompanhou a mudança e **mora agora no reparo**,
> que é o único caminho que ainda varre conversa. O efeito continua o mesmo —
> conversa de sessão que a WAHA não conhece mais não ganha card — mas a frase
> "seria desfeito no GET seguinte" deixou de valer: o GET não repovoa mais nada.
>
> A contagem por etapa continua filtrada como descrito, e é ela que leva o
> painel de 630 para 126. O que mudou é quando os cards deixam de **nascer**,
> não quando deixam de ser **contados**.

De quebra, o contador de etapa no Supabase passou a juntar `conversations`, como
o SQLite sempre fez. Antes ele contava `conversation_kanban_state` sozinha e
incluía card de conversa em quarentena: os dois provedores divergiam no mesmo
número do painel, independentemente deste assunto.

---

## `sla.service.ts` não precisou mudar. Por quê

Medido em 29/07: **61 linhas em `conversation_sla_metrics`, 61 da sessão viva, 0
das sessões antigas.** O vermelho do painel (54 `expired`) é todo de conversa
viva.

E não há caminho para isso mudar sozinho:

- `summary()` (`sla.service.ts:73`) monta todos os totais a partir de
  `listDue`, que lê exclusivamente `conversation_sla_metrics`. Nunca consulta
  `conversations`. Uma conversa só entra no painel se tiver linha.
- A **única** criadora de linha é `SlaService.message` com inbound
  não-histórico (`:47` e `:49`). `status`, `reopen` e `tick` são update-only e
  devolvem antes de escrever quando a linha não existe — então mudar status pela
  Inbox, mover card no Kanban ou atribuir operador não cria linha nenhuma.
- Toda ingestão que cita uma sessão antiga vem de history sync, e chega com
  `historical: true`, barrada em `:47`. Webhook novo sempre carimba a sessão
  viva.

Filtrar por sessão dentro de `listDue` custaria um join com `conversations` a
cada tick de 60 s e a cada leitura do painel, para excluir zero linhas. A
invariante ficou prendida por teste
(`test/whatsapp-session-activity.test.ts`, "o painel de SLA e as conversas de
sessão anterior") em vez de por código: um history sync de sessão antiga tem que
deixar `conversation_sla_metrics` vazia e `summary().totals` zerado, e uma
mensagem pela sessão viva tem que continuar abrindo o relógio.

**Impacto esperado nos números do SLA: nenhum.** Se algum dia mudar, muda de uma
vez e para cima — daí o teste.

---

## Os cards já gravados

O código para de criar e de contar, mas não apaga: os 504 cards continuam em
`conversation_kanban_state` e continuariam aparecendo na *lista* de cards da
etapa, que lê a tabela.

O SQL para removê-los está em **`docs/migrations-propostas-sessao-inativa.sql`**,
com as conferências executáveis e o `DELETE` comentado. **Não foi executado.**
Ele apaga card, e só card — conversa, mensagem, identidade e contato ficam
intactos. A forma do arquivo está prendida por
`apps/api/test/sessao-inativa-sql.test.ts`.

Reapontar as conversas para a sessão viva **não** está proposto: a chave única é
`(workspace_id, waha_session, chat_id)` e 62 `chat_id` existem nas duas sessões,
então o `UPDATE` colide em 62 linhas; e não está estabelecido que as três sessões
parearam o mesmo número.

---

## O que este PR deliberadamente não faz

- **Não esconde nada.** Nem da Inbox, nem da lista de cards do Kanban.
- **Não escreve no banco.** Nenhuma migration, nenhum SQL executado.
- **Não filtra routing.** `openCount` e `distribute`
  (`routing.service.ts`) também ignoram a sessão, mas hoje nenhuma conversa de
  sessão morta tem `assigned_user_id`, `assigned_team_id` ou `routing_queue_id`
  — medido: zero em todas as três. A distribuição só é disparada por inbound, que
  nunca chega numa sessão que não existe. É lacuna latente, não contaminação.
- **Não persiste a lista de sessões.** Continua vindo da WAHA a cada 30 s. Uma
  tabela de sessões resolveria isto e o próximo repareamento de uma vez, mas é
  migration — e migration não se faz sem pedido.

---

## Como conferir

```bash
cd web && npm run typecheck && npm test && npm run build
```

Da API (`cd web/apps/api`):

```bash
npx vitest run test/whatsapp-session-activity.test.ts \
               test/inactive-session-metrics.test.ts \
               test/sessao-inativa-sql.test.ts
```

Cada alteração de produção foi conferida revertendo-a uma por vez e verificando
que algum teste quebra — as doze quebram.
