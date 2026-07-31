# Envio de documento com nome preservado — especificação portável

Escrito para quem vai implementar o mesmo recurso em outro sistema, sem acesso a
este código. O problema concreto que motivou o documento: um CRM que envia todo
documento com o nome genérico `documento`, e precisa descobrir em qual dos doze
saltos entre o seletor de arquivos e a API do WhatsApp o nome se perdeu.

Onde a decisão foi arbitrária, está escrito que foi arbitrária. Onde há número
medido, a medição está junto. Onde não houve evidência, está escrito
**não identificado** — inclusive sobre partes deste próprio sistema.

---

## 1. O que faz

O operador anexa um documento a uma conversa de WhatsApp e o contato recebe o
arquivo **com o nome que o operador via no computador dele** — `Contrato de
Prestação 2026.pdf`, não `documento` nem `arquivo.pdf`. É a diferença entre um
anexo que a pessoa do outro lado consegue arquivar e um que ela precisa abrir
para descobrir o que é.

Do ponto de vista do operador: clica no `+`, escolhe **Documento**, o seletor do
sistema operacional abre filtrado, ele escolhe o arquivo, escreve uma legenda
opcional e envia. O cartão aparece na conversa com o nome e o tamanho. Nada no
caminho pede que ele confirme ou digite o nome — ele nunca é perguntado, porque
o nome já veio junto do arquivo.

**O recurso é inteiro sobre não perder uma string.** Não há transformação de
conteúdo, não há decisão de produto: o nome entra num ponto e precisa sair
idêntico no outro. Toda a dificuldade está em que ele atravessa cinco processos
— navegador, HTTP multipart, aplicação, armazenamento de objetos, provedor —
e cada fronteira tem um jeito próprio de descartá-lo em silêncio.

---

## 2. O caminho completo do nome

Este é o coração do documento. O nome do arquivo é uma string que atravessa doze
saltos. Em cada um, ou ela é preservada, ou é reescrita, ou desaparece.

```text
[1] input.files[0].name                (navegador: File nativo)
     ↓  preservado
[2] intakeName / acceptAttachment      (fallback se vier vazio)
     ↓  preservado, ou "colada-<ts>.<ext>"
[3] FormData.set('file', file)         (o nome vem de File.name)
     ↓  preservado
[4] fetch sem content-type             (o navegador escreve o boundary)
     ↓  preservado, em Content-Disposition
[5] multer → file.originalname         (decodifica como latin1 ⚠)
     ↓  MOJIBAKE se o nome tinha acento
[6] sanitizeFilename(originalname)     (NFKD, allowlist, corte, fallback)
     ↓  REESCRITO — o único ponto de reescrita do servidor
[7] path = ws/conv/jobId/<filename>    (o nome vira chave de objeto)
     ↓  preservado
[8] INSERT inbox_outbox_jobs.filename  (coluna TEXT, nullable)
     ↓  preservado
[9] payload.filename do comando        (contrato Zod, min 1 max 255)
     ↓  preservado — ou dispatch aborta em silêncio se for nulo
[10] worker: remapeamento campo a campo (cópia manual)
     ↓  preservado
[11] POST /api/sendFile                (file: { url, mimetype, filename })
     ↓  preservado
[12] o contato vê o nome no WhatsApp
```

### 2.1 No navegador

Há **um único** `<input type="file">` no sistema inteiro, compartilhado por todas
as opções do menu de anexo. O que muda entre "Documento" e "Fotos/Vídeos" é
apenas o atributo `accept`, que é filtro de diálogo e **não toca em nada** —
nem nos bytes, nem no nome:

```tsx
onClick={() => {
  setAttachmentAccept(".pdf,.doc,.docx,.xls,.xlsx,.txt");
  attachmentInputRef.current?.click();
}}
```

São cinco pontos de entrada de arquivo: seletor, colagem, arrasto-e-solta,
câmera e gravador de áudio. Só os três primeiros aceitam documento; câmera e
gravador produzem sempre mídia e **não têm nome de origem para preservar** —
fabricam `foto-<ts>.jpg`, `video-<ts>.webm`, `audio-<ts>.<ext>`.

O único ponto de reescrita no navegador trata o arquivo que chega **sem nome**,
que é o caso da colagem de um print:

```ts
export const intakeName = (file: File, at: number) =>
  file.name?.trim() ? file.name : `colada-${at}.${EXTENSION[normalizeMime(file.type)] ?? "bin"}`;

// e, adiante:
return { ok: true, kind, file: name === file.name ? file : new File([file], name, { type: file.type }) };
```

Repare na igualdade `name === file.name`: quando o nome existe, o `File`
**original é devolvido sem cópia**. Reconstruir por hábito seria a primeira
oportunidade de perder metadados.

### 2.2 A fronteira HTTP — onde a maioria dos sistemas perde o nome

Dois detalhes decidem se o nome atravessa, e os dois são fáceis de errar sem
perceber:

```ts
const body = new FormData();
body.set('file', file);        // <- 2 argumentos, e é o certo AQUI
```

`FormData.set(campo, valor)` com um **`File`** usa `File.name` como o `filename`
da parte multipart. Com um **`Blob`**, não há nome, e a especificação manda o
navegador escrever literalmente `blob`. É por isso que o terceiro argumento
existe: `body.set('file', blob, 'contrato.pdf')`. **Se o seu sistema converte
para `Blob` em algum ponto — e converter é comum, porque quase toda manipulação
de bytes devolve `Blob` — o nome morre aqui, sem erro e sem aviso.**

