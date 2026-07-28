# Bloqueio e exclusão de contatos — investigação e proposta

Documento de proposta. **Nada aqui foi implementado, nenhuma migration foi
aplicada e nenhum DDL foi executado no banco remoto.** O SQL correspondente está
em `docs/migrations-propostas-contatos.sql`, também não aplicado.

O schema do Supabase **deixou de ser suposição**: foi extraído do remoto e
conferido contra o DDL versionado, e as duas fontes batem coluna a coluna. Ver
seção 5 — o bloqueio "schema não versionado" da versão anterior está resolvido, e
duas conclusões que dependiam dele foram corrigidas. O SQL foi validado por
execução em bancos descartáveis (Postgres em contêiner e SQLite reproduzindo o
runner real), nunca contra a infraestrutura de produção.

Onde não houve evidência direta, o texto diz **não identificado**. Nenhuma
afirmação abaixo foi inferida sem fonte.

## Correção de escopo

Uma proposta anterior descrevia bloqueio como "flag local com guarda no envio".
Isso não atende ao requisito. Bloqueio no WhatsApp é bidirecional: o contato não
recebe e não entrega. Uma guarda apenas no envio deixa o webhook continuar
ingerindo mensagens, que seguem criando e atualizando conversa visível na Inbox.

A conclusão central desta investigação é que **a guarda local nos dois sentidos é
obrigatória nos dois cenários**. A propagação para a WAHA, quando existir, é um
reforço que atua no lado do WhatsApp — não substitui a guarda local, porque:

- a propagação pode falhar e o ChatPro precisa continuar coerente;
- mensagens já em trânsito chegam pelo webhook depois do bloqueio;
- o bloqueio do WhatsApp é por sessão; um workspace com mais de uma sessão só
  fica protegido nas sessões em que a propagação foi aplicada.

Consequência prática de projeto: **o schema proposto é o mesmo nos dois
cenários.** Muda apenas se a etapa de propagação roda. Com a rota da WAHA já
confirmada (seção 1), o caminho é o cenário (a); o schema idêntico continua
valendo porque o cenário (b) virou o estado em que o sistema cai quando a
propagação falha — que é uma condição de runtime, não uma hipótese de
plataforma.

## 1. A WAHA expõe block/unblock?

### Instância local (somente leitura)

`WAHA_BASE_URL=http://127.0.0.1:3002`, porta em escuta confirmada.

```console
$ curl -s -H "X-Api-Key: ***" http://127.0.0.1:3002/api/version
{"version":"2026.7.1","engine":"WEBJS","tier":"CORE","browser":"/usr/bin/chromium",
 "platform":"linux/x64","worker":{"id":null}}
```

Engine **WEBJS**, versão **2026.7.1**, tier **CORE**.

### Sondagem por GET: inconclusiva

```console
$ curl -o /dev/null -w "%{http_code}" .../api/contacts/block      -> 404
$ curl -o /dev/null -w "%{http_code}" .../api/contacts/unblock    -> 404
$ curl -o /dev/null -w "%{http_code}" .../api/contacts/check-exists -> 400
$ curl -o /dev/null -w "%{http_code}" .../api/rotaInexistenteDeControle -> 404
```

À primeira vista o 404 sugeriria ausência da rota. **Não sugere.** Experimento de
controle numa rota POST que o ChatPro comprovadamente usa em produção
(`apps/worker/src/waha-client.ts` chama `POST /api/sendImage`):

```console
$ curl -o /dev/null -w "%{http_code}" .../api/sendImage -> 404
$ curl -o /dev/null -w "%{http_code}" .../api/sendText  -> 400
```

`POST /api/sendImage` existe e mesmo assim `GET /api/sendImage` devolve 404. O
NestJS, que serve a WAHA, responde 404 (não 405) quando o caminho existe mas o
método não casa. Logo **o 404 em `/api/contacts/block` não é evidência de
ausência**, e a sondagem local por GET não consegue decidir a questão.

A especificação OpenAPI da instância não está exposta. Todas as localizações
usuais respondem 404: `/api/docs-json`, `/-json`, `/api-json`, `/swagger-json`,
`/api/docs/swagger.json`, `/docs`, `/swagger`, `/api/docs`, `/openapi.json`,
`/docs-json`, `/api/openapi.json`. `/dashboard` responde 401 (exige credencial).

### Documentação oficial

`https://waha.devlike.pro/docs/how-to/contacts/` documenta:

| Método | Caminho | Corpo |
|---|---|---|
| POST | `/api/contacts/block` | `{"contactId": "...", "session": "..."}` |
| POST | `/api/contacts/unblock` | `{"contactId": "...", "session": "..."}` |

Suporte por engine — **as duas fontes divergem**:

- página oficial de Contacts: **WEBJS e WPP** apenas; NOWEB e GOWS não suportam;
- espelho DeepWiki de `devlikeapro/waha-docs` (`4.5-contacts-api`): ✅ para
  **WEBJS, NOWEB e GOWS**.

As duas fontes concordam no que importa aqui: **WEBJS é suportado**, e WEBJS é a
engine da instância local.

Nenhuma das duas fontes declara se block/unblock exige WAHA Plus. Como a
instância local é **CORE**, isso era decisivo — e foi resolvido empiricamente na
seção seguinte.

### Teste por POST: rota CONFIRMADA

Executado contra a instância local com sessão inexistente — não bloqueia
ninguém, e o formato do erro distingue os casos.

```console
$ curl -X POST http://127.0.0.1:3002/api/contacts/block \
    -H "X-Api-Key: ***" -H 'Content-Type: application/json' \
    -d '{"contactId":"000000000000","session":"sessao-inexistente-teste"}'
{"error":"Session \"sessao-inexistente-teste\" does not exist", ...}

# controle, mesma sessão inexistente, numa rota que sabidamente existe:
$ curl -X POST http://127.0.0.1:3002/api/sendText ... -> HTTP 422
```

**Por que o erro de sessão prova a existência da rota.** No NestJS o roteamento
resolve antes do handler. Um caminho ausente nunca chega ao corpo do controlador:
devolve o 404 genérico, exatamente como `/api/rotaInexistenteDeControle`. Uma
resposta que **nomeia a sessão do payload** só pode ter sido produzida por um
handler que recebeu, desserializou e validou o corpo. Ou seja, a requisição
atravessou o roteamento e chegou à lógica de negócio de `contacts/block`.

O contraste com o GET fecha o raciocínio. `GET /api/contacts/block` devolve 404
porque o método não casa com a rota registrada — o mesmo 404 que
`GET /api/sendImage` devolve embora `POST /api/sendImage` seja usado em produção
pelo worker. O 404 do GET media o método, não a existência do caminho; o erro de
sessão do POST media a existência do caminho. As duas observações são
consistentes com uma única explicação: **a rota existe e aceita apenas POST.**

O controle com `POST /api/sendText` na mesma sessão inexistente devolveu 422,
confirmando que os dois caminhos passam do roteamento e falham na camada de
negócio, cada um do seu jeito. Nenhum dos dois devolveu 404.

