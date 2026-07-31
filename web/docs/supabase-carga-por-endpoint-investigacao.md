# Carga contra o PostgREST por endpoint

Investigação de 31/07/2026 sobre a origem de um relato de ~10 requisições por
segundo contra o Supabase. Os três suspeitos anteriores já haviam sido
descartados; este documento mede o que sobrou e registra o custo real de cada
caminho.

## 1. O que já estava descartado

- **Kanban:** `conversation_kanban_events` tem 15 linhas e
  `kanban_automation_deliveries` 16. Os números que apontavam para ele eram
  acumulado de `pg_stat_statements`, não taxa.
- **`workspace_sla_config`:** a tabela está vazia. Vale notar que tabela vazia
  não reduz leitura — a consulta continua sendo uma requisição HTTP —, mas o
  N+1 que a lia uma vez por linha foi corrigido na #80.
- **Dashboard:** era a hipótese restante, e é o objeto desta medição.

## 2. Como se mediu

`supabase-js` aceita um `fetch` próprio, e a API tem **um único** `createClient`
(`apps/api/src/persistence/supabase.ts`), então todo tráfego para o PostgREST
passa por um ponto só. `apps/api/src/persistence/supabase-call-stats.ts` embrulha
esse `fetch` e conta método, tabela e **quem chamou**, tirando o chamador da
pilha no momento da chamada. Sem dependência nova.

Está desligado por padrão: `SUPABASE_CALL_STATS=1` liga, e sem a variável o
cliente recebe o `fetch` global intocado — capturar pilha em todo `fetch` não é
coisa de caminho quente. Com a variável ligada, a API despeja o tally a cada
60 s e zera a janela.

O lado do navegador foi medido com Chrome headless local por CDP, sem
dependência: `Network.requestWillBeSent` por 60 s, sem interação.

## 3. Dashboard ocioso, 60 s sem interação

39 requisições no total, das quais 25 são estáticos e HMR do Vite. Chamadas de
API de verdade: **4 no minuto**, mais a conexão WebSocket.

| chamada | vezes em 60 s |
|---|---|
| `GET /api/v1/domain/dashboard` | 2 |
| `GET /api/v1/inbox/operations/sla-summary` | 2 |
| `WS /ws` | 1 conexão |

As duas de cada são carga inicial mais um `Page.reload` disparado pela captura;
em regime, o que se repete sozinho é o painel de SLA a cada 60 s
(`SlaOperationalDashboard`, `refreshIntervalMs = 60_000`).

O polling de 2 s que existe em `Inbox.tsx` **não roda em regime**: é condicional
a `isActiveSync(syncJob?.status)`, ou seja, só durante uma sincronização de
histórico em andamento.

## 4. Custo de cada rota em chamadas ao PostgREST

Medido em processo, uma requisição por vez, com `nodeEnv: 'test'` para que o
relógio de SLA, a limpeza de anexos e o backfill de identidade não
contaminassem a contagem.

| rota | chamadas | onde nascem |
|---|---|---|
| `GET /inbox/kanban/boards` | **12** | `supabase-kanban.service.ts` |
| `GET /domain/dashboard` | **10** | `supabase-domain.repository.ts` |
| `GET /inbox/operations/sla-summary` | 5 | `sla.service.ts` |
| `GET /inbox/conversations` | 4 | `waha-webhook.service.ts` |
| `GET /inbox/integrity/summary` | 1 | `quarantineCount` |
| `GET /workspace/sla-config` | **0** | servida pelo cache da #80 |

O zero da última linha é a #80 funcionando: a configuração já estava em memória
por causa da chamada anterior, e a rota não foi ao banco.

## 5. O relógio de SLA

Com escrita bloqueada, um tick custa **2 chamadas** e 276 ms: um `listDue` e uma
leitura de configuração. O tick seguinte custa **1** — a configuração vem do
cache. Nenhuma escrita foi sequer tentada.

Antes da #80 esse mesmo tick fazia 1 + 61 leituras, uma por linha de
`conversation_sla_metrics`.

## 6. Conclusão

**Nada no caminho medido chega perto de 10 requisições por segundo.** Somando o
pior caso de um dashboard aberto — painel de SLA a cada 60 s, mais uma abertura
de Kanban e uma de Inbox no minuto — dá cerca de 30 chamadas por minuto, ou 0,5
por segundo. O relógio de SLA contribui com 1 a 2 por minuto.

**A origem do relato de ~10/s está não identificada.** As hipóteses que sobram
não foram medidas e não devem ser tratadas como conclusão: pode ter sido o N+1
que a #80 removeu, medido antes dela; pode ter sido a mesma confusão entre
acumulado e taxa que já havia apontado o Kanban; e pode ter sido tráfego de
análise, já que as investigações destes dias leram a base em páginas por várias
horas. Nada disso foi verificado.

O que fecharia a questão é instrumentar o processo que de fato serve produção —
a API na porta 3000 — e observar um minuto de operação real. Esta medição rodou
numa instância própria, e não naquele processo.

## 7. Dois achados de eficiência

Não são a causa do relato, mas são as rotas mais caras e ambas crescem com o
tamanho da base.

**`GET /inbox/kanban/boards`, 12 chamadas.** Seis delas são `HEAD` de contagem em
`conversation_kanban_state`, uma por etapa, emitidas em paralelo por `board()`.
É um N+1 sobre etapas: seis etapas hoje, seis requisições. Uma contagem agrupada
por `stage_id` resolveria em uma. Além disso, `ensure()` lê **todas** as
conversas visíveis do workspace a cada abertura do quadro, sem paginação, para
descobrir quais ainda não têm estado de Kanban — e é daí que sai o `POST` de
backfill que a rota executa mesmo sendo `GET`.

**`GET /domain/dashboard`, 10 chamadas.** Uma consulta por coleção — `leads`
(2), `contacts` (2), `tags`, `templates`, `campaigns`, `stages` — mais dois
`HEAD` de contagem, todas por `SupabaseDomainRepository.rows`. São independentes
entre si e hoje saem em sequência.

## 8. O que esta medição não cobriu

- O processo que serve produção não foi instrumentado; ver seção 6.
- O fan-out da ingestão de webhook não foi medido, porque medir exigiria gravar
  em produção. Pelas chamadas no código o caminho é da ordem de uma dezena de
  requisições por mensagem recebida, mas **isso é leitura de código, não
  medição**.
- Uma gravação aconteceu durante a medição: a rota `GET /inbox/kanban/boards`
  executou o backfill idempotente de `conversation_kanban_state` descrito na
  seção 7. É a mesma gravação que a API de produção faz a cada abertura do
  quadro, mas foi gravação, e está registrada aqui por isso.
