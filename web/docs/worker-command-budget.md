# Orçamento de tempo de um comando do worker

Todo comando que a API envia ao worker interno carrega um orçamento
(`timeoutMs`). O worker gasta **esse** orçamento entre todas as chamadas que o
comando precisar fazer à WAHA, em vez de dar um timeout novo a cada chamada.

## A cadeia

| camada | valor hoje | onde é definido |
| --- | --- | --- |
| Orçamento anunciado pela API | `WORKER_TRANSPORT_TIMEOUT_MS` (padrão 30 000 ms, máximo 30 000) | `apps/api/src/config.ts` |
| Abort do cliente de transporte | o mesmo orçamento, via `AbortController` | `apps/api/src/internal-worker-client.ts` |
| Contrato do transporte | `timeoutMs` inteiro, de 1 a 30 000 | `packages/contracts/src/index.ts` |
| Orçamento efetivo no worker | orçamento anunciado − reserva | `apps/worker/src/request-deadline.ts` |
| Teto por chamada WAHA | `WAHA_TIMEOUT_MS` (padrão 10 000; 28 000 no ambiente atual) | `apps/worker/src/config.ts` |
| Timeout real de cada chamada | `min(WAHA_TIMEOUT_MS, orçamento restante)` | `apps/worker/src/waha-client.ts` |

A reserva é `min(500 ms, orçamento/10)` e existe para que a resposta chegue à API
enquanto ela ainda está ouvindo. Sem ela, o worker terminaria exatamente no
instante do abort e o erro real se perderia.

## Quantas chamadas WAHA cabem num comando

Quase todo comando começa validando a sessão (`refresh()` → `GET /api/sessions/:name`)
antes da operação em si:

| comando | chamadas WAHA sequenciais |
| --- | --- |
| `history.page` | 2 (sessão + `chats` ou `chats/:id/messages`) |
| `message.send` | 2 (sessão + `sendText`) |
| `message.sendAttachment` | 2 (sessão + `sendFile`/`sendImage`/…) |
| `identity.sync` | até 4 (sessão + reconciliação + contato + grupo) |
| `session.connect` | 2 (`start` + sessão) |
| `session.qr` | 2 (sessão + QR, este último limitado a 1,5 s) |

Antes da propagação do deadline, cada uma dessas chamadas recebia um
`WAHA_TIMEOUT_MS` inteiro. Com 28 000, o pior caso de `identity.sync` era 112 s
contra um abort de 30 s: a API desistia primeiro, reportava o próprio abort
(`TIMEOUT` / «Internal worker command timed out») e a requisição continuava
correndo no worker sem cancelamento. O orçamento só não invertia por
coincidência — a checagem de sessão responde em milissegundos.

Compartilhar o orçamento torna a propriedade estrutural: **acrescentar uma
chamada a um comando nunca mais pode estourar o orçamento**, porque as chamadas
dividem o mesmo prazo em vez de cada uma receber um prazo próprio.

## Qual erro chega ao job

Três causas distintas produzem o código `TIMEOUT`, e agora a mensagem diz qual:

| mensagem | significado |
| --- | --- |
| `TIMEOUT: WAHA request timed out` | a WAHA não respondeu dentro do tempo que recebeu |
| `TIMEOUT: command budget ran out before WAHA answered` | o comando não coube no orçamento; a WAHA ainda estava trabalhando |
| `TIMEOUT: Internal worker command timed out` | a API abortou por conta própria — não deve mais acontecer em operação normal |

O código continua sendo `TIMEOUT` nos três casos, então as decisões de retry e de
encerramento de conversa não mudam; o que muda é o que fica registrado em
`lastErrorSafe`. Ver a terceira linha em produção indica que a reserva do worker
não foi suficiente, não que a WAHA está lenta.

## `WAHA_TIMEOUT_MS`: qual valor usar

**Mantenha 28000.** O valor não precisa mudar, mas o papel dele mudou.

Antes, `WAHA_TIMEOUT_MS` era o que precisava ser mantido manualmente abaixo do
teto do transporte, e o único valor *provadamente* seguro era ~14 000 (duas
chamadas de 14 s cabem em 30 s) — ou ~9 500, considerando `identity.sync` com três
chamadas. 28000 estava acima disso: funcionava porque a checagem de sessão é
barata, não porque o orçamento fechava.

Agora `WAHA_TIMEOUT_MS` é apenas um teto por chamada, e o orçamento do comando é
sempre respeitado independentemente dele.

**A profundidade alcançável não muda.** Cada chamada usa
`min(WAHA_TIMEOUT_MS, restante)`, e com o padrão de 30 000 o restante na hora de
ler mensagens é ~29,5 s; portanto quem manda continua sendo o teto de 28 000. A
leitura mais funda continua sendo a que custa 28 s — offset ~1.500 na curva
medida em `whatsapp-history-sync.md`. O que a correção compra não é
profundidade, é a garantia de que 28000 é seguro: antes, o único valor
*provadamente* seguro era ~7 000 (quatro chamadas de 7 s cabem em 30 s), e
adotá-lo teria reduzido a profundidade a menos de um terço.

Para ler mais fundo é preciso subir os dois: `WAHA_TIMEOUT_MS` acima de 30 000
sozinho não adianta, porque o orçamento do comando passa a ser o menor dos dois,
e `WORKER_TRANSPORT_TIMEOUT_MS` é limitado a 30 000 pela config da API e pelo
contrato do transporte. Na prática o teto de uma página é ~29,5 s.

## Cuidado ao baixar `WORKER_TRANSPORT_TIMEOUT_MS`

A sincronização de histórico não nomeia mais um prazo próprio, então ela usa esse
orçamento. Baixá-lo para deixar comandos de sessão mais responsivos reduz na
mesma medida a profundidade de histórico alcançável: com 5 000, uma página lê até
o offset em que o custo chega a ~4,5 s, algo em torno de 400 mensagens. A config
aceita qualquer valor de 1 a 30 000 e não avisa. Se algum dia os dois usos
precisarem de prazos diferentes, o caminho é passar um `timeoutMs` explícito na
chamada — como `identity.sync` já faz com 10 000 — e não voltar a escrever um
literal dentro do serviço.

## Chamadas fora de um comando

Reconexões, webhooks e o consumidor de filas chamam a WAHA fora do escopo de um
comando do transporte. Nesses casos não há orçamento anunciado e vale
`WAHA_TIMEOUT_MS` puro, como antes.
