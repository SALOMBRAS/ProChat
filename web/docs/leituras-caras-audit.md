# Leituras caras: candidatos registrados, não corrigidos

Registro de 31/07/2026. Dois caminhos de leitura da API que custam mais
requisições ao PostgREST do que precisariam. **Nenhum é urgente** — a medição de
carga que os encontrou fechou em ~30 chamadas por minuto com um dashboard
aberto, e nada aqui é gargalo hoje. Ficam registrados com o chamador nomeado
para que a correção, quando vier, não precise redescobri-los.

Números medidos em processo, uma requisição por vez, com a instrumentação de
`apps/api/src/persistence/supabase-call-stats.ts` (`SUPABASE_CALL_STATS=1`).

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

## Por que não corrigir agora

A carga medida não justifica. Um dashboard aberto gera ~30 chamadas por minuto,
e o relógio de SLA, 1 a 2. Os dois candidatos só passam a importar se o número
de etapas do quadro crescer, se a base de conversas crescer muito, ou se o
painel passar a ser recarregado com frequência — e nesse caso o candidato 1 é o
primeiro a doer, porque cresce em duas dimensões ao mesmo tempo.
