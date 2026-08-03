# Leituras caras: candidatos registrados, não corrigidos

Registro de 31/07/2026, ampliado em 03/08/2026. Caminhos de leitura da API que
custam mais do que precisariam. **Nenhum é urgente** — a medição de carga que
encontrou os dois primeiros fechou em ~30 chamadas por minuto com um dashboard
aberto, e nada aqui é gargalo hoje. Ficam registrados com o chamador nomeado
para que a correção, quando vier, não precise redescobri-los.

Os candidatos 1 e 2 custam **requisições**; o 3 custa **volume por leitura**, e
por isso tem critério próprio de disparo.

Números dos candidatos 1 e 2 medidos em processo, uma requisição por vez, com a
instrumentação de `apps/api/src/persistence/supabase-call-stats.ts`
(`SUPABASE_CALL_STATS=1`). Os do candidato 3, direto no PostgREST.

## Candidato 1 — `GET /inbox/kanban/boards`: 12 chamadas

| chamadas | operação | chamador |
|---|---|---|
| 6 | `HEAD conversation_kanban_state` | `supabase-kanban.service.ts` → `board()` |
| 2 | `GET kanban_stages` | `ensure()` |
| 1 | `GET kanban_boards` | `ensure()` |
| 1 | `GET conversations` | `ensure()` |
| 1 | `POST conversation_kanban_state` | `ensure()` |
| 1 | `GET kanban_boards` | `board()` |

**O N+1.** As seis `HEAD` são uma contagem por etapa, emitidas em paralelo por
`board()`: para cada etapa do quadro, um `select(count, head: true)` filtrado por
`stage_id`. Seis etapas, seis requisições; o número acompanha a quantidade de
etapas, não o tamanho da resposta. Uma contagem agrupada por `stage_id` numa
única chamada resolve — no Supabase, uma view ou uma RPC que devolva
`stage_id, count`.

**A leitura sem limite.** `ensure()` lê **todas** as conversas visíveis do
workspace, sem paginação, para descobrir quais ainda não têm linha de estado.
São 657 hoje. Esse ponto está tratado em detalhe, com proposta, em
`rotas-get-que-escrevem-investigacao.md`, porque é também de onde sai o `POST`
numa rota `GET`.

## Candidato 2 — `GET /domain/dashboard`: 10 chamadas

| chamadas | operação | chamador |
|---|---|---|
| 2 | `GET leads` | `supabase-domain.repository.ts:45` → `rows()` |
| 1 cada | `GET contacts`, `tags`, `templates`, `campaigns`, `stages` | `rows()` |
| 1 | `GET contacts` | `contacts()` |
| 1 | `HEAD conversations` | `count()` |
| 1 | `HEAD whatsapp_messages` | `count()` |

São dez consultas independentes entre si, uma por coleção, emitidas em
sequência. Nenhuma depende do resultado da anterior, então o caminho mais barato
sem mudar semântica é emiti-las em paralelo; o mais barato de todos seria uma
única RPC que devolvesse os agregados do painel prontos.

O custo real hoje é de latência somada, não de volume: dez viagens de ida e
volta contra a base para montar uma tela.

## Candidato 3 — o relógio de SLA relê a população inteira a cada 60 s

Medido em **03/08/2026**, direto no PostgREST de produção, somente leitura.

`tick()` (`sla.service.ts:134`) roda a cada 60 s e começa por `listDue()`, que é
`GET conversation_sla_metrics?select=*&frozen_at=is.null` — sem filtro de estado
e sem paginação.

| medida | hoje |
| --- | --- |
| linhas devolvidas | 72 |
| resposta | 40,7 KB |
| latência | 0,15 s (três medições: 0,150 / 0,158 / 0,164) |
| por dia, 1440 ciclos | ~56 MB |

### Quantas dessas linhas o tick pode usar

Uma. A única escrita do laço está atrás de `projected.slaIndicator === 'red' &&
row.slaStatus === 'waiting_operator'` (`sla.service.ts:143`), e depois de virar
`expired` a linha nunca mais satisfaz a condição.

| estado | linhas | pode gerar escrita? |
| --- | --- | --- |
| `expired` | 62 | não — a transição já aconteceu |
| `waiting_customer` | 9 | não — só espera do operador expira |
| `waiting_operator` | **1** | sim, uma vez |

