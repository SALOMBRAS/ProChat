# PR de Passagem de Contexto — T4: Documentos, Arquivos e Links

**Data de escrita:** 05/08/2026 (~18h UTC)
**Autor:** agente anterior da feature T4
**Destinatário:** próximo engenheiro/agente que continuar esta feature
**Estado da feature:** código + testes unitários concluídos; faltam auditoria final, build raiz, validação manual em aparelho real e um SQL manual do usuário (ver §13 e §14).
**Regra de leitura:** este documento NÃO resume. Ele reproduz tudo o que foi investigado, decidido e implementado, para que nenhuma investigação precise ser refeita. Se algo aqui divergir do código, o código vence — mas até 05/08/2026 ~15:10 tudo aqui foi conferido contra o working tree.

> **Aviso de atribuição (CRÍTICO):** o working tree contém, além do T4, WIP **estrangeiro** de outro processo (features "openConversation / Conversar", "message reactions", "contact sync", mudanças no ContactPicker). Tudo que é T4 está documentado em profundidade aqui; tudo que é estrangeiro está **listado e separado arquivo a arquivo** na seção §4b, sem documentação em profundidade. Não misture os dois ao revisar, testar ou dar merge.

---

## 1. visao_geral

### 1.1 Objetivo da feature

A T4 entrega à inbox do ChatPro a mesma experiência de documentos, arquivos e links que o WhatsApp oferece:

1. **Documento de qualquer formato** — enviar qualquer arquivo como documento (não só PDF/TXT/DOCX/XLSX/ZIP), até 50 MB, com o mimetype correto chegando ao destinatário mesmo quando o navegador não conhece o tipo.
2. **Cartão de documento rico** — etiqueta por tipo real (PDF, XLS, APK, PSD…), miniatura nativa do WhatsApp quando existe (ex.: primeira página de PDF), ações de abrir no navegador / visualizar texto / baixar com barra de progresso.
3. **Links vivos** — URLs no texto da mensagem viram âncoras clicáveis, e o primeiro link da mensagem ganha um cartão de prévia, com a mesma prioridade do WhatsApp: prévia nativa gerada pelo remetente → prévia persistida dos nossos envios → raspagem OG/oEmbed como retaguarda.
4. **Upload com progresso** — o operador vê a porcentagem do upload no chip do anexo pendente (XHR, porque `fetch` não relata progresso de upload).

### 1.2 Problema que existia antes

- A `policy` de documentos da API (`attachment-outbox.service.ts`) tinha uma allowlist de **6 mimetypes** e teto de **25 MB**. Um `.rar`, `.7z`, `.apk`, `.psd`, `.md`, `.json` ou qualquer formato fora da lista voltava **415 "Tipo de arquivo não permitido"** — comportamento mais restrito que o próprio WhatsApp, que anexa qualquer arquivo.
- Pior: a allowlist da aplicação aceitava ZIP, mas o bucket Supabase `chatpro-temporary-attachments` **não tem ZIP** nos seus 13 `allowed_mime_types` (migration `supabase/migrations/011_inbox_outbox_attachments.sql`) — ou seja, ZIP já passava nas 3 validações da API e explodia num 503 opaco no upload do Storage. Bug conhecido e documentado em `docs/anexos-pendencias.md` §1, **ainda não corrigido** (exige SQL manual, ver §13/§14).
- Quando o navegador declarava `application/octet-stream` (ou nada) para um `.apk`/`.fig`/`.md`, o outbox gravava o mime mentiroso/vazio e a WAHA o entregava assim ao WhatsApp: o arquivo chegava ao destinatário **sem identidade nenhuma**.
- Mensagens com links chegavam como texto puro: sem âncora, sem prévia — nem a prévia nativa que o WhatsApp já gera e já viaja dentro do payload `_data` das mensagens era aproveitada.
- Upload de anexo não tinha feedback de progresso; download de documento era um clique cego (sem saber se o arquivo ainda existia, sem barra).
- Documentos baixavam mesmo quando o navegador poderia abri-los em aba (PDF/TXT/MD/JSON/XML/SVG/CSV), impondo o ciclo baixar-abrir-apagar a cada conferida.

### 1.3 Comportamento esperado (o que a feature entrega)

- Qualquer arquivo anexável como documento até 50 MB (teto da nossa infra: multer 50 MB + bucket 50 MB; o produto WhatsApp aceitaria 2 GB).
- Formatos de assinatura conhecida passam por verificação de *magic bytes* (PDF, família ZIP incl. APK/EPUB/DOCX/XLSX/PPTX, OLE2 doc/xls/ppt, RAR, 7Z, PSD, PostScript/AI, textos sem NUL); formato desconhecido entra **sem checagem** — paridade com o WhatsApp, que manda o arquivo do jeito que veio.
- O mime gravado no job do outbox é o **canônico**: se o navegador mandou octet-stream/vazio, resolve pela extensão do nome sanitizado via `documentExtensionMimes` (21 extensões mapeadas).
- Texto com link: o envio pede à WAHA a prévia nativa (`linkPreview: true, linkPreviewHighQuality: true`), o WhatsApp gera e devolve no `sentMessage._data`, o worker extrai, a API persiste em `metadata.linkPreview` e o dashboard desenha o cartão sem custo de rede.
- Recebidas com link: a prévia nativa já vem no `_data` (`title`, `description`, `canonicalUrl`/`matchedText`, `thumbnail` base64) e já chega ao dashboard via `payload_json` → `metadata` — **sem nenhuma mudança de schema**.
- Sem prévia nativa, o dashboard consulta `GET /api/v1/inbox/link-preview?url=…`, que raspa OG/Twitter Cards/oEmbed com guarda de SSRF, cache em memória (6 h sucesso / 10 min falha, 500 entradas) e enriquecimento YouTube/TikTok/GitHub.
- Documento no dashboard: cartão com etiqueta de tipo (extensão primeiro, mime de retaguarda), miniatura nativa quando existe, "Abrir" ↗ em nova aba para tipos navegáveis, "Visualizar" ≡ com o conteúdo de texto numa janela modal (mesma moldura da imagem ampliada), download ⇩ com barra de progresso e fallback para a âncora nativa quando o fetch é bloqueado (CORS da URL assinada).
- Upload: barra fina de progresso no chip do anexo pendente, "Enviando… N%" → "Anexo em processamento…".

### 1.4 Como funciona neste momento (estado real verificado)

Tudo da seção 1.3 está **implementado e coberto por testes unitários**, que passam onde o WIP estrangeiro não interfere:

- **Contracts:** typecheck 0 erros, 5/5 testes.
- **API:** 493 testes passando, EXCETO 11 falhas em `open-conversation.test.ts` e `inbox-open-conversation.test.ts` — **falhas do WIP estrangeiro, idênticas à baseline pré-T4**. Typecheck da API: 30 erros, **todos em arquivos do WIP estrangeiro** (nenhum em arquivo T4): o estrangeiro adicionou `findDirectByChatId` à interface `ConversationStore` em `waha-webhook.service.ts` sem implementá-lo nas stores (TS2420/TS2345), o que também quebra o typecheck do worker pela cadeia de import de `apps/worker/src/main.ts:44`.
- **Worker:** 92/92 testes passando; typecheck quebrado **apenas** pela causa estrangeira acima.
- **Dashboard:** `npx tsc --noEmit` limpo; `npm test` → 33 arquivos, **654/654 testes passando** (verificado em 05/08/2026 ~15:10).
- **Build raiz (`npm run build`): NÃO foi rodado ainda.**
- `git diff --check` limpo (reportado pelo agente de backend).

### 1.5 O que falta (resumo; detalhe em §13)

1. SQL manual do usuário no Supabase (bucket `allowed_mime_types = NULL`) — **bloqueante para formatos novos em produção** (sem isso, 503 opaco, igual ao bug do ZIP).
2. `npm run build` na raiz — nunca rodado com o conjunto T4+estrangeiro.
3. Passada final de auditoria técnica (gargalos, duplicações, código morto, concorrência, regressões) — passo 7 do plano.
4. Atualização de `docs/anexos-pendencias.md` (o item §1 do ZIP muda de natureza depois desta feature).
5. Validação manual em aparelho real (envio/recebimento via WhatsApp real) — roteiro completo em §15.
6. Coordenação de merge com o WIP estrangeiro (ele quebra typecheck compartilhado API+worker).

---

## 2. arquitetura

### 2.1 Visão de alto nível

```
DASHBOARD (React)                API (Express)                  WORKER                WAHA (WEBJS)            SUPABASE
─────────────────                ───────────────                ──────                ────────────            ────────
Anexo → FormData ──multipart──▶ multer (mem, 50MB, 1 arquivo)
                               ▶ validateFile (policy+magic)
                               ▶ canonicalDocumentMime
                               ▶ outbox.create → job row ───────────────────────────────────────────────▶ inbox_outbox_jobs
                               ▶ storage.upload ────────────────────────────────────────────────────────▶ bucket chatpro-temporary-attachments
                               ▶ dispatch: signedUrl(300s) ──▶ message.sendAttachment ──▶ WAHA /api/sendFile (baixa a URL assinada)
XHR upload progress ◀── onprogress (xhr.upload)

Texto com link ────────────────▶ InternalInboxService.send
                               ▶ message.send ──────────────▶ WahaHttpClient.sendText
                                                              linkPreview:true, linkPreviewHighQuality:true ──▶ POST /api/sendText
                               ◀ sentMessage{ id, timestamp, linkPreview? } ◀── extrai _data{title,description,thumbnail,canonicalUrl,matchedText}
                               ▶ recordOutbound(payload={ linkPreview }) ──────────────────────────────────▶ whatsapp_messages.payload_json

Recebidas ◀── SSE/realtime ◀── waha_webhook_events → ingest → whatsapp_messages.payload_json (contém _data com prévia nativa e jpegThumbnail de PDF)

Dashboard renderiza:
  metadata.linkPreview (nossos envios) → metadata._data (recebidas) → GET /api/v1/inbox/link-preview (retaguarda OG/oEmbed, SSRF-guard, cache 6h/10min)
Download: GET /inbox/messages/:id/media/access → { url: signed(300s) | /inbox/messages/:id/media?access_token=… } → fetch+stream→Blob→objectURL (barra) ou âncora nativa (fallback)
```

### 2.2 Fluxo: envio de documento (dashboard → contato)

1. **Intake no dashboard** (`apps/dashboard/src/ui/attachmentIntake.ts`): colar/arrastar/seletor produz `File`s. `attachmentKind(mime)` agora **sempre** devolve um tipo: o que não é imagem/áudio/vídeo da allowlist é `document`. `acceptAttachment` rejeita apenas: vazio (`reason: "empty"`), acima do teto da família (`reason: "size"`) e bytes mentirosos quando a assinatura é conhecida (`reason: "magic"`). Não existe mais `reason: "type"`.
2. **Envio** (`Inbox.tsx` `send` → `InboxApi.sendAttachment`): monta `FormData` (`file`, `clientRequestId` UUID, `caption` opcional, `voiceNote` opcional) e, **como agora recebe `onProgress`**, troca o transporte de `postForm` (fetch) para `postFormProgress` (XHR) — único caminho com `xhr.upload.onprogress`.
3. **API** (`POST /api/v1/inbox/conversations/:conversationId/attachments`): multer `memoryStorage`, `limits: { fileSize: 50MB, files: 1 }`, `defParamCharset: 'utf8'` (preserva acentos no `originalname`). `attachmentRequest` (zod) valida `clientRequestId`/`caption`/`voiceNote`.
4. **Outbox** (`AttachmentOutboxService.create`): `validateFile` (tipo + tamanho + magic bytes); `sanitizeFilename` (NFKD, ASCII, 180 chars, extensão preservada); **mime persistido = `canonicalDocumentMime(filename, file.mimetype)`**; cria a linha `pending` em `inbox_outbox_jobs` (idempotência por `clientRequestId`); faz `storage.upload` para `chatpro-temporary-attachments` no path `{workspaceId}/{conversationId}/{jobId}/{filename}`; **este processo só despacha o job que ele mesmo persistiu**.
5. **Dispatch** (mesmo processo, após persistir): `claim` → `storage.signedUrl(path, 300)` (300 s) → comando interno `message.sendAttachment` para o worker → WAHA `POST /api/sendFile` com `{ file: { url, mimetype, filename }, caption? }` — a WAHA baixa a URL assinada e entrega ao WhatsApp. **A WAHA não tem restrição de mimetype no `/api/sendFile`** (auditado).
6. **Confirmação**: webhook `message.ack`/eco confirma (`attachments.confirm`) e o objeto temporário é removido; uma varredura horária (`cleanupExpired`) limpa restos.
7. **Sem retry** — decisão deliberada (reenvio sem saber se o provedor aceitou duplicaria a mensagem); documentado em código, teste e `docs/anexos-pendencias.md` §2.

### 2.3 Fluxo: envio de texto com link (prévia nativa + persistência)

1. Dashboard `sendMessage` → API `InternalInboxService.send` → comando interno `message.send`.
2. Worker `WahaHttpClient.sendText` chama `POST /api/sendText` com **`linkPreview: true, linkPreviewHighQuality: true`** (camelCase; o default da WAHA já gera prévia, o parâmetro torna explícito; `HighQuality` é melhor esforço no engine WEBJS).
3. O WhatsApp gera a prévia **no cliente remetente** (raspando OG/HTML — não oEmbed) e a WAHA devolve o material no `_data` da mensagem enviada: `title`, `description`, `thumbnail` (base64), `matchedText`, `canonicalUrl`, `links[]`.
4. `nativeLinkPreview()` do worker extrai: `url = canonicalUrl ?? matchedText ?? primeiraUrlHttpDoTexto`; `imageUrl = thumbnail` (prefixa `data:image/jpeg;base64,` se não vier como data URL). Sem título, descrição e thumbnail → sem prévia (estado normal, não erro).
5. `WahaProvider.sendText` valida a prévia com `linkPreviewSchema.safeParse` — **prévia inválida é descartada, não derruba o envio**.
6. O `sentMessage` agora carrega `linkPreview` pelo transporte interno (contrato admite; ver §4.1).
7. API `InternalInboxService.deliver`: o `outbound.payload` do `send()` é uma **função do sentMessage** — `payload: sent => (sent.linkPreview ? { linkPreview: sent.linkPreview } : undefined)` — avaliada **depois** da resposta do worker, e persistida via `recordOutbound({ …, payload })` → `payload_json` → `metadata.linkPreview`. Texto sem URL volta sem prévia e **nenhum payload é gravado** (teste fixa isso).
8. Dashboard lê `metadata.linkPreview` e desenha o cartão sem rede.

### 2.4 Fluxo: recebimento (webhook → dashboard)

1. WAHA emite webhook (`message`/`message.any`) → `WahaWebhookController` → `WahaWebhookService.persistEvent` → linha em `waha_webhook_events` (`payload_json` sanitizado) e em `whatsapp_messages` (`payload_json` com o payload completo, incluindo `_data`).
2. **Nenhuma mudança de schema foi necessária**: o `_data` cru do whatsapp-web.js já traz `title`, `description`, `matchedText`, `canonicalUrl`, `thumbnail` (base64) e, para PDFs recebidos, `jpegThumbnail`/`thumbnail` da primeira página.
3. `listMessages` (Supabase e SQLite) mapeia `metadata: row.payload_json` — o dashboard já recebia `_data`; a T4 só passou a **ler** dele (`nativeLinkPreview` no dashboard, `documentThumbnail`, `wahaMime`).

### 2.5 Fluxo: download / acesso a mídia

1. Dashboard `Media` pede `api.mediaUrl(messageId)` → `GET /inbox/messages/:messageId/media/access`:
   - se há `storagePath` (mídia permanente persistida): devolve `{ url: signedUrl(permanente), expiresAt: now+300s }`;
   - senão: emite token de acesso e devolve `{ url: /api/v1/inbox/messages/:id/media?access_token=…, expiresAt }` — o endpoint `/media` faz proxy/stream da WAHA (ou redireciona 302 para a URL assinada permanente), com suporte a HEAD e Range.
