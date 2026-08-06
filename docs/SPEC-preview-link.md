# SPEC — Prévia de Link (Link Preview)

> **Propósito:** documentar a feature de **prévia de link** do ChatPro de forma
> independente e completa, com detalhe suficiente para **replicar em outro
> sistema do zero**, sem ler o código original.
>
> **Stack de referência:** TypeScript, React 18 (dashboard), Express 5 (API),
> Zod (contratos), worker interno + WAHA (provedor WhatsApp).
> **Banco de dados:** esta feature **não exige nenhum SQL, migration ou tabela
> nova** — o cache é em memória por decisão (ver §8).
>
> **⚠️ Frontend de destino ≠ frontend de referência.** Tudo que é de UI nesta
> spec foi escrito contra React 18 + Vite. Se o sistema de destino usa outro
> framework (Angular, Vue, Svelte, Razor, Flutter, mobile nativo…), **não copie
> os trechos de UI** — comece pelo **Passo 0 do §12**, que mapeia o frontend de
> destino e separa o que é portável (regras, tempos, caches, layout) do que é
> acoplado ao React (JSX, hooks, escaping). A lógica de API/worker/SSRF/cache
> (§4–§8) é agnóstica e vale para qualquer stack.

---

## §0 — O que a feature faz HOJE

### ✅ Funciona

| Comportamento | Detalhe |
|---|---|
| **Links vivos** | URLs no texto das mensagens viram âncoras clicáveis seguras (`target="_blank"` + `rel="noopener noreferrer"`) |
| **Prévia antes de enviar** | Ao digitar/colar um link, o cartão aparece **acima do compositor** (debounce de 400 ms) — como o WhatsApp Web |
| **Dispensar a prévia (×)** | O operador clica no × e envia **só o link, sem cartão** — `linkPreview: false` atravessa toda a cadeia até a WAHA |
| **Prévia nativa no envio** | A WAHA gera a prévia como o cliente oficial (`linkPreview: true`, `linkPreviewHighQuality: true`) |
| **Retaguarda OG/oEmbed** | Quando a prévia nativa não existe (mensagens recebidas sem `_data`, histórico), a API raspa OG/Twitter e enriquece com oEmbed (YouTube, TikTok) |
| **Cartão rico** | Título, descrição, miniatura, domínio/site, favicon, duração (vídeo) e **cor de borda por provedor** |
| **Layout compacto** | Miniatura lateral (~92 px na conversa, ~72 px no compositor), como o WhatsApp — nada de banner esticado |
| **Cache em duas camadas** | API: LRU em memória (500 entradas, 6 h sucesso / 10 min falha). Dashboard: cache de sessão por URL |
| **Proteção SSRF** | Só http(s) público; IPs privados/loopback/link-local bloqueados, revalidado a cada redirect |

### ❌ Não faz ainda (backlog)

| Limitação | Comportamento atual | Melhoria futura |
|---|---|---|
| **Prévia editável** (trocar título/imagem antes de enviar) | Não existe — a prévia é a nativa ou a raspada | Editor de prévia no cartão do compositor |
| **Mais de uma prévia por mensagem** | Só o **primeiro** link ganha cartão (como o WhatsApp) | Sem previsão — é paridade intencional |
| **Páginas atrás de login** | Retaguarda falha com 422; cartão não aparece | Documentado; sem solução prevista (a retaguarda não tem sessão) |
| **Cache persistente da retaguarda** | Memória por processo — reiniciar a API limpa | Tabela de cache (exige migration — fora do escopo) |
| **oEmbed para mais provedores** | Só YouTube e TikTok | Instagram/Facebook (exigem token), Spotify, X/Twitter |
| **Prévia em legenda de anexo** | Cartão do compositor some quando há anexo pendente | WAHA não gera prévia em caption — manter oculto |
| **Dismiss "lembrar para sempre"** | A dispensa vale enquanto o link não muda no rascunho | Preferência persistida por domínio |

---

## §1 — Arquitetura de ponta a ponta

```
DIGITANDO (prévia no compositor)
┌──────────┐  debounce 400 ms   ┌─────────┐  safeTarget + OG/oEmbed  ┌─────────┐
│ Compositor│ ────────────────▶ │   API   │ ───────────────────────▶ │  Página │
│ (React)   │  GET link-preview  │ (cache) │ ◀─────────────────────── │  destino│
└──────────┘ ◀──────────────── └─────────┘   título/descr./imagem    └─────────┘
      │ cartão + botão ×
      │ ×  = dispensar → enviar com linkPreview: false
      ▼
ENVIANDO
Dashboard ──▶ API ──▶ transporte interno ──▶ Worker ──▶ WAHA /api/sendText
              (body)   (comando message.send)            linkPreview: true|false
                                                              │ o WhatsApp gera
                                                              ▼ a prévia no aparelho
RECEBENDO / RENDERIZANDO
WAHA webhook → API persiste _data.linkPreview → dashboard: nativa (rede zero)
vence; sem nativa → retaguarda OG da API; falha → o texto linkado permanece,
o cartão some sem resíduo.
```