O segundo detalhe:

```ts
headers: { ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }) }
```

O `content-type` **precisa** ser omitido para `FormData`. Quem escreve
`content-type: multipart/form-data` à mão remove o `boundary` que o navegador
geraria, e o servidor recebe um corpo que não consegue separar em partes. O
sintoma não é "nome perdido", é "arquivo não chegou".

### 2.3 Na aplicação

```ts
readonly attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
}).single('file');
```

Em memória, não em disco: o arquivo precisa estar inteiro em RAM para a
verificação de *magic bytes* de §5.2. O `file.originalname` que o multer expõe é
o `filename` do `Content-Disposition`, **verbatim** — o multer não normaliza, não
remove caminho e não confere extensão.

Daí em diante o nome passa por **um único** ponto de reescrita, e o resultado é
usado em dois lugares ao mesmo tempo:

```ts
const filename = sanitizeFilename(file.originalname);
const path = `${context.workspaceId}/${conversationId}/${id}/${filename}`;
```

O nome saneado é, simultaneamente, o valor que vai ao WhatsApp **e** o último
segmento da chave do objeto no armazenamento. Esse acoplamento é o que
transforma a sanitização de cosmética em requisito de segurança — ver §4.

### 2.4 Até o provedor

O nome viaja como **campo próprio** do comando, ao lado da URL do arquivo:

```ts
const url = await this.storage.signedUrl(processing.storageObjectPath, 300);
command: { type: 'message.sendAttachment', payload: {
  wahaSession, chatId, type, url,
  filename: processing.filename,
  mimeType: processing.mimeType,
  caption,
} }
```

E chega ao provedor assim — este é o corpo literal e completo da requisição:

```http
POST {WAHA_BASE_URL}/api/sendFile
{
  "session":  "...",
  "chatId":   "5511999990000@c.us",
  "file": { "url": "<signed url>", "mimetype": "application/pdf", "filename": "contrato.pdf" },
  "caption":  "..."          // omitido quando não há legenda
}
```

O endpoint é escolhido pelo tipo: `/api/sendImage`, `/api/sendVoice`,
`/api/sendVideo` ou `/api/sendFile`. **Documento é o caso do `/api/sendFile`, e é
onde o `filename` importa.** Se o `filename` é honrado nos outros três endpoints:
**não identificado** — o campo é enviado nos quatro, e nada no código diz se o
provedor o ignora fora do `sendFile`.

O arquivo vai **como URL**, não como base64: uma URL assinada de 300 segundos
para um bucket privado, que o provedor busca por conta própria. O binário nunca
trafega pelo processo do worker.

> **Ambiguidade importante para quem for portar.** A URL assinada contém o mesmo
> nome saneado no último segmento do caminho (§2.3). Então há **duas** fontes
> possíveis do nome chegando ao provedor, e elas carregam o mesmo texto. Se o
> provedor deriva o nome da URL em vez de ler o campo `filename`, este sistema
> não teria como notar. **Não identificado** — não há teste, comentário nem doc
> que resolva. Num sistema novo, vale desacoplar de propósito (um `jobId` puro
> como chave de objeto) só para tornar o bug distinguível.

---

## 3. Onde o nome pode se perder

Sete pontos. Para cada um, o sintoma que o desenvolvedor veria.

### 3.1 `Blob` em vez de `File` no multipart

**Sintoma:** o contato recebe `blob`, sem extensão. No servidor,
`file.originalname` é literalmente `"blob"`.

A causa quase sempre está longe do envio: alguém passou o arquivo por um canvas,
um `fetch(...).blob()`, uma compressão, uma biblioteca de recorte. Todos devolvem
`Blob`. A única barreira neste sistema é a assinatura TypeScript `file: File` —
**não há teste**, e no `jsdom` o comportamento pode divergir do navegador real.

### 3.2 Multer decodificando como `latin1`

```js
this.defParamCharset = options.defParamCharset || 'latin1'   // multer/index.js:22
```

**Sintoma:** `Relatório Anual.pdf` chega em `file.originalname` como
`RelatÃ³rio Anual.pdf`, e depois da sanitização vira `RelatA-3rio-Anual.pdf`
(o `NFKD` converte `³` em `3`). Não é nome genérico — é pior, é nome corrompido
de um jeito que parece bug de fonte.

Este sistema **não** passa `defParamCharset`, então herda o padrão. É omissão de
configuração, não decisão registrada: não há comentário sobre isso em lugar
nenhum. **Quem portar deve passar `defParamCharset: 'utf8'`.**

> A cadeia "UTF-8 no navegador → mojibake em `originalname`" foi verificada em
> Node isoladamente, a partir do literal em `multer/index.js:22`. **Não há teste
> no repositório que a exercite**, então o comportamento com o navegador real
> não está travado.

### 3.3 `sanitizeFilename` caindo no fallback

```ts
return name || 'attachment';
```

**Sintoma:** o contato recebe um arquivo chamado `attachment`, sem extensão. No
banco, `inbox_outbox_jobs.filename = 'attachment'`. **Nada é logado, nada falha:
o job é criado normalmente.**

