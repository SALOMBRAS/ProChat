# SPEC — Envio e Recebimento de Documentos, Arquivos e Links (T4)

> **Propósito:** documentar a feature de documentos/arquivos/links do ChatPro com
> detalhe suficiente para **replicar a mesma função em outro sistema**, do zero,
> sem precisar ler o código original.
>
> **Stack de referência:** TypeScript, React 18 + Vite (dashboard), Express 5 (API),
> Zod (contratos), Supabase Storage (staging), worker interno + WAHA (provedor WhatsApp).

---

## §0 — O que o sistema consegue enviar e receber HOJE

### ✅ Pode enviar (operador → WhatsApp)

| Categoria | Tipos aceitos | Limite | Como chega ao destinatário |
|---|---|---|---|
| Imagem | `image/jpeg`, `image/png`, `image/webp` | 15 MB | Imagem inline no WhatsApp |
| Áudio | `audio/ogg`, `audio/mpeg` (mp3), `audio/mp4` (m4a), `audio/webm` | 25 MB | Player de áudio (ou voice note com forma de onda, via botão de microfone) |
| Vídeo | `video/mp4`, `video/webm` | 50 MB | Vídeo inline no WhatsApp |
| **Documento (catch-all)** | **QUALQUER outro tipo de arquivo** | 50 MB | Cartão de documento com nome, tamanho e ícone |

Exemplos de documentos que já funcionam pelo catch-all (testados ou cobertos pela policy):

- **Texto/dados:** `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.log`, `.svg`
- **Office:** `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.odt`, `.ods`, `.odp`, `.rtf`
- **Compactados:** `.zip`, `.rar`, `.7z`, `.gz`, `.tar`
- **PDF:** `.pdf`
- **Apps/design:** `.apk`, `.psd`, `.ai`, `.fig`
- **E-books:** `.epub`
- **Imagem fora da lista de mídia** (ex.: `.gif`, `.svg`): vai **como documento**, sem recusa
- **Qualquer extensão desconhecida:** vai como documento com mime `application/octet-stream`

### ✅ Pode receber (WhatsApp → operador)

- Todos os tipos acima, renderizados como:
  - **Cartão de documento rico** — etiqueta colorida por tipo real (PDF, DOC, XLS, ZIP, APK, MD…), nome, tamanho, miniatura nativa do WhatsApp quando existe;
  - **Ações:** abrir no navegador, visualizar inline, baixar com progresso;
  - **Prévia de texto inline** para `.md`, `.json`, `.csv`, `.xml`, `.txt` (leitura dos primeiros bytes, sem baixar o arquivo inteiro).

### ✅ Links

- URLs no texto viram **âncoras clicáveis** (linkify) com segurança (`rel="noopener noreferrer"`, `target="_blank"`);
- O **primeiro link** da mensagem ganha **cartão de prévia** (título, descrição, imagem, domínio, favicon);
- **Prévia antes de enviar (como o WhatsApp):** ao digitar/colar um link, o cartão aparece **acima do compositor**; o botão **×** dispensa a prévia e envia só o link — `linkPreview: false` desce por toda a cadeia (dashboard → API → transporte interno → worker → WAHA);
- Envio usa a **prévia nativa da WAHA** (`linkPreview: true`); quando a prévia nativa não existe, uma **retaguarda própria** raspa OG/Twitter e enriquece com oEmbed (YouTube, TikTok);
- O cartão usa **layout compacto** (miniatura lateral, como o WhatsApp) — banner largo esticava a imagem pequena do provedor e parecia "baixa resolução".

### ❌ NÃO pode ainda (backlog para futuras versões desta spec)

