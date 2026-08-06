# SPEC — Menções (@) em Grupos de WhatsApp com Painel de Membros e Nomes Sincronizados

> **⚠️ REGRA DE OURO DESTA SPEC — FRONTEND**
>
> Este documento **não prescreve código, componentes, estrutura de arquivos, CSS
> ou framework de frontend**. Toda a seção de interface descreve **comportamentos,
> estados, interações e requisitos de acessibilidade** — **o QUE** a tela precisa
> fazer, nunca **COMO** um projeto específico faz.
>
> **Implemente o frontend usando os padrões, componentes e design system do SEU
> sistema.** Se o seu projeto tem autocomplete, painel lateral ou textarea
> próprios, adapte os requisitos a eles. Não copie estrutura de nenhum projeto
> de referência — é isso que causa bugs de integração.
>
> O backend, o protocolo com o provedor WhatsApp e as regras de negócio, por
> outro lado, **são prescritivos**: ali os formatos exatos (JIDs, payloads,
> validações) são o que garante a menção funcionar de verdade no WhatsApp.

---

## 1. Visão geral

A feature permite que um operador, numa conversa de **grupo** do WhatsApp:

1. Digite `@` no campo de mensagem e veja um **autocomplete de participantes do grupo**;
2. Filtre por nome ou número, navegue com teclado ou mouse e selecione;
3. Envie a mensagem de forma que o mencionado seja **notificado de verdade** pelo WhatsApp (vibração/push de menção), não apenas veja um `@texto`;
4. Veja, nas mensagens recebidas e enviadas, as menções **destacadas visualmente** e **resolvidas para o nome da pessoa**;
5. Abra um **painel de membros do grupo** com nome, número e selo de admin de cada participante;
6. Veja o **nome que a pessoa cadastrou no WhatsApp** (pushName) mesmo para números **não salvos** na agenda — sincronizado em segundo plano, sem intervenção.

### 1.1 Por que não é "só colocar @ no texto"

O WhatsApp só dispara notificação de menção quando a mensagem carrega, **além do
texto**, uma lista estruturada de JIDs mencionados (`mentionedJidList` no
protocolo). Um `@Nome` digitado no corpo é texto puro e **não notifica ninguém**.
Toda a complexidade desta spec existe para manter a experiência simples
(digita `@Nome`, vê `@Nome`) enquanto o envio carrega o formato que o protocolo
exige (`@dígitos` no texto + array de JIDs).

---

## 2. Vocabulário e identificadores

| Termo | Significado |
|---|---|
| **JID** | Identificador WhatsApp de uma entidade, no formato `dígitos@sufixo`. |
| `@c.us` | JID de pessoa física. Os dígitos são o número com DDI (ex.: `5511999990001@c.us`). Telefone garantido. |
| `@lid` | JID opaco ("Linked ID") que o WhatsApp usa para ocultar números. **Primeira classe**: menções recebidas chegam cada vez mais como `@lid`. **Sem telefone garantido.** |
| `@g.us` | JID de grupo (ex.: `120363012345678901@g.us`). |
| **pushName** | O nome que a pessoa cadastrou no próprio WhatsApp. É o que aparece para quem não tem o número salvo. |
| **WAHA** | Provedor HTTP de WhatsApp usado como referência nesta spec (self-hosted, REST). Os conceitos se adaptam a outros provedores (ver §13.4). |
| **`@dígitos`** | No corpo da mensagem, a menção é literalmente `@` seguido dos dígitos do JID (ex.: `@5511999990001`). É assim que o WhatsApp liga o texto ao JID listado na estrutura. |

### 2.1 Formatos validados (use exatamente estes)

- JID de pessoa para menção: regex `^\d{6,20}@(c\.us|lid)$`
- Tamanho máximo do array de menções por mensagem: **50**
- Menções a **grupos** (`@g.us`) são **inválidas** — só se menciona pessoas.

---

## 3. Escopo e limites aceitos (decisões de produto)

Estas decisões foram tomadas explicitamente. Reproduza-as ou mude conscientemente:

1. **Menção é texto puro no campo de digitação** — não é chip/contenteditable. Se o operador apagar ou editar o `@Nome` antes de enviar, a menção é **descartada** no envio. O texto sempre manda.
2. **Menções só em grupos.** Em conversa 1:1, o envio com menções é rejeitado com **400**. O autocomplete **não abre** em 1:1.
3. **`mentions: ["all"]` (mencionar todos) está FORA de escopo.**
4. **A lista de participantes pode estar desatualizada**: quem saiu do grupo sem registro de saída permanece na lista. Quem tem saída registrada (papel `left`) **nunca aparece**.
5. **Participantes de grupo NÃO viram contatos do CRM** ao ter o nome sincronizado (ver §8.4).
6. O nome exibido depende do que o provedor consegue ler: contato com privacidade restrita ou sem pushName público permanece exibido como número.
7. Identidade sincronizada fica em **cache de 24h** — troca de nome no WhatsApp demora até 1 dia para refletir.

---

## 4. Modelo de dados

Quatro coleções/tabelas são suficientes. Nomes ilustrativos; adapte ao seu banco.

### 4.1 `whatsapp_identities` — quem é cada JID

| Campo | Tipo | Notas |
|---|---|---|
| `workspaceId` | string | isolamento multi-tenant |
| `wahaSession` | string | sessão do provedor |
| `whatsappId` | string | JID como recebido (`@c.us` ou `@lid`) |
| `canonicalWhatsappId` | string | JID canônico (para `@lid`, o `@c.us` correspondente quando conhecido) |
| `phone` | string \| null | só garantido em `@c.us` |
| `name` | string \| null | nome do contato no provedor |
| `pushName` | string \| null | nome que a pessoa cadastrou no WhatsApp |
| `profilePictureUrl` | string \| null | avatar |

Constraint única: `(workspaceId, wahaSession, whatsappId)`.

### 4.2 `whatsapp_groups` — os grupos

| Campo | Tipo | Notas |
|---|---|---|
| `chatId` | string | `@g.us` |
| `name`, `pictureUrl` | string \| null | |
| `metadataJson` | json | payload administrativo do grupo |

Único em `(workspaceId, wahaSession, chatId)`.

### 4.3 `whatsapp_group_participants` — membros

| Campo | Tipo | Notas |
|---|---|---|
| `groupId` | FK | |
| `participantWhatsappId` | string | JID do membro (`@c.us` ou `@lid`) |
| `role` | string \| null | `admin` / `superadmin` / `left` / **NULL** (membro comum sem papel registrado) |
| `createdAt` | timestamp | |

Único em `(groupId, participantWhatsappId)`. **Sem DELETE** de quem sai (limitação aceita); quem sai formalmente fica `role = 'left'`.

### 4.4 Metadados da mensagem

Não é preciso coluna nova. No envelope/metadados da mensagem:

- **Recebidas**: o payload bruto do provedor já carrega `mentionedJidList` (em WAHA, dentro de `_data`). Persista o payload bruto e leia de lá.
- **Enviadas por nós**: grave `mentions: string[]` (os JIDs) nos metadados da mensagem no momento do envio — é o que permite destacar as nossas próprias menções depois.

---

## 5. Fluxo de envio (operador → WhatsApp)

### 5.1 Pipeline ponta a ponta

```
[UI] operador digita "oi @Ada Lovelace"
  → (autocomplete insere o nome; UI mantém registro {display: "Ada Lovelace", jid: "5511999990001@c.us"})
[UI] no submit, SERIALIZA: texto vira "oi @5511999990001", mentions = ["5511999990001@c.us"]
  → POST /conversations/{id}/messages { text, mentions }
[API] validações semânticas (§5.3)
  → comando interno message.send { wahaSession, chatId, text, mentions }
[Worker/Provider] POST WAHA /api/sendText
  body: { session, chatId, text: "oi @5511999990001", mentions: ["5511999990001@c.us"] }
[API] persiste a mensagem enviada com metadata.mentions = [...]
[WhatsApp] destinatário recebe notificação de menção ✅
```

### 5.2 Regra inquebrável do provedor

**Cada JID do array `mentions` PRECISA ter o `@dígitos` correspondente dentro de
`text`.** A WAHA (e o WhatsApp) cruzam os dois. A serialização que garante isso
acontece na UI (§9.6); a API confere de novo (§5.3).

### 5.3 Validações semânticas na API (nesta ordem)

Entrada: `conversationId`, `text`, `mentions?` (schema: array de JID válido, máx. 50).

1. `mentions` ausente ou vazio → envio normal, fim.
2. Conversa inexistente → **404**.
3. Conversa **não é grupo** → **400** ("mentions are only allowed in group conversations").
4. **Dedupe** de JIDs repetidos.
5. **Filtro (não rejeição)**: menção cujo `@dígitos` **não consta no texto** é removida silenciosamente do array. Se nada sobrar → envio normal sem menções.
   *Motivo: a UI envia registros que o operador pode ter apagado; o texto manda.*
