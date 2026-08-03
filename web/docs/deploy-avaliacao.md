# Avaliação de deploy: tirar o ChatPro da máquina local

**03/08/2026. Somente leitura.** Nenhum código foi alterado, nada foi escrito no
banco, nada foi implantado. Levantamento para decidir a arquitetura de produção.

Custos são **estimativas de ordem de grandeza, não verificadas nesta data**.

---

## 1. Inventário: o que precisa rodar

Quatro peças, e elas não têm o mesmo formato.

### 1.1 API (`apps/api`)

| | |
|---|---|
| **Processo persistente** | **Sim, obrigatório** |
| **Disco** | Só com `DATABASE_PROVIDER=sqlite`. Com `supabase`, nenhum |
| **Porta** | `API_PORT`, padrão 3000. HTTP **e** WebSocket no mesmo servidor |
| **Timeout** | Nenhum limite próprio; transmite mídia em stream, sem teto de duração |

Precisa de processo vivo por três motivos, todos em `app.ts`:

- **`setInterval` de 60 s** — o relógio de SLA (`sla.tick()`), que promove
  conversa a `expired`;
- **`setInterval` de 1 h** — limpeza de anexos temporários expirados;
- **`WebSocketServer`** em `/ws`, anexado ao mesmo servidor HTTP
  (`websocket.ts:8`), que entrega o realtime da Inbox.

Há ainda um disparo de boot: `identitySync.enqueueBackfill()`, que resolve
identidades pendentes assim que o processo sobe.

Variáveis (15): `API_PORT`, `NODE_ENV`, `DATABASE_PROVIDER`,
`CHATPRO_DATABASE_PATH`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`WORKER_TRANSPORT_URL`, `WORKER_TRANSPORT_TIMEOUT_MS`, `WAHA_BASE_URL`,
`WAHA_API_KEY`, `WAHA_WEBHOOK_HMAC_KEY`, `WAHA_WEBHOOK_WORKSPACE_ID`,
`MEDIA_PROXY_TOKEN_SECRET`, `WHATSAPP_OWN_NUMBERS`,
`CHATPRO_DEVELOPMENT_USER_ID`.

**Recebe upload de até 50 MB** por requisição (`fileSize: 50 * 1024 * 1024`) e
**transmite bytes de mídia** da WAHA para o navegador com
`pipeline(Readable.fromWeb(...))` — resposta de duração indeterminada, presa à
velocidade do cliente.

### 1.2 Worker (`apps/worker`)

| | |
|---|---|
| **Processo persistente** | **Sim, obrigatório** |
| **Disco** | **Sim, com estado que não pode se perder** |
| **Porta** | `WORKER_TRANSPORT_PORT`, padrão 3101, HTTP interno |
| **Timeout** | Conexão WhatsApp de vida longa; reconexão com backoff |

Escreve em `CHATPRO_DATA_DIR` (padrão `.chatpro-data`):

- **`waha-sessions.json`** — o registro de sessões, com
  `{ workspaceId, sessionId, name, wahaName, aliases[] }`. **É a única fonte dos
  `aliases`**, e foi a falta deles que causou o incidente de 31/07 documentado
  em `sessao-inativa-validacao-investigacao.md`;
- **credenciais** do provider (`FileSystemCredentialStoreAdapter`).

Variáveis (19), entre elas `WHATSAPP_PROVIDER` (**padrão `baileys`**, não
`waha`), `WHATSAPP_CONNECTION_ENABLED`, `ROUTING_*` e as de reconexão.

### 1.3 Container WAHA

| | |
|---|---|
| **Processo persistente** | **Sim** — mantém a sessão WhatsApp aberta |
| **Disco** | **Sim, crítico:** `./.waha-sessions:/app/.sessions` |
| **Porta** | Hoje `127.0.0.1:3002:3000` — só loopback |
| **Timeout** | N/A. Apaga mídia baixada em **180 s** (`WHATSAPP_FILES_LIFETIME`) |

Imagem `devlikeapro/waha:latest-2026.7.1`, engine **WEBJS** — ou seja, roda um
**Chromium** dentro do container. Precisa de memória e CPU de navegador, não de
função.

Manda webhook para `WHATSAPP_HOOK_URL`, hoje
`http://host.docker.internal:3000/api/v1/webhooks/waha`, assinado com
`WHATSAPP_HOOK_HMAC_KEY`.

### 1.4 Dashboard (`apps/dashboard`)