| Limitação | Comportamento atual | Melhoria futura |
|---|---|---|
| Arquivo **> 50 MB** | Recusado com 413 (`Arquivo excede o limite permitido`) | Subir para o teto do WhatsApp (2 GB) com upload em partes e bucket maior |
| **GIF como imagem animada inline** | GIF vai como documento (chega estático no cartão) | Enviar GIF como vídeo inline (WAHA converte para mp4) — paridade com "GIF" do WhatsApp |
| **Sticker (webp animado)** | Vai como documento | Suporte a sticker via `/api/sendSticker` ou equivalente |
| **HEIC/HEIF, MOV, MKV, AVI** como mídia inline | Caem como documento (mime fora da policy de mídia) | Ampliar policy de imagem/vídeo ou transcodificar no worker |
| **SVG como imagem inline** | Vai como documento (decisão de segurança: SVG executa script) | Manter como documento ou sanitizar antes de exibir |
| **Prévia inline de PDF/vídeo** | Só miniatura nativa do WhatsApp no recebimento; sem visualizador próprio | Visualizador de PDF inline (pdf.js) e player de vídeo |
| **Prévia de link editável** (título/imagem customizados) | Não existe — a prévia é a nativa ou a raspada | Editor de prévia antes do envio |
| **Páginas atrás de login** na prévia de link | Prévia falha com 422 (`A página não tem informações…`) | Documentado como limitação; sem solução prevista |
| **Cache de prévia persistente** | Cache em memória por processo (reiniciar a API limpa) | Tabela de cache (exige migration — fora do escopo atual) |
| **Múltiplos anexos por mensagem** | Um anexo por envio | Fila de anexos no compositor |
| **`.fig`** | Mapeado conscientemente para `application/octet-stream` (formato proprietário sem mime registrado) | Revisitar se surgir mime registrado |

---

## §1 — Arquitetura de ponta a ponta

```
ENVIO (operador → WhatsApp)
┌──────────┐  1. XHR c/ progresso   ┌─────────┐  2. valida+classifica   ┌────────────┐
│ Dashboard│ ─────────────────────▶ │   API   │ ──────────────────────▶ │  Outbox DB │
│ (React)  │  multipart/form-data  │(Express)│                         │ (job pend.)│
└──────────┘                       └────┬────┘                         └────────────┘
                                        │ 3. staging do buffer
                                        ▼
                                 ┌─────────────┐   4. signed URL (300 s)   ┌────────┐
                                 │   Supabase  │ ◀──────────────────────── │  API   │
                                 │   Storage   │                           └───┬────┘
                                 └─────────────┘                               │ 5. comando interno
                                                                               ▼
┌──────────┐   7. webhook de confirmação   ┌─────────┐   6. sendFile/etc.  ┌────────┐
│   WAHA   │ ────────────────────────────▶ │   API   │ ◀────────────────── │ Worker │
└────┬─────┘                               └─────────┘                     └────────┘
     │ 8. WhatsApp entrega ao destinatário
     ▼

RECEBIMENTO (WhatsApp → operador)
WAHA webhook → API (classifica, persiste, extrai _data) → dashboard renderiza
cartão rico + ações (abrir/visualizar/baixar) via URL assinada.
```

**Decisão estrutural: staging temporário + outbox.** O arquivo nunca vai do navegador
direto para a WAHA. Ele sobe para um bucket temporário, a API cria um **job de
outbox** (fila persistida), e o worker baixa pela **URL assinada de curta vida
(300 s)** e entrega à WAHA. Isso dá: idempotência, confirmação real de entrega,
retomada após restart e limpeza automática.

---

## §2 — Policy de classificação e limites

```ts
const policy = {
  image:    { mimes: ['image/jpeg', 'image/png', 'image/webp'],                 max: 15 * 1024 * 1024 },
  audio:    { mimes: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/webm'],    max: 25 * 1024 * 1024 },
  video:    { mimes: ['video/mp4', 'video/webm'],                               max: 50 * 1024 * 1024 },
  document: { mimes: null /* catch-all */,                                      max: 50 * 1024 * 1024 },
};
```