6. **Pertencimento — fail-open**:
   - Se a tabela de participantes do grupo está **vazia** (grupo nunca sincronizado) → **não bloqueia** (não há como conferir).
   - Se há participantes sincronizados → JID fora da lista → **400** ("mentioned user is not a group participant"). Lembrar que `role = 'left'` **não conta** como membro.
7. Sobreviventes seguem no comando ao worker.

### 5.4 Resposta e persistência

- O worker devolve `{ id?, timestamp, pending? }` da WAHA.
- A API persiste a mensagem outbound com `metadata.mentions` (somente quando há menções — **sem menção, sem a chave**, o envelope fica como sempre foi).

---

## 6. Fluxo de recebimento (WhatsApp → operador)

1. O webhook do provedor entrega a mensagem; o payload bruto carrega a lista de mencionados (WAHA: `_data.mentionedJidList`; Baileys: `contextInfo.mentionedJid`).
2. **Persista o payload bruto** nos metadados da mensagem — nada além disso é necessário no ingresso.
3. Na leitura/renderização, a UI recebe `metadata` e resolve os JIDs para nomes (§9.8).

> Não crie fluxo paralelo de mensagens para menções: menção é **atributo de
> renderização** sobre a mensagem normal, não um tipo de mensagem.

---

## 7. Listagem de participantes (alimenta autocomplete + painel)

### 7.1 Endpoint

`GET /conversations/{conversationId}/participants`

- 404 conversa inexistente · 400 conversa que não é grupo.
- Resposta: `{ items: GroupParticipant[] }`.
- **Efeito colateral melhor-esforço**: dispara a sincronização de identidades (§8) para a próxima leitura vir mais fresca. A resposta NUNCA espera o sync.

### 7.2 `GroupParticipant`

```json
{
  "whatsappId": "5511999990001@c.us",
  "name": "Ada Lovelace",
  "phone": "5511999990001",
  "role": null,
  "avatarUrl": null,
  "lastActiveAt": "2026-08-01T11:00:00.000Z"
}
```

### 7.3 Montagem da lista (query/agregação)

1. Grupo pelo `(workspaceId, wahaSession, chatId)` da conversa.
2. Participantes **excluindo `role = 'left'`** — cuidado com SQL: `role IS NOT 'left'` (e não `!=`), porque **NULL precisa passar** (membro comum).
3. Enriquecer cada JID com:
   - identidade (`whatsapp_identities`, casando por `whatsappId` **ou** `canonicalWhatsappId`);
   - contato do CRM por telefone (dígitos do JID) como fallback de nome.
4. **Precedência do nome**: `identity.name ?? identity.pushName ?? contact.name ?? null`.
5. **Precedência do telefone**: garantido só em `@c.us`; `@lid` pode ficar `null`.
6. **Dedupe por JID** (identidade canônica pode casar duas vezes).
7. **Ordenação**: quem falou por último no grupo primeiro (recência via `MAX(occurredAt)` das mensagens por remetente); os demais em **ordem alfabética locale-aware** (pt-BR) pelo nome de exibição.
8. Grupo sem linha na tabela de grupos → lista **vazia** (não erro).

---

## 8. Nomes do WhatsApp para números não salvos (sync de identidade)

### 8.1 O problema

A listagem de participantes do provedor (WAHA `/groups/{chatId}/participants/v2`)
devolve **só `{id, role}`** — sem nomes. O nome de quem não está salvo na agenda
exige uma chamada de identidade **por JID** (WAHA: `GET /api/contacts?contactId={jid}`,
que devolve `name`/`pushname`, + opcionalmente foto e resolução `@lid`→`@c.us`).

### 8.2 Quando sincronizar

Ao atender `GET /participants`, para cada membro **sem nome resolvido** (`name == null`):

- enfileire um sync de identidade individual **em segundo plano** (nunca no caminho da resposta);
- **limite por abertura: 30** — protege o provedor de uma enxurrada em grupos grandes; o resto entra na abertura seguinte;
- **staleness/TTL: 24h** por identidade — não refaça o que já está fresco;
- **dedupe in-flight** por JID — abrir o grupo 5 vezes não dispara 5 chamadas iguais.

### 8.3 Execução do sync

