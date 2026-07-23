# Auditoria da camada de contatos do OpenWA para adaptação no ChatPro

Data da auditoria: 2026-07-23

## Implementação de identidade atômica (2026-07-23)

Implementado `whatsapp-identifier.ts` como fronteira central de JID e uma RPC
Supabase transacional (`20260723000100_contact_identity_atomic.sql`). Os padrões
foram reimplementados a partir de `wa-id.ts`, `lid-mapping-store.service.ts`,
`baileys-session-store.ts` e `whatsapp-web-js.adapter.ts` do commit OpenWA
`c7e0ff3248ef7176d006e2ff59ad9710ff0759f1`; não há cópia de código.

## Resumo executivo

O OpenWA não possui uma entidade persistida de contato equivalente a `contacts` do ChatPro. A lista de contatos e a lista de chats são projeções do estado do engine WhatsApp ativo. A parte realmente reutilizável como padrão arquitetural é a fronteira de identidade: ela classifica JIDs, converte `@s.whatsapp.net` para o dialeto neutro `@c.us`, preserva um `@lid` não resolvido como estado válido e mantém uma ponte persistida `lid → telefone`.

O ChatPro já tem a base de domínio mais adequada ao produto: `contacts` é a entidade canônica, o telefone normalizado é único no workspace, aliases ficam em `contact_identifiers`, identidades sem telefone ficam em `pending_contact_identities`, grupos permanecem em `@g.us` e o participante é armazenado como autor da mensagem, não como conversa privada. Isso deve permanecer.

A adaptação recomendada não é copiar a camada de contatos do OpenWA. É incorporar quatro padrões:

1. um parser/normalizador de identificadores na fronteira do transporte;
2. `@lid` não resolvido como estado explícito, nunca como telefone;
3. persistência de todas as observações de alias;
4. constraints e operações atômicas como árbitro final de deduplicação.

As lacunas críticas do ChatPro estão no caminho Supabase:

- `SupabaseContactIdentityResolver` resolve contato, cria contato, grava aliases e remove pendências por várias chamadas PostgREST independentes; portanto, não atende à atomicidade exigida;
- `SupabaseWhatsAppIdentityStore.reconcile` atualiza mensagens, exclui conversas duplicadas e atualiza a conversa primária sem transação;
- `SupabaseWahaWebhookStore.ingest` grava evento, mensagem e conversa em etapas independentes. Uma falha depois do evento pode fazer o retry ser tratado como duplicado antes de completar a ingestão;
- a migration Supabase `013_contact_identity_aliases.sql` usa `text` para `id` e `contact_id`, enquanto o contrato público trata `contactId` como UUID e outras colunas de vínculo já usam UUID. Essa divergência é compatível com a FK inválida relatada e a migration não deve ser aplicada novamente sem inspeção e correção de tipos;
- a busca de contatos no adapter Supabase carrega todos os contatos, pagina em memória e ignora o parâmetro `search`; a versão SQLite busca por nome, telefone e e-mail, mas não por aliases.

Prioridade: começar apenas com backup e testes de caracterização. Depois, criar uma RPC transacional no Supabase e uma operação equivalente no SQLite para resolver telefone e aliases de forma atômica. Webhook, mensagens, realtime e frontend devem permanecer inalterados até essa base estar coberta por testes.

### Estado de preflight

- ChatPro:
  - branch: `feat/replace-repository-with-chatpro`;
  - commit: `61d875fff633965ad50e4c2f2c8857cf5317a55d`;
  - relação com o remoto: 14 commits à frente de `origin/feat/replace-repository-with-chatpro`;
  - `git status --short`: sem arquivos alterados antes desta auditoria.
- A pasta `C:\Projeto Salo\ChatPro\OpenWA-reference` não existia e foi clonada conforme solicitado.
- Nenhuma alteração local do ChatPro foi limpa, descartada ou sobrescrita.
- O banco SQLite local foi aberto em modo somente leitura apenas para conferir o DDL e as migrations aplicadas.
- Nenhum banco remoto foi consultado ou alterado.

## Commit do OpenWA analisado

- Repositório: `https://github.com/rmyndharis/OpenWA`
- Branch: `main`
- Commit analisado: `c7e0ff3248ef7176d006e2ff59ad9710ff0759f1`
- Data do commit: `2026-07-23T20:50:28+07:00`
- Assunto: `chore(release): v0.10.8`
- `origin/HEAD` conferido por `git ls-remote` no início da auditoria: o mesmo SHA.

Todos os apontamentos sobre OpenWA neste documento referem-se exclusivamente a esse commit.

## Licença e atribuição

O arquivo `OpenWA-reference/LICENSE` declara licença MIT e:

> Copyright (c) 2026 Yudhi Armyndharis and OpenWA Contributors

A licença permite uso, cópia, modificação e redistribuição, mas exige que o aviso de copyright e o texto de permissão sejam incluídos em cópias ou porções substanciais do software.

Regras para uma implementação futura:

- preferir reimplementar os padrões arquiteturais no estilo do ChatPro, sem copiar código literal;
- registrar neste documento/ADR o repositório, o commit analisado e os arquivos de referência;
- se qualquer função ou trecho substancial for copiado/adaptado, incluir o aviso MIT do OpenWA no inventário de terceiros do ChatPro e manter um comentário de proveniência no arquivo adaptado;
- não sugerir que a licença MIT transfere suporte, garantia ou responsabilidade dos autores;
- não copiar o dashboard do OpenWA.

## Arquitetura de contatos do OpenWA

### 1. Não existe contato canônico persistido