**Tier resolvido: block/unblock não é Plus-only.** A verificação rodou numa
instância **CORE** (`"tier":"CORE"` em `/api/version`) e a rota respondeu da
camada de negócio. Se fosse gated por licença, a resposta seria de licenciamento
ou 404, não erro de sessão.

### Veredito

| Pergunta | Resposta | Base |
|---|---|---|
| A WAHA documenta block/unblock? | **Sim** | doc oficial + espelho DeepWiki |
| A engine em uso (WEBJS) está na matriz de suporte? | **Sim** | ambas as fontes |
| A instância local expõe `POST /api/contacts/block`? | **Sim — confirmado** | erro de sessão nomeada, sem 404; controle `sendText` 422 |
| Funciona no tier CORE? | **Sim — verificado em CORE** | `/api/version` → `"tier":"CORE"` |
| `POST /api/contacts/unblock` também existe? | **Não identificado** | não testado — ver abaixo |

**Portanto o caminho é o cenário (a).** O cenário (b) permanece documentado como
fallback de falha de propagação, não como hipótese sobre a WAHA.

### Pendência: `/unblock` ainda não foi verificado

`/block` foi testado; `/unblock` não. As duas fontes listam os dois juntos e a
matriz de engines é a mesma, então a expectativa é que exista — mas expectativa
não é evidência, e é o desbloqueio que carrega o risco maior de falhar fechado
(ver "falha no desbloqueio" na seção 2). Rodar o mesmo teste antes de implementar:

```bash
curl -i -X POST http://127.0.0.1:3002/api/contacts/unblock \
  -H "X-Api-Key: $WAHA_API_KEY" -H 'Content-Type: application/json' \
  -d '{"contactId":"000000000000","session":"sessao-inexistente-teste"}'
```

- Erro nomeando a sessão, ou qualquer 4xx de validação → **rota existe**,
  cenário (a) completo.
- 404 idêntico ao de `/api/rotaInexistenteDeControle` → **bloquear seria
  irreversível pela API**, e a implementação teria de exigir desbloqueio manual
  no aparelho. Nesse caso não implementar bloqueio com propagação até rever o
  desenho.

## 2. Desenho do bloqueio

### Comum aos dois cenários — a guarda local bidirecional

#### Máquina de estados

`contacts.blockState` separa **intenção** de **efeito confirmado**, para que a
Inbox nunca diga "bloqueado" sem propagação bem-sucedida:

```text
active ──bloquear──> blocking ──propagação OK──> blocked
                        │
                        └──propagação falhou──> block_failed
blocked ──desbloquear──> unblocking ──OK──> active
```

`contacts.blockPropagation` registra o lado WAHA em separado: `none`, `pending`,
`confirmed`, `failed`, `unsupported`.

Regra de rotulagem, que é o ponto do requisito: a UI só escreve **"Bloqueado"**
com `blockState='blocked'` **e** `blockPropagation IN ('confirmed','unsupported')`.
Em `blocking` mostra "Bloqueio pendente"; em `block_failed` mostra "Bloqueio local
ativo — não propagado ao WhatsApp", com o motivo e ação de repetir.

Regra de proteção, deliberadamente mais ampla que a de rotulagem: **as guardas
locais valem para `blockState IN ('blocking','blocked','block_failed')`**. O
operador fica protegido no instante do clique, mesmo com propagação pendente ou
falha. Proteger cedo e rotular tarde são decisões independentes de propósito.

#### Guarda 1 — envio

Local: `InternalInboxService.send` (`apps/api/src/services/internal-inbox.service.ts:14`),
**antes** de `this.worker.send`. Hoje o método só valida a existência da conversa.

Resolve o contato pela conversa e, se bloqueado, responde `409 CONFLICT` com
código próprio (`CONTACT_BLOCKED`) — sem chamar o worker, sem persistir outbound.
O mesmo vale para o envio de anexos.

#### Guarda 2 — ingestão do webhook

Local: `SqliteWahaWebhookStore.ingest` e `SupabaseWahaWebhookStore.ingest`
(`apps/api/src/services/waha-webhook.service.ts:44` e adiante).

Três opções foram consideradas:

| Opção | Efeito | Avaliação |
|---|---|---|
| Descartar o evento antes de persistir | zero rastro | rejeitada: perde auditoria; ao desbloquear há um buraco inexplicável no histórico |
| Persistir tudo e filtrar na leitura | nada muda no write path | rejeitada: `unreadCount`, SLA, Kanban e realtime continuam disparando |
| **Persistir e marcar a conversa como bloqueada** | evento e mensagem gravados, conversa fora da Inbox | **escolhida** |

Na opção escolhida, ao ingerir mensagem cujo identificador pertence a contato
bloqueado:

1. o evento bruto continua gravado em `waha_webhook_events` (auditoria intacta);
2. a mensagem continua gravada em `whatsapp_messages` (histórico reversível);
3. a conversa recebe `blockedAt` preenchido;
4. `unreadCount` **não** é incrementado;
5. `IngestResult` ganha `blocked: true`, e `WahaWebhookController.receive`
   (`apps/api/src/controllers/waha-webhook.controller.ts`) **não** publica
   `message.received` nem `conversation.updated`;
6. `KanbanAutomationCoordinator.run` e `SlaMessageCoordinator.run` **não** rodam,
   para o contato bloqueado não gerar SLA nem mover card;
7. `whatsapp-identity-sync` não é enfileirado.

A listagem já filtra visibilidade (`listConversations` exige
`c.visibilityState = 'visible'`), então basta acrescentar `AND c.blockedAt IS NULL`
ali, em `listQuarantined`/`quarantineCount` e no contador de conversas do
`dashboard()` em `sqlite-domain.repository.ts:75`.

#### Por que uma coluna nova em vez de `visibilityState = 'blocked'`

Reaproveitar `visibilityState` seria mais econômico, mas o CHECK atual é
`IN ('visible','quarantined','technical')`
(`apps/api/migrations/017_conversation_integrity_quarantine.sql`) e o SQLite não
altera CHECK sem reconstruir a tabela pelo procedimento de 12 passos. `conversations`
acumula colunas de mais de dez migrations; reconstruí-la é risco desproporcional
ao ganho. Além disso, bloqueio e quarentena de integridade são ortogonais — uma
conversa pode ser as duas coisas —, e um enum único não representaria isso.
Portanto: `conversations.blockedAt`, `ALTER TABLE ADD COLUMN` simples nos dois
bancos.

#### Busca do estado de bloqueio sem N+1

Na ingestão só existe `chatId`. A consulta é uma única leitura indexada por
`contact_identifiers`, que tem `UNIQUE (workspaceId, identifier)`:

```sql
SELECT c.id, c.blockState
  FROM contact_identifiers i
  JOIN contacts c ON c.workspaceId = i.workspaceId AND c.id = i.contactId
 WHERE i.workspaceId = ? AND i.identifier = ?
   AND c.blockState IN ('blocking','blocked','block_failed');
```

Uma leitura por mensagem ingerida, pelo índice único. Sem varredura, sem N+1,
com `workspaceId` em todos os predicados.

#### Auditoria

