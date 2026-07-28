# Limpeza retroativa dos eventos de sistema — procedimento de execução

SQL: [`migrations-propostas-eventos-sistema.sql`](migrations-propostas-eventos-sistema.sql).
Origem do problema: [`conversas-sem-resposta.md`](conversas-sem-resposta.md), seção 6.

A correção de ingestão já está em `main` e impede novos casos. Este documento trata
só do que ficou gravado antes dela.

Nada aqui foi executado no Supabase remoto. Tudo que segue foi validado num
PostgreSQL 16.14 em contêiner, com o schema montado a partir de
`web/supabase/migrations` e carregado com um espelho somente-leitura dos dados
reais. O acesso ao remoto usado para medir e espelhar foi apenas `GET` via
PostgREST.

---

## 1. Estado atual (medido em 2026-07-28)

A recontagem foi feita rodando as próprias consultas do arquivo `.sql` sobre o
espelho — não por agregação em JS, que era a ressalva registrada.

| | proposta original | agora | |
|---|---|---|---|
| mensagens | 3 007 | **4 613** | base viva, cresceu |
| mensagens técnicas | 237 (8 %) | **241** (5,2 %) | +2 `gp2`, +2 `revoked` |
| conversas | 650 | **652** | |
| conversas fantasma | 156 | **160** (25 %) | 138 diretas, 22 grupos |
| fantasma com badge de não lida | 68 | **70** | somando 93 não lidas |
| conversas mistas (preservar) | 17 | **8** | ver ressalva abaixo |
| linhas de SLA | 52 | **54** | |
| SLA que somem por cascata | 37 | **41** | |
| SLA a recalcular | 6 | **2** | ver ressalva abaixo |
| eventos brutos (intocados) | 12 917 | **14 777** | |

Técnicas por tipo: `e2e_notification` 141, `notification_template` 71, `gp2` 26,
`revoked` 3. `call_log` continua fora do escopo: são 197 mensagens em 30
conversas; incluí-las levaria as fantasmas a 167 e as mistas a 29.

**Ressalva sobre "mistas 17 → 8" e "SLA a recalcular 6 → 2".** Uma conversa mista
não pode virar não-mista: ela não perde mensagem real. Logo esse número não podia
cair por crescimento da base. Os valores antigos não são reproduzíveis a partir da
regra escrita no SQL, e nenhuma variante testada os produz:

| assinatura testada | fantasmas | mistas |
|---|---|---|
| regra do arquivo (`payload_json`, `call_log` = real) | 160 | 8 |
| incluindo `call_log` como técnico | 167 | 29 |
| pela coluna `message_type` | 0 | 0 |
| só `payload_json->>'type'`, sem o fallback `_data` | 0 | 0 |

A coluna `message_type` já vem normalizada pela ingestão e só contém
`text/document/image/audio/video` — por isso zera. Os números antigos vieram da
agregação em JS que nunca foi validada; os desta tabela vieram do SQL. **São estes
que valem.** Reconfira na hora de executar: a base é viva.

---

## 2. O que a validação encontrou

O SQL proposto está sintaticamente correto — todas as oito consultas rodam contra
o schema real. Mas **a sequência não executava até o fim**, e dois passos faziam
mais do que diziam.

**1. O DELETE de conversas abortava.** Três chaves estrangeiras para
`conversations` não são `CASCADE`:

| tabela | ação | efeito |
|---|---|---|
| `conversation_kanban_state` | `NO ACTION` | bloqueia |
| `kanban_automation_deliveries` | `NO ACTION` | bloqueia |
| `inbox_outbox_jobs` | `RESTRICT` | bloqueia |

Como 625 das 652 conversas estão no Kanban, **as 160 alvo estão todas
bloqueadas**. Rodando a sequência original no espelho, o passo de mensagens
apagava 241 linhas e o de conversas explodia:

```
DELETE 241
ERROR: update or delete on table "conversations" violates foreign key constraint
       "conversation_kanban_state_workspace_id_conversation_id_fkey"
```

Fora de uma transação isso deixa a base meio migrada: mensagens apagadas,
conversas fantasma ainda lá — agora sem nenhuma mensagem e ainda na Inbox.

