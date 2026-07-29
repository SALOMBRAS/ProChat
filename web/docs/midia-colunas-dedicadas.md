# Colunas dedicadas de mídia: por que chegavam nulas

Companheiro obrigatório: `docs/migrations-propostas-midia-colunas.sql` (backfill
e a proposta de coluna para a forma de onda). Contexto de origem:
`docs/media-persistence.md` e `docs/midia-content-type.md`.

## 1. O sintoma

O dashboard mostrava "Documento" e "Tamanho não informado" para arquivos que
tinham nome e tamanho, e nota de voz sem duração. A PR #66 resolveu na tela,
lendo `metadata._data` direto no cliente — funciona, e degrada em silêncio se a
WAHA mudar o formato cru. Este documento é o caminho definitivo: a API preenche
as colunas.

## 2. Onde a mensagem é persistida

```text
POST /api/v1/webhooks/waha
  └─ waha-webhook.controller.ts     valida HMAC, responde 202
      └─ waha-webhook.service.ts
          ├─ webhookRecord()        evento cru -> StoredWebhook
          ├─ messageFrom()          <- AQUI as colunas são decididas
          └─ Sqlite/SupabaseWahaWebhookStore.ingest()
                                    INSERT em whatsapp_messages
```

`messageFrom` é o único ponto de extração: os dois provedores consomem o mesmo
`StoredMessage` e gravam as mesmas colunas, só muda a sintaxe do INSERT. Depois,
e só para quem tem `mediaUrl` vivo, o worker de mídia baixa o arquivo e
`persistMedia` regrava `media_size`, `media_mime_type` e `media_filename` com o
que o download revelou.

## 3. Por que os campos não eram extraídos

Não é omissão: o caminho existe e é acionado em toda mensagem. **O código estava
lendo no lugar errado.**

`messageFrom` procurava tamanho, nome e duração dentro de `payload.media`:

```ts
mediaSize: integer(media?.filesize) ?? integer(media?.size) ?? integer(value.mediaSize),
duration:  integer(media?.duration) ?? integer(value.duration),
```

Mas `payload.media`, no tráfego real da WAHA/WEBJS, carrega quatro campos e
nenhum deles é tamanho ou duração — `url`, `filename`, `mimetype` e, quando o
download falha, `error`:

```json
"media": { "url": "…", "filename": null, "mimetype": "image/jpeg" }
```

Não há `filesize`, não há `size`, não há `duration` — nunca houve; as quatro
chaves acima são todas as que aparecem nas 6 833 linhas. E o objeto inteiro é
`null` quando o arquivo já não está baixável: 1 253 das 2 350 mensagens de mídia,
53 %.

O dado mora em `_data`, e os números chegam **como texto**:

```json
"_data": { "type": "ptt", "size": "7678", "duration": "18",
           "mimetype": "audio/ogg; codecs=opus", "filename": "Nota fiscal.pdf",
           "waveform": { "0": 0, "1": 27, …, "63": 41 } }
```

Dois erros somados, portanto: a raiz não era o lugar, e o helper `integer()` só
aceitava `typeof value === 'number'` — então mesmo se o campo tivesse sido lido,
`"18"` viraria `null`.

É a mesma família de erro da #57 (`wahaMessageType` lia só a raiz e o tipo real
estava em `_data.type`), agora nos campos de mídia em vez do tipo.

### Medição, na base de produção

6 833 mensagens lidas via PostgREST, somente leitura, em 2026-07-29. Das 2 350
mensagens de mídia (image, video, ptt, audio, document, sticker):

A coluna "preenchida antes" olha só as mensagens de mídia; a de "linhas a
recuperar" conta a base inteira, porque um `interactive` com vídeo anexado também
tem o dado e também o perdia.

| Coluna | Preenchida antes | Linhas a recuperar |
|---|---|---|
| `duration` | **0** (100 % nula, inclusive nas 338 notas de voz) | 475, em `_data.duration` |
| `media_size` | só onde o worker baixou o arquivo | 1 379, em `_data.size` |
| `media_filename` | 18 documentos | 59, em `_data.filename` |
| `media_mime_type` | 1 080 de 2 350 | 1 273 — 1 256 em `_data.mimetype` e 17 na raiz, que a ingestão antiga também não gravou |

