# Ordem dos cartões no Kanban — medição e proposta

**03/08/2026. Leitura, não correção.** Nada foi escrito no banco. O SQL do fim
está proposto e **aguarda aprovação**.

A pergunta era se vale renormalizar as posições depois do backfill. Vale — mas o
motivo medido é maior do que a inversão que se suspeitava, e uma renormalização
sozinha não resolve o caso por muito tempo.

---

## O que a coluna "Novo" mostra hoje

627 dos 630 cartões do quadro estão em **Novo**. A leitura ordena por
`position DESC` (`supabase-kanban.service.ts:26`), e a primeira página são 30
cartões.

| medida | hoje | se ordenasse por `last_message_at` |
| --- | --- | --- |
| dos 30 da 1ª página que estão entre as 30 conversas mais recentes | **2** | 30 |
| idade mediana da última mensagem no topo | **247 dias** | 1 dia |
| idade máxima no topo | **639 dias** | 7 dias |

Quem abre o quadro vê, no alto, conversas paradas há oito meses. As de hoje estão
no fim de 627 cartões — vinte e uma páginas abaixo.

## Duas causas, e só uma é o backfill

### 1. Cartão novo nasce em `position = 1`

`ensureState` grava `position: 1` para toda conversa nova
(`supabase-kanban.service.ts:74`). Com a ordenação `DESC`, **1 é o fim da fila**.

Isto não é efeito do backfill: é o comportamento permanente. Medido — os cartões
em `position = 1` têm última mensagem em 01/08, 02/08 e **03/08**, isto é, as
conversas mais recentes da base estão no rodapé da coluna.

O backfill não criou o defeito; ele o tornou visível, ao empilhar 496 cartões
entre 128 e 626 por cima dos que já estavam lá.

### 2. Empate sem critério de desempate

627 cartões ocupam **541 posições distintas**: 83 valores estão repetidos e
cobrem **169 cartões**. `position = 1` sozinho é de 5 cartões.

A consulta ordena só por `position`, sem segundo critério, e pagina por `range`.
Postgres não promete ordem estável entre linhas empatadas, então **o mesmo cartão
pode aparecer em duas páginas ou não aparecer em nenhuma** conforme o operador
rola o quadro. Isso é defeito de correção, independente de qual ordem se
escolha — e não some renormalizando, porque `ensureState` volta a produzir
empates em `1` na mensagem seguinte.

## Nenhuma posição carrega intenção do operador

`conversation_kanban_events` tem **18 eventos, de 3 conversas**, todos com
`source` `inbound` ou `outbound` — automação, não arrasto. **Zero eventos
`manual`**, e nenhuma das 3 conversas está entre os 627 cartões de Novo.

Ou seja: a posição de hoje é ordem de varredura do backfill e nada mais. Não há
trabalho humano a preservar, o que torna a reescrita segura.

## O critério proposto

**`last_message_at`, mais recente no topo.** É o que o operador já espera, e é o
mesmo critério pelo qual a lista da Inbox ordena — hoje o quadro e a lista
discordam sobre o que é "recente".

Como a leitura é `DESC`, a conversa mais recente precisa da **maior** `position`.
O desempate entra na própria numeração (`created_at`, depois `conversation_id`),
o que também elimina os 83 valores repetidos.

## O que a renormalização não resolve

Ela conserta o retrato de hoje. **Amanhã volta a degradar**, porque
`ensureState` continua entregando `position = 1` a cada conversa nova — que cai
de novo no rodapé, empatada com as outras que chegaram depois.

A correção durável é uma das duas, e as duas são em `apps/api/src`, fora do
escopo desta análise:

- **desempate na leitura** — `.order('position',{ascending:false})` seguido de
  `.order('last_message_at',{ascending:false})` na conversa juntada; ou
- **posição de entrada** — cartão novo nascer no topo em vez de em `1`.

A primeira é a mais barata e sozinha já resolveria os dois problemas medidos,
inclusive sem renormalizar coisa alguma. **Vale decidir isso antes de rodar o
UPDATE**: se a leitura ganhar desempate por `last_message_at`, o UPDATE abaixo
vira desnecessário.

---

## O SQL — proposto, não executado

Renormaliza todos os estágios do quadro, cada um na sua faixa, com posições
distintas e determinísticas. Confira o `workspace_id` e o `board_id` antes.

```sql
-- Ordem por atividade recente. `row_number` ASC dá 1 ao mais antigo e N ao mais
-- recente; como a leitura é DESC, o mais recente fica no topo.
-- O desempate por created_at e id garante posições únicas, o que fecha o buraco
-- de paginação dos 169 cartões empatados.
WITH ordenado AS (
  SELECT s.conversation_id,
         s.stage_id,
         row_number() OVER (
           PARTITION BY s.stage_id
           ORDER BY c.last_message_at ASC NULLS FIRST, c.created_at ASC, s.conversation_id ASC
         ) AS nova_posicao
    FROM public.conversation_kanban_state s
    JOIN public.conversations c
      ON c.id = s.conversation_id
     AND c.workspace_id = s.workspace_id
   WHERE s.workspace_id = 'default-workspace'
     AND s.board_id = '<board_id>'
)
UPDATE public.conversation_kanban_state s
   SET position = o.nova_posicao,
       updated_at = now()
  FROM ordenado o
 WHERE s.conversation_id = o.conversation_id
   AND s.stage_id        = o.stage_id
   AND s.workspace_id    = 'default-workspace'
   AND s.board_id        = '<board_id>'
   AND s.position IS DISTINCT FROM o.nova_posicao;
```

Antes, para conferir o que mudaria sem mudar nada — mesma consulta, só lendo:

```sql
WITH ordenado AS (
  SELECT s.conversation_id, s.stage_id, s.position AS antiga,
         row_number() OVER (
           PARTITION BY s.stage_id
           ORDER BY c.last_message_at ASC NULLS FIRST, c.created_at ASC, s.conversation_id ASC
         ) AS nova
    FROM public.conversation_kanban_state s
    JOIN public.conversations c ON c.id = s.conversation_id AND c.workspace_id = s.workspace_id
   WHERE s.workspace_id = 'default-workspace' AND s.board_id = '<board_id>'
)
SELECT stage_id, count(*) AS cartoes, count(*) FILTER (WHERE antiga IS DISTINCT FROM nova) AS mudam,
       count(DISTINCT antiga) AS posicoes_antes, count(DISTINCT nova) AS posicoes_depois
  FROM ordenado GROUP BY stage_id;
```

`posicoes_depois` tem de ser igual a `cartoes` em todos os estágios. Se não for,
o desempate não cobriu algum caso e o UPDATE **não deve** rodar.

Para desfazer não há caminho: a posição antiga não é guardada em lugar nenhum.
Quem quiser rede de segurança copia a tabela antes:

```sql
CREATE TABLE conversation_kanban_state_backup_20260803 AS
  SELECT * FROM public.conversation_kanban_state WHERE workspace_id = 'default-workspace';
```

## Método

Tudo lido por PostgREST com a credencial de `web/.env.local`. 630 linhas de
`conversation_kanban_state`, 627 delas em Novo; `last_message_at` de cada
conversa lido em lotes de 80 ids; `conversation_kanban_events` lido inteiro.
Nenhuma escrita.
