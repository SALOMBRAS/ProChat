# Localização: enviar e receber — especificação portável

Escrito para quem vai implementar o mesmo recurso em outro sistema, sem acesso a
este código. Cobre o ciclo inteiro: o envio, construído nas PRs #49 (o contrato),
#51 (o envio) e #55 (o refinamento), e a recepção, que **não funcionava** até a
PR #119 e cujo defeito é o assunto de §3.8.

Onde a decisão foi arbitrária, está escrito que foi arbitrária. Onde há número
medido, a medição está junto, e está dito quem mediu. Onde não houve evidência,
está escrito **não identificado**.

Há uma seção que não é sobre localização: §4. Ela descreve a distinção entre a
raiz do payload e `_data`, que neste repositório causou **quatro** incidentes em
sete dias. A localização é só o quarto. Quem for integrar WAHA/WEBJS deve ler §4
mesmo que não vá enviar localização nenhuma.

---

## 1. O que faz

**Enviando.** O operador abre a conversa, clica no `+`, escolhe **Localização**.
Um painel oferece "Usar minha localização atual" — que pede a posição ao
navegador — ou um campo para digitar `latitude, longitude`. Ele pode dar um nome
ao ponto, conferir no mapa antes de mandar, e enviar. Na conversa aparece um
cartão com um pino, o nome do lugar (ou as coordenadas) e um link que abre o
mapa.

**Recebendo.** O cliente manda a localização dele pelo WhatsApp. Aparece o mesmo
cartão, agora com a **miniatura do mapa que o WhatsApp já mandou embutida**, o
nome e o endereço do lugar quando ele escolheu um ponto nomeado, e um selo "ao
vivo" quando é localização em tempo real.

As duas pontas terminam no mesmo componente de tela. O que muda é tudo o resto.

---

## 2. Arquitetura

### Os dois caminhos

```text
ENVIO
  painel no compositor
    → POST /api/v1/inbox/conversations/:id/location      {latitude, longitude, title?}
    → InternalInboxService.sendLocation
    → deliver()  ── o MESMO de texto e de anexo
    → comando  message.sendContent  { content: { kind: 'location', … } }
    → transporte interno HTTP
    → waha-provider.sendContent  → ramo 'location'
    → POST {WAHA}/api/sendLocation  { session, chatId, latitude, longitude, title? }
    → recordOutbound  → whatsapp_messages (message_type='location', payload_json.location)

RECEPÇÃO
  WAHA → webhook → messageFrom()
    → tipo real: _data.type = 'location'        ← §3.8, o defeito estava aqui
    → mapa canônico → message_type = 'location'
    → body = location.name  (NUNCA o body da raiz — §3.8)
    → payload_json guarda o payload cru inteiro
    → listMessages devolve payload_json como `metadata`
    → locationOf(metadata) → cartão
```

### A fronteira

O componente de tela recebe uma `InboxMessage` e lê `metadata`. Ele não sabe se a
mensagem foi enviada por nós ou recebida do WhatsApp — e essa indiferença é
comprada com uma função de leitura que aceita as duas formas (§3.11), não com um
ramo por origem.

Do lado do servidor a fronteira é o **comando**: a API não conhece o WAHA, e o
worker não conhece conversa, workspace nem banco. Entre os dois passa
`message.sendContent`, validado por Zod nas duas pontas.

---

## 3. As decisões e o porquê

### 3.1 Um comando só, com conteúdo discriminado

**O problema:** `message.send` carrega uma string e `message.sendAttachment`
carrega URL, nome e mimetype. Um par de coordenadas não cabe em nenhum dos dois.

**A decisão**, escrita no próprio contrato:

> *One command with a discriminated content instead of one command per kind: the
> envelope is identical for all of them — same session, same chat, same
> `sentMessage` answer — and only the content differs. A new kind is a member of
> this union plus a branch in the provider; it needs no new command type, no new
> response variant and no new call site in the API.*
>
> — `packages/contracts/src/index.ts:144-150`

```ts
export const sendableLocationSchema = z.object({
  kind: z.literal('location'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  title: z.string().trim().min(1).max(240).optional(),
});
export const sendableContentSchema =
  z.discriminatedUnion('kind', [sendableLocationSchema, sendableVcardSchema, sendablePollSchema]);
```

`packages/contracts/src/index.ts:152-159`.

O que a decisão compra, concretamente: `vcard` e `poll` **já estão declarados no
contrato** (`:153` e `:157`) sem que nenhum dos dois tivesse consumidor quando a
#49 entrou. Acrescentar o cartão de contato depois não tocou em
`packages/contracts` — só o ramo do provedor e a chamada da API.

O que ela custa: o envelope tem de servir aos três. Se algum dia um tipo precisar
de resposta diferente de `sentMessage`, a união deixa de bastar e o desenho
precisa mudar. Hoje os três respondem igual.

**O `240` do título é arbitrário.** Não há comentário, teste ou referência ao
limite do WhatsApp que o justifique. Os limites de latitude e longitude, não: são
a faixa geográfica real.

**Uma duplicação que vale notar:** o schema da rota HTTP
(`apps/api/src/controllers/inbox.controller.ts:22`) repete os mesmos três campos
com os mesmos limites, em vez de derivar de `sendableLocationSchema`. São dois
lugares para manter em sincronia, e nada os prende um ao outro.

### 3.2 As coordenadas viajam no payload, não numa coluna nova

A justificativa está no código:

> *Same delivery, persistence and automation as a text send; only the worker
> command and what gets stored differ. The message keeps `messageType`
> `location` and the coordinates travel in the stored payload, which the message
> reader already surfaces as `metadata` — so no column, no migration and no
> change to either repository.*
>
> — `apps/api/src/services/internal-inbox.service.ts:14-20`

```ts
return this.deliver(context, conversationId, {
  command: session => ({ type: 'message.sendContent', payload: { …, content: { kind: 'location', latitude, longitude, …title } } }),
  messageType: 'location',
  body: location.title ?? null,
  payload: { location: { latitude, longitude, …title } },
});
```