**Regra de classificação:** o tipo é o primeiro `kind` cuja lista contém o mime
declarado; **se nenhuma lista bate, cai em `document`** — paridade com o WhatsApp,
que aceita qualquer arquivo como documento. O teto continua valendo (50 MB).

**Ordem das validações (importante):**

1. Classificar o tipo;
2. **Tamanho** — `size < 1` ou `size > max` → **413** `Arquivo excede o limite permitido`;
3. **Magic bytes** — assinatura não confere → **400** `Arquivo inválido`;
4. Só depois: persistir job + fazer staging. Recusar depois deixaria lixo (job
   `failed` + arquivo órfão no storage por até 24 h).

---

## §3 — Magic bytes (assinaturas conferidas)

**Filosofia:** assinatura conhecida é conferida; **desconhecida passa** (paridade
com o WhatsApp). O documento nunca é executado pelo sistema — viaja como anexo e o
destinatário decide abrir.

| Tipo | Assinatura (primeiros bytes) |
|---|---|
| `image/jpeg` | `FF D8 FF` |
| `image/png` | `89 50 4E 47 0D 0A 1A 0A` |
| `image/webp` | `RIFF` … `WEBP` (bytes 0–3 e 8–11) |
| `audio/ogg` | `OggS` |
| `audio/mpeg` | `ID3` ou byte 0 = `FF` |
| `audio/mp4`, `video/mp4` | `ftyp` nos bytes 4–7 |
| `audio/webm`, `video/webm` | `1A 45 DF A3` |
| `application/pdf` | `%PDF-` |
| Família ZIP (`zip`, `x-zip-compressed`, `apk`, `epub`, **todos os OpenXML** `docx/xlsx/pptx`) | `PK` (`50 4B`) |
| Família OLE2 (`doc`, `xls`, `ppt` legados) | `D0 CF 11 E0 A1 B1 1A E1` |
| `rar` | `Rar!\x1a\x07` |
| `7z` | `37 7A BC AF 27 1C` |
| `psd` | `8BPS` |
| `ai` (postscript) | `%!PS` ou `%PDF-` |
| Família texto (`txt`, `csv`, `md`, `json`, `xml`, `svg`) | **Não pode conter byte NUL** nos primeiros 8 192 bytes |
| Qualquer outro mime | Passa sem checagem |

**Pegadinha de implementação:** confira `application/epub+zip` **antes** de qualquer
teste `mime.includes('zip')`, e `image/svg+xml` antes de qualquer teste
`mime.endsWith('+xml')` — ambos caem no balde errado se a ordem for invertida.

---

## §4 — Mime canônico por extensão

O mime guardado no job é o que a WAHA entrega ao WhatsApp. Quando o navegador
declara vazio ou `application/octet-stream`, **a extensão do nome resolve a
identidade** — um `.apk` deixa de chegar anônimo ao destinatário.

```ts
const documentExtensionMimes = {
  doc:  'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls:  'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt:  'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf:  'application/pdf',
  txt:  'text/plain',
  csv:  'text/csv',
  md:   'text/markdown',
  json: 'application/json',
  xml:  'application/xml',
  zip:  'application/zip',
  rar:  'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  apk:  'application/vnd.android.package-archive',
  psd:  'image/vnd.adobe.photoshop',
  ai:   'application/postscript',
  fig:  'application/octet-stream', // decisão explícita: formato proprietário sem mime registrado
  svg:  'image/svg+xml',
  epub: 'application/epub+zip',
};

// Regra: se o navegador declarou um mime real (não vazio, não octet-stream),
// ele vence. Senão, extensão → tabela → fallback octet-stream.
```

---

## §5 — Sanitização do nome de arquivo

O nome é o **último segmento da chave do objeto no storage**, então precisa
sobreviver a uma allowlist (`A-Za-z0-9._-`) — é o que desarma `../../`. Mas ele
**não pode perder a extensão**, porque o dispositivo receptor decide como abrir
por ela.