2. Download com barra (`downloadWithProgress` em `messageMedia.ts`): `fetch(url)` → `content-length` (ou `mediaSize` conhecido) → leitura do `reader` em blocos acumulando porcentagem → `Blob` → `saveBlob` (objectURL + âncora `download` + revoga após 1 s). Sem stream ou sem comprimento declarado: barra indeterminada, download acontece. **Se o fetch falhar (URL assinada sem CORS), cai na âncora nativa** — perde a barra, não o download.
3. Antes do download, `useMediaFailure.classify()` faz **uma** sondagem (HEAD) ao proxy: 404 = arquivo descartado de vez (`MediaGone`), qualquer outro erro = transitório. A sondagem é memoizada por URL (a promessa fica guardada — quem clica espera a mesma pergunta). É o anti-N+1 do projeto: nada é sondado no render.

### 2.6 Fluxo: prévia de link (prioridade de 3 níveis)

A prioridade é **a do próprio WhatsApp** — o remetente gera a prévia e ela viaja dentro da mensagem:

1. **`metadata.linkPreview`** — nossos envios (persistido pela API a partir do `_data` do `sendText`; ver §2.3). Custo de rede: zero.
2. **`metadata._data`** — recebidas (payload cru do whatsapp-web.js; ver §2.4). Custo de rede: zero.
3. **`GET /api/v1/inbox/link-preview?url=…`** — retaguarda raspada pela API (OG/Twitter/oEmbed/GitHub API), com guarda de SSRF e cache. Só é chamada quando não há nativa **e** há URL no texto. No cliente, `cachedLinkPreview` guarda **a promessa** num `Map` de sessão (dez mensagens com o mesmo link = uma busca; falha também é cacheada como `null`).

O componente `LinkPreview` mostra **no máximo um cartão por mensagem** (o do primeiro link), como o WhatsApp. Busca que falha não deixa resíduo: o texto linkado permanece, o cartão some.

### 2.7 Fluxo: upload com progresso

`Inbox.tsx` mantém `uploadProgress: number | undefined` (0–100; `undefined` fora de envio). Ao enviar anexo, passa o callback como **6º argumento** de `sendAttachment`, que troca o transporte para `ApiClient.postFormProgress` (XHR): `xhr.upload.onprogress` → `Math.min(100, Math.round(loaded/total*100))` (só quando `lengthComputable && total > 0`). O chip do anexo pendente mostra a barra: `<100` → "Enviando… N%"; `100` → "Anexo em processamento…" (a WAHA ainda está aceitando o arquivo). Erro/fim limpa o estado. Sem callback, `sendAttachment` segue no `postForm` de sempre (compatibilidade preservada, testada).

### 2.8 Fluxo: URLs no texto (linkify)

`linkify(content)` (em `LinkPreview.tsx`) usa `findUrls` (regex `https?://[^\s<>"']+`, até 32 URLs, sem repetição, aparando pontuação final e parêntese excedente da frase — parêntese balanceado de URL estilo Wikipédia é mantido). O texto é quebrado em nós: trechos puros seguem texto puro (sem risco de XSS — nada vira HTML), cada URL vira `<a class="message-link" target="_blank" rel="noopener noreferrer">`. As quebras de linha continuam sendo do `white-space: pre-wrap` do balão.

---

## 3. exploracao_realizada

Tudo que foi lido/auditado durante a feature, com o porquê e o que se concluiu. **Não refaça esta exploração** — as conclusões estão aqui; os arquivos mudaram exatamente como a §4 documenta.

### 3.1 Arquivos do repositório analisados

- **`apps/api/src/services/attachment-outbox.service.ts`** — coração da política de anexos. Achados: `policy` por `AttachmentKind` com allowlist de mimes e teto; `validateFile` rejeitava com 415 o que não estava na lista; `magicMatches` só conhecia jpeg/png/webp/ogg/mpeg/mp4/webm/pdf/zip/texto; `sanitizeFilename` (NFKD → ASCII, `[^A-Za-z0-9._-]+` → `-`, teto 180, extensão ASCII preservada, fallback `attachment`); fluxo create→store→upload→dispatch com signed URL de 300 s; `startupCutoff` e `claim` garantindo que cada processo só despacha o próprio job; falha é terminal por decisão (sem retry). Decisão T4: documento vira catch-all (`mimes: null`), teto 50 MB, magic bytes só para assinaturas conhecidas, mime canônico por extensão.
- **`apps/worker/src/waha-client.ts`** — cliente HTTP da WAHA. Achados: `sendText` chamava `/api/sendText` sem parâmetros de prévia; `sendAttachment` roteia por tipo (`sendImage`/`sendVoice`/`sendVideo`/`sendFile`) sem restrição de mime no `sendFile`; `messageId()` extrai id de várias formas de resposta. Decisão T4: pedir prévia nativa e extrair do `_data`.
- **`apps/api/src/services/waha-webhook.service.ts`** — ingest do webhook e stores de conversa. Achados: `payload_json` guarda o payload completo (incl. `_data`) tanto em `waha_webhook_events` quanto em `whatsapp_messages`; `listMessages` mapeia `metadata: row.payload_json` (Supabase) — ou seja, **a prévia nativa e a miniatura de PDF já chegavam ao dashboard**, só ninguém as lia. `recordOutbound` aceita `payload` e o devolve como `metadata`. Decisão T4: zero mudança aqui (as mudanças presentes neste arquivo são **estrangeiras** — ver §4b).
- **`apps/api/src/services/internal-inbox.service.ts`** — orquestra envios da inbox. Achados: `deliver` centraliza conversa→worker→persistência→realtime; `outbound.payload` era um valor estático gravado em `metadata`. Decisão T4: permitir payload como **função do sentMessage**, porque a prévia nativa só existe depois que o worker envia.
- **`apps/dashboard/src/ui/Inbox.tsx`** — inbox/compositor. Achados: `MessageBubble` renderizava `message.content` como texto puro; chip de anexo pendente sem progresso; seletor de documento limitado a `.pdf,.doc,.docx,.xls,.xlsx,.txt`. Decisão T4: linkify + `<LinkPreview>` + barra de upload + `accept="*/*"` para documento.
- **`apps/dashboard/src/ui/MessageMedia.tsx`** — cartões de mídia. Achados: `DocumentMessage` era uma âncora única (clique → sondagem HEAD → clique repassado); `useMediaFailure` memoiza a sondagem por URL; `MediaGone` cobre o arquivo descartado; `ImageMessage` já tinha a janela modal `.media-modal-backdrop`. Decisão T4: cartão rico (div), ações abrir/visualizar/baixar, barra de download, miniatura nativa, prévia de texto **reusando a moldura da janela da imagem**.
- **`apps/dashboard/src/ui/messageMedia.ts`** — leitores puros de mensagem/mídia. Achados: `documentKind` reconhecia 6 famílias e olhava o mime **antes** da extensão; base real medida: 88 de 89 documentos sem `media_filename` (mime em `_data.mimetype` é a retaguarda que salva). Decisão T4: extensão primeiro (é o que o operador vê), mime de retaguarda, 20+ etiquetas, `documentThumbnail`, `browserOpenable`, `textPreviewable`, `formatTextPreview`, `downloadWithProgress`.
- **`apps/dashboard/src/ui/attachmentIntake.ts`** — intake colar/arrastar, espelho client-side da `policy`. Achados: `attachmentKind` podia devolver `undefined` (rejeição por tipo); `readTransfer` separava `rejected` por formato; `magicMatches` lia 4 KB e devolvia `false` para desconhecidos. Decisão T4: espelhar o catch-all — nada é recusado por formato; `rejected` fica vazio de propósito (a mensagem antiga de "formato não aceito" não pode reaparecer).
- **`apps/dashboard/src/api/client.ts`** — fronteira HTTP. Achado: `fetch` não expõe progresso de upload → decisão: `postFormProgress` com XHR, mesma fronteira e mesmos `ApiError` do `request` (REQUEST_FAILED/API_UNAVAILABLE/TIMEOUT, fases `parse`/`fetch`/`timeout`/`abort`, sufixos DEV).
- **`apps/dashboard/src/api/inbox.ts`** — fachada da inbox. Achados: `sendAttachment` via `postForm`; não havia `linkPreview`. Decisão T4: 6º parâmetro `onProgress` (troca transporte) e `linkPreview(url)` GET com `encodeURIComponent`.
- **`packages/contracts/src/index.ts`** — contratos zod compartilhados. Achado: variante `sentMessage` do `internalTransportDataSchema` era `{ id?, timestamp, pending? }`. Decisão T4: `linkPreviewSchema` novo + `linkPreview` opcional no `sentMessage`.
- **`supabase/migrations/011_inbox_outbox_attachments.sql`** — bucket `chatpro-temporary-attachments`: privado, `file_size_limit = 52428800` (50 MB), `allowed_mime_types` fixo com 13 tipos **sem ZIP**. Conclusão: qualquer tipo novo de documento esbarra no bucket com 503 opaco — e ZIP **já** esbarra hoje. AGENTS.md (REGRA 1) proíbe o agente de escrever no Supabase → a correção é SQL **manual** do usuário (§13/§14).
- **`docs/anexos-pendencias.md`** — confirma o bug do ZIP (§1) e a ausência deliberada de retry (§2). Pendente de atualização após esta feature (§13).
- **`docker-compose.waha.yml`** — WAHA `devlikeapro/waha:latest-2026.7.1`, engine `WEBJS`, porta `127.0.0.1:3002`, `WHATSAPP_DOWNLOAD_MEDIA=true`, sem `env_file` (chaves interpoladas por nome). Usada na auditoria de capacidades.

### 3.2 Auditoria WAHA / WhatsApp (feita; fontes: docs waha.devlike.pro, código do whatsapp-web.js, pesquisa de protocolo)

Conclusões verificadas — **não re-audite**:

1. **WAHA `devlikeapro/waha:latest-2026.7.1`, engine WEBJS**, rodando local em `http://127.0.0.1:3002` (healthy).
2. `POST /api/sendText` suporta **`linkPreview: true` + `linkPreviewHighQuality: true`** (camelCase). O default já gera prévia; os parâmetros tornam explícito e pedem qualidade alta (melhor esforço no WEBJS).
3. **Não existe endpoint WAHA para obter a prévia de uma URL arbitrária.** `/api/send/link-custom-preview` **NÃO** é suportado no engine WEBJS. Por isso a retaguarda OG própria (`link-preview.service.ts`) existe.
4. Mensagens recebidas com link carregam a **prévia nativa no `_data`** (raw whatsapp-web.js): `title`, `description`, `matchedText`, `canonicalUrl`, `thumbnail` (base64), `links[]`. Esse `_data` já chega ao dashboard via `payload_json` → `metadata` — **sem mudança de schema**.
5. O WhatsApp gera a prévia **no cliente remetente**, raspando OG/HTML da página (**não oEmbed**) e anexando-a à mensagem. Nossa retaguarda OG espelha esse comportamento. oEmbed é usado por nós **só como enriquecimento** (autor/thumbnail de YouTube/TikTok); GitHub via `api.github.com/repos/{owner}/{repo}`.
6. `POST /api/sendFile` **não tem restrição de mimetype**; o WhatsApp aceita qualquer arquivo como documento (limite de produto: 2 GB; nossa infra: multer 50 MB + bucket 50 MB).
7. PDFs recebidos podem trazer **`jpegThumbnail` (primeira página)** exposto em `_data.thumbnail`.
8. O bucket `chatpro-temporary-attachments` (migration 011) tem `allowed_mime_types` fixo (13 tipos, **sem ZIP**) — bloqueia os novos tipos de documento **e já bloqueia ZIP hoje** (bug conhecido em `docs/anexos-pendencias.md`). Correção = SQL manual do usuário:
   ```sql
   UPDATE storage.buckets SET allowed_mime_types = NULL
   WHERE id = 'chatpro-temporary-attachments';
   ```

---

## 4. implementacoes

Cada arquivo T4: motivo, antes, depois (nível de código), impacto, dependências, riscos. Arquivos mistos (T4 + estrangeiro) têm as duas partes separadas aqui — a parte estrangeira é só identificada, com detalhe na §4b.

### 4.1 `packages/contracts/src/index.ts` (modificado — T4 parcial; contém WIP estrangeiro)

- **Motivo T4:** a prévia precisa de um contrato único, válido nas três origens (nativa do `_data`, persistida em `metadata.linkPreview`, retaguarda OG) e transportável do worker para a API dentro do `sentMessage`.
- **Antes:** variante `sentMessage` do `internalTransportDataSchema` = `{ id?: string(1..200), timestamp: datetime, pending?: boolean }`. Não existia schema de prévia.
- **Depois (T4, e só isto é T4 neste arquivo):**
  - `linkPreviewProviderSchema = z.enum(['youtube','tiktok','github','spotify','instagram','facebook','figma','notion','google-drive','dropbox','generic'])` + `export type LinkPreviewProvider`.
  - `linkPreviewSchema = z.object({ url: z.string().min(1).max(2_048), domain: z.string().min(1).max(255).optional(), title: z.string().max(500).optional(), description: z.string().max(2_000).optional(), imageUrl: z.string().min(1).max(400_000).optional(), siteName: z.string().max(240).optional(), faviconUrl: z.string().url().max(2_048).optional(), provider: linkPreviewProviderSchema.optional(), author: z.string().max(240).optional(), durationSeconds: z.number().int().nonnegative().optional() })` + `export type LinkPreview`.
  - Comentário de bloco acima do schema fixando a **prioridade do WhatsApp**: remetente gera → viaja na mensagem (`_data.title/description/thumbnail/matchedText`) → WAHA devolve no `sendText` com `linkPreview` → só na ausência dos dois a API raspa OG/oEmbed. `imageUrl` aceita `data:` **de propósito** (a thumbnail nativa chega em base64; por isso é `z.string()` e não `z.string().url()`, com teto de 400 KB).
  - Variante `sentMessage` do `internalTransportDataSchema` agora: `{ id?, timestamp, pending?, linkPreview: linkPreviewSchema.optional() }`.
- **Impacto:** worker pode devolver a prévia dentro da resposta do `message.send` validada pelo contrato; API e dashboard compartilham o mesmo tipo `LinkPreview`.
- **Dependências:** nenhuma nova (zod já era a base).
- **Riscos:** nenhum identificado; aditivo e opcional. Clientes antigos ignoram o campo.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** `persistenceContactSchema` ganhou `photoUrl`/`whatsappName`/`whatsappPushName`/`whatsappId`; `messageReactionSchema` + `MessageReaction` novos; `inboxMessageSchema` ganhou `reactions`; `eventTypes` ganhou `'message.reaction.updated'`; `internalContactsPageCommandSchema` e `internalSendReactionCommandSchema` novos; `internalTransportCommandSchema` inclui `contacts.page` e `message.sendReaction`; `internalTransportDataSchema` inclui `contactsPage` e `reactionSent`.

### 4.2 `apps/api/src/services/attachment-outbox.service.ts` (modificado — 100% T4)

- **Motivo:** paridade WhatsApp para documentos (qualquer formato, 50 MB), magic bytes só onde há assinatura conhecida, e mime canônico para o arquivo não chegar sem identidade ao destinatário.
- **Antes:**
  - `policy.document = { mimes: ['application/pdf','application/zip','application/x-zip-compressed','text/plain','…wordprocessingml.document','…spreadsheetml.sheet'], max: 25MB }`.
  - `validateFile`: `find(kind => policy[kind].mimes.includes(file.mimetype))`; sem match → **415 "Tipo de arquivo não permitido"**.
  - `magicMatches` devolvia `false` para qualquer mime desconhecido.
  - Job gravava `mimeType: file.mimetype` (o que o navegador declarou — inclusive octet-stream/vazio).