**2. A conferência não mostrava tudo que o DELETE apagava.** A consulta de
conversas órfãs usava `JOIN`, então nunca listava as 29 conversas que já hoje não
têm mensagem — mas o `DELETE ... WHERE NOT EXISTS` apagava as 29 junto. A
instrução "restrinja pela lista de ids conferida no passo 1" não protegia, porque
essa lista não continha as 29. Agora a conferência usa `LEFT JOIN` e classifica os
dois casos, e o DELETE trabalha sobre uma lista congelada no backup.

**3. O UPDATE de SLA mexia em 13 linhas para consertar 2**, e o `CASE` só emite
`waiting_operator`/`waiting_customer`. No espelho ele **reabriu uma conversa
`resolved` como `waiting_customer`**, com relógio correndo.

**4. Faltava filtro de `workspace_id`** nos dois DELETE.

**5. A conferência de SLA duplicava linha** quando duas mensagens dividem o mesmo
instante de âncora (`JOIN` virou `EXISTS`), e casava conversa só por `id`,
ignorando `workspace_id`.

O que o SQL prometia e **se confirmou**: `waha_webhook_events` não é tocado por
nada, e a FK de `conversation_sla_metrics` é `CASCADE` e leva as linhas junto.

---

## 3. As 8 conversas mistas são preservadas

Confirmado no espelho, rodando a sequência inteira e conferindo depois:

| conversa | chat | técnicas removidas | mensagens que restaram |
|---|---|---|---|
| `7a336196…` | `120363328209240027@g.us` | 5 | 1 252 |
| `4799ff83…` | `120363363444637332@g.us` | 2 | 962 |
| `53cddba6…` | `120363328209240027@g.us` | 1 | 193 |
| `6c3af7c1…` | `120363419464143076@g.us` | 1 | 68 |
| `cca527f5…` | `120363419464143076@g.us` | 1 | 45 |
| `94621a1d…` | `558596917853@c.us` | 1 | 9 |
| `8b0e09cd…` | `558587667647@c.us` | 1 | 1 |
| `7cf4f4dc…` | `558596318752@c.us` | 1 | 1 |

Nenhuma foi apagada; as 2 531 mensagens reais continuam lá. São preservadas por
construção, em dois níveis:

- a lista de exclusão (`backup_eventos_sistema.alvo`) exige
  `count(*) FILTER (WHERE tipo real NÃO é técnico) = 0`, e uma conversa mista tem
  pelo menos uma real;
- o DELETE de conversas usa essa lista congelada, não uma condição recalculada.

**O passo 2 as identifica claramente**: uma linha por conversa mista, com
`chat_id`, `tecnicas_a_remover` e `reais_preservadas`. A última coluna é a prova,
linha a linha, de que a conversa sobrevive — se alguma aparecer com
`reais_preservadas = 0`, pare, porque a classificação mudou.

Repare que duas conversas dividem o mesmo `chat_id` (`120363328209240027@g.us` e
`120363419464143076@g.us` aparecem duas vezes): são sessões WAHA diferentes. Por
isso todo casamento entre conversa e mensagem usa
`(workspace_id, waha_session, chat_id)`, nunca só `chat_id`.

---

## 4. As linhas de SLA que sobrevivem

Hoje são **2**, não 6, e a premissa registrada não se aplica a elas.

```
conversation_id                       status   op_ms  cli_ms  resp_ms  respostas
7a336196-0675-4f8b-add2-75d707f9a4a9  expired      0       0        0          0
cca527f5-6239-483d-a9c9-85ec38ee92b6  expired      0       0        0          0
```

**Todos os acumuladores estão zerados.** A linha não foi contaminada por
intervalos medidos a partir de evento técnico: ela foi **criada** pelo evento
técnico e nunca viu uma transição. Não há o que separar. O mesmo vale para as 41
linhas que somem por cascata — todas com acumulador zero.

Não é um acaso das duas linhas: **todas** as 43 linhas ancoradas em evento técnico
(as 41 que somem por cascata e estas 2) têm acumulador zero. E das 13 que
sobrevivem, 9 têm acumulador não-zero — nenhuma delas ancorada em evento técnico.
Os dois conjuntos não se cruzam.

Não afirmo aqui *por que* o acumulador ficou em zero. `SlaService.message` soma em
`operator_waiting_ms` também num inbound, quando a linha já estava em
`waiting_operator` (`sla.service.ts:53`), e a conversa `7a336196…` recebeu inbound
real depois da âncora — então o zero não se explica só por "nunca houve resposta".
O que vale para esta limpeza é o fato medido, não a explicação; e o guard do
passo 8 cobre o caso de o fato deixar de valer.