Regras:

1. Normalizar `NFKD`; tudo fora de `[A-Za-z0-9._-]` vira `-`; aparar separadores das bordas.
2. **Separar stem e extensão** e limpar cada um por conta própria:
   - extensão só vale se for ASCII alfanumérica de 1–12 chars (`/^[A-Za-z0-9]{1,12}$/`);
   - stem que colapsar para vazio (ex.: nome todo em alfabeto não-latino, como
     `日本語.pdf`) ganha o fallback `attachment` — **a extensão fica**.
3. Truncar **só o stem** para `180 - extensão.length` — nome longo perde o meio,
   nunca a cauda onde mora a extensão. Reaparar separadores depois do corte.
4. **Privacidade:** o nome nunca vai para o log (é dado do cliente). Logar só
   comprimento original e extensão quando o stem colapsa.

---

## §6 — Fluxo de envio (detalhado)

### 6.1 Dashboard → API (upload com barra de progresso)

- `POST /api/v1/inbox/conversations/{id}/attachments` com `multipart/form-data`;
- **Obrigatório usar `XMLHttpRequest` com `upload.onprogress`** — `fetch` **não
  expõe progresso de upload**. (Use `fetch` só para download/leitura.)
- O `input file` usa `accept="*/*"` — qualquer arquivo pode ser anexado; a policy
  é decidida no servidor, não no seletor;
- **GIF colado/arrastado é anexado como documento**, nunca recusado;
- O cliente gera um **`clientRequestId` (UUID)** por anexo — é a chave de
  idempotência: retry/reenvio com o mesmo ID retorna o job existente em vez de
  duplicar a mensagem.

### 6.2 API — criação do job (ordem importa)

1. `getConversation` (404 se não existe);
2. **`assertActive` da sessão** — antes de qualquer persistência/upload;
3. `findByClientRequest` → se já existe, retorna o job (idempotência);
4. `validateFile` (§2 e §3) → `type`;
5. Monta o job: `path = {workspaceId}/{conversationId}/{uuid}/{filenameSanitizado}`,
   `mimeType = canonicalDocumentMime(...)` (§4), status `pending`;
6. `store.create(job)` — se der conflito, tenta `findByClientRequest` de novo
   (corrida entre duas abas);
7. `storage.upload(path, file)` — **se falhar, marca o job `failed` com
   `lastErrorSafe` genérico e devolve 503 seguro**; a causa real vai para o log
   com campos estruturados (`statusCode`, `providerError`, `mimeType`) — nunca a
   mensagem livre do provedor, que pode conter o path (que contém o filename);
8. `setImmediate(dispatch)` — **este processo despacha apenas o job que acabou de
   persistir**. Nunca re-executa linhas antigas após restart (ver §6.4).

### 6.3 Dispatch (API → worker → WAHA)

1. `claim` atômico (`UPDATE … WHERE status='pending'`) — garante **um único
   despachante** mesmo com triggers concorrentes;
2. `createSignedUrl(path, 300)` — URL de 5 minutos;
3. Comando interno ao worker `message.sendAttachment` com `{ wahaSession, chatId,
   type, url, filename, mimeType, caption?, voiceNote? }`;
4. Worker chama a WAHA:
   - `image` → `POST /api/sendImage`
   - `audio` com `voiceNote` → `POST /api/sendVoice` (PTT com forma de onda)
   - `audio` sem flag → player de áudio
   - `video` → `POST /api/sendVideo`
   - **todo o resto → `POST /api/sendFile`** (o WhatsApp trata como documento)
5. Sucesso → job `sent` + `externalMessageId` + `providerAcceptedAt`;
   falha → job `failed` com `lastErrorSafe` (mensagem segura, ≤ 240 chars).
   **Não há retry automático após falha incerta do worker** — aceitação duvidosa
   não pode virar mensagem duplicada.

### 6.4 Confirmação, reconciliação e limpeza