`contact_block_events` append-only registra quem pediu, qual ação, qual desfecho,
em qual sessão WAHA e — quando falhou — o motivo já saneado. É o que responde
"quem bloqueou e a propagação funcionou?".

### Cenário (a) — CAMINHO ESCOLHIDO: propagar para a WAHA

Confirmado na seção 1: `POST /api/contacts/block` existe na instância, engine
WEBJS, tier CORE.

Fluxo do `POST /api/v1/contacts/:contactId/block`:

1. transação local: `blockState='blocking'`, `blockPropagation='pending'`,
   `blockRequestedAt=now`, `conversations.blockedAt=now` para as conversas do
   contato, evento `('block','requested')` na auditoria. **Commit.** A partir
   daqui as duas guardas locais já valem.
2. resposta imediata ao cliente com `blockState='blocking'` — a UI mostra
   "Bloqueio pendente", nunca "Bloqueado".
3. propagação assíncrona pelo worker, comando novo do tipo `contact.block`,
   seguindo o padrão de `WorkerCommand` já existente em
   `apps/worker/src/waha-provider.ts`: `POST /api/contacts/block` com
   `{contactId, session}` para **cada sessão WAHA conectada do workspace**.
4. desfecho, detalhado abaixo.

#### O que acontece quando o POST falha

A propagação tem três desfechos distintos, e tratá-los como um só seria o erro
que o requisito pede para evitar. Classificação pela resposta da WAHA:

| Classe | Exemplos | `blockPropagation` | `blockState` | Retry |
|---|---|---|---|---|
| **Sucesso** | 2xx em todas as sessões conectadas | `confirmed` | `blocked` | — |
| **Transitório** | timeout, 5xx, conexão recusada, sessão em `starting` | `pending` | continua `blocking` | **sim** |
| **Permanente** | 4xx de validação, sessão inexistente, `contactId` inválido | `failed` | `block_failed` | **não** |

A distinção importa porque só o transitório se resolve esperando. Repetir um 4xx
de validação queima chamada e mascara um defeito de dados.

**Retry, para a classe transitória.** Backoff exponencial com teto — proposta:
5 tentativas em ~5s, 15s, 45s, 2min, 6min, com jitter. Enquanto tenta,
`blockState` fica em `blocking` e a UI diz "Bloqueio pendente". Esgotadas as
tentativas, cai para `block_failed` / `failed` com `blockLastErrorSafe`
preenchido e evento `('block','failed')` na auditoria. Cada tentativa registra
seu próprio evento, então o histórico mostra que houve insistência.

O retry é por sessão, não global: se o workspace tem três sessões e uma falha,
as outras duas já confirmadas não são reprocessadas. Só o contato fica em
`blocking` até a última resolver.

**Sucesso parcial é falha.** Com múltiplas sessões, `blocked`/`confirmed` só
quando **todas** as conectadas retornam 2xx. Uma sessão sem propagar significa um
canal por onde o contato ainda alcança o operador no WhatsApp — chamar isso de
"bloqueado" seria a mentira que o requisito proíbe. `blockLastErrorSafe` nomeia
quais sessões falharam.

Sessões **desconectadas** no momento do bloqueio não contam como falha: não há
o que propagar. Ficam pendentes de reconciliação — ao reconectar, o worker
reaplica o bloqueio para os contatos com `blockState IN ('blocked','blocking')`
antes de considerar a sessão operacional. Sem isso, reconectar reabriria o canal
silenciosamente.

**Em todos os desfechos de falha, as duas guardas locais continuam valendo.** O
contato segue sem receber e sem enviar dentro do ChatPro. O que muda é só o
rótulo, que passa a dizer a verdade: "Bloqueio local ativo — não propagado ao
WhatsApp", com o motivo e ação de repetir. É exatamente o estado que o cenário
(b) descreve, alcançado por falha de runtime em vez de ausência de recurso.

#### Desbloqueio

Espelho do bloqueio: `unblocking` → `POST /api/contacts/unblock` → `active` e
`blockedAt=NULL`. É o caso mais delicado, porque falhar aqui falha na direção
perigosa — o ChatPro voltaria a aceitar envio enquanto o WhatsApp ainda bloqueia,
e as mensagens seriam aceitas pela API e descartadas pelo WhatsApp sem erro
visível.

Proposta: **falhar fechado**. `blockState` permanece `unblocking` até confirmação,
a guarda de envio continua ativa nesse estado, e a UI sinaliza "Desbloqueio
pendente". O operador nunca recebe sinal verde para enviar antes de o WhatsApp
confirmar. Mesma política de retry da tabela acima.

Depende de `/api/contacts/unblock` existir — **ainda não verificado**, ver a
pendência ao fim da seção 1.

#### Idempotência

Bloquear contato já bloqueado é no-op com 200; a WAHA é chamada apenas em
transição de estado. Isso evita que retry de cliente ou clique duplo gerem
chamadas repetidas ao provider.

### Cenário (b) — fallback: bloqueio local sem propagação

**Não é mais uma hipótese sobre a plataforma** — a seção 1 confirmou a rota. É o
estado degradado em que o sistema entra quando a propagação falha de forma
permanente, e o modo em que ele operaria caso uma instância futura (outra engine,
outra build) não exponha as rotas.

Idêntico ao cenário (a) menos o passo 3: o endpoint grava `blockState='blocked'`
e `blockPropagation='unsupported'` na mesma transação, e a auditoria recebe
`('block','skipped_unsupported')`.

Rotulagem: **"Bloqueado no ChatPro"**, com a ressalva explícita de que o contato
não foi bloqueado no WhatsApp e pode continuar enviando mensagens — que o ChatPro
recebe, arquiva e não exibe. Dizer só "Bloqueado" seria mentira nesse cenário.

Nada além do rótulo e do passo de propagação muda. Mesmo schema, mesmas guardas,
mesma auditoria. É por isso que a migration proposta não depende de qual cenário
está em vigor.

### Independência do opt-out

Preservada por construção, nos dois cenários:

| | Bloqueio | Opt-out |
|---|---|---|
| Escreve em | `contacts.block*`, `conversations.blockedAt`, `contact_block_events` | `opt_out_history` |
| Lê | as próprias colunas | `opt_out_history` |
| Endpoint | `/contacts/:id/block` e `/unblock` | `/contacts/:id/opt-out` (existente) |

Nenhum dos fluxos lê ou escreve no estado do outro. Bloquear não cria opt-out;
desbloquear não apaga opt-out; `removeOptOut` não desbloqueia. As implementações
atuais de opt-out (`sqlite-domain.repository.ts:61-64` e
`supabase-domain.repository.ts:81`) ficam inalteradas.

**Ponto de decisão para você:** hoje `prepareCampaign` exclui destinatários
apenas por opt-out (`sqlite-domain.repository.ts:70`). Contato bloqueado
tecnicamente não pode receber campanha. A proposta é acrescentar um predicado
**separado** de bloqueio — duas condições independentes que excluem pelo mesmo
motivo prático, sem uma ler o estado da outra. Não implementei nem assumi:
confirme se quer esse acoplamento operacional.