`src/engine/interfaces/whatsapp-engine.interface.ts:162-170` define apenas a interface de transporte `Contact`. `src/modules/contact/contact.service.ts:22-35` delega listagem e leitura ao engine ativo; não há repository nem entity de contato. `src/modules/contact/contact.controller.ts` oferece endpoints de listagem, consulta por ID, verificação de número, resolução de telefone, foto e bloqueio, mas não cria uma identidade de domínio.

No engine Baileys, `src/engine/adapters/baileys-session-store.ts:12-21` mantém contatos e chats em `Map`s por sessão e em memória. Os eventos `contacts.upsert`, `contacts.update`, `chats.upsert`, `chats.update` e `messaging-history.set` alimentam esses mapas em `src/engine/adapters/baileys.adapter.ts:300-348`. No whatsapp-web.js, `src/engine/adapters/whatsapp-web-js.adapter.ts:1518-1552` consulta o próprio client.

Consequência: o OpenWA não oferece um `contactId` estável e independente do WhatsApp. O ID funcional do contato é o JID emitido pelo engine.

### 2. Fronteira neutra de identificadores

`src/engine/identity/wa-id.ts:1-24` documenta o dialeto neutro:

- `<telefone>@c.us`: usuário com telefone conhecido;
- `<id>@g.us`: grupo;
- `<lid>@lid`: usuário conhecido apenas pelo identificador de privacidade;
- IDs especiais para status, newsletter e broadcast;
- nunca emitir `@s.whatsapp.net` nem sufixo de dispositivo.

`parseWaId` classifica o domínio e remove `:device`; `toNeutralJid`:

- converte `@s.whatsapp.net` e `@c.us` em `<userPart>@c.us`;
- mantém grupo como `@g.us`;
- converte `@lid` para `@c.us` somente quando um resolvedor retorna telefone;
- mantém `<lid>@lid` quando a resolução falha.

Isso é uma camada anticorrupção entre engine e aplicação. O ChatPro deve adaptar esse conceito para WAHA, sem importar dependências do OpenWA.

Limite importante: `userPart` apenas extrai o componente local. O OpenWA não valida E.164 nem comprimento do telefone nessa função. A validação de 8 a 15 dígitos do ChatPro deve permanecer.

### 3. Persistência `lid → telefone`

`src/engine/identity/lid-mapping.entity.ts` define `lid_mappings`:

- `lid`: chave primária, sem domínio e sem sufixo de dispositivo;
- `phone`: dígitos ou `null`;
- `sessionId`: proveniência, sem FK;
- `updatedAt`;
- índice reverso por `phone`.

`src/engine/identity/lid-mapping-store.service.ts` carrega a tabela em memória, mantém mapas nos dois sentidos e usa `repo.upsert(..., ['lid'])`. A migration `src/database/migrations/1781200000000-AddLidMappings.ts` cria a mesma estrutura para PostgreSQL e SQLite.

O escopo é global entre sessões, e a política é “última observação vence”. O dado é tratado como cache corrigível pelo WhatsApp, não como entidade CRM.

Esse modelo evita dois mapeamentos simultâneos para o mesmo LID, mas não garante que dois LIDs ou dois telefones não apontem para contatos duplicados, pois o OpenWA não tem entidade canônica de contato.

### 4. Fontes de resolução

No Baileys:

- registros de contato podem carregar `lid` e `phoneNumber`;
- `messaging-history.set` pode trazer `lidPnMappings`;
- `lid-mapping.update` entrega pares novos;
- chaves de mensagem podem trazer os pares `remoteJid/remoteJidAlt` e `participant/participantAlt`.

`src/engine/adapters/baileys-session-store.ts:42-112` captura todas essas fontes antes de normalizar a mensagem. A resolução usa primeiro o mapa da sessão, depois `contact.phoneNumber` e por fim o cache persistido (`:242-273`).

No whatsapp-web.js:

- `resolveContactPhone` usa `getContactLidAndPhone` em `src/engine/adapters/whatsapp-web-js.adapter.ts:1570-1583`;
- o envio a um `@c.us` pode ser resolvido para `@lid`, armazenado em cache e persistido em `lid_mappings` (`:1389-1429`);
- erro `No LID for user` invalida o cache e tenta uma nova resolução uma única vez (`:1437-1460`).

Esse padrão de “ID canônico de leitura” separado do “ID de entrega” corresponde à intenção atual de `canonicalChatId` e `deliveryChatId` do ChatPro.

### 5. Contato, chat e mensagem são conceitos separados

- `Contact` é uma projeção do catálogo do engine.
- `ChatSummary` é uma projeção do chat, com `id`, `name`, `kind`, `isGroup`, não lidas e última atividade (`src/engine/interfaces/whatsapp-engine.interface.ts:338-352`).
- `IncomingMessage.chatId` é a conversa; `author` é o remetente real dentro do grupo (`:68-108`).

O OpenWA não persiste uma entidade “conversation”. A reconexão recompõe contatos e chats pelo engine e usa `lid_mappings` para tentar produzir o mesmo JID neutro.

Limite: `BaileysSessionStore.listContacts()` e `listChats()` mapeiam cada registro bruto, mas não fazem uma redução final por JID neutro. Se o engine mantiver simultaneamente registros `@lid` e phone-JID para a mesma pessoa, a API pode devolver duas entradas que normalizam para o mesmo ID. Portanto, essa parte não deve ser copiada como mecanismo de deduplicação do ChatPro.

### 6. Grupos e participantes

`src/engine/adapters/baileys-message-mapper.ts:161-202` mantém `remoteJid` como `chatId`; para grupo, `participant` vira `author`. `src/engine/adapters/message-mapper.ts:75-114` faz o equivalente no whatsapp-web.js.

`src/engine/interfaces/whatsapp-engine.interface.ts:422-442` representa eventos de grupo com:

- `groupId`;
- `actorId`;
- `participantIds`;
- alterações de metadados.

