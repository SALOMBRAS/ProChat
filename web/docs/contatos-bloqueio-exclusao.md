# Bloqueio e exclusão de contatos — investigação e proposta

Documento de proposta. **Nada aqui foi implementado, nenhuma migration foi
aplicada e nenhum DDL foi executado.** O SQL correspondente está em
`docs/migrations-propostas-contatos.sql`, também não aplicado.

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
cenários.** Muda apenas se a etapa de propagação roda. Isso desacopla a decisão
de banco da resposta sobre a WAHA.

## 1. A WAHA expõe block/unblock?

### Instância local (somente leitura)

`WAHA_BASE_URL=http://127.0.0.1:3002`, porta em escuta confirmada.

```console
$ curl -s -H "X-Api-Key: ***" http://127.0.0.1:3002/api/version
{"version":"2026.7.1","engine":"WEBJS","tier":"CORE","browser":"/usr/bin/chromium",
 "platform":"linux/x64","worker":{"id":null}}
```

Engine **WEBJS**, versão **2026.7.1**, tier **CORE**.

### Sondagem de rota: inconclusiva

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

**Restrição de tier (CORE vs PLUS): não identificado.** Nenhuma das duas fontes
declara se block/unblock exige WAHA Plus. Como a instância local é **CORE**, isso
é decisivo e continua em aberto.

### Veredito

| Pergunta | Resposta | Base |
|---|---|---|
| A WAHA documenta block/unblock? | **Sim** | doc oficial + espelho DeepWiki |
| A engine em uso (WEBJS) está na matriz de suporte? | **Sim** | ambas as fontes |
| A instância local expõe a rota? | **Não identificado** | sondagem inconclusiva, OpenAPI não exposta |
| Funciona no tier CORE? | **Não identificado** | nenhuma fonte declara o tier |

### Como fechar a questão

Fora do escopo somente leitura desta investigação, então fica como passo manual.
O teste decisivo é um POST com sessão inexistente: não bloqueia ninguém, e o
formato do erro distingue os casos.

```bash
curl -i -X POST http://127.0.0.1:3002/api/contacts/block \
  -H "X-Api-Key: $WAHA_API_KEY" -H 'Content-Type: application/json' \
  -d '{"contactId":"000000000000","session":"sessao-inexistente-de-teste"}'
```

- Erro citando sessão inexistente / validação → **a rota existe** → cenário (a).
- 404 genérico do NestJS, igual ao de `/api/rotaInexistenteDeControle` → rota
  ausente nesta build/tier → cenário (b).

Alternativa não destrutiva: abrir `/dashboard` autenticado e ler o Swagger.

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

### Cenário (a) — a WAHA suporta bloqueio

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
4. desfecho:
   - todas as sessões OK → `blockState='blocked'`,
     `blockPropagation='confirmed'`, `blockConfirmedAt=now`, evento
     `('block','propagated')`, realtime `contact.block.updated`;
   - qualquer falha → `blockState='block_failed'`, `blockPropagation='failed'`,
     `blockLastErrorSafe` com a mensagem saneada, evento `('block','failed')`.
     **As guardas locais continuam valendo** — o contato segue protegido no
     ChatPro, e a UI diz exatamente isso.

O desbloqueio é o espelho: `unblocking` → `POST /api/contacts/unblock` → `active`
e `blockedAt=NULL`. Falha na propagação do desbloqueio é o caso mais delicado —
o ChatPro voltaria a aceitar envio enquanto o WhatsApp ainda bloqueia. Proposta:
manter `blockState='unblocking'` até confirmação, mantendo a guarda de envio
ativa, e sinalizar "Desbloqueio pendente". Falhar fechado, não aberto.

Idempotência: bloquear contato já bloqueado é no-op com 200; a WAHA é chamada
apenas em transição de estado.

### Cenário (b) — a WAHA não suporta bloqueio

Idêntico ao anterior menos o passo 3. O endpoint grava
`blockState='blocked'` e `blockPropagation='unsupported'` na mesma transação,
e a auditoria recebe `('block','skipped_unsupported')`.

Rotulagem: **"Bloqueado no ChatPro"**, com a ressalva explícita de que o contato
não foi bloqueado no WhatsApp e pode continuar enviando mensagens — que o ChatPro
recebe, arquiva e não exibe. Dizer só "Bloqueado" seria mentira nesse cenário.

Nada além do rótulo e do passo de propagação muda. Mesmo schema, mesmas guardas,
mesma auditoria.

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

Equivalente no Supabase: **não identificado** — o DDL de `contacts` e
`opt_out_history` não está versionado (ver seção 5).

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

