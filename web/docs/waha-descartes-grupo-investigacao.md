# Descarte de mensagens de grupo no webhook WAHA (`missing_chat_id`)

Investigação de 31/07/2026 sobre mensagens de grupo — imagens e texto — que o
webhook da WAHA recebia e descartava sem gravar. Números medidos por replay dos
eventos reais de `waha_webhook_events` contra uma base SQLite local; nada foi
escrito em produção.

## 1. Sintoma

O log de produção registrava o descarte com o chat vazio, embora o JID do grupo
estivesse no evento:

```json
{"message":"WAHA message discarded","wahaMessageType":"image",
 "messageId":"false_120363363444637332@g.us_3EB06F93242EDB5978123A_105257451397231@lid",
 "chatIdReceived":null,"chatIdNormalized":null,"discardReason":"missing_chat_id"}
```

O `chatIdReceived: null` mandava procurar um payload sem identidade. O payload
tinha identidade — em um campo que a função de resolução não chegava a consultar.

## 2. Causa

O payload real desse evento, lido em `waha_webhook_events`, traz na raiz:

| campo | valor |
|---|---|
| `from` | `120363363444637332@g.us` |
| `to` | `558592369359@c.us` |
| `participant` | `105257451397231@lid` |
| `chatId` | ausente |
| `remoteJid` | ausente |
| `fromMe` | `false` |
| `hasMedia` | `true` |
| `type` (raiz) | ausente; `_data.type` é `image` |

`chatIdFromPayload`, em `apps/api/src/services/waha-webhook.service.ts`,
resolvia nesta ordem: `chatId`/`chat_id`, depois `remoteJid` (aceito apenas se
for `@g.us`), depois **descartava o evento se houvesse `participant`**, e só
então caía no fallback `from`/`sender`/`author`.

A guarda do participante existe pelo precedente da PR #18: um participante de
grupo não pode virar conversa privada. Mas ela era avaliada **antes** do
fallback, então um evento cujo `from` é um JID de grupo — onde não há
ambiguidade nenhuma — morria na guarda junto com os casos realmente ambíguos.

## 3. Medição

Replay dos 16.936 eventos `message` e `message.any` da base, pelo caminho de
ingestão de verdade:

| | antes | depois |
|---|---|---|
| normalizados | 6.122 (36,1%) | 15.787 (93,2%) |
| descartados | 10.814 (63,9%) | 1.149 (6,8%) |
| `missing_chat_id` | 10.372 | 686 |
| `technical_message_type` | 442 | 463 |

Os 21 eventos que migraram para `technical_message_type` são `gp2` — mudança de
participantes do grupo. Passaram a resolver o chat e, com isso, a ser
classificados como técnicos, que é o destino correto deles.

### Forma dos 10.372 descartes

| forma | eventos | é conversa? |
|---|---|---|
| `from` `@g.us`, `to` `@c.us`, com `participant`, recebida | 9.581 | sim — o defeito |
| `from` `@lid`, `to` `@g.us`, com `participant`, enviada | 79 | sim — o defeito, na direção de saída |
| `from` `@c.us`, `to` `@g.us`, com `participant`, enviada | 24 | sim |
| `from` `@lid`, `to` `@g.us`, com `participant`, recebida | 2 | sim |
| `from` `@broadcast`, com `participant` | 558 | não — status |
| `from` `@newsletter`, sem `participant` | 126 | não — canal |
| `from` `@c.us`/`@lid`, `to` `@c.us`, com `participant` | 2 | não — ambíguo, precedente #18 |

### Por tipo, entre os 10.372

`chat` 4.888, `image` 4.831, `video` 272, `sticker` 214, `ptt` 113, `gp2` 21,
`album` 13, `document` 9, e uma cauda de 9 eventos em 6 outros tipos. O relato
inicial era sobre imagens, mas texto responde por quase metade.

### Por dia

Antes de 17/07/2026 o descarte é residual: 1 a 9 por dia, 63 no total em vinte
meses. A partir de 20/07/2026 vira o regime normal:

```
2026-07-17     57     2026-07-24    537
2026-07-18      9     2026-07-25    975
2026-07-19      5     2026-07-26     62
2026-07-20    717     2026-07-27  1.130
2026-07-21  1.410     2026-07-28  1.736
2026-07-22  1.382     2026-07-29  1.276
2026-07-23    957     2026-07-31     56
```

O que mudou na origem para o WEBJS parar de mandar `chatId` e `remoteJid` nesses
eventos está **não identificado**: a investigação olhou só o lado do ChatPro.

## 4. A leitura do `messageId`

A hipótese de extrair o chat do próprio `messageId`
(`fromMe_chat_id_participante`) foi verificada contra a base antes de ser
descartada como desnecessária:

- **Campo 2 é o chat:** confere em 4.336 de 4.366 eventos que trazem `chatId`
  explícito (99,3%). As 30 divergências são todas o mesmo par — campo 2 em
  `@lid` contra um `chatId` em `@c.us`. Ou seja, o campo 2 continua sendo o
  chat, mas em outro endereçamento; usá-lo cru abriria uma segunda conversa para
  um chat que já existe.
- **Campo 4 é o autor:** confere em 13.726 de 13.727 eventos que trazem
  `participant` (99,99%).

A leitura se sustenta, mas não é necessária: `from` e `to` já carregam o JID do
grupo em todos os 9.686 eventos recuperáveis, sem o risco de duplicação por
`@lid`. A correção não faz parsing de `messageId`.

## 5. A correção

Em `chatIdFromPayload`, antes da guarda de participante:

```ts
const group = [text(value.from), text(value.to)].find(candidate => candidate?.endsWith('@g.us'));
if (group) return group;
```

Um JID `@g.us` endereça um chat e nunca um autor, então onde ele aparece não há a
ambiguidade que a guarda existe para resolver. Os eventos sem grupo algum
continuam passando pela guarda inalterada — os 686 que seguem descartados são
exatamente os `@broadcast`, `@newsletter` e os 2 casos ambíguos.

`chatIdSource`, que alimenta o log de normalização, ganhou o valor `group_jid`
pelo mesmo motivo que originou esta investigação: o log precisa dizer de onde
veio o chat.

## 6. O histórico já descartado

**Não está perdido.** `waha_webhook_events` guarda o evento bruto antes da
normalização, e os 10.372 descartados estão lá com o payload inteiro. O que se
perdeu foi a materialização em `whatsapp_messages` e `conversations`.

A correção só vale para eventos novos: as 9.686 mensagens já recebidas
continuam invisíveis na Inbox até que alguém as reprocesse.

Sobre um reprocessamento, três coisas medidas e uma não:

- **Rotina não existe.** `SqliteWahaWebhookStore.ingest` e o par Supabase
  começam inserindo em `waha_webhook_events`; reexecutá-los sobre um evento já
  gravado viola a unicidade. Reprocessar exige um caminho que pule esse passo e
  vá direto à normalização e à persistência. Não foi construído aqui.
- **Mídia:** dos 5.442 eventos descartados com `hasMedia`, 5.206 ainda têm
  `media.url` no payload guardado, 158 têm `media` sem url, 73 têm `media` nulo
  e 5 registram erro.
- **Se essas URLs ainda resolvem está não identificado** — verificar exigiria
  chamar a WAHA, o que esta investigação não fez. O precedente de
  `media-persistence.md` é que a WAHA zera `media` quando o arquivo deixa de ser
  baixável, o que sugere que as 5.206 ainda valem; sugerir não é medir.
- **Reprocessar escreve em produção** e depende de autorização explícita, que
  esta PR não tem e não pediu.

## 7. Fora do escopo

A ordem de resolução para eventos sem grupo não mudou, e o `@lid` do campo 2 do
`messageId` não foi tratado: se um dia um evento chegar só com esse
endereçamento, ele continuará abrindo conversa separada da `@c.us` equivalente.
A fusão de aliases `@lid`/`@c.us` já existe para chats diretos e não foi tocada.
