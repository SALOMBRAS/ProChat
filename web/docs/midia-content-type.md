# Content-type da mídia persistida

## O defeito

`waha-webhook.controller.ts` montava a chamada de persistência com
`messageType: firstString(event.payload.type)`. O payload WAHA/WEBJS **não tem
`type` na raiz** — o tipo real mora em `_data.type`. Medido na base viva:

| onde o tipo está | mensagens |
|---|---|
| raiz (`payload.type`) | **13** de 4 638 |
| `_data.type` | **4 625** de 4 638 |

As 13 da raiz são todas `type='text'`, `direction='outbound'`, sem mídia: é o
envio pelo Inbox, cujo payload sintético (`outboundRecord`) carrega `type` na raiz
e não tem `_data`. Ou seja, para **todo o tráfego que traz mídia** o
`messageType` chegava `null`.

Consequência direta: `normalizedMime(value, messageType)` só sabe corrigir um
content-type genérico se souber o tipo da mensagem. Sem ele, os três ramos de
correção (vídeo, áudio, sticker) eram inalcançáveis.

O mesmo buraco existia em `pendingMedia`, que não selecionava tipo nenhum:
`importPending` — que roda a cada boot da API, junto com `repairStoredMime`
(`app.ts`) — sempre chamava `persist` com `messageType` indefinido.

## Blast radius: medido, não estimado

### O que aconteceu com a mídia já armazenada

**Nada.** Não há mídia armazenada com content-type genérico:

| | |
|---|---|
| mensagens com `media_url` | 996 |
| armazenadas no Storage | 957 |
| marcadas `unavailable` | 39 |
| pendentes de importação | **0** |
| **armazenadas com mime genérico** (`application/octet-stream`, `application/mp4`) | **0** |
| com `media_url` e mime nulo | **0** |

O content-type de cada mídia armazenada bate com o tipo real:

| tipo WAHA | família do mime gravado | linhas |
|---|---|---|
| `image` | `image/…` | 726 |
| `ptt` | `audio/…` | 111 |
| `video` | `video/…` | 71 |
| `sticker` | `image/…` | 35 |
| `document` | `application/`, `image/`, `video/` | 11 |
| `audio` | `audio/…` | 2 |
| `interactive` | `image/…` | 1 |

A razão é que `persist` usa o `content-type` do **cabeçalho HTTP da resposta do
WAHA** como primeira fonte, e o WAHA sempre devolveu um content-type específico.
`normalizedMime` é o remendo para quando ele não devolve — e esse caso nunca
aconteceu nesta base.

**Portanto o defeito é real mas latente**: nunca chegou a produzir dado ruim. O
dia em que o WAHA responder `application/octet-stream` — que é o que ele faz
quando não reconhece o arquivo — a normalização falharia em silêncio. A correção
fecha isso antes.

### Se o proxy e o dashboard dependem do valor atual

Os dois dependem, por caminhos diferentes, e nenhum quebra com a correção.

**Proxy** (`waha-media-proxy.service.ts`): só entra em ação para mídia que **não**
está no Storage. `inbox.controller.ts` redireciona para uma signed URL do Storage
quando há `storagePath`; sem ele, aí sim streama do WAHA. E mesmo então usa
`upstream.headers.get('content-type')` primeiro, com `fallbackMimeType` só como
reserva. Não lê `message_type`. **Não é afetado.**

**Storage**: com `storagePath`, o navegador busca direto na signed URL e recebe o
content-type **gravado no objeto**. É por isso que o valor calculado em `persist`
importa: ele vai para o objeto e para a coluna `media_mime_type`.

**Dashboard** (`Inbox.tsx`): decide o componente por
`message.messageType === 'image' | 'sticker' | 'video'`, depois
`messageType === 'audio' || mediaMimeType?.startsWith('audio/')`, e cai em
documento. Ou seja, depende da coluna `message_type` **e** do mime. No cenário
genérico os dois falhariam ao mesmo tempo: `mediaType()` decide a coluna por
sniffing do mime e, com `application/octet-stream`, devolve `'document'` — um
áudio viraria card de documento. Como não há nenhuma linha nesse estado, nada muda
na tela hoje.

### Correção retroativa

**Não é necessária: são 0 linhas.** A consulta de conferência (somente leitura,
para rodar de novo antes de concluir — a base é viva):

```sql
SELECT count(*) AS mime_generico
FROM public.whatsapp_messages
WHERE media_storage_path IS NOT NULL
  AND lower(media_mime_type) IN ('application/mp4', 'application/octet-stream');
-- medido em 2026-07-28: 0
```

Se um dia não for zero, o caminho **não é SQL**. Um `UPDATE` conserta a coluna mas
não o content-type do objeto no Storage, que é o que o navegador recebe — e é
justamente ele que faz o `<audio>`/`<video>` recusar tocar. Quem faz as duas
coisas é `repairStoredMime()`, que já roda a cada boot: baixa o objeto, reescreve
o content-type e atualiza a coluna. Depois desta correção ele passa a receber o
tipo real do payload, e não a coluna `message_type` derivada — que, no caso
genérico, vale `'document'` e faria todos os ramos errarem justamente quando são
necessários.

Só como registro, o `UPDATE` equivalente **não deve ser executado sozinho**, e
fica aqui comentado para deixar explícito por que ele não basta:

```sql
-- NÃO EXECUTAR: conserta a coluna e deixa o objeto no Storage com o
-- content-type antigo, que é o que o navegador realmente lê.
-- UPDATE public.whatsapp_messages SET media_mime_type = 'audio/mp4'
-- WHERE media_storage_path IS NOT NULL
--   AND lower(media_mime_type) IN ('application/mp4','application/octet-stream')
--   AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type','')) IN ('ptt','audio');
```

## A correção

1. `wahaMessageType` passa a morar em `conversation-identity.ts`, exportado. A
   cópia privada em `waha-webhook.service.ts` some — era ela que permitia ao
   controller ler só a raiz enquanto a normalização de mensagem lia as duas.
2. O controller resolve o tipo por essa função.
3. `pendingMedia` e `storedMediaWithGenericMime` passam a trazer o tipo **do
   payload**, nos dois provedores: `json_extract(payloadJson, '$.type')` /
   `'$._data.type'` no SQLite, `payload_json->>type` / `payload_json->_data->>type`
   no PostgREST. A decisão de qual vale continua sendo uma só, em JS.
4. `normalizedMime` passa a tratar `ptt` como áudio. É o tipo que o WhatsApp usa
   para nota de voz e responde por 111 dos 113 áudios da base — sem ele o ramo de
   áudio seguiria morto na prática, mesmo com o tipo certo em mãos.

O que **não** mudou de propósito: a coluna `message_type` continua sendo o valor
normalizado por `mediaType()` (`text`/`image`/`video`/`audio`/`document`). Mudá-la
alteraria o dispatch do dashboard e o significado do campo em toda a base, o que é
outra decisão.