| | |
|---|---|
| **Processo persistente** | **Não.** `vite build` gera estáticos |
| **Disco** | Não |
| **Porta** | Não (servido por CDN ou qualquer servidor de estáticos) |
| **Timeout** | N/A |

Resolve a API por `import.meta.env.VITE_API_URL`, com **padrão string vazia** —
isto é, mesma origem. É variável **de build**, não de runtime: muda a URL, muda
o bundle.

---

## 2. Vercel: o que cabe e o que não cabe

### Cabe

**O dashboard, e só ele.** É exatamente o caso de uso da plataforma: build
estático, CDN, deploy por push. `VITE_API_URL` entra como variável de build.

### Não cabe

**O container WAHA — impossível, não difícil.** É uma imagem Docker com Chromium
e sessão de vida longa. A Vercel não executa contêineres arbitrários nem mantém
processo entre requisições. Não há configuração que resolva.

**O worker — não roda.** Três impedimentos independentes, qualquer um deles
bastando:

1. mantém conexão WhatsApp aberta indefinidamente; funções são efêmeras;
2. escreve estado em disco que precisa sobreviver (`waha-sessions.json`,
   credenciais); o filesystem de função é efêmero e não compartilhado;
3. expõe um servidor HTTP interno na 3101 que a API chama; funções não escutam
   portas.

**A API — cabe pela metade, e a metade que falta importa.** As rotas de
requisição-resposta funcionariam. O que **não** funciona:

- **WebSocket `/ws`.** `WebSocketServer` anexado ao servidor HTTP exige conexão
  de vida longa. A Inbox perde o realtime e volta a depender de polling —
  mudança de produto, não de infraestrutura.
- **Os dois `setInterval`.** Não existe processo entre requisições. O relógio de
  SLA simplesmente para: nenhuma conversa vira `expired`. Vercel Cron cobre o
  agendamento, mas é outro modelo — invocação HTTP, cadência mínima por minuto,
  e exigiria reescrever o tick como rota idempotente.
- **`enqueueBackfill()` no boot.** Não há boot.
- **Transmissão de mídia.** O proxy transmite bytes da WAHA por stream, com
  duração ditada pelo cliente. Funções têm teto de execução.
- **Upload de 50 MB.** Excede o limite de corpo de requisição das funções na
  maioria dos planos. **Valor exato do limite hoje: não identificado.**

**Conclusão:** Vercel serve o dashboard. API, worker e WAHA precisam de outro
lugar. Não é questão de ajuste — são modelos de execução diferentes.

---

## 3. Três arquiteturas

`C` = custo mensal estimado, `E` = esforço até o primeiro deploy.

### Opção A — Vercel (dashboard) + VPS (API + worker + WAHA)

```
Vercel (CDN)  ──HTTPS──>  VPS: nginx ─┬─> API :3000 ──> worker :3101 ──> WAHA :3000
                                       └─> /ws
```

| | |
|---|---|
| **C** | VPS 4 GB ~US$ 20–25 + Supabase Pro US$ 25 + Vercel US$ 0 ≈ **US$ 45–50** |
| **E** | **Médio.** Um host para configurar, TLS, systemd/compose, domínio |
| **Risco** | **Médio.** Ponto único de falha; atualização manual do host |

Ganha o CDN de graça para o front. Paga a complexidade de ter dois lugares.
Cuidado: a URL da API muda de origem, então **CORS deixa de ser trivial** — hoje
`app.ts` só admite `127.0.0.1:5173` e `localhost:5173`.

### Opção B — Plataforma de contêiner (Fly.io, Railway, Render)

```
CDN estático ──> api (container) ──> worker (container) ──> waha (container)
                                          └── volume persistente
```

| | |
|---|---|
| **C** | 3 serviços ~US$ 5–15 cada + volume + Supabase ≈ **US$ 55–80** |
| **E** | **Médio-alto.** Três Dockerfiles, rede interna, volumes, healthchecks |
| **Risco** | **Baixo-médio.** Reinício e rollback gerenciados; volume ainda é o ponto sensível |

É a que mais se parece com o `docker-compose` atual, e a que melhor sobrevive a
reinício — desde que o volume da WAHA e o `CHATPRO_DATA_DIR` do worker sejam
**volumes nomeados, não efêmeros**.

### Opção C — VPS único com `docker compose`

```
VPS: nginx ─> compose { dashboard(estático), api, worker, waha } + volumes locais
```