O detalhe que fecha o diagnóstico: as 970 mensagens de mídia com `media_size`
preenchida são **exatamente** as 970 que têm `media_storage_path`. Nem uma a
mais. Hoje esse valor vem só do download posterior, jamais da ingestão — e
`media_filename` está quase lá (977 preenchidas contra as mesmas 970 baixadas: as
7 de diferença são as únicas em que `payload.media.filename` existia e a ingestão
conseguiu ler).

> **Estado em 2026-07-29:** o comentário de cabeçalho de
> `apps/dashboard/src/ui/messageMedia.ts`, que chegou à main pela #66, declara
> para as mesmas colunas números que não batem com os desta seção: 89 documentos,
> com `media_filename` em 1 deles e `media_size` em nenhum, contra os 77
> documentos e 18 nomes medidos aqui. As duas medições dizem ser da base de
> produção e da mesma semana. A causa da diferença é **não identificada** — pode
> ser recorte de workspace, de intervalo ou de critério de `message_type`, e nada
> disso foi verificado. Nenhum dos dois lados foi corrigido pelo outro. Quem
> tiver acesso de leitura ao Supabase deve recontar antes de citar qualquer um
> dos dois números; o backfill da seção 7 só deve rodar depois que a conferência
> do SQL (`PARTE A`, A1) for reexecutada e reconciliada com a medição.

## 4. A correção

`messageFrom` passa a ler cada campo na raiz primeiro e em `_data` depois — a
mesma ordem de `wahaMessageType`, pelo mesmo motivo (o Inbox monta payload
sintético com `type` na raiz; a WAHA deixa a raiz vazia):

| Coluna | Ordem de leitura |
|---|---|
| `mediaMimeType` | `media.mimetype` → `media.mimeType` → `_data.mimetype` |
| `mediaFilename` | `media.filename` → `filename` → `_data.filename` |
| `mediaSize` | `media.filesize` → `media.size` → `mediaSize` → `_data.size` |
| `duration` | `media.duration` → `duration` → `_data.duration` |

E `integer()` passa a aceitar o inteiro serializado como texto, com
`/^\d+$/` — que recusa de propósito sinal, decimal, espaço e notação científica,
porque `Number(' ')` é `0` e um `0` gravado chega na tela como "0 B".

### O precedente da #57, e como ele foi evitado

Passar o vocabulário cru inteiro adiante reclassificaria a maior parte da base —
foi o que a #57 documentou (`text` viraria `chat`, e `gp2`, `e2e_notification` e
`revoked` chegariam à Inbox). O risco equivalente aqui é o mime: ele não é só uma
coluna, ele **decide `messageType`** dentro de `mediaType()`.

Por isso a extração é campo a campo e a variável que alimenta `mediaType()`
continua sendo só a da raiz. `_data.mimetype` preenche a coluna e não entra na
classificação.

**Medido antes de commitar**, rodando a extração velha e a nova sobre os mesmos
6 833 payloads reais:

| Campo | null → valor | valor mudou | valor → null |
|---|---|---|---|
| `messageType` | 0 | **0** | 0 |
| `mediaMimeType` | 1 256 | 0 | 0 |
| `mediaSize` | 2 350 | 0 | 0 |
| `duration` | 475 | 0 | 0 |
| `mediaFilename` | 59 | 0 | 0 |
| `mediaUrl`, `thumbnailUrl`, `quotedMessageId` | 0 | 0 | 0 |

Zero reclassificação, e nenhum valor existente alterado ou perdido. Se o mime de
`_data` alimentasse `mediaType()`, 1 256 linhas mudariam de tipo — há teste
prendendo exatamente isso.

Conferência contra o que o worker já tinha gravado ao baixar o arquivo:
`media_size` concorda em 971 de 971 e `media_filename` em 18 de 18. O mime
difere em 116, sempre pelo parâmetro: o payload diz `audio/ogg; codecs=opus` e o
`content-type` do download diz `audio/ogg`. O download continua vencendo, porque
roda depois — a coluna termina como termina hoje.

### Deriva histórica, que não é desta mudança

Em 131 das 6 833 linhas a coluna `message_type` não corresponde ao que o código
de hoje produziria: 114 são as notas de voz que a #57 deixou sem backfill
(`audio` onde hoje seria `ptt`) e 17 são linhas antigas (`text` onde hoje seria
`image`). Já estavam assim antes desta mudança e continuam.

## 5. O que ficou de fora, e por quê

