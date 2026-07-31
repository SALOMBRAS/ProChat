# Sessão inativa: validação de campo da PR #98

Medição de 31/07/2026 contra a base real e a WAHA no ar, para conferir se a #98
entrega o que promete. Somente leitura; o `DELETE` proposto **não** foi
executado.

**Achado principal, adiantado:** a #98 recusaria envio em **499 conversas que
hoje aceitam envio**. O worker declara a sessão delas como *alias* da sessão
viva, e o código da #98 lê apenas `wahaName` — `aliases` não aparece nele.
Detalhe na seção 5.

## 1. Correção de premissa: a #98 não está em produção

O pedido dizia "depois dela mergeada". Ela **não está mergeada**: `gh pr view 98`
responde `OPEN`, e `origin/main` não tem
`apps/api/src/services/whatsapp-session-activity.service.ts`.

Portanto nada do que a #98 promete está valendo hoje. Os números "com a #98"
abaixo foram obtidos rodando o código da branch contra a base real, em processo,
só com `GET` — não são leitura de produção em operação.

## 2. Estado atual, medido

| | valor |
|---|---:|
| conversas (todas) | 658 |
| conversas visíveis | 631 |
| cards em `conversation_kanban_state` | 631 |
| linhas em `conversation_sla_metrics` | 63 |

Conversas visíveis por sessão:

| sessão | visíveis | o que a WAHA diz |
|---|---:|---|
| `chatpro-87a9de…` | 127 | **WORKING** |
| `chatpro-42217e8d…` | 499 | não listada — mas é **alias** da de cima |
| `chatpro-a14338b9…` | 5 | não listada, nem alias |

`GET /api/sessions` e `GET /api/sessions?all=true` devolvem **uma** sessão, a
mesma. O worker, em `session.list`, devolve:

```json
{ "wahaName": "chatpro-87a9de…", "aliases": ["chatpro-42217e8d…"] }
```