- O **webhook da WAHA** confirma a entrega → job `confirmed` → objeto removido do
  bucket na hora;
- **Reconciliação no startup:** jobs `pending` antigos → `cancelled`
  (`stale_unverified_job`); `processing` antigos → `failed`
  (`provider_acceptance_uncertain`). Sem chamar o provider;
- **Sweep diário:** jobs terminais (`sent/failed/cancelled/confirmed`) com mais de
  **24 h** têm o objeto removido do bucket e `storageObjectPath` anulado;
- **Cancelamento pelo operador:** só em `pending`/`processing` (409 caso
  contrário); remove o objeto do storage.

### 6.5 Schema do job (tabela/coleção `inbox_outbox_jobs`)

```
id, workspaceId, conversationId, wahaSession, clientRequestId (único por workspace),
type CHECK IN ('image','audio','video','document'),
storageObjectPath, filename, mimeType, sizeBytes, caption,
status ('pending','processing','sent','confirmed','failed','cancelled'),
attemptCount, externalMessageId, providerAcceptedAt, lastErrorSafe,
createdAt, updatedAt
```

> **`voiceNote` é intenção do operador e NÃO é coluna** — de propósito. O dispatch
> acontece uma única vez, na mesma chamada que criou a linha; nada relê a linha
> para reenviar. Se um dia existir retry que re-despacha linha persistida, a flag
> **precisa** virar coluna antes (migration em cada banco).

---

## §7 — Fluxo de recebimento (detalhado)

1. Webhook da WAHA → a API persiste a mensagem e **extrai `_data`** do payload
   (mimetype, filename, tamanho, thumbnail), validando com `safeParse` (Zod) —
   payload malformado do provedor nunca quebra o recebimento;
2. O dashboard classifica o documento por **extensão primeiro, mime depois**
   (`documentKind`) e renderiza o cartão com etiqueta + cor de tom:

| Etiqueta | Extensões | Tom |
|---|---|---|
| PDF | pdf | pdf |
| TXT / MD | txt, log / md | txt |
| JSON / XML | json / xml | code |
| CSV / XLS | csv / xls, xlsx, ods | xls |
| SVG / IMG | svg / png, jpg, jpeg, webp, gif | img |
| DOC | doc, docx, odt, rtf | doc |
| PPT | ppt, pptx, odp | ppt |
| ZIP / RAR / 7Z | zip, rar, 7z, gz, tar | zip |
| APK | apk | app |
| PSD / AI / FIG | psd, ai, fig | design |
| EPUB | epub | book |
| FILE (fallback) | qualquer outra | file |

3. **Ações do cartão:**
   - **Abrir** — nova aba do navegador com a URL assinada (o navegador decide:
     PDF abre inline, binário baixa);
   - **Visualizar** — prévia de texto inline para `text/plain`, `text/csv`,
     `text/markdown`, `application/json`, `application/xml` (+ `image/svg+xml`
     como texto-fonte). A leitura é parcial (primeiros bytes) — não baixa 50 MB
     para mostrar texto;
   - **Baixar** — `fetch` com leitura do stream e **barra de progresso**;
4. Miniatura: usa a **thumbnail nativa que o WhatsApp gera** (vem no payload);
   o sistema não gera thumbnail própria.

---

## §8 — Links vivos e prévia de links

### 8.1 Linkify (texto → âncoras)

- Regex de URL no corpo da mensagem → `<a href target="_blank"
  rel="noopener noreferrer">` — sempre os dois atributos, sem exceção;
- Só o **primeiro link** da mensagem dispara prévia (como o WhatsApp).

### 8.2 Prévia no compositor (antes de enviar) — com opção de dispensar

Como o WhatsApp Web: o cartão aparece **enquanto o operador digita**, e o **×**
envia o link puro, sem prévia.