## 3. Apagar contato

### O que existe hoje

`deleteContact` é um DELETE cru, sem transação e sem tratar dependentes:

- `sqlite-domain.repository.ts:31` — `DELETE FROM contacts WHERE workspaceId=? AND id=?`
- `supabase-domain.repository.ts:72` — `.from('contacts').delete()`

As FKs do SQLite (`apps/api/migrations/001_initial_persistence.sql`, com
`PRAGMA foreign_keys = ON`):

| Dependente | Ação | Efeito no delete atual |
|---|---|---|
| `contact_tags` | CASCADE | vínculos somem |
| `contact_identifiers` | CASCADE | aliases somem (migration 020) |
| `leads` | SET NULL | lead perde o contato |
| `conversations` | SET NULL | conversa vira órfã |
| `opt_out_history` | **RESTRICT** | **o delete falha** |
| `campaign_recipients` | **RESTRICT** | **o delete falha** |

Ou seja: **hoje, apagar um contato que já deu opt-out ou que participa de alguma
campanha levanta erro de integridade.** Não é hipótese — decorre direto do DDL
citado. É a justificativa mais concreta para a RPC transacional.

Equivalente no Supabase: **idêntico, agora confirmado** (seção 5). As mesmas seis
FKs, com as mesmas ações — `opt_out_history` e `campaign_recipients` também em
`RESTRICT`. O defeito é o mesmo nos dois bancos.

E há um segundo defeito, preexistente, que o dump expôs: a FK
`conversations → contacts` é `ON DELETE SET NULL` sobre a chave composta
`(workspace_id, contact_id)`. A forma **simples** de `SET NULL` anula *todas* as
colunas da chave filha — inclusive `workspace_id`, que é `NOT NULL`. O DDL
versionado usa a forma simples em `web/supabase/migrations/003_conversations.sql:15`
e em `apps/api/migrations/003_conversations.sql:15`, embora o mesmo autor tenha
usado a forma correta com lista de colunas em `leads` (`on delete set null
(contact_id)`). Se o remoto estiver com a forma simples, **apagar um contato que
tenha qualquer conversa já falha hoje**, antes de qualquer coisa proposta aqui.
Confirme com uma leitura pura:

```sql
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'public.conversations'::regclass AND contype = 'f';
```

É defeito separado — reporte, não conserte de carona. A purga proposta não
depende dele: ela desvincula as conversas com `UPDATE` explícito **antes** do
`DELETE`, de modo que nenhuma ação de FK chega a disparar. O SQLite, que nem
sequer suporta a forma com lista de colunas, só funciona por causa dessa mesma
escolha.

### Soft ou hard delete?

**Soft delete como padrão, hard delete (purga) como modo explícito.** Razões:

1. **Opt-out é registro de conformidade.** Se apagar o contato cascatear o
   opt-out, uma reimportação do mesmo número volta a ser alvo de campanha,
   revogando na prática uma manifestação do titular. O `RESTRICT` de hoje existe
   por isso. Cascatear seria trocar uma proteção por um bug silencioso.
2. **"Apagar contato" no CRM ≠ apagar a conversa.** Como `conversations.contactId`
   é SET NULL, o hard delete deixa a conversa na Inbox com a identidade WhatsApp
   intacta. O operador que apagou "o contato" continua vendo a conversa e conclui,
   com razão, que a exclusão não funcionou.
3. **LGPD exige a via de apagamento real.** Direito à eliminação não se atende com
   soft delete. Daí o segundo modo.

Proposta, transacional, com a assinatura completa fixada já em M2:

```sql
chatpro_delete_contact(p_workspace_id text, p_contact_id text,
                       p_mode text default 'soft',
                       p_actor_user_id text default null,
                       p_identifier_hash text default null)
```

`p_mode IN ('soft','restore','purge')`. Em M2 só `soft` e `restore` são aceitos;
`purge` é **recusado com mensagem explícita** até M3 rodar, para a dependência
falhar alto em vez de corromper em silêncio.

`p_identifier_hash` já aparece em M2 embora só M3 o use, e isso é deliberado:
`CREATE OR REPLACE FUNCTION` **não altera assinatura**. Se M3 acrescentasse um
parâmetro, o Postgres criaria uma segunda função *sobrecarregada* em vez de
substituir a primeira, e toda chamada com quatro argumentos passaria a ser
ambígua. Fixando a assinatura final desde M2, M3 troca apenas o corpo — e os
`GRANT`s sobrevivem, porque `CREATE OR REPLACE` preserva as permissões da função
existente.

### Modo `soft` (padrão)

| Objeto | Destino |
|---|---|
| `contacts` | `deletedAt = now()`; sai das listagens e da busca |
| `contact_identifiers` | **preservados** |
| `contact_tags` | preservados |
| `conversations` | `contactId` preservado; a conversa **continua na Inbox** |
| `whatsapp_messages` | intactas |
| `opt_out_history` | intacto |
| `campaign_recipients` | preservado |
| `leads` | intactos |

Reversível por `deletedAt = NULL`.

#### Por que o soft delete NÃO desvincula as conversas

É a decisão menos óbvia do modo `soft`, e ela se sustenta em evidência, não em
preferência. Desvincular (`conversations.contactId = NULL`) seria errado por dois
motivos independentes — e o segundo é fatal.

**Seria inócuo.** `waha-webhook.service.ts:117` (Supabase) e `:82` (SQLite)
gravam o vínculo assim:

```ts
contact_id: existing?.contact_id ?? contact?.id ?? null
```

O `contactId` só é escrito quando ainda está nulo. Como o soft delete **preserva
`contact_identifiers`**, a primeira mensagem seguinte do mesmo número resolve
para o contato apagado, encontra `contact_id` nulo e **regrava o vínculo**.
Desvincular seria desfeito pelo próximo inbound.

**Seria irreversível.** Zerar `contactId` destrói a informação de quais conversas
pertenciam ao contato. O restore não teria como reconstruir o vínculo — e o soft
delete deixaria de ser reversível, que é a sua única razão de existir.

Some-se a isso que a FK `conversations → contacts` é `SET NULL` e o soft delete
não executa `DELETE` nenhum, então a ação da FK nunca dispara. **Preservar o
vínculo é o comportamento que o schema real já produz sozinho** — não é preciso
código para obtê-lo, seria preciso código para estragá-lo.

Consequência de produto que a UI precisa tratar: a conversa **continua na Inbox**
com a identidade do WhatsApp. "Apagar o contato" no CRM não apaga a conversa. É
a mesma assimetria do modo `purge`, e a razão de o rótulo na interface não poder
ser um "Excluir" seco.

**Ressurreição.** Os aliases ficam, então uma mensagem nova do mesmo número
resolve para o contato apagado. Criar um segundo contato violaria
`UNIQUE (workspaceId, phoneNumber)`. A proposta é o resolvedor de identidade
**limpar `deletedAt` e registrar a ressurreição** na auditoria. Alternativa seria
liberar o telefone soltando os aliases no soft delete, ao custo de perder a
ligação com o histórico. Prefiro ressuscitar: a pessoa escreveu de novo, o contato
volta, e fica registrado. **Confirme se concorda** — é a decisão de produto menos
óbvia deste documento.