`src/engine/adapters/baileys.adapter.ts:1383-1415` emite participantes como dados do evento. `src/modules/session/session.service.ts:1525-1555` encaminha o evento sem criar contato, chat privado ou registro de conversa.

Resposta às perguntas de grupo:

- o fluxo de grupo não persiste participante em uma tabela canônica de contatos;
- o participante pode aparecer no catálogo do engine se o próprio WhatsApp o sincronizar, mas o handler de grupo não cria um contato;
- participante não cria conversa privada automaticamente;
- grupo fica em `chatId/from`; autor fica em `author`.

### 7. Concorrência e idempotência

Mensagens:

- `messages` possui índice único `(sessionId, waMessageId)` em `src/modules/message/entities/message.entity.ts:34-40`;
- a migration `src/database/migrations/1781300000000-AddMessagesWaMessageIdUnique.ts` remove duplicatas antigas e cria a constraint;
- o live path usa `insert`, captura violação única e só dispara webhook/WebSocket uma vez (`src/modules/session/session.service.ts:937-990`);
- history usa pré-consulta mais `INSERT ... orIgnore`, preservando a constraint como árbitro final (`:671-725`);
- `onMessage` trata entrada; `onMessageCreate` ignora entrada e trata apenas saída, evitando dupla emissão (`:1001-1120`).

Webhooks:

- `src/modules/webhook/utils/idempotency.util.ts` gera chave estável por sessão e message ID para `message.received`/`message.sent`;
- `src/modules/webhook/webhook.service.ts:293-320` gera uma ocorrência e reutiliza a chave em retries.

Contatos:

- não existe criação concorrente de contato canônico;
- `lid_mappings.lid` como PK e `upsert` evitam duas linhas do mesmo LID;
- o cache em memória é atualizado antes da persistência e a falha de banco é apenas registrada. Logo, não há atomicidade entre memória e banco, nem entre mapping e qualquer contato.

### 8. Pesquisa e paginação

- `GET /sessions/:sessionId/contacts` aplica `limit/offset` após o engine devolver o conjunto completo (`src/modules/contact/contact.service.ts:22-27` e `src/common/utils/paginate.ts`).
- Não há busca server-side de contato por nome, telefone ou alias.
- O dashboard filtra chats por `name` ou `id` no cliente em `dashboard/src/pages/Chats.tsx:919-931`.
- A busca global do OpenWA é busca de mensagens, não de contatos; usa FTS em `messages`, conforme `src/database/migrations/1782400000000-AddMessagesFts.ts`.

## Arquitetura atual do ChatPro

### 1. Contato canônico

`web/apps/api/migrations/001_initial_persistence.sql:8-20` define:

- PK composta `(workspaceId, id)`;
- `phoneNumber` obrigatório;
- `UNIQUE(workspaceId, phoneNumber)`.

A versão SQLite inspecionada localmente confirma esse DDL. Esse é o modelo correto para o requisito “sem telefone, permanece pendente”: não é necessário criar contato incompleto.

### 2. Aliases e pendências

`web/apps/api/migrations/020_contact_identity_aliases.sql` e `web/supabase/migrations/013_contact_identity_aliases.sql` adicionam:

- `contact_identifiers`, único por `(workspace, identifier)` e com FK para contato;
- `pending_contact_identities`, único por `(workspace, identifier)` e sem FK para contato.

`web/apps/api/src/services/contact-identity-resolver.service.ts`:

- normaliza telefone para 8–15 dígitos;
- reconhece telefone cru e `@c.us`, mas não interpreta o número de um `@lid` como telefone;
- procura primeiro por telefone, depois por alias;
- cria contato apenas quando há telefone;
- persiste aliases e apaga as pendências;
- mantém sem telefone em `pending_contact_identities`.

No SQLite, tudo ocorre dentro de `better-sqlite3.transaction`. No Supabase, cada etapa é uma requisição independente.

### 3. Identidade de transporte

`web/apps/api/src/services/whatsapp-identity-sync.service.ts` mantém `whatsapp_identities` por `(workspace, sessão, whatsappId)`, incluindo `canonicalWhatsappId`, telefone e dados de apresentação.

`web/apps/worker/src/waha-client.ts:59-70` é o adapter WAHA atual:

- consulta contato e foto;
- para `@lid`, consulta `/lids/:id`;
- escolhe `lid.pn` como canônico quando disponível;
- mantém metadados de grupo e participantes separados.

`whatsapp_identities` é útil como observação/cache de transporte e como read model para o Inbox. Não deve continuar sendo a autoridade de unicidade do contato.

### 4. Conversas e grupos

`web/apps/api/src/services/conversation-identity.ts` determina a conversa somente pelo `chatId` aceito:

- `@g.us` → grupo;
- `@c.us` ou `@lid` → direto;
- status, broadcast, newsletter e mensagens técnicas → ignorados;
- `participant`, `from`, `to` e `remoteJid` não substituem um `chatId` de grupo.

`web/apps/api/src/services/waha-webhook.service.ts:115-123`:

- normaliza um evento em mensagem;
- usa `chatId` como identidade da conversa;
- grava participante de grupo em `senderWhatsappId`;
- não promove participante a conversa.

Os testes `web/apps/api/test/conversation-identity.test.ts` e `web/apps/api/test/waha-webhook.test.ts` cobrem grupo, aliases, eventos `message/message.any`, envio concorrente e participante `@lid`.

### 5. Deduplicação atual

`web/apps/api/migrations/002_waha_webhook_store.sql` e a versão Supabase definem:

- evento único por `(workspace, sessão, externalEventId)`;
- mensagem única por `(workspace, sessão, externalMessageId)`;
- FK da mensagem para o evento.

