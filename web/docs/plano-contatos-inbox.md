# Operações de contato no Inbox — levantamento

Escopo: criar, editar, apagar e bloquear/desbloquear contato **a partir do
Inbox**. Este documento é levantamento; nenhuma alteração de comportamento
foi feita com base nele.

Toda referência abaixo é `arquivo:linha` na revisão `db2a02b`.

## Resumo executivo

O backend de contatos já é completo para criar/editar/apagar: existe rota,
método no `DomainRepository` e implementação nos dois provedores. O que **não**
existe é a superfície no Inbox — hoje o CRUD de contato mora numa página CRM
separada (`Contatos`), e `Inbox.tsx` apenas *exibe* identidade, sem nenhuma
mutação.

"Bloquear" **não existe** neste domínio em nenhuma forma. Opt-out não é
bloqueio (seção 2).

---

## 1. Estado atual por operação

Camadas avaliadas: rota HTTP → controller → `DomainService` →
`DomainRepository` → SQLite / Supabase → UI.

### 1.1 Criar contato

| Camada | Status | Evidência |
| --- | --- | --- |
| Rota | existe | `POST /api/v1/domain/contacts` — `apps/api/src/routes/v1.ts:26` |
| Controller | existe | `createContact` — `apps/api/src/controllers/domain.controller.ts:7` |
| Serviço | existe | `apps/api/src/services/domain.service.ts:7` |
| Interface do repositório | existe | `createContact` — `apps/api/src/persistence/domain.repository.ts:8` |
| SQLite | existe | `apps/api/src/persistence/sqlite-domain.repository.ts:28` — valida com `contactInput`, normaliza telefone, valida cada `tagId`, insere contato + `contact_tags` **em transação**, converte violação de unicidade em `409 CONFLICT` |
| Supabase | existe | `apps/api/src/persistence/supabase-domain.repository.ts:35` — delega para a RPC `chatpro_create_contact` |
| RPC Supabase | **não identificado** | A chamada existe no código, mas `chatpro_create_contact` **não está definida em nenhum arquivo do repositório** (`grep` em `supabase/migrations/`, `scripts/`, `docs/` retorna apenas as chamadas do cliente). Ver seção 3.1 |
| UI — página CRM | existe | `apps/dashboard/src/ui/App.tsx:209` (`Novo contato` + modal) |
| UI — Inbox | **não existe** | `Inbox.tsx` não referencia nenhuma mutação de contato; as únicas ocorrências de `contact` são rótulos de exibição (`Inbox.tsx:20,39,824,852,855,946`) |
| Cliente HTTP | existe | `createContact` — `apps/dashboard/src/api/domain.ts:19` |

### 1.2 Editar contato

| Camada | Status | Evidência |
| --- | --- | --- |
| Rota | existe | `PATCH /api/v1/domain/contacts/:contactId` — `v1.ts:26` |
| Controller | existe | `updateContact` — `domain.controller.ts:7` |
| Interface do repositório | existe | `domain.repository.ts:9` |
| SQLite | existe | `sqlite-domain.repository.ts:29` — parcial (`contactInput.partial()`), exige ao menos um campo, revalida tags, substitui `contact_tags` em transação |
| Supabase | existe | `supabase-domain.repository.ts:36` — RPC `chatpro_update_contact` |
| RPC Supabase | **não identificado** | mesma situação de 1.1 |
| UI — página CRM | existe | `App.tsx:209` (botão `Editar` reaproveita o mesmo modal) |
| UI — Inbox | **não existe** | idem 1.1 |

**Defeito observado (edição, ambos os provedores):** o modal de edição em
`App.tsx:209` renderiza as tags com
`<input name="tag" type="checkbox" value={t.id} />` sem `defaultChecked`. Ao
abrir um contato existente e salvar sem tocar nas tags, o formulário envia
`tagIds: []`, e o backend interpreta array vazio como "substituir por
nenhuma" (`sqlite-domain.repository.ts:29`, ramo `if(input.tagIds)`). Ou seja,
**salvar uma edição apaga silenciosamente as tags do contato**. Não é
regressão introduzida por este trabalho; é pré-existente.

### 1.3 Apagar contato