Dispara **exclusivamente** quando o resultado da sanitização é a string vazia —
isto é, quando não sobrou nenhum caractere `[A-Za-z0-9]` no miolo. Casos
verificados executando a função: `''`, `'...'`, `'___'`, `'   '`, `'文件'`.

Um nome inteiramente em alfabeto não-latino **sem extensão** cai aqui. Com
extensão, o caso é pior — o próximo.

### 3.4 A extensão engolida pela poda das bordas

**O ponto mais silencioso do sistema inteiro.** Quando o miolo antes do ponto é
todo não-ASCII, ele colapsa num único `-`, o ponto passa a ser caractere de
borda, e a poda leva os dois:

| Entrada | Saída | O que aconteceu |
| --- | --- | --- |
| `日本語.pdf` | `pdf` | a extensão virou o nome inteiro |
| `Договор.pdf` | `pdf` | idem |
| `📄.pdf` | `pdf` | idem |
| `.pdf` | `pdf` | arquivo oculto do Unix |

**Sintoma:** o contato recebe um arquivo chamado `pdf`, **sem ponto e sem
extensão**, que o celular dele não sabe abrir. Não aciona o fallback, não gera
log, e a string até parece plausível numa listagem de banco.

Qualquer operação com alfabeto não-latino — chinês, russo, árabe, grego, hebraico
— cai aqui. Se o seu CRM atende esse público, este é o primeiro lugar para olhar.

### 3.5 O truncamento cortando a extensão

```ts
.replace(/^[._-]+|[._-]+$/g, '').slice(0, 180)
```

O `slice` é a **última** operação e corta o **fim** — exatamente onde mora a
extensão. Seja `L` o comprimento já saneado:

- `L ≤ 180` → extensão intacta.
- `L = 183` com `.pdf` → saída termina em `.` — **um ponto solto**, porque a poda
  das bordas já rodou e não roda de novo.
- `L ≥ 184` com `.pdf` → sem ponto e sem extensão.

**Sintoma:** nomes longos chegam sem extensão, e alguns com um ponto órfão no
fim. Só acontece acima de 180 caracteres, então nunca aparece em teste manual.

A ordem — podar antes de cortar — é **arbitrária** e tem essa consequência
observável. A ordem inversa a evitaria.

### 3.6 O campo `filename` nulo abortando o envio em silêncio

```ts
if (!processing || !processing.storageObjectPath || !processing.filename || !processing.mimeType) return;
```

**Sintoma:** o anexo simplesmente **não é enviado**. Não vira `failed`, não gera
log, não aparece erro para o operador: o job fica preso em `processing` para
sempre, e o objeto fica ocupando espaço no bucket. Só um restart da aplicação o
resolve (§5.7).

Um `return` mudo dentro de uma guarda defensiva é a forma mais cara de tratar
erro: o estado fica inconsistente e ninguém sabe.

### 3.7 A idempotência descartando o nome novo

```ts
const existing = await this.store.findByClientRequest(context.workspaceId, clientRequestId);
if (existing) return existing;
```

**Sintoma:** o operador reenvia um arquivo diferente e o contato recebe o
anterior — ou nada. O `originalname` desta requisição **nem chega a ser lido**.

Vale para **qualquer** status, inclusive `failed`: reenviar com o mesmo
`clientRequestId` nunca reenvia. Se o seu cliente gera o id uma vez por sessão em
vez de uma por submit, isso vira um bug de "só o primeiro anexo funciona".

### 3.8 O nome exibido **não** vem do caminho de envio

Este é estrutural e merece destaque, porque explica por que "corrigir a
sanitização" pode não mudar nada na tela.

A coluna que a Inbox lê para exibir o nome é
`whatsapp_messages.media_filename` — e o caminho de envio **nunca escreve nela**.
O envio grava em `inbox_outbox_jobs.filename`, que é outra tabela. A mensagem só
entra em `whatsapp_messages` pelo **eco do webhook do provedor**, e ali o nome é
lido do payload que o provedor devolveu, não da linha do outbox.

**Sintoma:** o contato recebe o nome certo e **o operador vê "Documento"**. Ou o
contrário. As duas pontas têm fontes independentes, e nada as reconcilia.

---

## 4. Sanitização

A função inteira, em uma linha:

```ts
function sanitizeFilename(value: string) {
  const name = value
    .normalize('NFKD')                        // 1
    .replace(/[^A-Za-z0-9._-]+/g, '-')        // 2
    .replace(/^[._-]+|[._-]+$/g, '')          // 3
    .slice(0, 180);                           // 4
  return name || 'attachment';                // 5
}
```

### 4.1 O que é segurança

**Só uma coisa: o nome vira segmento de caminho.** Como o resultado é
concatenado em `${workspaceId}/${conversationId}/${id}/${filename}`, um nome
como `../../photo.jpg` escreveria fora do prefixo pretendido. O passo 2 resolve,
porque `/` e `.` consecutivos não sobrevivem: `../../photo.jpg` vira
`photo.jpg`.

Se você **desacoplar** o nome da chave do objeto — usando o `jobId` como chave e
guardando o nome só numa coluna —, esta justificativa desaparece e a sanitização
inteira vira cosmética. **Recomendo desacoplar.** O acoplamento não compra nada
e cobra a §3.4 inteira.

Há um segundo item de segurança, no caminho de **recepção**, e ele é obrigatório
em qualquer implementação:

```ts
const filename = (fallbackFilename ?? 'attachment').replace(/[\\\r\n"]/g, '_');
response.setHeader('content-disposition', `inline; filename="${filename}"`);
```

Um nome com `"` ou `\r\n` injeta cabeçalho HTTP. **Isso não é cosmético em
nenhuma circunstância.** Note que a solução correta aqui é `filename*=UTF-8''…`
(RFC 5987), que preserva o nome e escapa direito; este sistema usa a forma
simples e aceita a perda.

### 4.2 O que é cosmético

Todo o resto:

| Passo | O que faz | Por que existe |
| --- | --- | --- |
| `NFKD` | decompõe acentos (`é` → `e`+diacrítico) e converte formas de compatibilidade (`³`→`3`, fullwidth→ASCII) | fazer acento sobreviver como letra em vez de virar `-` |
| allowlist `[A-Za-z0-9._-]` | tudo fora vira `-` | evitar caracteres problemáticos em chave de objeto |
| poda das bordas | remove `.`, `_`, `-` das pontas | evitar `.arquivo` (oculto) e `-arquivo` (parece flag) |
| `slice(0, 180)` | corta | evitar nome absurdo |

**Todos os quatro são escolhas, e todas são arbitrárias:**

- O **180** não corresponde a nada. Não é o limite do contrato interno (255), não
  é limite de coluna (`TEXT` é ilimitado nas duas árvores), não é limite
  documentado de nenhum sistema de arquivos citado no código. É número mágico.
- A allowlist **exclui todo alfabeto não-latino sem sinalizar**. Um nome em
  chinês não é rejeitado — é apagado.
- Mapear um **bloco contíguo** para **um único** `-` (o quantificador `+`) em vez
  de um `-` por caractere é escolha, e é o que faz `日本語.pdf` colapsar em
  `-.pdf` antes da poda.
- `NFKD` em vez de `NFD` ou `NFC` é escolha, com efeito colateral não
  documentado: alguns símbolos viram dígitos em vez de `-`.
- O literal `'attachment'` é arbitrário — e infeliz, porque a camada de exibição
  deste mesmo sistema o trata como lixo (§7.3). **As duas decisões foram tomadas
  sem conversar.**

### 4.3 O que eu faria diferente

Para quem está implementando do zero:

1. **Não use o nome como chave de objeto.** Use o id do job. Isso elimina a
   justificativa de segurança e libera o resto.
