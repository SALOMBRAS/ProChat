# Conflito 40001 em `chatpro_kanban_move` — investigação

> **03/08/2026 — o arrastar-e-soltar não chegava a conflitar.** Um relato de que
> toda movimentação manual mostrava "A movimentação conflitou ou falhou" levou a
> medir na base, e o resultado desmente a leitura mais natural do documento
> abaixo: **nunca houve um conflito manual**, porque a requisição nunca chegou à
> RPC.
>
> `expectedUpdatedAt` era validado com `z.string().datetime()` sem argumento, que
> **recusa deslocamento de fuso** e só aceita o `Z`. O PostgREST devolve
> `+00:00`. Toda tentativa manual contra o Supabase morria em **400**, e a tela
> chamava isso de conflito porque o `catch` era único.
>
> Medido em 03/08/2026, somente leitura:
>
> | | |
> |---|---|
> | eventos `manual` em `conversation_kanban_events` | **0**, desde sempre |
> | eventos em 24 h | 0 |
> | eventos em 7 dias | 6, todos `inbound`/`outbound` |
> | cartões por última transição | **627 `system`**, 3 `inbound`, 0 `manual` |
>
> O SQLite guarda `new Date().toISOString()`, que termina em `Z` e passava — mais
> uma divergência entre provedores que a suíte não via, porque a suíte é SQLite.
>
> Corrigido na PR #132, junto com a regra de desempate que o documento abaixo já
> pedia sem nomear: **a movimentação manual ganha da automação**, e o 409 só
> aparece quando quem moveu foi outra pessoa — aí com o nome da etapa.


**31/07/2026. Somente leitura.** Nenhuma migration foi criada ou aplicada, o banco
remoto não foi consultado nem escrito, nenhuma mensagem foi enviada e o runtime
completo não foi iniciado. Toda a análise é leitura de código no repositório, mais
execução da suíte de testes local em SQLite.

## O que se suspeitava

Um relato de produção apontou 3,4 milhões de erros em 60 minutos, todos com
`MESSAGE "kanban conflict"` e `STATUS 40001`, na `QUERY` que chama
`chatpro_kanban_move` com `p_expected_updated_at`. A hipótese era um *livelock*:
o `KanbanAutomationCoordinator` moveria o card a cada mensagem ingerida, a
sincronização de histórico despejaria mensagens antigas em massa, e alguma
repetição sem espera garantiria o conflito seguinte.

**A hipótese não se sustenta.** As duas metades dela são falsas no código, e a
segunda é falsa em seis camadas independentes.

## Por que a sincronização de histórico não move card

A cadeia é completa e não tem furo:

| Passo | Onde | O que faz |
| --- | --- | --- |
| 1 | `whatsapp-history-sync.service.ts:211` | o sync chama `historyRecord(...)` e entrega ao mesmo `ingest` do webhook |
| 2 | `waha-webhook.service.ts:127` | `historyRecord` carimba `_history: true` **por último no spread**, então o payload da WAHA não pode sobrescrever |
| 3 | `waha-webhook.service.ts:137` | `messageFrom` converte em `historical: value._history === true` |
| 4 | `waha-webhook.service.ts:54` e `:97` | o `IngestResult` repassa `historical: persisted.historical` para `automation.run` |
| 5 | `kanban.service.ts` e `supabase-kanban.service.ts`, primeira expressão de `automated()` | retorna `skipped / ineligible_origin` |

A porta de origem é a **primeira** expressão do método, antes de `await
this.boards(...)`. Uma mensagem de histórico não lê estado, não reivindica
entrega, não chama a RPC: custo zero de banco. E o sync ainda tem uma segunda
barreira antes dessa — o `externalEventId` estável `history:<id>` bate na chave
única de `waha_webhook_events` na segunda passada, então reprocessar não
reingere.

Além disso, o sync ingere **em série** (`await` por mensagem no `for..of`,
`whatsapp-history-sync.service.ts:203`), então duas mensagens do mesmo sync nunca
correm em paralelo contra a RPC.

## Por que não há repetição

Seis candidatos, todos verificados e todos descartados:

1. **Retry no código da API:** não existe. `fail()`
   (`supabase-kanban.service.ts:11`) converte 40001 em `AppError(409,'CONFLICT')`,
   e `KanbanAutomationCoordinator.run` engole a exceção e devolve
   `{status:'failed'}`. Terminal, sem laço.
2. **Retry do cliente Supabase:** o `postgrest-js` só reenvia métodos
   idempotentes (`RETRYABLE_METHODS = ["GET","HEAD","OPTIONS"]`). `rpc()` é POST
   e nunca é reenviada — nem em 503/520, nem em erro de rede.
3. **Reentrega de webhook pela WAHA:** o endpoint devolve 202 (novo) ou 200
   (duplicado) e **nunca** 5xx por falha do Kanban. Mesmo um 500 por outra causa
   custa 1 `INSERT` e **zero** RPC na reentrega: o insert em
   `waha_webhook_events` bate na PK e retorna antes da automação.
4. **Cron, trigger ou tick:** não existem. Os únicos `setInterval` da API são o
   `sla.tick` (que só escreve em `conversation_sla_metrics`) e a limpeza de
   anexos. Nenhum `CREATE TRIGGER` e nenhum `pg_cron` nas migrations versionadas.
5. **Realimentação pelo dashboard:** o `InboxKanban` reage a
   `conversation.kanban.moved` só com `load()`, que são `GET`s; no `catch` de
   conflito ele restaura o snapshot e **não** repete o `POST`. O transporte do
   dashboard não tem retry. O servidor WebSocket não registra handler de mensagem
   vinda do cliente.
6. **`applyOperationalStatus` dentro do `move`:** escreve apenas em
   `conversation_sla_metrics` e publica `conversation.sla.updated`, que o cliente
   trata com patch local. Não realimenta a automação.

O teto é rígido e aritmético: **1 chamada da RPC por `(workspace, conversa,
mensagem, direção)`**, porque a reivindicação em `kanban_automation_deliveries`
é inserida **antes** do move. Um 40001 sequer podia ser retentado — a
idempotência já estava queimada.

## O que é real

### 1. A automação optava por concorrência otimista sem ter a quem informar

O controle otimista existe para avisar **uma pessoa** que outra moveu o card
enquanto ela arrastava. A automação não tem operador a quem avisar, e perder a
corrida significava card parado com a mensagem já contabilizada como entregue.

Pior: o `expectedUpdatedAt` era lido e só chegava à RPC depois de `boards()`, do
`INSERT` de reivindicação, do `requireStage()` e do `position()` — a janela entre
a leitura e a escrita tinha vários *round trips*.

Havia ainda divergência entre provedores, contra a regra crítica nº 1 do
`CLAUDE.md`: o `automated()` do Supabase passava `expectedUpdatedAt`, e o do
SQLite não passava — o mesmo laço automático era conflitável num provedor e
sobrescrevia o outro em silêncio.

### 2. `ensure()` custa O(C) por mensagem — **não corrigido aqui**

`automated()` chama `boards()`, que chama `ensure()`
(`supabase-kanban.service.ts:34`). O `ensure()` faz um `SELECT` **sem `limit`**
de todas as conversas visíveis do workspace e um `upsert` de estado para todas
elas, mais um `count` por etapa. São ~13 *round trips* e 2·C linhas tocadas por
mensagem elegível — inclusive quando o veredito acaba sendo `stage_rule` e
nenhum card se move.

Isso viola a regra crítica nº 4 do `CLAUDE.md` ("não carregue listas inteiras")
e é o candidato mais forte para a pressão de recursos observada, já que escreve
exatamente na tabela que a RPC tranca com `FOR UPDATE`. O mesmo `ensure()` roda
em todo `GET /kanban/boards`, e cada aba aberta no Kanban faz esse `GET` a cada
evento de movimentação.

**Deixado fora de escopo de propósito.** Corrigir exige decidir o que acontece
quando o board ainda não existe no momento da mensagem, o que muda o
comportamento de bootstrap e merece PR própria, com prova de reversão própria.

## O que foi corrigido