| Camada | Status | Evidência |
| --- | --- | --- |
| Rota | existe | `DELETE /api/v1/domain/contacts/:contactId` — `v1.ts:26` |
| Controller | existe | `deleteContact` (204) — `domain.controller.ts:7` |
| Interface do repositório | existe | `domain.repository.ts:10` |
| SQLite | existe | `sqlite-domain.repository.ts:30` — verifica existência e apaga |
| Supabase | **existe parcial** | `supabase-domain.repository.ts:37` — usa `remove()` (`DELETE` direto na tabela, `supabase-domain.repository.ts:30`), **sem** verificação de existência prévia e **sem** transação |
| RPC de exclusão | **não existe** | confirmado: nenhuma `chatpro_delete_contact` é chamada nem definida |
| UI — página CRM | existe | `App.tsx:209`, dentro do modal (`Actions … remove`), com `confirm('Excluir contato?')` |
| UI — Inbox | **não existe** | idem 1.1 |

**Assimetria relevante (detalhada em 4.2):** apagar contato inexistente
retorna `404` no SQLite e `204` no Supabase. E o efeito colateral em
`conversations.contactId` é garantido por FK apenas no SQLite
(`ON DELETE SET NULL`, `apps/api/migrations/003_conversations.sql:15`); a
existência da FK equivalente no Supabase **não foi identificada**.

### 1.4 Bloquear / desbloquear contato

| Camada | Status | Evidência |
| --- | --- | --- |
| Rota | **não existe** | nenhuma rota de bloqueio em `v1.ts` |
| Controller | **não existe** | — |
| Interface do repositório | **não existe** | `domain.repository.ts` não declara nada de bloqueio |
| SQLite | **não existe** | nenhuma coluna/tabela de bloqueio em `apps/api/migrations/` |
| Supabase | **não existe** | — |
| UI | **não existe** | — |

`grep -i block` em `apps/`, `packages/` e `supabase/` retorna apenas: o status
`'blocked'` de **campanha** (`repositories.ts:19`,
`sqlite-domain.repository.ts:64,69,70`), `scrollIntoView({block:'center'})`
(`Inbox.tsx:734`) e textos de teste não relacionados. Não há conceito de
contato bloqueado.

---

## 2. O que "bloquear" significa aqui — e por que opt-out não é bloqueio

**Opt-out não cobre bloqueio.** São conceitos distintos, e a evidência é o
único ponto do código que *consome* opt-out:

`sqlite-domain.repository.ts:69` (`prepareCampaign`) usa `opt_out_history`
exclusivamente para dividir os destinatários de uma campanha entre
`eligibleRecipients` e `excludedOptOut`, e marcar a campanha como `ready` ou
`blocked`. É o **único** consumidor. Nenhum outro caminho lê `opt_out_history`.

O que isso implica:

1. **Opt-out é consentimento de marketing (saída de campanha), não bloqueio de
   comunicação.** Modela "não quero receber campanhas", que é uma obrigação
   legal/LGPD sobre envio em massa.
2. **Opt-out não tem nenhum efeito no Inbox.** O caminho de envio
   (`POST /inbox/conversations/:conversationId/messages`, `v1.ts:21` →
   `inbox.sendMessage`) não consulta `opt_out_history` em momento algum. Um
   contato com opt-out registrado continua podendo receber e enviar mensagens
   normalmente pelo atendimento.
3. **Opt-out é reversível e historicizado** (`optOut` insere linha,
   `removeOptOut` apaga todas — `sqlite-domain.repository.ts:60,62`), enquanto
   bloqueio, no sentido de WhatsApp, é um estado booleano do contato.

Já **"bloquear contato" no domínio de atendimento WhatsApp** significa
tipicamente uma destas duas coisas — e o produto precisa escolher, porque o
custo e o efeito são bem diferentes:

- **(A) Bloqueio local (ChatPro).** Um estado do contato no ChatPro que
  impede o envio pelo Inbox e/ou esconde/silencia a conversa. Não sai do
  ChatPro; o WhatsApp do cliente não sabe. Custo: coluna nova + regra no
  caminho de envio.