Então **o tick escreve de 0 a 1 linha por ciclo hoje, e lê 72 para descobrir
isso.** As outras 71 são transferidas e projetadas em memória sem produzir nada.

Vale registrar o resto do cenário medido, porque muda a leitura dos números:
existe **um** workspace (`default-workspace`), e `workspace_sla_config` está
**vazia** — todo mundo roda no `defaults` do código.

### Por que cresce e não encolhe

Nenhuma das 72 linhas está congelada. `frozen_at` é o único jeito de sair da
leitura, e o conjunto de não congeladas só cresce: uma conversa que expirou
continua sendo lida a cada minuto para sempre. A linha mais antiga é de
24/07/2026.

A 563 bytes por linha:

| linhas não congeladas | por ciclo | por dia |
| --- | --- | --- |
| 72 (hoje) | 40,7 KB | 56 MB |
| 500 | 275 KB | 386 MB |
| 2 000 | 1,1 MB | 1,5 GB |
| 10 000 | 5,4 MB | 7,5 GB |

### O que a correção seria

Uma leitura própria para o tick, filtrando `sla_status = 'waiting_operator'` no
banco — hoje 1 linha em vez de 72.

**Não é mexer no `listDue()`.** `summary()` (`sla.service.ts:110`) chama o mesmo
método e precisa de todas as linhas não congeladas para os totais do painel:
`active`, `waitingCustomer`, `withinSla`, as médias e a amostra crítica. Estreitar
a consulta compartilhada quebraria o dashboard em silêncio. É método novo no
`SlaStore`, com implementação nos dois provedores para manter a paridade da regra
crítica nº 1.

### O critério que dispara o trabalho

Qualquer um dos dois, o que vier primeiro:

1. **A linha de log já existente.** `tick()` registra `SLA tick skipped: previous
   run still in progress` em nível de erro (`sla.service.ts:138`) quando um ciclo
   ainda está rodando na hora do seguinte. Hoje isso nunca dispara, com 0,15 s de
   leitura contra 60 s de intervalo. Se aparecer, o tick passou a demorar mais que
   a própria cadência e este candidato é a primeira coisa a olhar.
2. **1 000 linhas não congeladas** em `conversation_sla_metrics` — ~550 KB por
   ciclo e ~800 MB por dia, ponto em que a transferência deixa de ser ruído.

Para conferir o número atual, sem escrever nada:

```bash
curl -s -o /dev/null -D - -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0" \
  "$SUPABASE_URL/rest/v1/conversation_sla_metrics?select=conversation_id&frozen_at=is.null" \
  | grep -i content-range
```

### Não é candidato: o `prepare()` do `SqliteSlaStore`

Fica registrado para não ser levantado de novo. Cada método de `SqliteSlaStore`
chama `this.db.prepare(...)` na própria invocação, e `save()` ainda remonta o SQL
a partir das chaves da linha. Parece custo por conversa vencida a cada 60 s, e
não é, por dois motivos independentes:

- **produção não passa por essa classe.** `DATABASE_PROVIDER=supabase`, e
  `app.ts:92` escolhe `SupabaseSlaStore` quando não há banco local. O `prepare()`
  só existe no caminho SQLite, isto é, `dev:local` e os testes;
- **mesmo no SQLite, `save()` só é chamado na transição**, não uma vez por linha
  percorrida — a mesma condição da tabela acima. São 0 a 1 chamadas por ciclo,
  não 72.

O custo de `prepare()` por linha é real onde há laço de escrita de verdade, e
esse caso está tratado em `testing.md` §8, que é sobre montagem de cenário em
teste.

## Por que não corrigir agora

A carga medida não justifica. Um dashboard aberto gera ~30 chamadas por minuto,
e o relógio de SLA, 1 a 2. Os candidatos 1 e 2 só passam a importar se o número
de etapas do quadro crescer, se a base de conversas crescer muito, ou se o
painel passar a ser recarregado com frequência — e nesse caso o candidato 1 é o
primeiro a doer, porque cresce em duas dimensões ao mesmo tempo.

O candidato 3 não é sobre número de chamadas: continua sendo uma por ciclo, para
sempre. O que cresce é o tamanho da resposta, e ele cresce sozinho, sem ninguém
abrir tela nenhuma. Por isso o critério dele é medido em linhas e no log de
sobreposição, não em requisições por minuto.