### Modo `purge` (LGPD)

Ordem dentro da transação, escolhida para que **nenhuma ação de FK precise
disparar**: cada dependente é resolvido por comando explícito antes do `DELETE`
do contato.

| Passo | Objeto | Ação |
|---|---|---|
| 0 | — | **recusa** se houver opt-out e o hash não vier |
| 1 | `opt_out_history` | `contactId = NULL`, `identifierHash` gravado — **a linha sobrevive** |
| 2 | `campaign_recipients` | DELETE (contorna o RESTRICT sem mudar o schema) |
| 3 | `conversations` | `contactId = NULL`, `blockedAt = NULL` |
| 4 | `contact_identifiers` | DELETE (também cascatearia) |
| 5 | `contact_tags` | DELETE (também cascatearia) |
| 6 | `leads` | `contactId = NULL` (também viria da FK) |
| 7 | `contact_block_events` | DELETE (também cascatearia) |
| 8 | `contact_deletion_log` | INSERT — tabela **sem FK**, sobrevive ao contato |
| 9 | `contacts` | DELETE |

Os passos 4 a 7 são explícitos apesar de CASCADE/SET NULL por três razões: a RPC
devolve a contagem do que removeu; o resultado deixa de depender do modo de FK do
SQLite em runtime; e, decisivo, **não se depende da forma do `SET NULL`** —
`conversations` e `leads` usam chave composta, e a forma simples de `SET NULL`
tentaria anular `workspaceId NOT NULL` (ver seção 3, "o que existe hoje").

O passo 0 não é burocracia: sem hash, a linha de opt-out sobrevive inconsultável,
o que equivale a perder a manifestação do titular preservando a aparência de tê-la
guardado.

O passo 1 é o núcleo do desenho: o opt-out **sobrevive sem PII**. `identifierHash`
mantém a manifestação consultável por número sem que o número esteja armazenado,
de modo que uma importação futura do mesmo telefone ainda a encontre.

#### O que muda de schema — e o que, ao contrário do que se supunha, não muda

Só uma coisa é obrigatória: **soltar o `NOT NULL` de `opt_out_history.contactId`**,
para a linha poder ser desvinculada e sobreviver. Mais o acréscimo da coluna
`identifierHash`.

**Trocar a ação da FK de `RESTRICT` para `SET NULL` não é necessário — e é pior.**
A versão anterior deste documento afirmava que era a única alteração estrutural
obrigatória. Estava errada. A purga desvincula as linhas com `UPDATE` explícito
**antes** do `DELETE` do contato; quando o `DELETE` roda, nenhuma linha de
`opt_out_history` referencia o contato e o `RESTRICT` nunca chega a disparar.

Manter o `RESTRICT` é um ganho de segurança, e a diferença é exatamente o dano
que a proposta existe para impedir:

| | Caminho que apague um contato **sem** passar pela RPC |
|---|---|
| com `RESTRICT` | falha alto. O opt-out nunca fica órfão por acidente. |
| com `SET NULL` | **sucede em silêncio** e desvincula a linha **sem gravar `identifierHash`**. O opt-out sobrevive como lixo: não casa com número nenhum numa importação futura. |

`SET NULL` desliga a proteção justamente no caminho não auditado. O SQL traz o
bloco de troca comentado — porque foi pedido, não porque seja recomendado.

#### Hash do telefone: HMAC com pepper, calculado na aplicação

O hash é calculado **na aplicação** e chega à RPC como parâmetro
`p_identifierHash`. Nem o Postgres nem o SQLite o calculam. Quatro razões, em
ordem de peso:

1. **SHA-256 puro de telefone não anonimiza.** O espaço de busca de um celular
   brasileiro tem ordem de 10⁹–10¹¹ preimagens; uma GPU comum reverte o conjunto
   inteiro em minutos. Sob a LGPD, dado pseudonimizado reversível continua sendo
   dado pessoal. Guardar `SHA-256(telefone)` e chamar isso de "sem PII" seria
   falso — e falso justamente no artefato criado para provar conformidade. A
   aplicação usa **HMAC-SHA256 com um pepper de ambiente**, que nunca entra no
   banco, em migration, em log ou na documentação. Um dump do banco, sozinho,
   deixa de bastar para reverter o hash. É isso que torna "o opt-out sobrevive
   sem PII" uma afirmação verdadeira em vez de retórica.
2. **Paridade SQLite/Supabase**, que é a regra 1 do `CLAUDE.md`. O SQLite não tem
   SHA-256 nativo. Calcular no Postgres obrigaria uma segunda implementação em
   Node, e as duas teriam de produzir byte a byte o mesmo resultado para sempre.
   Uma implementação só, em TypeScript, elimina a classe inteira de divergência.
3. **Some a dependência de `pgcrypto`.** Sem `digest()` não há extensão a
   habilitar, e o "não identificado" sobre `pgcrypto` deixa de existir.
4. O backfill histórico teria de ser de aplicação de qualquer forma — é ela que
   tem o pepper. Uma rotina serve aos dois bancos.

Entrada canônica, que precisa ficar fixada: `contacts.phoneNumber` exatamente
como armazenado. Já é normalizado — `normalizedPhoneNumberSchema`
(`packages/contracts/src/index.ts:49`) exige `/^\d{8,15}$/` e `normalizedPhone()`
(`contact-identity-resolver.service.ts:14`) produz esse formato: só dígitos, sem
`+`, sem sufixo `@c.us`. Mudar o pepper ou a normalização invalida todo hash já
gravado; versione o prefixo (`v1:`) se algum dia precisar rodar dois em paralelo.

A RPC **recusa** purgar contato que tenha opt-out sem hash. Falhar alto é melhor
que destruir em silêncio a capacidade de honrar a manifestação.

#### O achado: o hash não tinha quem o lesse (RESOLVIDO)

Este é o achado mais sério da verificação, e ele atinge o núcleo do desenho.

`identifierHash` seria, hoje, uma coluna **write-only**. Um `grep` por
`identifier_hash|identifierHash` em todo o repositório, fora o SQL de proposta,
retorna **zero** ocorrências. E os três consumidores de opt-out casam
exclusivamente por `contactId`:

| Consumidor | Predicado |
|---|---|
| `sqlite-domain.repository.ts:70` `prepareCampaign` | `o.contactId = r.contactId` |
| `chatpro_prepare_campaign` (`20260715000100_chatpro_domain_rpcs.sql:102`) | `o.contact_id = r.contact_id` |
| `sqlite-domain.repository.ts:27` filtro `optOut` da listagem | `o.contactId` |

Logo, assim que o passo 1 da purga zera `contactId`, a linha deixa de casar com
**qualquer** predicado existente — e uma reimportação do mesmo número gera um
`contactId` novo que nada liga ao hash. Na prática, **purgar revogaria o
opt-out**: exatamente o dano que M3 existe para impedir, e o mesmo defeito pelo
qual esta proposta recusa o `ON DELETE SET NULL`.