O SQLite ingere evento, mensagem e conversa em uma transação. O Supabase executa as etapas separadamente. `message` e `message.any` com IDs de evento diferentes e o mesmo message ID preservam dois eventos e uma mensagem, mas o código ainda atualiza a conversa depois da colisão de mensagem.

### 6. Vínculo conversa → contato

`conversations.contactId/contact_id` é anulável e usa FK `ON DELETE SET NULL`. O caminho direto tenta resolver contato antes de preencher o vínculo.

Pontos positivos:

- grupo não tenta resolver contato;
- contato sem telefone não é criado;
- FK fica nula quando não há contato confirmado.

Pontos frágeis:

- no Supabase, resolver contato e atualizar conversa não é atômico;
- a reconciliação de alias atualiza `whatsapp_messages.chat_id`, apaga conversas duplicadas e altera a conversa primária em chamadas separadas;
- `COALESCE` impede sobrescrever um `contact_id` já preenchido, inclusive quando um vínculo antigo estiver incorreto;
- ainda não existe constraint parcial que imponha uma única conversa direta por contato confirmado e sessão.

### 7. Busca atual

- SQLite: `web/apps/api/src/persistence/sqlite-domain.repository.ts:26` busca contatos por nome, telefone e e-mail, com paginação.
- Supabase: `web/apps/api/src/persistence/supabase-domain.repository.ts:26-32` carrega todos os contatos, pagina em memória e ignora `search`.
- Nenhum dos adapters consulta `contact_identifiers` para busca por `@lid`, `@c.us` ou futuro alias.
- Inbox: `listConversations` aceita `search`; a cobertura difere entre SQLite e Supabase.

### 8. Contratos consumidos pelo frontend

Os contratos que não podem quebrar estão em:

- `web/packages/contracts/src/index.ts:65-88`;
- `web/apps/dashboard/src/api/inbox.ts:5-20`;
- `web/apps/dashboard/src/api/domain.ts`;
- `web/apps/dashboard/src/ui/Inbox.tsx`;
- `web/apps/dashboard/src/ui/App.tsx`.

Campos essenciais de conversa: `id`, `whatsappSessionId`, `chatId`, `contactId`, `conversationType`, estado operacional, última mensagem, não lidas e `identity`. Mensagens de grupo usam `senderWhatsappId`.

O frontend não precisa conhecer `@s.whatsapp.net`, a origem OpenWA, tabelas de aliases, resolução de LID ou detalhes da RPC.

## Comparação arquivo por arquivo

| Componente | Como funciona no OpenWA | Como funciona no ChatPro | Diferença | Padrão recomendado | Arquivo OpenWA de referência | Arquivo ChatPro impactado | Risco | Necessita migration? | Necessita adaptação de API? |
|---|---|---|---|---|---|---|---|---|---|
| Identidade canônica | JID neutro é a identidade funcional; não há contato persistido | `contacts.id` é a entidade de domínio e telefone é único | ChatPro possui identidade CRM estável | Manter `contacts`; usar JID apenas como alias/endereço | `src/engine/identity/wa-id.ts` | `web/apps/api/src/services/contact-identity-resolver.service.ts` | Baixo | Não para o conceito; sim para corrigir constraints | Não |
| Parser de JID | Classifica user, group, lid e especiais e remove device suffix | Regras espalhadas em regex/sufixos | ChatPro não tem valor neutro tipado único | Criar módulo puro `WhatsAppIdentifier` no adapter WAHA | `src/engine/identity/wa-id.ts` | `web/apps/api/src/services/conversation-identity.ts`; `web/apps/worker/src/waha-client.ts` | Médio | Não | Não |
| `@s.whatsapp.net` | Converge para `@c.us` | Não é aceito pelo validador atual | Um alias futuro/raw pode ser descartado | Normalizar na fronteira, persistindo o alias observado | `src/engine/identity/wa-id.ts:28-100` | `web/apps/api/src/services/contact-identity-resolver.service.ts` | Médio | Talvez, para backfill | Não |
| `@lid` sem telefone | Estado de primeira classe; permanece `@lid` | Vai para pendência e conversa direta pode existir sem contato | Conceitos são compatíveis | Preservar pendência; nunca derivar telefone dos dígitos do LID | `src/engine/interfaces/whatsapp-engine.interface.ts:1-15` | `web/apps/api/src/services/contact-identity-resolver.service.ts` | Baixo | Não | Não |
| Mapping LID/telefone | Tabela global por LID, upsert e cache em memória | `whatsapp_identities` por sessão + `contact_identifiers` no workspace | Autoridade duplicada e não atômica | `contact_identifiers` como autoridade; `whatsapp_identities` como observação/cache | `src/engine/identity/lid-mapping.entity.ts`; `lid-mapping-store.service.ts` | `web/apps/api/src/services/whatsapp-identity-sync.service.ts` | Alto | Sim | Não |
| Criação de contato | Não existe | Cria somente quando há telefone | ChatPro é mais completo | Manter regra; tornar operação Supabase uma RPC transacional | N/A; ausência confirmada em `src/modules/contact` | `web/apps/api/src/services/contact-identity-resolver.service.ts` | Alto | RPC/migration | Não |
| Duplicação de contato | Mapa evita duplicar chave bruta, mas lista não reduz por chave neutra | Unique de telefone e alias; Supabase tem janela de corrida | Constraint do ChatPro é melhor, execução remota é pior | Constraint + lock/RPC + reselect após conflito | `src/engine/adapters/baileys-session-store.ts:200-210` | resolver e migration 013/020 | Alto | Sim | Não |
| Contato versus chat | Tipos separados, ambos engine-backed | Contato de domínio, conversa persistida e identidade de transporte | ChatPro precisa preservar três níveis | `contacts` ≠ `contact_identifiers` ≠ `conversations` | `whatsapp-engine.interface.ts:162-195,338-352` | `waha-webhook.service.ts`; `whatsapp-identity-sync.service.ts` | Médio | Sim, constraints/vínculos | Não |
| ID canônico versus entrega | JID neutro para leitura; adapter resolve ID aceito no envio | `canonicalChatId` e `deliveryChatId` | Intenção igual, reconciliação não atômica | Manter separação; adapter escolhe entrega, domínio escolhe contato | `whatsapp-web-js.adapter.ts:1389-1460` | `internal-inbox.service.ts`; `whatsapp-identity-sync.service.ts` | Alto | Talvez | Não |
| Grupo e autor | `chatId/from` é grupo; `author` é participante | `chatId` é grupo; `senderWhatsappId` é participante | Equivalentes | Preservar integralmente | `baileys-message-mapper.ts:161-202` | `conversation-identity.ts`; `waha-webhook.service.ts` | Baixo | FK opcional futura para autor confirmado | Não |
| Dedup de mensagem | Unique `(sessionId, waMessageId)` é árbitro atômico | PK `(workspace, sessão, externalMessageId)` | Equivalentes no DDL; fluxo Supabase não é transacional | Retornar `inserted` da RPC e só aplicar efeitos uma vez | `1781300000000-AddMessagesWaMessageIdUnique.ts` | `waha-webhook.service.ts`; migration 002 | Alto | RPC recomendada | Não |
| Webhook duplicado | Chave idempotente por sessão/message ID para o receptor | Evento e mensagem possuem chaves distintas no banco | OpenWA protege entrega; ChatPro protege ingestão | Manter PKs e testar `message`/`message.any` concorrentes | `webhook/utils/idempotency.util.ts` | `waha-webhook.service.ts`; `waha-webhook.test.ts` | Médio | Não necessariamente | Não |
| Transação | TypeORM usa upsert/insert e transactions de migration; contato não é agregado | SQLite é transacional; Supabase usa múltiplas chamadas | Principal gap do ChatPro | RPC PL/pgSQL para resolver/reconciliar; transação SQLite equivalente | `lid-mapping-store.service.ts`; `session.service.ts` | resolver, identity store e webhook store Supabase | Alto | Sim | Não |
| Busca de contato | Apenas listagem paginada em memória; sem busca server-side | SQLite busca nome/telefone/e-mail; Supabase ignora `search` | ChatPro tem contrato melhor, implementação inconsistente | Busca server-side por contato + aliases, mesma resposta atual | `contact.service.ts`; `paginate.ts` | repositories de domínio SQLite/Supabase | Médio | Índices | Não; preservar query atual |
| Frontend | Dashboard próprio usa chats e resolução de telefone | Dashboard consome contratos `@chatpro/contracts` | UIs e conceitos diferentes | Não copiar UI; manter DTO atual e resolver no backend | `dashboard/src/pages/Chats.tsx` | contracts, `api/inbox.ts`, `ui/Inbox.tsx` | Alto se alterado | Não | Não |