- **(B) Bloqueio no WhatsApp (via WAHA).** Propaga o bloqueio para a conta
  WhatsApp real, de modo que o contato deixa de conseguir enviar mensagens.
  Depende de o provedor WAHA expor o endpoint de bloqueio; **não foi
  identificado** nenhum uso desse recurso no worker atual.

Recomendação: implementar **(A)** primeiro, com nome explícito
(`blocked`/`blockedAt`), mantido separado de opt-out, e tratar (B) como
integração posterior. Misturar os dois no mesmo campo quebraria o relatório de
campanha, que hoje depende de `opt_out_history` significar só consentimento.

**Isto é uma decisão de produto e precisa da sua confirmação** antes de
qualquer implementação — ver seção 5.

---

## 3. O que exige migration nova no Supabase

### 3.1 Achado que antecede tudo: o schema CRM não está versionado

`supabase/migrations/` **não contém** as tabelas `contacts`, `contact_tags`,
`opt_out_history`, `tags`, `templates`, `leads` nem `campaigns`, e **não
contém** nenhuma das RPCs `chatpro_*` de CRM que o código chama
(`chatpro_create_contact`, `chatpro_update_contact`, `chatpro_record_opt_out`,
`chatpro_remove_opt_out`, `chatpro_delete_tag`, `chatpro_save_campaign`,
`chatpro_prepare_campaign`, `chatpro_initialize_pipeline`, …).

As migrations versionadas cobrem só o lado WhatsApp/Inbox. A única função de
contato definida no repositório é `chatpro_resolve_contact_identity`
(`supabase/migrations/20260723000100_contact_identity_atomic.sql:3`).

Não foi possível confirmar o schema remoto real: o projeto Supabase
configurado em `.env.local` (variável `SUPABASE_URL`) não pertence à conta
Supabase acessível por este ambiente, então a introspecção remota não estava
disponível. Status: **não identificado**.

Consequência prática: mesmo o que "já existe" no Supabase existe **fora do
controle de versão**, e qualquer proposta de migration precisa primeiro
confirmar o estado remoto.

### 3.2 Precisa de migration (DDL)

| Item | Motivo |
| --- | --- |
| Coluna de bloqueio em `contacts` (ex.: `blocked_at timestamptz null`) | 1.4: não existe em lugar nenhum. Também exige migration SQLite equivalente |
| RPC `chatpro_delete_contact` | 1.3: exclusão hoje é `DELETE` direto sem checagem nem transação; para paridade com SQLite (404 + limpeza de vínculos atômica) precisa de RPC |
| RPC ou view para o filtro `optOut=false` | 4.1: PostgREST não expressa anti-join (`NOT EXISTS`) numa única consulta de tabela |
| FK `conversations.contact_id → contacts` com `ON DELETE SET NULL` | 1.3: existe no SQLite, **não identificada** no Supabase; sem ela, apagar contato deixa `contact_id` órfão |
| Versionar o schema CRM já existente | 3.1 |

### 3.3 É só código (sem migration)

| Item | Onde |
| --- | --- |
| Filtro de busca de contatos no banco | `supabase-domain.repository.ts:33` — **entregue na PR de correção da busca** |
| Checagem de existência antes de apagar (404) | `supabase-domain.repository.ts:37` |
| Superfície de contato no Inbox (criar/editar/apagar) | `Inbox.tsx` + reuso de `domain.ts:19` |
| Correção do `defaultChecked` das tags no modal | `App.tsx:209` (defeito de 1.2) |
| `optOutContacts` deixar de retornar todos os contatos | `supabase-domain.repository.ts:46` (ver 4.1) |

---

## 4. Assimetrias entre SQLite e Supabase

Estado **atual**, antes de qualquer mudança. O projeto exige paridade, então
cada item é dívida.

### 4.1 Listagem de contatos — a mais grave

`sqlite-domain.repository.ts:26` filtra no banco por `search`, `tagId` e
`optOut`, ordena por `createdAt DESC` e pagina em SQL.

`supabase-domain.repository.ts:33` faz `this.page(await this.rows('contacts', w), q)`:
carrega **todos** os contatos do workspace (`rows()`, linha 27, ordena por
`created_at` **ASC**), e `page()` (linha 31) fatia em memória. Os parâmetros
`search`, `tagId` e `optOut` são **silenciosamente ignorados**.

