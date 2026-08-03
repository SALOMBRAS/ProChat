# Envio de mídia com preview em tela cheia — especificação portável

Escrito para quem vai implementar o mesmo recurso em outro sistema, sem acesso a
este código. Descreve o que foi construído na PR #62 (a tela) e replantado na
PR #66 (o mesmo conteúdo, numa base que a branch principal aceitasse), por que
cada decisão foi tomada, e o que quebra se for feito sem cuidado.

Onde a decisão foi arbitrária, está escrito que foi arbitrária. Onde há número
medido, a medição está junto — e está dito **quem** mediu: a PR original, ou uma
medição refeita para escrever este documento, com a ferramenta que a produziu.
Onde não houve evidência, está escrito **não identificado**.

Vários defeitos apareceram enquanto este documento era escrito. Estão registrados
onde importam, com o sintoma que o operador veria. **Nenhum foi corrigido** — é
escopo de outra frente.

---

## 1. O que faz

O operador escolhe uma foto ou um vídeo para mandar numa conversa de WhatsApp. A
conversa **sai da tela** e dá lugar à mídia em tamanho grande, com a legenda
encostada nela e o botão de enviar ao lado. Ele olha a foto, escreve a frase,
manda. É o que o WhatsApp faz, e é o contrário do que este sistema fazia antes:
um cartão pequeno ao lado do campo de texto, com nome e tamanho — tudo menos a
imagem.

### Fluxo do ponto de vista do operador

1. Com uma conversa aberta, escolhe uma imagem ou um vídeo. Pelo menu `+`, pela
   câmera, colando ou arrastando: tanto faz.
2. A lista de mensagens e o compositor somem. No lugar entram, de cima para
   baixo: uma barra com o nome e o tamanho do arquivo e os botões **Editar**,
   **Remover** e **Fechar**; a mídia grande, centrada; e o campo de legenda com o
   botão de enviar.
3. O **cabeçalho da conversa fica**. É o que impede de perder de vista para quem
   se está mandando.
4. Em imagem, **Editar** troca o preview pelo editor de traço, texto, recorte e
   giro — que é outro componente, com especificação própria
   (`spec-editor-imagem.md`). Em vídeo o botão não aparece.
5. Escreve a legenda. **Enter envia; Shift+Enter quebra linha.**
6. **Fechar** volta à conversa descartando o anexo e **devolvendo a legenda** ao
   campo de mensagem. **Remover** joga fora as duas coisas. Os dois perguntam
   antes, e só quando há algo a perder.
7. **Esc desfaz um passo por vez**: primeiro a pergunta, depois o editor, e só
   então a tela. Esse é o desenho; §3.9 mostra que ele **não fecha** no caso em
   que há algo a perder, e que isso é defeito.

Documento e áudio **não** entram aqui. Continuam no cartão pequeno do
compositor — §3.4 diz por quê.

### O que este documento não é

Não é a especificação do envio. O que acontece depois que o operador aperta
enviar — multipart, sanitização de nome, idempotência, máquina de estados do
outbox, chamada ao provedor — está em `spec-envio-documento.md`, e **não muda por
causa desta tela**. Provar que não muda é metade do valor do desenho (§2).

---

## 2. Arquitetura

### O funil

```text
      menu "+" → seletor de arquivos ─┐
                          câmera ─────┤
             gravador de vídeo ───────┼──▶ applyAttachment(File) ──▶ [ estado ]
                colar / arrastar ─────┤                                   │
                gravador de áudio ────┘                                   │
                                                                          ▼
                                                   kind(File.type) ∈ {image, video} ?
                                                     │ sim                    │ não
                                                     ▼                        ▼
                                              [ TELA CHEIA ]          [ cartão pequeno ]
                                                     │                        │
                                                     └────────┬───────────────┘
                                                              ▼
                                                    o MESMO caminho de envio
```

Cinco origens, uma função de entrada, e a decisão de qual superfície mostrar
tomada **depois**, a partir do tipo do arquivo. Nenhuma origem sabe que a tela
existe; a tela não sabe que as origens existem.

### A fronteira da tela

O componente recebe isto, e só isto:

```ts
type AttachmentComposerProps = {
  file: File;                  // o arquivo pendente — para o nome e o tamanho na barra
  previewUrl?: string;         // um object URL, ou nada
  caption: string;
  onCaption: (value: string) => void;
  sending: boolean;
  status?: string;
  notice?: { text: string; failed: boolean };
  editor?: ReactNode;          // o painel de edição JÁ MONTADO por quem chama
  onEditorClose: () => void;
  canEdit: boolean;
  onEdit: () => void;
  dirty: boolean;              // há legenda ou traço a perder
  onClose: () => void;         // descarta o anexo, preserva a legenda
  onRemove: () => void;        // descarta os dois
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};
```

`web/apps/dashboard/src/ui/AttachmentComposer.tsx:16-40`.

O que **não** está aí é a lista inteira do que a tela ignora: não há câmera, não
há `<input type="file">`, não há área de transferência, não há endpoint, não há
`conversationId`, não há `workspaceId`, não há cliente de API. A tela recebe um
`File` e devolve eventos. Ela nem decide se deve existir — quem decide é a
condição de §3.3, fora dela.

**O editor entra como `ReactNode`, não como uma flag.** É a decisão que mais
economiza acoplamento: a tela não importa o editor, não conhece seus parâmetros,
não sabe o que é uma edição de imagem. Ela sabe apenas que, quando `editor` está
presente, ele ocupa o lugar do preview e o Esc é dele (§3.9). Trocar o editor por
outro, ou por nenhum, não toca uma linha da tela.

### Onde ela encaixa

A tela substitui **dois** elementos irmãos — a lista de mensagens e o formulário
do compositor — e nada mais:

```tsx
{stageOpen && attachment ? <AttachmentComposer … /> : <>
  <div className="message-list">…</div>
  <form className="message-composer">…</form>
</>}
```

`web/apps/dashboard/src/ui/Inbox.tsx:1256-1277`.

O cabeçalho da conversa está **acima** desse ramo (`Inbox.tsx:1223`) e por isso
sobrevive à troca. Não é acaso de marcação: é o requisito de §1.3 resolvido pela
posição do nó na árvore, sem uma linha de código a respeito.

### O que prova que o envio não muda

Três fatos, e os três são verificáveis lendo o diff:

- O `<form>` da legenda usa `name="text"` (`AttachmentComposer.tsx:110`) — o
  mesmo nome do `<textarea>` do compositor normal (`Inbox.tsx:1365`).
- `onSubmit` é ligado ao **mesmo** `submitMessage` (`Inbox.tsx:1276` e
  `Inbox.tsx:1308`).
- `submitMessage` lê o anexo do mesmo estado e chama o mesmo
  `api.sendAttachment` (`Inbox.tsx:743-746`).

Do ponto de vista do servidor, **não há como saber que a tela existe**. Nenhuma
rota, nenhum campo, nenhum contrato, nenhuma migration. É a mesma propriedade que
o editor de imagem tem, pelo mesmo motivo: a peça nova mora inteira acima da
fronteira de envio.

---

## 3. As decisões e o porquê

### 3.1 Por que o preview toma a tela em vez de virar cartão pequeno

**O problema:** o cartão anterior — que o comentário do componente descreve como
"de 40px" — mostrava um ícone, o nome do arquivo e o tamanho. Para um PDF isso é
a informação toda. Para uma foto é a única informação que não interessa: ninguém
confere um anexo de imagem pelo nome do arquivo.

**A decisão: quem anexa uma foto quer ver a foto antes de mandar, e a legenda só
faz sentido junto dela.** Está escrita no código, não só na PR:

> *O cartão de 40px ao lado do campo de texto mostrava nome e tamanho — tudo
> menos a imagem. Quem anexa uma foto quer* ver *a foto antes de mandar, e a
> legenda só faz sentido junto dela.* — `AttachmentComposer.tsx:7-10`

Três coisas concretas mudam, e vale separá-las porque só a primeira é óbvia:

1. **Conferência.** O operador vê o que vai mandar. Anexar a foto errada é o erro
   mais comum e o mais caro de desfazer num canal onde não há "apagar para
   todos" garantido.
2. **A legenda deixa de ser um segundo campo sem contexto.** Antes, a legenda era
   digitada no mesmo `<textarea>` de sempre, a poucos pixels de um cartão que não
   mostrava a imagem; a relação entre a frase e a foto existia só na cabeça de
   quem escrevia. Encostar o campo no preview torna a relação visual.
3. **Espaço para o editor.** Este é o efeito colateral que virou requisito: o
   painel de marcação foi desenhado para a faixa estreita do compositor, com
   260 px de canvas. Dentro da tela ele passa a `min(46vh, 430px)`
   (`styles.css:427`). Marcar uma foto com precisão num canvas de 260 px é
   trabalho de pinça — §3.14 fecha o assunto, e mostra que o novo tamanho tem
   problema próprio.

**A contrapartida, dita sem maquiagem:** a conversa fica invisível enquanto se
compõe. O operador não lê mensagem nova até fechar ou enviar. Foi declarado como
risco na própria PR #62 — *"a conversa fica invisível enquanto se compõe"* — e
aceito porque é o comportamento do WhatsApp. O estado continua vivo por baixo
(§3.12), então nada se perde; o que se perde é a leitura em tempo real. Se isso
incomodar no seu caso, o passo seguinte barato é um contador de não lidas na
barra da tela — **não implementado aqui**.

Uma perda menor que acompanha a decisão: **a miniatura e o botão ✎ do cartão
sumiram** para imagem. Quem clicava no lápis do cartão passa a clicar em
**Editar** na barra. O CSS da miniatura ficou para trás:
`.chat-inbox .composer-pending-thumbnail` continua declarado em
`styles.css:88` e nenhum componente emite mais essa classe. É código morto sem
sintoma, e é o rastro típico de uma troca de superfície.

### 3.2 A mesma tela serve três origens sem conhecer nenhuma

**O problema:** câmera, seletor de arquivos e colagem produzem a mesma coisa por
caminhos completamente diferentes. Se a tela soubesse de onde o arquivo veio,
teria um ramo por origem, e cada origem nova pediria alteração nela.

**A decisão: todas as origens terminam numa função só, e é ela — não a tela — que
tem o estado.**

```ts
const applyAttachment = (file?: File) => {
  setAttachment(file);
  setAttachmentSource(file);
  setAttachmentEdit(PRISTINE_EDIT);
  setEditorOpen(false);
  setIntakeMessage(undefined);
};
```

`Inbox.tsx:268`. Os cinco chamadores, com o `File` que cada um fabrica:

| Origem | Onde chama | O `File` que produz |
| --- | --- | --- |
| Seletor de arquivos (menu `+`) | `Inbox.tsx:1312` | o `File` nativo do `input`, intocado |
| Colagem e arrasto | `Inbox.tsx:292` | o `File` do `DataTransfer`, renomeado só se vier sem nome |
| Câmera — foto | `Inbox.tsx:872` | `foto-<ts>.jpg`, de `canvas.toBlob(…, "image/jpeg", 0.92)` |
| Câmera — vídeo | `Inbox.tsx:920` | `video-<ts>.webm`, de `MediaRecorder` |
| Gravador de áudio | `Inbox.tsx:813` | `audio-<ts>.<ext>`, de `MediaRecorder` |

Repare que a lista tem **cinco** entradas e a tela abre para **duas** delas mais
o seletor — porque quem decide é o tipo do arquivo, não a origem (§3.3). O
gravador de áudio chama exatamente a mesma função e simplesmente não abre a tela.
É essa indiferença que faz o desenho valer: acrescentar uma sexta origem —
arrastar de outra aba, receber por *share target*, colar de um editor externo —
custa uma chamada a `applyAttachment` e zero linhas na tela.

**O que `applyAttachment` zera importa tanto quanto o que ela põe.** As três
limpezas existem porque cada uma já foi bug em algum sistema:

- `setAttachmentEdit(PRISTINE_EDIT)` — trocar o arquivo tem de descartar a
  marcação do anterior, senão os traços de uma foto reaparecem sobre a próxima.
- `setEditorOpen(false)` — trocar o arquivo com o editor aberto o deixaria aberto
  sobre outra imagem.
- `setIntakeMessage(undefined)` — o recado de "só o primeiro foi anexado" não
  pode sobreviver ao anexo seguinte, que talvez tenha sido um só.

**Duas fabricações merecem nota**, porque são onde a origem *quase* vaza para
dentro do sistema:

- A câmera exporta **JPEG de propósito**, não porque JPEG seja melhor, mas porque
  é o que a allowlist aceita e o que a checagem de *magic bytes* espera
  (`ff d8 ff`). O comentário está em `Inbox.tsx:867-868`. A qualidade `0.92` não
  tem justificativa registrada em lugar nenhum — é herdada, não medida.
- O gravador de vídeo escolhe **webm** pelo mesmo motivo: *"webm é o que o
  MediaRecorder produz e está na allowlist do servidor; mp4 sairia da allowlist
  em boa parte dos navegadores"* (`Inbox.tsx:887-888`).

Ou seja: **a origem se adapta à allowlist, e não o contrário.** É o desenho certo,
e é o que mantém a validação num lugar só.

#### O MIME com parâmetro, e um acerto que é do transporte

O caminho do vídeo normaliza o tipo do `MediaRecorder` antes de fabricar o `File`:

```ts
const type = recorder.mimeType?.split(";", 1)[0] || "video/webm";   // Inbox.tsx:917
```

O caminho do áudio, não:

```ts
const type = recorder.mimeType || "audio/webm";                     // Inbox.tsx:811
```

O `File` do áudio nasce, portanto, com `type` valendo `audio/webm;codecs=opus`. O
servidor compara o MIME por **igualdade exata** contra a allowlist
(`attachment-outbox.service.ts:100`), e `audio/webm;codecs=opus` não está lá. Que
isso não devolva 415 hoje depende inteiramente de o parser de multipart descartar
os parâmetros antes que a aplicação veja o valor — o que ele faz, e foi
verificado executando:

```console
$ node -e "const {parseContentType}=require('busboy/lib/utils.js');
           const r=parseContentType('audio/webm;codecs=opus');
           console.log(r.type+'/'+r.subtype)"
audio/webm
```

Portanto o sistema está **certo por acidente do transporte**, não por desenho. E
o `normalizeMime` do cliente (`attachmentIntake.ts:34`) **não é o que salva**:
ele só classifica — decide a família e portanto o limite e a superfície (§3.3) —
e não reescreve o `File.type` que vai ao multipart. Quem apaga o parâmetro é o
parser, no servidor. O servidor não tem normalização própria, então
`IMAGE/PNG` ou `image/png;charset=binary` chegando por **qualquer rota que não
seja o multipart do navegador** levaria 415. É a armadilha de §7.

### 3.3 Quem abre a tela é o tipo do arquivo, e a lista é dado

```ts
const STAGE_KINDS: readonly string[] = ["image", "video"];
const stageOpen = Boolean(attachment)
  && STAGE_KINDS.includes(attachmentKind(attachment?.type) ?? "");
```

`Inbox.tsx:104` e `Inbox.tsx:273`.

Três propriedades, e as três são de propósito:

- **A decisão é derivada do MIME, não pedida por quem chamou.** A câmera não diz
  "abra a tela"; ela entrega um `image/jpeg` e a tela abre porque `image` está na
  lista. Isso é o que faz §3.2 funcionar.
- **`attachmentKind` é a mesma função da allowlist** (`attachmentIntake.ts:35-38`),
  então a lista de quem abre a tela é um subconjunto declarado da lista de quem
  pode ser enviado. Não há um segundo vocabulário de tipos para manter em
  sincronia.
- **A lista é dado, não código.** Acrescentar um terceiro tipo que mereça tela é
  uma string.

O tipo declarado é `readonly string[]` e não `readonly AttachmentKind[]`
(`Inbox.tsx:104`), o que desliga a única checagem que o compilador poderia dar de
graça: `["image", "vídeo"]` com acento passa no `typecheck` e a tela
silenciosamente para de abrir para vídeo. Uma linha, e o teste de vídeo (§3.4)
pegaria — mas o tipo certo pegaria antes.

**O caso que revela o desenho, e que é um defeito de borda.** `attachmentKind`
devolve `undefined` para qualquer coisa fora da allowlist, e `undefined ?? ""`
não está em `STAGE_KINDS`. Logo **um arquivo que o cliente não reconhece cai no
cartão pequeno** — a superfície feita para documento. Executado:

```console
image/heic                     kind=undefined  stageOpen=false
image/heif                     kind=undefined  stageOpen=false
image/gif                      kind=undefined  stageOpen=false
image/svg+xml                  kind=undefined  stageOpen=false
video/3gpp                     kind=undefined  stageOpen=false
video/quicktime                kind=undefined  stageOpen=false
image/jpeg                     kind=image      stageOpen=true
image/png                      kind=image      stageOpen=true
image/webp                     kind=image      stageOpen=true
video/mp4                      kind=video      stageOpen=true
video/webm                     kind=video      stageOpen=true
IMAGE/PNG                      kind=image      stageOpen=true
image/png;charset=binary       kind=image      stageOpen=true
```

O sintoma visível: o operador escolhe uma foto HEIC de iPhone, vê **um cartão de
documento com o nome da foto**, aperta enviar, espera o upload inteiro e recebe
415. O comentário do código diz *"Só documento e áudio chegam aqui"*
(`Inbox.tsx:1343-1344`) — e isso está **errado**: chega ali também tudo o que a
allowlist não reconhece. §3.5 explica por que esse caso não deveria ter chegado
até ali, e por que chega.

### 3.4 Documento e áudio não têm o que olhar

A justificativa está inteira no código, o que é raro e vale citar literal:

> *Documento e áudio continuam no cartão. Documento porque a prévia que daria
> para desenhar aqui é ícone, nome e tamanho — exatamente o que o cartão já
> mostra, em dez vezes a área e sem nada a mais para ver; renderizar a primeira
> página de um PDF exigiria biblioteca nova. Áudio porque o próprio WhatsApp não
> abre tela para nota de voz: ela é gravada no compositor e sai dali, e tomar a
> conversa para mostrar uma barra de reprodução acrescentaria um passo sem nada
> em troca.*
>
> — `Inbox.tsx:97-103`

Os dois argumentos são de natureza diferente, e vale separá-los porque só um
sobrevive a mudanças de contexto:

- **Documento é uma questão de conteúdo.** A tela não é recusada por princípio; é
  recusada porque não há o que mostrar nela hoje. A própria PR declara a
  condição de reversão: *"Se um dia houver miniatura de primeira página de PDF, é
  aí que documento passa a merecer a tela."* Isso é uma decisão com prazo de
  validade declarado, que é a melhor espécie.
- **Áudio é uma questão de gesto.** Uma nota de voz é gravada e mandada no mesmo
  movimento, dentro do compositor; interpor uma tela acrescenta um passo a um
  fluxo cuja graça é não ter passos. Aqui não há condição de reversão — a decisão
  não depende de tecnologia nenhuma.

> A premissa *"o próprio WhatsApp não abre tela para nota de voz"* aparece como
> afirmação no código e no corpo da PR, sem captura, medição ou referência.
> **Não identificado** se foi conferida.

**A consequência de desenho:** existem **duas** superfícies de anexo pendente, e
elas não compartilham código. O cartão é marcação inline no compositor
(`Inbox.tsx:1345-1351`); a tela é um componente. Isso é aceitável porque o que
elas têm em comum é pouco — nome, tamanho e um botão de remover — e o que têm de
diferente é tudo. Unificá-las produziria um componente com um `if` por
propriedade.

Está travado por teste nos dois sentidos: `"documento e áudio continuam no cartão
do compositor"` (`InboxAttachmentStage.test.tsx:96`) e `"vídeo abre a mesma tela,
com player em vez de imagem"` (`:90`). **O primeiro teste não faz jus ao nome:**
o corpo escolhe só um PDF (`:100`) e nunca exercita um arquivo de áudio. Se
alguém acrescentar `"audio"` a `STAGE_KINDS`, nada quebra.

#### Três conjuntos aninhados, e uma inconsistência entre dois deles

O editor não segue a mesma lista da tela:

```ts
const editableAttachment = isEditableImage(attachmentSource?.type) ? attachmentSource : undefined;
```

`Inbox.tsx:271`. Vídeo entra na tela e **não** ganha o botão Editar — travado em
`InboxAttachmentStage.test.tsx:262`. São, portanto, três conjuntos aninhados:
*enviável* ⊃ *merece tela* ⊃ *editável*. Manter os três explícitos, em vez de
derivar um do outro, é o que permite que vídeo esteja no segundo sem estar no
terceiro.

Mas os dois de dentro **normalizam o MIME de maneira diferente**, e isso é
defeito. `attachmentKind` passa por `normalizeMime`; `isEditableImage` compara
cru (`imageAnnotation.ts:144-145`). Executado:

```console
"image/png"                  attachmentKind= image     isEditableImage= true
"image/png;charset=binary"   attachmentKind= image     isEditableImage= false
"IMAGE/PNG"                  attachmentKind= image     isEditableImage= false
" image/jpeg"                attachmentKind= image     isEditableImage= false
```

O sintoma: um PNG cujo `File.type` traga um parâmetro — caso que o próprio código
declara existir, em `attachmentIntake.ts:33` — **abre a tela e não oferece o botão
Editar**. As duas listas têm os mesmos três MIMEs; o que diverge é a normalização.

### 3.5 A allowlist real — e por que o `accept` do input também importa

#### A allowlist

Para o que interessa a esta tela:

| Família | MIMEs aceitos | Limite |
| --- | --- | --- |
| `image` | `image/jpeg`, `image/png`, `image/webp` | 15 MiB |
| `video` | `video/mp4`, `video/webm` | 50 MiB |

Declarada em **três** lugares independentes, e os três **conferem** para imagem e
vídeo — o que foi verificado campo a campo:

| Lugar | Referência |
| --- | --- |
| Navegador (espelho) | `apps/dashboard/src/ui/attachmentIntake.ts:15-27` |
| Aplicação (autoridade) | `apps/api/src/services/attachment-outbox.service.ts:16-20` |
| Bucket de armazenamento | `supabase/migrations/011_inbox_outbox_attachments.sql:27-30` |

> Há uma divergência conhecida entre a aplicação e o bucket, mas ela é em
> `application/zip` — território de `spec-envio-documento.md` §5.4. Para imagem e
> vídeo as três listas são idênticas.

O espelho do navegador é **conveniência, não segurança**, e o código diz isso:
*"Repetir vale porque recusar antes de subir 8 MB de print é a diferença entre
'formato não aceito' na hora e um 415 depois da espera"* (`attachmentIntake.ts:8-10`).
O servidor valida de novo, e é o servidor que manda.

#### Os *magic bytes*

O tipo que o navegador declara num `File` **vem da extensão do arquivo**, não do
conteúdo. Um `.png` que na verdade é PDF chega declarando `image/png`. Por isso
os dois lados conferem os primeiros bytes:

| Tipo | Assinatura | Força |
| --- | --- | --- |
| JPEG | `ff d8 ff` | 3 bytes |
| PNG | `89 50 4e 47 0d 0a 1a 0a` | 8 bytes — a mais forte da tabela |
| WebP | `RIFF` no offset 0 e `WEBP` no offset 8 | 8 bytes, em dois pedaços |
| MP4 | `ftyp` no offset 4 | 4 bytes, e os **quatro primeiros ficam livres** |
| WebM | `1a 45 df a3` | 4 bytes |

