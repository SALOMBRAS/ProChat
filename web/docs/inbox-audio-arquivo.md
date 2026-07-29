# Áudio como arquivo de música, distinto de nota de voz

O WhatsApp trata uma nota de voz (PTT, com forma de onda) e um arquivo de áudio
(uma faixa, com nome) de formas diferentes. O ChatPro não distinguia nenhum dos
dois lados: todo envio de `audio` saía como nota, e toda recepção era gravada
como `audio`.

Este documento registra o que foi medido, o desenho escolhido e o que ele não
faz. Onde faltou evidência está escrito **não identificado**.

## 1. Qual endpoint envia áudio como arquivo

Sondagem da instância local (`2026.7.1`, engine `WEBJS`, tier `CORE`) pelo mesmo
método de `waha-capacidades-anexos.md`: POST com o nome de sessão inexistente
`probe-nonexistent-session-do-not-create`. **Nenhuma mensagem foi enviada a
ninguém** — a sessão real do workspace nunca foi usada.

Controles executados na mesma rodada:

| requisição | HTTP | veredito |
| --- | --- | --- |
| `POST /api/sendText` (controle positivo) | 422 | rota existe |
| `POST /api/sendDefinitelyNotARealEndpoint` (controle negativo) | 404 | rota não existe |

Resultado:

| endpoint | HTTP | veredito |
| --- | --- | --- |
| `/api/sendVoice` | 422 | **existe** — é o PTT |
| `/api/sendFile` | 422 | **existe** — é o único caminho para arquivo |
| `/api/sendAudio` | 404 | não existe |
| `/api/sendPtt` | 404 | não existe |
| `/api/sendMedia` | 404 | não existe |
| `/api/sendDocument` | 404 | não existe |
| `/api/sendAudioFile` | 404 | não existe |

**Não há endpoint dedicado a arquivo de áudio.** Um mp3 sai pela mesma rota que
um documento, `/api/sendFile`; o que separa os dois casos é a rota escolhida, não
um campo. `convert`, que transcodifica para o OPUS que a nota exige, deixa de ser
enviado no caminho de arquivo — mandá-lo desfaria justamente o envio da faixa
como ela é.

Isto prova roteamento, não autorização: uma chamada com sessão real não foi feita,
por decisão de segurança desta etapa. **Tier CORE vs PLUS: não identificado.**

## 2. Como a intenção do operador chega ao worker

Escolha: **um campo no caminho de anexo existente**, `voiceNote`, e não
`message.sendContent`.

Por quê:

- Um arquivo de áudio **é um arquivo**. O outbox já entrega idempotência por
  `clientRequestId`, allowlist de MIME, limite de tamanho, checagem de magic
  bytes, upload em bucket privado, URL assinada de 300 s, máquina de estados,
  cancelamento, reconciliação de startup e limpeza do objeto temporário. Passar
  um mp3 de 25 MB por `message.sendContent` significaria reconstruir tudo isso.
- `message.sendContent` existe para o que **não é** texto nem arquivo —
  coordenadas, cartão de contato, enquete. Usá-lo aqui apagaria a razão de ele
  existir.
- A intenção é um bit e muda só a rota, não o formato do payload.

Caminho completo:

```text
dashboard api.sendAttachment(..., voiceNote)
  → multipart voiceNote=false
  → InboxController.createAttachment (zod aceita boolean OU "true"/"false")
  → AttachmentOutboxService.create(..., voiceNote)
  → dispatch(context, id, voiceNote)
  → comando message.sendContent? NÃO — message.sendAttachment { ..., voiceNote }
  → WahaProvider.sendAttachment (repassa o objeto inteiro)
  → WahaHttpClient: voiceNote !== false ? /api/sendVoice + convert : /api/sendFile
```

### Por que não é uma coluna, e por que não é um quinto tipo

`inbox_outbox_jobs.type` é guardado por
`CHECK (type IN ('image','audio','video','document'))` **nos dois bancos**
(`apps/api/migrations/010`, `supabase/migrations/011`). Um quinto tipo de anexo —
ou uma coluna nova — custaria migration em cada um. O tipo continua `audio`; o
que muda é a rota.

A intenção viaja **em memória**, de `create` para `dispatch`, e isso é correto
porque o despacho é único: `dispatch` é privado, `create` é o seu único chamador,
ele roda uma vez sobre a linha que acabou de escrever, e nada reproduz uma linha
gravada depois — `reconcileStartup` resolve o que encontra para
`cancelled`/`failed` em vez de reenviar.

**Se algum dia existir retry que redespacha uma linha persistida, isto precisa
virar coluna antes.** O SQL abaixo fica registrado para esse caso; **não foi
aplicado e não deve ser aplicado agora** — hoje ele não é necessário.

```sql
-- NÃO APLICAR. Só faz sentido junto de um retry que redespacha linha gravada.
-- SQLite  (web/apps/api/migrations/)
ALTER TABLE inbox_outbox_jobs ADD COLUMN voiceNote INTEGER;
-- Supabase (web/supabase/migrations/)
ALTER TABLE public.inbox_outbox_jobs ADD COLUMN IF NOT EXISTS voice_note boolean NULL;
```

### O padrão escolhido para o default

`voiceNote` é opcional. **Ausente significa nota de voz**, que é o que o gravador
do compositor sempre produziu — um chamador que não diz nada mantém o
comportamento que tinha. Só um `false` explícito pede arquivo.