- **Depois:**
  - `policy: Record<AttachmentKind, { mimes: readonly string[] | null; max: number }>` — `document: { mimes: null, max: 50 * 1024 * 1024 }`. Comentário no código: "`mimes: null` é o catch-all — o tipo cai em `document` quando não bate em nenhuma lista de mídia acima". `attachmentPolicy` segue exportado.
  - `validateFile`: `find(kind => policy[kind].mimes?.includes(file.mimetype)) ?? 'document'` — **o 415 sumiu**. Tamanho e magic bytes continuam (413 e 400).
  - `magicMatches` ganhou famílias de assinatura de documento (valores exatos):
    - `ZIP_FAMILY = ['application/zip','application/x-zip-compressed','application/vnd.android.package-archive','application/epub+zip']` (e qualquer mime contendo `openxmlformats`) → bytes `50 4B` (`PK`).
    - `OLE2_FAMILY = ['application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint']` → `d0 cf 11 e0 a1 b1 1a e1`.
    - `RAR_FAMILY = ['application/vnd.rar','application/x-rar-compressed']` → `52 61 72 21 1a 07` (`Rar!`).
    - `application/x-7z-compressed` → `37 7a bc af 27 1c`.
    - `PSD_FAMILY = ['image/vnd.adobe.photoshop','application/x-photoshop']` → ASCII `8BPS`.
    - `application/postscript` → `%!PS` **ou** `%PDF-` (AI moderno é PDF).
    - `TEXT_FAMILY = ['text/plain','text/csv','text/markdown','application/json','application/xml','text/xml','image/svg+xml']` → sem byte NUL nos primeiros 8 KB.
    - **Qualquer outro mime → `true`** (sem checagem — paridade WhatsApp; comentário no código diz isso).
  - Novo export `documentExtensionMimes` (21 entradas): `doc→application/msword`, `docx→…wordprocessingml.document`, `xls→application/vnd.ms-excel`, `xlsx→…spreadsheetml.sheet`, `ppt→application/vnd.ms-powerpoint`, `pptx→…presentationml.presentation`, `pdf→application/pdf`, `txt→text/plain`, `csv→text/csv`, `md→text/markdown`, `json→application/json`, `xml→application/xml`, `zip→application/zip`, `rar→application/vnd.rar`, `7z→application/x-7z-compressed`, `apk→application/vnd.android.package-archive`, `psd→image/vnd.adobe.photoshop`, `ai→application/postscript`, `fig→application/octet-stream`, `svg→image/svg+xml`, `epub→application/epub+zip`.
  - Novo export `canonicalDocumentMime(filename, declaredMime)`: declarado (trim/lowercase) vence, **exceto** vazio ou `application/octet-stream`; nesses casos resolve pela extensão do nome (lowercase, após o último `.`); fallback final `application/octet-stream`. `fig` mapeia conscientemente para octet-stream (formato proprietário sem mime registrado — chega sem identidade mesmo, mas agora por decisão explícita).
  - `create()`: job agora grava `mimeType: canonicalDocumentMime(filename, file.mimetype)` — com comentário: "O mime guardado é o que a WAHA entrega ao WhatsApp".
- **Impacto:** qualquer arquivo até 50 MB entra como documento; o destinatário recebe o mime correto; `.apk` deixa de chegar anônimo. ZIP continua aceito pela aplicação (e continua esbarrando no bucket até o SQL manual — §13/§14).
- **Dependências:** nenhuma nova. O worker/WAHA já repassavam `mimeType` ao `/api/sendFile`.
- **Riscos:** (1) bucket bloqueia tipos novos até o SQL manual — 503 opaco `Temporary upload failed` (mesma classe do bug do ZIP); (2) um binário hostil agora entra — mitigado: ele viaja como **documento** (o WhatsApp não executa, o destinatário decide abrir), a sanitização de nome segue, e o storage é privado; (3) `magicMatches` permissivo para desconhecidos é deliberado e comentado.

### 4.3 `apps/api/src/services/internal-inbox.service.ts` (modificado — T4 parcial; contém WIP estrangeiro)

- **Motivo T4:** a prévia nativa só existe **depois** que o worker envia (o WhatsApp a gera e devolve no `sentMessage`) — o payload gravado em `metadata` precisava poder depender da resposta do worker.
- **Antes:** `deliver(context, conversationId, outbound: { command, messageType, body, payload?: Record<string,unknown> })` — `payload` era valor estático, espalhado em `metadata` no caminho pending e repassado a `recordOutbound`.
- **Depois (T4):**
  - `send()` passa a declarar `payload: sent => (sent.linkPreview ? { linkPreview: sent.linkPreview } : undefined)` — com comentário: "A prévia nativa só existe depois que o worker envia… Texto sem URL volta sem ela e nada muda."
  - Assinatura de `deliver`: `payload?: Record<string, unknown> | ((sent: { id?: string; timestamp: string; pending?: boolean; linkPreview?: LinkPreview }) => Record<string, unknown> | undefined)`.
  - Após a resposta do worker: `const sent = response.data as { sentMessage?: { …, linkPreview?: LinkPreview } }`; `const payload = typeof outbound.payload === 'function' ? outbound.payload(sent.sentMessage) : outbound.payload;` — o resultado alimenta tanto o retorno pending (`metadata: { pending: true, ...(payload ?? {}) }`) quanto o `recordOutbound({ …, ...(payload ? { payload } : {}) })`.
  - Import novo: `type LinkPreview` de `@chatpro/contracts`.
- **Impacto:** toda mensagem de texto enviada com prévia nativa grava `metadata.linkPreview` e o dashboard a desenha sem rede. Texto sem link **não grava payload nenhum** (teste fixa).
- **Dependências:** §4.1 (contrato) e §4.8/§4.9 (worker extraindo a prévia).
- **Riscos:** nenhum identificado; `sendVcard` e `sendLocation` seguem com payload estático (a forma valor continua aceita).
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** parâmetro `reactions?: ReactionStore` no construtor; método `sendReaction` inteiro (toggle de reação via `message.sendReaction`); `sendVcard` ganhou `whatsappId?: string` no contato.

### 4.4 `apps/api/src/services/link-preview.service.ts` (NOVO — 225 linhas, 100% T4)

- **Motivo:** não existe endpoint WAHA para prévia de URL arbitrária e `/api/send/link-custom-preview` não é suportado no WEBJS (§3.2.3) — a retaguarda tinha que ser própria, espelhando o que o WhatsApp faz (raspagem OG) com enriquecimento oEmbed/API.
- **O que é:** classe `LinkPreviewService` com `preview(url): Promise<LinkPreview>`; construtor aceita `{ fetchImpl?, now? }` para testes.
- **Constantes (topo do arquivo):** `TIMEOUT_MS = 8_000` (página), `ENRICH_TIMEOUT_MS = 4_000` (oEmbed/API), `MAX_REDIRECTS = 2`, `MAX_BODY_BYTES = 1_500_000`, `CACHE_MAX = 500`, `SUCCESS_TTL_MS = 6h`, `FAILURE_TTL_MS = 10min`.
- **Pipeline de `preview`:** `safeTarget(url)` (guarda SSRF, §10) → cache hit? (toque LRU: delete+set; erro cacheado é relançado) → `fetchPreview` → `remember` com TTL de sucesso; falha vira `AppError` 422 (ou a original) e vira **cache negativo** — **exceto status 400** (URL bloqueada é erro do pedido, não do destino; comentário no código).
- **`fetchPreview`:** `fetchHtml` → `extractMetadata` → se não há título, descrição nem imagem → 422 "A página não tem informações para gerar a prévia" → monta candidato (`url` final pós-redirect, `domain` = hostname, campos truncados nos tetos do contrato, `provider: providerFromHostname(hostname)`) → `linkPreviewSchema.safeParse` (inválido → 422) → `enrich`.
- **`fetchHtml`:** laço de redirects **manual** (`redirect: 'manual'`): 301/302/303/307/308 → resolve `location` contra a URL corrente, **revalida com `safeTarget`** (redirect para dentro da rede é recusado), máx. 2 saltos; `!response.ok` → 422; `content-type` sem `text/html` → 422 "O link não aponta para uma página web"; corpo via `readLimited` (reader em blocos, cancela ao passar de 1,5 MB, decodifica utf8).
- **`enrich` (melhor esforço — qualquer falha cai no catch e a prévia segue só com OG):**
  - `youtube` → oEmbed `https://www.youtube.com/oembed?url=…&format=json`;
  - `tiktok` → oEmbed `https://www.tiktok.com/oembed?url=…`;
  - `github` → `github()` (abaixo).
  - `oembed()` preenche **só o que está vazio**: `author` (de `author_name`, ≤240), `imageUrl` (de `thumbnail_url`), `title` (≤500).
  - `github()`: só para `github.com/{owner}/{repo}` (regex `^\/([^/?#]+)\/([^/?#]+)\/?$`); chama `api.github.com/repos/{owner}/{repo}` com `user-agent: 'chatpro-link-preview'` e `accept: 'application/vnd.github+json'`; `author = owner` (se vazio); descrição = `description` da página ou da API, sufixada com ` — ★ {stargazers_count} · {language}` quando houver.
- **`request`:** `AbortController` + `setTimeout`; headers `accept: 'text/html,application/json'` (+ extras); qualquer exceção de rede → 422 "Não foi possível gerar a prévia deste link".
- **`safeTarget` (SSRF, detalhe em §10):** `new URL` (inválida → 400 "Link inválido"); só `http:`/`https:` (→ 400 "O link precisa começar com http:// ou https://"); `blockedHostname`: `localhost`, `*.localhost`, `*.local`, `*.internal`, IPv4 nas faixas `0/8`, `10/8`, `127/8`, `172.16–31`, `192.168`, `169.254` (o WHATWG URL já normaliza `0x7f.1`/`2130706433` para a forma pontilhada — comentário no código), IPv6 `::`, `::1`, `fe80:*`, `fc*`, `fd*`, e `::ffff:a.b.c.d` mapeado (recai na regra de IPv4).
- **`providerFromHostname`:** youtube (`youtube.com`/`youtu.be`), tiktok, github (`github.com` exato), spotify (`open.spotify.com`), instagram, facebook, figma, notion (`notion.so`/`*.notion.site`), google-drive (`drive.google.com`/`docs.google.com`), dropbox, senão `generic`.
- **`extractMetadata`:** varre `<meta>` tag a tag (as duas ordens de atributo `property`/`content` aparecem na prática — comentário), prioridade `og:` → `twitter:` → `<title>`/`meta description`; `og:site_name`; `og:image`/`twitter:image` resolvidos contra a URL da página; favicon do `<link rel="icon|shortcut icon">` ou `/favicon.ico`; `decodeEntities` (`&lt; &gt; &quot; &#39; &amp;` — `&amp;` **por último** para não decodificar duas vezes); `clean` colapsa whitespace.
- **Impacto:** endpoint de retaguarda completo e seguro.
- **Dependências:** `@chatpro/contracts` (schema), `AppError`.
- **Riscos:** SSRF (mitigado, §10); cache em memória por processo (§11); páginas com login wall devolvem OG pobre/ausente → 422 → cliente esconde o cartão (limitação conhecida, §8/§13).

### 4.5 `apps/api/src/controllers/inbox.controller.ts` (modificado — T4 parcial; contém WIP estrangeiro)

- **Motivo T4:** expor a retaguarda de prévia como rota da inbox.
- **Depois (T4, e só isto):**
  - `const linkPreviewQuery = z.object({ url: z.string().trim().min(1).max(2_048) })`.
  - Novo handler: `linkPreview: RequestHandler = async (req, res) => { if (!this.previews) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Link preview is unavailable'); res.json(await this.previews.preview(linkPreviewQuery.parse(req.query).url)); };` — com comentário: "Fallback de prévia: a nativa vem do próprio WhatsApp no envio; esta rota existe para o compositor mostrar algo antes, quando a nativa não existir."
  - Construtor ganhou o último parâmetro opcional: `private readonly previews?: LinkPreviewService`.
  - Import de tipo novo: `import type { LinkPreviewService } from '../services/link-preview.service.js';`.
- **Impacto:** `GET /api/v1/inbox/link-preview?url=…` disponível quando o serviço é injetado (no `app.ts` real, sempre é); 503 quando não é.
- **Dependências:** §4.4.
- **Riscos:** zod rejeita query sem `url` com 400 (testado). Nenhum outro.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** schema `openConversation` + handler `openConversation` (POST `/inbox/conversations/open`); schema `sendReaction`; handlers `sendReaction` e `listReactions`.

### 4.6 `apps/api/src/routes/v1.ts` (modificado — T4 parcial)

- **T4 (só isto):** `router.get('/inbox/link-preview', inbox.linkPreview);` — registrada **antes** de `/inbox/conversations` e de qualquer rota com `:conversationId`, dentro do `if (inbox)`.
- **Impacto/dependências/riscos:** triviais; nenhum.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** `POST /inbox/conversations/open` (`openConversation`); rotas de reações (`POST /inbox/conversations/:conversationId/messages/:messageId/reactions`, `GET /inbox/messages/:messageId/reactions` — no trecho truncado do diff); `POST|GET /domain/contacts/sync*` (3 rotas de contact sync no `DomainController`).

### 4.7 `apps/api/src/app.ts` (modificado — T4 parcial)

- **T4 (só isto):** `import { LinkPreviewService } from './services/link-preview.service.js';` e `new LinkPreviewService()` passado como **último argumento** do `new InboxController(…)` (após `sessionActivity`).
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** imports `SqliteContactIdentityResolver`/`SupabaseContactIdentityResolver` e `WhatsAppContactSyncService`/`MemoryContactSyncStore`; criação de `contactResolver`/`contactSync`; `DomainController` ganhou `contactSync`; `WahaWebhookController` ganhou argumento extra (`webhookStore` ao final); `InternalInboxService` ganhou `webhookStore` como `reactions`.

### 4.8 `apps/worker/src/waha-client.ts` (modificado — T4 parcial; contém WIP estrangeiro)

- **Motivo T4:** pedir a prévia nativa ao WhatsApp e devolvê-la estruturada.
- **Antes:** `sendText` → `requestResponse('/api/sendText', 'POST', { session, chatId, text })`; retorno `{ id, pending:false }` ou `{ pending:true }`.
- **Depois (T4):**
  - Novo tipo exportado: `WahaLinkPreview = { url: string; title?: string; description?: string; imageUrl?: string }` — com comentário: "`url` é sempre a canônica quando existe; a thumbnail chega em base64 e viaja como data URL, que é o formato que o contrato aceita".
  - `WahaSentMessage` ganhou `linkPreview?: WahaLinkPreview`.
  - `sendText` envia `{ session, chatId, text, linkPreview: true, linkPreviewHighQuality: true }` — comentário: "é o próprio app que resolve o link, como acontece no cliente oficial".
  - Nova função `nativeLinkPreview(value, text)`: lê `_data` do objeto de resposta; `url = canonicalUrl ?? matchedText ?? firstHttpUrl(text)`; exige ao menos um de `title`/`description`/`thumbnail` (senão `undefined` — "ausente é o estado normal, não um erro"); thumbnail vira `imageUrl` (prefixa `data:image/jpeg;base64,` se não vier como data URL).
  - `firstHttpUrl(text)`: `/https?:\/\/\S+/`.
  - Log `WAHA sendText accepted` ganhou o campo `linkPreview: Boolean(preview)`.
- **Impacto:** a prévia nativa atravessa o worker.
- **Dependências:** nenhuma nova.
- **Riscos:** `linkPreviewHighQuality` é melhor esforço no WEBJS (limitação registrada, §13); `_data` ausente em respostas não-WEBJS é tratado (sem prévia, sem erro).
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** `sendReaction` (`PUT /api/reaction`), `listContacts` (`GET /api/contacts/all`, filtra `isGroup`), tipos `WahaContactsPage` e método na interface `WahaClientPort`.

### 4.9 `apps/worker/src/waha-provider.ts` (modificado — T4 parcial; contém WIP estrangeiro)

- **Motivo T4:** só deixar passar para a API uma prévia que obedece ao contrato.
- **Depois (T4):** `sendText` agora: `const linkPreview = sent.linkPreview ? linkPreviewSchema.safeParse(sent.linkPreview) : undefined; return { ...(sent.id ? { id: sent.id } : {}), pending: sent.pending, timestamp: new Date().toISOString(), ...(linkPreview?.success ? { linkPreview: linkPreview.data } : {}) };` — **prévia que viola o contrato é descartada, não derruba o envio** (testado: `url: ''` cai fora).
- **Impacto/dependências/riscos:** garante a fronteira do contrato; nenhum risco.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** ramo `sendReaction` no `execute` + método privado `sendReaction`; ramo `contactsPage` + método `contactsPage`.

### 4.10 `apps/worker/src/ports.ts`, `internal-transport-server.ts`, `baileys-whatsapp-worker.adapter.ts`, `demo-whatsapp-worker.adapter.ts` (modificados — **0% T4**)