`apps/api/src/services/internal-inbox.service.ts:22-28`.

**Por que isso é o desenho certo aqui, e não preguiça:** a coluna `payload_json`
já existe, já é gravada para toda mensagem, e já é devolvida ao cliente como
`metadata` (`listMessages`). Uma coluna `latitude`/`longitude` exigiria migration
nas **duas** árvores — SQLite e Supabase —, mudaria os dois repositórios, e
serviria a um tipo de mensagem só.

**O preço, dito sem maquiagem:** não dá para consultar por proximidade. `SELECT …
WHERE distância(lat, lng, ponto) < 1km` é impossível sem extrair de JSON, e
qualquer índice geoespacial pediria a coluna. Se o seu produto for fazer busca
por raio, essa decisão se inverte — e é melhor inverter antes de ter dados.

### 3.3 O corpo recebe o título, não os números

`body: location.title ?? null` (`internal-inbox.service.ts:26`). A razão, na PR:

> ***`body` recebe o título, não os números.** É o corpo que aparece na lista de
> conversas; um par de coordenadas ali seria ruído. Sem título, `body` é `null` —
> e a prévia já respondia `Localização` para esse tipo antes desta PR.*
>
> — corpo da PR #51

A prévia é decidida por `messagePreview`, que devolve `'Localização'` para o tipo
independentemente do corpo (`apps/api/src/services/waha-webhook.service.ts`, ramo
`case 'location'`). Então o `body` não é o que a lista mostra — ele é o que a
**busca** encontra e o que o cartão evita repetir (§3.11).

### 3.4 Link de mapa em vez de preview — e a assimetria que ninguém previu

**A decisão original**, da #51:

> ***Renderização: link, não preview.** Mapa estático exigiria chave de API e um
> terceiro no caminho. A mensagem vira `📍 título` (ou `lat, lng`) abrindo o mapa
> em nova aba.*

O que um preview custaria, concretamente: um serviço de mapa estático (Google
Static Maps, Mapbox, similar) cobra por requisição e exige chave; a chave viaja
no HTML se o `<img>` for montado no cliente, ou obriga a um proxy no servidor se
não for; e cada mensagem de localização na tela vira uma requisição a um terceiro
que passa a saber onde os clientes do operador estão. Para um produto de
atendimento isso é dado de cliente vazando por conta de um enfeite.

**A assimetria**, descoberta na #55 e que é a parte interessante:

> ***`thumbnail`**: o WhatsApp **já manda a miniatura do mapa embutida em
> base64**. A decisão de usar link em vez de preview foi tomada porque "preview
> exigiria chave de API e um terceiro no caminho" — para mensagens **recebidas**
> isso não vale: a imagem já veio, e vira `data:` URI sem chave e sem terceiro. O
> link continua, como o cartão inteiro. (Para as **enviadas** não há miniatura, e
> aí o link segue sozinho.)*
>
> — corpo da PR #55

Ou seja: **a mesma decisão produz resultados diferentes nas duas direções, e está
certa nas duas.** Recebida ganha miniatura de graça; enviada fica só com o link.
O código expressa isso sem um `if` sobre direção — ele desenha a miniatura quando
ela existe:

```tsx
{point.thumbnail && <img className="message-location-thumb" src={point.thumbnail} alt="" />}
```

`apps/dashboard/src/ui/MessageMedia.tsx:223`.

E o `data:` URI é montado na leitura, não na ingestão:

```ts
thumbnail: thumbnail && !thumbnail.startsWith("data:") ? `data:image/jpeg;base64,${thumbnail}` : thumbnail,
```

`apps/dashboard/src/ui/messageMedia.ts` (dentro de `locationOf`). O `startsWith`
existe para o caso de a origem já mandar o prefixo — **não identificado** se
alguma origem manda.

O serviço do link é o Google Maps:

```ts
export const mapsUrl = (latitude: number, longitude: number) =>
  `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
