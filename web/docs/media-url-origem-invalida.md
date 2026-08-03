# Mídia com origem `0.0.0.0:3000`, que o proxy recusa

**Toda mídia que chega ao vivo hoje é gravada com uma URL que o proxy se recusa
a servir.** Não é histórico: está acontecendo agora, a cada mensagem com
arquivo que entra por webhook.

A primeira versão deste documento descreveu o defeito como uma janela fechada de
91 minutos afetando 2% da mídia. Estava errado nos dois números, e a seção
[Como a primeira leitura errou](#como-a-primeira-leitura-errou) explica por quê,
porque o erro é instrutivo.

## O sintoma

`GET /api/v1/inbox/messages/:id/media` responde **400** com
`"Media URL is not a WAHA file URL"`. Para o operador é uma mídia que não abre.

O 400 vem de `WahaMediaProxyService.stream`, que compara a origem da URL
guardada com a da `WAHA_BASE_URL` e rejeita o que não bater:

```ts
if (target.origin !== base.origin || !target.pathname.startsWith('/api/files/'))
  throw new AppError(400, 'VALIDATION_ERROR', 'Media URL is not a WAHA file URL');
```

O caminho (`/api/files/…`) está certo. A origem não:

| | valor |
| --- | --- |
| origem guardada nas afetadas | `http://0.0.0.0:3000` |
| `WAHA_BASE_URL` configurada | `http://127.0.0.1:3002` |

A recusa acontece **depois** da verificação do token de acesso. Um 400 aqui não
é problema de autenticação.

## A regra, medida

O que separa as boas das ruins é **por onde a mensagem entrou**:

| origem da ingestão | URL gravada | resultado |
| --- | --- | --- |
| sincronização de histórico (o worker pergunta à WAHA em `127.0.0.1:3002`) | `http://127.0.0.1:3002/api/files/…` | abre |
| webhook ao vivo (a WAHA empurra, sem requisição de onde tirar a origem) | `http://0.0.0.0:3000/api/files/…` | **400** |

Medido em 03/08/2026, cortando pela data da mensagem — o histórico sincronizado
tem `occurred_at` antigo, o que chega ao vivo tem `occurred_at` de hoje:

| recorte | com mídia | com `0.0.0.0` |
| --- | ---: | ---: |
| anterior a hoje (veio da sincronização) | 1.886 | **0** |
| de hoje | 366 | **59** |

Zero em 1.886 de um lado. Do outro, todas as que chegaram depois que a
sincronização passou pela conversa.

E é **contínuo**. A contagem de afetadas durante uma única sessão de trabalho:

```
45  ->  50  ->  59
```

As 25 mídias mais recentes por `received_at` são todas ruins, e a última
observada tinha acabado de chegar. Não há janela: o número cresce com o tráfego.

## Como a primeira leitura errou

Vale registrar, porque as duas armadilhas se repetem.

**A porcentagem estava diluída.** «2% da mídia» é verdade e não significa nada:
o denominador inclui as 21 mil mensagens que a sincronização de histórico
acabara de trazer. Medindo só o que a ingestão ao vivo produz, o defeito atinge
**100%**. Uma taxa sobre um corpo dominado por uma carga em lote não descreve o
comportamento corrente.

**O instrumento estava errado.** A hipótese certa — webhook contra sincronização
— foi testada e dada como refutada, usando a marca `_history` do payload. Os
dois grupos vieram 100% não-históricos, e a hipótese foi descartada. O erro é
que `_history` não distingue o que se queria: a sincronização também traz
mensagens recentes, e não é isso que a marca registra. O corte que funciona é
`occurred_at`, que separa o que já existia do que chegou depois.

**E a «janela de 91 minutos» era o relógio da medição, não do defeito.** Ela ia
do fim da sincronização até a última mensagem existente naquele instante. Meia
hora depois já eram 106 minutos. Um intervalo cujo fim é «agora» não é um
intervalo — é um começo.

## Onde a URL nasce

`messageFrom`, em `apps/api/src/services/waha-webhook.service.ts`, guarda o que
veio no payload, sem reescrever:

```ts
mediaUrl: safeUrl(text(media?.url) ?? text(value.mediaUrl)),
```

Não há normalização contra `WAHA_BASE_URL` em ponto nenhum da ingestão. O que a
WAHA disser é o que fica gravado, e o proxy só descobre a incompatibilidade na
hora de servir.

Do lado da WAHA, o contêiner anuncia:

```
WHATSAPP_API_HOSTNAME=0.0.0.0
```

`0.0.0.0` é endereço de escuta, não endereço alcançável. Quando a WAHA monta a
URL a partir dele — que é o que sobra quando ela empurra um webhook, sem
requisição de entrada de onde herdar o `Host` — o resultado nunca vai bater com
a `WAHA_BASE_URL` do host.

## Correção candidata

Normalizar a origem contra a `WAHA_BASE_URL` configurada, quando o caminho for
de arquivo da WAHA. Dois lugares possíveis, e a escolha não é óbvia:

- **na escrita**, em `messageFrom`: grava já corrigido, e o proxy não muda. Mas
  congela no dado um endereço que é de ambiente, e uma `WAHA_BASE_URL` diferente
  amanhã volta a não bater.
- **na leitura**, em `WahaMediaProxyService`: grava o que veio e resolve a
  origem ao servir, o que sobrevive a mudança de ambiente e conserta as já
  gravadas de graça. Em troca, guarda no banco uma URL que nunca foi válida.

A segunda parece melhor justamente porque as 59 já gravadas passam a funcionar
sem correção de dado — e esse número cresce enquanto isto não for resolvido.

## Alcance

Enquanto durar, **nenhuma mídia recebida ao vivo abre**. Texto, remetente e
horário são gravados normalmente; o que quebra é o arquivo. O histórico
sincronizado não é afetado.