| | |
|---|---|
| **C** | VPS 4–8 GB ~US$ 20–48 + Supabase ≈ **US$ 45–73** |
| **E** | **Baixo.** É quase o `docker-compose.waha.yml` que já existe, mais dois serviços |
| **Risco** | **Médio-alto.** Tudo num host: reinício derruba tudo; backup por sua conta |

**É a que menos muda em relação ao que existe hoje** e a mais rápida de pôr no
ar. `host.docker.internal` continua funcionando dentro da mesma rede compose.

### Recomendação

**Comece pela C, planeje a B.** A C tira o sistema da sua máquina com o menor
número de decisões novas e mantém o modelo mental atual. A B é para quando o
reinício sem perda e o rollback passarem a importar mais que a simplicidade.

A **A** só vale se o ganho de CDN para o dashboard for relevante — e ele é
pequeno num painel operacional interno.

---

## 4. Pontos críticos, antes de qualquer deploy

### 4.1 A sessão do WhatsApp e o reinício noutra máquina

**Perde o pareamento, sim — e perde mais do que o pareamento.**

São **dois** estados em disco, não um:

1. **`.waha-sessions/` → `/app/.sessions`** no container WAHA. É a credencial da
   sessão WhatsApp. Sem ela, a sessão sobe vazia e exige **novo QR**.
2. **`CHATPRO_DATA_DIR/waha-sessions.json`** no worker. É o registro
   `{ wahaName, aliases[] }`. Sem ele, o mapeamento de pareamentos anteriores
   some — e foi exatamente a ausência dessa informação que fez 499 conversas
   serem tratadas como mortas em 31/07.

Perder o (1) custa um QR novo. Perder o (2) custa **as conversas antigas
deixarem de ser reconhecidas como alcançáveis**, silenciosamente.

Requisito: **volume nomeado e com backup** para os dois caminhos, em qualquer
opção. Reinício na mesma máquina com volume preservado é seguro; reinício noutra
máquina sem o volume não é.

**Não identificado:** se a sessão WEBJS tolera restauração do volume em host com
arquitetura/versão de Chromium diferente. Testar antes de confiar.

### 4.2 O webhook `host.docker.internal:3000`

Hoje funciona porque WAHA e API estão no mesmo host, e o `extra_hosts` mapeia o
gateway. Em produção:

- **Opção C:** troque por `http://api:3000/...` — nome do serviço na rede
  compose. Continua interno, não passa pela internet.
- **Opções A e B:** vira URL pública HTTPS do endpoint de webhook.

Em qualquer caso o **HMAC já existe** (`WAHA_WEBHOOK_HMAC_KEY`, verificado em
`verifyWahaWebhook`), então a rota não fica aberta. O que muda é alcançabilidade,
não autenticidade.

Cuidado: o webhook é o caminho de ingestão inteiro. Se a URL apontar para o lugar
errado, **mensagens não chegam e nada dá erro visível** — a WAHA só registra
falha de entrega do lado dela.

### 4.3 Autenticação: o bloqueador

**Não existe autenticação. Este é o item que impede qualquer exposição pública.**

Medido no código:

- `middleware/context.ts:12` — o workspace vem de `req.header('x-workspace-id')`,
  cru. O 401 dispara **só se o header faltar ou não casar com o formato**. Não há
  sessão, token, assinatura ou usuário.
- `x-user-id` é opcional e igualmente não verificado.
- A API fala com o Supabase pela **`SUPABASE_SERVICE_ROLE_KEY`**, que **ignora
  RLS por definição**.
- RLS está habilitada em **4 tabelas**, todas de contato
  (`contact_identifiers`, `pending_contact_identities`, `contact_block_events`,
  `contact_deletion_log`). **Não está** em `conversations`,
  `whatsapp_messages`, `contacts`, `conversation_kanban_state`,
  `workspace_sla_config` nem `waha_webhook_events`.

Quem descobrir que o workspace se chama `default-workspace` lê e escreve tudo:
conversas, mensagens, mídia, contatos — e **envia mensagem pelo WhatsApp da
empresa**.

**Mínimo aceitável antes de expor**, em ordem:

1. **Autenticação de verdade na frente da API.** Sessão ou token assinado, com o
   `workspaceId` derivado do token — nunca do header. Enquanto isso não existir,
   qualquer outra proteção é cosmética.
2. **Não expor a API à internet aberta.** Enquanto (1) não existir: rede privada,
   VPN, ou proxy com autenticação (Basic/OAuth no nginx). Isso não é solução, é
   contenção.