```

`apps/dashboard/src/ui/messageMedia.ts`. **É escolha arbitrária** — o formato
`geo:` ou o OpenStreetMap serviriam igual, e não há comentário justificando.

### 3.5 A precisão no desktop, e o que a página não pergunta

O pedido de posição é este, e é o único do sistema:

```ts
navigator.geolocation.getCurrentPosition(
  (position) => { … position.coords.latitude, position.coords.longitude … },
  (failure) => setLocationError(geolocationErrorMessage(failure)),
  { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
);
```

`apps/dashboard/src/ui/Inbox.tsx:973-980`.

**Por que erra centenas de metros num desktop.** A API de geolocalização do
navegador não é GPS: é uma abstração sobre a melhor fonte que o aparelho tiver.
Num celular há GPS/GNSS. Num desktop não há, e a posição sai de duas fontes:

- **os pontos de acesso Wi-Fi à volta**, comparados com uma base do fornecedor do
  navegador — dá dezenas a centenas de metros quando a base conhece a região;
- **o endereço IP**, quando não há Wi-Fi utilizável — e aí o erro é o do bloco de
  IP, tipicamente a cidade ou o bairro, o que pode ser quilômetros.

`enableHighAccuracy: true` **pede** ao aparelho a fonte mais precisa disponível.
Num celular isso liga o GPS, com custo de bateria e de tempo. Num desktop **não
há fonte melhor para ligar**: a opção é uma dica, não uma garantia, e o navegador
pode ignorá-la. É por isso que a bandeira não conserta o desktop — ela não tem o
que acionar.

> Isto é **leitura da especificação** da W3C Geolocation API e do comportamento
> conhecido dos navegadores, **não medição feita neste projeto**. Não medimos o
> erro real em nenhum aparelho. Se importar para o seu caso, meça.

**O que `coords.accuracy` informa.** A especificação define `accuracy` como o raio
de incerteza em **metros**, num nível de confiança de 95%. É o próprio navegador
dizendo "estou nesta posição, com erro provável de até N metros". Um desktop por
IP costuma devolver valores na casa dos milhares; um celular com GPS aberto, na
casa das unidades.

**E este sistema não lê esse campo.** Varredura em `apps/dashboard/src`: as
únicas leituras de `position.coords` são `latitude` e `longitude`
(`Inbox.tsx:976-977`). `accuracy` nunca é consultado, nunca é mostrado e nunca
entra no envio.

A consequência é a que se imagina: **o operador não tem como saber se o ponto que
vai mandar tem 10 metros ou 10 quilômetros de erro.** Ele vê seis casas decimais
— `position.coords.latitude.toFixed(6)`, `Inbox.tsx:977` — que sugerem precisão
de centímetros e não significam nada sobre a exatidão. Seis casas decimais de um
número errado continuam sendo um número errado.

A escala, para dimensionar: um grau de latitude são ~111 320 m, então a sexta casa
decimal vale **~0,11 m** e a quinta — a que o cartão da mensagem exibe, via
`coordinatesLabel` — vale **~1,11 m**. O campo promete decímetros e o cartão
promete metros, para um dado que pode estar a quilômetros.

E não haveria onde guardar a incerteza mesmo que fosse lida: **nenhuma das quatro
camadas do envio tem campo para ela.** Nem o contrato (§3.1), nem a rota, nem o
comando, nem `/api/sendLocation`. Expor `accuracy` seria mudança de contrato, não
só de tela — e **não identificado** se o protocolo do WhatsApp aceitaria.

Mostrar `accuracy` ao lado do campo, ou recusar acima de um limiar, é a correção
óbvia e **não está implementada**. Registro como lacuna, não como bug: nada
quebra, o operador só decide sem uma informação que o navegador ofereceu de
graça.

`timeout: 10_000` e `maximumAge: 0` são calibração sem justificativa no código.
`maximumAge: 0` recusa posição em cache e força medição nova — defensável para
"minha localização atual", e mais lento.

### 3.6 Painel em vez de `prompt`, e faixa além de formato

A #51 usava `window.prompt`. A #55 trocou, e disse por quê:

> ***`window.prompt` virou painel.** O prompt não se estiliza, não se corrige e
> não mostra o que deu errado. Agora é campo com validação de formato **e de
> faixa** (latitude ±90, longitude ±180), com linha de erro e conferência no mapa
> antes de enviar.*

A validação de faixa importa porque formato sem faixa aceita `91, 200`, que
atravessa o cliente, atravessa a rota e só morre no Zod do contrato — depois de
uma ida ao servidor, com erro de validação genérico.

O botão de enviar só habilita quando as coordenadas resolvem, e há uma linha
explicando por que ele está apagado — decisão registrada em comentário:

> *Desabilitar só quando o campo está vazio deixava passar "abc": o operador
> clicava e só então lia o erro. Agora o botão exige coordenada que resolve, e a
> dica explica por que ele está apagado — senão o botão morto não diz nada.*
>
> — `apps/dashboard/src/ui/Inbox.tsx:1326-1329`

#### Um defeito, encontrado escrevendo esta especificação

O comentário de `parseCoordinates` diz:

> *Aceita "lat, lon" e "lat lon", **com vírgula ou ponto decimal**, e valida a
> faixa* — `apps/dashboard/src/ui/Inbox.tsx:117-118`

**Vírgula decimal não é aceita.** A função separa os dois números por `[,;]` ou
espaço **antes** de converter, então uma vírgula decimal vira separador de campo.
Executado:

```text
"-7.115, -34.861"   -> { latitude: -7.115, longitude: -34.861 }
"-7,115, -34,861"   -> undefined      partes: ["-7","115","-34","861"]
"-7,115 -34,861"    -> undefined      partes: ["-7","115","-34","861"]
"-7,115;-34,861"    -> undefined      partes: ["-7","115","-34","861"]
```

Num produto em português isso não é detalhe: vírgula é o separador decimal da
língua, e é o que sai quando o operador copia coordenada de muita fonte
brasileira. Ele recebe *"Coordenadas inválidas"* para uma coordenada que está
certa.

**E há um caso pior que a recusa.** Uma coordenada **única** com vírgula decimal
não é recusada — ela vira um par válido e enviável:

```text
"-7,115"   -> { latitude: -7, longitude: 115 }     ← aceito, e enviável
"-3,7784"  -> undefined
"0x10, 0"  -> { latitude: 16, longitude: 0 }       ← `Number` aceita hexadecimal
```

`-7, 115` é um ponto no Oceano Índico. O operador digita uma latitude sozinha, no
formato da própria língua, e o sistema manda ao cliente uma localização a
milhares de quilômetros — sem erro, sem aviso, e com o botão de enviar habilitado
porque `parseCoordinates` devolveu um objeto. **Isto é o modo de falha mais caro
descrito nesta especificação**, e foi encontrado executando a função, não lendo.

O comentário descreve a intenção; o código não a implementa. **Não corrigido** —
está registrado aqui e é escopo de outra frente. Quem for portar: decida entre
implementar o que o comentário promete (o que exige separar por `;` ou espaço
quando há vírgula decimal, e é ambíguo em `-7,115,-34,861`) ou corrigir o
comentário — mas em qualquer caso **recuse a entrada de um número só**, que hoje
passa.

#### O link de conferência não confere o que vai ser enviado

```tsx
{locationPoint && <a href={mapsUrl(locationPoint.latitude, locationPoint.longitude)} …>
   Conferir no mapa antes de enviar</a>}
…
<button onClick={confirmLocation} disabled={!parseCoordinates(locationCoords)}>Enviar localização</button>
```

`apps/dashboard/src/ui/Inbox.tsx:1325` e `:1331`.

O link lê `locationPoint`; o envio lê `parseCoordinates(locationCoords)`. São
**duas fontes diferentes**, e `setLocationPoint` só é chamado em dois lugares: ao
abrir o painel, para limpar, e dentro de `useCurrentLocation` (`:967` e `:976`).
Nunca a partir do campo digitado. Duas consequências:

- **Quem digita a coordenada nunca vê o link.** `locationPoint` fica `undefined`,
  e a conferência no mapa — a defesa contra o parágrafo anterior — não aparece
  justamente na entrada que mais precisa dela.
- **Quem usa o GPS e depois edita o campo confere o ponto errado.** O link
  continua apontando para a posição do GPS enquanto o envio usa o texto editado.

O conserto é uma linha: derivar o link de `parseCoordinates(locationCoords)`, que
é o mesmo valor que o botão de enviar já consulta. **Não corrigido.**

### 3.7 Três erros de geolocalização, não um

> ***Um erro de geolocalização virou três.** A API distingue `PERMISSION_DENIED`,
> `POSITION_UNAVAILABLE` e `TIMEOUT`, e o operador age diferente em cada um —
> todos apontam para o campo manual como saída. O `message` cru do navegador não
> chega mais à tela.*
>
> — corpo da PR #55

```ts
const geolocationErrorMessage = (error: unknown) => {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === 1) return "Permissão de localização negada. Autorize o acesso …";
  if (code === 2) return "Localização indisponível agora. Verifique se o GPS ou a rede estão ativos …";
  if (code === 3) return "A localização demorou demais para responder …";
  return "Não foi possível obter a localização. Informe o ponto abaixo.";
};
```

`apps/dashboard/src/ui/Inbox.tsx:110-116`, com o comentário certo: *"O `code` é o
contrato — `message` é texto do navegador, varia por fabricante e não é para o
operador."*

**As três mensagens terminam apontando para o campo manual.** Isso é o que
transforma um erro em uma saída: nenhuma delas deixa o operador sem próximo
passo.

### 3.8 Recepção: o tipo não está onde se procura, e o corpo é a miniatura

Este é o defeito que impediu a recepção de funcionar até 2026-08-03, e ele é a
razão de §4 existir.

**O que se via.** Duas coisas, que pareciam dois defeitos e eram um:

- localização recebida **não aparecia** na conversa;
- às vezes aparecia como **4 KB de `/9j/4AAQSkZJRgABAQAA…`** ocupando a tela.

**A causa.** O WAHA/WEBJS **não preenche `type` na raiz** do payload. Medido na
base viva: a raiz vinha preenchida em **15 de 12.851 linhas**, e as 15 eram
envios nossos — cujo payload sintético traz `type` na raiz e nenhum `_data`. O
tipo real vive em `_data.type`.

A classificação recebia a raiz como tipo primário. Uma localização não tem mídia
(`hasMedia: false`, `media: null`), então caía no ramo final e virava `text`.

E aí o segundo golpe: **o `body` da raiz de uma localização é a miniatura do mapa
em base64** — o mesmo blob de `location.thumbnail`. Medido: igualdade exata em
13 de 13 linhas. Copiá-lo para a coluna de texto é o que punha o base64 na
conversa e em `conversations.last_message`.

Os dois sintomas, então, são a mesma linha de código:

| a localização veio… | body da raiz | o que o operador via |
| --- | --- | --- |
| com miniatura | 3 548 a 5 444 caracteres de base64 | um bloco de lixo |
| sem miniatura | vazio | **nada** — bolha vazia |

**Onde os dados realmente estão** (todos na RAIZ, não em `_data`):

```json
{ "location": { "live": false,
                "latitude": -3.7784414291381836,
                "longitude": -38.48479080200195,
                "name": "Planeta Animal",
                "address": "Av Dr Silas Munguba 1299 Parangaba",
                "description": "Planeta Animal\nAv Dr Silas Munguba 1299 Parangaba",
                "thumbnail": "/9j/4AAQ…" },
  "_data": { "type": "location", "lat": -3.778…, "lng": -38.484…, "loc": "Planeta Animal\n…" } }