Inspecionados diff a diff: **nenhuma mudança T4**. A prévia atravessa essas camadas sem alteração porque:
- `ports.ts`: o tipo `SentMessage` não mudou — o objeto com `linkPreview` volta do `WahaProvider.execute` por inferência estrutural e o transport server o repassa por cast; o contrato (`internalTransportDataSchema`, §4.1) é quem valida na entrada da API.
- As mudanças presentes nesses arquivos são **todas estrangeiras**: comandos `sendReaction`/`contactsPage` em `ports.ts`; ramos `message.sendReaction` e `contacts.page` no `internal-transport-server.ts`; linhas `NOT_IMPLEMENTED` para os dois comandos novos nos adapters Baileys e Demo.

### 4.11 `apps/dashboard/src/api/client.ts` (modificado — 100% T4)

- **Motivo:** `fetch` não expõe progresso de upload; o XHR expõe.
- **Depois:** novo método `postFormProgress<T>(path, body, onProgress?)`:
  - `xhr.open('POST', baseUrl + path)`; `xhr.timeout = this.timeoutMs`; headers `x-workspace-id`/`x-user-id` (sem `content-type` — o browser define o boundary do multipart; o teste prende `headers['content-type'] === undefined`).
  - `xhr.upload.onprogress`: só quando `event.lengthComputable && event.total > 0` → `onProgress?.(Math.min(100, Math.round((loaded/total)*100)))`.
  - `onload`: 204 → `resolve(undefined)`; tenta `JSON.parse(responseText)` (falha → `ApiError REQUEST_FAILED` fase `parse`, com sufixo DEV `[PARSE {status} {path}]`); 2xx → resolve; senão extrai `error.message`/`error.details` do corpo → `ApiError REQUEST_FAILED` fase `response` ("Não foi possível concluir a operação." quando o corpo não traz mensagem).
  - `onerror` → `API_UNAVAILABLE`; `onabort` → `REQUEST_FAILED` "Solicitação cancelada." (fase `abort`); `ontimeout` → `TIMEOUT`.
  - Comentário: "Mesma fronteira e mesmos erros do `request` — só muda o transporte e o `onProgress`."
- **Impacto/dependências/riscos:** só `sendAttachment` usa hoje; comportamento idêntico ao `request` nos erros; nenhum risco novo (XHR é tão capaz quanto fetch para este caso).

### 4.12 `apps/dashboard/src/api/inbox.ts` (modificado — T4 parcial)

- **T4 (só isto):**
  - `sendAttachment(id, file, clientRequestId, caption?, voiceNote?, onProgress?)` — 6º parâmetro; com `onProgress` usa `postFormProgress`, sem ele segue no `postForm` (comentário: "`onProgress` troca o transporte para XHR, o único que relata o upload").
  - Novo: `linkPreview = (url: string) => this.http.get<LinkPreview>(\`/api/v1/inbox/link-preview?url=${encodeURIComponent(url)}\`)`.
  - Import de tipo `LinkPreview` de `@chatpro/contracts`.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** `openByPhone`, `react`, `listReactions`.

### 4.13 `apps/dashboard/src/ui/attachmentIntake.ts` (modificado — 100% T4)

- **Motivo:** espelhar no cliente a nova política (feedback antes do upload).
- **Antes:** `document.mimes` com 6 tipos e 25 MB; `attachmentKind` podia devolver `undefined`; `ACCEPTED_SUMMARY` listava os formatos; `readTransfer` separava `rejected` por formato; `acceptAttachment` rejeitava com `reason: "type"`; `magicMatches` devolvia `false` para desconhecido e só `text/plain` na família texto.
- **Depois:**
  - `ATTACHMENT_POLICY.document = { mimes: [] as readonly string[], max: 50MB }` (mimes vazio = coringa documentado).
  - `ACCEPTED_SUMMARY = "imagem JPEG, PNG ou WebP até 15 MB, áudio até 25 MB, vídeo MP4 ou WebM até 50 MB e qualquer documento até 50 MB"`.
  - `attachmentKind(mime): AttachmentKind` — **sempre** retorna: procura só em `image|audio|video`; senão `'document'`.
  - `magicMatches`: adicionadas assinaturas RAR (`52 61 72 21 1a 07`), 7Z (`37 7a bc af 27 1c`), PSD (`8BPS`, inclui `application/photoshop`), OLE2 (`d0 cf 11 e0 a1 b1 1a e1` para msword/ms-excel/ms-powerpoint); família texto ampliada para `normalized.startsWith("text/") || includes("json") || includes("xml")` (sem NUL); **default `true`** ("Assinatura conhecida é conferida; desconhecida passa"). O cliente lê 4 KB (`HEAD_BYTES`), o servidor 8 KB para texto — "ler menos é permissivo a mais, nunca a menos" (o servidor pega o que escapar).
  - `readTransfer`: `accepted = files` (todos); `rejected: []` — comentário: "Recusa agora é só de tamanho, arquivo vazio ou bytes mentirosos — e acontece no `acceptAttachment`, arquivo a arquivo. `rejected` fica de molho para a mensagem de formato antiga não reaparecer por engano."
  - `acceptAttachment`: removida a rejeição `reason: "type"`; restam `empty`, `size`, `magic`.
- **Impacto/riscos:** GIF/HEIC/SVG/etc. agora anexam como documento (testado). Nenhuma rejeição por formato no cliente — o servidor também não rejeita mais (§4.2).

### 4.14 `apps/dashboard/src/ui/messageMedia.ts` (modificado — 100% T4)

- **Motivo:** etiquetas ricas de documento, miniatura nativa, abrir/visualizar/baixar-com-barra.
- **Depois (tudo novo ou reescrito):**
  - `documentKind(filename, mimeType)` **reescrito**: extensão primeiro ("é o que o operador vê no nome do arquivo"), mime como retaguarda ("o caso real da base, medido em 88 de 89 documentos sem `media_filename`"). Mapa completo na §9. Novos tons: `code` (JSON/XML), `app` (APK), `design` (PSD/AI/FIG), `book` (EPUB), além dos existentes `pdf/doc/xls/ppt/zip/txt/img/aud/vid/file`. CSV sai de `XLS` para etiqueta própria `CSV` (tom `xls`); `md` vira `MD` (tom `txt`).
  - `documentThumbnail(message)`: `_data.thumbnail` → data URL (prefixa `data:image/jpeg;base64,` se necessário) — "a primeira página de um PDF, por exemplo — em base64, na mesma forma da miniatura de localização".
  - `browserOpenable(filename, mimeType)`: extensões `pdf/txt/md/json/xml/svg/csv/log`; ou mime `application/pdf`, `image/svg+xml`, `text/*`, contém `json`, ou XML — comparado por igualdade/sufixo `+xml` (`xmlMime`), **não** `includes("xml")`, que pegaria `vnd.openxmlformats-officedocument` (planilha não abre em aba — comentário no código).
  - `textPreviewable(filename, mimeType)`: subconjunto texto (`md/txt/json/xml/csv/log`; mime texto/json/xml) — "PDF e SVG o navegador renderiza melhor que um `<pre>`".
  - `TEXT_PREVIEW_LIMIT = 200 * 1024`.
  - `formatTextPreview(raw, mimeType, filename)`: JSON (por mime ou extensão `.json`) ganha `JSON.stringify(JSON.parse(raw), null, 2)` — JSON quebrado mostra cru ("truncado não é JSON"); acima do teto: corta e sufixa `\n…\n(Conteúdo truncado. Baixe o arquivo para ver inteiro.)`.
  - `downloadWithProgress(url, expectedSize, onProgress, fetchImpl = fetch)`: `response.ok` ou lança; `total = content-length || expectedSize || 0`; sem `response.body` → `response.blob()` direto; senão lê o `reader` em blocos → `onProgress(pct | null)` → `new Blob(chunks, { type: content-type })`. Comentário: "A URL assinada pode não liberar CORS para `fetch` — aí a promessa rejeita e quem chamou cai na âncora nativa, que sempre funcionou."
- **Impacto/dependências/riscos:** puro, testado (§12); nenhum risco.

### 4.15 `apps/dashboard/src/ui/MessageMedia.tsx` (modificado — T4 parcial; contém WIP estrangeiro)

- **Motivo T4:** cartão de documento rico e ações novas.
- **Depois (T4):**
  - `saveBlob(blob, name)`: objectURL → âncora `download` com `rel="noopener"` → click → remove → **`revokeObjectURL` após 1 s** ("revogar na hora cancela o download em alguns navegadores").
  - Novo componente `DocumentTextPreview({ message, url, label, onClose })`: busca o conteúdo **uma vez, quando o operador pede** (`useEffect` com guarda `active`); estados `undefined` (carregando → "Carregando conteúdo…"), `null` (falha → "Não foi possível carregar o conteúdo."), texto (`<pre className="document-text-preview">`). **Reusa a moldura `.media-modal-backdrop`/`.media-modal` da imagem ampliada** — decisão consciente (§5.6).
  - `DocumentMessage` **reescrito**: de âncora única para `<div className="message-document-card">` contendo: miniatura nativa (`<img className="message-document-thumb">`, quando `documentThumbnail`), ícone `tone-{kind.tone}`, detalhes (nome, chip etiqueta, **chip de extensão real quando difere da etiqueta** — ex.: etiqueta `XLS` + chip `XLSX`, tamanho), e coluna de ações `.message-document-actions`:
    - **Abrir ↗** (`browserOpenable`): âncora `target="_blank" rel="noopener noreferrer"`.
    - **Visualizar ≡** (`textPreviewable`): abre `DocumentTextPreview`.
    - **Baixar ⇩**: `startDownload` — se `nativeFallback.current` está armado, deixa o navegador baixar sozinho; senão `preventDefault`, `media.classify()` (uma sondagem HEAD memoizada), se `gone` o cartão troca para `MediaGone`; depois `downloadWithProgress` + `saveBlob`; **catch → arma `nativeFallback` e clica a âncora escondida** (fallback nativo).
    - Barra `.document-progress` durante o download (`pct == null` → trilha cheia indeterminada "Baixando…"; senão `N%`).
  - `if (media.gone) return <MediaGone message={message} />;` movido para antes do JSX (inalterado o comportamento).
- **Impacto/dependências/riscos:** depende de §4.14; o fluxo de sondagem HEAD continua anti-N+1 (uma por mídia, sob demanda). Risco: dois downloads simultâneos do mesmo cartão são bloqueados por `download.active`.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** `ContactCardMessage`/`ContactCardEntry` ganharam `onStartChat` e o botão "Conversar" (`ChatState`, `converse()`); `Media` ganhou a prop `onStartChat`.

### 4.16 `apps/dashboard/src/ui/Inbox.tsx` (modificado — T4 parcial; contém WIP estrangeiro)

- **T4 (só isto):**
  - `import { LinkPreview, linkify } from "./LinkPreview.js";`.
  - Corpo do balão: `{message.content && !bodyRepeatsCard(message) && <p>{linkify(message.content)}</p>}`.
  - `<LinkPreview message={message} api={api} />` dentro do `MessageBubble`, após o texto — comentário: "Uma prévia por mensagem, a do primeiro link — como o WhatsApp. O componente some sozinho quando não há link nem prévia."
  - Estado `uploadProgress: number | undefined` (comentário: "a barra só existe enquanto o XHR relata progresso"); `applyAttachment` o zera; `catch` do envio o zera.
  - Envio de anexo: `setUploadProgress(0)` antes; `api.sendAttachment(selected.id, attachment, clientRequestId, text, undefined, (pct) => { if (mounted.current) setUploadProgress(pct); })`.
  - Chip de anexo pendente: dentro de `.composer-pending-details`, quando `uploadProgress !== undefined`, barra `.composer-upload-progress` com `<i style={{ width }}>` e rótulo `uploadProgress < 100 ? \`Enviando… ${uploadProgress}%\` : "Anexo em processamento…"` (`role="status"`, `aria-label="Progresso do envio"`).
  - Menu de anexo: opção **Documento** agora `setAttachmentAccept("*/*")` (era `".pdf,.doc,.docx,.xls,.xlsx,.txt"`) — comentário: "Documento é o coringa: qualquer arquivo serve — paridade com o WhatsApp."
- **Impacto/dependências/riscos:** depende de §4.11/§4.12/§4.17/§4.18; `mounted.current` evita setState pós-desmontagem. Nenhum risco novo.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** todo o bloco de reações no `MessageBubble` (`REACTION_EMOJIS`, pickers, badges, popups, `handleReact`, props `conversationId`/`onStartChat`); `startChatFromCard`; handler do evento `message.reaction.updated` no realtime; `CONTACT_PAGE_SIZE` 20→50 (contact sync).

### 4.17 `apps/dashboard/src/ui/linkPreview.ts` (NOVO — 138 linhas, 100% T4)

- **Motivo:** núcleo puro e testável da prévia no cliente (URLs, prioridade nativa, cache).
- **Conteúdo:**
  - `MAX_URLS = 32`; `URL_PATTERN = /https?:\/\/[^\s<>"']+/gi`; `TRAILING = /[.,;:!?'"»]+$/`.
  - `trimUrl(raw)`: apara pontuação final; remove `)` excedente enquanto houver mais `)` que `(` (parêntese da frase sai, o da Wikipédia fica — comentário).
  - `findUrls(text)`: dedup por igualdade, até 32, só http(s).
  - `domainFromUrl(url)`: hostname sem `www.` ("como o WhatsApp mostra no rodapé do cartão").
  - `providerFromUrl(url)`: espelho cliente do provider (youtube/`youtu.be`, tiktok, github exato, `open.spotify.com`, instagram, facebook + `fb.watch`, figma, notion `.so`/`.site`, drive/docs google, dropbox, `generic`).
  - `sanitize(value)`: validação **frouxa** do `metadata.linkPreview` — exige `url` e ao menos `title` **ou** `imageUrl`; campos tortos caem fora em vez de derrubar a prévia; `durationSeconds` só se número finito ≥ 0.
  - `nativeLinkPreview(message)`: **prioridade** — 1) `metadata.linkPreview` (sanitize); 2) `metadata._data`: `title`/`description`, `thumbnail` → data URL, `url = canonicalUrl ?? matchedText ?? primeira URL do texto`; sem título **nem** imagem → `null` ("quem decide se busca a retaguarda é o componente").
  - `previewCache = new Map<string, Promise<LinkPreview | null>>()` (sessão); `cachedLinkPreview(api, url)`: guarda **a promessa antes de começar** ("dez cartões do mesmo link montados no mesmo render dividem a mesma busca"); falha vira `null` cacheado ("insistir na mesma raspagem que acabou de falhar é pedir o mesmo 422 a cada mensagem").
- **Impacto/dependências/riscos:** cache cresce sem bound **por sessão aba** (§11, limitação aceita); sem dependências novas.

### 4.18 `apps/dashboard/src/ui/LinkPreview.tsx` (NOVO — 81 linhas, 100% T4)

- **Motivo:** âncoras no texto e o cartão de prévia.
- **`linkify(content): ReactNode`:** usa `findUrls`; a busca anda para a frente (`rest.indexOf(url)`), então URL repetida vira âncora nas duas ocorrências; trechos entre URLs seguem **texto puro** (XSS-safe por construção); âncoras `className="message-link"`, `target="_blank"`, `rel="noopener noreferrer"`.
- **`LinkPreview({ message, api })`:**
  - `native = nativeLinkPreview(message)`; `firstUrl = findUrls(content)[0]`.
  - Estado `fetched: LinkPreviewData | null | undefined` — `undefined` = buscando; `null` = voltou sem prévia.
  - `useEffect`: se há nativa ou não há URL → `setFetched(null)` e **não chama a API**; senão `cachedLinkPreview(api, firstUrl)` com guarda `active`.
  - Render: sem nativa e sem URL → `null`; sem prévia e busca concluída → `null`; buscando → **esqueleto** `.link-preview-card.is-loading` (3 barras shimmer, `aria-hidden`).
  - Cartão: `<a className={\`link-preview-card is-${provider}\`} target="_blank" rel="noopener noreferrer" aria-label={title ? \`Abrir link: ${title}\` : \`Abrir link: ${url}\`}>`; imagem com `loading="lazy"` + badge de duração (`durationLabel`); corpo: título (clamp 2), autor, descrição (clamp 2), rodapé (favicon 13px + `siteName` + domínio uppercase), URL completa em `<small>`.
  - Guarda final: sem `url` ou sem `title` **e** `imageUrl` → `null`.
