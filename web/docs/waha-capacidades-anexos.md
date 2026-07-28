# Capacidades da WAHA para novos tipos de anexo

Sondagem da instância local para dimensionar cinco funcionalidades no Inbox:
localização, cartão de contato (vCard), foto/vídeo pela câmera, áudio como
arquivo de música (distinto de PTT) e enquete.

Este documento não propõe implementação. Onde faltou evidência, está escrito
**não identificado** — nada aqui é suposição.

## Instância sondada

`GET /api/version` em `http://127.0.0.1:3002`:

```json
{"version":"2026.7.1","engine":"WEBJS","tier":"CORE","browser":"/usr/bin/chromium","platform":"linux/x64"}
```

## Método

POST com um nome de sessão que não existe (`probe-nonexistent-session-do-not-create`).
Nenhuma mensagem foi enviada a ninguém: a sessão real do workspace nunca foi usada.

Controle positivo e negativo, executados em cada rodada:

| requisição | HTTP | corpo |
| --- | --- | --- |
| `POST /api/sendText` (rota conhecida) | **422** | `{"error":"Session \"…\" does not exist"}` |
| `POST /api/sendDefinitelyNotARealEndpoint` | **404** | `{"message":"Cannot POST /api/…","error":"Not Found"}` |

Portanto: **422 = a rota existe**; **404 = a rota não existe**.

Uma terceira resposta apareceu e também prova existência: **400** com a lista de
campos inválidos, quando o DTO é validado antes da checagem de sessão.

## Endpoints presentes

| endpoint | HTTP | veredito |
| --- | --- | --- |
| `/api/sendText` (controle) | 422 | existe |
| `/api/sendLocation` | 422 | **existe** |
| `/api/sendContactVcard` | 422 | **existe** |
| `/api/sendPoll` | 422 | **existe** |
| `/api/sendVoice` | 422 | **existe** |
| `/api/sendFile` | 422 | **existe** |
| `/api/sendImage` | 422 | **existe** |
| `/api/sendVideo` | 422 | **existe** |
| `/api/sendPollVote` | 400 | **existe** (validação do DTO antes da sessão) |
| `/api/sendButtons` | 400 | existe |
| `/api/sendList` | 422 | existe |
| `/api/sendLinkPreview` | 422 | existe |
| `/api/sendSeen`, `/api/startTyping`, `/api/stopTyping`, `/api/forwardMessage` | 422 | existem |

Ausentes (404 em POST): `sendContact`, `sendVcard`, `sendAudio`, `sendMedia`,
`sendSticker`, `sendGif`, `sendButtonsReply`, `sendReaction`,
`sendLocationRequest`, `sendDocument`, `sendVideoNote`, `sendPtt`, `reaction`,
`star`. As duas últimas podem existir sob outro verbo — só POST foi sondado.

A instância **não expõe OpenAPI/Swagger**: `/-json`, `/api-json`, `/docs-json`,
`/swagger.json`, `/openapi.json` e a raiz respondem 404. Por isso os corpos abaixo
vêm da documentação oficial, não da instância.

### Esquemas obtidos da própria instância

Dois DTOs validam antes de resolver a sessão, então a WAHA descreveu os campos:

`POST /api/sendPollVote` — `chatId` string obrigatória, `pollMessageId` string
obrigatória e não vazia, `votes` array de strings obrigatório:

```
pollMessageId should not be empty
pollMessageId must be a string
each value in votes must be a string
votes must be an array
chatId must be a string
```

`POST /api/sendButtons` — `buttons` array de 1 a 4 elementos.

## Corpos esperados (documentação oficial)

Fonte: <https://waha.devlike.pro/docs/how-to/send-messages/>,
<https://waha.devlike.pro/docs/how-to/polls/> e o markdown da doc em
<https://github.com/devlikeapro/waha-docs>.

**Localização** — note o `title`, que a página de referência não listava e o
markdown-fonte mostra:

```json
{ "session": "default", "chatId": "11111111111@c.us",
  "latitude": 38.8937255, "longitude": -77.0969763, "title": "Our office" }
```

**Cartão de contato** — aceita `contacts` como array, em duas formas
intercambiáveis (campos estruturados **ou** vCard bruto):

```json
{ "session": "default", "chatId": "79111111@c.us",
  "contacts": [{ "fullName": "John Doe", "organization": "Company Name",
                 "phoneNumber": "+91 11111 11111", "whatsappId": "911111111111" }] }
```

```json
{ "session": "default", "chatId": "79111111@c.us",
  "contacts": [{ "vcard": "BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\n…\nEND:VCARD" }] }
```

**Enquete**:

```json
{ "session": "default", "chatId": "123123123@c.us",
  "poll": { "name": "How are you?", "options": ["Awesome!", "Good!", "Not bad!"],
            "multipleAnswers": false } }
```

**Mídia** (`sendVoice`, `sendFile`, `sendImage`, `sendVideo`) — o arquivo vai em
`file`, com **`url` ou `data` base64**, mais `mimetype` e `filename`:

| endpoint | campos próprios |
| --- | --- |
| `sendVoice` | `file.mimetype` documentado como `audio/ogg; codecs=opus`; `convert` booleano |
| `sendFile` | `file.filename` obrigatório |
| `sendImage` | `caption` opcional |
| `sendVideo` | `caption`, `asNote` e `convert` booleanos |

`sendText` aceita ainda `linkPreview`, `linkPreviewHighQuality`, `reply_to` e
`mentions`; `sendLocation` e `sendContactVcard` aceitam `reply_to`.

## Suporte do engine WEBJS

Fonte: <https://waha.devlike.pro/docs/how-to/engines/>.

| recurso | WEBJS |
| --- | --- |
| `sendLocation`, `sendContactVcard`, `sendPoll` | suportado |
| `sendVoice`, `sendFile`, `sendImage`, `sendVideo` | suportado |
| receber voto (`poll.vote`) | suportado |

Os sete endpoints que interessam são suportados no engine em uso.

**Tier CORE vs PLUS: não identificado.** As páginas consultadas publicam a matriz
por engine, não por tier. O que se sabe é que nesta instância CORE todas as rotas
estão registradas (responderam 422/400, não 404) — isso prova roteamento, não
prova que uma chamada real seria autorizada. Confirmar exigiria uma chamada com
sessão real, que esta sondagem não fez por decisão de segurança.

## Como o ChatPro envia anexo hoje

Caminho completo de saída:

```text
composer → POST /api/v1/inbox/conversations/:id/attachments (multipart)
  → InboxController.createAttachment (202)
  → AttachmentOutboxService.create   → linha em inbox_outbox_jobs (pending)
                                     → upload no bucket privado Supabase
  → dispatch() → storage.signedUrl(path, 300)
  → comando interno message.sendAttachment (HTTP → /internal/transport)
  → WahaProvider.sendAttachment (exige sessão connected)
  → WahaHttpClient.sendAttachment → endpoint WAHA
```

O arquivo **nunca vai em base64 nem por caminho local**: vai como URL assinada de
300 s de um bucket privado. Consequência direta: anexo de saída só funciona com
`DATABASE_PROVIDER=supabase` — no SQLite o storage responde 503.

O tipo de anexo é decidido **apenas pelo mimetype do arquivo**, nunca pela
intenção do operador (`attachment-outbox.service.ts:81`, `validateFile`).

Mapeamento em `waha-client.ts:87`:

| tipo | endpoint | flags |
| --- | --- | --- |
| `image` | `/api/sendImage` | — |
| `audio` | `/api/sendVoice` | `convert: true` |
| `video` | `/api/sendVideo` | `convert` se não for mp4, `asNote: false` |
| `document` | `/api/sendFile` | — |

### O que já é reutilizável

O outbox inteiro: idempotência por `clientRequestId`, validação de MIME/tamanho/
magic bytes, dois backends (SQLite e Supabase), máquina de estados
`pending | processing | sent | confirmed | failed | cancelled`, retry, cancelamento
e realtime. **Foto/vídeo pela câmera não precisa de nada no backend** — os mimes
`image/*` e `video/mp4` já passam nas allowlists; falta só o `capture` no input.

### O que falta estruturalmente

O protocolo interno tem exatamente dois comandos de envio: `message.send`
(carrega `text`) e `message.sendAttachment` (carrega `url` + `filename` +
`mimeType`, todos obrigatórios). **Não existe caminho para payload que não seja
arquivo nem texto** — coordenadas, contatos e enquete não cabem em nenhum dos
dois. Localização, vCard e enquete exigem comando novo no contrato, no worker e
no cliente WAHA.

A união de tipos `'image' | 'audio' | 'video' | 'document'` está duplicada em
cinco lugares que precisam mudar juntos: o tipo TS, dois schemas Zod, o
`WorkerCommand`/`WahaAttachment` e o CHECK das duas migrations. Qualquer tipo
novo custa migration nos dois bancos.

## PTT × arquivo de áudio

**No envio, não há distinção.** Todo `audio` vai para `/api/sendVoice` com
`convert: true` — um mp3 sai como nota de voz. O comportamento é intencional e
está travado por teste (`apps/worker/test/waha-client.test.ts:13`:
`['audio', 'audio/mpeg', '/api/sendVoice', { convert: true }]`). A documentação
da WAHA indica `sendVoice` para OPUS/OGG e `sendFile` para arquivo de música.

**Na recepção, também não há** — e isso está medido. `mediaType()`
(`waha-webhook.service.ts:164`) lê `value.type` só da raiz do payload e, na
ausência dele, classifica pelo mime. Consulta somente-leitura à base de produção,
6.810 mensagens:

| `message_type` | linhas |
| --- | ---: |
| text | 4.487 |
| document | 1.260 |
| image | 868 |
| audio | 114 |
| video | 81 |
| **ptt** | **0** |