Cliente em `attachmentIntake.ts:54-70`, servidor em
`attachment-outbox.service.ts:101`. Divergência: **HTTP 400**, e no servidor isso
acontece depois do upload inteiro, porque o buffer precisa estar em RAM para ser
lido.

Duas coisas a saber antes de copiar a tabela:

- **A assimetria entre 3 bytes do JPEG e 8 do PNG não tem justificativa no
  código.** É arbitrária. Não há evidência de que ela cause falso positivo entre
  os tipos desta tela — um prefixo de 3 bytes já é bastante específico —; o que
  se pode dizer é que a força da checagem varia por tipo sem que nada explique
  por quê.
- **A fraqueza real está fora desta tela, e é de outra regra.** `audio/mpeg`
  aceita qualquer arquivo cujo primeiro byte seja `0xff` — um JPEG inclusive —, e
  isso decorre exclusivamente da regra do MP3, não do prefixo curto do JPEG.
  `text/plain`, no mesmo espírito, é validado por "não contém byte zero", o que
  aceita um PDF. As duas entradas são decorativas nos dois lados.

Uma diferença deliberada entre cliente e servidor: o cliente lê **4 096 bytes**
(`HEAD_BYTES`, `attachmentIntake.ts:72`) e o servidor lê 8 192 no caso do
`text/plain`. O comentário registra a direção do erro, que é a que importa: *"Ler
menos é permissivo a mais, nunca a menos: o que escapar daqui o servidor ainda
pega"* (`attachmentIntake.ts:65-67`). Os dois números em si são arbitrários; o que
não é arbitrário é a relação entre eles (§4.3).

#### E o `accept`, que não valida nada

```ts
/** A allowlist do servidor é mais estreita que `image/*`: HEIC do iPhone e 3gpp de
 *  Android seriam recusados com 415. Pedir só o que é aceito evita que o seletor
 *  ofereça um arquivo que vai falhar depois do upload. */
