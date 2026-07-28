# As 4 mensagens técnicas que entraram depois da correção de ingestão

Investigação das 4 mensagens que levaram o total de técnicas de 237 para 241
depois de `8db9f49` ("stop WhatsApp system events from becoming conversation").
Somente leitura.

## Resposta curta

**Não é tipo faltante nem tráfego anterior ao deploy.** São 4 mensagens antigas
reimportadas pelo **history sync**, ingeridas por um processo da API que ainda
rodava o build anterior à correção. Os dois tipos envolvidos — `gp2` e `revoked` —
já estavam no vocabulário desde antes.

O filtro funciona: depois que o processo passou a rodar o build novo, nenhum
evento técnico virou mensagem.

## Como se chega nisso

As 4, na ordem em que chegaram:

| tipo | `received_at` | `occurred_at` | `_history` |
|---|---|---|---|
| `gp2` | 2026-07-28 13:41:14Z | 2026-07-25 17:43:46Z | `true` |
| `revoked` | 2026-07-28 13:46:55Z | 2026-07-27 14:22:02Z | `true` |
| `revoked` | 2026-07-28 13:46:55Z | 2026-07-27 14:22:01Z | `true` |
| `gp2` | 2026-07-28 13:50:04Z | 2026-07-25 17:43:47Z | `true` |

Três fatos que fecham o caso:

1. **`_history: true` nas quatro.** Não vieram do webhook ao vivo: vieram do
   `historyRecord`, o caminho do history sync. O `occurred_at` é de 25 e 27 de
   julho — mensagens velhas reimportadas.
2. **`gp2` e `revoked` já eram cobertos.** Se o código que as processou tivesse a
   correção, `messageFrom` teria resolvido o tipo por `wahaMessageType`,
   `resolveConversationIdentity` teria devolvido `undefined` e a mensagem nem
   teria sido inserida. A existência das linhas prova que o código que as
   processou não tinha a correção.
3. **`wahaMessageType` nasceu nessa correção.** Antes dela, `isTechnical` lia
   `payload.type` na raiz — que é vazia em todo tráfego WAHA. A coluna
   `message_type` das quatro é `'text'`, exatamente o que `mediaType()` devolve
   quando a raiz não tem tipo. É a assinatura do código antigo.

O merge foi 12:18Z e as quatro entraram entre 13:41Z e 13:50Z: o processo da API
ainda não tinha reiniciado.

## Prova de que o filtro está de pé

`waha_webhook_events` grava **todo** evento que chega, antes de qualquer filtro.
Comparando com o que virou mensagem:

| janela | eventos técnicos que chegaram | viraram mensagem |
|---|---|---|
| até 2026-07-28 13:50:05Z | 419 | 241 |
| depois de 13:50:05Z | 1 | **0** |

Na janela posterior chegaram 354 eventos brutos e 197 viraram mensagem — o
pipeline estava ativo. O único evento técnico do período (`notification_template`)
foi descartado.

É uma amostra de 1, e por si só seria fraca. Ela sustenta a conclusão porque
combina com os três fatos acima: as quatro têm assinatura de código antigo, e os
tipos delas já eram cobertos.

## O que a varredura completa revelou

Aproveitando o levantamento, todos os tipos já vistos no fluxo bruto:

| tipo | eventos | viraram msg | no vocabulário | com corpo |
|---|---|---|---|---|
| `chat` | 5 315 | 2 211 | — | 5 315 |
| `image` | 5 208 | 1 542 | — | 4 695 |
| `video` | 329 | 95 | — | 55 |
| `e2e_notification` | 275 | 141 | sim | 0 |
| `ptt` | 259 | 156 | — | 0 |
| `sticker` | 215 | 95 | — | 0 |
| `call_log` | 197 | 197 | — (decisão de produto) | 0 |
| `notification_template` | 116 | 71 | sim | 0 |
| `document` | 52 | 44 | — | 45 |
| `text` | 29 | 13 | — | 29 |
| `gp2` | 26 | 26 | sim | 0 |
| `album` | 12 | 4 | — | 0 |
| **`biz_content_placeholder`** | **12** | **12** | **não** | **0** |
| **`unknown`** | **11** | **11** | **não** | **0** |
| `interactive` | 7 | 6 | — | 3 |
| `audio` / `vcard` | 4 / 4 | 4 / 4 | — | 0 / 4 |
| `revoked` | 3 | 3 | sim | 0 |
| `location` / `product` | 2 / 1 | 2 / 1 | — | 0 |
| `group-history` / `message_history_notice` | 2 / 2 | 0 / 0 | — | 0 |

Dois candidatos apareceram. Eles não têm relação com as 4 mensagens investigadas —
são achado da varredura.

### `biz_content_placeholder` — acrescentado

12 mensagens, 12 conversas distintas, **nenhuma com corpo ou mídia**, e nas 12 é a
**única mensagem não técnica do chat**. Ou seja: doze conversas que existem por
causa dela e de mais nada. É o marcador que a conta business deixa no lugar de um
conteúdo que ela não entrega — ninguém escreveu e ninguém responde. Entrou no
vocabulário, com teste.

### `unknown` — deliberadamente fora

11 mensagens, também sem corpo e sem mídia, única não técnica em 8 dos 10 chats.
O perfil é parecido, mas o risco é assimétrico: `unknown` é o **fallback do
próprio parser** do WEBJS. Silenciá-lo hoje significa silenciar amanhã toda
mensagem real de um tipo que o WhatsApp ainda vai lançar — o erro sairia caro e
sairia calado. Ficou de fora, com teste fixando essa escolha.

É o mesmo critério que já mantém `call_log` fora: quando a resposta depende do que
o produto considera atendimento, e não do que a normalização consegue afirmar, a
decisão não é do normalizador.

## Efeito na limpeza retroativa

`docs/migrations-propostas-eventos-sistema.sql` tem a lista de tipos escrita à
mão. Acrescentar `biz_content_placeholder` ao código **não** a atualiza, e o teste
`eventos-sistema-cleanup-sql.test.ts` só garante um lado (todo tipo do SQL é
técnico para o código), não o contrário. Então:

- a limpeza, como está, **não** alcança as 12 mensagens de
  `biz_content_placeholder` nem as 12 conversas que elas criaram;
- quem for executar a limpeza deve decidir antes se as inclui e, se sim,
  acrescentar o tipo às listas do `.sql` e refazer a conferência.

Não alterei o `.sql` aqui: ele é a proposta de uma limpeza que ainda não rodou e
cujos números foram medidos com o vocabulário anterior. Mudar a lista sem refazer
a medição deixaria o arquivo dizendo um número e fazendo outro.