3. **Rate limit e limite de corpo** no proxy, para que 50 MB por requisição não
   vire vetor trivial.

RLS **não** resolve enquanto a API usar `service_role`: a chave passa por cima.
Habilitar RLS só ajuda depois que o acesso for feito com credencial por usuário —
o que é uma mudança de arquitetura, não uma migration.

### 4.4 Segredos

`web/.env.local` tem **18 variáveis**, das quais quatro são segredo:
`SUPABASE_SERVICE_ROLE_KEY`, `WAHA_API_KEY`, `WAHA_WEBHOOK_HMAC_KEY`,
`MEDIA_PROXY_TOKEN_SECRET`.

O arquivo **está no `.gitignore`** (`web/.gitignore:9`) — nunca foi versionado, e
isso está certo. O problema não é o repositório; é que ele é a única cópia, em
texto, na sua máquina.

Em produção:

- **Opções B e C com plataforma:** variáveis de ambiente do serviço, definidas no
  painel ou por CLI. Não é cofre, mas tira do disco e do backup caseiro.
- **Opção C em VPS puro:** arquivo `.env` com permissão `600`, dono do serviço,
  fora do diretório do repositório.
- **Rotação:** a `SUPABASE_SERVICE_ROLE_KEY` dá acesso total ao banco. Se algum
  dia vazar, rotacionar exige reiniciar API e worker. Vale ter o procedimento
  escrito **antes** de precisar.
- O `MEDIA_PROXY_TOKEN_SECRET` assina URLs de mídia: trocá-lo invalida os links
  em trânsito, o que é aceitável, mas convém saber.

**Não identificado:** se a WAHA aceita rotação de `WAHA_API_KEY` sem derrubar a
sessão.

---

## 5. Esforço e o que bloqueia

### Bloqueante — não exponha sem isto

| frente | esforço | por quê |
|---|---|---|
| **Autenticação da API** | **Alto** — dias, não horas | Sem isso, publicar é entregar a operação inteira a quem souber um nome de workspace |
| **Volumes persistentes** (WAHA + `CHATPRO_DATA_DIR`) | Baixo | Reinício sem eles perde pareamento e o mapa de aliases |
| **URL do webhook** | Baixo | Errada, a ingestão morre em silêncio |
| **Segredos fora do `.env.local` local** | Baixo | Cópia única, em texto, numa máquina |
| **CORS** para a origem real | Baixo | Hoje só admite `localhost:5173`; o dashboard não fala com a API |

### Pode ficar para depois

| frente | esforço | por quê pode esperar |
|---|---|---|
| RLS nas tabelas principais | Alto | Só passa a valer depois que a API deixar de usar `service_role`. Fazer antes não protege nada |
| CDN para o dashboard | Baixo | Painel interno; ganho pequeno |
| Backup automatizado do volume | Médio | Necessário, mas o Supabase já guarda o essencial; o volume guarda sessão, que se recria com QR |
| Observabilidade além do log em stdout | Médio | O log estruturado já existe e cobre o diagnóstico atual |
| Reprocessamento dos eventos descartados | — | Independente de deploy; ver `reprocessamento-eventos-descartados-aplicacao.md` |

### Ordem sugerida

1. Subir a opção **C** numa rede fechada, sem exposição pública, com volumes
   nomeados e webhook por nome de serviço. Isso já tira o sistema da sua máquina.
2. Conferir: pareamento sobrevive a `docker compose restart`; webhook entrega;
   realtime conecta; mídia carrega.
3. **Só então** decidir a autenticação e, com ela, a exposição pública.

---

## 6. O que este levantamento não determinou

- **Limite exato de corpo de requisição e de duração** das funções da Vercel
  hoje: **não identificado**. A conclusão de que 50 MB e stream de mídia não
  cabem vale pela ordem de grandeza, não por número verificado.
- **Consumo real de memória e CPU** de cada peça em produção: **não
  identificado**. Nenhuma medição de carga foi feita; o dimensionamento de VPS
  acima é estimativa por tipo de carga (Chromium na WAHA é o dominante).
- **Se a sessão WEBJS restaura em host diferente**: **não identificado**.
- **Preços**: nenhum foi verificado nesta data.
- **Se `WHATSAPP_PROVIDER` deve ser `waha` ou `baileys` em produção**: o padrão
  do código é `baileys`, mas o ambiente atual roda WAHA. Qual é o alvo de
  produção **não identificado** — e muda o inventário, porque o Baileys dispensa
  o container.
