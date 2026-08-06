# SPEC — Prévia de Link (Link Preview) para o novo sistema

> **Propósito:** implementar a feature de **prévia de link** no sistema de
> destino, do zero, com o mesmo comportamento do ChatPro — inclusive a correção
> do defeito que hoje **derruba mensagens com link solto** no sistema legado.
>
> **Como ler esta spec:**
> - §1 é o coração: por que mensagem nunca pode cair por causa de link, por que
>   no ChatPro não cai, e **como ler o sistema legado para achar e arrancar a
>   causa** da queda;
> - §2–§10 são a engenharia (agnóstica de stack);
> - **§11 é o design — LEIA COM ATENÇÃO: o design é por TOKENS do sistema de
>   destino. Nenhuma cor do ChatPro pode ser copiada.** Hex hardcoded de outro
>   produto quebra o tema (contraste, dark/light, identidade) do novo front;
> - §13 é o checklist de execução; **§15 lembra: commitar na `main`**.
>
> **Stack de referência (onde a feature nasceu):** TypeScript, React 18,
> Express 5, Zod, WAHA. **Stack de destino:** a do novo sistema — mapear no
> Passo 0 do §13 antes de escrever código.
> **Banco de dados:** a feature **não exige SQL, migration ou tabela nova**.

---

## §0 — O que a feature faz

### ✅ Comportamentos

| Comportamento | Detalhe |
|---|---|
| **Todo link http(s) é enviável** | A prévia é **enfeite, nunca portão** — link válido sempre envia, mesmo com a página fora do ar, travando, bloqueando robô ou sem OG (§1) |
| **Links vivos** | URLs no texto viram âncoras seguras (`target="_blank"` + `rel="noopener noreferrer"`) |
| **Prévia antes de enviar** | Cartão aparece **acima do compositor** enquanto digita (debounce 400 ms) |
| **Dispensar (×)** | Envia só o link, sem cartão — `linkPreview: false` atravessa a cadeia |
| **Prévia nativa no envio** | WAHA gera como o cliente oficial (`linkPreview: true`, `linkPreviewHighQuality: true`) |
| **Retaguarda OG/oEmbed** | Quando a nativa não existe: OG/Twitter + oEmbed (YouTube, TikTok), com **UA de navegador** |
| **Aprendizado de portal morto** | Falha de **rede** (timeout/conexão derrubada) fica cacheada por **1 h** — o sistema **detecta e para de tentar**; falha de conteúdo: 10 min |
| **Cartão rico** | Título, descrição, miniatura, domínio, favicon, duração, acento por provedor |
| **Layout compacto** | Miniatura lateral — nunca banner esticado (§11) |
| **Proteção SSRF** | Só http(s) público, revalidado a cada redirect (§8) |

### ❌ Backlog (não faz ainda)

| Limitação | Hoje | Futuro |
|---|---|---|
| Prévia editável antes de enviar | Não existe | Editor no cartão do compositor |
| Mais de uma prévia por mensagem | Só o primeiro link (paridade WhatsApp) | Sem previsão — intencional |
| Páginas atrás de login | Sem prévia | Documentado; a retaguarda não tem sessão |
| Cache persistente da retaguarda | Memória por processo | Tabela de cache (exige migration) |
| oEmbed além de YouTube/TikTok | — | Instagram/Facebook (exigem token), Spotify, X |
| Prévia em legenda de anexo | Cartão oculto com anexo | WAHA não gera prévia em caption |
| Dispensa persistente por domínio | Vale enquanto o link não muda | Preferência gravada |

---

## §1 — Princípio-mestre: a prévia é enfeite, NUNCA portão de envio

### 1.1 A regra

> **Todo link http(s) sintaticamente válido DEVE ser enviável.** A geração de
> prévia é assíncrona, best-effort, e o seu fracasso **não bloqueia, não atrasa
> e não altera** o envio — no máximo, o cartão não aparece.

### 1.2 Por que no ChatPro a mensagem não cai

1. A validação de envio aceita **qualquer texto** de 1–4.096 chars — URL solta é
   texto, ponto final;