## Problemas que a adaptação resolveria

1. Duas criações simultâneas do mesmo telefone no Supabase.
2. Um mesmo alias associado silenciosamente a contatos diferentes.
3. Contato criado sem todos os aliases ou aliases criados sem o contato correspondente.
4. FK de `contact_identifiers` com tipo incompatível.
5. Reconciliação parcial que atualiza mensagens, mas falha antes de concluir conversas.
6. Retry de webhook interrompido por um evento já gravado, embora a mensagem/conversa anterior tenha falhado.
7. `@s.whatsapp.net` ou novos domínios escapando das regras atuais.
8. Busca Supabase que ignora `search`.
9. Busca incapaz de localizar contato por `@lid` ou outro alias.
10. Risco de duas conversas diretas confirmadas para o mesmo contato/sessão.
11. Preenchimento de `senderContactId` antes de confirmar o contato.

Já resolvido e a preservar:

- participante de grupo não cria conversa privada;
- `@g.us` permanece a identidade da conversa;
- autor do grupo é armazenado separadamente;
- eventos `message` e `message.any` não duplicam a linha de mensagem;
- frontend, Inbox e realtime estão operacionais;
- casos sem telefone ficam pendentes.

## Partes que não devem ser copiadas

- `ContactController` e decorators NestJS: o ChatPro usa Express/controllers próprios.
- `Repository`/entities TypeORM: o ChatPro usa Supabase/PostgREST e better-sqlite3.
- engines Baileys/whatsapp-web.js: WAHA continua sendo o transporte.
- cache global `lid_mappings` como única fonte de verdade: ele não referencia contato e usa last-write-wins.
- listagem de contatos/chats por `Map` sem redução final por identidade canônica.
- contratos e componentes do dashboard OpenWA.
- paginação feita depois de buscar todos os contatos.
- lógica de envio específica `No LID for user`; no ChatPro, erros e endpoints são do WAHA.
- FTS de mensagens como solução para busca de contatos.
- qualquer trecho literal sem aviso MIT e registro de origem.

## Modelo de dados recomendado

### Invariantes

1. `contacts` só existe quando um telefone normalizado foi confirmado.
2. `contacts.phone_number` permanece `NOT NULL`.
3. `UNIQUE(workspace_id, phone_number)` impede dois contatos para o mesmo telefone.
4. Todo identificador observado é normalizado e persistido.
5. `UNIQUE(workspace_id, normalized_identifier)` impede um alias em dois contatos.
6. `@lid` nunca é interpretado como telefone.
7. Um alias sem telefone vai para pendência e não recebe `contact_id`.
8. Resolução de contato e inserção de todos os aliases acontecem na mesma transação.
9. Grupo nunca referencia `contacts` como a identidade da conversa.
10. Participante de grupo pode receber `sender_contact_id` apenas depois de resolução confirmada; isso não cria conversa direta.
11. `delivery_chat_id` é endereço de transporte; não é chave de contato.
12. Nenhuma FK é inserida com ID gerado antes de o contato ser confirmado/reselecionado no banco.