- **Impacto/dependências/riscos:** depende de §4.17 e do endpoint §4.5; falha da retaguarda não deixa resíduo (testado).

### 4.19 `apps/dashboard/src/ui/styles.css` (modificado — T4 parcial)

- **T4 (bloco novo ao final, com cabeçalho de seção; regra do projeto: nenhum hex novo, todos os valores já existiam na folha):**
  - `.message-link` (cor `#8ac7ff`, hover underline, `overflow-wrap: anywhere`).
  - `.link-preview-card` (largura `min(360px,100%)`, borda esquerda 3px de acento, gradiente, sombra, hover) + variantes de acento por provedor: `is-youtube` `#fb7185`; `is-spotify`/`is-google-drive` `#25d366`; `is-github`/`is-notion` `#a697b4`; `is-tiktok`/`is-figma` `#f0abfc`; `is-instagram`/`is-facebook`/`is-dropbox` `#8ac7ff` — "A borda esquerda é o acento do provedor — a informação continua no texto."
  - `.link-preview-image` (+`img` `max-height:170px` cover), `.link-preview-duration` (badge canto inferior direito), `.link-preview-body`, `.link-preview-title` (`-webkit-line-clamp: 2`), `.link-preview-author`, `.link-preview-description` (clamp 2), `.link-preview-footer`, `.link-preview-favicon` (13px), `.link-preview-site`/`.link-preview-domain` (uppercase 10px), `.link-preview-url` (9px).
  - Esqueleto: `.link-preview-card.is-loading` com barras `<i>` animadas por `@keyframes link-preview-shimmer`.
  - Documento rico: `.message-document-thumb` (grid-column 1/-1, max-height 170px), `.message-document-actions` (coluna; botões/âncoras 30×30 com gradiente roxo), `.document-progress`/`.document-progress-track` (barra 4px), `.document-text-preview` (`ui-monospace`, `pre-wrap`, `max-height: calc(100vh - 140px)`).
  - Tons novos de etiqueta: `.tone-txt`, `.tone-code`, `.tone-zip`, `.tone-app`, `.tone-design`, `.tone-book`.
  - Upload: `.composer-upload-progress`/`.composer-upload-progress-track`.
- **WIP estrangeiro neste mesmo arquivo (NÃO é T4):** bloco "Message reactions" (badges/pickers/popups); `.composer-contact-row input` ganhou `width: auto`; `.composer-contact-more` substituído por `.composer-contact-sentinel` (contact sync).

### 4.20 Testes T4 (criados/atualizados) — detalhe completo na §12

- `apps/api/test/link-preview.service.test.ts` (**novo**): 22 testes de serviço + 3 de rota (25 no total).
- `apps/api/test/attachment-outbox.service.test.ts`: reescrito o caso 415 (agora só tamanho) + novo `describe` de política de documentos (~30 asserções).
- `apps/api/test/internal-inbox-content.service.test.ts`: +2 (persistência da prévia / ausência de payload).
- `apps/worker/test/waha-client.test.ts`: +4 T4 (pede prévia; mapeia `_data`; fallbacks de URL; sem prévia) — **+2 estrangeiros** (reaction) no mesmo arquivo.
- `apps/worker/test/waha-provider.test.ts`: +2 T4 (atravessa prévia; descarta prévia inválida) — **+1 estrangeiro** (reaction).
- Dashboard: `linkPreview.test.ts` (novo, 30 asserções), `InboxLinkPreview.test.tsx` (novo, 9), `client.test.ts` (+4), `inbox.test.ts` (+3), `attachmentIntake.test.ts` (atualizado + novos), `messageMedia.test.ts` (+~30), `InboxMessageCards.test.tsx` (atualizado +3 T4, **+1 estrangeiro**), `InboxMediaUnavailable.test.tsx` (fluxo de clique atualizado), `InboxPaste.test.tsx` (GIF aceito + 2 de progresso de upload).

---

## 4b. trabalho_concorrente — WIP ESTRANGEIRO (NÃO é T4)

O working tree contém trabalho concorrente de **outro processo**: features "openConversation / Conversar", "message reactions", "contact sync" e mudanças no ContactPicker. **Não documentar em profundidade, não revisar como T4, não "consertar" por conta própria** — mas é obrigatório saber que existe, porque (1) quebra o typecheck compartilhado e (2) toca arquivos que a T4 também tocou.

### 4b.1 Arquivos 100% estrangeiros (não ler como T4)

- `apps/api/src/controllers/domain.controller.ts` — rotas de contact sync (`startContactSync`, `contactSyncStatus`, `cancelContactSync`).
- `apps/api/src/controllers/waha-webhook.controller.ts` — assinatura/amarras do webhook para reações.
- `apps/api/src/middleware/errors.ts` — +2 linhas (mapeamento de erro do WIP).
- `apps/api/src/persistence/sqlite-domain.repository.ts` — contact sync/identidade (+31).
- `apps/api/src/persistence/supabase-domain.repository.ts` — idem (+65).
- `apps/api/src/services/inbox-contact.service.ts` — vCard com `whatsappId` (+18).
- `apps/api/src/services/waha-webhook.service.ts` — **`findDirectByChatId` adicionado à interface `ConversationStore` sem implementação nas stores** → causa raiz dos 30 erros de typecheck da API (TS2420/TS2345) e da quebra do typecheck do worker via `apps/worker/src/main.ts:44`. Também: reactions store (`batchReactions`, `listReactions`, `recordOperatorReaction`, `getOperatorReaction`, `removeOperatorReaction`), `createDirectConversation`, `findConversationByChatId`.
- `apps/api/src/services/whatsapp-contact-sync.service.ts` (**novo**) — sync de contatos via `contacts.page`.
- `apps/api/migrations/025_message_reactions.sql` (**novo**) — tabela de reações (SQLite/local). **Não aplicada por agentes.**
- `supabase/migrations/20260804000100_message_reactions.sql` (**novo**) — mesma feature no Supabase. **Não aplicada por agentes** (REGRA 1).
- `apps/api/test/app.test.ts`, `apps/api/test/supabase-domain.repository.test.ts`, `apps/api/test/waha-webhook.test.ts` — ajustes ao WIP.
- `apps/api/test/message-reactions.test.ts` (**novo**), `apps/api/test/open-conversation.test.ts` (**novo**), `apps/api/test/whatsapp-contact-sync.service.test.ts` (**novo**).
- `apps/dashboard/src/ui/ContactPicker.tsx`, `apps/dashboard/src/ui/InboxContactPicker.test.tsx` — paginação/infinite scroll de contatos.
- `apps/dashboard/src/api/realtime.ts` — `eventType` ganhou `'message.reaction.updated'`.
- `docs/microphone-gate-spec.md` (**novo**) — especificação alheia à T4.
- `web/AGENTS.md` (**untracked**) — arquivo de regras do projeto, pré-existente na prática (não é trabalho de feature; não apagar, não "arrumar").

### 4b.2 Arquivos mistos (T4 + estrangeiro no mesmo arquivo)

| Arquivo | Parte T4 | Parte estrangeira |
| --- | --- | --- |
| `packages/contracts/src/index.ts` | linkPreview*; `linkPreview` no `sentMessage` | reactions; contacts.page; sendReaction; campos whatsapp* do contato |
| `apps/api/src/controllers/inbox.controller.ts` | `linkPreviewQuery`, handler `linkPreview`, param `previews` | `openConversation`, `sendReaction`, `listReactions` |
| `apps/api/src/routes/v1.ts` | `GET /inbox/link-preview` | `/inbox/conversations/open`; rotas de reações; `/domain/contacts/sync*` |
| `apps/api/src/app.ts` | `new LinkPreviewService()` | contact sync; reactions wiring |
| `apps/api/src/services/internal-inbox.service.ts` | payload-como-função; persistência `linkPreview` | `sendReaction`; `reactions` no construtor; `whatsappId` no vCard |
| `apps/worker/src/waha-client.ts` | sendText linkPreview + extração `_data` | `sendReaction`, `listContacts` |
| `apps/worker/src/waha-provider.ts` | safeParse da prévia no sendText | `sendReaction`, `contactsPage` |
| `apps/worker/src/ports.ts` / `internal-transport-server.ts` / adapters baileys+demo | — (nada T4) | comandos sendReaction/contactsPage |
| `apps/dashboard/src/api/inbox.ts` | `linkPreview()`, `sendAttachment` onProgress | `openByPhone`, `react`, `listReactions` |
| `apps/dashboard/src/ui/Inbox.tsx` | linkify + LinkPreview + progresso de upload + accept `*/*` | reações no bubble; `startChatFromCard`; `message.reaction.updated`; `CONTACT_PAGE_SIZE` 50 |
| `apps/dashboard/src/ui/MessageMedia.tsx` | DocumentMessage rico; DocumentTextPreview; saveBlob | botão "Conversar" no cartão de contato (`onStartChat`) |
| `apps/dashboard/src/ui/styles.css` | link/documento/upload | bloco reactions; composer-contact-* |
| `apps/dashboard/src/ui/InboxMessageCards.test.tsx` | testes de documento rico | teste "Conversar abre a conversa" |
| `apps/worker/test/waha-client.test.ts` | 4 testes de prévia | 2 testes de reaction |
| `apps/worker/test/waha-provider.test.ts` | 2 testes de prévia | 1 teste de reaction |

### 4b.3 Estado conhecido do WIP estrangeiro (para coordenação de merge)

- **11 testes falhando** na API (`open-conversation.test.ts`, `inbox-open-conversation.test.ts`) — **idênticos à baseline pré-T4** (não é regressão da T4).
- **30 erros de typecheck** na API, todos em arquivos estrangeiros; a causa raiz é `findDirectByChatId` na interface `ConversationStore` sem implementação nas stores (TS2420/TS2345). A mesma causa quebra o typecheck do **worker** pela cadeia de import de `apps/worker/src/main.ts:44`.
- Dashboard **não** é afetado pelo WIP estrangeiro: tsc limpo, 654/654 testes.
- **Antes do merge da T4**, coordenar com o dono do WIP: ou ele completa as stores, ou a T4 entra sabendo que API+worker não typecheckam por causa alheia. O build raiz (§13) vai esbarrar nisso.

---

## 5. componentes

Componentes de UI da feature (dashboard). Não existe `MarkdownPreview`, `FilePreview` ou `GenericAttachment` separados — **decisão consciente de reuso**, ver §5.6.

### 5.1 `DocumentMessage` (estendido — `MessageMedia.tsx`)

- **Responsabilidade:** cartão de mensagem do tipo `document` — identidade (etiqueta + nome + extensão + tamanho), miniatura nativa quando existe, e as três ações (abrir/visualizar/baixar) com barra de progresso.
- **Props:** `{ message: InboxMessage; url: string }` (o `url` já vem resolvido pelo `Media` via `media/access`).
- **Fluxo:** `mediaFilename`/`wahaMime` leem colunas e `_data`; `documentKind` dá `{ label, tone }`; `documentThumbnail` dá a miniatura base64; `useMediaFailure(url)` dá `gone`/`classify`. Se `gone` → `MediaGone`. No clique de baixar: `classify()` (HEAD memoizado) → `downloadWithProgress` → `saveBlob`; catch → `nativeFallback` + clique nativo na âncora escondida.
- **Estados:** `download: { active: boolean; pct: number | null }`; `previewOpen: boolean`; `nativeFallback: useRef<boolean>`; `media.gone` (derivado).
- **Estrutura do cartão:** `<div className="message-document-card">` → `[thumb]` + ícone `tone-{tone}` (texto = etiqueta, ex. `XLS`) + detalhes (`<strong>` nome; chips: etiqueta, extensão real quando difere, tamanho ou "Tamanho não informado") + `.message-document-actions` (Abrir ↗ condicional a `browserOpenable`; Visualizar ≡ condicional a `textPreviewable`; Baixar ⇩ sempre) + barra `.document-progress` quando `download.active`.
- **Integrações:** `attachmentIntake.fileSizeLabel`; `messageMedia` (leitores); `useMediaFailure`/`MediaGone`; `DocumentTextPreview`.
- **Acessibilidade:** cada ação tem `aria-label` com o nome do arquivo ("Baixar X", "Abrir X em nova aba", "Visualizar X"); barra com `role="status"`.

### 5.2 `LinkPreview` (novo — `LinkPreview.tsx`)

- **Responsabilidade:** desenhar **no máximo um** cartão de prévia por mensagem — o do primeiro link — seguindo a prioridade nativa→retaguarda, sem deixar resíduo em falha.
- **Props:** `{ message: InboxMessage; api: InboxApi }`.
- **Fluxo:** `nativeLinkPreview(message)` (rede zero) → se nulo e houver URL no texto, `cachedLinkPreview(api, firstUrl)` (cache de sessão) → estados.
- **Estados:** `fetched: LinkPreviewData | null | undefined` (`undefined` = carregando → esqueleto shimmer; `null` = sem prévia → componente some).
- **Render do cartão:** âncora `link-preview-card is-{provider}`, imagem lazy + badge de duração, título (clamp 2), autor, descrição (clamp 2), rodapé (favicon + siteName + domínio), URL completa.
- **Integrações:** `linkPreview.ts` (`findUrls`, `nativeLinkPreview`, `cachedLinkPreview`, `providerFromUrl`, `domainFromUrl`), `messageMedia.durationLabel`, endpoint `api.linkPreview`.
- **Guardas:** sem URL na mensagem → `null` (e **não chama a API** — testado); prévia sem `url` ou sem `title`+`imageUrl` → `null`.

### 5.3 `linkify` (novo — função em `LinkPreview.tsx`)

- **Responsabilidade:** transformar o texto da mensagem em nós React com âncoras seguras.
- **Fluxo:** `findUrls` → corta o texto sequencialmente → trechos puros como strings (XSS-safe), URLs como `<a className="message-link" target="_blank" rel="noopener noreferrer">`.
- **Integrações:** usado no `<p>` do `MessageBubble` (Inbox.tsx).

### 5.4 `DocumentTextPreview` (novo — dentro de `MessageMedia.tsx`)

- **Responsabilidade:** mostrar o conteúdo de um documento de texto **na mesma janela modal da imagem ampliada**.
- **Props:** `{ message: InboxMessage; url: string; label: string; onClose: () => void }`.
- **Fluxo:** ao montar (só quando o operador clica "Visualizar"), `fetch(url)` → `formatTextPreview(raw, mime, filename)` → `<pre className="document-text-preview">`.
- **Estados:** `content: string | null | undefined` — `undefined` = "Carregando conteúdo…" (`role="status"`); `null` = "Não foi possível carregar o conteúdo."; guarda `active` contra setState pós-desmontagem.
- **Moldura:** `.media-modal-backdrop` (fecha no clique fora) + `.media-modal` (`role="dialog"`, `aria-modal`, `aria-label` = nome do arquivo, botão × "Fechar visualização", `stopPropagation`).

### 5.5 `MediaGone` (inalterado — reusado pelo DocumentMessage)

- **Responsabilidade:** cartão-fato para arquivo que o WhatsApp já descartou (sem "tente de novo" — não há o que tentar).
- **Fluxo:** `mediaKindLabel` + nome/duração/tamanho sobreviventes; `role="status"`.
- **Disparo em documento:** `useMediaFailure.classify()` retorna `"gone"` quando o proxy responde **404** (`MEDIA_GONE_STATUS`); qualquer outro status é `"transient"`. A sondagem é memoizada por URL — uma por mídia, jamais no render (anti-N+1 do projeto).

### 5.6 Decisão: por que NÃO existem `MarkdownPreview` / `FilePreview` / `GenericAttachment`

A janela modal de imagem (`.media-modal-backdrop` + `.media-modal`) já resolvia backdrop-clique-para-fechar, `role="dialog"`, foco e moldura. Criar componentes paralelos para prévia de texto duplicaria essa moldura (REGRA 2 do AGENTS.md: nunca duplicar fluxo). A prévia de texto é um **conteúdo** dentro da moldura existente (`DocumentTextPreview`), e o cartão de documento é **um só** (`DocumentMessage`) para todos os formatos — a variação é de dados (etiqueta/tom/miniatura/ações visíveis), não de componente. Markdown não é renderizado como HTML: é **texto pré-formatado** (`<pre>`) — decisão de segurança e de escopo (§13, limitações).

