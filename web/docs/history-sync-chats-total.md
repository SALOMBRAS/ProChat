# O denominador do progresso da sincronização

Como a Inbox passou a mostrar "240 de 551 conversas (44%)", de onde vem o 551, e
o que foi medido versus o que é suposição.

---

## 1. A WAHA não conta chats

`GET /api/{sessão}/chats` devolve **array JSON puro** — sem envelope, sem campo de
total, sem cabeçalho `X-Total-Count`. Verificado por três caminhos independentes
na versão que rodamos (`devlikeapro/waha:latest-2026.7.1`, motor WEBJS, tier
Core):

- o OpenAPI da versão exata (136 rotas) não tem rota de contagem para chats;
- o fonte do WAHA Core não tem `chatsCount`, `getChatCount` nem `@Header(`;
- sonda na instância viva: `GET /api/{sessão}/chats/count` → **404**.

A WAHA **tem** o padrão de contagem — `/groups/count` e `/lids/count` devolvem
`{ count }` — e simplesmente não o aplicou a chats. Comprar o Plus não muda: as
rotas de chat estão no Core, sem guarda de versão.

`/chats/overview` também não serve: devolve **mais** por item, não menos, porque
embute `picture` e `lastMessage`.

## 2. O que foi escolhido: busca binária sobre o `offset`

Em vez de receber a lista para tirar o `length`, o servidor descobre o total
perguntando **se existe chat na posição N**, com uma página de um item. Rampa
exponencial até passar do fim, depois busca binária.

Medido nesta conta (552 chats reais):

| método | requisições | bytes | tempo |
| --- | ---: | ---: | ---: |
| **busca binária (`limit=1`)** | **20** | **299 KB** | **0,136 s** |
| varredura de 6 páginas (`limit=100`) | 6 | 2,69 MB | 0,470 s |
| dump inteiro | 1 | 2,69 MB | 0,42–0,45 s |

A busca binária transfere **20 objetos de chat, não 552**, porque o WEBJS fatia a
coleção **antes** de serializar (`_Paginator` roda antes do `getChatModel`). Um
dump paga a serialização de cada item, incluindo `groupMetadata.participants`
inteiro — 63 grupos são 29% dos bytes desta conta, e um grupo de 977 membros
sozinho é 5,6%.

**Foi escolhida por não degradar.** A varredura é mais rápida de escrever e é
linear no tamanho da conta; a busca binária é logarítmica. Numa conta pequena a
diferença é de décimos de segundo — a razão da escolha é a conta que ninguém
mediu.

### Ninguém mediu conta grande

**Tudo acima de 552 chats é extrapolação.** Não há medição de conta de 5 mil nem
de 10 mil, e este documento não inventa uma: a taxa observada aqui foi ~0,78 ms
por chat no dump, mas nada garante que a serialização siga linear, e a composição
(quantos grupos, de que tamanho) pesa mais que a contagem. É exatamente por esse
desconhecimento que a busca binária foi preferida.

## 3. Duas armadilhas que custaram tempo

**Ramifique em `hasMore`, nunca em `items.length`.** `hasMore` é medido **antes**
do filtro (`listChats`, em `waha-client.ts`), então a sonda pergunta se a posição
existe. `items.length` é depois do filtro, e `status@broadcast` ocupa uma posição
real: com a ordenação por recência ele pode cair no offset 0, e uma sonda que
olhasse `items.length` leria a lista inteira como vazia.

**`limit=0` devolve tudo.** No WEBJS, `pagination.limit ||= Infinity` — zero é
falsy. Não serve para sondar.

## 4. O numerador estava quebrado, e foi corrigido junto

O denominador sozinho não fecharia a conta. Antes desta mudança, três saídas do
laço avançavam o `chatCursor` **sem** incrementar `chatsProcessed`:

- página inteira sem chat aproveitável (avança o tamanho da página);
- chat com identificador que não é de conversa (avança 1);
- chat já visitado nesta corrida (avança 1).