- **Detecção:** `findUrls(composerText)[0]` — só o primeiro link, memoizado no texto;
- **Debounce de 400 ms** antes de chamar a API — poupa a retaguarda a cada tecla;
- **Cache de sessão reutilizado** (`previewCache`): o link que já tem cartão na
  conversa não custa rede de novo; falha vira `null` cacheado e o cartão some
  sem resíduo;
- **Estado de dispensa por URL:** o × guarda a URL dispensada; o cartão volta
  automaticamente quando o primeiro link do texto **muda**. Com anexo pendente
  (legenda), o cartão não aparece — legenda não gera prévia;
- **Dispensa atravessa a cadeia inteira:** `sendMessage(id, text, mentions?,
  linkPreview?)` → body da API → comando `message.send` do transporte interno →
  `sendText` do worker → body da WAHA. Só o `false` viaja; omitido, a prévia
  segue ligada (default do WhatsApp);
- **Disciplina de aridade:** sem dispensa e sem menção, a chamada segue de 2
  argumentos, como sempre foi — argumento a mais (nem `undefined`) quebraria os
  espiões dos testes que conferem a chamada exata.

### 8.3 Envio com prévia nativa

- `POST /api/sendText` com `linkPreview: true` e `linkPreviewHighQuality: true` —
  a WAHA gera a prévia como o cliente WhatsApp faria;
- **Operador dispensou no compositor → `linkPreview: false`**, e nem a versão de
  alta qualidade é pedida.

### 8.4 Retaguarda de prévia (para quando a nativa não existe)

> Não há endpoint WAHA para prévia de URL arbitrária e
> `/api/send/link-custom-preview` não roda no engine WEBJS — a retaguarda é própria.

Endpoint: `GET /api/v1/link-preview?url=...`

Pipeline:

1. **`safeTarget`** (guarda de SSRF, §9);
2. Cache em memória (Map, LRU por ordem de inserção, **máx. 500 entradas**):
   - sucesso: **TTL 6 h**; falha: **TTL 10 min**; **400 nunca é cacheado** (URL
     bloqueada é erro do pedido, não do destino);
3. `fetch` da página: **timeout 8 s**, **máx. 2 redirects manuais** (cada
   `Location` é resolvido contra a URL corrente e **repassa por `safeTarget`**),
   corpo truncado em **1,5 MB**;
4. Extrai metadados OG/Twitter (`title`, `description`, `image`, `site_name`,
   favicon). Sem nenhum dos três principais → **422** `A página não tem
   informações para gerar a prévia`;
5. Truncamentos: título 500 chars, descrição 2 000, siteName 240;
6. **`providerFromHostname`** identifica o provedor (youtube, tiktok, github,
   spotify, instagram, facebook, figma, notion, google-drive, dropbox, generic) —
   o dashboard usa isso para a cor da borda do cartão;
7. **Enriquecimento oEmbed** (timeout próprio de 4 s): YouTube
   (`youtube.com/oembed`) e TikTok (`tiktok.com/oembed`);
8. Validação final com `linkPreviewSchema` (Zod) antes de responder.

### 8.5 Layout do cartão (a correção de "qualidade")

O cartão usa **layout compacto com miniatura lateral** (≈ 92 px na conversa,
≈ 72 px no compositor), como o WhatsApp Web. A tentação é um banner largo com
`width: 100%` — **não faça**: a imagem que o provedor devolve é pequena, e
esticada num banner de 360 px ela parece "baixa resolução". Renderizada no
tamanho certo, a mesma imagem fica nítida. Sem imagem, o corpo ocupa o cartão
inteiro (flex, não grid fixa).

---

## §9 — Segurança