Escrever o hash sem ler o hash não preserva nada; só produz a aparência de ter
preservado.

#### Caminho de leitura — IMPLEMENTADO

Resolvido em `apps/api/src/services/opt-out-identity.ts`, por **adoção** em vez de
espalhar o predicado de hash por todos os consumidores.

**A adoção.** Ao materializar um contato — `createContact` nos dois providers, e
o resolvedor de identidade quando uma mensagem cria o contato — o sistema calcula
o hash do telefone e reata a linha órfã:

```sql
UPDATE opt_out_history SET contactId = <novo contato>
 WHERE workspaceId = ? AND contactId IS NULL AND identifierHash = ?
```

A partir daí **todos os consumidores existentes voltam a funcionar sem saber que
hashes existem**: `prepareCampaign`, `chatpro_prepare_campaign` e o filtro da
listagem continuam casando por `contactId`. Isso é o que preserva a paridade sem
tocar em nenhuma RPC — `chatpro_prepare_campaign` ficaria fora do alcance do
código de aplicação, e mudá-la exigiria outra migration.

**A leitura direta.** `optOutStatus` também passou a considerar o hash, como rede
de segurança para contatos criados antes desta mudança:

```sql
WHERE workspaceId = ? AND (contactId = ? OR (contactId IS NULL AND identifierHash = ?))
```

O predicado só alcança linhas **órfãs** (`contactId IS NULL`), que é precisamente
"quando o contactId não existir mais". Contatos com opt-out próprio intacto não
mudam de comportamento.

**Inerte antes de M3.** No SQLite a presença da coluna é lida do próprio schema a
cada chamada — sem cache, porque uma resposta cacheada ficaria velha no instante
em que a coluna aparecesse. No Supabase é uma sondagem cacheada por cliente, o
que custa uma ida ao banco: **depois de aplicar M3 é preciso reiniciar a API**,
senão o processo em execução mantém a resposta negativa. O SQLite não tem essa
exigência, porque migra no boot.

**O pepper.** `OPT_OUT_HASH_PEPPER`, mínimo de 32 caracteres, documentado em
`.env.example` sem valor. Ausente ou curto demais, o cálculo **falha explícito**
(`SERVICE_UNAVAILABLE`) — nunca cai para um hash sem chave, que pareceria
conformidade sem entregar nenhuma. Enquanto a coluna não existir, o pepper não é
exigido: o caminho inteiro fica inerte.

**O que continua faltando.** A adoção cobre o contato que é materializado depois
da purga. Não cobre `updateContact` trocando o telefone de um contato existente
para um número com opt-out órfão — caso raro, deliberadamente fora de escopo, e
que a rede de segurança do `optOutStatus` ainda reporta.

É código, não migration. M1 e M2 não são afetadas.

#### Escopo real da purga — o que ela não apaga

A purga desvincula e apaga o **cadastro de CRM**. O telefone permanece em claro
em pelo menos quatro lugares que a RPC não toca:

| Onde | Origem |
|---|---|
| `whatsapp_identities.phone` | `005_whatsapp_group_persistence.sql:6` |
| `pending_contact_identities.identifier` | `020_contact_identity_aliases.sql:17` |
| `conversations.chatId` | formato `55…@c.us` |
| `whatsapp_messages.chatId` | idem |

Verificado após uma purga completa: `conversations.chatId` continua
`5511999998888@c.us`, apenas com `contactId` nulo.

Consequência para a alegação jurídica, e ela precisa ser dita sem enfeite: o
pepper protege contra quem obtenha **apenas** a tabela de opt-out, não contra um
dump completo do banco, onde o telefone está em claro ao lado. **O que M3 entrega
é desvinculação de cadastro, não "direito à eliminação".** Alcançar a eliminação
de fato exige estender a purga a `pending_contact_identities` e
`whatsapp_identities` e decidir o que fazer com os `chatId` — outro escopo, que
depende da decisão jurídica da pendência 4.

`whatsapp_messages` **não** são apagadas: pertencem à conversa, não ao contato, e
apagá-las destruiria o histórico de atendimento de outros operadores. Se a
exigência legal alcançar o conteúdo das mensagens, é outro escopo — diga e eu
desenho separado.

**Assimetria de reversibilidade:** `soft` é reversível; `purge` não é. Para
linhas de opt-out históricas o `identifierHash` nasce nulo e depende de um
backfill de aplicação. Enquanto esse backfill não rodar, purgar um contato com
opt-out antigo é **recusado** pela RPC — que é o comportamento correto, e o
motivo de a recusa existir. Está anotado no SQL.

### Transacionalidade nos dois bancos

- **Supabase:** função PL/pgSQL, atômica por natureza, seguindo o molde real das
  outras 19 RPCs, confirmado em
  `supabase/migrations/20260715000100_chatpro_domain_rpcs.sql`:
  `language plpgsql security invoker set search_path = public, pg_temp`,
  `p_workspace_id` primeiro, `perform chatpro_require_workspace(...)` como
  primeira instrução, `select ... for update` antes de mutar,
  `revoke all ... from public` e `grant execute ... to service_role`.
  **`security invoker`, não `SECURITY DEFINER`** — a versão anterior deste
  documento sugeria `DEFINER`, o que teria contrariado a convenção da casa e
  feito a função ignorar RLS para qualquer chamador.
- **SQLite:** não há RPC. O equivalente é `this.db.transaction(...)` em
  `sqlite-domain.repository.ts`, com a mesma ordem de passos e o mesmo retorno.
  O arquivo SQL entrega apenas as mudanças de schema do lado SQLite.
  Atenção ao implementar: o `DELETE` cru de hoje (`sqlite-domain.repository.ts:31`)
  falha para qualquer contato que tenha conversa, porque a FK composta com
  `SET NULL` tentaria anular `workspaceId NOT NULL`. A transação precisa
  desvincular com `UPDATE` explícito antes do `DELETE`, como a RPC faz.

Retorno em ambos: JSON com `mode` e as contagens por objeto afetado, para a API
relatar o que aconteceu em vez de um 204 mudo.

## 4. SQL proposto — três migrations independentes

`docs/migrations-propostas-contatos.sql`. **Não aplicado.** Fica em `docs/` de
propósito, para não ser executado por engano pelo runner de migrations.

A separação em três não é organizacional, é consequência do schema real: como o
soft delete não apaga nada, ele **nunca esbarra no `RESTRICT`**, e a
funcionalidade principal deixa de depender de qualquer mudança de constraint.

| | Habilita | Reversível | Depende de |
|---|---|---|---|
| **M1** Bloqueio | as duas guardas locais, a máquina de estados e a auditoria | sim, nos dois bancos, por `ALTER TABLE`/`DROP` | **nenhuma migration** |
| **M2** Soft delete + RPC | exclusão reversível, restore e o log que sobrevive ao contato | sim, em dois níveis — schema e dado (`restore`) | **nenhuma migration** |
| **M3** Purga LGPD | desvinculação real do cadastro preservando a linha de opt-out | schema sim; **dado não** — depois da primeira purga só resta backup | **M1 e M2** |