2. A busca de prévia roda **fora do caminho do envio**: no compositor (debounce,
   assíncrona) e no provedor (a WAHA gera no aparelho). **Nenhuma etapa
   síncrona** do "Enviar" toca a internet;
3. Falha/timeout da busca → **sem cartão**, envio idêntico;
4. O destinatário vê a prévia gerada **pelo WhatsApp dele, da rede dele** — o
   portal que bloqueia o nosso servidor não bloqueia o aparelho;
5. Portal morto é **aprendido** (§9): depois da primeira falha de rede, o
   sistema para de tentar por 1 hora — nem a espera de 8 s se repete.

### 1.3 Por que o sistema legado derruba links — e como provar

Sintoma real observado: *"`https://pje1g.trf3.jus.br/pje/ConsultaPublica/listView.seam`
só envia se tiver texto antes; solto, o sistema bloqueia."*

Fato medido: o portal resolve DNS (CDN Akamai) mas **derruba a conexão** —
timeout de 25 s tanto com UA de robô quanto de navegador. O link é válido; quem
não alcança a página é **qualquer servidor**.

O padrão "solto bloqueia, com texto passa" tem assinatura: o sistema legado
**ramifica por tipo de mensagem** — texto puro segue direto; mensagem que é só
URL cai num caminho "link post" que exige **embed/preview síncrono**. O portal
trava, a etapa falha, **o envio morre junto**.

### 1.4 Método: ler o sistema legado e achar a causa (30 min)

**Passo 1 — reproduzir com log.** Envie o link solto com o console/HTTP aberto
e capture: qual request dispara? Ela chama algum endpoint de "preview",
"embed", "unfurl", "og", "metadata"? O erro é timeout, 4xx, 5xx ou validação
local (nenhuma request sai)?

**Passo 2 — grep dirigido no código do legado.** Procure, nesta ordem:

| Busca | O que indica |
|---|---|
| `preview`, `unfurl`, `embed`, `opengraph`, `og:`, `metadata`, `scrape` | Geração de embed **síncrona** no fluxo de envio |
| Validador de URL (`regex`, `isUrl`, `validUrl`, `FILTER_VALIDATE_URL`) que só roda quando a mensagem **inteira** é URL | Rejeição de TLD/caminho incomum (`.jus.br`, `.seam`) |
| Ramificação `if (message is only url)` / tipo "link" vs "text" | O caminho "link post" que exige metadados |
| `await`/`curl`/cliente HTTP **dentro** do handler de envio | Dependência síncrona de rede no envio |

**Passo 3 — classificar a causa:**

| Causa | Correção |
|---|---|
| Embed síncrono no envio | Tirar a rede do caminho do envio: enviar o texto sempre; gerar prévia **depois** (assíncrona) e anexar ao cartão quando voltar |
| Validador de URL restritivo | Validar só **sintaxe** http(s); nunca TLD, extensão de path ou "conhecido" |
| Ramificação link×texto com exigência de metadados | Unificar: toda mensagem é texto; a prévia é enriquecimento opcional |

**Passo 4 — teste de aceite do legado corrigido:** link solto de portal que
derruba conexão (PJe) **envia como texto**; cartão aparece só se a prévia
existir.

---

## §2 — Arquitetura de ponta a ponta

```
DIGITANDO (prévia no compositor — assíncrona, nunca no caminho do envio)
Compositor ──debounce 400 ms──▶ API link-preview ──safeTarget + OG/oEmbed──▶ Página
    ▲ cartão + ×                    │ cache (sucesso 6 h, rede morta 1 h)
    └── × = dispensar → envio com linkPreview: false

ENVIANDO (rede NUNCA é etapa síncrona)
Front ──▶ API ──▶ transporte interno ──▶ Worker ──▶ WAHA /api/sendText
                                                       linkPreview: true|false
                                                       (o WhatsApp gera no aparelho)

RECEBENDO/RENDERIZANDO
nativa (metadata.linkPreview ou _data) → rede zero; sem nativa → retaguarda;
falha → texto linkado permanece, cartão some sem resíduo.
```