Quatro divergências decorrentes:

1. **Busca não funciona no Supabase** — digitar no campo "Buscar contatos"
   devolve a lista inteira paginada. Viola a regra 4 do `CLAUDE.md`.
2. **Ordenação invertida** — `DESC` no SQLite, `ASC` no Supabase.
3. **`optOutContacts` retorna todos os contatos no Supabase** —
   `supabase-domain.repository.ts:46` faz `optOutContacts(w,q){return this.contacts(w,q)}`
   sem forçar `optOut:'true'`, ao contrário de `sqlite-domain.repository.ts:63`.
   O card "opt-out" do dashboard (`domain.ts:4`, `optOutContacts`) mostra o
   total de contatos no Supabase e o número correto no SQLite.
4. **Validação de paginação** — SQLite valida com Zod (`page` inteiro
   positivo, `pageSize` ≤ 100) e devolve erro de validação para entrada
   inválida; Supabase usa `Number(...)` cru (linha 31), aceitando `NaN` e
   valores negativos.

A PR de correção da busca resolve (1), (2) e (4). **(3) permanece aberto**,
porque o ramo `optOut=false` precisa de view/RPC (3.2) e migration não está
autorizada.

### 4.2 Exclusão de contato

- Inexistente: SQLite `404 NOT_FOUND` (`this.one` em `sqlite-domain.repository.ts:30`);
  Supabase `204` silencioso (linha 37).
- Vínculos: SQLite tem FK `ON DELETE SET NULL` de `conversations` e cascata de
  `contact_tags`/`contact_identifiers`; no Supabase, **não identificado**.

### 4.3 Validação de entrada

SQLite valida com Zod (`contactInput`, `sqlite-domain.repository.ts:9`):
`displayName` 1–160, `email` formato válido, `tagIds` ≤ 100, e cada tag é
verificada no workspace. O Supabase envia o corpo praticamente cru para a RPC
(linhas 35–36); só o telefone é normalizado (`normalizePhone`, linha 16). O
que a RPC valida é **não identificado**. Erros também diferem: SQLite lança
`AppError` tipado (409/400/404); Supabase lança `Error` genérico (linha 15),
o que muda o status HTTP visto pela UI.

### 4.4 Após implementar bloqueio

Assimetria garantida se a migration Supabase não for aplicada junto com a
SQLite: o Inbox ofereceria "bloquear" funcionando em um provedor e quebrando
no outro. Bloqueio **não deve** ser implementado antes das duas migrations
estarem aprovadas e aplicadas.

---

## 5. O que precisa de decisão sua

1. **Semântica de bloqueio** — (A) local ChatPro ou (B) propagado ao WhatsApp
   via WAHA? Recomendo (A) primeiro (seção 2).
2. **Aprovação das migrations** — bloqueio, `chatpro_delete_contact`, filtro
   `optOut=false` e FK de `conversations`. O SQL fica em
   `docs/migrations-propostas-contatos.sql` para revisão; nada será aplicado
   sem sua autorização.
3. **Confirmação do schema remoto** (3.1) — sem saber o que existe hoje no
   projeto Supabase configurado, qualquer migration é escrita às cegas.
4. **Onde no Inbox** as ações devem aparecer — o painel direito
   (`customer-panel`, `Inbox.tsx:946`) é o lugar natural para editar/bloquear
   o contato da conversa selecionada.

## 6. Ordem de implementação sugerida

1. ~~Busca de contatos filtrando no banco~~ — feito, PR separada.
2. Editar contato no Inbox (backend pronto; só UI + correção do `defaultChecked`).
3. Criar contato no Inbox (backend pronto; só UI).
4. Apagar contato no Inbox — exige primeiro alinhar 404 e vínculos (4.2).
5. Bloquear/desbloquear — **bloqueado** pelas decisões 1 e 2 acima.

Editar e criar vêm antes de apagar e bloquear porque não exigem nenhuma
decisão pendente nem migration: o backend já está completo e simétrico o
suficiente, e a entrega é só a superfície de Inbox.