```

- **`latitude`/`longitude`**: raiz `location.*`, duplicadas em `_data.lat`/`lng`.
- **nome do lugar**: raiz `location.name`; `address` separado; `description` é os
  dois concatenados; `_data.loc` espelha a `description`. Medido: **1 de 13**
  mensagens trazia nome — o resto era coordenada nua.
- **`live: true`** em 8 de 13 — localização em tempo real (§6).
- **o tipo**: só `_data.type`.

**A correção** é classificar pelo tipo real e extrair o corpo por tipo:

```ts
if (canonical === 'location') {
  const point = record(value.location);
  return text(point?.name) ?? null;      // NUNCA value.body
}
```

`apps/api/src/services/waha-webhook.service.ts`, em `bodyFrom`. Sem nome, a
localização **não tem corpo**: o cartão do mapa já diz tudo, e a prévia da
conversa responde `Localização` pelo tipo.

**A renderização não precisou mudar.** `locationOf` já lia a raiz `location` com
`name`, `address`, `thumbnail` e `live` desde a #55. Faltava só a classificação —
o cartão nunca era alcançado porque `messageType` era `text`.

### 3.9 O mapa explícito, e por que não repassar o tipo cru

Descoberto que o tipo real está em `_data.type`, a correção óbvia é usá-lo
direto. **É armadilha, e foi medida antes de qualquer linha ser escrita:**

> `chat` é como o WEBJS chama uma mensagem de texto comum: **7 365 linhas**.
> Adotar o vocabulário cru renomearia **10 714 das 12 851 linhas — 83%**.

O produto fala `text`, `image`, `contact`. O WEBJS fala `chat`, `image`, `vcard`.
Repassar o vocabulário do provedor quebraria toda a renderização, toda a prévia e
todo consumidor que compara `messageType`.

**A solução é um mapa explícito e curto:**

```ts
const canonicalRawTypes: ReadonlyMap<string, string> = new Map([
  ['chat', 'text'],
  ['location', 'location'],
  ['vcard', 'contact'],
  ['multi_vcard', 'contact'],
]);
```

`apps/api/src/services/waha-webhook.service.ts`.

Duas propriedades que fazem o mapa valer, e que são o desenho e não o acaso:

1. **Tipo que não está no mapa NÃO é traduzido.** Ele continua caindo na
   classificação por mime, exatamente como antes. É isso que impede o primeiro
   tipo novo do WhatsApp de virar um rótulo que nenhum renderizador conhece.
2. **O mapa é curto de propósito.** Só entram os tipos cuja tradução é conhecida
   e cujo destino o produto sabe desenhar. `location` e `contact` são os dois que
   a tela desenha a partir do payload guardado, sem buscar mídia — para eles a
   classificação era a única peça faltando.

### 3.10 Como o mapa foi validado antes de virar código

Um mapa de tradução que erra reclassifica milhares de linhas em silêncio. Antes
de confiar nele, o efeito foi **simulado sobre a base inteira, somente leitura** —
e o simulador foi validado antes de ser usado para prever.

O procedimento, que vale copiar:

1. **Escrever um simulador** da lógica atual, fora do código de produção.
2. **Rodá-lo contra a coluna real** de todas as linhas. Se ele reproduz a coluna,
   ele é fiel; se não, o entendimento está errado e não adianta prever nada.
   Resultado: **12 725 de 12 856 = 99,0%**.
3. **Investigar as divergências** em vez de ignorá-las. As 131 eram linhas
   antigas, gravadas antes de correções anteriores — a coluna reflete o código do
   dia da inserção, não o de hoje. Isso *confirma* a fidelidade em vez de
   contradizê-la.
4. **Só então** rodar o simulador com a lógica nova e medir a diferença:
   **19 linhas, 0,15%** — 13 para `location`, 6 para `contact`, 9 corpos perdendo
   o base64. Nenhuma linha `chat` mudando.

O passo 2 é o que a maioria pula, e é o único que distingue "medi o efeito" de
"imaginei o efeito com uma planilha". Um simulador que não reproduz o presente
não tem autoridade nenhuma sobre o futuro.

### 3.11 `name` × `title`: o mesmo campo com dois nomes

As duas origens nomeiam o mesmo dado de formas diferentes, e a leitura tem de
aceitar as duas:

| origem | onde | campo |
| --- | --- | --- |
| enviada por nós | `metadata.location` | `title` |
| recebida do WhatsApp | `metadata.location` | `name` |

```ts
title: text(point.title) ?? text(point.name),
```

`apps/dashboard/src/ui/messageMedia.ts`, em `locationOf`, com o comentário: *"`title`
e `name` são o mesmo campo com nomes diferentes de cada lado — quem só lê `title`
mostra coordenadas nuas para um lugar que veio nomeado."*

Foi exatamente o sintoma que a #55 corrigiu. E a própria PR registra que a
correção está no lugar errado:

> *é o tipo de coisa que ficaria melhor resolvida na origem, normalizando no
> `waha-webhook.service` em vez de no front*

Concordo, e continua no front. Normalizar na ingestão faria toda a leitura a
jusante — tela, busca, export, relatório — ver um campo só. Normalizar na leitura
obriga cada consumidor novo a lembrar dos dois nomes. **Não corrigido.**

O `bodyRepeatsCard` existe pelo mesmo motivo: o corpo guardado de uma localização
enviada é o título, e o cartão já mostra o título em destaque; renderizar os dois
põe a mesma frase duas vezes.

---

## 4. A armadilha central: a raiz do payload versus `_data`

Esta seção não é sobre localização. É sobre a única coisa que quem integra
WAHA/WEBJS precisa saber antes de escrever a primeira linha.

### 4.1 A regra

> **No payload de mensagem do WAHA com engine WEBJS, a raiz é uma vista parcial e
> `_data` é o objeto real do WhatsApp Web. Campo que você procura na raiz e não
> encontra provavelmente está em `_data` — e campo que você encontra na raiz pode
> ser uma projeção com outro nome, outra forma, ou lixo.**

O caso extremo é o `body` da raiz de uma localização: ele **existe**, é uma
string, e é a miniatura do mapa em base64. Quem lê `payload.body` esperando texto
não recebe `undefined` — recebe 4 KB de dados binários codificados, que atravessam
validação de string, cabem numa coluna `TEXT` e chegam à tela.

### 4.2 Os quatro incidentes

Quatro PRs em sete dias, quatro pontos de chamada diferentes, a mesma distinção:

| # | data | o que lia a raiz | sintoma |
| --- | --- | --- | --- |
| **#34** | 2026-07-28 | `messageFrom` → `mediaType(value.type, …)` | Todo evento de sistema virava texto de entrada, **abria conversa**, marcava não lida e começava relógio de SLA. |
| **#43** | 2026-07-28 | `waha-webhook.controller.ts`, com `firstString(event.payload.type)` | Toda mensagem com mídia chegava à persistência com `messageType` nulo, e a resolução de mime **nunca alcançava** os ramos de vídeo, áudio e sticker. |
| **#57** | 2026-07-29 | `mediaType` recebia a raiz como tipo primário | Nota de voz e arquivo de música chegam com o mesmo `audio/ogg`; sem o tipo real, **toda nota de voz virava `audio`**. |
| **#119** | 2026-08-03 | `mediaType` idem, e o mime lido só de `media.mimetype` da raiz | Localização e cartão de contato viravam `text`, com a miniatura em base64 no corpo; e todo anexo do histórico virava `document`, porque o objeto `media` da raiz **só existe no evento ao vivo**. |

A mensagem de commit da #34 já enuncia a regra inteira:

> *The WAHA/WEBJS message payload has no `type` at the root — the real type lives
> in `_data.type`. messageFrom read only the root, so mediaType fell…*

E mesmo assim a #43 caiu no dia seguinte, num arquivo diferente. **Escrever a
regra num commit não a fez valer no repositório.**

### 4.3 O que se aprende, e o que fazer

- **Uma função canônica não basta se ela for opcional.** `wahaMessageType` existe
  desde a #34 e resolve raiz-depois-`_data`. As três recaídas foram todas em
  pontos que **não a chamaram**. O que faltou não foi a função: foi impedir que
  alguém lesse `payload.type` diretamente.
- **O que teria pegado as três:** um teste que afirme, para um payload realista
  de cada tipo, que o tipo resolvido não é `undefined`. Ou, mais forte, uma
  fronteira que impeça o acesso cru — normalizar o payload numa forma própria na
  entrada, e nunca deixar o payload do provedor circular.
- **Ao portar, normalize na ingestão.** Este sistema guarda o payload cru e faz
  cada consumidor se virar. É o que produz o `name` × `title` de §3.11, e é o que
  produziu os quatro incidentes.
- **Meça antes de confiar.** Todo número desta especificação — 15 de 12.851, 83%,
  13 de 13 — saiu de consulta somente leitura à base viva. A distinção raiz/`_data`
  não se descobre lendo documentação do provedor; descobre-se contando linhas.

---

## 5. Implementação de referência

### 5.1 O contrato

```ts
/** §3.1 — um comando, conteúdo discriminado por `kind`. Um tipo novo é um membro
 *  desta união mais um ramo no provedor: nenhum tipo de comando novo, nenhuma
 *  variante de resposta nova, nenhum ponto de chamada novo na API. */