const CAMERA_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/webm";
```

`Inbox.tsx:89-92`.

**A história é documentada, não hipotética.** Até a PR #50 o `accept` de
"Fotos/Vídeos" era `image/*,video/*`; o commit que o trocou (`8188052`) é o mesmo
que introduziu `CAMERA_ACCEPT`. O motivo, escrito ali e no comentário acima: com o
curinga, o seletor do iPhone **oferece HEIC**, e HEIC não está na allowlist —
então o operador escolhia uma foto que subia inteira e voltava 415.

**Mas `accept` é filtro de diálogo. Não impede nada**, por três razões
independentes:

1. O estado inicial é `undefined` (`Inbox.tsx:211`), então o atributo nem existe
   até algum item de menu ser clicado.
2. O operador pode trocar para "Todos os arquivos" no seletor do sistema
   operacional.
3. Colar e arrastar nem passam pelo `<input>`.

Está travado por teste, com a razão escrita junto: *"E pede só o que o servidor
aceita: HEIC e 3gpp seriam recusados com 415"* (`InboxCamera.test.tsx:218`), e o
tipo em si é afirmado fora da allowlist em `attachmentIntake.test.ts:50-51`.

**Dois defeitos no ciclo de vida do atributo**, ambos por leitura direta:

- `setAttachmentAccept` **nunca volta a `undefined`**. O valor do último item
  clicado persiste no input, então quem clicou "Documento" e depois arrasta uma
  foto tem um input com `accept` de documento — inofensivo, porque o arrasto não
  usa o input, mas é estado que ninguém limpa.
- O item **"Documento" não limpa `capture`** (`Inbox.tsx:1355`), ao contrário de
  "Fotos/Vídeos" (`:1356`). O `capture="environment"` só é posto no fallback da
  câmera sem `mediaDevices` (`:844`) e limpo no `onChange` (`:1312`) — então o
  resíduo sobrevive exatamente quando o operador **cancela** o diálogo, porque aí
  não há `change`. No celular, o clique seguinte em "Documento" abre a câmera em
  vez do gerenciador de arquivos.

#### A parte que não é conforto, e sim buraco

O caminho do seletor de arquivos **não valida nada no cliente**. Compare:

```ts
// colar / arrastar — Inbox.tsx:290
const verdict = await acceptAttachment(first, Date.now());
if (!verdict.ok) { setIntakeMessage({ text: verdictMessage(verdict, first), failed: true }); return; }
applyAttachment(verdict.file);

// seletor de arquivos — Inbox.tsx:1312
onChange={(event) => { applyAttachment(event.target.files?.[0]); … }}
```

`acceptAttachment` — que confere tipo, vazio, tamanho e *magic bytes* — é chamada
**exclusivamente** de `takeTransfer` (`Inbox.tsx:283-298`), o funil de colagem e
arrasto. Verificado por varredura: não há outro chamador em
`apps/dashboard/src`. A câmera também não passa por ela, mas ali é indiferente —
a câmera fabrica os bytes que declara.

Duas consequências concretas, as duas verificadas contra o `Inbox` real:

- Um **HEIC** escolhido pelo seletor é anexado sem recusa, vira cartão de
  documento (§3.3), e é enviado à API com `type = image/heic`.
- Um **executável renomeado para `.png`** — cujo `File.type` o navegador declara
  `image/png` pela extensão — **abre a tela de composição em tela cheia** como se
  fosse imagem válida. Basta o `kind`; os bytes não são consultados em lugar
  nenhum do cliente nesse caminho. Só o servidor recusa, com 400, depois do
  upload inteiro.

Todo o benefício declarado em `attachmentIntake.ts:9-10` — *"recusar antes de
subir 8 MB de print"* — **não existe** para a origem mais usada do produto.

Se você for portar, a regra que vale é: **passe todas as origens pela mesma
validação**, e trate `accept` como o que ele é — uma cortesia para o diálogo do
sistema operacional, nunca uma verificação.

### 3.6 Os limites, e onde cada um é conferido

Um arquivo encontra o tamanho **cinco** vezes entre o clique e o bucket. As
verificações, na ordem, com o que acontece ao estourar:

| # | Onde | Limite | Ao estourar |
| --- | --- | --- | --- |
| 1 | Câmera — foto, `Inbox.tsx:871` | 15 MiB | mensagem na câmera, o `File` **não** é criado |
| 2 | Câmera — vídeo, `Inbox.tsx:904` e `:919` | 50 MiB | a gravação **para sozinha** e avisa |
| 3 | Espelho de colar/arrastar, `attachmentIntake.ts:141` | por família | mensagem com o tamanho medido e o limite |
| 4 | Multer, `inbox.controller.ts:53` | 50 MiB fixos | `LIMIT_FILE_SIZE` → **413** (`middleware/errors.ts:8`) |
| 5 | Aplicação, `attachment-outbox.service.ts:100` | por família | **413** |
| 6 | Bucket, `011_inbox_outbox_attachments.sql:28` | 52428800 | erro do armazenamento; o job cai em `failed` |

Seis linhas para "cinco vezes" porque a câmera confere duas — durante e depois. E
**o caminho do seletor de arquivos não aparece em nenhuma delas antes do
multer** (§3.5): um PNG de 20 MB escolhido pelo menu `+` abre a tela sem aviso
nenhum e sobe inteiro.

**Nada sincroniza esses números.** Não há constante compartilhada entre o
navegador, a aplicação e o SQL do bucket; os valores estão escritos à mão nos
três. O que o cliente faz é reduzir três a dois: `ATTACHMENT_LIMITS`
(`Inbox.tsx:88`) deriva os limites da câmera do próprio espelho da política, com
o comentário *"O espelho de `policy` agora é um só, em attachmentIntake.ts"*.
Entre navegador e servidor a duplicação continua.

**Os números por família são arbitrários.** Não há no código nenhuma citação de
limite do WhatsApp, do WAHA ou de qualquer provedor. São política deste servidor,
sem justificativa registrada — o mesmo achado de `spec-envio-documento.md` §5.3,
reconfirmado aqui.

**O limite do multer é o do vídeo, e é isso que faz o modo de falha ser desigual:**

- Vídeo de 60 MB: morre no multer (413) **antes** de qualquer código da aplicação.
- Imagem de 40 MB: **passa** no multer — a folga entre os dois tetos é de 35 MiB —
  sobe inteira para a RAM do servidor, e só então leva 413 da política.

Isso não é bug; é a consequência aceita de ter um limite de transporte único e
limites de negócio por família. Vale saber que existe: se você quiser recusar
cedo, o limite do transporte tem de ser por família, o que exige lê-lo do
`Content-Type` antes de bufferizar.

**Três detalhes de qualidade:**

- Arquivo de **0 byte** cai no mesmo ramo do 413 no servidor (`file.size < 1` está
  na mesma condição do `> max`, `attachment-outbox.service.ts:100`) e recebe a
  mensagem *"Arquivo excede o limite permitido"* — o oposto exato do problema. O
  cliente tem a mensagem certa (*"O arquivo está vazio"*, `attachmentIntake.ts:171`),
  e não é chamado no caminho do seletor.
- **A mensagem de tamanho se contradiz na fronteira.** `fileSizeLabel`
  (`attachmentIntake.ts:40-45`) arredonda para uma casa decimal, então um arquivo
  um byte acima do teto produz: *"O arquivo tem 15.0 MB e o limite para imagem é
  15.0 MB."* O operador lê que seu arquivo tem exatamente o tamanho do limite e
  ainda assim foi recusado.
- **O gravador de áudio não confere tamanho nenhum.** Foto e vídeo conferem;
  áudio, não (`Inbox.tsx:804-816`). Não afeta esta tela, mas é a mesma família de
  omissão.

**A mensagem de recusa diz quanto deu e qual é o limite**, e isso é requisito, não
capricho:

```ts
`O arquivo tem ${fileSizeLabel(file.size)} e o limite para ${label} é ${fileSizeLabel(max)}.`
```

`attachmentIntake.ts:172-173`. "Falhou" manda o operador tentar de novo o que vai
falhar de novo.

### 3.7 A prévia é um object URL, e ele tem de ser devolvido

```ts
useEffect(() => {
  if (!attachment || !STAGE_KINDS.includes(attachmentKind(attachment.type) ?? "")) {
    setAttachmentPreview(undefined);
    return;
  }
  const url = URL.createObjectURL(attachment);
  setAttachmentPreview(url);
  return () => URL.revokeObjectURL(url);
}, [attachment]);
```

`Inbox.tsx:258`.

Três coisas nesse bloco, e nenhuma é decorativa:

- **A limpeza revoga.** Um object URL segura o `Blob` inteiro na memória até ser
  revogado ou a aba fechar. Numa sessão em que o operador olha uma foto atrás da
  outra, esquecer o `revokeObjectURL` acumula todas elas.
- **A condição repete `STAGE_KINDS`.** Documento e áudio não ganham URL, porque o
  cartão não mostra imagem. É a única duplicação da regra de §3.3, e ela existe
  para não criar URL que ninguém vai usar.
- **A dependência é `[attachment]`, não `[attachment?.name]`.** Confirmar uma
  edição troca o objeto `File` (`Inbox.tsx:1270`), e é essa troca que precisa
  regerar a prévia — o nome pode até ser o mesmo.

**Uma consequência que a leitura do código garante e que nenhum teste pega:** o
efeito roda *depois* do render. Na primeira passagem depois de escolher o
arquivo, `stageOpen` já é verdadeiro e `attachmentPreview` ainda é `undefined`,
de modo que a tela renderiza uma vez com o ramo de erro — *"Não foi possível
gerar a prévia deste arquivo."* (`AttachmentComposer.tsx:98`). Se o navegador
pintar esse quadro, o operador vê a mensagem piscar antes da foto. Um
`useLayoutEffect` fecharia a janela. **Não reproduzido em navegador** — é leitura
de código, e o jsdom não ajuda porque `URL.createObjectURL` nem existe nele e
precisa ser injetado pelo teste (`InboxAttachmentStage.test.tsx:52`).

### 3.8 Fechar e Remover diferem no que sobrevive

Duas saídas, e a diferença é exatamente uma coisa:

```ts
const closeStage  = () => clearAttachment();                          // Inbox.tsx:278
const removeStage = () => { clearAttachment(); setComposerText(""); }; // Inbox.tsx:279
```

**Fechar devolve a legenda ao compositor.** Quem digitou "segue o contrato" e
resolveu não mandar a foto ainda pode mandar a frase como texto. **Remover joga
fora as duas coisas.**

Isso só funciona porque a legenda **não é estado da tela**: ela mora em
`composerText`, o mesmo estado do `<textarea>` da conversa, e a tela a recebe
como propriedade (`caption`/`onCaption`). Se a tela guardasse a própria legenda,
"fechar preservando a frase" exigiria devolvê-la para cima na saída — e alguém
esqueceria em um dos dois caminhos.

**A confirmação só aparece quando há o que perder:**

```ts
const stageDirty = Boolean(composerText.trim()) || !isPristineEdit(attachmentEdit);  // Inbox.tsx:275
const ask = (action) => { if (sending) return; if (dirty) setPending(action); else run(action); };
```

`AttachmentComposer.tsx:52`, com o comentário certo: *"Sem nada a perder a
confirmação só atrapalharia: fechar uma tela onde não se escreveu nada tem de ser
um clique."*

Note o que **não** conta como sujo: o anexo em si. Ter escolhido uma foto e
desistir não pede confirmação — escolher outra é um clique. O que pede é o
trabalho que não se refaz num clique: a frase digitada e a marcação feita. E
`isPristineEdit` é a mesma função do editor (`spec-editor-imagem.md` §3.6), o que
significa que **girar a foto 360° em quatro cliques deixa a tela limpa de novo** —
o estado final é o original, e é o estado final que conta.

**O texto da pergunta diz o que cada botão vai custar**, em vez de perguntar
genericamente: *"Descartar o anexo? A legenda volta para o campo de mensagem."*
contra *"Descartar o anexo e a legenda?"* (`AttachmentComposer.tsx:103`). Um
"Tem certeza?" obrigaria o operador a lembrar qual botão ele apertou.

**E é aqui que o texto mente.** `stageDirty` é legenda **ou** edição, mas os dois
textos falam só de legenda. Quem desenhou sobre a foto e não escreveu nada vê
*"Descartar o anexo? A legenda volta para o campo de mensagem."* — uma frase que
descreve uma perda que não vai acontecer e omite a que vai. Nenhum dos dois textos
menciona a marcação da imagem.

### 3.9 A escada do Esc — o desenho, e por que ele não fecha

Uma tecla, três alvos possíveis, e a ordem importa:

```ts
if (pending) { setPending(undefined); return; }   // 1. a pergunta
if (editor)  { onEditorClose(); return; }         // 2. o editor
ask("close");                                     // 3. a tela
```

`AttachmentComposer.tsx:55-66`.

**A intenção: um Esc desfaz um passo.** Fechar tudo de uma vez descartaria o traço
sem perguntar — e o operador que aperta Esc para sair de um diálogo de
confirmação não está pedindo para jogar a edição fora. O terceiro degrau chama
`ask`, não `onClose`, de modo que a tecla **também** passa pela confirmação: sem
isso, a tecla mais fácil de apertar por engano seria a única saída sem rede de
proteção.

**O defeito: com algo a perder, o Esc nunca fecha.** Os degraus 1 e 3 se
alimentam. Esc → não há pergunta → `ask("close")` → está sujo → abre a pergunta.
Esc → há pergunta → fecha a pergunta. Esc → abre de novo. Não existe ramo que
chame `run()` a partir do teclado, então a confirmação só pode ser aceita com o
ponteiro. Executado sobre o componente real:

```console
✓ sem nada a perder, um Esc fecha
✓ COM legenda a perder, o Esc oscila e NUNCA fecha
  oito Esc seguidos -> pergunta -> tela -> pergunta -> tela -> pergunta -> tela -> pergunta -> tela
  onClose chamado: 0 vez(es)
```

**O segundo defeito: a confirmação não é modal.** Ela tem `role="alertdialog"`
(`AttachmentComposer.tsx:102`), mas não trava foco, não torna o resto inerte, e o
`disabled` da legenda e do botão de enviar olha só `sending` — não `pending`. Com
a pergunta *"Descartar o anexo?"* no ar, um Enter na legenda envia o anexo:

```console
✓ com a pergunta no ar, Enter na legenda ainda envia
  onSubmit com a pergunta no ar: 1 vez(es)
```

Os dois saem da mesma raiz: a confirmação foi tratada como um bloco de marcação
condicional, e não como um estado que suspende a tela. Ao portar, o conserto é o
mesmo para os dois — a pergunta desabilita a legenda e o envio, e o teclado ganha
um caminho de aceitar (Enter no botão de descarte, com foco levado para ele ao
abrir).

**Uma sutileza de implementação** que é fácil de errar: o efeito **não tem lista
de dependências** (`AttachmentComposer.tsx:66`) e por isso religa o `keydown` a
cada render. Isso é intencional — o manipulador fecha sobre `pending` e `editor`,
e uma lista errada o congelaria numa versão velha do estado. O custo é um par
`addEventListener`/`removeEventListener` por render, irrelevante nesta escala.

**Uma terceira consequência, do foco.** O `autoFocus` está na legenda
(`AttachmentComposer.tsx:118`), e o botão Editar fica `disabled` assim que o
editor abre (`:86`) — então, logo depois de abrir o editor, o foco não está
dentro dele. Na prática o caminho de teclado do editor
(`spec-editor-imagem.md` §3.16) só começa a existir depois de um clique dentro do
painel, e um Esc dado antes disso fecha o editor inteiro.

**Não travado por teste:** o terceiro degrau com confirmação pendente *e* editor
aberto ao mesmo tempo. Os testes cobrem `pergunta → tela` (`:166`) e
`editor → tela` (`:179`), separadamente — e nenhum aperta Esc duas vezes com a
tela suja, que é onde a oscilação aparece.

### 3.10 Enter envia — e só aqui

```ts
const captionKeys = (event) => {
  if (event.key !== "Enter" || event.shiftKey || sending) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
};
```

`AttachmentComposer.tsx:71-75`.

**Enter envia, Shift+Enter quebra linha — é o que o WhatsApp faz na legenda.** E
vale **só na tela**: o `<textarea>` do compositor da conversa não tem `onKeyDown`
nenhum (`Inbox.tsx:1365`), então ali Enter quebra linha. O comentário declara isso
como escolha e não como descuido: *"mudar isso é outra decisão"*
(`AttachmentComposer.tsx:69-70`).

É defensável, e vale saber por quê: legenda é uma frase curta que acompanha uma
mídia; mensagem de atendimento é texto que frequentemente tem parágrafo. Mas são
**duas regras opostas para a mesma tecla dentro da mesma tela do produto**, e isso
tem custo de aprendizado. Se você for portar, escolha uma das duas para o sistema
inteiro, ou aceite a divergência com os olhos abertos.

`requestSubmit()` e não `submit()`: o primeiro dispara `onsubmit` e a validação do
formulário, o segundo pula os dois. Com `submit()` o `onSubmit` da tela nunca
correria, e o Enter pareceria não fazer nada — sem erro no console.

O guarda `sending` na primeira linha impede o duplo envio por Enter repetido, que
é diferente do botão, já desabilitado por `disabled={sending}`
(`AttachmentComposer.tsx:121`). O que ele **não** cobre é a confirmação aberta
(§3.9).

### 3.11 Um anexo por vez, e o arrasto travado

A tela mostra **uma** mídia. Com ela aberta, os três manipuladores de arrasto
saem sem fazer nada:

```ts
const dragEnter = (event) => { if (!carriesFiles(event) || sending || stageOpen) return; … };
const dragOver  = (event) => { if (!carriesFiles(event) || sending || stageOpen) return; event.preventDefault(); };
const drop      = (event) => { if (!carriesFiles(event) || sending || stageOpen) return; … };
```

`Inbox.tsx:309`, `:312`, `:318`.

**A intenção é clara e o efeito colateral é sério.** O comentário do próprio
código, escrito para o caso sem tela, explica o que a falta de `preventDefault` no
`dragover` significa:

> *Sem `preventDefault` no dragover o navegador recusa o drop e abre o arquivo
> numa aba, jogando fora a conversa aberta.* — `Inbox.tsx:310-311`

Com a tela aberta é exatamente essa a situação: a guarda faz o `dragover` sair
antes do `preventDefault`. Pela regra que o próprio comentário enuncia, soltar um
segundo arquivo sobre a tela tende a **navegar a aba para o arquivo**, perdendo o
anexo, a legenda e a conversa. Não há manipulador global de `drop` que impeça
isso. **Não reproduzido em navegador** — o jsdom não executa a ação padrão do
arrasto; é leitura de código corroborada pelo comentário do próprio autor.

Se você portar, a guarda certa é `preventDefault` **sempre** e ignorar o arquivo
depois — "recusar" e "não impedir o navegador de agir" não são a mesma coisa.

**Colar com a tela aberta não faz nada, e por outro motivo.** Não há guarda: o
`onPaste` mora no `<form>` do compositor (`Inbox.tsx:1309`), e o compositor sai do
ar quando a tela entra. Não é uma decisão implementada, é uma consequência da
troca de árvore. Para quem portar, a diferença importa: **se a sua tela conviver
com o compositor em vez de substituí-lo, colar volta a funcionar e você vai
precisar da guarda explícita.** E como não há guarda, também não há aviso: colar
uma segunda imagem não anexa, não troca e não diz nada.

Por que um por vez: fila significa vários cartões, uma requisição por arquivo,
falha parcial e uma legenda que não se sabe a qual arquivo pertence. É trabalho
próprio, declarado fora de escopo em `attachmentIntake.ts:157-160`.

Quando vários arquivos chegam de uma vez por colagem ou arrasto, o sistema
**pega o primeiro e diz que pegou** (`extraFilesMessage`,
`attachmentIntake.ts:161-162`) — em vez de descartar em silêncio. E esse recado
teve de se mudar para dentro da tela, pelo mesmo motivo do parágrafo acima: o
lugar onde ele aparecia sai do ar exatamente quando ele precisa ser lido
(`AttachmentComposer.tsx:23-26`).

> Defeito vizinho, encontrado ao documentar: o `drop` não confere se há conversa
> selecionada (`Inbox.tsx:316-323`). Soltar um arquivo com a Inbox aberta e
> nenhuma conversa escolhida anexa em silêncio — sem cartão, sem tela, sem
> mensagem —, e o arquivo aparece ao abrir a próxima conversa.

### 3.12 A conversa continua viva por baixo

A tela troca **o que se vê**, não o que roda. `connectRealtime` é assinado num
`useEffect` do componente da Inbox (`Inbox.tsx:602-604`), completamente fora do
ramo condicional de §2 — então ele não é desmontado quando a tela entra, e as
mensagens que chegaram durante a composição estão lá na volta.

Isso é o oposto do que um desenho ingênuo faria. Montar a tela como uma rota, ou
desmontar a conversa para "economizar", produziria o comportamento que o operador
odeia: voltar de um anexo e encontrar a conversa como estava dez minutos antes,
com um piscar de recarregamento.

Há teste dirigindo o realtime de fora para provar isso —
`InboxAttachmentStage.test.tsx:271`, com o mock em `:7-8` desenhado justamente
para permitir empurrar um evento com a tela aberta.

**O que a tela suspende, e por que está certo.** `listRef` não está montado, então
`onScroll` (`Inbox.tsx:930-935`) não roda e `atBottomRef` congela no valor que
tinha ao abrir. Como `loadLatest` só é chamado quando `atBottomRef.current` é
verdadeiro (`Inbox.tsx:668`), o efeito é: quem estava no fim da conversa continua
recebendo; quem tinha rolado para cima continua não recebendo. Ou seja, **a regra
não muda** — ela apenas para de ser reavaliada, e o operador não podia rolar
nesse meio-tempo de qualquer modo. É correto, mas é correto por sorte: um
`atBottomRef` que fosse zerado em vez de congelado inverteria o comportamento sem
que nada no código da tela mudasse.

### 3.13 `minmax(0, 1fr)` na célula do preview

Esta é a decisão que **não saiu de teste nenhum**. Saiu de olhar a tela.

```css
.chat-inbox .attachment-stage {
  flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
}
.chat-inbox .attachment-stage-preview {
  flex: 1 1 auto; min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  place-items: center; padding: 18px; overflow: hidden;
}
.chat-inbox .attachment-stage-media {
  max-width: 100%; max-height: 100%; border-radius: 14px; object-fit: contain;
}
```

`styles.css:397`, `:411`, `:412`.

**O bug.** Com `display: grid` e uma trilha de mínimo automático — `auto`, ou
`1fr`, que é `minmax(auto, 1fr)` — a linha é dimensionada pelo conteúdo. Aí o
`max-height: 100%` da imagem tenta resolver contra uma altura que depende da
própria imagem. A dependência é circular, a porcentagem é ignorada, e a imagem
renderiza no tamanho natural. Uma foto alta estoura a área.

`minmax(0, 1fr)` dá mínimo zero à trilha, e a partir daí a altura da célula não
depende mais do conteúdo: a porcentagem tem contra o que resolver.

#### A medição original, e o que ela não diz

A PR #62 registra: **636 px de conteúdo dentro de 587 px de área.** O par de
números aparece mais duas vezes no repositório — no comentário do teste
(`InboxAttachmentStage.test.tsx:300`) e, agora, aqui — sempre repetido, nunca
acompanhado de viewport, dimensão da foto ou método. **Não é reproduzível como
publicado.**

E há um detalhe que explica por quê: **o estado anterior à correção nunca foi
commitado.** O commit que introduz `.attachment-stage-preview` já a traz com
`minmax(0, 1fr)` nas duas direções. O bug existiu na árvore de trabalho do autor,
foi medido lá, e o que chegou ao repositório foi só o conserto. É honesto e é
comum; só não permite conferir o número.

#### A medição refeita

Reproduzida para escrever este documento em **Chrome headless local** (permitido
pelo `CLAUDE.md` deste projeto; a extensão do Chrome conectada, não), com as
regras reais de `styles.css`, uma coluna de 900×720 px e imagens sintéticas.
Cada linha remove ou troca **uma** propriedade:

```text
propriedade mexida            foto alta 400×1200      pequena 120×90    panorâmica 6000×300
                              célula  img    vaza     célula  img       célula  img
(nenhuma — as regras reais)    523   162×487    0       523  120×90      523  864×43
rows: minmax(0,1fr) → 1fr      523   400×1200 695      523  120×90      523  864×43
cols: minmax(0,1fr) → 1fr      523   162×487    0       523  120×90      523  864×43
célula: sem min-height: 0      523   162×487    0       523  120×90      523  864×43
célula: sem overflow: hidden   523   162×487    0       523  120×90      523  864×43
célula: sem NENHUM dos dois   1236   400×1200   0       523  120×90      523  864×43
PAI .attachment-stage: sem
  min-height: 0               1236   400×1200   0       523  120×90      523  864×43
célula: flex 1 1 → 0 1         523   162×487    0       126  120×90       79  864×43
place-items: center → stretch  523   864×487    0       523  864×487     523  864×487
display: grid → block          523   162×487    0       523  120×90      523  864×43
mídia: sem max-height: 100%    523   400×1200 677       523  120×90      523  864×43
mídia: sem max-width: 100%     523   162×487    0       523  120×90      523 6000×300
mídia: object-fit → fill       523   162×487    0       523  120×90      523  864×43
```

Sete leituras que a medição original não dava:

1. **Quem conserta é a declaração das LINHAS.** Trocar só as colunas por `1fr` não
   muda nada, em nenhuma das três fotos. O comentário do código diz que
   `minmax(0, 1fr)` *"nas duas direções"* é o que dá área definida à célula
   (`styles.css:408-410`) — para o bug observado, isso **superestima** a metade
   das colunas. Ela não custa nada e protege o caso simétrico se a largura do
   container um dia deixar de ser definida; mas não é ela que conserta o que foi
   visto na tela.
2. **O bug só morde foto alta.** A imagem larga e a panorâmica nunca estouram,
   porque a largura do container é definida pelo *stretch* da coluna flex e a
   porcentagem sempre resolve. É por isso que esse defeito atravessa uma revisão:
   se a foto de teste for larga, tudo parece certo — exatamente o mesmo formato
   de armadilha que `spec-editor-imagem.md` §3.11 descreve para o ponteiro da
   caneta.
3. **`min-height: 0` e `overflow: hidden` na célula são redundantes entre si.**
   Qualquer um dos dois zera o mínimo automático do item flex; só removendo **os
   dois** a célula cresce para 1236 px. Já o `min-height: 0` do **pai**
   `.attachment-stage` é *load-bearing* sozinho — ali não há `overflow` para fazer
   o mesmo trabalho.
4. **`max-height: 100%` na mídia é indispensável**, mesmo com a célula consertada:
   sem ele a foto alta volta ao natural e vaza 677 px.
5. **`max-width: 100%` também morde** — só que num caso que ninguém testa: a
   panorâmica de 6000 px sai em tamanho natural e é cortada pelo `overflow`. É a
   contraparte horizontal do item 4.
6. **`place-items: center` não é cosmético.** Trocado por `stretch`, a caixa da
   mídia é esticada a 864×487 em todos os casos. A imagem continua parecendo
   certa — e é aí que **`object-fit: contain` finalmente serve para alguma
   coisa**: com a centralização no lugar, ele é medida-por-medida um no-op; sem
   ela, é o que impede a foto de deformar. Os dois são seguro um do outro.
7. **`display: grid` não é o conserto — é a origem do problema.** Com `block` não
   há estouro nenhum, e `minmax` deixa de fazer sentido. O grid foi escolhido pela
   centralização em duas direções numa linha; `minmax(0, 1fr)` é o preço dessa
   escolha.

#### Onde a correção não alcança

No ramo de largura ≤ 760 px o `minmax(0, 1fr)` **não faz diferença nenhuma**: a
cadeia que daria altura definida à tela se rompe antes dela. O CSS empacotado põe
`.inbox-layout { min-height: auto }` e `.inbox-history { min-height: 420px }`
nessa faixa, de modo que a altura passa a ser dirigida pelo conteúdo. Uma foto em
retrato faz a própria `.attachment-stage` crescer além da janela e leva o botão
de enviar para baixo da dobra.

Isto foi **medido num arranjo separado que reproduz a cadeia de CSS real, não no
aplicativo em execução**, e **não foi conferido em tela** — o `CLAUDE.md` deste
projeto proíbe a extensão do Chrome conectada, e a conferência visual fica para o
usuário. Registre como suspeita forte, não como fato observado no produto.

#### O que o teste prende, e o que ele deixa passar

**Nenhum teste de DOM pega o layout** — o jsdom não faz layout (ele lê a cascata
corretamente e devolve zero em toda medida). O que dá para prender é o texto da
regra, e é o que se faz:

```ts
expect(stylesheet).toMatch(
  /\.chat-inbox \.attachment-stage-preview\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
```

`InboxAttachmentStage.test.tsx:301`, com a medição original anotada logo acima.
Vale a pena — impede que alguém "simplifique" `minmax(0, 1fr)` para `1fr` numa
limpeza de CSS, que é exatamente como esse bug volta. Mas é preciso saber o
tamanho da rede:

- **Pega:** a troca das linhas por `1fr`, e a remoção do `object-fit: contain`.
- **Não pega:** a remoção do `max-height: 100%` da mídia, a remoção do par
  `min-height: 0` / `overflow: hidden`, a remoção do `min-height: 0` do pai, e a
  troca das colunas — isto é, **três das cinco propriedades que a medição mostrou
  serem load-bearing**.
- **Falso positivo:** o regex casa texto, então `minmax(0,1fr)` sem espaço e
  `minmax(0px, 1fr)` — semanticamente idênticos — derrubam a suíte. Um
  formatador de CSS que minifique a folha quebra o teste sem mudar o layout.

Uma asserção sobre texto de folha de estilo é sempre isso: barata, frágil, e
melhor que nada. Se você for portar, **prenda a lista inteira de propriedades
load-bearing**, não uma delas.

### 3.14 O editor herda o espaço que a tela criou

O painel de marcação foi desenhado para a faixa estreita do compositor, com
`--editor-max: 260px` (`styles.css:324`), e 210 px no ramo móvel (`:380`). Dentro
da tela ele recebe outro valor:

```css
.chat-inbox .attachment-stage-preview .composer-editor       { order: 0; width: min(720px, 100%); }
.chat-inbox .attachment-stage-preview .composer-editor-frame { --editor-max: min(46vh, 430px); }
```

`styles.css:423` e `:427`, com o comentário: *"deixá-lo com 260px de canvas
desperdiçaria o espaço que justifica esta tela"*.

Duas propriedades do desenho que valem copiar:

- **O ajuste é uma variável, não uma prop.** A tela não passa tamanho ao editor;
  ela escreve `--editor-max` no escopo em que ele vive. O editor continua sem
  saber onde está montado, que é a propriedade que o torna reusável
  (`spec-editor-imagem.md` §3.11 explica por que o teto tem de estar na moldura e
  não no canvas).
- **`46vh` e não uma altura fixa.** A tela ocupa a altura da conversa, que varia;
  amarrar o canvas a pixels faria a barra de ferramentas do editor sair da vista
  em telas baixas.

O editor entra **no lugar** do preview, não sobre ele (`AttachmentComposer.tsx:93`:
`{editor ?? (previewUrl ? … )}`). É o que garante que não haja duas renderizações
da mesma imagem divergindo — o mesmo argumento de `spec-editor-imagem.md` §3.14
sobre o campo de texto flutuante, aplicado um nível acima.

**Os três números são calibração a olho.** `46vh`, `430px` e `720px` não têm
derivação em código, comentário, teste ou PR. E há indício de que a calibração
ficou grande demais: o painel inteiro — moldura mais barra de ferramentas mais
botões — pode passar da altura da célula do preview em resoluções comuns
(1280×720, 1366×768, 1440×900), e o `overflow: hidden` da linha 411 o cortaria
**sem barra de rolagem**, deixando Cancelar e Concluir fora da vista.

Isto foi medido num arranjo que remonta o painel a partir do JSX, **não com o
componente React real**, e **não foi conferido em tela**. É o achado deste
documento que mais precisa de confirmação visual antes de virar tarefa — mas é
concreto o bastante para ser olhado: a variável está presa a `vh` e a célula que
a contém está presa à altura da conversa menos a barra e a legenda, e as duas
contas não se conhecem.

---

## 4. O algoritmo da admissão

Não há aqui a matemática que o editor de imagem tem. O que há é uma **escada de
decisão**, e o valor de escrevê-la é que a ordem dos degraus é observável: ela
determina qual erro o operador vê quando o arquivo é ruim de mais de uma maneira.

### 4.1 Do arquivo à superfície

```
função admitir(arquivo, origem):

    # 1. Fabricação, quando a origem não entrega um File pronto.
    #    A origem se adapta à allowlist: a câmera exporta JPEG e o gravador
    #    exporta WebM porque é o que a allowlist aceita — não o contrário.
    se origem é câmera-foto:    arquivo ← jpeg(canvas), nome "foto-<ts>.jpg"
    se origem é câmera-vídeo:   arquivo ← webm(gravador), nome "video-<ts>.webm"
    se origem é gravador-áudio: arquivo ← webm/ogg, nome "audio-<ts>.<ext>"
    se origem é colagem e o arquivo veio sem nome:
                                arquivo ← renomear "colada-<ts>.<ext>"

    # 2. Validação. HOJE só as origens de transferência passam por aqui,
    #    e isso é o defeito de §3.5. O certo é passar TODAS.
    se origem é colagem ou arrasto:
        tipo ← kind(arquivo.tipo)              # deriva do MIME, nunca do cliente
        se não tipo:                           devolva recusa("type")
        se arquivo.tamanho == 0:               devolva recusa("empty")
        se arquivo.tamanho > limite[tipo]:     devolva recusa("size")
        cabeça ← primeiros 4096 bytes
        se não assinaturaBate(arquivo.tipo, cabeça): devolva recusa("bytes")

    # 3. O funil. Zera a marcação anterior, fecha o editor, limpa o recado.
    aplicarAnexo(arquivo)

    # 4. A superfície, decidida pelo TIPO e não por quem chamou.
    se kind(arquivo.tipo) ∈ {imagem, vídeo}:  tela cheia
    senão:                                    cartão pequeno
```

O passo 4 consulta **só o tipo declarado**. Nada nele olha bytes — é por isso que
um executável renomeado para `.png` abre a tela cheia (§3.5): quando o passo 2 é
pulado, o passo 4 não tem como saber.

### 4.2 A ordem dos degraus é observável

No servidor a mesma escada existe, e a ordem produz códigos diferentes para o
mesmo arquivo:

```
tipo fora da allowlist          → 415
tamanho fora da faixa (ou zero) → 413
assinatura divergente           → 400
```

`attachment-outbox.service.ts:100`.

Como o **tipo** é conferido antes do **tamanho**, um PDF de 30 MB renomeado para
`.png` recebe 415 (tipo), não 413 (tamanho) — e nunca chega ao 400 da assinatura.
Isso é escolha, e é a escolha certa: o erro mais específico é o que o operador
consegue agir sobre.

Mas há um degrau **antes** de todos, e é ele que embaralha: o multer bufferiza
com um teto de 50 MiB e devolve 413 sem consultar família nenhuma. Então:

| Arquivo | Erro | Vindo de |
| --- | --- | --- |
| HEIC de 3 MB | 415 | política |
| HEIC de 60 MB | 413 | multer, antes de qualquer código |
| PNG de 20 MB | 413 | política, depois de subir 20 MB |
| PNG de 20 MB renomeado de PDF | 413 | política — o tamanho barra antes da assinatura |
| PDF de 1 MB renomeado para `.png` | 400 | assinatura |
| qualquer coisa de 0 byte | 413, "excede o limite" | política — a mensagem é errada (§3.6) |

A quarta linha é a que engana: o arquivo é inválido por dois motivos e o operador
recebe a mensagem de tamanho. Não é erro; é a ordem escolhida, e vale ser
conhecida quando alguém reclamar de "mensagem errada".

### 4.3 O espelho só pode errar para o lado permissivo

A regra que governa qualquer validação duplicada entre cliente e servidor:

```
recusas(cliente) ⊆ recusas(servidor)
```

O cliente pode deixar passar o que o servidor vai recusar — o custo é um upload
perdido. O cliente **não pode** recusar o que o servidor aceitaria: aí o operador
fica preso sem recurso e sem entender por quê, e nenhuma mensagem de erro ajuda,
porque o arquivo dele estava certo.

É por isso que ler 4 KB de cabeça no cliente contra 8 KB no servidor está certo
(`attachmentIntake.ts:65-67`), e por isso qualquer aperto de regra tem de começar
pelo servidor.

O espelho deste sistema hoje falha **para o lado seguro**, e falha muito: como o
caminho do seletor não valida (§3.5), `recusas(cliente)` é vazio para a origem
mais usada. Nada quebra; tudo fica lento e mal explicado.

---

## 5. Implementação de referência

### 5.1 O núcleo portável

```ts
/* ─── A política. Allowlist, e o tipo é DERIVADO do MIME. ─────────────────── */
export const ATTACHMENT_POLICY = {
  image: { mimes: ["image/jpeg", "image/png", "image/webp"], max: 15 * 1024 * 1024 },
  audio: { mimes: ["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm"], max: 25 * 1024 * 1024 },
  video: { mimes: ["video/mp4", "video/webm"], max: 50 * 1024 * 1024 },
  document: { mimes: ["application/pdf", "text/plain", /* … */], max: 25 * 1024 * 1024 },
} as const;
export type AttachmentKind = keyof typeof ATTACHMENT_POLICY;