**Duas origens de prévia, uma prioridade:** 1) **nativa** (custo zero); 2)
**retaguarda** (sob demanda, só quando a nativa não existe).

---

## §3 — Linkify (texto → âncoras)

```ts
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const MAX_URLS = 32; // texto tem 4.096 chars — varredura finita
```

- **Aparar pontuação** que gruda na URL (`. , ; : ! ? ' " »`); o `)` excedente
  sai enquanto houver mais `)` que `(` — URL estilo Wikipédia (balanceada) fica;
- Sem repetição, até 32; URL repetida vira âncora nas duas ocorrências;
- **Nunca montar HTML de URL** (`innerHTML`, `v-html`, `dangerouslySetInnerHTML`,
  `[innerHTML]`): renderizar como texto + elemento âncora do framework —
  XSS-safe por construção;
- Toda âncora: `target="_blank" rel="noopener noreferrer"` — sem exceção.

---

## §4 — Prévia no compositor (antes de enviar)

1. **Detecção:** primeiro URL do texto, memoizado/derivado do estado do campo;
2. **Debounce de 400 ms** antes de buscar — poupa a API a cada tecla;
3. **Cache de sessão reutilizado** (§9): link já visto na conversa custa zero;
4. **Cartão acima do campo:** miniatura, título, descrição, domínio + **×**;
   enquanto carrega, esqueleto (shimmer) no lugar;
5. **× (dispensar):** guarda a URL dispensada; o cartão **volta sozinho quando o
   primeiro link muda**; apagar o texto limpa tudo;
6. **Anexo pendente → sem cartão** (legenda não gera prévia na WAHA);
7. **Falha da busca → o cartão não aparece** e o envio segue normal;
8. **Envio:** dispensou → `linkPreview: false` na chamada; caso contrário o
   parâmetro **nem existe** na chamada (aridade exata, §5).

---

## §5 — A flag `linkPreview` na cadeia (envio sem prévia)

Só o `false` viaja; omitido = prévia ligada (default do WhatsApp).

| Camada | Forma |
|---|---|
| Front → API | body `{ text, mentions?, linkPreview?: boolean }` (Zod: `z.boolean().optional()`) |
| API → Worker | comando interno `message.send`, payload com `linkPreview?: boolean` |
| Worker → WAHA | `POST /api/sendText`: `linkPreview: false` e **sem** `linkPreviewHighQuality` |

**Disciplina de aridade (front):** sem dispensa e sem menção, a chamada segue
com os argumentos de sempre — nunca `undefined` "de enfeite" (espiões de teste
conferem a chamada exata):

```ts
if (mentions.length > 0 && dismissed) await api.sendMessage(id, text, mentions, false);
else if (mentions.length > 0)         await api.sendMessage(id, text, mentions);
else if (dismissed)                   await api.sendMessage(id, text, undefined, false);
else                                  await api.sendMessage(id, text);
```

**Pegadinha real:** ao adicionar o parâmetro `linkPreview` no provider do
worker, ele colidiu com a variável local homônima (a que valida a prévia
devolvida). Renomeie a **local** (ex.: `parsedPreview`) — o parâmetro é o
contrato da cadeia.

---

## §6 — Prévia nativa WAHA (envio)

```ts
POST /api/sendText
{ session, chatId, text, linkPreview: true, linkPreviewHighQuality: true, mentions? }
```

- É o **próprio WhatsApp** que resolve o link (`HighQuality` = melhor esforço
  no engine WEBJS);
- A WAHA devolve a prévia no `sentMessage`: título, descrição, thumbnail
  (base64), URL canônica — **validar com `safeParse`**; payload torto nunca
  quebra o envio;
- A API **persiste** em `metadata.linkPreview` — alimenta a renderização de
  rede zero (§10).

**Schema da prévia (Zod):**

```
url: string (obrigatória)     domain: string
title?: string (≤ 500)        description?: string (≤ 2.000)
imageUrl?: string             siteName?: string (≤ 240)
faviconUrl?: string           provider?: enum (§7)
author?: string               durationSeconds?: number
```