Com o acumulador zerado, o recálculo é determinável a partir do que sobra:

| campo | de onde vem | por quê |
|---|---|---|
| `first_inbound_at` | primeiro inbound real | a âncora técnica era posterior ao início real da conversa |
| `last_inbound_at` | último inbound real | |
| `last_outbound_at` | último outbound real, senão preserva | |
| `waiting_since_at` | último outbound real, senão último inbound real | quem falou por último define quem está esperando |
| `sla_status` | `waiting_customer` se o operador falou por último, senão `waiting_operator` | |
| `first_response_at` | **continua `NULL`** | nunca houve outbound; inventar uma primeira resposta seria pior que não ter |
| acumuladores | **ficam como estão (zero)** | zero é o valor correto, não uma perda |

Efeito medido no espelho:

```
7a336196…  expired → waiting_operator
           first_inbound  2026-07-24 13:11:52 → 2026-07-21 18:29:07
           relógio        2026-07-24 13:11:52 → 2026-07-28 13:29:18
cca527f5…  expired → waiting_operator
           first_inbound  2026-07-24 18:39:47 → 2026-07-21 19:30:01
           relógio        2026-07-24 18:39:47 → 2026-07-22 15:18:47
```

Ambas saem de `expired` (um atraso que nunca existiu, contado a partir de uma
notificação técnica) para `waiting_operator` com o relógio na última mensagem
real. Ambas são grupos sem nenhum outbound: ninguém respondeu, e continua assim.

### Se na hora de executar alguma linha tiver acumulador não-zero

O `UPDATE` do passo 8 tem o guard
`AND b.operator_waiting_ms = 0 AND b.customer_waiting_ms = 0 AND b.total_response_ms = 0 AND b.response_count = 0`.
Uma linha com histórico acumulado **não é tocada** — ela sai do UPDATE em vez de
ser reancorada por cima de um acumulador que ninguém sabe decompor. O passo 3
mostra isso antes, na coluna `acumuladores_zerados`.

Para essas linhas, aí sim o valor correto é irrecuperável: o acumulador é um
`bigint` somado a cada transição, sem registro de quais intervalos o compuseram, e
`waha_webhook_events` guarda o evento bruto mas não as transições de SLA. Nesse
caso o tratamento honesto é **apagar a linha** e deixar
`SlaService.message` recriá-la no próximo inbound real:

```sql
-- Só se o passo 3 mostrar acumuladores_zerados = false em alguma linha.
-- DELETE FROM public.conversation_sla_metrics s
-- USING backup_eventos_sistema.sla_ajustadas b
-- WHERE b.workspace_id = s.workspace_id AND b.conversation_id = s.conversation_id
--   AND NOT (b.operator_waiting_ms = 0 AND b.customer_waiting_ms = 0
--            AND b.total_response_ms = 0 AND b.response_count = 0);
```

O custo é explícito e deve ser aceito antes: a conversa fica **sem métrica de SLA
até chegar a próxima mensagem real** — some do painel operacional nesse intervalo.
Zerar os acumuladores no lugar disso seria afirmar "não houve espera", que é
falso; mantê-los seria afirmar um número medido a partir de evento técnico, que
também é falso. Apagar é a única das três que não afirma nada errado.

---

## 5. Procedimento

Rode no SQL Editor do Supabase, um passo por vez, conferindo antes de seguir.
Fora de pico: o passo 7 remove 160 conversas da Inbox e dos quadros de Kanban.

### Passo A — reconferir

Rode as consultas **0, 1, 2 e 3** do arquivo `.sql` e compare com a tabela da
seção 1. Números diferentes não são impedimento — a base é viva —, mas
**divergência de forma é**. Pare se:

- alguma conversa aparecer no passo 2 com `reais_preservadas = 0`;
- o passo 3 mostrar `acumuladores_zerados = false` (vá para a seção 4 antes);
- o passo 1 listar como `fantasma_desta_limpeza` alguma conversa que você
  reconhece como atendimento real.

Anote os números: eles são a expectativa dos passos seguintes.

### Passo B — backup

Rode o **passo 4** inteiro, em transação própria, e confira:

```sql
SELECT 'alvo' t, count(*) FROM backup_eventos_sistema.alvo
UNION ALL SELECT 'mensagens', count(*) FROM backup_eventos_sistema.whatsapp_messages
UNION ALL SELECT 'conversas', count(*) FROM backup_eventos_sistema.conversations
UNION ALL SELECT 'sla_cascata', count(*) FROM backup_eventos_sistema.conversation_sla_metrics
UNION ALL SELECT 'kanban', count(*) FROM backup_eventos_sistema.conversation_kanban_state
UNION ALL SELECT 'deliveries', count(*) FROM backup_eventos_sistema.kanban_automation_deliveries
UNION ALL SELECT 'outbox', count(*) FROM backup_eventos_sistema.inbox_outbox_jobs
UNION ALL SELECT 'sla_ajustadas', count(*) FROM backup_eventos_sistema.sla_ajustadas;
```

Esperado hoje: 160 / 241 / 160 / 41 / 160 / 0 / 0 / 2. **`alvo` e `conversas` têm
que bater**, e `alvo` tem que bater com o total de `fantasma_desta_limpeza` do
passo 1. Se `alvo` vier maior que isso, algo mudou na classificação: pare.

O backup fica na base. Não o apague antes de a Inbox estar conferida.

### Passo C — mensagens técnicas

Rode o **passo 5**. Esperado: `DELETE 241` — o mesmo número do passo 0 e de
`backup_eventos_sistema.whatsapp_messages`.

```sql
SELECT count(*) FROM public.whatsapp_messages
WHERE workspace_id = 'default-workspace'
  AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
  ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext');
-- esperado: 0
SELECT count(*) FROM public.waha_webhook_events;  -- esperado: inalterado (14 777)
```

### Passo D — estado operacional das conversas alvo

Rode os três DELETE do **passo 6**. Esperado: 160 / 0 / 0.

Sem isto o passo E aborta. São cartões de Kanban, entregas de automação e jobs de
envio de conversas que estão prestes a deixar de existir — tudo no backup.

### Passo E — conversas fantasma

Rode o **passo 7**. Esperado: `DELETE 160`.

```sql
SELECT count(*) FROM public.conversations WHERE workspace_id = 'default-workspace';
-- esperado: 492  (652 - 160)
SELECT count(*) FROM public.conversation_sla_metrics WHERE workspace_id = 'default-workspace';
-- esperado: 13   (54 - 41, levadas por CASCATA)
```

Se o `DELETE` falhar por FK, **não force**: apareceu uma dependência nova. Rode o
diagnóstico e trate antes de seguir:

```sql
SELECT c.conrelid::regclass AS tabela, c.confdeltype
FROM pg_constraint c
WHERE c.contype = 'f' AND c.confrelid = 'public.conversations'::regclass
  AND c.confdeltype <> 'c';
```

### Passo F — ajuste das linhas de SLA

Rode o **passo 8**. Esperado: `UPDATE 2`.

Se vier mais que o total de `sla_ajustadas` do passo B, pare e reverta: o filtro
não está prendendo.

### Passo G — conferência final

Rode o **passo 9**:

| coluna | esperado |
|---|---|
| `mensagens_tecnicas_restantes` | 0 |
| `conversas_sem_mensagem` | 29 (as que já estavam assim; não são alvo) |
| `conversas_totais` | 492 |
| `linhas_de_sla` | 13 |
| `sla_com_ancora_inexistente` | 0 |
| `eventos_brutos_preservados` | 14 777 (inalterado) |

Depois, na aplicação: abrir a Inbox e conferir que as 160 conversas sumiram, que
as 93 não lidas fantasma sumiram do contador, e que as 8 conversas mistas da
seção 3 continuam abrindo com o histórico completo.

---

## 6. Rollback

Testado no espelho: restaura **byte a byte**. Depois de reverter, o checksum de
`whatsapp_messages`, `conversations`, `conversation_sla_metrics` e
`waha_webhook_events` volta a ser idêntico ao de um banco carregado do zero com os
mesmos dados.

Ordem importa: conversas primeiro, porque as outras têm FK para elas.