export const sendableLocationSchema = z.object({
  kind: z.literal('location'),
  latitude: z.number().min(-90).max(90),      // faixa geográfica real, não escolha
  longitude: z.number().min(-180).max(180),
  title: z.string().trim().min(1).max(240).optional(),   // o 240 é arbitrário
});
export const sendableContentSchema =
  z.discriminatedUnion('kind', [sendableLocationSchema, sendableVcardSchema, sendablePollSchema]);

export const internalSendContentCommandSchema = z.object({
  type: z.literal('message.sendContent'),
  payload: z.object({ wahaSession: z.string().min(1), chatId: z.string().min(1), content: sendableContentSchema }),
});
```

### 5.2 O envio

```ts
/** §3.2 — mesma entrega, persistência e automação de um texto. Só mudam o comando
 *  e o que se guarda. As coordenadas viajam no payload guardado, que o leitor de
 *  mensagens já devolve como `metadata`: nenhuma coluna, nenhuma migration. */
sendLocation(context, conversationId, location: { latitude: number; longitude: number; title?: string }) {
  return this.deliver(context, conversationId, {
    command: session => ({ type: 'message.sendContent', payload: { wahaSession: session.wahaSession, chatId: session.chatId,
      content: { kind: 'location', latitude: location.latitude, longitude: location.longitude, ...(location.title ? { title: location.title } : {}) } } }),
    messageType: 'location',
    body: location.title ?? null,        // §3.3 — o título, nunca os números
    payload: { location: { latitude: location.latitude, longitude: location.longitude, ...(location.title ? { title: location.title } : {}) } },
  });
}