| Ameaça | Defesa implementada |
|---|---|
| **SSRF** na prévia de link | Só `http:`/`https:`; host bloqueado se: `localhost`, `*.localhost`, `*.local`, `*.internal`, `::`, `::1`, `fe80:*`, `fc*/fd*` (ULA), IPv4-mapped IPv6, e IPv4 nas faixas `0.x`, `10.x`, `127.x`, `172.16–31.x`, `192.168.x`, `169.254.x`. A URL WHATWG normaliza IPv4 alternativo (`0x7f.1`, `2130706433`) antes da checagem. **Revalidado a cada redirect.** |
| Path traversal no storage | Filename passa por allowlist `A-Za-z0-9._-` (§5); path contém UUID imprevisível |
| Arquivo mascarado | Magic bytes para todas as famílias conhecidas (§3); texto não pode ter NUL |
| XSS via SVG | SVG nunca renderiza como imagem inline — documento ou texto-fonte |
| Tabnabbing nos links | `target="_blank"` + `rel="noopener noreferrer"` sempre |
| Vazamento de dados do cliente | Filename nunca em logs; erro de storage devolve 503 genérico ao cliente e loga só campos estruturados (`statusCode`, `providerError`, `mimeType`) |
| URL de staging vazada | Signed URL de **300 s**; objeto removido na confirmação ou no sweep de 24 h |
| Mensagem duplicada | `clientRequestId` idempotente + `claim` atômico + sem retry após falha incerta |
| Bucket fechado por engano | Restrição de mime do Storage é camada extra — ver §10 |

---

## §10 — ❓ SQL do banco de dados (PASSO DE CONFIRMAÇÃO — leia antes)

> **PERGUNTA PARA VOCÊ, DONO DO SISTEMA:**
> *"Deseja realmente aplicar isto no meu banco de dados, para conseguir enviar e
> receber todos os tipos de arquivo desta spec?"*
>
> **Responda SIM antes de executar.** Sem este passo, o bucket continua com a
> lista antiga de mimes (só imagem/áudio/vídeo/pdf) e o Storage **rejeita os
> tipos novos** (`text/markdown`, `application/zip`, etc.) com erro que a API
> converte em `503 Temporary attachment storage is unavailable` — mesmo com todo
> o código correto. Foi exatamente o sintoma observado na validação desta feature.
>
> **O que faz:** remove a restrição de mime do bucket de anexos temporários,
> alinhando o Storage à policy da aplicação (qualquer documento até 50 MB).
> **Não altera schema, não cria tabela, não mexe em dados** — só configuração do
> bucket. A validação de tipo continua existindo na aplicação (§2 e §3); o bucket
> deixa de ser uma segunda trava desalinhada.

```sql
-- Passo 1: remover a restrição de mime do bucket de anexos temporários
UPDATE storage.buckets
SET allowed_mime_types = NULL
WHERE id = 'chatpro-temporary-attachments';

-- Passo 2: verificação — deve retornar allowed_mime_types = NULL
SELECT id, allowed_mime_types, file_size_limit
FROM storage.buckets
WHERE id = 'chatpro-temporary-attachments';
```

**Notas para o outro sistema:**

- Se o bucket do seu sistema tiver outro nome, troque o `id`;
- Garanta também que `file_size_limit` do bucket ≥ 50 MB (ou ajuste ao seu teto);
- Execute no SQL Editor da **mesma instância** que a API usa (`SUPABASE_URL`);
- Não é migration versionada — é configuração operacional do bucket. Documente
  no runbook de setup do ambiente para novos deploys não nascerem com a trava.

---

## §11 — Checklist de replicação no outro sistema

**Contratos / validação**
1. [ ] Schema Zod do anexo e do `linkPreview` (url, domain, title?, description?,
       imageUrl?, siteName?, faviconUrl?, provider);
2. [ ] Tipos do job de outbox (§6.5) e enum de status.

**API**
3. [ ] Policy de 4 kinds com catch-all `document` (§2) — ordem: classificar →
       tamanho (413) → magic bytes (400);
4. [ ] Tabela de magic bytes (§3) com as pegadinhas de ordem (epub, svg);
5. [ ] Mime canônico por extensão (§4) + sanitização de filename (§5);
6. [ ] Outbox persistida: idempotência por `clientRequestId`, `claim` atômico,
       dispatch só do job recém-criado, reconcile no startup, sweep 24 h;