**Duas origens de prévia, uma prioridade clara:**

1. **Nativa (custo de rede zero)** — a que o WhatsApp gerou no envio (persistida
   em `metadata.linkPreview`) ou a que veio no `_data` da mensagem recebida;
2. **Retaguarda (sob demanda)** — a raspagem OG/oEmbed da API, só quando a
   nativa não existe.

---

## §2 — Linkify (texto → âncoras)

```ts
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const MAX_URLS = 32; // texto tem 4.096 chars no contrato — varredura finita
```

- **Aparar pontuação da frase** que gruda na URL (`.`, `,`, `;`, `:`, `!`, `?`,
  aspas, `»`); o `)` excedente sai **enquanto houver mais `)` que `(`** — o da
  frase sai, o de URL estilo Wikipédia (balanceado) fica;
- Sem repetição de URL, no máximo 32;
- **Renderização sem HTML montado:** os trechos entre URLs seguem como strings
  puras (o React escapa) e cada URL vira `<a>` — XSS-safe por construção;
- Toda âncora: `target="_blank" rel="noopener noreferrer"` — sem exceção;
- URL repetida vira âncora nas duas ocorrências (a busca anda para a frente).

---

## §3 — Prévia no compositor (antes de enviar)

O comportamento que o WhatsApp Web tem e que esta spec replica:

1. **Detecção:** primeiro URL do texto — `findUrls(composerText)[0]`, memoizado;
2. **Debounce de 400 ms** antes de buscar — poupa a API a cada tecla;
3. **Cache de sessão reutilizado** (`previewCache`, ver §8): link que já tem
   cartão na conversa não custa rede de novo;
4. **Cartão acima do campo:** miniatura, título, descrição, domínio + **botão ×**;
   enquanto carrega, um esqueleto (shimmer) ocupa o lugar;
5. **× (dispensar):** guarda a URL dispensada; o cartão **volta sozinho quando o
   primeiro link muda**; apagar o texto limpa tudo;
6. **Anexo pendente → sem cartão:** legenda de anexo não gera prévia na WAHA,
   então o cartão do compositor também some;
7. **Falha da busca → o cartão não aparece** e o envio segue normal (com prévia
   nativa, que é o default);
8. **Envio:** dispensou → `sendMessage(id, text, mentions?, false)`; caso
   contrário a chamada vai **sem o 4º argumento** — ver disciplina de aridade no §4.

---

## §4 — A flag `linkPreview` na cadeia (envio sem prévia)

A dispensa do operador atravessa 5 camadas. **Só o `false` viaja** — omitido
significa "prévia ligada" (default do WhatsApp):

| Camada | Onde | Forma |
|---|---|---|
| Dashboard → API | `POST /inbox/conversations/{id}/messages` | body `{ text, mentions?, linkPreview?: boolean }` |
| API — validação | schema do body (Zod) | `linkPreview: z.boolean().optional()` |
| API → Worker | comando interno `message.send` | payload `{ wahaSession, chatId, text, mentions?, linkPreview?: boolean }` |
| Worker → WAHA | `POST /api/sendText` | `linkPreview: false` e **sem** `linkPreviewHighQuality` |
| WAHA → WhatsApp | o app envia o texto puro | nenhum cartão é gerado |

**Disciplina de aridade (frontend):** sem dispensa e sem menção, a chamada segue
de **2 argumentos**, como sempre foi. Nunca passar `undefined` "de enfeite" —
espiões de teste (e contratos implícitos) conferem a chamada exata. Ramos:

```ts
if (mentions.length > 0 && dismissed) await api.sendMessage(id, text, mentions, false);
else if (mentions.length > 0)          await api.sendMessage(id, text, mentions);
else if (dismissed)                    await api.sendMessage(id, text, undefined, false);
else                                   await api.sendMessage(id, text);
```

**Pegadinha real encontrada:** ao adicionar o parâmetro `linkPreview` no provider
do worker, ele colidiu com a variável local que já existia com esse nome (a que
valida a prévia nativa devolvida pela WAHA). Renomeie a local (ex.:
`parsedPreview`) — não o parâmetro, cujo nome é o contrato da cadeia.

---

## §5 — Prévia nativa WAHA (envio)

