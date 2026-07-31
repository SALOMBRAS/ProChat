# Conversas de sessões WhatsApp anteriores — investigação

> **Corrigido em 29/07/2026 — a seção 5 está errada para 526 das 531 conversas.**
> O envio nelas **não** falha: o worker reconcilia o nome da sessão por alias e a
> mensagem sai pelo número atual, ficando gravada na conversa antiga enquanto a
> resposta do cliente cai na conversa nova. Ver `conversas-sessao-inativa.md`,
> que também traz o tratamento implementado.

**28/07/2026. Somente leitura.** Nenhum código foi alterado, nada foi escrito no
banco e nenhuma mensagem foi enviada. O acesso ao Supabase foi `GET` via PostgREST;
o acesso à WAHA foi `GET` em `/api/sessions`.

Este documento só descreve o que existe. **Não propõe SQL nem implementa nada.**

---

## Resumo

A suspeita de que a Inbox está tomada por uma sessão morta **se confirma**: 531 das
655 conversas (81 %) pertencem a duas sessões que não existem mais na WAHA, e
**504 delas aparecem na Inbox hoje**.

Mas a suspeita de que isso distorce o painel de SLA **não se confirma**: as 59
linhas de SLA são todas da sessão ativa. O vermelho atual não vem daí.

| pergunta | resposta |
|---|---|
| Aparecem na Inbox? | **Sim** — 504 conversas, sem nenhum filtro de sessão |
| Entram nas métricas de SLA? | **Não** — zero linhas de SLA nas sessões antigas |
| O envio funciona nelas? | **Não** — erro `404 NOT_FOUND` explícito, sem falha silenciosa |
| Recebem mensagem nova? | **Não** — a última é de 21/07, antes de a sessão atual nascer |
| Há duplicação? | **Sim** — 62 chats existem nas duas sessões |

---

## 1. Quantas sessões existem e quais estão ativas

Três valores distintos em `conversations.waha_session`:

| sessão | conversas | mensagens | estado na WAHA |
|---|---:|---:|---|
| `chatpro-87a9de04…` | **124** | 5 298 | **`WORKING`** — ativa |
| `chatpro-42217e8d…` | **526** | 1 481 | **não existe** (`404 Session not found`) |
| `chatpro-a14338b9…` | **5** | 32 | **não existe** (`404 Session not found`) |
| total | 655 | 6 811 | |

A WAHA conhece **uma única sessão**, `chatpro-87a9de04…`, em estado `WORKING`,
pareada à conta que termina em `…9359`. As outras duas retornam
`{"message":"Session not found","statusCode":404}`.

**Conversas em sessão inexistente: 531** — o mesmo número medido pelo terminal 1.

Não existe tabela `whatsapp_sessions` no Supabase (`404` no PostgREST): o registro
de qual sessão é a atual não está no banco do ChatPro, só na WAHA.
Como as três sessões foram criadas e por que as duas primeiras foram descartadas:
**não identificado**.

### Cronologia — as sessões não se sobrepõem no tempo

Pelo `received_at` das mensagens, que é quando o ChatPro ingeriu:

| sessão | ingestão de | até | duração |
|---|---|---|---|
| `chatpro-a14338b9…` | 17/07 02:31 | 17/07 04:38 | ~2 horas |
| `chatpro-42217e8d…` | 20/07 13:28 | 21/07 15:04 | ~26 horas |
| `chatpro-87a9de04…` | 21/07 18:18 | **agora** | 7 dias |

São três pareamentos sucessivos, cada um substituindo o anterior. A troca de
`42217e8d` para `87a9de04` levou 3h14 (21/07 15:04 → 18:18).

---

## 2. As conversas antigas têm mensagens? De quando?

**Sim: 1 513 mensagens** (1 481 + 32), contra 5 298 na sessão ativa.

O `last_message_at` das 531 vai de **23/10/2024** a **21/07/2026**, espalhado por 22
meses — é histórico real, sincronizado de uma vez pelo history sync durante as ~26
horas em que a sessão `42217e8d` esteve viva:

```
2024-10:  3   2025-03:  6   2025-08: 18   2026-01: 13   2026-06:  50
2024-11: 24   2025-04: 10   2025-09: 23   2026-02: 18   2026-07: 114
2024-12: 20   2025-05: 12   2025-10: 11   2026-03: 10
2025-01: 28   2025-06: 21   2025-11: 25   2026-04: 18
2025-02:  6   2025-07: 22   2025-12: 18   2026-05: 61
```

### Alguma recebeu mensagem depois que a sessão atual foi criada?

**Não. Nenhuma.**

- última ingestão na sessão antiga: **21/07/2026 15:04:03**
- primeira ingestão na sessão atual: **21/07/2026 18:18:30**