### 5.7 Chip de anexo pendente do compositor (estendido — `Inbox.tsx`)

- **Responsabilidade:** mostrar o anexo em preparo e, durante o envio, a barra de upload.
- **Fluxo:** `attachment` presente → `.composer-pending-attachment` com ícone (◖ áudio / ▤ resto), nome, `fileSizeLabel`; quando `uploadProgress !== undefined` → `.composer-upload-progress` (`role="status"`, `aria-label="Progresso do envio"`): `<100` → "Enviando… N%"; `100` → "Anexo em processamento…".
- **Estados:** `uploadProgress: number | undefined` (0 marcado no início do envio; zerado em `applyAttachment`/erro/fim).
- **Integrações:** `InboxApi.sendAttachment` (6º arg `onProgress`, guardado por `mounted.current`).

---

## 6. backend

### 6.1 Controllers

- **`InboxController`** (`inbox.controller.ts`): T4 adicionou o handler `linkPreview` (§4.5) e o parâmetro `previews?: LinkPreviewService` (último do construtor, opcional → 503 quando ausente). O upload de anexo segue no handler `createAttachment` (multer `single('file')`, `attachmentRequest` zod: `clientRequestId` UUID, `caption` ≤ 1.000, `voiceNote` boolean string), respondendo **202** com o job.
- Rotas de mídia (inalteradas, usadas pela feature): `GET /inbox/messages/:messageId/media/access` (JSON `{ url, expiresAt }` — signed URL permanente de 300 s **ou** URL do proxy com `access_token`) e `GET /inbox/messages/:messageId/media` (redirect 302 para signed URL permanente, ou stream proxy WAHA com HEAD/Range).

### 6.2 Services

- **`AttachmentOutboxService`** — §4.2 (policy catch-all, 50 MB, magic bytes por família, `documentExtensionMimes`/`canonicalDocumentMime`). Inalterados e relevantes: `sanitizeFilename` (NFKD → `[A-Za-z0-9._-]`, teto 180, extensão ASCII preservada, fallback `attachment`); idempotência por `clientRequestId`; path `{workspace}/{conversation}/{job}/{filename}`; `dispatch` só do job recém-persistido por este processo; signed URL de **300 s** para a WAHA baixar; falha terminal sem retry (decisão registrada).
- **`InternalInboxService`** — §4.3 (`deliver` com payload valor-ou-função; `send()` persiste `metadata.linkPreview`).
- **`LinkPreviewService`** (novo) — §4.4 completo: pipeline, constantes, SSRF, OG/Twitter/oEmbed/GitHub, cache 6 h/10 min/500.
- **`WahaMediaProxyService`** (inalterado): emite/verifica o `access_token` da rota `/media` e faz o stream da WAHA.

### 6.3 Worker

- **`WahaHttpClient.sendText`**: `POST /api/sendText` com `linkPreview: true, linkPreviewHighQuality: true`; extrai `WahaLinkPreview` do `_data` (§4.8).
- **`WahaHttpClient.sendAttachment`** (inalterado): roteia `image→/api/sendImage`, `audio→/api/sendVoice` (voiceNote) ou `/api/sendFile`, `video→/api/sendVideo`, `document→/api/sendFile` com `{ file: { url, mimetype, filename }, caption? }` — **a WAHA não restringe mimetype no `sendFile`** (§3.2.6).
- **`WahaProvider.sendText`**: valida a prévia com `linkPreviewSchema.safeParse` e a descarta silenciosamente se inválida (§4.9).
- **Transporte interno** (`internal-transport-server.ts`): a variante `sentMessage` do contrato agora admite `linkPreview` (§4.1); os ramos novos nesse arquivo (`message.sendReaction`, `contacts.page`) são estrangeiros.

### 6.4 Rotas (v1)

- **T4:** `GET /api/v1/inbox/link-preview?url=…` → 200 `LinkPreview` | 400 (URL inválida/bloqueada/sem `url`) | 422 (destino sem prévia/não-HTML/inalcançável) | 503 (serviço não injetado). Registrada antes das rotas com `:conversationId`.
- **Estrangeiras (contexto):** `POST /inbox/conversations/open`; `POST …/messages/:messageId/reactions`; `GET /inbox/messages/:messageId/reactions`; `/domain/contacts/sync*`.

### 6.5 Contratos

§4.1: `linkPreviewProviderSchema` (11 provedores), `linkPreviewSchema` (campos e tetos), `LinkPreview`/`LinkPreviewProvider`, `linkPreview` opcional no `sentMessage`. `imageUrl` é `z.string()` (não `.url()`) com teto 400 KB **para aceitar data URL** da thumbnail nativa.

### 6.6 Validações de arquivo (resumo operacional)

| Camada | Validação | Erro |
| --- | --- | --- |
| Dashboard intake | vazio / tamanho por família / magic bytes (4 KB, assinaturas conhecidas) | recusa local com motivo |
| Multer | 50 MB, 1 arquivo, memória | `LIMIT_FILE_SIZE` → erro de upload |
| API `validateFile` | tamanho por família (doc 50 MB) → 413; magic bytes (8 KB texto/12 bytes binário, conhecidos) → 400 | `Arquivo excede o limite permitido` / `Arquivo inválido` |
| Storage (bucket) | `allowed_mime_types` + 50 MB — **hoje bloqueia tipos novos e ZIP** | 503 opaco (`Temporary upload failed`) até o SQL manual |

Tabela de magic bytes por formato: ver §4.2 (PDF `%PDF-`; família ZIP `PK` incl. APK/EPUB/DOCX/XLSX/PPTX; OLE2 `d0cf11e0a1b11ae1` para doc/xls/ppt; RAR `Rar!\x1a\x07`; 7Z `377abcaf271c`; PSD `8BPS`; PS/AI `%!PS` ou `%PDF-`; texto = sem NUL).

### 6.7 Storage

- Bucket **`chatpro-temporary-attachments`** (privado, 50 MB, `allowed_mime_types` de 13 tipos **sem ZIP** — migration 011): staging dos envios; objetos removidos na confirmação ou na varredura horária (`cleanupExpired`, `setInterval` 1 h com `unref`).
- Bucket **`chatpro-whatsapp-media`** (mídia permanente das recebidas; signed URL via `SupabaseWhatsAppMediaStorage.signedUrl`, expiração 300 s no `media/access`).
- Tabela **`inbox_outbox_jobs`** (migration 011): estados `pending/processing/sent/confirmed/failed/cancelled`; índice único parcial em `external_message_id`; PK `(workspace_id, id)`.

### 6.8 WAHA (endpoints usados por esta feature)

| Endpoint | Uso |
| --- | --- |
| `POST /api/sendText` | texto; T4 passa `linkPreview: true, linkPreviewHighQuality: true` |
| `POST /api/sendFile` | documentos (sem restrição de mime) |
| `POST /api/sendImage` / `/api/sendVideo` / `/api/sendVoice` | mídias (inalterado) |
| — | **Não existe** endpoint de prévia de URL arbitrária; `/api/send/link-custom-preview` não roda no WEBJS (§3.2.3) |

Versão/engine: `devlikeapro/waha:latest-2026.7.1`, WEBJS, `http://127.0.0.1:3002` (healthy durante a feature).

---

## 7. frontend

### 7.1 Componentes e módulos (mapa)

| Módulo | Papel |
| --- | --- |
| `ui/LinkPreview.tsx` | `linkify` + componente `LinkPreview` (cartão) — §5.2/§5.3 |
| `ui/linkPreview.ts` | núcleo puro: `findUrls`, `trimUrl`, `domainFromUrl`, `providerFromUrl`, `sanitize`, `nativeLinkPreview`, `cachedLinkPreview` (+`previewCache`) — §4.17 |
| `ui/MessageMedia.tsx` | `Media`, `DocumentMessage` (§5.1), `DocumentTextPreview` (§5.4), `MediaGone` (§5.5), `saveBlob`, `useMediaFailure` |
| `ui/messageMedia.ts` | leitores puros: `documentKind`, `documentThumbnail`, `browserOpenable`, `textPreviewable`, `formatTextPreview`, `downloadWithProgress`, `wahaData`, `mediaFilename`, `mediaSize`, `durationLabel`… — §4.14 |
| `ui/attachmentIntake.ts` | intake: `ATTACHMENT_POLICY`, `attachmentKind`, `magicMatches`, `readTransfer`, `acceptAttachment`, `ACCEPTED_SUMMARY` — §4.13 |
| `api/client.ts` | `ApiClient.postFormProgress` (XHR) — §4.11 |
| `api/inbox.ts` | `InboxApi.linkPreview`, `sendAttachment` com `onProgress` — §4.12 |
| `ui/Inbox.tsx` | fiação: `uploadProgress`, chip pendente, `linkify`, `<LinkPreview>`, `accept="*/*"` — §4.16 |
| `ui/styles.css` | bloco novo "Prévia de link e documentos ricos" — §4.19 |

### 7.2 Hooks

- **`useMediaFailure(url)`** (`MessageMedia.tsx:49`): devolve `{ failure, gone, classify }`. `classify()` memoiza **a promessa** da sondagem por URL (`asked.current = { url, answer }`) — quem clica espera a mesma pergunta em vez de abrir outra. Sondagem via `probeMedia` (HEAD); 404 → `"gone"`, resto → `"transient"`. Custo zero no caminho feliz; anti-N+1 por construção.
- **`useAudio`** (inalterado): consome `useMediaFailure` para separar arquivo sumido de falha transitória no play.
- Não há hook novo na T4; `DocumentTextPreview` usa `useEffect`+`useState` locais, `LinkPreview` idem (guarda `active`).

### 7.3 Estados de UI por fluxo

- **Prévia de link:** nativa (render imediato) → sem nativa: esqueleto shimmer (`is-loading`) → cartão | nada (falha cacheada como `null`).
- **Download:** ocioso → `classify` (HEAD) → barra indeterminada ("Baixando…") → barra determinada (`N%`) → salvo (`saveBlob`) | fallback nativo (CORS) | `MediaGone` (404).
- **Upload:** chip pendente → "Enviando… N%" → "Anexo em processamento…" (100%) → some (job aceito) | "Falhou" + `setError`.
- **Prévia de texto:** "Carregando conteúdo…" → `<pre>` | "Não foi possível carregar o conteúdo."

### 7.4 Upload com progresso (detalhe)

`postFormProgress` (§4.11) só reporta quando `lengthComputable && total > 0`; pct = `min(100, round(loaded/total*100))`. A UI marca `0` ao iniciar (antes do primeiro evento) e trata `100` como "servidor processando" (a WAHA ainda precisa aceitar o arquivo — o job 202 volta depois). Erros mapeados como o `request` do fetch: `API_UNAVAILABLE` (rede), `TIMEOUT`, `REQUEST_FAILED` (abort/parse/resposta), com `details.status` e fases.

### 7.5 Download com progresso (detalhe)

`downloadWithProgress` (§4.14): `fetch` → `content-length` (ou `mediaSize` da mensagem) → `reader.read()` em laço → `onProgress(pct|null)` → `Blob` tipado pelo `content-type`. `saveBlob`: objectURL → `<a download rel="noopener">` → `click()` → `remove()` → **revoga após 1 s** (revogar na hora cancela o download em alguns navegadores — comentário no código). Fallback CORS: `nativeFallback.current = true` + `anchor.current?.click()` (o handler deixa o navegador seguir a âncora sem `preventDefault`).

### 7.6 Renderização

- **linkify:** strings puras entre âncoras (React escapa; nenhum `dangerouslySetInnerHTML`); `message-link` com `overflow-wrap: anywhere`.
- **documentKind (tons):** `pdf, doc, xls, ppt, zip, txt, code, app, design, book, img, aud, vid, file` — a cor é decoração; **a informação é o rótulo** (comentário na folha de estilo).
- **Cartão de prévia:** acento do provedor na borda esquerda (`is-*`), imagem `max-height:170px`, clamps de 2 linhas, rodapé uppercase.
- **Extensão real:** quando difere da etiqueta (`vendas-2026.xlsx` → etiqueta `XLS` + chip `XLSX`), o chip extra aparece — coberto por teste.

### 7.7 Cache de sessão (cliente)

`previewCache` em `linkPreview.ts`: `Map<string, Promise<LinkPreview|null>>` de módulo (vive pela sessão da aba). Guarda a promessa **antes** de começar a busca (N cartões do mesmo link no mesmo render = 1 request). Falha resolve `null` e fica cacheada. Sem bound explícito (limitação §11/§13).

---

## 8. links

### 8.1 O que é extraído e como cada provedor é detectado/enriquecido

**Detecção do provedor** — duas implementações espelhadas: servidor `providerFromHostname` (link-preview.service.ts) e cliente `providerFromUrl` (linkPreview.ts). O cliente cobre também `fb.watch` (facebook); o servidor cobre subdomínios (`*.youtube.com`, `*.tiktok.com`, etc.).

**Extração OG (servidor):** prioridade `og:*` → `twitter:*` → `<title>`/`meta[name=description]`; `og:site_name`; imagem resolvida contra a URL final; favicon do `<link rel=icon>` ou `/favicon.ico`; entidades decodificadas; redirect revalidado (máx. 2); corpo ≤ 1,5 MB; só `text/html`.

| Provedor | Detecção | Enriquecimento | O que aparece no cartão | Limitações conhecidas |
| --- | --- | --- | --- | --- |
| YouTube | `youtube.com`, `*.youtube.com`, `youtu.be` | oEmbed `youtube.com/oembed?url=…&format=json` → `author_name` (canal), `thumbnail_url`, `title` | thumb do vídeo, título, **autor (canal)**, domínio; acento `#fb7185` | oEmbed fora do ar → prévia segue só com OG (testado); `durationSeconds` hoje só vem de fontes que o tragam no contrato (nativo/OG não preenchem) |
| TikTok | `tiktok.com`, `*.tiktok.com` | oEmbed `tiktok.com/oembed` → `author_name` | título OG + @criador | TikTok pode exigir mais que OG para thumb; falha do oEmbed é engolida (melhor esforço) |
| GitHub | `github.com` (exato) | `api.github.com/repos/{owner}/{repo}` (UA `chatpro-link-preview`) → `description`, `stargazers_count`, `language` | autor = owner, descrição sufixada com ` — ★ N · Lang` | só URLs `github.com/{owner}/{repo}` exatas (regex `^\/([^/?#]+)\/([^/?#]+)\/?$`); rate limit da API pública sem token |
| Spotify | `open.spotify.com` | — (OG apenas) | capa via `og:image`, título, acento `#25d366` | OG do Spotify é bom público; nada além disso |
| Figma | `figma.com`, `*.figma.com` | — | OG (arquivos públicos); acento `#f0abfc` | arquivos privados → login wall → 422 → sem cartão |
| Notion | `notion.so`, `*.notion.site` | — | OG de páginas públicas | páginas privadas → login wall → sem cartão |
| Google Drive | `drive.google.com`, `docs.google.com` | — | OG do arquivo público; acento `#25d366` | arquivos restritos → OG de login → prévia pobre ou 422 |
| Dropbox | `dropbox.com`, `*.dropbox.com` | — | OG; acento `#8ac7ff` | idem login wall |
| Instagram / Facebook | domínios respectivos (+`fb.watch` no cliente) | — | OG quando o Meta entrega sem login | frequentemente login-walled → 422 → sem cartão (limitação registrada) |
| Genérico | qualquer outro host | — | OG/Twitter/`<title>`/favicon | página sem metadados → 422 "A página não tem informações para gerar a prévia" |

### 8.2 Prévia nativa (a que viaja na mensagem)

- **Recebidas:** `_data.title/description/canonicalUrl/matchedText/thumbnail(base64)/links[]` — lidas por `nativeLinkPreview` no dashboard; thumbnail vira data URL.
- **Nossos envios:** mesma matéria, devolvida pela WAHA no `sendText` e persistida em `metadata.linkPreview` (§2.3).
- A nativa **vence** a retaguarda sempre; com nativa presente a API **não é chamada** (testado).

### 8.3 Regras de exibição