---

## §7 — Retaguarda OG/oEmbed (quando a nativa não existe)

> Não há endpoint WAHA para prévia de URL arbitrária e
> `/api/send/link-custom-preview` não roda no engine WEBJS — retaguarda própria.

**Endpoint:** `GET /api/v1/link-preview?url=...`

Pipeline:

1. **`safeTarget`** — SSRF (§8);
2. **Cache** (§9);
3. **Fetch:** timeout **8 s**, **máx. 2 redirects manuais** (cada `Location`
   repassa por `safeTarget`), corpo truncado em **1,5 MB**, **User-Agent de
   navegador** + `Accept-Language: pt-BR` — o fetch de servidor se identifica
   como bot e portais (governo, stacks antigas, WAF) respondem 403/406 ou
   travam. Os que derrubam conexão mesmo assim (WAF por IP) seguem enviáveis
   pela regra-mestre (§1);
4. **Metadados OG/Twitter:** `title`, `description`, `image`, `site_name`,
   favicon. Sem os três → **422**;
5. **Truncamentos:** título 500, descrição 2.000, siteName 240;
6. **Provedor por hostname:** youtube, tiktok, github, spotify, instagram,
   facebook, figma, notion, google-drive, dropbox, generic;
7. **oEmbed** (timeout **4 s**): YouTube e TikTok;
8. **Validação final** com o schema Zod antes de responder.

---

## §8 — Proteção SSRF (`safeTarget`)

Revalidado **a cada redirect**:

- Só `http:`/`https:`;
- Hostnames bloqueados: `localhost`, `*.localhost`, `*.local`, `*.internal`;
- IPv6: `::`, `::1`, `fe80:*`, `fc*`/`fd*`, IPv4-mapped (`::ffff:a.b.c.d`);
- IPv4: `0.x`, `10.x`, `127.x`, `172.16–31.x`, `192.168.x`, `169.254.x`;
- A URL WHATWG **normaliza IPv4 alternativo** (`0x7f.1`, `2130706433`) antes da
  checagem;
- 400 de URL bloqueada **nunca é cacheado**.

---

## §9 — Cache (duas camadas, nenhuma tabela)

**API (por processo):** `Map` com despejo LRU por ordem de inserção.

| | Valor |
|---|---|
| Capacidade | 500 entradas |
| Sucesso | **6 h** |
| Falha de **conteúdo** (respondeu sem OG) | **10 min** — a página pode ganhar tags |
| Falha de **rede** (timeout/conexão derrubada) | **1 h** — portal morto/WAF não se recupera em minutos; **é o mecanismo que detecta o caso e para de tentar gerar prévia** |
| 400 | **nunca cacheado** |

A distinção viaja no `details.reason` do erro interno: **só a camada de fetch
marca `'network'`**; qualquer outra falha fica no TTL curto por segurança.

**Front (por aba):** `Map<url, Promise<Preview | null>>` guardando a **promessa
antes de começar** — dez cartões do mesmo link dividem a mesma busca. Falha vira
`null` cacheado. O compositor reusa este cache.

---

## §10 — Renderização da mensagem (conversa)

Prioridade, custo zero primeiro:

1. **`metadata.linkPreview`** — nossos envios (persistido no §6);
2. **`metadata._data`** — recebidas (title/description/thumbnail base64 →
   `data:image/jpeg;base64,…`; `canonicalUrl` → `matchedText` → 1º URL do texto);
3. **Retaguarda** — só se as duas falharem, via cache de sessão.

**Validação frouxa na ponta:** exige `url` e ao menos `title` **ou** `imageUrl`.
Sem nada utilizável → o texto linkado permanece e o cartão não existe.

---

## §11 — DESIGN (agnóstico de tema — regra de ouro da replicacão)