```ts
POST /api/sendText
{ session, chatId, text, linkPreview: true, linkPreviewHighQuality: true, mentions? }
```

- É o **próprio WhatsApp** que resolve o link, como no cliente oficial —
  `linkPreviewHighQuality` é melhor esforço no engine WEBJS;
- A WAHA devolve a prévia gerada no `sentMessage` (`_data.linkPreview` ou
  equivalente): título, descrição, thumbnail (base64), URL canônica;
- O worker **valida com `safeParse`** (`linkPreviewSchema`) antes de repassar —
  payload torto do provedor nunca quebra o envio; sem prévia válida, a mensagem
  segue sem ela;
- A API **persiste** a prévia em `metadata.linkPreview` da mensagem — é o que
  alimenta a renderização de rede zero no §10.

**Schema da prévia (Zod):**

```
url: string (obrigatória)
domain: string
title?: string (≤ 500)      description?: string (≤ 2.000)
imageUrl?: string           siteName?: string (≤ 240)
faviconUrl?: string         provider?: enum (ver §6)
author?: string             durationSeconds?: number
```

---

## §6 — Retaguarda OG/oEmbed (quando a nativa não existe)

> Não há endpoint WAHA para prévia de URL arbitrária e
> `/api/send/link-custom-preview` não roda no engine WEBJS — a retaguarda é própria.

**Endpoint:** `GET /api/v1/link-preview?url=...`

Pipeline:

1. **`safeTarget`** — guarda de SSRF (§7);
2. **Cache** (§8) — consulta antes de qualquer fetch;
3. **Fetch da página:** timeout **8 s**, **máx. 2 redirects manuais** (cada
   `Location` resolve contra a URL corrente e **repassa por `safeTarget`**),
   corpo truncado em **1,5 MB**;
4. **Metadados OG/Twitter:** `title`, `description`, `image`, `site_name`,
   favicon. Sem título, descrição **e** imagem → **422** `A página não tem
   informações para gerar a prévia`;
5. **Truncamentos:** título 500, descrição 2.000, siteName 240;
6. **Provedor por hostname** (define a cor da borda do cartão):

| Provedor | Hosts |
|---|---|
| youtube | `youtu.be`, `youtube.com`, `*.youtube.com` |
| tiktok | `tiktok.com`, `*.tiktok.com` |
| github | `github.com` |
| spotify | `open.spotify.com` |
| instagram | `instagram.com`, `*.instagram.com` |
| facebook | `facebook.com`, `*.facebook.com`, `fb.watch` |
| figma | `figma.com`, `*.figma.com` |
| notion | `notion.so`, `*.notion.site` |
| google-drive | `drive.google.com`, `docs.google.com` |
| dropbox | `dropbox.com`, `*.dropbox.com` |
| generic | todo o resto |

7. **oEmbed** (timeout próprio de **4 s**): YouTube
   (`https://www.youtube.com/oembed?url=...&format=json`) e TikTok
   (`https://www.tiktok.com/oembed?url=...`) — enriquece título/autor/thumbnail;
8. **Validação final** com o schema Zod antes de responder.

---

## §7 — Proteção SSRF (`safeTarget`)

O endpoint é uma janela de SSRF em potencial: o operador cola uma URL e a API
busca em nome dele. Regras, **revalidadas a cada redirect**:

- Só `http:` e `https:` — qualquer outro esquema → 400;
- **Hostnames bloqueados:** `localhost`, `*.localhost`, `*.local`, `*.internal`;
- **IPv6 bloqueados:** `::`, `::1`, `fe80:*` (link-local), `fc*`/`fd*` (ULA),
  IPv4-mapped (`::ffff:a.b.c.d` — desmonta e confere o IPv4);
- **IPv4 bloqueados:** `0.x`, `10.x`, `127.x`, `172.16–31.x`, `192.168.x`,
  `169.254.x` (link-local/metadata de cloud);
- A URL **WHATWG normaliza IPv4 alternativo** (`0x7f.1`, `2130706433`) para a
  forma pontilhada **antes** da checagem — não tente burlar com notação
  hexadecimal/decimal;
- 400 de URL bloqueada **nunca é cacheado** (é erro do pedido, não do destino).

---

## §8 — Cache (duas camadas, nenhuma tabela)

**API (por processo):** `Map` com despejo LRU por ordem de inserção.

| | Valor |
|---|---|
| Capacidade | 500 entradas |
| TTL de sucesso | **6 horas** |
| TTL de falha | **10 minutos** |
| 400 (URL bloqueada) | **nunca cacheado** |