/** No provedor: um ramo por `kind`, e nada mais. */
private async sendContent(context, wahaSession, chatId, content: SendableContent) {
  if (content.kind === 'location')
    return this.client.sendLocation(stored.wahaName, chatId,
      { latitude: content.latitude, longitude: content.longitude, ...(content.title ? { title: content.title } : {}) });
  /* … vcard, poll … */
}
```

E o corpo literal da requisição ao provedor:

```http
POST {WAHA_BASE_URL}/api/sendLocation
{ "session": "…", "chatId": "5511999990000@c.us",
  "latitude": -7.115, "longitude": -34.861, "title": "Loja centro" }
```

`apps/worker/src/waha-client.ts:103-104`. `title` é omitido quando não há.

### 5.3 A recepção

```ts
/** §3.9 — a tradução do vocabulário do provedor. MAPA, nunca repasse: `chat` é
 *  como o WEBJS chama texto comum, e adotar o vocabulário cru renomearia 83% da
 *  tabela. Tipo fora do mapa NÃO é traduzido e continua caindo na classificação
 *  por mime — é isso que impede um tipo novo de virar rótulo desconhecido. */
const canonicalRawTypes = new Map([
  ['chat', 'text'], ['location', 'location'], ['vcard', 'contact'], ['multi_vcard', 'contact'],
]);

/** §4 — o tipo real, de onde quer que o payload o carregue. A raiz vem preenchida
 *  em 15 de 12.851 linhas, e as 15 são envios nossos. */
export function wahaMessageType(payload: unknown): string | undefined {
  const root = payload as Record<string, unknown> | undefined;
  const nested = (root?._data as Record<string, unknown> | undefined)?.type;
  return firstNonEmpty(root?.type, nested);
}

/** §3.8 — o corpo por tipo. Numa localização o `body` da raiz é a MINIATURA do
 *  mapa em base64, idêntica a `location.thumbnail` em 13 de 13 linhas medidas.
 *  Copiá-la para a coluna de texto é o defeito que esta função existe para
 *  impedir. Sem nome, a localização não tem corpo. */
function bodyFrom(canonical: string, value: Record<string, unknown>): string | null {
  if (canonical === 'location') return text(record(value.location)?.name) ?? null;
  return text(value.body) ?? text(value.text) ?? null;
}
```

### 5.4 A leitura e o cartão

```ts
/** §3.11 — lê as DUAS origens: `title` do que enviamos, `name` do que recebemos.
 *  Quem só lê `title` mostra coordenada nua para um lugar que veio nomeado. */