- Um cartão por mensagem (primeiro link). Texto com N links → N âncoras + 1 cartão.
- Sem título **nem** imagem → sem cartão (a retaguarda pode ainda tentar; se também falhar, nada aparece).
- Link repetido em mensagens diferentes → mesma busca cacheada (servidor 6 h; cliente sessão).
- Mensagem de 4.096 chars: até 32 URLs varridas (`MAX_URLS`).

---

## 9. documentos

### 9.1 Tabela completa de tipos suportados

Colunas: extensão | mime canônico (`documentExtensionMimes`, §4.2) | etiqueta/tom (`documentKind`, §4.14) | magic bytes conferidos | abre no navegador (`browserOpenable`) | prévia de texto (`textPreviewable`) | notas.

| Ext | Mime canônico | Etiqueta (tom) | Magic | Abrir | Prévia texto | Notas |
| --- | --- | --- | --- | --- | --- | --- |
| pdf | application/pdf | PDF (pdf) | `%PDF-` | ✔ | ✘ (abre em aba) | miniatura nativa da 1ª página quando vem no `_data.thumbnail` |
| txt / log | text/plain | TXT (txt) | sem NUL (8 KB) | ✔ | ✔ | |
| md | text/markdown | MD (txt) | sem NUL | ✔ | ✔ | prévia = **texto pré-formatado**, não HTML renderizado (§5.6) |
| json | application/json | JSON (code) | sem NUL | ✔ | ✔ | prévia indentada quando parseia; cru quando não |
| xml | application/xml | XML (code) | sem NUL | ✔ | ✔ | `xmlMime` cobre `text/xml` e sufixo `+xml` |
| csv | text/csv | CSV (xls) | sem NUL | ✔ | ✔ | |
| svg | image/svg+xml | SVG (img) | sem NUL | ✔ | ✘ (abre em aba) | |
| doc | application/msword | DOC (doc) | OLE2 | ✘ | ✘ | |
| docx | …wordprocessingml.document | DOC (doc) | ZIP (`PK`) | ✘ | ✘ | chip de extensão mostra `DOCX` |
| xls | application/vnd.ms-excel | XLS (xls) | OLE2 | ✘ | ✘ | |
| xlsx | …spreadsheetml.sheet | XLS (xls) | ZIP | ✘ | ✘ | chip `XLSX` |
| ppt | application/vnd.ms-powerpoint | PPT (ppt) | OLE2 | ✘ | ✘ | |
| pptx | …presentationml.presentation | PPT (ppt) | ZIP | ✘ | ✘ | chip `PPTX` |
| zip | application/zip | ZIP (zip) | `PK` | ✘ | ✘ | **bloqueado pelo bucket hoje** — §14 (bug pré-existente) |
| rar | application/vnd.rar | RAR (zip) | `Rar!\x1a\x07` | ✘ | ✘ | `x-rar-compressed` também aceito |
| 7z | application/x-7z-compressed | 7Z (zip) | `377abcaf271c` | ✘ | ✘ | |
| apk | application/vnd.android.package-archive | APK (app) | `PK` | ✘ | ✘ | |
| psd | image/vnd.adobe.photoshop | PSD (design) | `8BPS` | ✘ | ✘ | `application/x-photoshop` também |
| ai | application/postscript | AI (design) | `%!PS` ou `%PDF-` | ✘ | ✘ | AI moderno é PDF → aceito pelos dois caminhos |
| fig | application/octet-stream | FIG (design) | não (desconhecido passa) | ✘ | ✘ | sem mime registrado — chega como octet-stream por decisão explícita |
| epub | application/epub+zip | EPUB (book) | `PK` | ✘ | ✘ | |
| (sem extensão/qualquer outra) | o declarado ou octet-stream | ARQ (file) | só se conhecido | conforme mime | conforme mime | etiqueta pelo mime quando há (`image/*`→IMG, `audio/*`→AUD, `video/*`→VID) |

**Limites:** 50 MB por documento (multer + policy + bucket). WhatsApp aceitaria 2 GB — limitação registrada (§13).

**Download:** sempre disponível (⇩), com barra via fetch/stream e fallback de âncora. **Miniatura:** só quando `_data.thumbnail` existe (PDFs recebidos costumam trazer a 1ª página; enviados por nós não trazem).

### 9.2 Caminho de abertura no navegador

`browserOpenable` verdadeiro → ação "Abrir" ↗ (`target="_blank" rel="noopener noreferrer"`) apontando para a **mesma URL resolvida** do download (signed URL 300 s ou proxy). Poupa o ciclo baixar-abrir-apagar para pdf/txt/md/json/xml/svg/csv.

---

## 10. seguranca

### 10.1 Guarda de SSRF (`link-preview.service.ts`)

O endpoint é uma janela de SSRF em potencial (o operador cola uma URL e a API busca em nome dele). Regras implementadas:

1. **Esquema:** só `http:`/`https:` — qualquer outro (ftp, file, gopher…) → 400.
2. **Host bloqueado:** `localhost`, `*.localhost`, `*.local`, `*.internal`; IPv4 `0.0.0.0/8`, `10/8`, `127/8`, `172.16.0.0/12`, `192.168/16`, `169.254/16`; IPv6 `::`, `::1`, `fe80:*`, `fc*`, `fd*`; IPv4-mapeado `::ffff:a.b.c.d` recai na regra de IPv4. A URL WHATWG normaliza IPv4 alternativo (`0x7f.1`, `2130706433`) para a forma pontilhada **antes** da checagem (comentário no código).
3. **Redirect revalidado:** `redirect: 'manual'`; cada `Location` (301/302/303/307/308) é resolvido e passa por `safeTarget` de novo — redirect para dentro da rede é recusado; máx. 2 saltos.
4. **Timeout:** 8 s por página (AbortController); 4 s para oEmbed/API.
5. **Corpo:** máx. 1,5 MB (`readLimited` cancela o stream ao estourar).
6. **Conteúdo:** só `text/html` (qualquer outro content-type → 422).
7. **Cache negativo não se aplica a 400** — URL bloqueada é erro do pedido, não do destino.

Testes cobrem: 8 hosts bloqueados (`it.each`), esquema não-http, redirect para `127.0.0.1`, não-HTML, tudo **sem fetch disparado** nos casos de bloqueio.

### 10.2 Validação de arquivo

- 50 MB em três camadas (multer, policy, bucket); tamanho mínimo 1 byte; `Number.isSafeInteger`.
- Magic bytes para as assinaturas conhecidas (§4.2); desconhecidos passam de propósito (paridade) — **documento nunca é executado pelo sistema**: viaja como anexo do WhatsApp e o destinatário decide abrir.
- `sanitizeFilename`: NFKD, só `[A-Za-z0-9._-]`, teto 180 com corte no meio (extensão preservada), fallback `attachment` — path traversal morto (teste com `../../photo.jpg` fixa).
- Storage privado; a WAHA recebe só signed URL de 300 s; o dashboard nunca recebe credencial de Storage.

### 10.3 linkify / XSS

- O texto é quebrado em **strings** (React escapa) + âncoras cujo `href` é a URL casada por regex `https?://` — nenhum HTML é montado, nenhum `dangerouslySetInnerHTML`.
- Âncoras externas sempre `target="_blank" rel="noopener noreferrer"` (message-link, cartão de prévia, "Abrir" de documento).
- `saveBlob` usa `rel="noopener"` e revoga a objectURL.
- Prévia de texto é `<pre>` (texto puro), jamais HTML renderizado — MD não vira marcação por decisão (§5.6).
- `imageUrl` da prévia pode ser `data:` (thumbnail nativa) ou URL http(s) resolvida no servidor; o `<img>` é passivo, `loading="lazy"`.

---

## 11. cache

### 11.1 Servidor (`LinkPreviewService`)

- **Estrutura:** `Map<string, CacheEntry>` em memória por processo; chave = URL final (`target.href` pós-`safeTarget`).
- **TTL:** sucesso **6 h** (`SUCCESS_TTL_MS`); falha **10 min** (`FAILURE_TTL_MS`) — cache negativo cobre 422 de destino e erros de rede; **status 400 (URL bloqueada) nunca é cacheado**.
- **Invalidação:** só por expiração (`expiresAt > now`); não há invalidação manual nem por evento.
- **Evicção:** `CACHE_MAX = 500`; ao inserir acima do teto, remove a entrada **mais antiga da ordem de inserção**; acerto de cache "toca" a entrada (delete+set) — a ordem de inserção é o critério de despejo (LRU aproximado; comentário no código).
- **Por que não persiste em banco:** REGRA 1 do AGENTS.md (Supabase é só consulta; nada de tabela nova por agente) e a prévia é reconstruível por definição. Registrado como limitação (§13).

### 11.2 Cliente (`linkPreview.ts`)

- `previewCache`: `Map` de **módulo** (vive na sessão da aba); guarda **promessas** (`Promise<LinkPreview|null>`), não valores — concorrência de render vira uma busca só; falha cacheada como `null`.
- **Sem bound e sem TTL** — cresce durante a sessão da aba (limitação aceita: mensagens por conversa são finitas e URLs repetem muito; registrado em §13).

### 11.3 O que NÃO é cacheado

- Prévia nativa não precisa de cache (viaja na mensagem).
- Signed URLs de mídia são emitidas por acesso (`media/access`), sem cache no dashboard.
- Sondagens `useMediaFailure` são memoizadas por URL **por montagem do componente** (não é cache global).

---

## 12. testes

### 12.1 Arquivos criados/atualizados pela T4, com cenários contados

**API (`apps/api/test/`):**

- **`link-preview.service.test.ts` (NOVO — 25 testes: 22 de serviço + 3 de rota).**
  - Extração (7): OG nas duas ordens de atributo + URLs relativas resolvidas; fallback Twitter → `<title>`/`meta description`; entidades HTML decodificadas; favicon default `/favicon.ico`; redirect seguido com revalidação (2 fetches, URL final); não-HTML → 422; página sem conteúdo útil → 422.
  - Enriquecimento (3): YouTube oEmbed (canal/thumb/título, OG vence onde preenchido); TikTok oEmbed + oEmbed quebrado segue com OG; GitHub repo (owner/★/linguagem, header `user-agent`).
  - SSRF (10): `it.each` com 8 hosts bloqueados (`127.0.0.1`, `localhost`, `192.168.0.1`, `10.0.0.4`, `169.254.1.1`, `[::1]`, `intranet.local`, `service.internal`) **sem fetch**; esquema `ftp://`; redirect que aponta para dentro (`127.0.0.1`) após 1 fetch.
  - Cache (2): URL repetida = 1 fetch; falha cacheada (TTL negativo) = 1 fetch.
  - Rota `GET /inbox/link-preview` (3): 200 com prévia pública (via `createApp` real + fetch stubado); 400 para `127.0.0.1` no formato de erro da API; 400 sem `url`.
- **`attachment-outbox.service.test.ts` (reescrito + ampliado).**
  - Caso antigo "rejects blocked MIME types…" → agora **"rejects oversized files before storage"** (o 415 de `.exe` octet-stream foi removido — proposital: octet-stream agora é documento).
  - Novo `describe 'AttachmentOutboxService document policy'` (~30 asserções): aceita qualquer mimetype incluindo desconhecido (`.exe` `x-msdownload`, `.fig` octet-stream); 50 MB aceito / 50 MB+1 → 413; **`it.each` com 20 casos de magic bytes** (rar ok/errado, rar mime legado, 7z ok/errado, psd ok/errado, ole2 doc ok, ole2 xls errado, apk-é-zip ok/errado, epub-é-zip, pdf ok/errado, ai como `%!PS`, ai moderno como `%PDF-`, ai errado, csv texto, csv com NUL, svg texto); mime resolvido por extensão quando octet-stream (fig→octet-stream, apk→`vnd.android.package-archive`, md→`text/markdown`, sem extensão→octet-stream); mime declarado específico vence a extensão (`relatorio.bin` com `application/pdf`).
- **`internal-inbox-content.service.test.ts` (+2):** persiste `payload.linkPreview` no `recordOutbound` quando o worker devolve prévia; **não grava `payload` nenhum** quando o texto não tem prévia.

**Worker (`apps/worker/test/`):**

- **`waha-client.test.ts` (+4 T4):** body do `sendText` contém `linkPreview: true, linkPreviewHighQuality: true`; mapeia `_data` completo (canonicalUrl vence, thumbnail→data URL); fallbacks `matchedText` → primeira URL do texto; `_data` vazio → sem prévia. **(+2 estrangeiros: reaction PUT e reaction vazia.)**
- **`waha-provider.test.ts` (+2 T4):** prévia atravessa o `sendMessage` até a resposta; prévia que viola o contrato (`url: ''`) é **descartada** sem falhar o envio. **(+1 estrangeiro: reaction.)**

**Dashboard (`apps/dashboard/src/`):**

- **`ui/linkPreview.test.ts` (NOVO — 30 asserções):** `findUrls` (5: posição qualquer; pontuação final; parêntese da frase vs. da URL; dedup + não-http; teto 32); `domainFromUrl` (2); `providerFromUrl` (`it.each` 14 URLs → provedor); `nativeLinkPreview` (6: lê `metadata.linkPreview`; enviada vence `_data`; lê `_data` com thumbnail→data URL; fallback matchedText → primeiro link do texto; sem título nem imagem → null; só imagem sustenta cartão); `cachedLinkPreview` (3: mesma URL divide promessa; falha cacheada; URLs diferentes buscam diferente).
- **`ui/InboxLinkPreview.test.tsx` (NOVO — 9):** URL vira âncora segura (classe/target/rel) e o resto segue texto; pontuação fora do `href`; sem link → sem âncora, sem cartão, **sem chamada à API**; prévia dos nossos envios renderiza sem API (classe `is-youtube`, autor, domínio); recebida `_data` com thumbnail base64 sem API; retaguarda: chama a API uma vez e desenha; **duas mensagens com o mesmo link = uma busca**; busca que falha não deixa resíduo (âncora permanece); folha de estilo tem as regras (link, card, `is-youtube`, esqueleto, clamps).
- **`api/client.test.ts` (+4 — `postFormProgress` com `FakeXHR`):** reporta pct e resolve JSON (headers, sem `content-type`, evento `lengthComputable:false` ignorado); erro do corpo → `REQUEST_FAILED` com message/details; resposta não-JSON → fase `parse` (não simula indisponibilidade); `onerror`→`API_UNAVAILABLE`, `ontimeout`→`TIMEOUT` (e `xhr.timeout` respeitado).
- **`api/inbox.test.ts` (+3):** com `onProgress` usa `postFormProgress` (e não `postForm`); sem callback segue no `postForm`; `linkPreview` chama a rota com URL `encodeURIComponent`.
- **`ui/attachmentIntake.test.ts` (atualizado):** HEIC/GIF/SVG/octet-stream/vazio/undefined → `document`; teto documento 50 MB; magic novos (rar, 7z, psd, ole2) reconhecidos; falsos (rar com corpo PDF, 7z com `PK`); json como texto; desconhecido passa (`gif`, octet-stream); `readTransfer` não separa mais por formato; `acceptAttachment` aceita gif/exe como documento; documento acima do teto → `reason: "size"`.
- **`ui/messageMedia.test.ts` (+~30):** `documentKind` `it.each` 16 extensões novas; extensão antes do mime (`foto.jpg`+`application/pdf`→IMG; `dados.csv`+`text/plain`→CSV); 9 fallbacks de mime (json, rar, 7z, apk, epub, csv, markdown, svg, msword); `documentThumbnail` (base64→data URL, data URL preservada, ausente→undefined); `browserOpenable` (pdf/md/csv/svg/json ✔; zip/apk ✘); `textPreviewable` (md/json/csv/xml ✔; pdf/svg/zip ✘); `formatTextPreview` (JSON indentado; JSON quebrado cru; trunca ~200 KB com aviso).
- **`ui/InboxMessageCards.test.tsx` (atualizado +3 T4):** cartão de documento adaptado à nova estrutura (âncora de download dentro do card; "Abrir" presente para PDF); xlsx mostra etiqueta `XLS` + chip `XLSX` + nome + tamanho e **não** oferece Abrir/Visualizar; PDF com `_data.thumbnail` mostra a miniatura; `notas.md` abre a janela de prévia de texto (conteúdo, fechar). **(+1 estrangeiro: "Conversar".)**
- **`ui/InboxMediaUnavailable.test.tsx` (atualizado):** fluxo de clique agora é HEAD (sondagem) + GET (tentativa de download com barra) → no proxy fake do teste cai na âncora nativa; asserções ajustadas (2 sondas, primeira HEAD, 2 cliques).
- **`ui/InboxPaste.test.tsx` (atualizado +2):** colar/soltar GIF anexa como documento (sem alerta de formato); novo `describe` de progresso: 6º argumento é função, barra 40% ("Enviando… 40%", `width: 40%`), 100% → "Anexo em processamento…", barra some ao resolver; regra CSS do progresso existe na folha.

