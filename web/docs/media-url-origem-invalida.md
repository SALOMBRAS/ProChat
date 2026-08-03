# Mídia com origem `0.0.0.0:3000`, que o proxy recusa

Achado por acidente em 03/08/2026, verificando outra coisa: parte das mensagens
guarda uma `media_url` que o proxy de mídia se recusa a servir. Este documento
registra **o que foi medido**, separa isso do que ainda é hipótese, e aponta
onde a correção provavelmente mora. Nada foi corrigido.

## O sintoma

`GET /api/v1/inbox/messages/:id/media` responde **400** com
`"Media URL is not a WAHA file URL"`. Para o operador isso é uma mídia que não
abre.

O 400 vem de `WahaMediaProxyService.stream`, que compara a origem da URL
guardada com a da `WAHA_BASE_URL` configurada e rejeita o que não bater:

```ts
if (target.origin !== base.origin || !target.pathname.startsWith('/api/files/'))
  throw new AppError(400, 'VALIDATION_ERROR', 'Media URL is not a WAHA file URL');
```

O caminho está certo (`/api/files/…`). O que não bate é a origem:

| | valor |
| --- | --- |
| origem guardada nas afetadas | `http://0.0.0.0:3000` |
| `WAHA_BASE_URL` configurada | `http://127.0.0.1:3002` |

Vale notar que a recusa acontece **depois** da verificação do token de acesso.
Um 400 aqui não é problema de autenticação.

## O que foi medido

Contagem exata contra a base, em 03/08/2026:

| | mensagens | |
| --- | ---: | ---: |
| com `media_url` preenchida | 2.238 | 100% |
| origem `http://127.0.0.1:3002` | 2.193 | 98,0% |
| origem `http://0.0.0.0:3000` | **45** | **2,0%** |
| qualquer outra origem | 0 | 0% |

Das 45 afetadas:

- **janela**: de `2026-08-03T16:36:24` a `2026-08-03T18:07:21` — 91 minutos, tudo
  no mesmo dia. Não é um problema difuso ao longo do histórico.
- **conversas distintas**: 7
- **tipos**: 33 `image/jpeg`, 9 `audio/ogg; codecs=opus`, 2 `video/mp4`,
  1 `image/webp`

## Onde a URL nasce

`messageFrom`, em `apps/api/src/services/waha-webhook.service.ts`, guarda o que
veio no payload, sem reescrever:

```ts
mediaUrl: safeUrl(text(media?.url) ?? text(value.mediaUrl)),
```

Não há normalização contra `WAHA_BASE_URL` em ponto nenhum do caminho de
ingestão. Ou seja: **o que a WAHA disser é o que fica gravado**, e o proxy
descobre a incompatibilidade só na hora de servir, muito depois.

Do lado da WAHA, o contêiner anuncia:

```
WHATSAPP_API_HOSTNAME=0.0.0.0
```

`0.0.0.0` é endereço de escuta, não endereço alcançável. Uma URL construída a
partir dele nunca vai bater com a `WAHA_BASE_URL` do host.

## Uma hipótese que foi testada e NÃO se sustentou

A explicação natural seria: as mensagens que chegam por **webhook** (a WAHA
empurra, sem requisição de entrada de onde tirar o `Host`) cairiam no hostname
configurado, enquanto as lidas pela **sincronização de histórico** (o worker
pergunta em `127.0.0.1:3002`) herdariam a origem certa.

Medido, e não é isso. Classificando pelo `_history` do payload:

| grupo | histórico | ao vivo |
| --- | ---: | ---: |
| as 45 com `0.0.0.0` | 0 | 45 |
| 300 corretas, para comparar | 0 | 300 |

Os dois grupos são inteiramente não-históricos, então essa divisão não separa
nada. A hipótese fica **em aberto**.

O que decidiria: comparar, para duas mensagens vizinhas no tempo — uma de cada
grupo —, o `payload_json` bruto, procurando o que difere na forma como a WAHA
montou a URL. A amostra de 300 usada acima também não foi ordenada, então pode
não representar o corpo todo das corretas; uma repetição vale ordenar por
`occurred_at` e cobrir a mesma janela de 91 minutos.

## Correção candidata

Normalizar na ingestão, num lugar só: em `messageFrom`, reescrever a origem da
`media_url` para a `WAHA_BASE_URL` configurada quando o caminho for de arquivo
da WAHA. Isso resolve as futuras e mantém o proxy como está.

Duas ressalvas para quem for fazer:

- as 45 já gravadas não se consertam sozinhas; precisam de correção de dado à
  parte, e a janela estreita torna isso barato;
- a `WAHA_BASE_URL` pode mudar entre ambientes, então normalizar na **leitura**
  (no proxy) em vez de na escrita é a alternativa a considerar — grava o que
  veio, resolve a origem na hora de servir. As duas são defensáveis; a escolha
  depende de a URL gravada valer como registro histórico ou como ponteiro.

## Alcance

2% da mídia, numa janela de 91 minutos de um dia. Não bloqueia a operação e não
perde mensagem: o texto, o remetente e o horário estão gravados; só o arquivo
não abre. Foi registrado em vez de corrigido porque apareceu no meio de uma
rotação de credenciais, e misturar as duas coisas ia atrapalhar as duas.
