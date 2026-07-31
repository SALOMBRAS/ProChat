# Rotas GET que escrevem no banco

Investigação de 31/07/2026, motivada por uma medição de carga que gravou em
produção sem pretender: bastou chamar `GET /api/v1/inbox/kanban/boards`. Este
documento levanta todas as rotas `GET` da API que escrevem, explica por que a do
Kanban escreve, e propõe — **sem implementar** — o que teria de mudar para ela
parar.

## 1. As três rotas

Levantamento sobre `apps/api/src/routes/v1.ts` (48 rotas `GET`), seguindo cada
handler até o store. Vale para os dois provedores, SQLite e Supabase.

| rota | escrita | quando |
|---|---|---|
| `GET /inbox/kanban/boards` | cria quadro, etapas e uma linha de `conversation_kanban_state` por conversa visível sem estado | sempre |
| `GET /inbox/conversations/:id/context` | `upsert` em `conversation_metadata` | primeira abertura de cada conversa |
| `GET /workspace/users`, `/workspace/teams`, `/workspace/teams/:id/members` | insere o usuário de desenvolvimento | só quando `developmentUserId` está definido e é quem chama |

As duas últimas são pequenas e limitadas. A terceira só existe em ambiente de
desenvolvimento (`ensureDevelopmentActor` retorna sem fazer nada quando
`developmentUserId` não bate com o chamador). A segunda grava uma linha por
conversa, uma única vez, e é ela que dá a `conversation_metadata` a existência
que o PATCH seguinte assume.

A primeira é a que importa.

## 2. Por que o Kanban escreve numa leitura

`boards()` é `[await this.ensure(workspaceId)]` — a rota de leitura é, literalmente,
a rotina de criação. `ensure()`, em `supabase-kanban.service.ts` e no par SQLite,
faz três coisas em sequência:

1. procura o quadro padrão do workspace e **cria** se não existir;
2. compara as etapas existentes com as padrão e **insere** as que faltam;
3. lê **todas** as conversas visíveis do workspace, sem paginação, e **insere**
   uma linha de `conversation_kanban_state` para cada uma que ainda não tem.

O passo 3 é o backfill. É dele que veio o `POST` observado numa requisição
`GET`.

## 3. O alcance é maior que a rota

`ensure()` tem exatamente dois chamadores em cada provedor:

- `boards()` — a rota `GET`;
- `automated()` — **o caminho da ingestão**, executado a cada mensagem recebida
  que seja elegível.

Ou seja: o custo O(conversas) do passo 3 não é pago só quando alguém abre o
quadro. É pago **a cada mensagem de entrada**. Numa base com 657 conversas
visíveis, toda mensagem recebida lê as 657 antes de decidir para onde mover um
único card.

Isso não é a rota GET escrevendo; é a mesma função servindo a dois propósitos
que não deveriam ser o mesmo.

## 4. O que quebra se o GET parar de escrever

Depende de retirar só a chamada ou de mover a responsabilidade. Retirar só a
chamada quebra três coisas:

- **Workspace novo não teria quadro.** O quadro padrão nasce em `ensure()`; sem
  ele, a primeira abertura do Kanban não mostraria nada até chegar a primeira
  mensagem.
- **Etapas novas não apareceriam.** Se a lista de etapas padrão do código mudar,
  é `ensure()` que reconcilia os workspaces existentes.
- **Conversas inelegíveis ficariam fora do quadro para sempre.** `automated()`
  desiste **antes** de chamar `ensure()` quando a origem é `historical`,
  `imported`, `replay`, `technical`, `quarantined` ou não visível. Conversas
  nesses estados — e as que voltam da quarentena depois — nunca ganham linha de
  estado pela ingestão. Hoje quem as recolhe é o backfill do `GET`, e sem ele
  elas sumiriam do quadro. `automated()` já devolve `skipped: 'missing_state'`
  quando a linha não existe, então o sintoma seria silencioso.

## 5. Proposta

Não implementada. Três movimentos, em ordem de dependência:

1. **Criação do quadro e das etapas sai da leitura.** Passa para o bootstrap do
   workspace e para o `POST /inbox/kanban/boards`, que já existe. A
   reconciliação de etapas padrão vira parte do caminho de criação, não de toda
   leitura.
2. **A linha de estado nasce com a conversa.** O ponto natural é onde a conversa
   passa a ser visível — `upsertConversation` na ingestão e a restauração de
   quarentena —, e não a varredura de todas as conversas. Isso cobre justamente
   as origens que `automated()` descarta antes de chegar em `ensure()`, que são
   as que hoje dependem do backfill.
3. **O backfill vira caminho explícito de reparo**, uma rota `POST` própria,
   para recolher as conversas anteriores a esta mudança. Roda uma vez, sob
   comando, e não a cada leitura nem a cada mensagem.

Feito isso, `GET /inbox/kanban/boards` lê e só. E o efeito colateral maior —
`automated()` pagando O(conversas) por mensagem — desaparece junto, porque o
motivo de ele chamar `ensure()` era garantir a existência do quadro e da linha,
que passariam a ser garantidas na origem.

Sobre as outras duas rotas da seção 1: o `upsert` do contexto é pequeno e
idempotente, e a proposta natural é a mesma — criar a linha de
`conversation_metadata` junto com a conversa —, mas o ganho é menor e o risco de
mexer não se justifica sozinho. O usuário de desenvolvimento é só de
desenvolvimento e pode ficar como está.

## 6. O que não foi determinado

- **Não foi medido** quanto o passo 3 custa por mensagem recebida em produção;
  medir exigiria ingerir mensagem real e gravar. O que está medido é a rota
  `GET`: 12 chamadas ao PostgREST, das quais uma é a leitura de todas as
  conversas visíveis e uma é o `POST` do backfill.
- Se existe algum workspace hoje com conversas visíveis sem linha de estado —
  ou seja, se o backfill ainda tem trabalho a fazer — está **não identificado**.
  Responder isso é uma consulta de leitura e deveria preceder a etapa 3 da
  proposta.