```
API enfileira {workspaceId, wahaSession, chatId: <JID do participante>, origin: "group-participant"}
  → verifica staleness da identidade (24h); fresca? aborta.
  → comando ao worker: identity.sync { wahaSession, chatId: <JID>, refreshIdentity: true }
  → worker chama o provedor (getIdentity) e devolve
    { whatsappId, canonicalWhatsappId, phone, name, pushName, shortName, profilePictureUrl }
  → API persiste UPSERT em whatsapp_identities (COALESCE: não sobrescreve com null)
  → publica evento realtime: conversation.updated { chatId: <JID>, identitySynchronized: true }
```

### 8.4 ⚠️ Regra de design inegociável

**O sync de participante grava SOMENTE a linha de identidade.** Ele **NÃO**:

- cria/atualiza contato no CRM;
- cria alias/identificador de contato;
- dispara reconciliação de conversas.

Membro de grupo é audiência, não lead. Abrir um grupo de 200 pessoas não pode
poluir o CRM com 200 contatos. Distinga este sync do sync de identidade de
conversas diretas (que faz tudo isso) por uma **origem** explícita no comando
(ex.: `origin: "group-participant"`).

### 8.5 Refresh na interface

O evento realtime (`identitySynchronized`) é o gatilho para a UI **invalidar o
cache de participantes da conversa aberta e reler** (§9.10) — os nomes aparecem
sozinhos, sem recarregar a tela, segundos depois de abrir o grupo.

---

## 9. Requisitos de frontend (agnósticos de framework)

> Lembrete: implemente com **seus** componentes. Abaixo, "popup", "composer" e
> "painel" são papéis, não estruturas.

### 9.1 Papéis de UI

- **Composer**: campo de texto da mensagem (textarea ou equivalente — texto puro, §3.1).
- **Popup de menções**: lista flutuante de participantes, aberta acima do composer.
- **Bolha de mensagem**: renderiza corpo com menções destacadas.
- **Painel de membros**: seção do painel de detalhes da conversa, só em grupos.

### 9.2 Estado que a tela precisa manter

| Estado | Conteúdo |
|---|---|
| `mention` \| null | `{ start: number, query: string }` — posição do `@` e o que já foi digitado depois dele |
| `activeIndex` | índice destacado no popup |
| `mentionRecords` | array de `{ display: string, jid: string }` — os `@Nome` inseridos e seus JIDs |
| `participantsCache` | participantes por conversa (1 fetch por abertura) |
| `participantsState` | `{ loading, failed }` para os estados visuais |

### 9.3 Gatilho do `@`

Abra o popup **somente** quando o `@`:

- está no **início do texto** ou **imediatamente após espaço/quebra de linha** (`\s`);
- e o que segue (a query) tem até **30 letras/números/espaços**, **sem quebra de linha**.

Regex de referência (aplicada ao texto **antes do cursor**):
`/(?:^|\s)@([\p{L}\p{N} ]{0,30})$/u`

Consequências obrigatórias: `ana@exemplo.com` **não abre**; `@` após parágrafo novo **abre**; query atravessada por `\n` **fecha**. Fora de conversa de grupo, o gatilho **nunca** é avaliado.

### 9.4 Filtro da lista

- Local, sobre o cache: casa **nome**, **telefone** ou **dígitos do JID**;
- **insensível a caso e acentos** (normalize NFD e remova diacríticos; lowercase locale pt-BR);
- query vazia → lista inteira (já ordenada pelo backend, §7.3.7).

### 9.5 Itens do popup

Cada item mostra: **avatar** (ou **iniciais** nome+sobrenome em círculo), **nome de exibição** (`name ?? phone ?? dígitos do JID`), **telefone formatado** quando houver, e selo **admin** quando `role ∈ {admin, superadmin}`.

Estados obrigatórios do popup: **carregando** (primeira abertura), **falha** (com orientação "feche e tente o @ de novo"), **vazio** ("nenhum participante encontrado").

Acessibilidade mínima: contêiner `role="listbox"`, itens `role="option"` com `aria-selected`, e o ativo visualmente destacado.

### 9.6 Inserção e serialização (o coração da fidelidade)

**Inserir** (seleção por Enter/Tab/clique):

1. Substitua o trecho `@query` (de `start` ao cursor) por **`@NomeDeExibição` + espaço**;
2. Registre `{ display, jid }` em `mentionRecords` (dedupe por JID — mencionar a mesma pessoa duas vezes mantém um registro);
3. Feche o popup e posicione o cursor **depois do espaço**.

**Serializar no submit** — para cada registro, na ordem:

1. ache a **primeira ocorrência restante** de `@NomeDeExibição` no texto (busca literal);
2. não achou (operador apagou/editou) → **descarte o registro**;
3. achou → troque por `@dígitosDoJid` e inclua o JID no array (dedupe);
4. envie `{ text: <texto convertido>, mentions: <jids> }`. Array vazio → **não envie a chave** (chamada de 2 argumentos / payload sem `mentions`).

**Após enviar**: limpe texto, registros e popup.

### 9.7 Teclado com o popup aberto

| Tecla | Ação |
|---|---|
| `↓` / `↑` | move o ativo (circular), `preventDefault` |
| `Enter` / `Tab` | seleciona o ativo, `preventDefault` (Enter **não** quebra linha nem envia) |
| `Esc` | fecha o popup, `stopPropagation` (não dispara atalhos de fechar conversa/tela) |

Popup fechado → nenhum comportamento muda.

### 9.8 Renderização das menções no corpo

1. Leia os JIDs da mensagem: `metadata._data.mentionedJidList` (recebidas) ∪ `metadata.mentions` (enviadas por nós), dedupe. Vazio → render normal.
2. No corpo, localize cada **`@dígitos`** correspondente a esses JIDs (busca literal, varredura em ordem de posição; sobreposições são ignoradas — o primeiro span vence).
3. Cada span vira um **destaque inline** (ex.: pill/roxo do tema) com o rótulo **`@Nome`** resolvido via cache de participantes da conversa; JID sem nome → `@dígitos` mesmo.
4. Os demais segmentos seguem o pipeline normal do corpo (links continuam virando links — menção e URL vizinhas não se quebram).

### 9.9 Painel de membros (só em grupos)

- Título com contagem: `MEMBROS (N)`;
- Por membro: **nome de exibição** em destaque + linha secundária com **telefone formatado** (ou "sem número visível" para `@lid`) e **"· admin"** quando aplicável;
- Estados: carregando, falha, e **vazio explicado** ("a lista se completa conforme o grupo interage").

### 9.10 Cache e refresh

- **1 fetch por conversa aberta** (cache em memória); falha **não** cacheia (próxima tentativa refaz).
- Ao receber o evento realtime `conversation.updated` com `identitySynchronized: true`: se o `chatId` do evento for o **grupo aberto** ou um **JID presente no cache**, invalide e **relea** — painel, autocomplete e destaques ganham os nomes novos sem recarregar.

---

## 10. Contratos entre processos (prescritivo)

Se a sua arquitetura separa API e worker/provedor (recomendado), o comando interno é:

```json
{
  "type": "message.send",
  "payload": {
    "wahaSession": "session-a",
    "chatId": "120363012345678901@g.us",
    "text": "olá @5511999990001",
    "mentions": ["5511999990001@c.us"]
  }
}
```

- `mentions`: **opcional** (`array<JID-pessoa>`, regex §2.1, máx. 50). **Schema estrito**: enviar a chave sem o schema atualizado quebra o parse no worker (400).
- Comando de sync de identidade: `{ "type": "identity.sync", "payload": { "wahaSession", "chatId": "<JID>", "refreshIdentity": true } }` → resposta `{ identity: {...} | null, group: null }`.

---

## 11. Payloads do provedor (WAHA, referência)

### 11.1 Enviar texto com menções

`POST /api/sendText`

```json
{
  "session": "session-a",
  "chatId": "120363012345678901@g.us",
  "text": "olá @5511999990001 e @123456789012345",
  "mentions": ["5511999990001@c.us", "123456789012345@lid"]
}
```

(Omita `mentions` inteiramente quando não houver — não envie vazio.)

### 11.2 Participantes do grupo

`GET /api/{session}/groups/{chatId}/participants/v2` → `[{ "id": "...@lid", "role": "admin" }, ...]` (sem nomes).

### 11.3 Identidade de um JID (nomes)

`GET /api/contacts?contactId={jid}&session={session}` → `{ name, pushname, number, ... }`
Complementos opcionais: foto (`/api/contacts/profile-picture`) e resolução `@lid`→`@c.us` (`/api/{session}/lids/{jid}`).

### 11.4 Menção recebida (webhook `message`)

O corpo traz `@dígitos` e o payload bruto traz `_data.mentionedJidList: ["<JIDs>"]`.

---

## 12. Casos de borda (todos cobertos acima; checklist de revisão)

