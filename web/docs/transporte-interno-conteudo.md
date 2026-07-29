# Envio de conteúdo que não é texto nem arquivo

O protocolo interno API→worker tinha dois comandos de envio: `message.send`,
que carrega uma string, e `message.sendAttachment`, que carrega `url` +
`filename` + `mimeType`, todos obrigatórios. Coordenadas, cartão de contato e
enquete não cabem em nenhum dos dois — ver `docs/waha-capacidades-anexos.md`.

`message.sendContent` é o terceiro comando.

## Forma

```jsonc
{ "type": "message.sendContent",
  "payload": {
    "wahaSession": "chatpro-…",
    "chatId": "5585…@c.us",
    "content": { "kind": "location", "latitude": -7.115, "longitude": -34.861, "title": "Escritório" }
  } }
```

`content` é uma união discriminada por `kind`, com as três variantes já
declaradas:

| kind | campos |
| --- | --- |
| `location` | `latitude` (−90..90), `longitude` (−180..180), `title` opcional |
| `vcard` | `contacts[]` (1..20), cada item **ou** `{ vcard }` **ou** `{ fullName, phoneNumber, organization?, whatsappId? }` |
| `poll` | `name`, `options[]` (2..12), `multipleAnswers` |

Os campos seguem a documentação da WAHA para `/api/sendLocation`,
`/api/sendContactVcard` e `/api/sendPoll`.

## Por que um comando com conteúdo discriminado

A alternativa seria um comando por tipo (`message.sendLocation`,
`message.sendVcard`, `message.sendPoll`). O envelope, porém, é idêntico nos três
— mesma sessão, mesmo chat, mesma resposta `sentMessage` — e só o conteúdo muda.

Com um comando só:

- **A união de comandos do transporte não cresce por funcionalidade.** As três
  variantes já estão no contrato, então acrescentar vCard ou enquete depois não
  mexe em `packages/contracts`.
- **A resposta não muda.** `internalTransportDataSchema` já tem a variante
  `sentMessage`, reaproveitada como está.
- **Um ponto de entrada no worker.** Um branch no servidor de transporte e um
  `switch` no provider, em vez de três de cada.

O `switch` do provider é exaustivo com `const unreachable: never`, então uma
variante nova acrescentada ao contrato **quebra a compilação** do worker em vez
de ser aceita e descartada em silêncio.

## Validação de verdade

O `timeoutMs` era enviado pela API, validado pelo schema e **ignorado pelo
handler** — o erro que esta extensão não repete. Aqui a validação é do contrato e
acontece na porta do worker, antes de qualquer execução:

- limites numéricos reais de latitude e longitude, não `z.number()` solto;
- enquete com no mínimo duas opções;
- lista de contatos não vazia;
- `kind` desconhecido rejeitado pela união discriminada.

Todos esses casos são cobertos por teste que verifica **duas coisas**: que a
resposta é `VALIDATION_ERROR` e que o worker **não foi chamado**. Um campo que
viaja sem ser usado passaria na primeira asserção e falharia na segunda.

## Estado por variante

Nesta etapa o contrato e o roteamento estão completos; o provider ainda responde
`NOT_IMPLEMENTED` com o `kind` nos detalhes, para as três variantes. Os adaptadores
Baileys e demo respondem `NOT_IMPLEMENTED` próprio, como já faziam para
`historyPage`.

`location` é implementada na etapa seguinte. `vcard` e `poll` seguem declaradas e
validadas, mas sem execução — e o `NOT_IMPLEMENTED` é a resposta correta e
observável para elas, não um silêncio.
