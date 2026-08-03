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

> **Correção de 03/08/2026.** A primeira versão deste parágrafo dizia que o
> desempate na leitura "sozinho já resolveria os dois problemas medidos". **Está
> errado**, e a decisão foi tomada com base nisso. O desempate — implementado na
> PR #113 como `position DESC, last_message_at DESC, conversation_id ASC` —
> conserta o empate e a paginação, e **não mexe no topo velho**: `position`
> continua mandando, então o cartão de 639 dias em `position = 626` ainda ganha
> do de hoje em `position = 1`, e a primeira página de "Novo" segue com 2 dos 30
> mais recentes.

Para o topo, restam dois caminhos, e os dois são decisão de produto:

| caminho | conserta o topo | custo |
| --- | --- | --- |
| rodar o UPDATE abaixo | sim, para os cartões de hoje | escrita em massa; e volta a degradar enquanto `ensureState` gravar `1` |
| ordenar por `last_message_at` **acima** de `position` | sim, e continua valendo | arrastar cartão vira enfeite: o card sobe de volta na próxima mensagem |

O segundo custa zero hoje — `manual_override` é `false` nas 630 linhas e não há
nenhum evento `manual` —, mas desliga em silêncio um recurso que existe.

---

## Decisão de 03/08/2026

| item | decisão |
| --- | --- |
| desempate na leitura | **feito** — PR #113, `position DESC, last_message_at DESC, conversation_id ASC` nos dois provedores |
| cartão novo no topo do estágio | **feito** — PR #116, `max(position) + 1` por estágio nos dois provedores |
| renormalizar os 627 já posicionados | **não** — o SQL abaixo fica escrito e **não executado** |

**Por que o UPDATE não roda.** Depois do incidente dos 504 cards, escrita em
massa em produção só com necessidade. O que ela conserta é o retrato de hoje, e
o retrato incomoda menos agora que cartão novo nasce no lugar certo: o topo de
"Novo" para de piorar sozinho, e a coluna se corrige aos poucos conforme as
conversas antigas recebem mensagem e são movidas.

**Reavaliar em 17/08/2026.** Se o topo continuar inútil — a medida é a mesma
desta análise: quantos dos 30 da primeira página estão entre as 30 conversas
mais recentes —, o UPDATE é aplicado.

### O que os dois merges já mudaram

- Nenhum cartão aparece em duas páginas nem some entre elas, que era defeito de
  correção e não de gosto.
- Conversa nova entra no alto da sua coluna, e não no rodapé de 627.
- Empates continuam existindo — `max + 1` pode ser lido em paralelo por duas
  mensagens — e são inofensivos, porque a leitura desempata.

### Não existe arrasto para reordenar dentro da coluna

Conferido no dashboard em 03/08/2026, e isto muda a decisão futura:

- a única superfície de arrasto do Kanban é `InboxKanban.tsx`; o `onDrop` de
  `Inbox.tsx` é a zona de anexo;
- o alvo do arrasto é a **coluna**, não um espaço entre cartões — não há
  indicador de inserção;
- `move()` recusa quando o estágio de destino é o de origem, então **arrastar um
  cartão dentro da própria coluna não faz nada**;
- ao trocar de coluna, a UI manda sempre `afterConversationId: destination[0]`,
  isto é, "põe no topo da coluna de destino". Nunca uma posição escolhida.

Ou seja, `position` registra **uma** coisa visível ao operador: um cartão movido
para outra coluna vai para o topo dela. Ordenar direto por `last_message_at`
custaria só isso — e dispensaria uma coluna que nada mais lê. É uma mudança bem
menor do que parecia enquanto se supunha que o arrasto reordenava.

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