### Tabelas

#### `contacts` — manter

Campos atuais permanecem. Confirmar que `id` é UUID no Supabase e texto contendo UUID no SQLite. Não tornar telefone anulável.

#### `contact_identifiers` — corrigir e ampliar

Proposta lógica:

```text
id uuid
workspace_id text
contact_id uuid
provider text default 'whatsapp'
identifier text
normalized_identifier text
kind text  -- phone | user_jid | lid | future
source text
first_seen_at timestamptz
last_seen_at timestamptz
last_seen_session text nullable  -- proveniência, não FK/escopo de unicidade
is_canonical boolean
```

Constraints:

- PK compatível com o tipo de `contacts.id`;
- FK composta `(workspace_id, contact_id) → contacts(workspace_id, id)`;
- unique `(workspace_id, provider, normalized_identifier)`;
- índice `(workspace_id, contact_id)`;
- índice de busca por `normalized_identifier`;
- checks para `kind`, sem restringir os domínios futuros a uma lista fechada.

Aliases mínimos ao resolver telefone:

- telefone cru normalizado;
- `<telefone>@c.us`;
- todo alias observado (`@lid`, `@s.whatsapp.net` ou futuro);
- não fabricar `@lid`.

#### `pending_contact_identities` — manter sem FK

Ampliar com:

- `first_seen_at`, `last_seen_at`;
- `attempt_count`, `next_retry_at`;
- `last_error_code_safe`;
- `last_seen_session`;
- payload mínimo de evidência, sem credenciais.

Quando houver telefone, a RPC deve mover todos os aliases compatíveis para `contact_identifiers` e remover as pendências na mesma transação.

#### `whatsapp_identities` — manter temporariamente como adapter/read model

Funções que permanecem:

- metadados de perfil por sessão;
- observação `whatsappId → canonicalWhatsappId`;
- dados para `ConversationIdentity` do Inbox.

Mudança de autoridade:

- não decidir unicidade de contato;
- opcionalmente receber `contact_id` confirmado;
- alimentar o resolvedor transacional;
- futuramente ser renomeada/conceituada como `whatsapp_identity_observations`.

#### `conversations` — manter contrato, reforçar vínculo

- `id` permanece estável e é a chave apresentada ao frontend.
- `chat_id` permanece no DTO atual.
- `canonical_chat_id` e `delivery_chat_id` permanecem internos.
- adicionar unique parcial por `(workspace_id, waha_session, contact_id)` para conversa direta com contato confirmado, depois de saneamento/backfill.
- grupos continuam únicos por `(workspace_id, waha_session, chat_id)`.

Recomendação futura adicional: adicionar `conversation_id` anulável em `whatsapp_messages`, fazer backfill e usar o ID estável nas consultas. Manter `chat_id` por compatibilidade e auditoria. Isso evita reescrever toda a história quando um alias muda.

#### Autor de grupo

Manter `sender_whatsapp_id`. `sender_contact_id`:

- deve ter o mesmo tipo de `contacts.id`;
- deve aceitar `NULL`;
- deve receber FK composta com workspace somente após backfill validado;
- nunca participa da escolha de conversa.

### Operação transacional recomendada

Criar RPC versionada, por exemplo `chatpro_resolve_contact_identity_v1`, com entrada:

```text
workspace_id
phone nullable
observed_identifiers[]
display_name nullable
source
session_id nullable
```

Fluxo dentro de uma única transação PostgreSQL:

1. normalizar/validar a entrada ou rejeitar antes da RPC;
2. adquirir lock transacional estável por workspace + telefone/aliases;
3. buscar e bloquear contatos por telefone e aliases;
4. se aliases conhecidos apontarem para contatos diferentes, não escolher arbitrariamente: registrar conflito para reconciliação;
5. se não houver telefone, upsert em pendências e retornar `pending`;
6. com telefone, inserir contato com `ON CONFLICT` e reselecionar o ID confirmado;
7. inserir todos os aliases com `ON CONFLICT`;
8. remover pendências;
9. retornar `contact_id`, telefone e estado (`created`, `matched`, `pending`, `conflict`).

No SQLite, manter uma operação equivalente dentro de `BEGIN IMMEDIATE`/`better-sqlite3.transaction`, usando as constraints como árbitro final e reselecionando depois de `INSERT OR IGNORE`.

## Plano de compatibilidade com o frontend

Princípio: nenhuma tela ou chamada existente precisa mudar para adotar o resolvedor.

1. Preservar `GET /api/v1/inbox/conversations` e seu `Page<InboxConversation>`.
2. Preservar `GET /api/v1/inbox/conversations/:id/messages`.
3. Preservar `POST /api/v1/inbox/conversations/:id/messages`.
4. Preservar `GET /api/v1/domain/contacts` e os parâmetros `page`, `pageSize`, `search`, `tagId` e `optOut`.
5. Preservar `InboxConversation.chatId`, `contactId`, `conversationType` e `identity`.
6. Preservar `InboxMessage.senderWhatsappId` para autor de grupo.
7. Manter `deliveryChatId` interno ao backend/worker; o frontend envia pelo ID da conversa.
8. Não expor `@s.whatsapp.net`, tabela de aliases, RPC ou nomes OpenWA.
9. Se campos novos forem úteis, adicioná-los como opcionais e apenas depois de testes de contrato; não são necessários para as fases iniciais.
10. Corrigir a busca no repository Supabase sem mudar a assinatura usada por `Contacts`.

Possíveis quebras a evitar:

- mudar `contactId` de UUID para texto arbitrário;
- substituir `chatId` por `contactId` no DTO;
- remover `senderWhatsappId`;
- renomear `identity.phone/displayName/pushName/profileName`;
- fazer o frontend resolver LID;
- retornar duas conversas durante reconciliação;
- alterar ordenação/paginação do Inbox junto com a mudança de identidade.

## Plano de backup e rollback

Nenhum backup foi criado nesta etapa. Antes da implementação:

### Git

1. Exigir working tree limpo ou registrar separadamente toda alteração local do usuário.
2. Criar branch de implementação `codex/contact-identity-adapter`.
3. Criar tag anotada `pre-openwa-contact-adaptation-YYYYMMDD` no último commit validado.
4. Registrar no ADR:
   - SHA do ChatPro;
   - SHA do OpenWA;
   - checksum das migrations propostas;
   - resultado dos testes de caracterização.
5. Não fazer push até revisão explícita.

### Banco Supabase/PostgreSQL

Criar snapshot/PITR e dump lógico consistente de:

- `contacts`, `contact_tags`, `opt_out_history`;
- `contact_identifiers`, `pending_contact_identities`;
- `conversations` e tabelas que referenciam conversa;
- `whatsapp_identities`;
- `whatsapp_groups`, `whatsapp_group_participants`;
- `whatsapp_messages`, `waha_webhook_events`;
- histórico de migrations.

Antes do backup, consultar `pg_catalog` para confirmar tipos reais, PKs, uniques, FKs, índices e migrations efetivamente aplicadas. Não confiar apenas nos arquivos locais.

### SQLite

Usar a API de backup do SQLite com o processo parado ou checkpoint consistente; não copiar apenas `backend.sqlite` enquanto WAL estiver ativo. Incluir:

- `backend.sqlite`;
- WAL/SHM apenas se o procedimento de backup exigir;
- diretório de objetos/mídia referenciado;
- arquivo de migrations/checksums.

Não incluir `.env.local` em commit ou artefato compartilhado.

### Estratégia de rollout

1. migrations aditivas;
2. resolver novo atrás de feature flag;
3. shadow-read: comparar resultado antigo e novo sem alterar vínculo;
4. dual-write temporário somente onde for idempotente;
5. backfill em lotes pequenos, com tabela de auditoria de “antes/depois”;
6. ativar leitura nova;
7. observar métricas;
8. só então retirar legado.

### Rollback

- código: desligar feature flag e retornar à tag;
- dados: manter colunas/tabelas novas durante rollback; não executar `DROP` imediato;
- reconciliação: usar a tabela de auditoria para restaurar `conversation_id/contact_id/chat_id` anteriores;
- se houver perda ou conflito estrutural, restaurar snapshot, não improvisar merge reverso;
- migration destrutiva só depois de uma janela de estabilidade e backup renovado.

## Migrations futuramente necessárias

Ordem proposta, sem aplicar nesta etapa:

1. **Diagnóstico de schema**
   - inventário de tipos reais no Supabase;
   - detectar aplicação parcial da migration 013;
   - detectar aliases órfãos ou apontando para contatos distintos.

2. **Correção de tipos e FK**
   - reconstruir/alterar `contact_identifiers.id` e `contact_id` com tipos compatíveis;
   - criar FK composta para `contacts`;
   - validar a constraint somente depois de limpar órfãos;
   - alinhar `sender_contact_id`.

3. **Normalização e unicidade**
   - adicionar `normalized_identifier`, `provider`, `kind`, timestamps e proveniência;
   - backfill determinístico;
   - criar unique por alias normalizado;
   - confirmar unique de telefone.

4. **Pendências operacionais**
   - adicionar tentativas, próxima execução, erro seguro e sessão de proveniência.

5. **RPC de resolução**
   - criar `chatpro_resolve_contact_identity_v1`;
   - conceder execução apenas ao `service_role`;
   - testes concorrentes e de conflito.

6. **Vínculo de conversa**
   - backfill de `contact_id`;
   - unique parcial de conversa direta por contato/sessão;
   - opcional `whatsapp_messages.conversation_id` com backfill e FK.

7. **Autor confirmado**
   - FK composta de `sender_contact_id`, mantendo `NULL` para não resolvidos.

8. **Busca**
   - índices por telefone e alias;
   - `pg_trgm`/índice apropriado para nome se a extensão estiver disponível;
   - query/RPC paginada e equivalente em SQLite.

9. **Remoção do legado**
   - somente depois de métricas e reconciliação concluídas;
   - nenhuma coluna antiga removida na mesma release que ativa o caminho novo.

## Plano de testes

### Caracterização antes de alterar

- repetir os testes focados executados nesta auditoria;
- congelar snapshots dos DTOs de contatos, conversas e mensagens;
- registrar contagens por telefone, alias, conversa direta, grupo e pendência.

Validação executada nesta auditoria:

```text
npx vitest run apps/api/test/conversation-identity.test.ts apps/api/test/waha-webhook.test.ts
2 arquivos passaram; 32 testes passaram.
```

### Unidade

- parser de `@c.us`, `@s.whatsapp.net`, `@lid`, `@g.us`, `:device`, broadcast, newsletter e domínio futuro;
- telefone normalizado 8–15 dígitos;
- `@lid` nunca produz telefone;
- geração de aliases;
- decisão `direct/group/ignore`.

### Integração SQLite

- duas resoluções concorrentes do mesmo telefone → um contato;
- dois aliases simultâneos do mesmo contato → um contato e todos os aliases;
- mesmo alias com telefones conflitantes → conflito explícito, sem reassociação silenciosa;
- sem telefone → apenas pendência;
- resolução posterior → contato + aliases + remoção de pendência atômicos;
- FK nunca aponta para contato ausente;
- rollback de exceção no meio da transação não deixa linhas parciais.