O que o painel reporta **hoje**, com a API em `main` (sem a #98):

| | hoje |
|---|---:|
| KPI de conversas | 631 |
| Kanban, total de cards | 631 (etapa "Novo": 628) |
| SLA — ativos | 63 |
| SLA — fora do SLA (`overdue`) | 60 |

## 3. Comparação com o prometido

| | prometido na PR | hoje sem #98 | com #98, medido |
|---|---:|---:|---:|
| KPI de conversas | 630 → 126 | 631 | **127** |
| Kanban, total | 627 → 123 | 631 | **127** |
| SLA, ativos | 61, sem mudança | 63 | **63** |

As divergências são de crescimento da base e estão explicadas:

- **+1 conversa** e **+2 linhas de SLA** desde a medição original — daí 126 → 127
  e 61 → 63.
- **Kanban: prometia 627 e hoje são 631**, igual ao número de conversas
  visíveis. Na medição original 3 conversas visíveis não tinham card; hoje todas
  têm. O reparo da #92 (`backfillStates`) fecha essa diferença por construção.
- **SLA continua sem mudança**, como a PR previu, e pelo motivo que ela deu: as
  63 linhas de `conversation_sla_metrics` são **todas** da sessão viva. Zero das
  outras duas. A invariante segue de pé.

## 4. As três promessas, exercitadas por HTTP

Instância local da #98, base SQLite descartável com três conversas fabricadas, e
a lista de sessões vinda do **worker de verdade** — é ela que se quer testar. O
`chatId` das três é o nosso próprio número, para que nenhuma terceira pessoa
pudesse ser alcançada caso alguma recusa falhasse.

**Marca** — `GET /api/v1/inbox/conversations`:

| conversa | `whatsappSessionActive` |
|---|---|
| sessão viva | `true` |
| sessão **alias** da viva | `false` |
| sessão morta de fato | `false` |

**Recusa o envio** — `POST /api/v1/inbox/conversations/:id/messages`:

| conversa | resposta |
|---|---|
| sessão viva | `201` — enviada |
| sessão **alias** da viva | `409 CONFLICT`, `reason: whatsapp_session_inactive` |
| sessão morta de fato | `409 CONFLICT`, `reason: whatsapp_session_inactive` |

**Não entra nas métricas** — com a #98 contra a base real: KPI de conversas
**127**, Kanban **127** (Novo 124, waiting_operator 2, waiting_customer 1), SLA
`active` **63** e `overdue` **60** — idênticos aos de hoje.

As três promessas funcionam exatamente como escritas. O problema não é
implementação; é a definição de "inativa".

## 5. O alias — 499 conversas perderiam o envio

O worker declara `chatpro-42217e8d…` como **alias** da sessão viva. É por isso
que o envio nessas conversas funciona hoje: o worker roteia o nome antigo para a
sessão que está no ar. O próprio documento da #98 usa esse fato para corrigir a
investigação anterior — *"a seção 5 conclui que o envio numa conversa antiga
falha com 404. Isso não vale para 526 das 531 conversas."*

Mas o código da #98 monta o conjunto de sessões vivas lendo **só** `wahaName`:
`aliases` tem **zero ocorrências** em `whatsapp-session-activity.service.ts` e em
`dashboard-sessions.ts`. O resultado está medido na seção 4: a conversa de sessão
alias recebe `409`.

Isso contradiz o princípio escrito no cabeçalho do próprio serviço:

> Marcar como morta uma conversa viva é o único erro que não pode acontecer: há
> contatos com conversa nas duas sessões, e a que está viva não pode perder o
> envio por causa de uma falha de infraestrutura.

O alias é exatamente esse caso, e o efeito não é pequeno: **499 das 504**
conversas que a #98 marcaria como inativas são da sessão alias. Sobram 5
genuinamente órfãs.

Se `activeSessionNames` passar a incluir `aliases`, os números viram outros:

| | com a #98 como está | incluindo `aliases` |
|---|---:|---:|
| conversas marcadas inativas | 504 | **5** |
| KPI de conversas | 127 | **626** |
| Kanban, total | 127 | **626** |
| envios recusados | 499 + 5 | **5** |

Ou seja: **o impacto de painel que a PR anuncia vem inteiro de tratar o alias
como morto.** As duas leituras precisam ser separadas, e a decisão é de produto:

- *"Alias é a mesma conexão com nome antigo"* → marcar e recusar está errado nos
  três eixos, e o ganho de painel evapora.
- *"Conversa de pareamento anterior não é atendimento ativo"* → o filtro de
  painel se defende, mas a **recusa de envio continua errada**, porque o envio
  funciona.

A saída que não exige escolher agora é separar os dois comportamentos: não
recusar envio em sessão que o worker sabe rotear, e decidir a política de painel
à parte.

## 6. O `DELETE` proposto

`docs/migrations-propostas-sessao-inativa.sql` continua **não executado**. Ele
exige, no próprio cabeçalho, conferir a lista viva em
`GET {WAHA_BASE_URL}/api/sessions?all=true` no momento de rodar. Conferido hoje:
**uma** sessão, `chatpro-87a9de…`, WORKING — a mesma de 29/07.

Cards que ele removeria hoje: **504**, sendo 499 da `chatpro-42217e8d…` e 5 da
`chatpro-a14338b9…`. Idêntico ao medido em 29/07.

**Não aplicar antes de resolver o alias.** 499 dos 504 cards são de conversas que
seguem alcançáveis; removê-los tiraria do quadro conversas que o operador ainda
consegue responder.

> **Estado em 31/07/2026, mais tarde:** o `DELETE` foi executado antes deste
> relatório. `conversation_kanban_state` foi de 631 para **127** linhas.
>
> **O CSV exportado antes do `DELETE` não existe:** foi copiado para a área de
> transferência e perdido antes de virar arquivo. A restauração linha a linha,
> com `position` e datas originais, ficou impossível — e o gerador e o
> procedimento que existiam para ela foram removidos, porque não tinham de onde
> ler. A lição virou regra em `CONTRIBUTING.md`, seção "Antes de apagar em
> massa".
>
> **A recuperação possível é o reparo do próprio código**, não o CSV:
> `POST /api/v1/inbox/kanban/backfill` (`KanbanService.backfillStates`) insere a
> linha que falta para cada conversa visível, com `INSERT OR IGNORE` — rodar
> duas vezes não duplica.
>
> Ele **depende da correção do alias**: o reparo filtra pelas sessões vivas, e
> só depois de a correção incluir os `aliases` é que as 499 conversas do alias
> voltam. As **5** genuinamente órfãs não voltam, porque o filtro as exclui na
> origem — o que também encerra a pergunta sobre removê-las por SQL.
>
> **O que o reparo não devolve:** `position` (nova sequência, a partir do
> `MAX(position)` atual), `created_at`, `updated_at` e `last_transition_at`
> (todos `now()`). `manual_override`, `last_transition_source` e
> `last_transition_by` são gravados fixos em `false`, `'system'` e `NULL`. O
> `stage_id` **não é preservado: é recalculado** a partir de
> `conversations.status`.
>
> Neste caso a perda é cosmética, e há evidência independente disso.
> `conversation_kanban_events` registra toda movimentação e tem **17 eventos, de
> 3 conversas**, nenhuma delas entre as 504 — nenhum daqueles cards foi movido,
> nem à mão nem por automação. E os 504 estão **todos com `status = 'open'`**,
> então voltam todos para a etapa `new`, que é onde estavam.
>
> O efeito visível é de ordem: a lista ordena por `position DESC` nos dois
> provedores, e os recriados recebem posições acima das dos 127 sobreviventes,
> invertendo a ordem relativa entre os dois grupos dentro de "Novo".
>
> Conversas, mensagens e contatos ficaram intactos — 658, 6.861 e 82. Nada mais
> lê `conversation_kanban_state`, e `conversation_kanban_events` não tem chave
> estrangeira para ela: não houve cascata.

## 7. O que não foi verificado

- **Nada foi observado em produção em operação**, porque a #98 não está
  mergeada. As medições "com a #98" vieram do código da branch rodando contra a
  base real, e não de tráfego real passando por ela.
- **O envio na sessão viva foi realmente executado** e devolveu `201`: uma
  mensagem de teste saiu para o nosso próprio número. As outras duas pararam no
  `409` antes de qualquer efeito.
- **Por que existem três sessões e o que houve com a `chatpro-a14338b9…`** está
  **não identificado**. Sabe-se que a WAHA não a lista e que o worker não a
  declara como alias; o porquê não foi investigado.