export const locationOf = (metadata: unknown) => {
  const point = (metadata as { location?: Record<string, unknown> } | undefined)?.location;
  if (!point) return undefined;
  const latitude = Number(point.latitude), longitude = Number(point.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const thumbnail = text(point.thumbnail);
  return {
    latitude, longitude,
    title: text(point.title) ?? text(point.name),
    address: text(point.address),
    // §3.4 — a miniatura já veio embutida: preview sem chave e sem terceiro.
    thumbnail: thumbnail && !thumbnail.startsWith("data:") ? `data:image/jpeg;base64,${thumbnail}` : thumbnail,
    live: point.live === true,
  };
};
export const mapsUrl = (lat: number, lng: number) =>
  `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
```

```tsx
/* §3.4 — a miniatura é desenhada quando existe. Nenhum `if` sobre direção: a
   enviada simplesmente não tem, e o cartão fica só com o link. */
<a href={mapsUrl(point.latitude, point.longitude)} target="_blank" rel="noreferrer noopener">
  {point.thumbnail && <img src={point.thumbnail} alt="" />}
  <strong>◎ {point.title || "Localização"}{point.live && <em> · ao vivo</em>}</strong>
  <span>{point.address || coordinatesLabel(point.latitude, point.longitude)}</span>
  <span>Abrir no mapa ↗</span>
</a>
```

### 5.5 O que é específico deste projeto

| Item | Por que é específico |
| --- | --- |
| **`POST /api/sendLocation` e a forma `{session, chatId, latitude, longitude, title?}`** | É a API do WAHA. A Meta Cloud API tem outro contrato; o Baileys, outro. Os dois adaptadores locais recusam com `NOT_IMPLEMENTED`. |
| **Google Maps no `mapsUrl`** | Escolha arbitrária, sem justificativa registrada. `geo:` ou OpenStreetMap serviriam. |
| **`title` máximo 240** | Arbitrário. Não corresponde a limite documentado do WhatsApp. |
| **`timeout: 10_000`, `maximumAge: 0`** | Calibração sem justificativa no código. |
| **Seis casas decimais no campo** | Escolha de exibição, e enganosa: sugere precisão que a fonte não tem (§3.5). |
| **`payload_json` como lugar das coordenadas** | Decisão certa **aqui** porque a coluna já existia e já era devolvida como `metadata`. Se o seu produto for consultar por raio, inverta (§3.2). |
| **O mapa `canonicalRawTypes` com quatro entradas** | Os quatro tipos que este produto sabe desenhar. A *forma* (mapa curto, sem repasse, com fallback por mime) é o que vale copiar; as entradas são do produto. |
| **Textos em português** | Estão em toda parte. |
| **Duplicação do schema entre contrato e rota** | Acidente, não desenho (§3.1). Não copie. |

Portável sem alteração: a união discriminada de §3.1, a decisão de guardar
descrição em vez de coluna (§3.2) com a ressalva do raio, a separação
link × preview e a assimetria de §3.4, a regra de §4 inteira, o procedimento de
validação de simulador de §3.10, `wahaMessageType`, `bodyFrom`, `locationOf` e o
mapa canônico com fallback por mime.

---

## 6. O que não está incluído

### Pontos de referência próximos

Mostrar "Padaria X, 200 m" em vez de `-7.115, -34.861` é a melhoria que mais
mudaria a experiência, e é a que tem custo real.

**Google Places.** Resolve bem e cobra por requisição. O preço varia por SKU,
tier (Essentials/Pro/Enterprise) e volume — a faixa publicada vai de poucos
dólares a algumas dezenas de dólares por mil requisições, e a tabela oficial é a
única fonte confiável porque muda. Exige chave, e a chave num cliente web é
pública salvo restrição por referer, o que empurra para um proxy no servidor.
Como cada mensagem de localização na tela viraria uma consulta, o custo escala
com o **tráfego de leitura da Inbox**, não com o de envio — que é o pior perfil
possível para essa conta.

**OpenStreetMap.** O serviço público de geocodificação reversa (Nominatim) é
gratuito e tem política de uso explícita: **no máximo 1 requisição por segundo**,
e **4 por minuto** para tarefas em massa; geocodificação em massa é
explicitamente desencorajada; exige `User-Agent` ou `Referer` identificando a
aplicação e atribuição sob ODbL. Para uma Inbox com várias localizações por tela,
**1 req/s não serve** — e usar assim mesmo é abusar de servidores doados.

A saída honesta com OSM é **hospedar o Nominatim**, o que troca custo por
requisição por custo de operação: a base do planeta pede dezenas de gigabytes e
uma máquina dedicada.

**Nenhuma das três foi feita.** Nenhum número de custo foi medido para o volume
deste produto — **não identificado** quantas localizações por dia a Inbox exibe.
Antes de escolher fornecedor, meça isso: é o número que decide.

> Fontes de preço e política, consultadas em 2026-08:
> [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing) ·
> [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)

### Localização em tempo real

O payload recebido traz `location.live: true` — e são **8 de 13** das mensagens
medidas, mais da metade. Hoje isso vira um selo "· ao vivo" no cartão
(`MessageMedia.tsx:225`) e **nada mais**: a posição mostrada é a do instante em
que a mensagem chegou, e não se move.

Fazer de verdade é outro problema, não uma melhoria deste: exige receber as
atualizações subsequentes que o WhatsApp emite para a mesma sessão de
compartilhamento, ligá-las à mensagem original, decidir por quanto tempo a
conversa mostra uma posição que muda, e o que fazer quando o compartilhamento
termina. **Não identificado** se o WAHA sequer entrega essas atualizações — não
há evento de atualização de localização em nenhum payload da base.

O selo, como está, é honesto: diz que era ao vivo quando chegou. Não promete
acompanhar.

### Enviar localização em tempo real

Não existe, e não é simétrico do anterior. Exigiria manter uma sessão de
compartilhamento aberta a partir do navegador do operador, com permissão contínua
de geolocalização e uma fonte de posição que o desktop não tem (§3.5).

---

## 7. Armadilhas

Em ordem aproximada de quanto tempo custam quando aparecem.

**O tipo que não está na raiz.** §4. Quatro incidentes em sete dias, quatro
arquivos diferentes. A raiz do payload WAHA/WEBJS vem quase vazia — 15 campos
preenchidos em 12.851 linhas — e o objeto real é `_data`. Uma função canônica não
resolve sozinha: ela só resolve onde é chamada, e as três recaídas foram em
pontos que não a chamaram.

**O `body` que parece texto e é uma imagem.** §3.8. O `body` da raiz de uma
localização é a miniatura do mapa em base64. Não é `undefined`, não é vazio, não
falha em nenhuma validação de string: são 3 548 a 5 444 caracteres que atravessam
tudo e chegam à tela. Extraia o corpo por tipo, nunca genericamente.

**Adotar o vocabulário do provedor.** §3.9. `chat` é como o WEBJS chama texto
comum: 7 365 linhas, 57% da tabela. Repassar o tipo cru renomeia 83% e quebra
toda a renderização de uma vez. Traduza por mapa curto, e deixe o que não está no
mapa cair na classificação anterior.

**Simulador que ninguém validou.** §3.10. Medir o efeito de uma reclassificação
com um simulador que não reproduz o presente é imaginar o efeito com passos
extras. Rode contra a coluna real primeiro; se não bater, o entendimento está
errado, e investigar as divergências vale mais que a previsão.

**Seis casas decimais de um número errado.** §3.5. O campo mostra
`toFixed(6)` — precisão de centímetros — para uma posição que num desktop pode
estar a quilômetros. `coords.accuracy` diz o raio de erro em metros e **este
sistema não o lê**. O operador decide sem a informação que o navegador ofereceu
de graça.

**`enableHighAccuracy` como conserto.** §3.5. É uma dica, não uma garantia, e num
desktop não há fonte melhor para acionar. Ligá-la não melhora nada onde não há
GPS — só custa bateria onde há.

**Uma latitude sozinha virando um par válido.** §3.6. `"-7,115"` — uma coordenada
única no formato decimal da própria língua — é separada em dois números e enviada
como `{-7, 115}`, um ponto no Oceano Índico. Sem erro, sem aviso, botão
habilitado. É o modo de falha mais caro desta especificação, e nenhum teste o
pega. Separar campos por um caractere que também é separador decimal é a raiz;
recuse a entrada de um número só, no mínimo.

**Vírgula decimal recusada num produto em português.** §3.6. O mesmo mecanismo
pelo lado benigno: `-7,115, -34,861` vira quatro pedaços e a coordenada certa é
recusada como inválida. O comentário promete aceitar. Encontrado executando a
função, não lendo.

**O botão de conferir que confere outra coisa.** §3.6. O link do mapa lê
`locationPoint`, que só o GPS preenche; o envio lê o campo de texto. Quem digita
nunca vê o link, e quem usa o GPS e depois edita confere o ponto antigo. Duas
fontes para a mesma pergunta é sempre uma a mais.

**`name` × `title`.** §3.11. O mesmo campo com nome diferente de cada lado. Quem
lê só um mostra coordenada nua para um lugar que veio nomeado — e a correção, no
front, obriga cada consumidor novo a lembrar dos dois. Normalize na ingestão.

**Coordenadas na prévia da conversa.** §3.3. `body` é o que aparece na lista;
um par de números ali é ruído para o operador que varre a coluna. Guarde o
título, e deixe a prévia responder pelo tipo.

**Preview de mapa por hábito.** §3.4. Custa chave de API, um terceiro sabendo
onde os clientes estão, e uma requisição por mensagem **renderizada** — que
escala com leitura da Inbox, não com envio. Na recepção o WhatsApp já manda a
miniatura embutida: ali o preview é grátis e o hábito estava certo pelo motivo
errado.

**Guardar coordenada só no JSON.** §3.2. É a decisão certa até o dia em que
alguém pedir "conversas num raio de 2 km". Aí não há índice possível sem
migration e sem reprocessar o histórico. Decida cedo.

**Um `prompt` para entrada estruturada.** §3.6. Não se estiliza, não se corrige,
não mostra o que deu errado, e a validação de faixa não cabe nele.

**Um erro de geolocalização só.** §3.7. Permissão negada, posição indisponível e
tempo esgotado pedem ações diferentes do operador. E o `message` cru do navegador
varia por fabricante: use o `code`, que é o contrato.

---

## Referências no código deste projeto

Para quem tiver acesso a este repositório:

- `web/packages/contracts/src/index.ts:140-161` — o contrato de §3.1
- `web/apps/api/src/services/internal-inbox.service.ts:14-28` — `sendLocation` e a
  justificativa do payload; `:51` — `deliver`, o caminho comum
- `web/apps/api/src/controllers/inbox.controller.ts:22,88` — a rota e o schema
  duplicado
- `web/apps/api/src/routes/v1.ts` — `POST /inbox/conversations/:id/location`
- `web/apps/worker/src/waha-provider.ts:65-73` — o ramo `location`
- `web/apps/worker/src/waha-client.ts:103-104` — `POST /api/sendLocation`
- `web/apps/worker/src/baileys-whatsapp-worker.adapter.ts:12` e
  `demo-whatsapp-worker.adapter.ts:22` — as recusas dos outros provedores
- `web/apps/api/src/services/waha-webhook.service.ts` — `canonicalRawTypes`,
  `bodyFrom`, `mimeFrom`, `messagePreview`
- `web/apps/api/src/services/conversation-identity.ts:67` — `wahaMessageType`, a
  função de §4
- `web/apps/dashboard/src/ui/Inbox.tsx:110-126` — os três erros e
  `parseCoordinates`; `:962-990` — o painel; `:1319-1332` — a marcação
- `web/apps/dashboard/src/ui/messageMedia.ts` — `locationOf`, `mapsUrl`,
  `coordinatesLabel`, `bodyRepeatsCard`
- `web/apps/dashboard/src/ui/MessageMedia.tsx:216-232` — o cartão
- PRs #49 (contrato), #51 (envio), #55 (refinamento) e #119 (recepção)
- Os quatro incidentes de §4: PRs #34, #43, #57 e #119
- `web/docs/inbox-localizacao.md` — a descrição anterior, só do envio; atenção, a
  seção de interface é da #51 e fala em `window.prompt`, que a #55 substituiu
- `web/docs/eventos-tecnicos-residuais.md` — a contagem dos tipos técnicos, que é
  onde a família de §4 aparece do outro lado
- `web/docs/spec-editor-imagem.md` e `web/docs/spec-envio-documento.md` — as
  especificações irmãs