- [ ] `@` em e-mail não abre popup; `@` no início/apos espaço/quebra abre.
- [ ] Query com acento filtra nome sem acento ("caio" acha "Cáio") e vice-versa.
- [ ] Operador apaga parte do `@Nome` → menção descartada no envio (sem 400).
- [ ] Duas pessoas com o **mesmo nome de exibição**: registros distintos por JID; a serialização troca a primeira ocorrência restante de cada — funciona porque cada inserção consome uma ocorrência.
- [ ] Múltiplas menções na mesma mensagem (mesma pessoa 2× conta como 1 JID).
- [ ] `@lid` sem telefone: exibe dígitos; sync pode resolvê-lo para `@c.us` depois (identidade canônica casa nas duas colunas).
- [ ] Ex-membro (`left`) nem aparece na lista nem é aceito como menção quando a lista está povoada.
- [ ] Grupo nunca sincronizado: envio com menção **passa** (fail-open) e a lista vem vazia com hint explicativo.
- [ ] Menção em 1:1: popup nunca abre; API responde 400 se forçada.
- [ ] 51+ menções: schema rejeita (máx. 50).
- [ ] Sessão WhatsApp desconectada durante sync de nomes: sync falha em background, lista segue com números, próxima abertura tenta de novo.

---

## 13. Cenários de teste (mínimo para dar a feature por pronta)

### 13.1 Contrato/transporte

- comando com `mentions` válido (`@c.us`, `@lid`, misto) / inválido (`@g.us`, texto solto, 51 itens) / ausente;
- repasse verbatim até o worker; **ausência não vira chave vazia** no body do provedor.

### 13.2 Worker/provedor

- body do `sendText` inclui `mentions` quando presente e **exclui** quando ausente/vazio.

### 13.3 API

- `GET /participants`: campos de exibição, `left` excluído, ordenação por recência, 404/400;
- envio: persiste `metadata.mentions`; menção fora do texto é filtrada; não-participante → 400 (lista povoada); fail-open (lista vazia); 1:1 → 400; JID malformado → 400;
- **sync de nomes**: membro sem nome ganha pushName em background e **`contact_identifiers`/CRM permanece intocado** (trava a regra §8.4).

### 13.4 Frontend (contra a SUA implementação)

- `@` abre; filtro por nome/número; ↑↓/Enter/Tab/Esc; clique seleciona;
- inserção produz `@Nome ` com cursor depois do espaço;
- submit envia texto com `@dígitos` + array de JIDs; apagar o nome descarta;
- recebida com `mentionedJidList` e enviada com `metadata.mentions` renderizam `@Nome` destacado; JID sem nome cai para dígitos;
- 1:1 nunca abre popup; painel de membros lista nome+número+admin;
- evento realtime `identitySynchronized` troca número → nome **sem recarregar**.

### 13.5 Adaptação a outro provedor (Baileys, Cloud API…)

Os pontos de contato são 3: **envio** (onde vai o array de JIDs), **recebimento** (onde está `mentionedJid` no payload) e **catálogo** (participantes do grupo e identidade por JID). Isolando-os atrás de um client de provedor, o restante desta spec é independente de WAHA. Na Cloud API oficial, verifique a disponibilidade dos equivalentes antes de prometer notificação de menção — o comportamento não é idêntico ao dos clients não-oficiais.

---

## 14. Checklist de implementação (ordem recomendada)

1. [ ] Schema/contrato do comando de envio ganha `mentions` (estrito!).
2. [ ] Worker/provedor repassa `mentions` no body do envio de texto.
3. [ ] Leitura de participantes: tabelas/coleções + query com `left` excluído, enriquecimento de nome/telefone, ordenação.
4. [ ] `GET /participants` + validações semânticas do envio (§5.3).
5. [ ] Envio persiste `metadata.mentions`.
6. [ ] Sync de identidade por participante com origem que **não** toca o CRM (§8) + evento realtime.
7. [ ] UI: gatilho, popup, teclado, inserção, serialização, render com destaque, painel de membros, cache + invalidação.
8. [ ] Testes §13.
9. [ ] Revisão dos casos de borda §12.

---

## 15. Limitações conhecidas (declare-as ao usuário final)

- Lista de membros pode conter quem já saiu (sem evento de saída não há como saber);
- nomes dependem da privacidade/visibilidade que o WhatsApp expõe ao provedor;
- cache de identidade de 24h atrasa trocas de nome;
- `@lid` sem número visível é esperado, não bug;
- "mencionar todos" não existe nesta versão.