7. [ ] Storage staging: path `{ws}/{conv}/{uuid}/{filename}`, signed URL 300 s,
       erro → 503 genérico + log estruturado;
8. [ ] Endpoint de prévia de link com `safeTarget` (SSRF), cache LRU 500
       (6 h/10 min), 2 redirects revalidados, 8 s timeout, 1,5 MB de corpo,
       OG/Twitter + oEmbed (YouTube/TikTok).

**Worker / provedor**
9. [ ] Roteamento WAHA: `sendImage` / `sendVoice` (voiceNote) / `sendVideo` /
       **`sendFile` para todo o resto**;
10. [ ] `sendText` com `linkPreview: true` + `linkPreviewHighQuality: true` por
        padrão, e **`linkPreview: false` quando o operador dispensou** a prévia
        no compositor (a flag atravessa: comando interno → provider → cliente WAHA);
11. [ ] Webhook de confirmação → `confirmed` + remoção do objeto;
12. [ ] Extração de `_data` no recebimento com `safeParse`.

**Frontend**
13. [ ] Upload via **XHR** (não fetch) com `upload.onprogress` + barra visual;
14. [ ] `accept="*/*"`; GIF colado/arrastado anexa como documento;
15. [ ] Cartão de documento: etiqueta/ton por `documentKind` (extensão → mime),
        ações abrir/visualizar/baixar, prévia de texto inline (md/json/csv/xml/txt);
16. [ ] Linkify com `noopener noreferrer`; cartão de prévia do primeiro link com
        **layout compacto de miniatura lateral** (§8.5); **prévia no compositor
        antes de enviar** (§8.2): debounce 400 ms, cache de sessão, × que
        dispensa por URL e envia `linkPreview: false`, cartão oculto com anexo
        pendente, aridade exata nas chamadas (sem argumento `undefined` a mais).

**Infra (passo de confirmação!)**
17. [ ] **❓ SQL do §10 — perguntar ao dono antes de aplicar** (`allowed_mime_types
        = NULL` + `file_size_limit` adequado);
18. [ ] Variáveis: URL/chave service-role do Storage, segredo do transporte interno.

**Testes mínimos**
19. [ ] Policy: pdf/zip/mp4 classificam certo; 413 acima do teto; 400 em magic
        bytes errado; catch-all aceita extensão desconhecida;
20. [ ] Outbox: idempotência, claim único sob concorrência, reconcile, sweep,
        503 seguro sem dispatch quando o storage falha;
21. [ ] Prévia de link: SSRF bloqueia IPs privados e redirect interno; cache
        hit/TTL; 422 sem metadados; oEmbed enriquece;
22. [ ] UI: barra de progresso, linkify seguro, cartão por tipo, prévia de texto.

---

## §12 — Limitações conhecidas (registradas de propósito)

- **50 MB** vs teto real do WhatsApp (2 GB para documentos): limitação atual da
  stack (bucket + WAHA), documentada — ver backlog do §0;
- **Cache de prévia em memória**: reiniciar a API limpa; persistir exigiria
  tabela nova (fora de escopo sem solicitação);
- **Páginas atrás de login** não geram prévia (a retaguarda não tem sessão);
- **`.fig` → octet-stream** é decisão explícita, não descuido;
- **Sem retry** de anexo após falha incerta do provider: preferível falhar
  visível a duplicar mensagem no WhatsApp do cliente;
- **Prévia nativa WAHA depende do engine** — no WEBJS, `link-custom-preview`
  não roda; por isso a retaguarda própria existe.

---

*Spec gerada a partir da implementação T4 do ChatPro (branch `feat/replace-repository-with-chatpro`),
validada com 530 testes de API, 100 de worker, 8 de contratos e 706 de dashboard.*