M1 e M2 são mutuamente independentes: qualquer uma pode ser aplicada sozinha e
entrega o seu recurso inteiro. M3 depende de M1 por **dois** objetos — zera
`conversations.blockedAt` e apaga `contact_block_events` — e de M2 pela função e
pelo `contact_deletion_log`.

Modo de falha a conhecer: **aplicar M3 isolada não dá erro de DDL.** O validador
do plpgsql não resolve nomes de tabela na criação, então a migration aplica
normalmente e a função só quebra na primeira chamada, com `42703`. Verificado.

Cada migration traz SQLite, Supabase e rollback próprios. Os arquivos definitivos,
quando aprovados, seriam `apps/api/migrations/021..023_*.sql` e
`web/supabase/migrations/<timestamp>_*.sql`.

### Independência entre migrations não é independência de tudo

Duas ressalvas que a tabela acima não captura, ambas descobertas por execução e
ambas **bloqueantes**:

**1. Pré-requisito de código, comum às três (só SQLite).** O repositório usa
`INSERT` posicional, sem lista de colunas, em 14 pontos de
`sqlite-domain.repository.ts`. Dois são fatais:

```text
:29  INSERT INTO contacts VALUES (@id,@workspaceId,...,@updatedAt)      -- 8 valores
:61  INSERT INTO opt_out_history VALUES (@id,@workspaceId,...,@updatedAt) -- 8 valores
```

Qualquer `ADD COLUMN` em `contacts` quebra `createContact`; o rebuild do
`opt_out_history` quebra `optOut`. Reproduzido sobre a baseline real:

```text
antes de M1 ...... createContact -> OK
depois de M1 ..... "table contacts has 13 columns but 8 values were supplied"
depois de M2 ..... "table contacts has 14 columns but 8 values were supplied"
depois de M3 ..... "table opt_out_history has 9 columns but 8 values were supplied"
```

Pior que falhar: **o erro é mascarado**. A linha `:29` está dentro de
`catch { fail(409,'CONFLICT','Phone number already exists in this workspace'); }`,
um `catch` nu. O operador veria "telefone já existe" para todo contato novo, sem
nada no log apontando para a migration. Corrigir os dois `INSERT` para a forma
nomeada — e estreitar o `catch` para `SQLITE_CONSTRAINT_UNIQUE` — é
**pré-requisito de aplicação**, não melhoria. O lado Supabase não tem o
problema: as RPCs nomeiam as colunas.

**2. Pré-requisito próprio de M3: `identifierHash` não tem leitor.** Detalhado
na seção 3 — sem ele, a purga *revoga* o opt-out em vez de preservá-lo.

### Duas armadilhas que o SQL desarma

1. **O runner do SQLite já abre transação.**
   `apps/api/src/persistence/database.ts:31` executa cada arquivo dentro de
   `this.sqlite.transaction(...)`. Logo, dentro de um arquivo de migration,
   `BEGIN TRANSACTION` levanta *"cannot start a transaction within a
   transaction"* e derruba a migration inteira, e `PRAGMA foreign_keys = OFF` é
   **no-op silencioso** — o SQLite ignora a mudança com transação pendente. A
   versão anterior usava os dois no rebuild do `opt_out_history` e teria falhado
   na aplicação. Nenhuma seção de migration usa `PRAGMA` ou `BEGIN`/`COMMIT`
   agora; só as de rollback, que rodam à mão fora do runner. O rebuild funciona
   com `foreign_keys` ligado porque `opt_out_history` é tabela **filha** e nada
   a referencia — não há o que orfanar.

2. **O que o SQLite realmente recusa em `DROP COLUMN`** — e aqui uma versão
   intermediária desta proposta errou, prescrevendo um rebuild desnecessário da
   tabela `contacts`, que é pai de seis outras. Medido em 3.53.2:

   | Caso | `DROP COLUMN` |
   |---|---|
   | coluna com CHECK de **coluna** (o que `ADD COLUMN` produz) | **aceito** |
   | coluna citada em CHECK de **tabela** | recusado — `error in table u after drop column` |
   | coluna citada no `WHERE` de índice **parcial** | recusado — `error in index ix after drop column` |

   A regra correta é *índice ou CHECK de tabela*, não *CHECK*. Por isso os
   rollbacks de M1 e M2 saem por `ALTER TABLE` limpo, desde que os índices
   parciais caiam antes — e é o índice, não o CHECK, que impõe essa ordem.

### Rollback só é seguro se o executor parar no primeiro erro

Vale para os dois bancos, e custou duas rodadas de verificação para aparecer:
**ordenar os comandos não protege nada se o cliente continua após o erro.**

- **Postgres.** Colado em `psql` com autocommit e sem `ON_ERROR_STOP`, o
  `ALTER … SET NOT NULL` que serve de trava no rollback de M3 falha com `23502`
  e os comandos seguintes executam assim mesmo, destruindo `identifier_hash` —
  o desfecho que a ordem existia para impedir. Os três rollbacks passaram a ser
  envelopados em `BEGIN; … COMMIT;`, o que torna a proteção estrutural.
- **SQLite.** Pior. O `sqlite3` CLI, por padrão, imprime o erro e **continua**.
  Sem `.bail on`, o `INSERT … SELECT` que serve de trava falha, o `DROP TABLE`
  seguinte roda, e o `COMMIT` confirma: **zero linhas** em `opt_out_history`,
  com `foreign_key_check` e `integrity_check` limpos. O banco fica íntegro e
  vazio, sem sinal de que o histórico inteiro de opt-out se perdeu. O bloco
  agora começa com `.bail on` e **renomeia** a tabela antiga em vez de apagá-la,
  de modo que nem um `DROP` indevido a alcance.

Também documentado no SQL: **reaplicar o bloco M3/SQLite zera todo o backfill de
hash com sucesso e sem aviso**, porque o `INSERT … SELECT` grava `NULL` em
`identifierHash`. M1 e M2 falham alto na segunda vez; M3 não. O runner
automático está protegido por `schema_migrations`; execução manual não está.

## 5. Schema real — RESOLVIDO

O bloqueio "o schema CRM do Supabase não está versionado" que esta seção
descrevia **não existe mais**. O schema foi obtido e conferido. O SQL da proposta
está escrito contra ele, não mais contra suposição.

### Evidência 1 — dump do remoto

Extraído por `information_schema` e `pg_constraint` no banco remoto:

```text
contacts: id text NOT NULL, workspace_id text NOT NULL, display_name text NOT NULL,
          phone_number text NOT NULL, email text, company text,
          created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
```

**Não existe `blocked_at` nem `deleted_at`** — as colunas propostas são todas
aditivas, nenhuma colide.

As seis FKs que referenciam `contacts`, todas pela chave composta
`(workspace_id, contact_id)`, com o nome real e a ação real:

| Constraint | `ON DELETE` |
|---|---|
| `contact_tags_workspace_id_contact_id_fkey` | CASCADE |
| `contact_identifiers_workspace_id_contact_id_fkey` | CASCADE |
| `leads_workspace_id_contact_id_fkey` | SET NULL |
| `conversations_workspace_id_contact_id_fkey` | SET NULL |
| `campaign_recipients_workspace_id_contact_id_fkey` | RESTRICT |
| `opt_out_history_workspace_id_contact_id_fkey` | RESTRICT |