```sql
BEGIN;
INSERT INTO public.conversations                SELECT * FROM backup_eventos_sistema.conversations;
INSERT INTO public.conversation_sla_metrics     SELECT * FROM backup_eventos_sistema.conversation_sla_metrics;
INSERT INTO public.conversation_kanban_state    SELECT * FROM backup_eventos_sistema.conversation_kanban_state;
INSERT INTO public.kanban_automation_deliveries SELECT * FROM backup_eventos_sistema.kanban_automation_deliveries;
INSERT INTO public.inbox_outbox_jobs            SELECT * FROM backup_eventos_sistema.inbox_outbox_jobs;
-- whatsapp_messages não tem FK para conversations; só para waha_webhook_events, que ficou intacta.
INSERT INTO public.whatsapp_messages            SELECT * FROM backup_eventos_sistema.whatsapp_messages;
-- Desfaz o passo 8, coluna a coluna.
UPDATE public.conversation_sla_metrics s
SET sla_status = b.sla_status, first_inbound_at = b.first_inbound_at, first_response_at = b.first_response_at,
    last_inbound_at = b.last_inbound_at, last_outbound_at = b.last_outbound_at, last_activity_at = b.last_activity_at,
    waiting_since_at = b.waiting_since_at, operator_waiting_ms = b.operator_waiting_ms,
    customer_waiting_ms = b.customer_waiting_ms, total_response_ms = b.total_response_ms,
    response_count = b.response_count, resolved_at = b.resolved_at, archived_at = b.archived_at,
    frozen_at = b.frozen_at, updated_at = b.updated_at
FROM backup_eventos_sistema.sla_ajustadas b
WHERE b.workspace_id = s.workspace_id AND b.conversation_id = s.conversation_id;
COMMIT;
```

Rollback parcial: se você parou no meio, rode só as linhas dos passos que já
executou, na mesma ordem. Reverter o passo E exige reverter também o D (as FKs
apontam para as conversas restauradas), e nessa ordem: conversas antes do Kanban.

Depois de conferir tudo, o backup pode ser removido:

```sql
-- DROP SCHEMA backup_eventos_sistema CASCADE;
```

---

## 7. O que este procedimento NÃO faz

- **Não toca em `waha_webhook_events`.** Os 14 777 eventos brutos continuam
  explicando o que chegou, e são o que torna as mensagens reconstruíveis.
- **Não apaga contatos.** 73 das 160 conversas fantasma têm `contact_id`. O
  contato pode ser compartilhado com outra conversa ou ter sido criado à mão.
  Limpar contatos é decisão separada.
- **Não apaga as 29 conversas que já hoje não têm mensagem.** Elas ficaram assim
  por outro motivo, ninguém as auditou, e a proposta original as levava junto sem
  as listar. Continuam aparecendo no passo 1 como `ja_vazia_antes`.
- **Não trata `call_log`.** 197 mensagens em 30 conversas. Se a decisão de produto
  for tratá-las como técnicas, refaça a conferência inteira: as fantasmas vão de
  160 para 167 e as mistas de 8 para 29.
- **Não mexe nas bases SQLite locais.** São recriadas a partir das migrations.

---

## 8. Como isto foi validado

- PostgreSQL 16.14 em contêiner, schema aplicado a partir de
  `web/supabase/migrations` (duas migrations precisaram de um `storage.buckets`
  stub, irrelevante aqui). As colunas de `whatsapp_messages`, `conversations`,
  `conversation_sla_metrics`, `waha_webhook_events` e `contacts` foram conferidas
  uma a uma contra a introspecção PostgREST do projeto remoto: idênticas.
- Espelho somente-leitura dos dados reais (4 613 mensagens, 652 conversas, 54
  linhas de SLA, 625 cartões de Kanban). `payload_json` foi reconstruído como
  `{"type": …, "_data": {"type": …}}`, o que é fiel para a expressão que a limpeza
  usa.
- Sequência original rodada no espelho: **abortou** no DELETE de conversas.
- Sequência corrigida rodada no espelho: completa, com os números da seção 1.
- Rollback rodado em seguida: restaura byte a byte.
- `apps/api/test/eventos-sistema-cleanup-sql.test.ts` prende o SQL ao código:
  o vocabulário técnico do arquivo tem que ser exatamente
  `technicalMessageTypes` de `conversation-identity.ts`, os DELETE têm que
  continuar comentados, a ordem dos passos e os guards não podem sumir. Nove
  mutações no SQL foram testadas contra a suíte; todas quebram algum teste.