### 12.2 Cobertura: o que está coberto vs. o que falta

**Coberto:** toda a lógica pura (policy, magic bytes, mime canônico, linkPreview client, documentKind/browserOpenable/textPreviewable/formatTextPreview/downloadWithProgress indiretamente), serviço de prévia completo (extração/enriquecimento/SSRF/cache), rota, persistência da prévia, worker (pedido + extração + validação), UI (linkify, cartão, esqueleto, cache, falha sem resíduo, upload com barra via FakeXHR e via mock do `sendAttachment`, cartão de documento completo, prévia de texto, GIF como documento).

**Falta / não coberto (consciente):**
- **E2E em aparelho real** (envio/recebimento via WhatsApp de verdade) — roteiro §15, pendente §13.
- `downloadWithProgress` **não tem teste unitário direto** com stream real — o caminho é exercido indiretamente pelo fluxo de fallback no `InboxMediaUnavailable.test.tsx`.
- `postFormProgress` coberto com XHR **mockado** (não há XHR real em jsdom).
- Cache do servidor: coberto TTL lógico via `now` injetável? — coberto por comportamento (1 fetch para repetições), não por expiração avançando o relógio.
- Prévia nativa de **recebidas** reais (o `_data` dos testes é sintético, fiel ao formato documentado do whatsapp-web.js).

---

## 13. pendencias

### 13.1 Obrigatórias (bloqueiam "feature pronta")

1. **SQL manual do usuário no Supabase** (o agente NÃO pode executar — REGRA 1):
   ```sql
   UPDATE storage.buckets SET allowed_mime_types = NULL
   WHERE id = 'chatpro-temporary-attachments';
   ```
   Sem isso, qualquer tipo de documento fora dos 13 da migration 011 (e **ZIP**, bug pré-existente) falha com **503 opaco** (`Temporary upload failed`) depois de passar em todas as validações da API. Alternativa menos ampla: acrescentar os mimes novos ao array — mas `NULL` (= qualquer mime, mantendo `file_size_limit` de 50 MB) é o que espelha a policy nova.
2. **`npm run build` na raiz** — nunca rodado com T4+WIP no tree. Esperado: **falhar** no typecheck da API/worker por causa do WIP estrangeiro (§4b.3). Validar que dashboard+contracts compilam; a decisão de merge precisa saber disso.
3. **Auditoria técnica final** (passo 7 do plano): gargalos, duplicações, código morto, concorrência, regressões — uma passada sobre todos os arquivos da §4.
4. **Atualizar `docs/anexos-pendencias.md`:** o §1 (ZIP no bucket) muda de natureza — agora não é "a aplicação aceita e o bucket recusa ZIP", é "a aplicação aceita **tudo** e o bucket recusa quase tudo"; registrar a saída escolhida (SQL manual) e quem a executa. O §2 (retry inexistente) segue válido.
5. **Validação manual em aparelho real** — roteiro completo em §15.

### 13.2 Opcionais / melhorias futuras

- Teste que compara a `policy` da aplicação com o `allowed_mime_types` do bucket (sugerido pelo próprio `anexos-pendencias.md`; após o SQL manual vira asserção de "bucket sem restrição").
- Bound/TTL no `previewCache` do cliente (hoje sem limite por aba).
- Invalidação/evicção mais rica no cache do servidor (hoje LRU aproximado + TTL fixo).
- Extrair `durationSeconds` de OG (`og:video:duration`) para o badge de duração sem depender da nativa.
- Miniatura de documento para **nossos envios** (hoje só recebidas a trazem; exigiria gerar thumb no upload — fora de escopo).

### 13.3 Dívida técnica

- `previewCache` do cliente sem bound (§11.2).
- Cache do servidor em memória por processo: múltiplas réplicas da API raspam/cacham em separado (aceitável; documentado §11.1).
- `documentExtensionMimes` vive na API e o intake do dashboard tem política própria espelhada — duas fontes para evoluir juntas (o projeto já aceita esse espelhamento para magic bytes/policy; registrado nos comentários dos dois lados).
- `fig` e desconhecidos chegam como `application/octet-stream` ao destinatário (sem mime registrado — decisão explícita, não descuido).

### 13.4 Limitações conhecidas (todas verificadas e deliberadas)

- **50 MB** por arquivo (multer + bucket), contra 2 GB do produto WhatsApp.
- **Login wall:** Instagram/Facebook/Notion/Drive/Figma privados devolvem OG de login ou nada → 422 → sem cartão (o link clicável permanece).
- Prévia de MD é **texto pré-formatado**, não HTML renderizado (§5.6).
- Cache de prévia **em memória** (não persiste entre restarts; §11).
- `linkPreviewHighQuality` é **melhor esforço no WEBJS** — o WhatsApp pode devolver thumbnail menor/ausente.
- Prévia nativa depende do WhatsApp gerar — texto com URL "feia" (IP, domínio estranho, localhost) geralmente **não** gera nativa; a retaguarda OG recusa localhost/privados por SSRF → esses links ficam só clicáveis. É o comportamento correto.
- oEmbed de YouTube/TikTok sujeito a rate limit/indisponibilidade — falha é engolida (prévia segue com OG).

---

## 14. supabase

### 14.1 Do que a feature depende (somente leitura/uso existente)

- **Bucket `chatpro-temporary-attachments`** (migration `supabase/migrations/011_inbox_outbox_attachments.sql`): staging privado dos anexos de saída; `file_size_limit = 52428800` (50 MB); `allowed_mime_types` com 13 tipos **sem ZIP**.
- **Bucket `chatpro-whatsapp-media`**: mídia permanente das recebidas; signed URLs de 300 s servidas pelo `media/access`.
- **Tabela `public.inbox_outbox_jobs`** (mesma migration 011): fila de envio (`pending/processing/sent/confirmed/failed/cancelled`).
- Leituras habituais: `whatsapp_messages.payload_json` (de onde vêm `_data` e `metadata.linkPreview`), `conversations`, `waha_webhook_events`.

### 14.2 Declaração explícita de não-escrita

**Esta feature NÃO criou migration, NÃO alterou policy, NÃO criou função/trigger, NÃO modificou tabela, bucket ou storage, NÃO executou qualquer SQL de escrita no Supabase.** Tudo que a T4 precisava do banco já existia (payload_json, buckets, outbox). A única mudança de banco necessária é **manual e do usuário** (abaixo), por força da REGRA 1 do AGENTS.md.

### 14.3 SQL manual obrigatório (executar no SQL Editor do projeto correto — confirmar URL/keys do `.env.local` deste repo)

```sql
UPDATE storage.buckets SET allowed_mime_types = NULL
WHERE id = 'chatpro-temporary-attachments';
```

Efeito: o bucket passa a aceitar qualquer mimetype (a policy da aplicação e o `file_size_limit` de 50 MB continuam valendo). Sem isso: 503 opaco nos formatos novos **e em ZIP** (bug já documentado em `docs/anexos-pendencias.md` §1).

### 14.4 Nota sobre migrations estrangeiras

Existem no tree duas migrations **do WIP concorrente** (reactions): `apps/api/migrations/025_message_reactions.sql` e `supabase/migrations/20260804000100_message_reactions.sql`. **Também não foram aplicadas por agentes.** Se o WIP de reactions for adiante, a aplicação delas é decisão do usuário/dono do WIP — não misturar com o SQL da T4 acima.

---

## 15. localhost — roteiro completo de validação

### 15.1 Pré-requisitos

1. Stack de pé: `npm run dev:api`, `npm run dev:worker`, `npm run dev:dashboard` (ver `package.json`/`scripts/local-runtime.mjs` para os nomes exatos `dev:*`).
2. WAHA de pé: `npm run dev:waha` (compose `docker-compose.waha.yml`; imagem `devlikeapro/waha:latest-2026.7.1`, engine WEBJS, `http://127.0.0.1:3002`) — **sessão pareada e `WORKING`** (escanear QR).
3. **SQL manual do §14.3 aplicado** (senão os envios de formato novo estouram 503 no storage).
4. Um segundo WhatsApp (aparelho real) para cruzar mensagens.

### 15.2 Envio de documentos (dashboard → contato) — checklist por tipo

Para cada um, verificar: upload com barra ("Enviando… N%" → "Anexo em processamento…"), mensagem confirmada, arquivo **abre no aparelho** com o tipo certo, cartão no dashboard com etiqueta/extensão/tamanho corretos.

- [ ] `pdf` (com e sem nome acentuado — `defParamCharset` preserva acentos)
- [ ] `txt`, `md`, `json`, `xml`, `csv`, `svg`
- [ ] `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`
- [ ] `zip` (**depende do SQL manual** — bug pré-existente), `rar`, `7z`
- [ ] `apk` (chega como APK instalável, não como binário anônimo)
- [ ] `psd`, `ai`, `fig` (fig = octet-stream por decisão)
- [ ] `epub`
- [ ] Arquivo sem extensão e arquivo com extensão desconhecida (`.xyz`) — entram como documento
- [ ] GIF/HEIC colado ou arrastado → anexa como **documento** (antes era recusado)

### 15.3 Recebimento de documentos (contato → dashboard)

- [ ] PDF enviado do aparelho → cartão com **miniatura da 1ª página** (`_data.thumbnail`), ações Abrir/Visualizar(ausente p/ pdf)/Baixar
- [ ] Documento Office/zip/etc. → etiqueta correta; download abre íntegro
- [ ] Mídia mandada "como documento" (ex.: foto como arquivo) → etiqueta IMG via mime

### 15.4 Download e abertura

- [ ] Baixar cada tipo: barra de progresso aparece; arquivo salvo com **nome original** e íntegro
- [ ] "Abrir" ↗ para pdf/txt/md/json/xml/svg/csv abre em nova aba
- [ ] "Visualizar" ≡ para md/txt/json/xml/csv: janela com conteúdo (JSON indentado), fecha no × e no clique fora
- [ ] Documento antigo (mídia já descartada pelo WhatsApp) → cartão `MediaGone` ("Documento indisponível"), sem JSON de 404 na cara

### 15.5 Links e prévias

Envie e receba cada um, conferindo **nos dois sentidos**: nativa quando existir (sem chamada à retaguarda), retaguarda quando não, um cartão por mensagem:

- [ ] YouTube (thumb + canal), TikTok (autor), GitHub repo (owner + ★ + linguagem)
- [ ] Spotify, Google Drive/Docs público, Dropbox público, Figma/Notion públicos
- [ ] OG genérico (blog/loja com `og:*`), página só com `<title>`
- [ ] Instagram/Facebook (provável login wall → sem cartão, link clicável — comportamento esperado)
- [ ] Mensagem longa com **vários** links → **1** cartão (o do primeiro); todas as URLs clicáveis
- [ ] Mesmo link em **duas** mensagens → uma busca só (conferir rede no devtools)
- [ ] Pontuação colada (`…veja https://x.com.`) → href sem o ponto; URL entre parênteses; URL estilo Wikipédia com `()` balanceado

### 15.6 Casos de erro (esperado falhar bonito)

- [ ] Arquivo **> 50 MB** → 413 "Arquivo excede o limite permitido" (job nem é criado)
- [ ] Arquivo corrompido/assinatura falsa (`.pdf` com conteúdo texto) → 400 "Arquivo inválido"
- [ ] `GET /inbox/link-preview?url=` inválida (`ftp://…`, `nota-url`) → 400
- [ ] Link de IP privado/loopback (`http://127.0.0.1/…`, `http://192.168.…`) → 400 "Este endereço não é permitido" (e **nenhum fetch** sai da API)
- [ ] Link inalcançável/sem OG → 422 → dashboard some o esqueleto e **não deixa resíduo**
- [ ] Sem o SQL manual: enviar `.rar` → 503 `Temporary upload failed` (confirma o bloqueio do bucket; reaplique o SQL depois)

### 15.7 Casos de borda

- [ ] `.fig` / `.apk` enviados com o navegador declarando octet-stream → job gravado com mime canônico (conferir `inbox_outbox_jobs.mime_type` — **somente SELECT**)
- [ ] Mesmo link duas vezes na **mesma** mensagem → duas âncoras, um cartão
- [ ] Colar screenshot (PNG) segue entrando como **imagem** (não regrediu para documento)
- [ ] Nota de voz e áudio-música seguem seus fluxos (`voiceNote`) inalterados
- [ ] Upload grande com rede lenta (devtools throttling) → barra avança; cancelar/fechar no meio → estado limpo, sem setState pós-desmontagem

---

## 16. estado_final

### 16.1 Percentual estimado: **~90%**

Código e testes unitários **concluídos e verificados**; faltam validação manual E2E, build raiz, auditoria final, update de doc auxiliar e o SQL manual do usuário.

### 16.2 O que funciona (verificado)

- Contracts: typecheck 0 erros, 5/5 testes.
- API: 493 testes passando **exceto 11 falhas estrangeiras** (`open-conversation.test.ts`, `inbox-open-conversation.test.ts`) idênticas à baseline pré-T4. Typecheck: 30 erros **todos estrangeiros** (§4b.3).
- Worker: 92/92 testes; typecheck quebrado **só** pela causa estrangeira.
- Dashboard: `tsc --noEmit` limpo; 33 arquivos, **654/654 testes** (05/08/2026 ~15:10).
- `git diff --check` limpo.

### 16.3 O que falta (em ordem recomendada de execução)

1. **Coordenar com o dono do WIP estrangeiro** — ele quebra typecheck de API+worker (`findDirectByChatId` não implementado nas stores). Sem isso, build raiz e merge saem vermelhos por causa alheia.
2. **Rodar `npm run build` na raiz** e registrar o resultado (esperado: falha API/worker por causa alheia; contracts+dashboard verdes).
3. **Auditoria técnica final** (passo 7): gargalos/duplicações/código morto/concorrência/regressões nos arquivos da §4.
4. **Atualizar `docs/anexos-pendencias.md`** (§13.1.4).
5. **Usuário: aplicar o SQL do §14.3** (bloqueante para produção; sem ele, 503 nos formatos novos e em ZIP).
6. **Validação manual §15** em aparelho real.
7. Só então: commit/merge da T4 (o usuário comanda git; agentes não comitam).

### 16.4 Riscos conhecidos

- **Merge prematuro com o WIP estrangeiro:** o typecheck compartilhado sai quebrado (30 erros API + worker). Mitigação: item 16.3.1.
- **Bucket sem o SQL manual:** 503 opaco em produção para os novos tipos e ZIP — o operador recebe "indisponível" por um arquivo que o sistema disse aceitar. Mitigação: item 16.3.5.
- **Cache de prévia em memória:** restart da API zera (seguro); múltiplas réplicas raspam em separado (aceitável, §11).
- **Prévia nativa depende do WhatsApp:** `linkPreviewHighQuality` é melhor esforço no WEBJS; ausência de nativa é estado normal e o fallback cobre — comportamento testado nas pontas.
- **Arquivos arbitrários agora entram:** mitigado por design (documento nunca é executado pelo sistema; nome sanitizado; storage privado; §10.2) — mas é uma mudança de postura que vale constar na revisão de segurança do merge.

### 16.5 Próximos passos recomendados (resumo executivo)

1. Falar com o dono do WIP (typecheck). 2. Build raiz. 3. Auditoria final. 4. Doc `anexos-pendencias.md`. 5. Usuário aplica SQL. 6. Roteiro §15. 7. Merge.

— Fim do PR de passagem de contexto da T4. Dúvidas de atribuição T4×estrangeiro: §4b. Dúvidas de "por que assim": comentários nos próprios arquivos — esta feature documenta decisões no código, não só aqui.