/** `image/png;charset=binary` e `IMAGE/PNG` são o mesmo tipo para a allowlist.
 *  Normalize em TODO lugar que compare mime — inclusive no servidor, e inclusive
 *  na lista de quem pode ser editado (§3.2 e §3.4). */
export const normalizeMime = (mime?: string | null) =>
  (mime ?? "").split(";", 1)[0].trim().toLowerCase();

export const attachmentKind = (mime?: string | null): AttachmentKind | undefined => {
  const normalized = normalizeMime(mime);
  return (Object.keys(ATTACHMENT_POLICY) as AttachmentKind[])
    .find((kind) => (ATTACHMENT_POLICY[kind].mimes as readonly string[]).includes(normalized));
};

/** §3.3 — quem merece a tela. Dado, não código; e subconjunto declarado da
 *  allowlist, para não haver um segundo vocabulário de tipos a manter.
 *  Tipe como AttachmentKind[], não string[]: é a única checagem grátis que existe. */
export const STAGE_KINDS: readonly AttachmentKind[] = ["image", "video"];
export const opensStage = (mime?: string | null) => {
  const kind = attachmentKind(mime);
  return Boolean(kind) && STAGE_KINDS.includes(kind!);
};

/** §3.5 — filtro do diálogo do sistema operacional. NÃO é validação: o operador
 *  pode escolher "Todos os arquivos", e colar/arrastar nem passa pelo input.
 *  Existe para o seletor do iPhone não oferecer HEIC, que levaria 415 DEPOIS do
 *  upload inteiro. Escreva mimes, nunca `image/*`. */