Proposta: `chatpro_delete_contact(p_workspace_id, p_contact_id, p_mode)` com
`p_mode IN ('soft','purge')`, transacional.

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

**Ressurreição.** Os aliases ficam, então uma mensagem nova do mesmo número
resolve para o contato apagado. Criar um segundo contato violaria
`UNIQUE (workspaceId, phoneNumber)`. A proposta é o resolvedor de identidade
**limpar `deletedAt` e registrar a ressurreição** na auditoria. Alternativa seria
liberar o telefone soltando os aliases no soft delete, ao custo de perder a
ligação com o histórico. Prefiro ressuscitar: a pessoa escreveu de novo, o contato
volta, e fica registrado. **Confirme se concorda** — é a decisão de produto menos
óbvia deste documento.

### Modo `purge` (LGPD)

Ordem dentro da transação, escolhida para respeitar as FKs sem alterar as que já
funcionam:

| Passo | Objeto | Ação |
|---|---|---|
| 1 | `opt_out_history` | `contactId = NULL`, `identifierHash` preservado — **a linha sobrevive** |
| 2 | `campaign_recipients` | DELETE (contorna o RESTRICT sem mudar o schema) |
| 3 | `conversations` | `contactId = NULL`, `blockedAt = NULL` |
| 4 | `contact_identifiers` | DELETE (também cascatearia) |
| 5 | `contact_tags` | DELETE (também cascatearia) |
| 6 | `contact_block_events` | DELETE por cascata |
| 7 | `contact_deletion_log` | INSERT — tabela **sem FK**, sobrevive ao contato |
| 8 | `contacts` | DELETE |

Passos 4 e 5 são explícitos apesar do CASCADE, para a RPC devolver a contagem do
que removeu e não depender do modo de FK do SQLite em runtime.

O passo 1 é o núcleo do desenho: o opt-out **sobrevive sem PII**. `identifierHash`
guarda o SHA-256 do telefone normalizado, então uma importação futura do mesmo
número ainda encontra a manifestação anterior sem que o telefone esteja
armazenado. Isso exige mudança de schema — `opt_out_history.contactId` passa a
aceitar NULL e a FK vira SET NULL —, que é justamente o que o `RESTRICT` atual
impede. É a única alteração estrutural realmente obrigatória da proposta.

`whatsapp_messages` **não** são apagadas: pertencem à conversa, não ao contato, e
apagá-las destruiria o histórico de atendimento de outros operadores. Se a
exigência legal alcançar o conteúdo das mensagens, é outro escopo — diga e eu
desenho separado.

**Assimetria de reversibilidade:** `soft` é reversível; `purge` não é. O
`identifierHash` do passo 1 precisa ser preenchido no momento do opt-out, por
código de aplicação (o SQLite não tem SHA-256 nativo). Para linhas históricas há
backfill de aplicação; enquanto não rodar, `identifierHash` fica NULL e o opt-out
purgado não é recuperável por número. Está anotado no SQL.

### Transacionalidade nos dois bancos

- **Supabase:** função PL/pgSQL, atômica por natureza, `SECURITY DEFINER`,
  `SET search_path = public`, `GRANT EXECUTE ... TO service_role` — mesmo padrão
  de `chatpro_resolve_contact_identity` em
  `supabase/migrations/20260723000100_contact_identity_atomic.sql`.
- **SQLite:** não há RPC. O equivalente é `this.db.transaction(...)` em
  `sqlite-domain.repository.ts`, com a mesma ordem de passos e o mesmo retorno.
  O arquivo SQL entrega apenas as mudanças de schema do lado SQLite.

Retorno em ambos: JSON com `mode` e as contagens por objeto afetado, para a API
relatar o que aconteceu em vez de um 204 mudo.

## 4. SQL proposto

`docs/migrations-propostas-contatos.sql`, com as três seções — SQLite, Supabase e
rollback. **Não executado.** Os arquivos definitivos, quando aprovados, seriam
`apps/api/migrations/021_*.sql` e `supabase/migrations/<timestamp>_*.sql`; ficam
em `docs/` de propósito, para não serem aplicados por engano pelo runner de
migrations.

## 5. BLOQUEIO — o schema CRM do Supabase não está versionado

**Nenhuma migration pode ser aplicada antes de resolver isto.**

### Evidência

`supabase/migrations/` começa em `002_waha_webhook_store.sql`. Não existe `001`.
As tabelas de CRM nunca são criadas ali — só referenciadas:

```console
$ grep -rln "contacts" supabase/migrations/
supabase/migrations/003_conversations.sql              # FK para contacts
supabase/migrations/013_contact_identity_aliases.sql   # FK para contacts
supabase/migrations/20260723000100_contact_identity_atomic.sql  # INSERT em contacts

$ grep -rln "contact_tags\|opt_out" supabase/migrations/
(vazio)
```