As janelas não se cruzam. Depois que a sessão atual entrou no ar, **nenhuma
mensagem foi gravada nas sessões antigas** — o que é coerente com elas não
existirem mais na WAHA, logo não haver webhook que as cite.

Consequência: as 531 são um acervo **congelado**. Não crescem e não vão crescer.

---

## 3. Aparecem na Inbox? O filtro considera a sessão?

**Aparecem. O filtro NÃO considera a sessão** — só `workspace_id` e
`visibility_state`.

**SQLite** — `apps/api/src/services/waha-webhook.service.ts:60`:

```ts
const where = ["c.workspaceId = ?", "c.visibilityState = 'visible'", …]
```

**Supabase** — `apps/api/src/services/waha-webhook.service.ts:99`:

```ts
.eq('workspace_id', workspaceId).eq('visibility_state', 'visible')
```

Nenhum dos dois tem `waha_session` na cláusula. O mesmo vale para
`listQuarantined` (linhas 61 e 100) e para `getConversation` (linha 103).

O único filtro que separa as antigas hoje é `visibility_state`, e ele não foi feito
para isso — é a quarentena de integridade. Distribuição das 531:

| `visibility_state` | conversas | aparece na Inbox? |
|---|---:|---|
| `visible` | **504** | **sim** |
| `quarantined` | 26 | não (vai para a fila de quarentena) |
| `technical` | 1 | não |

**504 conversas de um pareamento que não existe mais estão na lista principal**,
misturadas às 124 da sessão ativa — 80 % da Inbox.

Ordenação por `last_message_at DESC` (linha 60/99): as antigas mais recentes são de
21/07, então elas **não** ficam todas no fim. Uma conversa antiga de 21/07 aparece
acima de uma conversa ativa de 20/07.

Não lidas nas 504 visíveis: **25 conversas, somando 31 não lidas** (contra 95
conversas e 289 não lidas na sessão ativa).

---

## 4. Entram nas métricas do painel?

**Não. Nenhuma.** Este é o achado que contraria a hipótese inicial.

O painel usa `SlaService.summary()` — `apps/api/src/services/sla.service.ts:73` —
que monta *todos* os totais (`active`, `waitingOperator`, `overdue`, `withinSla`) e
todas as médias (`operatorWaitSeconds`, `customerWaitSeconds`,
`firstResponseSeconds`) a partir de uma única fonte:

```ts
const rows = await this.store.listDue(workspaceId);
```

E `listDue` lê **exclusivamente `conversation_sla_metrics`**:

- SQLite — `sla.service.ts:89`: `SELECT * FROM conversation_sla_metrics WHERE frozenAt IS NULL AND workspaceId = ?`
- Supabase — `sla.service.ts:99`: `.from('conversation_sla_metrics').is('frozen_at', null).eq('workspace_id', …)`

`summary()` **nunca consulta `conversations`**. Uma conversa só entra no painel se
tiver linha em `conversation_sla_metrics`.

**Medição:** das 59 linhas de `conversation_sla_metrics`, **59 pertencem à sessão
ativa e 0 às antigas.**

| origem | linhas de SLA | status |
|---|---:|---|
| sessão ativa | **59** | `expired` 54, `waiting_customer` 5 |
| sessões antigas | **0** | — |

### Por que elas não têm linha de SLA

Duas causas somadas, ambas verificadas:

1. **O SLA passou a existir depois.** A linha de `conversation_sla_metrics` mais
   antiga tem `updated_at` de **24/07 13:17**. A sessão `42217e8d` parou de ingerir
   em **21/07 15:04** — três dias antes. Nunca houve ingestão nessas conversas
   enquanto o SLA existia.
2. **Mensagem histórica não abre SLA.** `sla.service.ts:46-47`:
   ```ts
   async message(workspaceId, conversationId, direction, occurredAt, historical) {
     if (historical) return;
   ```
   O acervo das sessões antigas veio de history sync, e o webhook passa
   `historical: Boolean(persisted.historical)` para `sla.run(...)`.

### Quanto do vermelho vem delas

**Zero.** Os 54 `expired` do painel são todos de conversas da sessão ativa.

Se um dia essas conversas passarem a ter linha de SLA — por qualquer caminho que
gere ingestão não-histórica nelas — o painel mudaria bruscamente. Hoje não é o caso.

**Ressalva de escopo:** isto vale para o painel de SLA
(`/inbox/operations/sla-summary`). Se existir algum outro contador no dashboard que
conte conversas direto de `conversations`, ele **incluiria** as 504 — não auditei
todos os contadores do frontend, porque `web/apps/dashboard/` está fora do escopo
desta tarefa. **Não identificado** para os demais widgets.

---

## 5. O envio funciona nelas?

