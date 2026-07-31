# O custo O(conversas) do bootstrap do Kanban — correção

**31/07/2026.** Implementa a proposta de `rotas-get-que-escrevem-investigacao.md`
(PR #86), com **uma divergência declarada**. Nenhuma migration foi criada ou
aplicada, e o banco remoto não foi consultado nem escrito: a medição é local, em
SQLite, contando consultas e linhas escritas.

---

## 1. O defeito

`ensure()` fazia três coisas, e a terceira era ler **todas** as conversas
visíveis do workspace e escrever uma linha de estado para cada uma. Tinha dois
chamadores:

- `boards()` — a rota `GET /inbox/kanban/boards`;
- `automated()` — **o caminho da ingestão**, a cada mensagem de entrada elegível.

Ou seja: com 657 conversas visíveis, toda mensagem recebida lia as 657 antes de
decidir para onde mover um único card. E escrevia na
`conversation_kanban_state`, que é exatamente a tabela que a RPC
`chatpro_kanban_move` tranca com `FOR UPDATE`.

## 2. A medição

Contando consultas e linhas escritas em SQLite, com o mesmo instrumento nos dois
lados. `C` é o número de conversas visíveis.

### Abrir o quadro (`GET /inbox/kanban/boards`)

| C | antes: consultas | depois | antes: linhas escritas | depois |
| --- | --- | --- | --- | --- |
| 5 | 27 | **19** | 12 | **7** |
| 80 | 102 | **19** | 87 | **7** |
| 657 | **679** | **19** | **664** | **7** |

### Ingerir uma mensagem elegível (`automated()`)

| C | antes: consultas | depois | antes: linhas escritas | depois |
| --- | --- | --- | --- | --- |
| 5 | 20 | **17** | 12 | **8** |
| 80 | 95 | **17** | 87 | **8** |
| 657 | **672** | **17** | **664** | **8** |

O que muda não é a constante, é a **forma**: antes crescia linearmente com o
número de conversas; agora é constante. Em 657 conversas, a ingestão de uma
mensagem passou de **672 consultas para 17**, e de **664 linhas escritas para 8**.

As sete linhas que sobram na abertura do quadro são o quadro e as seis etapas
padrão, escritas só na primeira vez. As oito da ingestão são essas mais a linha
de estado da conversa que a mensagem toca.

> **A medição do Supabase é por leitura de código, não medida.** O acesso ao
> banco remoto era somente leitura nesta rodada, e medir a ingestão exigiria
> gravar. O que muda lá é da mesma natureza e maior em custo, porque cada
> consulta é uma viagem de rede: some 1 `GET conversations` sem limite, 1 `POST`
> de C linhas, e — no caminho da ingestão — as **6 requisições `HEAD`** de
> contagem por etapa que `automated()` pedia e nunca lia.

## 3. Onde concordo com a PR #86, e onde não

A proposta original tinha três movimentos. Implementei o segundo e o terceiro
como propostos, e **divirjo do primeiro**.

### Movimento 3 — o backfill vira reparo explícito: **concordo, feito**

`POST /api/v1/inbox/kanban/backfill`. Idempotente, responde
`{ boardId, examined, created }`. É o único lugar onde a varredura O(C) ainda
roda.

### Movimento 2 — a linha nasce com a conversa: **concordo no princípio, mudo o lugar**

A proposta punha a criação em `upsertConversation`, na ingestão. **Não pude
fazer isso**: `waha-webhook.service.ts` está sendo reescrito noutra branch
(PR #90, que acrescenta um `sideEffects` desligando justamente a automação de
Kanban), e mexer ali criaria conflito.

O que fiz: `automated()` cria a linha **da conversa que a mensagem toca**, e só
dela. É O(1) em vez de O(C), fica dentro do serviço de Kanban, e cobre o caso
comum — conversa nova, primeira mensagem ao vivo.

**A consequência, declarada:** as origens que `automated()` recusa antes de
chegar ao corpo — `historical`, `imported`, `replay`, `technical`,
`quarantined`, invisível — não ganham linha pela ingestão. Uma conversa que só
recebeu mensagem de histórico fica sem card até o reparo rodar. É exatamente a
terceira quebra que a #86 identificou, e é por isso que o reparo virou rota em
vez de sumir. Há teste fixando os dois lados desse trade-off.

### Movimento 1 — criação do quadro sai da leitura: **discordo, e não fiz**

A proposta manda a criação do quadro para o bootstrap do workspace e para o
`POST /inbox/kanban/boards`. **Isso conflita com o movimento 2**, e o conflito é
de ordem:

> A linha de estado tem `board_id` e `stage_id` com chave estrangeira. Para
> nascer com a conversa, ela precisa que o quadro **já exista**. Se a criação do
> quadro sair de todos os caminhos quentes, um workspace cuja primeira mensagem
> chega antes de alguém abrir o Kanban não tem quadro — e a linha não pode ser
> criada. A falha seria no `INSERT`, ou silenciosa, dependendo do provedor.

E o custo de manter a criação do quadro é irrelevante para o problema em causa:
são **três consultas limitadas** (um quadro, seis etapas), que não crescem com
nada. O ganho de 672 → 17 é **inteiramente** do movimento 3 e do movimento 2.

Então dividi `ensure()` em duas, em vez de mover a primeira metade para fora:

| | o que faz | custo | quem chama |
| --- | --- | --- | --- |
| `ensureBoard()` | quadro + etapas padrão | **O(1)** | `boards()`, `automated()`, o reparo |
| `backfillStates()` | linha de estado para toda conversa visível | O(C) | **só o reparo** |

`GET /inbox/kanban/boards` continua criando o quadro quando ele falta — continua
sendo uma rota `GET` que escreve, e isso não foi resolvido aqui. Mas passou a
escrever **um número limitado de linhas, uma única vez por workspace**, em vez de
uma por conversa a cada chamada. Tirar essa última escrita é uma PR própria, e
depende de decidir onde fica o bootstrap de workspace — que hoje não existe.

## 4. Paridade SQLite × Supabase

A divisão é a mesma nos dois provedores, com uma diferença que já existia e que
esta mudança **reduz**: o `automated()` do Supabase chamava `boards()`, que chama
`detail()`, que conta cards por etapa — **seis requisições `HEAD` por mensagem
recebida**, cujo resultado `automated()` nunca lia. O SQLite chamava `ensure()`
direto e não pagava isso.

Agora os dois chamam `ensureBoard()`, que devolve id e etapas cruas. As seis
contagens ficaram onde são usadas: em `detail()`, para desenhar o quadro.

## 5. Migration

**Não exige.** Nenhuma coluna, tipo, índice ou constraint. As mudanças são de
código, e o reparo usa a mesma escrita idempotente que o backfill antigo já
fazia.

## 6. O que não foi determinado

- **Quanto isso vale em produção**, em milissegundos. A medição é de consultas e
  linhas, em SQLite local. A latência remota citada em outras investigações
  (~155 ms por viagem) sugere que 672 → 17 consultas é a diferença entre
  inviável e imperceptível, mas isso é aritmética sobre um número medido noutro
  contexto, não medição desta mudança.
- **Se existe hoje workspace com conversa visível sem linha de estado** — ou
  seja, se o reparo tem trabalho a fazer na primeira execução. A #86 já
  registrava isso como não identificado, e continua. É uma consulta de leitura, e
  deveria preceder a primeira chamada da rota nova.
- **Se alguma conversa que só tem histórico existe hoje** e portanto perderia o
  card com esta mudança. Como o backfill antigo rodava a cada leitura do quadro,
  todas as conversas visíveis de hoje **já têm** linha; o risco é só para as que
  nascerem depois desta PR, e o reparo as recolhe.