Os 114 áudios têm todos mime `audio/ogg`, ou seja, são notas de voz gravadas no
WhatsApp — e foram gravadas como `audio`. Os `case 'ptt'` e `case 'voice'` de
`messagePreview` (`waha-webhook.service.ts:165`) são inalcançáveis para este
tráfego.

O dashboard tem um único player, casado por `messageType === 'audio'` ou mime
`audio/`, sem nome de arquivo e com `aria-label` fixo `Mensagem de áudio`.

Distinguir os dois é, portanto, um **quinto tipo de anexo** atravessando as cinco
duplicações acima — não é uma questão de mimetype novo, porque `audio/mpeg` já é
aceito hoje e vira PTT.

## O menu "+" do Inbox

Quatro opções (`Inbox.tsx`, dentro de `composer-attachment-options`):

| opção | estado |
| --- | --- |
| Documento | **real** — define `accept=".pdf,.doc,.docx,.xls,.xlsx,.txt"` e aciona o input |
| Fotos/Vídeos | **real** — define `accept="image/*,video/*"` e aciona o input |
| Áudio | **inerte** — classe `future-option`, rótulo "Em breve", sem `onClick` |
| Câmera | **inerte** — classe `future-option`, rótulo "Em breve", sem `onClick` |

Fora do menu, no mesmo composer: o botão de microfone é **real** e é hoje o único
produtor de áudio de saída (grava webm/ogg); o botão de emoji é inerte.

Não existe atributo `capture` nem `multiple` em nenhum input — é por isso que
"foto/vídeo pela câmera" ainda não funciona, mesmo com o backend pronto.

## Enquete: o que falta além do envio

O envio é a parte barata (`/api/sendPoll` existe e o WEBJS suporta). O voto é a
parte cara, e hoje **não tem por onde entrar**.

**1. O evento não é assinado.** O ChatPro aceita exatamente três eventos, e a
lista está fechada em três lugares independentes:

- `const acceptedEvents = ['message', 'message.any', 'session.status']` — `waha-webhook.service.ts:11`
- `CHECK (event_type IN ('message','message.any','session.status'))` — `supabase/migrations/002_waha_webhook_store.sql:5` e o equivalente em `apps/api/migrations/002_waha_webhook_store.sql:5`
- `WHATSAPP_HOOK_EVENTS: message,message.any,session.status` — `docker-compose.waha.yml:24`

Nenhum código do worker configura webhooks por sessão: `createSession` envia
apenas `{ name }`. A assinatura é só a do container.

**2. Se fosse assinado, seria rejeitado.** `parseWebhook` roda antes de qualquer
persistência, então um `poll.vote` viraria `VALIDATION_ERROR` HTTP 400 — entrega
falhada, não evento ignorado. Há ainda uma segunda barreira: `messageFrom` só
materializa linha de mensagem para `message`/`message.any`.

**3. O formato do payload não casa com o normalizador.** Segundo a documentação,
o evento é:

```json
{ "event": "poll.vote", "session": "default",
  "payload": { "vote": { "id": "…", "from": "1111111@c.us", "fromMe": false,
                         "selectedOptions": ["Awesome!"], "timestamp": 1692861427 },
               "poll": { "id": "…", "to": "1111111111@c.us", "fromMe": true } } }
```

Não há `id` nem `chatId` na raiz do `payload` — o id está em `payload.vote.id`.
O normalizador atual descartaria o registro por falta de id de mensagem.

**4. Modelo de dados.** A enquete em si cabe no que existe: `message_type` é
texto livre **sem CHECK**, então o valor `poll` já é gravável, e `payload_json`
guarda pergunta e opções sem coluna nova. Os votos **não cabem**: não existe
nenhuma tabela nem coluna de voto no repositório — busca por `poll`/`vote` em
`apps/`, `packages/` e `supabase/` retorna uma única ocorrência, e é um teste de
temporizador sem relação. A granularidade também não bate: o modelo atual é uma
linha por mensagem (chave workspace + sessão + `externalMessageId`), enquanto
"quem votou em quê" é N votantes × N opções, com o agravante da FK obrigatória
para `waha_webhook_events`, cuja coluna `event_type` está fechada por CHECK nos
dois bancos.

**Dimensão da enquete, em resumo:** enviar é um comando novo; receber voto é
ampliar a assinatura do webhook, ampliar o enum e o CHECK nos dois bancos,
ensinar o normalizador a extrair id de um payload com forma diferente, e criar
armazenamento de voto que hoje não existe em nenhuma forma.

## Lacunas

- **Tier CORE vs PLUS por endpoint** — não identificado; a documentação publica
  matriz por engine, não por tier.
- **Limites documentados de tamanho/conversão** para `sendVideo`, `sendVoice` e
  `sendFile` — não identificado nas páginas consultadas.
- **`reaction` e `star`** respondem 404 em POST; se existem sob outro verbo, não
  identificado.
- **Comportamento real de qualquer endpoint novo** — não verificado: nenhuma
  chamada foi feita com sessão real, por decisão de segurança desta sondagem.