export const MEDIA_ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/webm";

/* ─── §3.5: magic bytes. O tipo declarado num File vem da EXTENSÃO. ───────── */
export const HEAD_BYTES = 4096;
const ascii = (head: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...head.subarray(from, to));
const opens = (head: Uint8Array, bytes: number[]) =>
  bytes.every((byte, index) => head[index] === byte);

export const magicMatches = (mime: string, head: Uint8Array): boolean => {
  const t = normalizeMime(mime);
  if (t === "image/jpeg") return opens(head, [0xff, 0xd8, 0xff]);
  if (t === "image/png")  return opens(head, [137, 80, 78, 71, 13, 10, 26, 10]);
  if (t === "image/webp") return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP";
  if (t === "video/mp4")  return ascii(head, 4, 8) === "ftyp";
  if (t === "video/webm") return opens(head, [0x1a, 0x45, 0xdf, 0xa3]);
  /* … as demais famílias … */
  return false;
};

/** `Blob.arrayBuffer()` não existe em Safari antigo nem no jsdom; `FileReader`
 *  existe nos dois. Lê só a cabeça: o resto do arquivo não interessa. */
export const readHead = (file: Blob, bytes = HEAD_BYTES) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("leitura falhou"));
    reader.readAsArrayBuffer(file.slice(0, bytes));
  });

export type IntakeVerdict =
  | { ok: true;  kind: AttachmentKind; file: File }
  | { ok: false; reason: "type" | "size" | "empty" | "bytes"; kind?: AttachmentKind };

/** §4.1 — a escada. TODAS as origens devem passar por aqui; neste sistema só
 *  colagem e arrasto passam, e isso é o defeito de §3.5. */
export const acceptAttachment = async (file: File, at = 0): Promise<IntakeVerdict> => {
  const kind = attachmentKind(file.type);
  if (!kind) return { ok: false, reason: "type" };
  if (!file.size) return { ok: false, reason: "empty", kind };
  if (file.size > ATTACHMENT_POLICY[kind].max) return { ok: false, reason: "size", kind };
  let head: Uint8Array;
  try { head = await readHead(file); } catch { return { ok: false, reason: "bytes", kind }; }
  if (!magicMatches(file.type, head)) return { ok: false, reason: "bytes", kind };
  const name = intakeName(file, at);
  // Quando o nome já existe, devolve o File ORIGINAL sem cópia: reconstruir por
  // hábito é a primeira oportunidade de perder metadados.
  return { ok: true, kind, file: name === file.name ? file : new File([file], name, { type: file.type }) };
};

/** §3.6 — a recusa diz quanto deu e qual é o limite. "Falhou" manda o operador
 *  tentar de novo o que vai falhar de novo. Arredonde para BAIXO o tamanho e para
 *  CIMA o limite, senão a frase vira "tem 15.0 MB e o limite é 15.0 MB". */
export const verdictMessage = (v: Extract<IntakeVerdict, { ok: false }>, file: File): string =>
  v.reason === "type"  ? `Formato não aceito: ${normalizeMime(file.type)}.`
: v.reason === "empty" ? "O arquivo está vazio."
: v.reason === "size"  ? `O arquivo tem ${fileSizeLabel(file.size)} e o limite para `
                       + `${KIND_LABEL[v.kind!]} é ${fileSizeLabel(ATTACHMENT_POLICY[v.kind!].max)}.`
:                        `O conteúdo não corresponde a ${normalizeMime(file.type)}. `
                       + `O arquivo pode estar corrompido ou com a extensão trocada.`;
```

### 5.2 O funil e a troca de superfície

```tsx
/** §3.2 — ponto único por onde um anexo entra ou sai. O que ele ZERA importa
 *  tanto quanto o que ele põe. */
const applyAttachment = (file?: File) => {
  setAttachment(file);
  setAttachmentSource(file);          // o original, para o editor não empilhar perda
  setAttachmentEdit(PRISTINE_EDIT);   // senão o traço de uma foto reaparece na próxima
  setEditorOpen(false);               // senão o editor fica aberto sobre outra imagem
  setIntakeMessage(undefined);        // senão o recado sobrevive ao anexo seguinte
};

/** §3.7 — a prévia é um object URL, e ele TEM de ser devolvido. */
useEffect(() => {
  if (!attachment || !opensStage(attachment.type)) { setPreview(undefined); return; }
  const url = URL.createObjectURL(attachment);
  setPreview(url);
  return () => URL.revokeObjectURL(url);
}, [attachment]);

const stageOpen  = Boolean(attachment) && opensStage(attachment?.type);
/** §3.8 — o que se perde ao descartar. O anexo em si NÃO conta: escolher outro é
 *  um clique. Conta o que não se refaz num clique. */
const stageDirty = Boolean(caption.trim()) || !isPristineEdit(attachmentEdit);