O remoto tem **19 RPCs `chatpro_*`**, e **`chatpro_delete_contact` não é uma
delas** — a função proposta é nova, não uma substituição.

### Evidência 2 — o DDL estava versionado o tempo todo, em outro diretório

A afirmação anterior era falsa por escopo de busca. A investigação olhou apenas
`web/supabase/migrations/`. O DDL de CRM e as RPCs estão versionados na **raiz do
repositório**:

```console
$ ls supabase/migrations/ | head -3
20260715000000_initial_chatpro_persistence.sql   # cria contacts, opt_out_history, ...
20260715000100_chatpro_domain_rpcs.sql           # define as RPCs chatpro_*
20260716000100_grant_chatpro_service_role_table_access.sql
```

`supabase/migrations/20260715000000_initial_chatpro_persistence.sql:23` traz o
`opt_out_history` com `on delete restrict`, e `:3` traz o `contacts` exatamente
com as oito colunas do dump. **As duas fontes batem coluna a coluna** — o dump
confirma que o remoto está no estado que esses arquivos descrevem.

Isso também resolve dois "não identificado" que restavam:

- **Convenção das RPCs.** `20260715000100_chatpro_domain_rpcs.sql:3` define
  `chatpro_require_workspace`, e todas as funções seguem o mesmo molde:
  `language plpgsql security invoker set search_path = public, pg_temp`,
  `p_workspace_id text` como primeiro parâmetro, `perform
  chatpro_require_workspace(...)` como primeira instrução, `revoke all ... from
  public` seguido de `grant execute ... to service_role`. Nenhum grant a `anon`
  ou `authenticated`. A proposta segue esse molde à risca — inclusive
  `security invoker`, e não o `SECURITY DEFINER` que a versão anterior sugeria.
- **RLS.** Não existe **um único** `CREATE POLICY` em nenhum dos dois diretórios
  de migrations. As tabelas têm RLS ligada e nenhuma política; o acesso é
  exclusivamente por `service_role`, que ignora RLS. As tabelas novas espelham
  essa postura, que é o que "espelhar as políticas existentes" significa na
  prática: não criar nenhuma.

### O que a evidência mudou no desenho

Duas conclusões da versão anterior caíram:

1. **A alteração de FK não é a "única mudança estrutural obrigatória" — e não é
   obrigatória.** Como o soft delete não apaga nada, ele nunca esbarra em
   `RESTRICT`. Só a purga precisa mexer em `opt_out_history`, e mesmo lá o único
   comando indispensável é soltar o `NOT NULL` de `contact_id`. Trocar a ação da
   FK para `SET NULL` é opcional e **contraindicado**: a purga já desvincula com
   `UPDATE` explícito antes do `DELETE`, então o `RESTRICT` nunca dispara;
   mantê-lo garante que nenhum caminho fora da RPC consiga desvincular um
   opt-out sem gravar o hash. Com `SET NULL`, esse caminho passaria em silêncio e
   deixaria o opt-out órfão e inconsultável — exatamente o dano que a proposta
   existe para impedir.
2. **A proposta virou três migrations independentes.** Como a funcionalidade
   principal não depende de mudança de constraint, bloqueio e soft delete não
   precisam esperar pela decisão da purga. Ver seção 4.

### Problema separado, ainda em aberto

`web/supabase/migrations/` — o diretório que o `CLAUDE.md` declara canônico
(«`web/supabase/migrations`: esquema Supabase remoto») — **continua sem a
baseline de CRM**. Ele começa em `002_waha_webhook_store.sql`, sem `001`, e nunca
cria `contacts`, `contact_tags` ou `opt_out_history`; só as referencia. A
baseline vive na raiz, fora dele.

Isso **não bloqueia mais** as migrations propostas: o schema é conhecido, os
nomes de constraint são reais e o SQL foi escrito e testado contra eles. Mas
continua sendo um defeito de manutenção: quem ler apenas o diretório canônico
conclui, como esta investigação concluiu, que o schema não existe. Reconciliar os
dois diretórios é trabalho à parte, com escopo próprio, e não deve ser feito de
carona nesta entrega.

## Resumo dos pontos em aberto

### Bloqueiam a aplicação — RESOLVIDOS

| # | Bloqueio | Alcance | Estado |
|---|---|---|---|
| A | `INSERT` posicional em `sqlite-domain.repository.ts`, com o erro mascarado num 409 falso | M1, M2 e M3 (só SQLite) | **corrigido** — os 16 `INSERT` nomeiam colunas e o `catch` nu virou `conflictOn`, que só traduz para 409 a violação daquela constraint |
| B | `identifierHash` sem nenhum caminho de leitura — a purga revogaria o opt-out | só M3 | **corrigido** — ver "Caminho de leitura" abaixo |

Ainda assim, **nenhuma migration foi aplicada**. O código agora sobrevive a M1,
M2 e M3, e permanece inerte enquanto elas não rodarem.

### Dependem de decisão sua

| # | Pendência | Quem decide |
|---|---|---|
| 1 | `POST /api/contacts/unblock` existe? Comando pronto no fim da seção 1 | teste manual — **bloqueia a implementação da propagação** |
| 2 | Campanha deve excluir bloqueados, além de opt-out? | produto |
| 3 | Soft delete ressuscita contato ao receber mensagem nova? | produto |
| 4 | A purga alcança `chatId`, `whatsapp_identities` e o conteúdo das mensagens? | jurídico — define se "eliminação" é alcançável |
| 5 | Trocar a FK do `opt_out_history` para `SET NULL`? A análise recomenda **não** | você — não bloqueia nada |

### Fora do escopo desta entrega, registrados como trabalho à parte

| Defeito | Onde |
|---|---|
| `web/supabase/migrations/` sem a baseline de CRM, que vive na raiz | seção 5 |
| FK `conversations → contacts` com `SET NULL` sem lista de colunas — apagar contato com conversa ou lead **já falha hoje** | seção 3 |
| Outros 12 `INSERT` posicionais em `sqlite-domain.repository.ts` | seção 4 |
| `optOutHistorySchema` (`packages/contracts/src/index.ts:52`) passa a mentir sobre o schema depois de M3 | seção 3 |

Resolvido desde a primeira versão deste documento:

- `POST /api/contacts/block` **existe** na instância local (WAHA 2026.7.1, WEBJS)
  e **não é Plus-only** — verificado em tier CORE. Cenário (a) é o caminho.
- **O schema do Supabase é conhecido** (seção 5). Deixou de bloquear as
  migrations, e derrubou a tese de que a alteração de FK era obrigatória.
- **A convenção das RPCs e a postura de RLS** estavam versionadas o tempo todo em
  `supabase/migrations/` na raiz: `security invoker`, `search_path` fixo, grant
  só para `service_role`, nenhuma policy. Os "não identificado" que restavam
  sobre RLS, grants e `pgcrypto` deixaram de existir.