> ### ⛔ NENHUMA COR DO CHATPRO PODE SER COPIADA
>
> O ChatPro é dark-roxo (`#c084fc`, `#241a35`, `#11101a`…). O novo sistema tem
> **tema próprio** — copiar hex de fora quebra contraste, dark/light e a
> identidade visual do produto. **Tudo que pinta usa TOKENS do sistema de
> destino** (CSS variables, design tokens, tema do framework, palette service).
> Se o sistema não tem token para algo, **cria-se o token no tema dele**, nunca
> se hardcoda hex no componente.

### 11.1 Passo prévio: mapear os tokens do sistema de destino

Antes de estilizar, preencher esta tabela com os nomes REAIS do tema de destino:

| Papel no cartão | Token do sistema de destino (preencher) |
|---|---|
| Superfície do cartão (fundo) | ex.: `--surface-2` / `theme.palette.background.paper` |
| Borda padrão | ex.: `--border-subtle` |
| Texto principal (título) | ex.: `--text-primary` |
| Texto secundário (descrição, domínio) | ex.: `--text-secondary` |
| Acento/links do produto | ex.: `--accent` / `theme.palette.primary.main` |
| Sombra de elevação | ex.: `--shadow-1` |
| Raio de borda | ex.: `--radius-md` |
| Esqueleto/shimmer | o componente de skeleton **do sistema**, se existir |

### 11.2 Estrutura (comportamento — vale em qualquer tema)

- **Layout compacto, miniatura lateral:** 92 × 92 px na conversa, 72 px no
  compositor, `object-fit: cover`. **Nunca banner `width: 100%`** — a imagem do
  provedor é pequena e esticada parece "baixa resolução" (foi o defeito real
  corrigido no ChatPro);
- **Sem imagem:** o corpo ocupa o cartão inteiro (flex, não grid fixa);
- **Acento de provedor:** borda esquerda de 3 px. As cores de provedor (YouTube
  vermelho, Spotify verde…) são as **únicas cores de marca permitidas fora do
  tema** — e mesmo assim devem vir de um **mapa de tokens semânticos** criado no
  tema de destino (`--provider-youtube`, `--provider-spotify`…), escolhidas para
  contrastar com os fundos **dele**, nos dois modos (dark/light);
- **Tipografia:** título 2 linhas com clamp, descrição 2 linhas com clamp,
  domínio em caps pequeno — sempre com as **escalas tipográficas do sistema**,
  não com px soltos;
- **Estados:** hover/focus com elevação sutil usando `--shadow-*` do tema;
  `is-loading` ignora clique; foco visível (a11y) com o outline do tema;
- **Esqueleto:** shimmer com as cores de superfície do tema (ou o skeleton
  pronto dele);
- **Responsivo:** cartão `width: min(360px, 100%)`; no compositor,
  `width: min(430px, 100%)` → 100% em telas estreitas;
- **Acessibilidade:** o cartão é `<a>` com `aria-label="Abrir link: {título}"`;
  o × tem `aria-label` próprio ("Enviar sem a prévia do link") e é alcançável
  por teclado;
- **Verificação de contraste:** título e descrição sobre a superfície do cartão
  ≥ 4.5:1 nos dois modos — medir com as ferramentas do tema, não assumir.

### 11.3 Teste de design obrigatório (a regra que o ChatPro usa)

Existe um teste automatizado que **proíbe cor nova**: todo hex usado num bloco
novo de CSS precisa já existir na folha antes dele. Replicar o equivalente no
sistema de destino: um lint/teste que falha se o componente novo introduzir cor
fora dos tokens do tema. **É o guarda que impede o design de quebrar o front.**

---

## §12 — Segurança (resumo)

| Ameaça | Defesa |
|---|---|
| Envio derrubado por link "problemático" | §1 — rede nunca é etapa síncrona do envio |
| SSRF | `safeTarget` completo (§8), revalidado a cada redirect |
| XSS via linkify | Nunca montar HTML de URL; texto + âncora do framework |
| Tabnabbing | `noopener noreferrer` em 100% das âncoras |
| Payload torto do provedor | `safeParse` no worker; validação frouxa no render |
| Abuso da retaguarda | Timeouts 8 s/4 s, corpo 1,5 MB, cache de falha, UA honesto |
| Design quebrando o tema | §11 — só tokens + teste de "cor nova" |