Com o cursor andando e o contador parado, uma corrida real **não chegava
matematicamente a 100%**. `chatsProcessed` passou a contar **posições andadas na
listagem**, que é o que a barra precisa e o que o rótulo "conversas" já dava a
entender.

### Por que a porcentagem é presa em 100%

A listagem se reordena enquanto a corrida anda: um chat que recebe mensagem pula
para o topo e empurra para trás os que já foram visitados, e o cursor volta a
passar por eles. Posições consumidas podem **exceder** o total contado no início
— o teste `does not walk a conversation twice…` mostra 3 conversas andadas em 5
posições. O denominador é um retrato do começo, não uma verdade estável, então a
fração é presa nas duas pontas.

## 5. Falha aberta, sempre

`chatsTotal` é **nulo** quando a contagem não veio: provedor fora do ar, teto de
sanidade atingido, contagem desligada. Nulo não é zero — zero é "esta sessão não
tem conversa". Sem total, a corrida segue normalmente e a Inbox volta a mostrar a
contagem sem porcentagem. **A corrida vale mais que a barra de progresso.**

`maxCountedChats: 0` desliga a contagem por configuração. É a válvula para uma
conta grande onde a sonda passe a incomodar, e o que os testes que não são sobre
contagem usam para manter sob análise a sequência de chamadas ao provedor.

## 6. Job que já existia

Corrida nova (job inédito, ou um `completed` recomeçando) zera `chatsTotal` e
conta de novo — a conta pode ter crescido desde a anterior. Retomada de um job
`failed`/`cancelled` **preserva** o total que já tiver; se estiver nulo, a corrida
conta ao (re)entrar. Um job em andamento no momento em que a migration for
aplicada termina sem porcentagem e ganha uma na corrida seguinte.

A escolha é por previsibilidade: a contagem pertence à corrida e acontece uma vez
por ação do operador, nunca no laço quente.

## 7. `.rollback.sql` não é migration

O executor de migrations do SQLite varre `*.sql` e ordena. `021_x.rollback.sql`
vem logo depois de `021_x.sql` e **desfazia em silêncio** o que acabara de ser
aplicado — a suíte inteira caiu com `no such column: chatsTotal` até isso
aparecer. O executor passou a excluir `.rollback.sql`, com teste próprio.

## 8. O que ficou de fora

**Separar os dois sentidos de `pending`.** Hoje o mesmo status cobre duas coisas
diferentes: o **checkpoint de lote**, que retoma sozinho depois de
`continuationDelayMs`, e a **guarda de execução de emergência**, que estaciona o
job até alguém apertar o botão. O rótulo "Aguardando próximo ciclo…" é mentira no
segundo caso, e a faixa da Inbox oferece Cancelar quando deveria oferecer
Retomar.

Exige campo novo, então não foi feito aqui. O desenho, para quando for decidido:

- **`pendingReason: 'batch' | 'parked' | null`** em `SyncJob`, nas duas migrations
  e na projeção de status. `batch` no checkpoint de lote, `parked` na guarda de
  emergência, nulo fora de `pending`.
- Alternativa mais barata: **`parked boolean NOT NULL DEFAULT false`**. Menos
  expressiva, mas responde a única pergunta que a tela faz hoje — "isto anda
  sozinho ou está esperando por mim?".

A primeira é preferível: um terceiro motivo de pausa aparece cedo ou tarde, e um
booleano não comporta o terceiro.

---

## Referências no código

- `web/apps/api/src/services/whatsapp-history-sync.service.ts` — `countChats`, a
  correção do numerador, a projeção `view`
- `web/apps/api/migrations/021_whatsapp_sync_chats_total.sql` e o par Supabase em
  `web/supabase/migrations/20260731000100_whatsapp_sync_chats_total.sql`
- `web/apps/dashboard/src/ui/syncProgress.ts` — `progressDetail`,
  `progressPercent` e a razão do teto de 100%
- `web/apps/api/test/whatsapp-history-sync.service.test.ts` — o describe
  `counting the session chats for the progress denominator`