**`thumbnail_url`** — nula em 100 % e continua. Não há de onde tirá-la: a WAHA
não manda URL de miniatura. O que existe é a miniatura embutida em base64 no
corpo da mensagem; `safeUrl` recusa `data:`, e uma imagem inteira não cabe numa
coluna de URL. O dashboard usa a coluna como `poster` do vídeo e simplesmente
não tem pôster.

**`quoted_message_id`** — nula em 100 %, e `_data.quotedStanzaID` existe em 944
linhas. Ficou de fora por não ter leitor: nenhum componente do dashboard usa a
coluna. Preencher o que ninguém lê só adicionaria risco. Fica registrado aqui
como trabalho disponível se a citação de mensagem virar produto.

**Largura, altura e número de páginas** (`_data.width` e `_data.height` em 1 895
linhas, `_data.pageCount` em 71) — não há coluna e não há leitor.

## 6. Forma de onda

**Recomendação: fica onde está, no payload. Não criar coluna.**

Medido: `_data.waveform` existe em 340 das 6 833 linhas (5,0 %), só em nota de
voz, sempre com exatamente 64 amplitudes, ~496 bytes de JSON.

O ponto decisivo é que **ela já chega à tela hoje**: `listMessages` devolve o
`payload_json` inteiro como `metadata`, sem filtrar, nos dois provedores. Uma
coluna dedicada custaria duas migrations, um backfill e a mesma leitura de
`_data` — para entregar o mesmo byte que já está chegando.

O que justificaria criar: filtrar ou ordenar por forma de onda (ninguém faz nem
pediu), ou parar de devolver o payload inteiro ao dashboard — decisão maior, que
teria de vir antes e mudaria muito mais que a onda.

O DDL está escrito e **inteiramente comentado** em
`docs/migrations-propostas-midia-colunas.sql`, PARTE B, para o caso de a decisão
ser outra. Nada foi aplicado.

## 7. Backfill das linhas já gravadas

A correção de código impede novos casos e não desfaz os já gravados. O SQL está
em `docs/migrations-propostas-midia-colunas.sql`, PARTE A, nos dois dialetos,
com **a conferência liberada e o UPDATE comentado**. Não foi executado em
produção.

Preenche 1 570 linhas (união das quatro colunas): 475 de duração, 1 379 de
tamanho, 59 de nome e 1 273 de mime. Não sobrescreve nada — o `COALESCE` põe a
coluna existente na frente.

Validado de verdade, sem tocar no remoto: a parte PostgreSQL rodou num contêiner
descartável carregado com um espelho somente-leitura das 6 833 linhas, e a parte
SQLite roda em teste contra o schema do repositório
(`apps/api/test/midia-colunas-backfill-sql.test.ts`). A invariante que os dois
provam é a mesma: **o valor que o backfill grava é igual ao que a ingestão
gravaria para o mesmo payload** — conferido linha a linha no espelho, 6 833 de
6 833.

## 8. O que o dashboard pode voltar a fazer

Nada aqui foi alterado em `apps/dashboard` — os leitores da #66 continuam
funcionando exatamente como estão, porque já preferem a coluna e só caem no
payload quando ela é nula. Com as colunas preenchidas, a retaguarda deixa de ser
acionada sozinha, sem uma linha de mudança.

Quando alguém for simplificar `ui/messageMedia.ts`, o que muda é isto:

| Leitor | Hoje | Depois do backfill |
|---|---|---|
| `mediaDuration` | `duration` ?? `_data.duration` | só a coluna |
| `mediaSize` | `mediaSize` ?? `_data.size` ?? `_data.fileLength` | só a coluna (`fileLength` não existe em nenhuma linha da base) |
| `mediaFilename` | `mediaFilename` ?? `_data.filename` | só a coluna, mantendo o filtro de rótulo (`image`, `attachment`…) |
| `documentKind` | `mediaMimeType` ?? `_data.mimetype` | só a coluna |
| `isVoiceNote` | `messageType === 'ptt'` ou `_data.type === 'ptt'` | **manter as duas** — 114 linhas continuam gravadas como `audio` e o backfill de `message_type` da #57 nunca foi feito |
| `voiceWaveform` | `_data.waveform` | **manter** — é a decisão da seção 6 |

Ou seja: quatro leitores podem perder a retaguarda, e dois têm de mantê-la. Vale
esperar o backfill ser aprovado e executado antes de mexer: enquanto ele não
rodar, tirar a retaguarda regride a tela para o estado anterior à #66 nas linhas
antigas.