Justificativa: a prévia é reconstruível por definição; persistir exigiria tabela
nova (proibido sem solicitação). Reiniciar a API limpa o cache — aceito.

**Dashboard (por aba):** `Map<string, Promise<Preview | null>>` guardando a
**promessa antes de começar** — dez cartões do mesmo link montados no mesmo
render dividem a mesma busca. Falha vira `null` cacheado: insistir na raspagem
que acabou de falhar é pedir o mesmo 422 a cada mensagem. O compositor reusa
este cache (§3).

---

## §9 — Layout do cartão (a correção de "qualidade")

**Regra de ouro: miniatura lateral compacta — nunca banner esticado.**

A imagem que o provedor devolve é pequena. Num banner `width: 100%` (360 px) ela
estica e parece "baixa resolução"; renderizada no tamanho certo, a mesma imagem
fica nítida. Por isso:

- **Cartão da conversa:** flex, miniatura **92 × 92 px** à esquerda
  (`object-fit: cover`), corpo à direita (título 2 linhas, descrição 2 linhas,
  site/domínio, favicon, URL encurtada);
- **Cartão do compositor:** mesma estrutura, miniatura **72 px**;
- **Sem imagem:** o corpo ocupa o cartão inteiro (flex, não grid fixa);
- **Duração de vídeo:** selo `m:ss` sobre a miniatura;
- **Borda esquerda colorida por provedor** (o acento muda como o WhatsApp muda o
  cartão de YouTube para o de Instagram);
- **Esqueleto shimmer** enquanto a retaguarda responde; `is-loading` ignora
  clique;
- Sempre `<a target="_blank" rel="noopener noreferrer">`, com `aria-label`
  "Abrir link: {título}".

---

## §10 — Renderização da mensagem (conversa)

Prioridade do WhatsApp, custo de rede zero primeiro:

1. **`metadata.linkPreview`** — os nossos envios, persistidos pela API a partir
   do que a WAHA devolveu no `sendText`;
2. **`metadata._data`** — as recebidas, payload cru do whatsapp-web.js
   (`title`, `description`, `thumbnail` base64 → `data:image/jpeg;base64,…`,
   `canonicalUrl` → `matchedText` → primeiro URL do texto);
3. **Retaguarda** — só se as duas acima falharem; via cache de sessão.

**Validação frouxa na ponta:** exige `url` e ao menos `title` **ou** `imageUrl`;
campo torto cai fora em vez de derrubar o cartão. Sem nada utilizável → o texto
linkado permanece e o cartão simplesmente não existe.

---

## §11 — Segurança (resumo)

| Ameaça | Defesa |
|---|---|
| SSRF | `safeTarget` completo (§7), revalidado a cada redirect |
| XSS via linkify | Nenhum HTML montado — strings puras + `<a>` do React |
| Tabnabbing | `target="_blank"` + `rel="noopener noreferrer"` em 100% das âncoras |
| Payload torto do provedor | `safeParse` no worker; validação frouxa na renderização |
| Abuso da retaguarda | Timeout 8 s/4 s, corpo 1,5 MB, cache de falha 10 min, 400 sem cache |
| Redirect para intranet | Cada `Location` repassa por `safeTarget` |

---

## §12 — Checklist de replicação no outro sistema

### Passo 0 — Aprender o frontend de destino (antes de qualquer código)

A feature foi desenhada para React 18 + Vite. O sistema de destino tem frontend
próprio, com convenções próprias — **a função precisa nascer de acordo com ele,
não traduzida ao pé da letra**. Responda isto primeiro:

| Pergunta | Para que muda a implementação |
|---|---|
| Framework e versão? (Angular, Vue, Svelte, Razor/Blazor, Flutter, React Native…) | Como se escrevem o cartão, o compositor e os listeners de texto |
| Componente de "caixa de mensagem" já existe? Onde? | Onde pendurar a detecção de URL e o cartão de prévia |
| Estado: signals, stores, services, setState? | Onde vivem `composerPreview` e `dismissedPreviewUrl` |
| Reatividade: como observar "o texto mudou"? (two-way binding, evento, observable) | Onde entra o **debounce de 400 ms** |
| HTTP client do sistema já tem cache/dedup de requisições? | Se o `previewCache` por promessa (§8) já existe de graça |
| CSS: global, modules, Tailwind, styled, folhas nativas? | Como portar o layout do §9 (miniatura lateral, shimmer, borda por provedor) |
| Sanitização de HTML/marks no render? (Angular sanitiza; Vue `v-text`; React escapa) | Como manter o linkify **XSS-safe por construção** (§2) |
| Testes de UI: qual runner e harness? | Como reescrever os testes do §12/itens 17–21 |