## 3. Recepção: distinguir PTT de arquivo

**Não exige migration.** `messageType` (SQLite, `migrations/002`) e
`message_type` (Supabase, `migrations/002`) são `TEXT NOT NULL` **sem CHECK** nos
dois bancos, e `messagePreview` já tinha `case 'ptt'` e `case 'voice'` — ramos
inalcançáveis até agora.

A distinção **já chegava no payload e nunca era lida**. Consulta somente-leitura à
base de produção, 6.825 mensagens:

| sinal | linhas |
| --- | ---: |
| `_data.type = 'ptt'`, gravadas como `audio` | 114 |
| `_data.type = 'audio'`, gravadas como `audio` | 2 |
| `type` na raiz do payload | 0 de 116 |

WAHA/WEBJS não põe `type` na raiz. `messageFrom` já calculava `wahaMessageType`
(que lê `_data.type`) para identidade e filtro de evento técnico, mas entregava
a `mediaType` apenas `value.type` — a raiz, vazia. Sem tipo, a classificação caía
no mime, e `audio/ogg` virava `audio` para os dois casos.

### A regra é deliberadamente estreita

Passar `wahaMessageType` inteiro para `mediaType` seria a correção óbvia e estaria
errada. Medido sobre as mesmas 6.825 linhas, adotar o vocabulário cru
reclassificaria **5.846 delas (86%)**:

| viraria | linhas |
| --- | ---: |
| `text` → `chat` | 3.855 |
| `document` → `image` | 806 |
| `text` → `call_log` | 259 |
| `document` → `ptt` | 224 |
| `text` → `e2e_notification` | 142 |
| `audio` → `ptt` | 114 |
| … mais 25 formas, incluindo `gp2`, `revoked`, `sticker` | 446 |

A regra aplicada consulta o tipo cru para **uma** decisão e nunca o devolve como
está: quando o tipo normalizado já é `audio` e o cru é `ptt` ou `voice`, grava
`ptt`. Efeito medido: **114 de 6.825 linhas (1,7%)**, todas `audio → ptt`.

Não há backfill. As 116 linhas existentes continuam `audio`; reescrevê-las seria
migração de dados e precisa de aprovação à parte.

## 4. Renderização

Mínima, para validar o caminho: o player passa a dizer `Mensagem de voz` ou
`Arquivo de áudio` no `aria-label`, o glifo muda, e o arquivo mostra o nome —
que a nota não tem. `ptt` foi acrescentado ao roteamento do player, senão cairia
no cartão de documento.

Nenhuma classe CSS nova foi criada: o nome do arquivo usa `<small>`, que o
navegador estiliza sozinho. **O refinamento visual — forma de onda contra linha
de faixa — é do terminal 2.** O compositor e o menu `+` não foram tocados; o
acionamento fica exposto em `api.sendAttachment(..., voiceNote)`.

## 5. O teste que fixava o comportamento antigo

`apps/worker/test/waha-client.test.ts` tinha a linha:

```ts
['audio', 'audio/mpeg', '/api/sendVoice', { convert: true }],
```

Ela **afirmava um invariante**: áudio sempre vira nota de voz. Esse invariante era
o próprio defeito — um mp3 saía como nota e o operador não tinha como dizer
outra coisa, porque a rota era função do mimetype.

A linha foi mantida, com `voiceNote` indefinido, e agora **afirma um default**:
um anexo que não declara intenção continua saindo como nota. As linhas em volta
são a intenção — o mesmo mimetype chegando a rotas diferentes. Nada foi apagado.

`convert` é afirmado **ausente** no caminho de arquivo, e `voiceNote` não aparece
em nenhum corpo esperado: é palavra nossa, não da WAHA, e o `toEqual` exato é o
que impede o vazamento para o provedor.

## Paridade SQLite × Supabase

Nenhum schema mudou. `message_type`/`messageType` é texto livre sem CHECK nos
dois, `payload_json`/`payloadJson` continua entregue como `metadata` pelo leitor,
e o outbox grava `type = 'audio'` como sempre gravou. O envio de anexo continua
exigindo `DATABASE_PROVIDER=supabase` para o storage, como antes desta mudança.

## Riscos

- **Nada foi validado contra a WAHA com sessão real.** Que `/api/sendFile` aceite
  `audio/mpeg` e que o WhatsApp mostre a faixa como faixa está apoiado na
  documentação e no roteamento, não em envio observado — **não identificado**.
- Mensagens novas de nota de voz passam a gravar `ptt`. Qualquer consulta externa
  que filtre `message_type = 'audio'` para achar notas de voz passa a não achá-las.
  Dentro do repositório os dois consumidores já tratavam `ptt`
  (`whatsapp-media-persistence.service.ts`, `messagePreview`).
- As 224 linhas com `_data.type = 'ptt'` gravadas como `document` continuam
  `document`: são notas de voz cuja classificação se perdeu por falta de mime, um
  problema anterior e distinto deste. Não foram tocadas.

## Como reverter

Reverter o commit desfaz tudo: não há migration aplicada, coluna nova, dado
reescrito nem endpoint novo. Envios voltam a sair por `/api/sendVoice` e a
recepção volta a gravar `audio`; as linhas gravadas como `ptt` no intervalo
permanecem, e `messagePreview` já sabe lê-las.