/* §2 — a tela substitui DOIS irmãos. O cabeçalho está acima e sobrevive. */
{stageOpen && attachment ? (
  <AttachmentComposer
    file={attachment}
    previewUrl={preview}
    caption={caption} onCaption={setCaption}
    canEdit={Boolean(editableAttachment)}
    onEdit={() => setEditorOpen(true)}
    /* §2 — o editor entra montado, como nó. A tela não o importa. */
    editor={editorOpen && editableAttachment
      ? <ImageAnnotator file={editableAttachment} initialEdit={attachmentEdit}
          onCancel={() => setEditorOpen(false)}
          onConfirm={(edited, edit) => { setAttachment(edited); setAttachmentEdit(edit); setEditorOpen(false); }} />
      : undefined}
    onEditorClose={() => setEditorOpen(false)}
    dirty={stageDirty}
    onClose={() => clearAttachment()}                      // a legenda sobrevive
    onRemove={() => { clearAttachment(); setCaption(""); }} // a legenda vai junto
    onSubmit={(event) => void submitMessage(event)}        // §2 — o MESMO submit
  />
) : (
  <>
    <div className="message-list">…</div>
    <form className="message-composer" onPaste={pasteIntoComposer}>…</form>
  </>
)}
```

E a tela em si, com o que decide cada peça. **As marcas `← §3.9` apontam o que
este sistema faz errado e a referência mostra corrigido:**

```tsx
export function AttachmentComposer({ file, previewUrl, caption, onCaption, sending,
  notice, editor, onEditorClose, canEdit, onEdit, dirty, onClose, onRemove, onSubmit }) {
  const [pending, setPending] = useState<"close" | "remove">();
  const discardRef = useRef<HTMLButtonElement>(null);
  const run  = (a) => (a === "remove" ? onRemove : onClose)();
  // §3.8 — sem nada a perder a confirmação só atrapalharia.
  const ask  = (a) => { if (sending) return; if (dirty) setPending(a); else run(a); };
  // §3.9 — a pergunta SUSPENDE a tela. Sem isto, Enter na legenda envia o anexo
  // com "Descartar?" no ar.  ← este sistema não faz
  const busy = sending || Boolean(pending);

  // §3.9 — um Esc desfaz UM passo. Sem lista de dependências de propósito: o
  // manipulador fecha sobre `pending` e `editor`, e congelá-lo quebraria a escada.
  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      if (pending) { setPending(undefined); return; }
      if (editor)  { onEditorClose(); return; }
      ask("close");                       // passa pela confirmação, como o botão
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // §3.9 — o teclado precisa de um caminho para ACEITAR o descarte, senão o Esc
  // só oscila entre abrir e fechar a pergunta.  ← este sistema não faz
  useEffect(() => { if (pending) queueMicrotask(() => discardRef.current?.focus()); }, [pending]);

  // §3.10 — Enter envia, Shift+Enter quebra linha. `requestSubmit`, não `submit`:
  // o segundo pula o onsubmit e a validação.
  const captionKeys = (event) => {
    if (event.key !== "Enter" || event.shiftKey || busy) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const video = file.type.startsWith("video/");
  return (
    <div className="attachment-stage" role="region" aria-label="Compor anexo">
      <div className="attachment-stage-bar">{/* nome, tamanho, Editar, Remover, Fechar */}</div>
      {notice && <p role={notice.failed ? "alert" : "status"}>{notice.text}</p>}
      <div className="attachment-stage-preview">
        {/* §3.14 — o editor entra NO LUGAR do preview, nunca sobre ele. */}
        {editor ?? (previewUrl
          ? video ? <video className="attachment-stage-media" src={previewUrl} controls playsInline />
                  : <img   className="attachment-stage-media" src={previewUrl} alt={`Prévia de ${file.name}`} />
          : <p className="attachment-stage-empty">Não foi possível gerar a prévia deste arquivo.</p>)}
      </div>
      {pending && (
        <div role="alertdialog" aria-modal="true" aria-label="Confirmar descarte">
          {/* §3.8 — o texto diz o que ESTE botão vai custar. E tem de nomear a
              MARCAÇÃO também, não só a legenda.  ← este sistema só fala da legenda */}
          <p>{pending === "remove" ? "Descartar o anexo e a legenda?"
                                   : "Descartar o anexo? A legenda volta para o campo de mensagem."}</p>
          <button onClick={() => setPending(undefined)}>Cancelar</button>
          <button ref={discardRef} onClick={() => { const a = pending; setPending(undefined); a && run(a); }}>
            {pending === "remove" ? "Descartar tudo" : "Descartar anexo"}
          </button>
        </div>
      )}
      {/* §2 — mesmo `name`, mesmo submit: o servidor não sabe que esta tela existe. */}
      <form className="attachment-stage-composer" onSubmit={onSubmit}>
        <textarea name="text" value={caption} onChange={(e) => onCaption(e.target.value)}
                  onKeyDown={captionKeys} aria-label="Legenda do anexo"
                  maxLength={4096} disabled={busy} autoFocus />
        <button className="send-button" disabled={busy}>{sending ? "…" : "➤"}</button>
      </form>
    </div>
  );
}
```

CSS mínimo. As anotações vêm da medição de §3.13: **load-bearing** significa que
removê-la mudou um número medido.

```css
/* A tela ocupa a altura restante e empilha barra / preview / legenda. */
.attachment-stage {
  flex: 1 1 auto;
  min-height: 0;          /* LOAD-BEARING: sem ele a célula vai a 1236px */
  display: flex; flex-direction: column;
}
.attachment-stage-bar,
.attachment-stage-composer { flex: 0 0 auto; }

.attachment-stage-preview {
  flex: 1 1 auto;         /* LOAD-BEARING só para mídia pequena: sem ele a área colapsa */
  min-height: 0;          /* redundante com o overflow abaixo — um dos dois basta */
  display: grid;          /* é o grid que CRIA o problema; block não teria */
  grid-template-rows: minmax(0, 1fr);     /* LOAD-BEARING: é este que conserta */
  grid-template-columns: minmax(0, 1fr);  /* sem efeito medido; seguro barato */
  place-items: center;    /* LOAD-BEARING: `stretch` deforma a caixa da mídia */
  overflow: hidden;       /* redundante com o min-height acima — um dos dois basta */
}
.attachment-stage-media {
  max-width: 100%;        /* LOAD-BEARING para imagem mais larga que a célula */
  max-height: 100%;       /* LOAD-BEARING: sem ele a foto alta volta ao natural */
  object-fit: contain;    /* seguro do place-items: só age se a centralização sair */
}

/* §3.14 — o ajuste do editor é uma VARIÁVEL no escopo, não uma prop: ele
   continua sem saber onde está montado. Confira se o painel INTEIRO cabe na
   célula: o `overflow: hidden` acima corta sem barra de rolagem. */
.attachment-stage-preview .composer-editor       { width: min(720px, 100%); }
.attachment-stage-preview .composer-editor-frame { --editor-max: min(46vh, 430px); }
```

### 5.3 O que é específico deste projeto

Não copie sem trocar:

| Item | Por que é específico |
| --- | --- |
| **Limites 15/25/50 MiB** | Política deste servidor. Não vieram do WhatsApp nem do provedor; são escolha sem justificativa registrada (§3.6). |
| **Allowlist `jpeg/png/webp` e `mp4/webm`** | É o que o servidor daqui aceita. O que vale manter é que seja allowlist com *magic bytes*, e que o `accept` do input a espelhe (§3.5). |
| **`STAGE_KINDS = ["image", "video"]`** | A lista é dado. Se o seu produto tiver visualizador de PDF, documento entra; se não tiver, a justificativa de §3.4 vale igual. |
| **`--editor-max: min(46vh, 430px)` e `width: min(720px, 100%)`** | Calibração a olho, sem derivação registrada — e com indício de que não cabe (§3.14). |
| **Enter enviando só na legenda** | Divergência deliberada com o compositor da conversa (§3.10). Escolha uma regra para o produto inteiro, ou aceite a divergência de olhos abertos. |
| **`0.92` na exportação da foto da câmera** | Herdado do editor de imagem, que por sua vez o herdou da captura. Não medido. |
| **`4096` bytes de cabeça** | Arbitrário. O que importa é a regra de §4.3: ler menos que o servidor é permissivo a mais, e permissivo a mais é o lado seguro. |
| **`maxLength={4096}` na legenda** | Limite local, não é o do WhatsApp. |
| **Nomes `foto-<ts>.jpg`, `video-<ts>.webm`, `colada-<ts>.<ext>`** | Convenção local. O que vale manter é que a câmera **não tem nome de origem a preservar** e portanto precisa fabricar um. |
| **A paleta e as classes `.chat-inbox …`** | Marcação e tema deste produto. |
| **Textos em português** | Estão em toda parte. |
| **Substituir a conversa em vez de abrir modal** | Escolha de apresentação. O componente funciona igual num modal ou numa gaveta — o que ele exige é **área**, e é a área que justifica §3.1. |
| **A guarda `stageOpen` só no arrasto** | Consequência de a tela substituir o compositor (§3.11). Numa tela que conviva com o compositor, colar volta a funcionar e precisa de guarda própria. |
| **O ramo móvel (≤ 760 px)** | A cadeia de altura deste layout se rompe ali e a correção de §3.13 fica inerte. Confira a sua. |

Portável sem alteração: a fronteira de props de §2, o funil `applyAttachment` com
as três limpezas, a derivação da superfície a partir do MIME (§3.3), a escada de
`acceptAttachment` e a ordem de seus degraus (§4), a regra do espelho permissivo
(§4.3), o ciclo do object URL (§3.7), a distinção fechar/remover com confirmação
condicional (§3.8), a escada do Esc **com os dois consertos de §3.9**, e as
anotações de load-bearing das regras CSS de §5.2.

### 5.4 O que a rede de testes não segura

A tela tem 17 testes (`InboxAttachmentStage.test.tsx`), e eles são bons no que
cobrem: a troca de superfície por tipo, as duas saídas, a legenda chegando ao
envio, o editor vindo da barra, e o realtime por baixo. A PR #62 declara ter
conferido a cobertura por reversão.

O que segue foi **medido do mesmo jeito, para esta especificação**: aplicar a
mutação na produção e rodar os 465 testes do dashboard. Cada linha abaixo é uma
mutação que **não derruba nenhum teste** — e portanto um comportamento que este
documento descreve e a suíte não protege:

| Mutação aplicada | Testes que quebram |
| --- | --- |
| Remover `return () => URL.revokeObjectURL(url)` do efeito da prévia (§3.7) | **0 de 465** |
| Remover o `autoFocus` do campo de legenda | **0 de 465** |

Outras lacunas do mesmo tipo, todas verificáveis pelo mesmo método: o guarda de
tamanho da foto da câmera (§3.6), o ramo de prévia indisponível e o atributo
`controls` do `<video>` (§3.7), o `maxLength` da legenda e seu acoplamento com o
schema do servidor, o Esc fechando a tela **limpa** — apesar de o teste `:166` se
chamar *"Esc fecha a tela"*, o que ele exercita é a tela suja —, e o
comportamento de colar com a tela aberta (§3.11).

E há dois buracos estruturais que nenhuma mutação revela:

- **O fim a fim para no `InboxApi` mockado.** Quatro testes levam um `File` real
  da entrada da tela até `api.sendAttachment`, e ali param. Nada afirma que o que
  sai da tela chega ao servidor — é a mesma costura não testada que
  `spec-envio-documento.md` §8 registra para o nome do arquivo.
- **O layout não é testado em lugar nenhum**, porque o jsdom não faz layout
  (§3.13). As três propriedades load-bearing que o teste de estilo não prende
  ficam sem qualquer rede.

Se você for portar e quiser escolher poucos testes, escolha estes três: um por
origem passando pela mesma validação (§3.5), o Esc na tela suja (§3.9), e um de
ponta a ponta que não pare no mock.

---

## 6. O que não está incluído

Cada item abaixo ficou de fora por ser trabalho próprio, não por descuido.

**Vários anexos de uma vez.** A tela mostra uma mídia. Fila significa vários
cartões, uma requisição por arquivo com um `clientRequestId` cada, falha parcial,
e a pergunta de a qual arquivo a legenda pertence — que não tem resposta óbvia.
O sistema pega o primeiro e **diz que pegou**, o que é o mínimo aceitável.

**Recorte pela tela, e não pelo editor.** O recorte existe, mas dentro do editor
(`spec-editor-imagem.md` §3.8). Oferecê-lo na barra da tela seria uma segunda
porta para a mesma função.

**Miniatura de primeira página de PDF.** É a condição declarada para documento
merecer a tela (§3.4). Exige biblioteca nova, o que estava fora do escopo da PR.

**Contador de não lidas na barra.** O antídoto declarado para o risco de §3.1 — a
conversa invisível durante a composição. O estado já está lá (§3.12); o que falta
é mostrá-lo.

**Prévia de vídeo com poster.** O `<video>` recebe `controls` e mais nada: o
primeiro quadro aparece quando o navegador decide, e até lá a área fica preta. Um
`poster` extraído do primeiro quadro por canvas resolveria, e custa uma
decodificação.

**Edição de vídeo.** Aparar, silenciar, extrair quadro. Estruturalmente é outro
problema — o editor de imagem trabalha com um canvas e uma lista de objetos, e
vídeo não cabe nesse modelo.

**Validação unificada das origens.** Não é recurso novo: é fechar o buraco de
§3.5, fazendo o caminho do seletor passar por `acceptAttachment` como colar e
arrastar já passam. Está fora deste documento porque **documentar não é
corrigir** — mas é a menor mudança com maior retorno desta lista.

---

## 7. Armadilhas

Em ordem aproximada de quanto tempo custam quando aparecem.

**Foto alta estourando a área com barra de rolagem.** §3.13. Só aparece com foto
**alta** — com foto larga tudo parece certo, porque `max-width: 100%` continua
funcionando e é só o `max-height` que é ignorado. **Nenhum teste de DOM pega**: o
jsdom não faz layout. Se você "simplificar" `minmax(0, 1fr)` para `1fr` numa
limpeza de CSS, ele volta inteiro — e o teste que existe pega **essa** mutação e
deixa passar outras três igualmente fatais.

**O Esc que nunca fecha.** §3.9. Com legenda escrita ou traço feito, Esc oscila
entre abrir e fechar a confirmação, para sempre. A escada parece certa lendo — o
defeito só aparece apertando a tecla **duas vezes** com a tela suja, que é a
sequência que ninguém escreve por acaso. Verificado executando.

**A confirmação que não suspende nada.** §3.9. `role="alertdialog"` é semântica,
não comportamento: com a pergunta *"Descartar o anexo?"* no ar, um Enter na
legenda envia o anexo. O `disabled` da legenda e do botão olha `sending` e esquece
`pending`. Verificado executando.

**Uma origem validando e a outra não.** §3.5. Colar e arrastar passam por tipo,
tamanho e *magic bytes*; o seletor de arquivos passa direto. Um executável
renomeado para `.png` **abre a tela cheia** como se fosse foto. A causa é fácil de
não ver porque o código de validação **existe** — só não é chamado de todo lugar.
Ao portar, ligue todas as origens à mesma escada, e escreva um teste por origem.

**O arquivo que a allowlist não conhece virando cartão de documento.** §3.3. Um
HEIC de iPhone tem `kind` indefinido, não abre a tela, e aparece como se fosse um
PDF — com o nome de uma foto. O comentário do código que diz *"Só documento e
áudio chegam aqui"* está errado, e é o tipo de comentário que faz alguém procurar
o bug no lugar errado.

**`image/*` no `accept`.** §3.5. Parece a coisa óbvia e é a que produz o 415
tardio: o seletor do iPhone passa a oferecer HEIC. Escrever a lista exata é feio e
é o que evita o problema. Mas **não confunda com validação** — `accept` é filtro
de diálogo, o operador pode desligá-lo, e ele nem existe até alguém clicar um item
de menu.

**O arrasto "barrado" que na verdade navega a aba.** §3.11. Sair do `dragover` sem
`preventDefault` não recusa o drop: deixa o navegador agir, e a ação padrão é
abrir o arquivo — levando embora a conversa, o anexo e a legenda. O próprio código
documenta isso, para o outro caso. Recuse **depois** do `preventDefault`, nunca
antes dele.

**O espelho de validação recusando o que o servidor aceitaria.** §4.3. É a
inversão do erro anterior e é pior: o operador tem um arquivo legítimo e o sistema
não deixa mandar, sem que nenhuma mensagem faça sentido. Toda vez que apertar a
regra, aperte o servidor primeiro.

**O MIME com parâmetro batendo contra uma comparação exata.** §3.2. O gravador de
áudio produz `audio/webm;codecs=opus`, o servidor compara MIME por igualdade, e a
única razão de isso não dar 415 é o parser de multipart descartar os parâmetros
antes. Verificado executando. É um acerto por acidente do transporte: troque o
parser, ou receba o arquivo por outra rota — JSON com base64, por exemplo — e todo
vídeo e todo áudio gravado no navegador começa a levar 415.

**Duas listas do mesmo conjunto normalizando diferente.** §3.4. `attachmentKind`
normaliza o MIME e `isEditableImage` não. As duas têm os mesmos três tipos, e
mesmo assim um `image/png;charset=binary` abre a tela e não ganha o botão Editar.
Quando o mesmo conjunto é declarado em dois lugares, o que diverge não é a lista —
é o pré-processamento.

**O object URL não revogado.** §3.7. Cada prévia segura o `Blob` inteiro em
memória até ser revogada. Uma sessão de atendimento com dezenas de fotos acumula
todas. Não dá erro, não aparece em teste, e o sintoma é a aba ficando pesada — que
ninguém associa a anexos.

**A prévia de erro piscando antes da foto.** §3.7. O efeito que cria o object URL
roda depois do render, então a tela renderiza uma vez com *"Não foi possível gerar
a prévia deste arquivo."*. É leitura de código, **não reproduzido em navegador**.

**Guardar a legenda dentro da tela.** §3.8. Parece o desenho natural — a legenda é
da tela, afinal —, e destrói a distinção entre Fechar e Remover: para preservar a
frase, a tela teria de devolvê-la para cima na saída, e alguém vai esquecer em um
dos dois caminhos. Manter a legenda no estado do compositor faz "Fechar preserva"
ser o comportamento padrão, sem código.

**A confirmação que promete o que não vai perder.** §3.8. `dirty` é legenda **ou**
marcação, e os dois textos só falam de legenda. Quem desenhou e não escreveu lê
uma frase sobre a legenda voltar ao campo — e perde o desenho. Se a condição é uma
disjunção, o texto tem de ser também.

**A edição sobrevivendo à troca de anexo.** Se o funil não zerar `attachmentEdit`,
o traço de uma foto reaparece sobre a próxima. É estado de **fora** do editor,
então nenhum teste do editor pega — a mesma armadilha que `spec-editor-imagem.md`
§7 registra do outro lado da fronteira.

**`submit()` em vez de `requestSubmit()`.** §3.10. `submit()` não dispara
`onsubmit`, então o `onSubmit` da tela nunca corre e o Enter parece não fazer
nada — sem erro no console.

**A tela desmontando o realtime.** §3.12. Montar a composição como rota, ou
desmontar a conversa "para economizar", faz o operador voltar de um anexo e
encontrar a conversa parada, com um piscar de recarregamento. O antídoto é
estrutural: troque só o ramo visual, deixe as assinaturas onde estão.

**O foco que nunca entra no painel do editor.** §3.9. O `autoFocus` fica na
legenda e o botão Editar vira `disabled` ao abrir o editor, de modo que o caminho
de teclado do editor só existe depois de um clique dentro dele — e um Esc antes
disso fecha o painel inteiro.

**A guarda de colar que não existe.** §3.11. Aqui colar com a tela aberta não faz
nada porque o `onPaste` mora no compositor, que saiu do ar. É acidente feliz da
troca de árvore, não decisão implementada. Numa tela que conviva com o compositor
— modal, gaveta — a colagem volta a funcionar e troca o anexo por baixo da legenda
que já estava escrita.

**Imagem de 40 MB subindo inteira para ser recusada.** §3.6. O teto do transporte
é o do vídeo, então há 35 MiB de folga em que uma imagem é bufferizada antes de a
política por família opinar. É consequência aceita, não bug — mas é o que faz "por
que demorou tanto para dizer que era grande demais?" ter uma resposta.

**Arquivo de 0 byte recebendo "excede o limite".** §3.6. Vazio e grande demais
compartilham o mesmo ramo no servidor. O cliente tem a mensagem certa e não é
chamado no caminho do seletor.

**A mensagem de tamanho que se contradiz.** §3.6. Uma casa decimal faz um arquivo
um byte acima do teto virar *"tem 15.0 MB e o limite é 15.0 MB"*. Arredonde o
tamanho para baixo e o limite para cima, ou mostre bytes na fronteira.

**O `capture` que sobra.** §3.5. Posto pelo fallback da câmera e limpo só no
`onChange`, ele sobrevive quando o operador **cancela** o diálogo — e o clique
seguinte em "Documento", que não o limpa, abre a câmera no celular.

**O comentário que superestima a correção.** §3.13. `styles.css:408-410` afirma
que `minmax(0, 1fr)` "nas duas direções" é o que dá área definida à célula; a
medição mostra que só a declaração das **linhas** muda o resultado observado. Não
é defeito de comportamento — o CSS está certo —, mas quem ler o comentário ao
portar vai procurar no lugar errado se mexer nelas.

**O teste que casa texto de CSS.** §3.13. Ele quebra com `minmax(0,1fr)` sem
espaço e com `minmax(0px, 1fr)`, que são a mesma coisa; e não quebra quando alguém
apaga o `max-height: 100%` da mídia, que é fatal. Uma asserção sobre folha de
estilo é barata e frágil — prenda a lista inteira de propriedades load-bearing, e
saiba que ainda assim não é layout.

**O nome do teste que promete mais do que exerce.** §3.4 e §5.4. `"documento e
áudio continuam no cartão do compositor"` só escolhe um PDF; `"Esc fecha a tela"`
só exercita a tela suja, que é justamente o caso em que o Esc **não** fecha. Um
nome de teste com dois substantivos precisa de duas asserções — e um nome que
descreve o caso geral não pode cobrir só o particular.

**A limpeza que nenhum teste cobra.** §5.4. Remover o `revokeObjectURL` do efeito
da prévia passa nos 465 testes do dashboard; remover o `autoFocus` da legenda,
também. Medido por reversão. Comportamento sem teste não é comportamento sem
importância — é comportamento que o próximo refactor apaga sem que ninguém veja.

---

## Referências no código deste projeto

Para quem tiver acesso a este repositório:

- `web/apps/dashboard/src/ui/AttachmentComposer.tsx` — a tela inteira, em 125 linhas
- `web/apps/dashboard/src/ui/Inbox.tsx` — `STAGE_KINDS`, `applyAttachment`,
  `stageOpen`/`stageDirty`, o ciclo do object URL, as cinco origens e as guardas
  de arrasto
- `web/apps/dashboard/src/ui/attachmentIntake.ts` — a política, `attachmentKind`,
  `magicMatches` e a escada de `acceptAttachment`
- `web/apps/dashboard/src/ui/imageAnnotation.ts:144` — `isEditableImage`, a lista
  que não normaliza (§3.4)
- `web/apps/dashboard/src/ui/styles.css:393-437` — as regras da tela, incluindo o
  `minmax(0, 1fr)` de §3.13
- `web/apps/dashboard/src/ui/InboxAttachmentStage.test.tsx` — os 17 testes da tela
- `web/apps/dashboard/src/ui/InboxCamera.test.tsx` e `InboxPaste.test.tsx` — as
  origens
- `web/apps/api/src/services/attachment-outbox.service.ts` — a política do
  servidor, `validateFile` e `magicMatches`
- `web/apps/api/src/controllers/inbox.controller.ts:53` — o multer
- `web/apps/api/src/middleware/errors.ts:8` — o mapa de `MulterError` para 413/400
- `web/supabase/migrations/011_inbox_outbox_attachments.sql:27-30` — o bucket
- PR #62 (a tela), PR #66 (o replantio que a levou à branch principal) e PR #50
  (o commit `8188052`, que trocou `image/*` pela lista exata do `accept`)
- `web/docs/spec-editor-imagem.md` — o editor que esta tela hospeda
- `web/docs/spec-envio-documento.md` — o caminho de envio que esta tela **não**
  altera, e a outra superfície de anexo pendente