**O que é portável (vale em qualquer frontend):**

- Só o **primeiro link**; debounce de **400 ms**; cache de sessão **por promessa**;
- Dispensa **por URL** que reexibe quando o link muda; cartão **oculto com anexo pendente**;
- **Aridade exata** no envio — `linkPreview: false` só quando dispensado (§4);
- Prioridade **nativa → retaguarda** e **falha sem resíduo** (§10);
- **Layout compacto** com miniatura lateral 92/72 px — nunca banner (§9);
- Âncoras sempre com `target="_blank" rel="noopener noreferrer"`;
- Esqueleto shimmer no lugar do cartão enquanto carrega.

**O que é acoplado ao React (reescrever no framework de destino):**

- JSX/hooks (`useMemo`, `useEffect`, `useState`) → equivalente idiomático;
- "Strings puras escapadas pelo React" → o mecanismo de escaping do destino
  (nunca montar HTML de URL com `innerHTML`/`[innerHTML]`/`v-html`);
- O componente `LinkPreview` → componente nativo do sistema de destino;
- O harness de teste (Testing Library) → o harness do destino.

### Checklist

**Contratos**
1. [ ] Schema Zod da prévia (§5) + `linkPreview?: boolean` no body de envio e no
       comando interno `message.send`.

**API**
2. [ ] Endpoint `GET /link-preview?url=` com o pipeline do §6 (timeouts 8 s/4 s,
       2 redirects revalidados, corpo 1,5 MB, truncamentos);
3. [ ] `safeTarget` completo (§7) — inclusive IPv4 alternativo e IPv4-mapped;
4. [ ] Cache LRU em memória: 500 entradas, 6 h/10 min, 400 sem cache (§8);
5. [ ] Repasse do `linkPreview: false` para o comando interno (só o false viaja);
6. [ ] Persistência da prévia nativa em `metadata.linkPreview` no envio.

**Worker / provedor**
7. [ ] `sendText` com `linkPreview: true` + `linkPreviewHighQuality: true` por
       padrão; **`linkPreview: false` (sem HighQuality) quando dispensado**;
8. [ ] `safeParse` da prévia devolvida pela WAHA (cuidado com a colisão de nome
       do §4);
9. [ ] Extração de `_data` no recebimento (title/description/thumbnail/canonicalUrl).

**Frontend**
10. [ ] Linkify do §2 (trim de pontuação, parêntese balanceado, 32 URLs);
11. [ ] Cartão da conversa: prioridade nativa → retaguarda, validação frouxa,
        falha sem resíduo (§10);
12. [ ] **Layout compacto de miniatura lateral** (§9) — não banner;
13. [ ] **Compositor:** detecção do primeiro link, debounce 400 ms, cache de
        sessão, × que dispensa por URL (reexibe se o link mudar), oculto com
        anexo pendente, esqueleto shimmer (§3);
14. [ ] **Aridade exata** no envio (§4) — sem `undefined` de enfeite;
15. [ ] Cache de sessão por URL guardando a promessa (§8).

**Infra**
16. [ ] Nenhum SQL necessário — esta feature não toca o banco. ✅

**Testes mínimos**
17. [ ] Linkify: pontuação fora do href, parêntese balanceado, atributos de
        segurança, sem URL → sem elemento;
18. [ ] Retaguarda: SSRF bloqueia IP privado/redirect interno, 422 sem
        metadados, cache hit/TTL, oEmbed enriquece;
19. [ ] Worker: body com `linkPreview: true` + HighQuality por padrão; com
        `false` quando dispensado (e sem HighQuality);
20. [ ] API: `linkPreview: false` só viaja no comando quando presente no body;
21. [ ] Compositor: cartão aparece com o link (debounce), × esconde e o envio
        vai com `false`, sem dispensar vai com 2 argumentos, link novo reexibe,
        texto sem link não chama a API.

---

## §13 — Limitações registradas de propósito

- **Só o primeiro link** ganha prévia — paridade intencional com o WhatsApp;
- **Cache em memória** — reiniciar a API limpa; persistir exigiria tabela nova;
- **Páginas com login** não geram prévia pela retaguarda (ela não tem sessão);
- **oEmbed só YouTube/TikTok** — Instagram/Facebook exigem token de app;
- **Sem retry** de raspagem que falhou dentro da janela de 10 min (cache de falha);
- **Legenda de anexo não tem prévia** — limitação da WAHA, não da aplicação.

---

*Spec gerada a partir da implementação do ChatPro (branch `feat/replace-repository-with-chatpro`),
validada com 530 testes de API, 100 de worker, 8 de contratos e 706 de dashboard.*