- O `automated()` dos **dois** provedores passou a re-ler o estado e decidir de
  novo quando perde a corrida, com tentativas limitadas e espera exponencial com
  jitter (`kanban-conflict.ts`). Repetir a mesma tentativa perderia de novo — ela
  carrega o `expectedUpdatedAt` que já perdeu, então o conflito seria garantido,
  não provável. Re-ler converge: quem venceu já avançou a etapa, então o segundo
  leitor encontra `stage_rule` ou `manual_override` e sai de lado.
- A entrega é reivindicada **uma vez** por mensagem, não por tentativa.
- O `automated()` do SQLite passou a enviar `expectedUpdatedAt` também, para os
  dois provedores responderem igual a uma movimentação manual concorrente.
- O chamador outbound (`internal-inbox.service.ts:82`) passou a informar
  `historical`, campo que a chamada de SLA da linha seguinte sempre informou.
- O teste que dizia cobrir "skips history" era **vácuo**: reconstruía o store sem
  o coordinator, então a asserção passava mesmo sem a porta de origem. Agora usa
  a fiação real, exposta em `app.locals.wahaWebhookStore`.

## O que falta para fechar a questão

Não foi possível medir nada em produção (acesso ao banco proibido nesta
investigação). O teste decisivo, que **falsearia ou confirmaria** o número
relatado, é comparar na mesma janela de 60 minutos:

```sql
-- somente leitura
SELECT count(*) FROM conversation_kanban_events WHERE created_at > now() - interval '60 minutes';
SELECT count(*) FROM kanban_automation_deliveries WHERE created_at > now() - interval '60 minutes';
```

A RPC que levanta 40001 aborta a transação e **não** deixa linha em
`conversation_kanban_events`, mas o `pg_stat_statements` conta a chamada assim
mesmo — e acumula desde o último `reset`, sem janela. Se as duas contagens acima
forem muito menores que 3,4 milhões, o número relatado é acumulado e/ou dominado
por chamadas abortadas, não uma taxa de 944 por segundo.

Se a taxa for real, ela vem **de fora deste repositório**, e as origens possíveis
são: cliente externo martelando `POST /api/v1/inbox/kanban/conversations/:id/move`;
várias instâncias da API; ou algo chamando a RPC direto no Supabase (trigger,
`pg_cron`, Edge Function) que não existe em `web/supabase/migrations`.

Não identificado: quantas instâncias da API rodam em produção; a política de
reentrega configurada na WAHA; o valor real de C (conversas visíveis por
workspace); e se existe no banco remoto alguma trigger ou função fora das
migrations versionadas que chame `chatpro_kanban_move`.

## Outras RPCs com concorrência otimista

Nenhuma. A varredura por `expected_updated_at`, `40001` e `serialization_failure`
em `web/supabase/migrations/` e `web/apps/api/migrations/` retorna apenas o
`chatpro_kanban_move`. As outras quatro funções PL/pgSQL resolvem concorrência
por caminhos que nunca produzem exceção:

| Função | Mecanismo | Ao perder a corrida |
| --- | --- | --- |
| `chatpro_distribute_conversation` | compare-and-set no `WHERE` | `reason='assignment_raced'`, resultado `skipped` |
| `claim_inbox_outbox_job` | compare-and-set em `status='pending'` | 0 linhas |
| `chatpro_claim_routing_jobs` | `FOR UPDATE SKIP LOCKED` | pessimista, não disputa |
| `chatpro_resolve_contact_identity` | `pg_advisory_xact_lock` | pessimista, não disputa |

Fora de RPC não há conflito otimista por timestamp: não existe nenhum
`.eq('updated_at', ...)` em `src/` nem `WHERE updatedAt=?` no SQLite. O único
equivalente é a checagem em JS do `KanbanService.move`, alcançável só pelo
endpoint HTTP, onde o 409 é a resposta correta a uma pessoa.

Ressalva: as ~15 RPCs de domínio chamadas em `supabase-domain.repository.ts`
(`chatpro_create_contact`, `chatpro_move_lead`, `chatpro_save_campaign` e outras)
**não estão definidas nas migrations versionadas** — o corpo delas só existe na
base remota. Confirmei que nenhum chamador passa parâmetro de concorrência
otimista, mas não é possível confirmar por leitura que nenhuma delas levante
40001 internamente. Não identificado.