---

## §13 — Checklist de execução

### Passo 0 — Aprender o sistema de destino (antes de qualquer código)

**Frontend:** framework/versão? Onde fica a caixa de mensagem? Modelo de estado?
Como observar "o texto mudou"? O HTTP client já dedupa requisições? Como o
render sanitiza HTML? Runner de testes?

**Design (§11.1):** quais os nomes REAIS dos tokens (superfície, borda, textos,
acento, sombra, raio)? Tem skeleton pronto? Dark/light?

### Backend / provedor

1. [ ] Schema Zod da prévia (§6) + `linkPreview?: boolean` no body e no comando;
2. [ ] Endpoint de retaguarda com pipeline do §7 (**UA de navegador** incluso);
3. [ ] `safeTarget` completo (§8);
4. [ ] Cache com **rede 1 h × conteúdo 10 min** (§9);
5. [ ] `sendText`: `linkPreview: true` + HighQuality por padrão; `false` sem
       HighQuality quando dispensado;
6. [ ] `safeParse` da prévia devolvida; persistência em `metadata.linkPreview`;
7. [ ] Extração de `_data` no recebimento.

### Frontend (no framework DELE, com os tokens DELE)

8. [ ] Linkify do §3 (sem HTML montado);
9. [ ] Cartão da conversa: nativa → retaguarda, falha sem resíduo (§10);
10. [ ] **Layout compacto + tokens do tema** (§11) — nada de hex de fora;
11. [ ] **Compositor:** primeiro link, debounce 400 ms, cache de sessão, × por
        URL (reexibe ao mudar), oculto com anexo, shimmer (§4);
12. [ ] **Aridade exata** no envio (§5).

### Correção do legado (§1.4)

13. [ ] Reproduzir a queda com log; grep dirigido; classificar a causa;
14. [ ] Arrancar a rede do caminho do envio; validador só de sintaxe;
15. [ ] Aceite: link solto do PJe envia como texto.

### Testes

16. [ ] Linkify: pontuação, parêntese balanceado, atributos, sem URL → nada;
17. [ ] Retaguarda: SSRF, 422 sem OG, cache hit/TTL, **rede 1 h × conteúdo
        10 min**, oEmbed, UA de navegador no fetch;
18. [ ] Worker: body com `true`+HighQuality por padrão; `false` sem HighQuality;
19. [ ] API: `linkPreview: false` só viaja quando presente;
20. [ ] Compositor: cartão com debounce, × → envio com `false`, sem dispensar →
        chamada original, link novo reexibe, sem link → API não chamada;
21. [ ] **Design:** teste/lint de "cor nova fora dos tokens" verde.

---

## §14 — Limitações registradas de propósito

- Só o primeiro link ganha prévia (paridade intencional);
- Cache em memória — reiniciar a API limpa (persistir exigiria tabela nova);
- Páginas com login não geram prévia pela retaguarda;
- oEmbed só YouTube/TikTok;
- Portal morto é repescado só depois de 1 h;
- Legenda de anexo não tem prévia (limitação da WAHA).

---

## §15 — Lembretes finais

1. **💾 COMMITAR NA `main`:** esta spec e a implementação devem ser commitadas
   na branch `main` do repositório (não ficar só em branch de feature/local);
2. **⛔ Nenhuma cor do ChatPro** no front novo — só tokens do tema de destino
   (§11), com o teste de "cor nova" ligado;
3. **A prévia é enfeite, nunca portão** (§1) — se uma decisão de implementação
   ameaçar derrubar mensagem por causa de link, a decisão está errada;
4. Esta feature **não precisa de SQL** — se aparecer uma migration no caminho,
   parar e revisar.

---

*Spec de referência: implementação do ChatPro (547 testes de API, 100 de worker,
8 de contratos, 706 de dashboard verdes), incluindo as correções reais: prévia
no compositor com dispensa, layout compacto, UA de navegador e aprendizado de
portal morto (falha de rede cacheada por 1 h).*