> **CORRIGIDO EM 29/07/2026. A conclusão abaixo vale só para as 5 conversas de
> `chatpro-a14338b9…`.** Para as 526 de `chatpro-42217e8d…` o envio **funciona**:
> o registro do worker guarda esse nome como *alias* da sessão viva
> (`waha-provider.ts:107` casa por alias, `:57` envia com `stored.wahaName`), e a
> cadeia abaixo nunca chega ao passo 3 — a WAHA não é consultada com o nome
> morto. O passo 1 continua correto e é justamente o problema: a mensagem sai
> pelo número atual mas é gravada na conversa antiga, e a resposta do cliente
> volta carimbada com a sessão viva, em outra conversa. Ver
> `conversas-sessao-inativa.md`.

**Não. Falha com `404 NOT_FOUND` e mensagem explícita.** Não é falha silenciosa, e
**não** cai para a sessão nova.

Determinado por leitura de código, mais uma verificação de leitura contra a WAHA
(`GET` numa sessão inexistente). Nenhuma mensagem foi enviada.

### A cadeia, passo a passo

1. **A API usa a sessão gravada na conversa, não a ativa.**
   `apps/api/src/services/internal-inbox.service.ts:21`:
   ```ts
   command: { type: 'message.send',
              payload: { wahaSession: conversation.whatsappSessionId, chatId: deliveryChatId, text } }
   ```
   `whatsappSessionId` vem de `c.wahaSession` no `SELECT` de
   `waha-webhook.service.ts:65`. Numa conversa antiga, é o nome da sessão morta.
   **Não existe fallback para a sessão ativa em lugar nenhum do caminho.**

2. **O worker repassa como veio.**
   `apps/worker/src/waha-client.ts:66` → `POST /api/sendText` com `{ session, chatId, text }`.

3. **A WAHA recusa.** Verificado por `GET /api/sessions/chatpro-42217e8d…`:
   ```
   HTTP 404
   {"message":"Session not found","error":"Not Found","statusCode":404}
   ```

4. **O cliente transforma em erro tipado.** `waha-client.ts` (dentro de
   `requestResponse`): `if (!response.ok) throw new WahaClientError('response', response.status, safeProviderMessage(text))`.

5. **O provider mapeia 404 → `NOT_FOUND`.** `apps/worker/src/waha-provider.ts:81`:
   ```ts
   : error.status === 404 ? 'NOT_FOUND'
   ```
   com mensagem `WAHA request failed (404): Session not found`.

6. **A API converte em HTTP 404.** `internal-inbox.service.ts:10` mapeia
   `NOT_FOUND: 404`, e a linha 27 lança
   `new AppError(statusFor(code), response.error.code, response.error.message, …)`.

### O que o operador vê e o que fica no banco

- **Vê:** um erro de envio, com HTTP `404` e código `NOT_FOUND`.
- **Fica no banco:** nada. `recordOutbound` (`internal-inbox.service.ts:37`) só roda
  depois do envio bem-sucedido; o `throw` do passo 6 acontece antes.
- **Log:** `Inbox outbound worker rejected send`, com `workerCode` e `workerMessage`.

Ou seja, o pior cenário — mensagem que parece enviada e não chega — **não ocorre**.
O comportamento é uma recusa limpa.

**Não verificado:** o texto exato que o dashboard mostra ao operador para um `404
NOT_FOUND` (fora do escopo). **Não identificado.**

---

## 6. Sobreposição: o mesmo contato nas duas sessões

Sim, e é substancial.

| medida | valor |
|---|---:|
| `chat_id` presentes em mais de uma sessão | **62** |
| conversas envolvidas nesses 62 chats | **128** |
| — na sessão antiga | 66 |
| — na sessão ativa | 62 |
| `contact_id` presentes em mais de uma sessão | **12** |

Os 62 chats duplicados **cruzam antiga ↔ ativa** em todos os casos. São 66 conversas
antigas (alguns chats aparecem nas duas sessões antigas *e* na ativa) contra 62
ativas.

**O que isso significa na prática:** para 62 números, o operador vê **duas
conversas** na Inbox — uma com o histórico antigo (onde o envio falha) e outra com
as mensagens recentes (onde o envio funciona). Nada na tela distingue as duas.

Só 12 conversas antigas têm `contact_id` preenchido, contra 66 no cruzamento — a
maioria das duplicatas não está ligada a contato do CRM, então o problema aparece
como duas linhas na Inbox, não como contato duplicado.

A chave de unicidade é `(workspace_id, waha_session, chat_id)` — visível no
`ON CONFLICT` de `waha-webhook.service.ts:87`. Por isso trocar de sessão **cria
conversa nova** para o mesmo número, por construção. Não é bug de dado; é
consequência do modelo.

---

## 7. Opções de tratamento