2. **Preserve Unicode.** Guarde o nome original numa coluna e envie-o ao
   provedor. A limpeza necessária é apenas: remover separadores de caminho
   (`/`, `\`), remover bytes de controle, normalizar em `NFC` (não `NFKD`).
3. **Se precisar truncar, trunque o miolo e preserve a extensão:**
   separe base e extensão, corte a base, recomponha.
4. **Nunca deixe o fallback silencioso.** Se você chegou a um nome genérico,
   **registre um log** com o nome de entrada. Este sistema não faz isso, e é
   por isso que `attachment` apareceu em produção sem ninguém saber de onde.
5. **Passe `defParamCharset: 'utf8'`** se usar multer.

---

## 5. O resto do caminho de anexo

Sete peças. Cada uma protege de algo específico — leia o "protege contra" para
decidir o que portar.

### 5.1 Allowlist de MIME

```ts
const policy = {
  image:    { mimes: ['image/jpeg','image/png','image/webp'], max: 15 * 1024 * 1024 },
  audio:    { mimes: [...], max: 25 * 1024 * 1024 },
  video:    { mimes: [...], max: 50 * 1024 * 1024 },
  document: { mimes: ['application/pdf','application/zip','application/x-zip-compressed',
                      'text/plain',
                      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
              max: 25 * 1024 * 1024 },
};
```

É **allowlist**, não blocklist — o padrão é recusar. Fora da lista: HTTP 415.

**Protege contra:** enviar executável, e contra o crescimento silencioso da
superfície de tipos. Uma blocklist erra por omissão a cada formato novo.

Repare que **o tipo do anexo é derivado do MIME, nunca pedido pelo cliente**. Um
cliente não consegue declarar "isto é imagem" para escapar do limite de imagem.

O nome **não participa**: a extensão é ignorada por completo na classificação.
Isso é deliberado e certo — extensão é sugestão, não fato.

### 5.2 Magic bytes

Confere os primeiros 12 bytes do conteúdo contra o MIME declarado:

| Tipo | Assinatura |
| --- | --- |
| PDF | `%PDF-` |
| ZIP, DOCX, XLSX | `PK` (`0x50 0x4B`) |
| PNG | os 8 bytes canônicos |
| WebP | `RIFF` + `WEBP` |
| MP4 | `ftyp` no offset 4 |
| WebM | `1A 45 DF A3` |
| OGG | `OggS` |
| TXT | ausência de byte `0x00` nos primeiros 8192 |

Divergência: HTTP 400, **antes do upload**.

**Protege contra:** `.exe` renomeado para `.pdf`, e contra o navegador declarar
MIME pela extensão — que é o que ele faz. É a única checagem que olha o
conteúdo real.

> Advertência: a checagem de `audio/mpeg` neste sistema aceita **qualquer**
> arquivo cujo primeiro byte seja `0xFF`. Na prática, não verifica quase nada.
> Quem portar deve saber que essa entrada da tabela é decorativa.

### 5.3 Limite de tamanho — conferido em três lugares

1. **Multer**, 50 MiB, antes de qualquer código da aplicação. Estouro: HTTP 413.
2. **Por família**, na validação (imagem 15, áudio 25, vídeo 50, documento 25 MiB).
3. **No bucket**, `file_size_limit = 52428800`.

**Protege contra:** exaustão de memória (o multer bufferiza tudo em RAM antes de
qualquer checagem) e contra custo de armazenamento.

Os quatro números por família **não têm justificativa nenhuma no código**. Não
citam limite do WhatsApp nem do provedor. E os três lugares **não são
sincronizados por nada**: mudar um não muda os outros. Um PDF de 40 MB sobe
inteiro para ser recusado depois pelo limite de 25.

> Detalhe de qualidade: arquivo de **0 byte** cai no ramo do 413 e recebe a
> mensagem "Arquivo excede o limite permitido" — simplesmente errada. O cliente
> tem mensagem correta ("O arquivo está vazio"), o servidor não.

### 5.4 Bucket privado

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chatpro-temporary-attachments', 'chatpro-temporary-attachments', false, 52428800, ARRAY[...]);
```

Privado, e **nenhuma policy de leitura é criada** — só a credencial de serviço
escreve. O navegador nunca recebe credencial de armazenamento.

**Protege contra:** enumeração de anexos de outros workspaces. Com bucket
público, o caminho `workspaceId/conversationId/jobId/nome.pdf` seria adivinhável
por quem conhecesse os ids.

> Divergência real e não justificada: a lista de MIMEs do **bucket** não inclui
> `application/zip`, embora a `policy` da aplicação aceite. Um `.zip` passa nas
> três validações, cria a linha, e **morre no upload** — o erro vira 503 opaco e
> o job cai em `failed`. O teste unitário não pega porque usa armazenamento em
> memória.

### 5.5 URL assinada

300 segundos, gerada só no momento do despacho, consumida pelo provedor.

**Protege contra:** deixar o objeto acessível além do necessário. Mas é
**bearer-URL**: quem obtiver o link dentro da janela baixa o arquivo, sem
verificação de identidade. O TTL curto é a única defesa.

O `300` aparece como literal em **quatro lugares independentes** do sistema,
nenhum com justificativa e nenhum referenciando o outro.

### 5.6 Idempotência por `clientRequestId`

UUID gerado **no cliente**, uma vez por submit. Índice único
`(workspace_id, client_request_id)` nas duas árvores. A linha é gravada **antes**
do upload; se o índice estourar por corrida, o erro é engolido e a linha
vencedora é devolvida.

**Protege contra:** duplo clique, reenvio por reconexão, e a corrida entre dois
`create` concorrentes. É a peça que garante que o contato não receba o mesmo
arquivo duas vezes.

**Cuidado ao portar:** o id ser gerado no cliente é o que torna a defesa útil
(o servidor não teria como saber que duas requisições são a mesma intenção), mas
significa que um cliente com bug — id fixo, id por sessão — quebra o envio de
forma difícil de diagnosticar, e sempre com o sintoma da §3.7.

### 5.7 Máquina de estados do outbox

Seis estados, com `CHECK` nas duas árvores:

```text
                    ┌──────────── operador ────────────┐
                    ▼                                  │
create ──▶ pending ──claim──▶ processing ──ok──▶ sent ──webhook──▶ confirmed
             │                    │                            (remove o objeto)
             │                    └──erro──▶ failed
             └──▶ cancelled
```

- **`claim`** é um `UPDATE` condicional (`WHERE status = 'pending'`). É isso que
  garante que dois despachos concorrentes produzam um envio só.
- **`confirmed`** vem do eco do webhook, casando pelo id da mensagem do provedor,
  e é o que dispara a remoção do objeto temporário.
- **Não há retry.** `claim` exige `pending`, e nada devolve a linha para
  `pending`. Falha é terminal, deliberadamente: reenviar um anexo sem saber se o
  provedor aceitou o primeiro é como duplicar a mensagem para o contato.

> A documentação interna deste projeto (`docs/inbox-attachment-sending.md:16`)
> promete "no máximo três tentativas" e **o código não tem retry nenhum**. A
> documentação está errada, ou descreve algo removido. Registrado aqui porque
> quem portar pode ler aquele arquivo e acreditar.

**Job órfão em `processing`:** existe, e a única saída é o **reboot**. Uma rotina
de reconciliação roda na subida da aplicação e resolve tudo anterior ao boot:
`pending` → `cancelled`, `processing` → `failed`. Enquanto o processo estiver de
pé, um órfão fica preso indefinidamente. Uma varredura horária remove objetos de
jobs terminais com mais de 24 h — e **não** alcança `processing`, então o objeto
do órfão só cai depois do restart.

---

## 6. Implementação de referência

### 6.1 O núcleo portável

```ts
// ─── Política de tipos. Allowlist, e o tipo é DERIVADO do mime. ───────────────
const policy = {
  document: {
    mimes: ['application/pdf', 'text/plain',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    max: 25 * 1024 * 1024,
  },
  // image, audio, video…
} as const;

// ─── Validação: tipo → tamanho → conteúdo, nesta ordem. ──────────────────────
// A ordem é observável: um PDF de 30 MB com magic errado recebe 413, não 400.
function validateFile(file: { mimetype: string; size: number; buffer: Buffer }) {
  const type = (Object.keys(policy) as Kind[]).find(k => policy[k].mimes.includes(file.mimetype));
  if (!type) throw new HttpError(415, 'Tipo de arquivo não permitido');
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new HttpError(400, 'Arquivo vazio');
  if (file.size > policy[type].max) throw new HttpError(413, 'Arquivo excede o limite permitido');
  if (!magicMatches(file.buffer, file.mimetype)) throw new HttpError(400, 'Arquivo inválido');
  return type;
}

// ─── Nome: versão corrigida. Compare com a do sistema real, em §4. ───────────
// Diferenças deliberadas: preserva Unicode, preserva a extensão no truncamento,
// e AVISA quando cai no genérico em vez de fazê-lo em silêncio.
// Só sai o que é perigoso: controle, DEL e os dois separadores de caminho.
// Sem allowlist — é ela que apaga alfabeto não-latino (§3.4).
const CONTROL_AND_PATH = /[\u0000-\u001f\u007f/\\]/g;

export function preservingFilename(raw: string, onFallback?: (input: string) => void) {
  const cleaned = raw.normalize('NFC').replace(CONTROL_AND_PATH, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    onFallback?.(raw);                       // <- o log que falta no original
    return 'arquivo';
  }
  const dot = cleaned.lastIndexOf('.');
  const hasExt = dot > 0 && dot < cleaned.length - 1 && cleaned.length - dot <= 12;
  const base = hasExt ? cleaned.slice(0, dot) : cleaned;
  const ext  = hasExt ? cleaned.slice(dot) : '';
  return base.slice(0, 180 - ext.length) + ext;   // trunca o MIOLO, não a extensão
}
```

O `12` do limite de extensão é arbitrário — evita tratar `arquivo.2026.01.15` como
tendo extensão `.15` sem cortar `.openxmlformats`. Ajuste ao seu gosto.

As duas funções lado a lado, **executadas**, não descritas:

| Entrada | `sanitizeFilename` (real) | `preservingFilename` (referência) |
| --- | --- | --- |
| `contrato.pdf` | `contrato.pdf` | `contrato.pdf` |
| `nota fiscal 123.pdf` | `nota-fiscal-123.pdf` | `nota fiscal 123.pdf` |
| `Relatório Anual.pdf` | `Relato-rio-Anual.pdf` | `Relatório Anual.pdf` |
| `日本語.pdf` | **`pdf`** | `日本語.pdf` |
| `Договор.pdf` | **`pdf`** | `Договор.pdf` |
| `文件` | **`attachment`** | `文件` |
| `../../photo.jpg` | `photo.jpg` | `....photo.jpg` |
| `...` | **`attachment`** | `...` |
| `<183 chars>.pdf` | termina em `.` (ponto solto) | `.pdf` intacto |
| `<184 chars>.pdf` | sem extensão | `.pdf` intacto |

Duas diferenças de comportamento que a tabela expõe e que valem ser declaradas,
porque não são acidente:

- **`../../photo.jpg` vira `....photo.jpg`**, não `photo.jpg`. Os pontos
  sobrevivem porque a função só remove **separadores de caminho**, e sem `/`
  nem `\` não existe travessia. O nome fica feio e é inofensivo. Se a estética
  importar, pode-se colapsar `\.{2,}`, mas isso é cosmético, não segurança.
- **`...` não cai no fallback**, ao contrário da função real. Um nome só de
  pontos, uma vez removidos os separadores, é um nome de arquivo legítimo. O
  fallback aqui é reservado ao caso em que **não sobrou nada**.

---

### 6.2 O que é específico deste projeto

Não copie sem trocar:

| Item | Por que é específico |
| --- | --- |
| **`/api/sendFile` e o formato `file: { url, mimetype, filename }`** | É a API do WAHA. Outro gateway de WhatsApp (Meta Cloud API, Baileys direto) tem outro contrato — a Cloud API, por exemplo, quer um `media id` obtido num upload prévio, não uma URL. |
| **Arquivo entregue por URL assinada** | Escolha de arquitetura: exige que o provedor alcance seu armazenamento pela rede. Se o seu provedor roda na mesma máquina, base64 ou caminho local é mais simples e não precisa de URL assinada nenhuma. |
| **Limites 15/25/50 MB** | Política deste servidor. Não vieram do WhatsApp nem do provedor; são escolha sem justificativa registrada. |
| **`slice(0, 180)`** | Número mágico. Ver §4.2. |
| **Fallback `'attachment'`** | Literal arbitrário, e conflita com a camada de exibição do próprio sistema. |
| **Bucket `chatpro-temporary-attachments` e o TTL de 300 s** | Nomes e prazos locais. |
| **Caminho `workspaceId/conversationId/jobId/filename`** | Ver §4.3: eu recomendo **não** repetir. |
| **`x-workspace-id` sem token** | A autenticação da rota é um header cru validado por regex, declarado no próprio código como contexto temporário de desenvolvimento. **Não porte isto.** |
| **Seis estados do outbox** | O conjunto é razoável, mas `confirmed` só existe porque o provedor ecoa um webhook de saída. Sem esse eco, o estado não tem como ser alcançado e a limpeza de objeto precisa de outro gatilho. |
| **Textos em português** | Estão em toda parte. |
| **Espelho da validação no navegador** | Este sistema duplica allowlist, tamanho e magic bytes no cliente, para dar erro antes de subir 25 MB. É conveniência, não segurança — o servidor valida de novo, e é o servidor que manda. |

Portável sem alteração: a estrutura `validateFile` (ordem tipo → tamanho →
conteúdo), a tabela de *magic bytes*, o modelo de idempotência por id do cliente
com índice único e gravação antes do upload, o `claim` condicional, e as
decisões da §4.3.

---

## 7. Recepção

O caminho de volta — como o nome de um documento **recebido** chega e é
renderizado. Aqui há um desenho e um contorno, e eles não se encontram.

### 7.1 O desenho

O webhook lê **duas** chaves do payload, nesta precedência, e grava numa coluna:

```ts
const media = record(value.media);
mediaFilename: text(media?.filename) ?? text(value.filename) ?? null
```

Ou seja: `payload.media.filename`, depois `payload.filename`. Não há terceira
origem. O resultado vai para `whatsapp_messages.media_filename` (nas duas
árvores, nullable). A ordem de precedência não tem comentário nem teste que a
justifique — é arbitrária no sentido de que nada no código explica por que é a
ordem certa.

### 7.2 O defeito conhecido

> **`media_filename` chega nulo em 1.252 de 1.260 documentos da base.** Medido
> via PostgREST, somente leitura. Ou seja: **o desenho descrito em §7.1 não
> funciona em produção** para 99,4% dos documentos recebidos.

O nome existe: ele está no payload cru, sob `_data.filename`. E o payload cru é
gravado inteiro numa coluna própria, passando por uma função que redige apenas
chaves sensíveis (`token`, `secret`, `password`, `authorization`…). A chave
`filename` não bate nessa lista, então `_data.filename` sobrevive intacto no
banco — **e é só por isso que o contorno da §7.3 é possível**.

Por que a coluna vem nula — se o provedor manda o nome apenas em `_data`, ou se
manda nulo mesmo — **não identificado**: responder exigiria comparar payloads
crus, e o acesso ao banco estava fora do escopo desta investigação. Não há em
`web/docs/` nenhum exemplo capturado de payload de documento recebido; o que
existe são fixtures escritas pela equipe.

**Há PR em andamento para preencher as colunas.** O que está descrito abaixo é
contorno, e não deve ser lido como desenho.

### 7.3 O contorno (do dashboard, hoje)

```ts
const PLACEHOLDER_NAME = /^(image|imagem|audio|áudio|video|vídeo|file|arquivo|attachment|anexo|document|documento)(\.[a-z0-9]+)?$/i;

const name = text(message.mediaFilename) ?? text(wahaData(message).filename);
return name && !PLACEHOLDER_NAME.test(name) ? name : undefined;
```

Coluna primeiro, `metadata._data.filename` como retaguarda, e ainda um filtro
que descarta rótulos genéricos. Sem nome, o cartão exibe `Documento ${label}`,
cujo pior caso visível ao operador é literalmente **"Documento ARQ"**, com
"Tamanho não informado" ao lado.

Três observações para quem for portar:

1. **A lista de rótulos tem falso positivo embutido.** Um arquivo realmente
   chamado `documento.pdf` é descartado como se fosse rótulo.
2. **Ela inclui `attachment`** — o fallback que o próprio servidor produz no
   envio (§3.3). Isto é, o sistema trata o próprio genérico como lixo na
   exibição. As duas decisões foram tomadas sem conversar.
3. **O contorno é só de exibição, e não alcança dois pontos:**
   - A prévia da conversa congela a string `'Documento'` dentro da coluna
     `conversations.last_message` — ela é gravada, não recalculada no render.
   - O download por proxy monta `content-disposition: inline; filename="attachment"`
     a partir de uma leitura que **só** consulta a coluna.

### 7.4 Um agravante no próprio desenho

Quando a mídia é baixada para o armazenamento permanente, a coluna é
**sobrescrita** por uma segunda função de sanitização — gêmea da do envio, em
outro arquivo — que troca nome nulo por um rótulo derivado do MIME:

```ts
const source = value ?? (mime.startsWith('image/') ? 'image'
                       : mime.startsWith('video/') ? 'video'
                       : mime.startsWith('audio/') ? 'audio' : 'attachment');
```

Portanto **a coluna pode ficar não-nula e ainda assim genérica** — e é
exatamente contra isso que o filtro de rótulos da §7.3 existe. Duas funções de
sanitização quase idênticas, em arquivos diferentes, com fallbacks diferentes,
sem constante compartilhada: se você portar, **faça uma só**.

---

## 8. Armadilhas

Em ordem aproximada de quanto tempo custam quando aparecem.

**O `Blob` que virou `blob`.** §3.1. Qualquer manipulação de bytes devolve
`Blob`, e `Blob` não tem nome. O sintoma — todo arquivo chegando como `blob` —
aponta para o envio, mas a causa está na compressão, no recorte ou no
`fetch().blob()` três camadas antes. **Nenhum teste pega:** no `jsdom` o
comportamento de `FormData` pode divergir do navegador, e a única barreira aqui
é a assinatura de tipo.

**`content-type` escrito à mão no multipart.** Some o `boundary` e o servidor
recebe um corpo que não sabe separar. O sintoma não é "nome errado", é "arquivo
não chegou" — então você vai procurar no lugar errado. **Sem teste** neste
sistema: nada exercita o transporte com `FormData`.

**Acento virando mojibake pelo `latin1` do multer.** §3.2. `Relatório` vira
`RelatA-3rio` **depois** da sanitização, o que parece problema de fonte ou de
codificação do banco. Um teste com nome ASCII nunca reproduz, e ASCII é o que
todo mundo usa para testar.

**A extensão engolida em alfabeto não-latino.** §3.4. `日本語.pdf` vira `pdf`.
Não aciona fallback, não gera log, e a string parece plausível numa listagem.
Só aparece quando um cliente real manda um arquivo com nome em chinês, russo ou
árabe — provavelmente meses depois de você ter dado o recurso por pronto.

**O truncamento comendo a extensão.** §3.5. Acima de 180 caracteres. Ninguém
testa com nome de 184 caracteres.

**O fallback silencioso.** §3.3. `attachment` aparece em produção e **não há como
descobrir de onde veio**, porque nada é logado. Foi assim que este sistema
descobriu o problema — vendo o nome na tela do contato, não no log. A correção
é de uma linha: registre a entrada quando cair no fallback.

**O anexo que não é enviado e não vira erro.** §3.6. Um `return` mudo numa guarda
defensiva deixa o job preso em `processing` para sempre e o objeto no bucket.
O operador vê "enviando" e nada acontece. Só o restart da aplicação resolve.

**Idempotência com id de sessão em vez de id de submit.** §3.7. O primeiro anexo
funciona, os seguintes silenciosamente devolvem o primeiro. Parece cache,
parece bug de UI, e é o id.

**Nome certo no contato, "Documento" para o operador.** §3.8. As duas pontas
leem de fontes independentes: o contato vê o que o envio mandou; o operador vê o
que o eco do webhook trouxe. Corrigir a sanitização não muda a tela, e mexer na
tela não muda o que o contato recebe. **É a armadilha mais cara do documento**,
porque a hipótese natural — "é o mesmo dado" — está errada.

**A costura entre as pontas não é testada.** Neste sistema o nome é afirmado no
navegador (`api/inbox.test.ts`) e afirmado no worker
(`waha-client.test.ts`, com um literal escrito à mão) — e **nada** afirma que o
que sai de um chega ao outro. As duas pontas passam e o meio pode estar
quebrado. Se você escrever um teste só, escreva o de ponta a ponta.

**A sanitização sem teste.** `sanitizeFilename` **não é exportada** e nenhuma
asserção do repositório mira o valor que ela devolve. O único caso que a exercita
afirma sobre o *caminho de storage*, não sobre o nome. Todos os comportamentos da
§3.3 à §3.5 estão sem rede de proteção. **Exporte a função e teste-a
diretamente** — é a peça mais barata de travar e a que mais silenciosamente erra.

**A divergência entre a allowlist da aplicação e a do bucket.** §5.4. O tipo
passa em três validações, cria a linha, e morre no upload com erro opaco. O teste
unitário não pega porque usa armazenamento em memória. **Nenhum teste que use
mock de armazenamento pega este tipo de bug** — é preciso um teste de integração
contra o armazenamento real, ou uma verificação que compare as duas listas.

**O nome acoplado à chave do objeto.** §4.1. Enquanto o nome for segmento de
caminho, você **não pode** relaxar a sanitização — e é a sanitização que causa
§3.4 e §3.5. Os dois problemas são o mesmo problema, e a solução é desacoplar,
não afinar a regex.

**Cancelar durante o despacho.** A atualização de status não é condicional, então
um cancelamento disparado enquanto o despacho está em voo pode ser sobrescrito de
volta para `sent` — **com o objeto já removido**. Não há teste que exercite a
corrida, e não há evidência de que tenha ocorrido; é leitura de código.

---

## Referências no código deste projeto

Para quem tiver acesso a este repositório:

- `web/apps/api/src/services/attachment-outbox.service.ts` — o serviço inteiro em
  104 linhas: política, validação, *magic bytes*, `sanitizeFilename`,
  idempotência, despacho e máquina de estados
- `web/apps/api/src/controllers/inbox.controller.ts` — a rota e o multer
- `web/apps/dashboard/src/ui/attachmentIntake.ts` — os cinco pontos de entrada e
  o espelho da validação no navegador
- `web/apps/dashboard/src/api/inbox.ts` e `.../api/client.ts` — a montagem do
  multipart e a omissão deliberada do `content-type`
- `web/packages/contracts/src/index.ts` — o contrato do comando de anexo
- `web/apps/worker/src/waha-client.ts` — a chamada `/api/sendFile`
- `web/apps/api/src/services/waha-webhook.service.ts` — a extração do nome na
  recepção
- `web/apps/dashboard/src/ui/messageMedia.ts` — a cadeia de fallback e o filtro
  de rótulos genéricos
- `web/apps/api/src/services/whatsapp-media-persistence.service.ts` — a **segunda**
  função de sanitização
- `web/docs/inbox-attachment-sending.md` — a descrição anterior do fluxo;
  atenção, a promessa de "no máximo três tentativas" não corresponde ao código
- `web/docs/spec-editor-imagem.md` — a especificação irmã, do editor de imagem