RPCs: o código chama 18 funções `chatpro_*`; `supabase/migrations/` versiona
**uma**.

```console
$ grep -rhno "chatpro_[a-z_]*" supabase/migrations/ | sort -u
chatpro_claim_routing_jobs
```

As 17 sem migration, todas chamadas em `apps/api/src/persistence/supabase-domain.repository.ts`:
`chatpro_add_note`, `chatpro_create_contact`, `chatpro_delete_pipeline`,
`chatpro_delete_stage`, `chatpro_delete_tag`, `chatpro_distribute_conversation`,
`chatpro_initialize_pipeline`, `chatpro_kanban_move`, `chatpro_move_lead`,
`chatpro_prepare_campaign`, `chatpro_record_opt_out`, `chatpro_remove_opt_out`,
`chatpro_resolve_contact_identity`, `chatpro_save_campaign`,
`chatpro_save_settings`, `chatpro_set_lead_tag`, `chatpro_update_contact`.

(`chatpro_resolve_contact_identity` tem `CREATE OR REPLACE` em
`20260723000100_contact_identity_atomic.sql`, mas o cabeçalho do próprio arquivo
diz que é aditivo sobre um estado remoto não versionado.)

### Por que isso bloqueia especificamente esta proposta

Ela precisa alterar `public.opt_out_history` — soltar o NOT NULL de `contact_id` e
trocar a FK para `ON DELETE SET NULL`. Trocar uma FK exige o **nome exato da
constraint**, que só existe no banco remoto. Escrever o `ALTER` às cegas produz
migration que falha na aplicação ou, pior, que apaga a constraint errada.

Também não dá para saber, sem o dump: se `public.contacts` já tem alguma coluna de
bloqueio; se `opt_out_history` no Supabase usa RESTRICT como no SQLite; quais RLS
e grants as tabelas novas precisam espelhar.

### O que você precisa extrair — exatamente

Preferível, se a CLI estiver linkada ao projeto:

```bash
supabase db dump --schema public --file supabase/schema-remoto.sql   # estrutura
supabase migration list                                              # local x remoto
```

Sem CLI, rode no SQL Editor do painel e salve cada saída:

**a) Colunas das tabelas de CRM**

```sql
SELECT table_name, ordinal_position, column_name, data_type,
       is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('contacts','tags','contact_tags','opt_out_history',
       'templates','pipelines','stages','leads','lead_tags','lead_notes',
       'activities','campaigns','campaign_recipients','workspace_settings',
       'contact_identifiers','pending_contact_identities')
 ORDER BY table_name, ordinal_position;
```

**b) Constraints e regras de FK — o item mais crítico**

```sql
SELECT c.conname AS constraint_name,
       c.contype,
       rel.relname AS table_name,
       pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
 WHERE n.nspname = 'public'
   AND rel.relname IN ('contacts','opt_out_history','contact_tags',
       'campaign_recipients','contact_identifiers','conversations','leads')
 ORDER BY rel.relname, c.conname;
```

Preciso, daqui: o nome da FK de `opt_out_history` para `contacts`, o `ON DELETE`
de cada FK, e o nome da constraint única de `(workspace_id, phone_number)` de
`contacts` — a RPC de identidade já referencia
`contacts_workspace_id_phone_number_key` por nome.

**c) Definição das 17 RPCs**

```sql
SELECT p.proname, pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname LIKE 'chatpro\_%'
 ORDER BY p.proname;
```

**d) RLS e políticas**

```sql
SELECT relname, relrowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY relname;

SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
  FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
```

**e) Grants**

```sql
SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee IN ('service_role','authenticated','anon')
 ORDER BY table_name, grantee, privilege_type;
```

**f) Índices**

```sql
SELECT tablename, indexname, indexdef
  FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;
```

Com isso em mãos, a sequência sã é: (1) commitar o dump como migration de
baseline reconciliando `supabase/migrations/` com o remoto; (2) só então revisar o
SQL proposto contra o schema real; (3) aplicar em branch do Supabase antes de
produção.

## Resumo dos pontos em aberto

| # | Pendência | Quem decide |
|---|---|---|
| 1 | `POST /api/contacts/block` existe nesta build/tier CORE? | teste manual da seção 1 |
| 2 | Dump do schema CRM do Supabase | você — bloqueia qualquer migration |
| 3 | Campanha deve excluir bloqueados, além de opt-out? | produto |
| 4 | Soft delete ressuscita contato ao receber mensagem nova? | produto |
| 5 | A purga LGPD alcança o conteúdo das mensagens? | jurídico |