Nenhuma foi implementada. Custos são estimativa de esforço, não medição.

### A. Deixar como está

- **Custo:** zero.
- **Risco:** o operador continua vendo 504 conversas onde não pode responder, e 62
  números duplicados sem distinção visual. O erro só aparece depois de digitar e
  enviar. O acervo é congelado, então **não piora sozinho** — mas piora a cada novo
  repareamento.
- **A favor:** nada é perdido, e o histórico continua pesquisável.
- **Contra:** é o estado que motivou esta investigação.

### B. Marcar visualmente

Sinalizar na Inbox que a conversa é de sessão inativa, e desabilitar o campo de
envio.

- **Custo:** baixo-médio. Exige o dado da sessão ativa chegar ao frontend — hoje
  `ConversationSummary` já carrega `whatsappSessionId`, mas **qual é a ativa** não
  está no banco (só na WAHA), então precisa de uma origem para essa verdade.
- **Risco:** baixo. Não altera dado. O risco é a fonte da verdade ficar errada e
  marcar conversa boa como morta.
- **A favor:** resolve o problema real (o operador saber antes de tentar) sem
  destruir nada, e resolve a duplicação sem mesclar.
- **Contra:** as 504 continuam ocupando a lista e a paginação.

### C. Arquivar / esconder

Tirar as 531 da listagem principal, mantendo acessíveis por filtro ou busca.

- **Custo:** médio. Precisa de um critério persistido (`visibility_state` já existe,
  mas seus valores atuais têm outro significado — reaproveitá-lo misturaria
  quarentena de integridade com sessão inativa).
- **Risco:** **médio-alto.** Um erro de critério esconde conversa ativa. E há um
  precedente a respeitar: `listQuarantined` já usa `visibility_state`, então
  sobrecarregar essa coluna cria ambiguidade difícil de desfazer.
- **A favor:** a Inbox volta a refletir a operação — 124 conversas em vez de 628.
- **Contra:** histórico some da vista; se alguém procurar um cliente antigo e não
  achar, a percepção é de perda de dado.

### D. Migrar para a sessão atual

Reapontar as conversas antigas para `chatpro-87a9de04…`.

- **Custo:** **alto.** Não é um `UPDATE` de uma coluna: `conversations`,
  `whatsapp_messages`, `whatsapp_identities` e `whatsapp_groups` são todas
  chaveadas por `waha_session`, e a unicidade
  `(workspace_id, waha_session, chat_id)` **colide nos 62 chats duplicados** —
  cada colisão exige decidir o que fazer com duas conversas que viram uma.
- **Risco:** **alto e irreversível na prática.** Mescla histórico de dois
  pareamentos; se as sessões tiverem números diferentes, atribui a um número
  conversa que pertenceu a outro. **Não verifiquei se as três sessões pareavam o
  mesmo número** — só a ativa tem `me.id` legível hoje. **Não identificado.**
- **A favor:** seria o único caminho que faz o envio voltar a funcionar no histórico
  antigo.
- **Contra:** se o número for outro, é corrupção de dado com aparência de conserto.

### Observação que atravessa as quatro

Qualquer opção que dependa de "qual é a sessão ativa" precisa dessa informação
**persistida**. Hoje ela existe só na WAHA, e o ChatPro não tem tabela de sessões
(`whatsapp_sessions` → 404). Enquanto isso não existir, o critério depende de uma
chamada externa que pode falhar — e um repareamento futuro recria o problema, agora
com três gerações de conversa em vez de duas.

---

## O que esta investigação não determinou

- Por que as sessões `a14338b9` e `42217e8d` foram descartadas. **Não identificado.**
- Se as três sessões pareavam **o mesmo número**. Só a ativa expõe `me.id` hoje
  (`…9359`); as outras não existem mais na WAHA. **Não identificado.**
- O texto que o dashboard mostra ao operador no erro `404 NOT_FOUND`.
  **Não identificado** — `web/apps/dashboard/` fora do escopo.
- Se algum widget do painel conta conversas direto de `conversations` (e portanto
  incluiria as 504). Auditei `SlaService.summary()`; os demais contadores do
  frontend, **não identificado**.
- Se `whatsapp_identities` e `whatsapp_groups` têm linhas órfãs das sessões antigas.
  Não medido nesta investigação.

## Como os números foram obtidos

- Contagens e datas: `GET` via PostgREST no Supabase de produção, com a chave de
  `web/.env.local`. Nenhuma escrita.
- Estado das sessões: `GET /api/sessions?all=true` e
  `GET /api/sessions/{nome}` na WAHA local. Nenhum envio.
- Comportamento de listagem, SLA e envio: leitura do código em `apps/api/src` e
  `apps/worker/src`, com arquivo e linha citados acima.