### Integração Supabase/PostgreSQL

Executar contra banco efêmero:

- 50 chamadas paralelas da RPC para o mesmo telefone;
- chamadas paralelas por `@lid` e `@c.us`;
- falha injetada após criar contato e antes de alias → transação inteira revertida;
- tipos de FK validados no catálogo;
- RLS/grants: somente service role resolve/muta aliases;
- explain de busca por telefone, alias e nome;
- paginação estável.

### Webhook e conversa

- `message` + `message.any` concorrentes com o mesmo message ID;
- IDs de evento diferentes, uma mensagem e uma atualização de conversa;
- retry após falha entre evento e mensagem;
- grupo com vários participantes `@lid` → uma conversa `@g.us`;
- participante nunca aparece em `conversations.chat_id`;
- mensagem direta `@lid` sem telefone → conversa pendente, sem FK;
- resolução posterior → uma conversa canônica, sem perder mensagens, não lidas, status, responsável, Kanban ou contexto;
- envio depois da reconciliação usa `delivery_chat_id` válido.

### Contrato/frontend

- schemas de `@chatpro/contracts`;
- `GET /inbox/conversations`;
- `GET /inbox/conversations/:id/messages`;
- `POST /inbox/conversations/:id/messages`;
- `GET /domain/contacts?search=...`;
- render do Inbox para contato, grupo e pendente;
- busca por nome, telefone, `@c.us` e `@lid`;
- realtime continua emitindo uma vez.

### Dados/rollback

- dry-run de backfill com contagens;
- checksum antes/depois;
- nenhum alias órfão;
- nenhuma conversa direta duplicada por contato;
- restore de snapshot ensaiado;
- desativação da feature flag sem migration down.

## Divisão da implementação em fases pequenas

### Fase 1: backup e testes de caracterização

Escopo:

- criar tag/branch/snapshots;
- consultar schema real do Supabase;
- adicionar apenas testes que reproduzam concorrência, FK, aliases, pendências e contratos;
- nenhuma mudança no fluxo de produção.

Critério de saída:

- backup restaurável;
- baseline verde;
- falhas atuais documentadas e reproduzíveis.

Esta é a primeira fase recomendada.

### Fase 2: modelo canônico e aliases

Escopo:

- corrigir tipos/FK;
- adicionar campos e constraints de aliases;
- backfill em dry-run;
- manter código antigo lendo como antes.

Critério de saída:

- zero órfãos;
- unique de telefone e alias validada;
- nenhuma API alterada.

### Fase 3: resolvedor transacional

Escopo:

- RPC Supabase;
- transação SQLite equivalente;
- estado explícito `resolved/pending/conflict`;
- feature flag e shadow-read.

Critério de saída:

- testes paralelos verdes;
- contato e aliases sempre atômicos.

### Fase 4: webhook e sincronização

Escopo:

- adapter WAHA normaliza identificadores;
- identity sync chama o resolvedor;
- reconciliação transacional;
- manter mensagem/realtime existentes.

Critério de saída:

- `message/message.any` e grupos verdes;
- nenhuma duplicação de conversa/contato;
- nenhum evento parcialmente ingerido.

### Fase 5: APIs de contatos

Escopo:

- usar o novo read model por trás das rotas atuais;
- manter DTOs e paginação;
- não alterar frontend.

Critério de saída:

- testes de contrato sem diff incompatível.

### Fase 6: pesquisa

Escopo:

- busca server-side equivalente em SQLite/Supabase;
- nome, telefone e aliases;
- índices e paginação.

Critério de saída:

- mesma query do frontend;
- plano de execução aceitável;
- sem carregar todos os contatos em memória.

### Fase 7: validação e remoção segura do legado

Escopo:

- desligar dual-write;
- remover apenas código comprovadamente sem leitores;
- manter rollback de dados durante a janela definida.

Critério de saída:

- métricas estáveis;
- auditoria sem duplicatas/órfãos;
- backup renovado;
- aprovação explícita antes de qualquer `DROP`.

## Estimativa de risco por fase

| Fase | Risco | Motivo | Mitigação principal |
|---|---|---|---|
| 1. Backup e caracterização | Baixo | Não altera produção | Snapshot restaurável e testes isolados |
| 2. Modelo e aliases | Alto | Tipos/FKs e backfill podem bloquear ou rejeitar dados | Migration aditiva, catálogo real, dry-run, `NOT VALID`/validação posterior quando aplicável |
| 3. Resolvedor transacional | Médio/alto | Muda autoridade de criação/vínculo | Feature flag, shadow-read, concorrência em banco efêmero |
| 4. Webhook e sincronização | Alto | Caminho crítico recém-restabelecido | Mudanças pequenas, dedup como constraint, canário e rollback por flag |
| 5. APIs de contatos | Médio | Pode quebrar contrato/paginação | Contract tests e DTO sem alteração |
| 6. Pesquisa | Médio | Índices e custo de consulta | `EXPLAIN`, limite, paginação e rollout independente |
| 7. Remoção do legado | Alto | Remoção precoce pode causar perda ou rollback difícil | Janela de estabilidade, backup novo e nenhuma remoção junto da ativação |

## Decisão recomendada

Adotar do OpenWA a fronteira de identidade, não sua implementação de contatos. O desenho final deve ser:

```text
WAHA
  → adapter de identificadores WhatsApp
  → observação de aliases / pendência
  → resolvedor transacional
  → contacts (telefone canônico)
  → conversations (ID estável; chat/delivery como endereços)
  → DTO atual do ChatPro
  → frontend atual
```

O primeiro trabalho de implementação deve ser exclusivamente a Fase 1. Não iniciar pelas migrations nem tocar em webhook, mensagens, grupos, realtime ou Inbox antes de existir baseline concorrente e backup restaurável.
