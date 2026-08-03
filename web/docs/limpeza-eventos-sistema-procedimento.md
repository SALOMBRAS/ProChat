# Limpeza retroativa dos eventos de sistema — procedimento de execução

SQL: [`migrations-propostas-eventos-sistema.sql`](migrations-propostas-eventos-sistema.sql).
Origem do problema: [`conversas-sem-resposta.md`](conversas-sem-resposta.md), seção 6.

A correção de ingestão já está em `main` e impede novos casos. Este documento trata
só do que ficou gravado antes dela.

---

## ✅ Revalidação de 2026-08-03, 18h05Z — ESTA é a versão a executar

**SQL pronto para colar: [`limpeza-fantasmas-20260803.sql`](limpeza-fantasmas-20260803.sql).**
Não use `migrations-propostas-eventos-sistema.sql`: o vocabulário dele tem 11
tipos e o do código tem 14. Motivo de o arquivo antigo não ter sido corrigido no
lugar: [ver §0.6](#06-uma-mudança-de-código-que-eu-não-fiz).

Método: espelho somente-leitura das 8 tabelas, baixado por `GET` via PostgREST
às **18h05Z**, carregado num PostgreSQL **16.14** em contêiner descartável sobre
o schema das migrations do repositório. **O remoto não foi escrito em momento
algum.** Todas as colunas do remoto têm par local, conferido na carga — a carga
aborta se faltar.

### 0.1 Os números de hoje

| | 03/08 16h01Z (registro anterior) | **03/08 18h05Z (agora)** |
|---|---|---|
| mensagens | 17 009 | **22 074** |
| mensagens técnicas | — | **308** (14 tipos) / 280 (11 tipos) |
| conversas | 673 | **1 056** |
| conversas fantasma | 134 (113 diretas + 21 grupo) | **165** (144 + 21) |
| — protegidas pela #73 | não medido | **2** (1 direta + 1 grupo) |
| **= alvo da limpeza** | 134 | **163** |
| conversas mistas (preservar) | 21 | **31** |
| já vazias antes (não são alvo) | 29 | **29** |
| linhas de SLA | — | **72** |
| — ancoradas em evento técnico | — | **41** |
| — somem por cascata | — | **37** |
| — sobrevivem e são ajustadas | 3 (medição das 18h de 28/07) | **4** |
| eventos brutos (intocados) | — | **39 175** |

### 0.2 De onde vem cada diferença

**Conversas 673 → 1 056 (+383).** A sincronização terminou. É a maior parte de
tudo que mudou.

**Fantasmas 134 → 165 (+31).** As **+31 são todas diretas** (113 → 144). O total
de grupo é **21 pela quarta medição seguida** — não se moveu em nenhuma das
quatro, o que é a evidência mais forte de que a classe de grupo é estável e o que
cresce é a cauda de conversa direta sem conteúdo.

**Já vazias 29 → 29.** Terceira medição consecutiva no mesmo número. Não são alvo
e continuam não sendo.

**Mistas 21 → 31 (+10).** Mais conversa recebeu técnica e real ao mesmo tempo.
Mista é o que a limpeza **preserva**.

**SLA a ajustar 3 → 4.** Uma linha a mais ficou ancorada em evento técnico numa
conversa que sobrevive. **As quatro têm acumulador zerado** — a condição que
torna o passo F determinável — e as 37 da cascata também.

### 0.3 O vocabulário: 14 tipos, e o efeito medido

O código tem **14** em `technicalMessageTypes` (`conversation-identity.ts`); o
`.sql` antigo tem **11**. A #127 acrescentou `album`, `pinned_message` e
`group-history`. A #119 não mexe nesta limpeza: ela reclassificou `location` e o
uso de mime para `message_type`, e esta limpeza **não usa `message_type`** — usa
o tipo real do payload. Confirmado que o SQL lê o tipo na mesma ordem que o
código (`type` na raiz, `_data.type` como fallback).

Medido nas duas listas, sobre a base de hoje:

| | 11 tipos | 14 tipos |
|---|---|---|
| mensagens técnicas | 280 | **308** |
| conversas fantasma | 165 | **165** |
| conversas mistas | 19 | **31** |

**A população-alvo não muda** — nenhuma conversa é 100 % dos três tipos novos, o
que reproduz o achado de 31/07. O que muda são as 28 mensagens a mais que saem
(20+6 `album`, 1 `group-history`, 1 `pinned_message`) e 12 conversas que passam a
contar como mistas.

### 0.4 As três travas continuam valendo — e a terceira ficou pior

| trava | veredito hoje |
|---|---|
| FKs não-CASCADE bloqueiam o DELETE | **confirmada**, sem mudança |
| `HAVING count(*)` esconde as já vazias | **confirmada**, sem mudança |
| UPDATE de SLA sem guard | **confirmada**, e o dano é maior em proporção |

**FKs.** `inbox_outbox_jobs` é `RESTRICT`; `conversation_kanban_state` e
`kanban_automation_deliveries` são `NO ACTION`. As outras cinco FKs para
`conversations` são `CASCADE`. Do alvo, **161 de 163 estão no Kanban**; em
`deliveries` e `outbox`, zero. Sem o passo D o passo E aborta inteiro.

**`HAVING`.** Medido nas duas formas sobre a base de hoje: `count(*) FILTER`
devolve **165** linhas (só as fantasmas, escondendo as vazias) e
`count(m.external_message_id) FILTER` devolve **194** = 165 + 29. O defeito é o
mesmo de 31/07 e a correção é a mesma.

**UPDATE de SLA.** Executado sem o guard sobre o estado pós-limpeza: `UPDATE 35`,
e o resultado tem **zero `expired`**. Ou seja, **25 violações reais de SLA
apagadas para consertar 4**. A proporção piorou: em 28/07 eram 54 para 3 (18:1),
hoje são 25 para 4 (6:1), mas o que importa é que continua destruindo violações
verdadeiras. Com o guard: `UPDATE 4`, e sobram 21 `expired`.

### 0.5 A trava da #73 estava certa no princípio e errada na consulta

O princípio: conversa sem mensagem real pode ser **chat vivo cujo histórico nunca
materializou**, e essa não pode ser apagada. Confirmado — e a população existe:

| conversa | eventos brutos reais | mensagens persistidas |
|---|---|---|
| `120363305261884309@g.us` (grupo) | 62 (56 `chat`, 2 imagem, 2 figurinha, 1 ptt, 1 documento) | 1, técnica |
| `558592012483@c.us` (direta) | 19 (16 `chat`, 2 imagem, 1 desconhecido) | 3, técnicas |

**Mas a consulta C2 do `.sql` erra.** Ela testa
`payload_json::text LIKE '%' || c.chat_id || '%'`, que casa o JID em qualquer
lugar do payload. Medido: o `LIKE` protege **25** conversas; o teste por campo de
identificação protege **2**. As **23 de diferença são todas diretas**, e o JID
delas aparece em:

- `_data.mentionedJidList` — a pessoa foi **mencionada** numa mensagem de grupo;
- `_data.quotedParticipant` / `replyTo` — a mensagem dela foi **citada**.

Ser mencionado ou citado em outra conversa não é evento daquele chat. O guard
correto compara o `chat_id` com os campos que identificam o chat: `from`, `to`,
`_data.from`, `_data.to`, `_data.id.remote`, `participant`, `_data.author`. É o
que o SQL novo faz.

O erro é conservador — protege demais, não apaga demais —, então **nada foi
apagado indevidamente por causa dele**. Mas manteria 23 conversas fantasma na
Inbox achando que eram chats vivos.

**A consulta C3 também não serve como conferência.** Ela exige
`NOT EXISTS (mensagem alguma)`, e as duas conversas realmente protegidas **têm**
mensagem técnica — então C3 devolve **0** e não enxerga nenhuma das duas. Além
disso casa por `chat_id` ignorando `waha_session`, contra a regra do resto do
documento. A conferência que substitui C3 é a coluna `classe` da consulta A2 do
SQL novo.

Testado também o guard **com** `waha_session`: dos 163 alvos, **zero** teria
evento real na própria sessão. O alvo é o mesmo com ou sem sessão — não há
ambiguidade a resolver aqui.

### 0.6 Uma mudança de código que eu não fiz

Atualizar o vocabulário dentro de `migrations-propostas-eventos-sistema.sql`
**quebra** `apps/api/test/eventos-sistema-cleanup-sql.test.ts`. Medido: o teste
extrai as listas com a classe `[a-z0-9_]`, que não aceita hífen, e
`group-history` tem um. Com os 14 tipos, `typeLists()` devolve zero listas e o
teste falha em `nenhuma lista de tipos encontrada no SQL`.

Falha alto, e isso é mérito do teste: a asserção `lists.length > 0` existe
exatamente para isso.

A correção é uma classe de caracteres, em `apps/api/test/`:

```diff
-  [...sql.matchAll(/(?:NOT\s+)?IN\s*\(\s*((?:'[a-z0-9_]+'\s*,\s*)+'[a-z0-9_]+')\s*\)/gi)]
+  [...sql.matchAll(/(?:NOT\s+)?IN\s*\(\s*((?:'[a-z0-9_-]+'\s*,\s*)+'[a-z0-9_-]+')\s*\)/gi)]
```

Não apliquei: é código, e o combinado era avisar antes. Por isso o SQL executável
saiu em arquivo novo — que o teste não cobre. **Enquanto isso não for decidido, o
`.sql` novo não está preso ao vocabulário do código por teste nenhum.** Confira a
lista à mão antes de aplicar.

### 0.7 Backup em arquivo, fora do banco

Gerado antes de qualquer coisa, a partir do espelho de 18h05Z:

```text
~/Área de trabalho/Salomão/Chatpro/backup-limpeza-fantasmas-20260803/
  alvo.ndjson                          163 linhas
  conversations.ndjson                 163 linhas    140 KB
  whatsapp_messages.ndjson             308 linhas    1,1 MB
  conversation_kanban_state.ndjson     161 linhas     72 KB
  conversation_sla_metrics.ndjson       37 linhas     20 KB
  sla_ajustadas.ndjson                   4 linhas    4,0 KB
  kanban_automation_deliveries.ndjson    0 linhas
  inbox_outbox_jobs.ndjson               0 linhas
  MANIFESTO.sha256
```

Fica **fora do repositório**, de propósito: são dados de produção.

O que ele é e o que não é: é o registro do que foi medido, linha inteira, para
conferir depois que a limpeza rodou. **Não é o instrumento de rollback** — esse é
o schema `backup_eventos_sistema`, criado no passo B contra a base viva no
instante da execução. A base escreve continuamente (entre 18h05Z e 18h29Z
entraram 17 mensagens e 34 eventos), então o arquivo e o passo B podem divergir;
quem manda é o passo B.

### 0.8 A sequência inteira roda e termina

O arquivo `limpeza-fantasmas-20260803.sql` foi executado **literalmente**, do
começo ao fim, sobre o espelho recarregado. Saída 0, sem erro em nenhum passo:

| passo | resultado |
|---|---|
| A2 | 862 mista_ou_real + 163 fantasma_alvo + 29 ja_vazia_antes + 2 protegida_73 = **1 056** |
| B | alvo 163, mensagens 308, conversas 163, sla_cascata 37, kanban 161, deliveries 0, outbox 0, sla_ajustadas 4 |
| C | `DELETE 308`; técnicas restantes 0; eventos brutos 39 175 intactos |
| D | `DELETE 161` / `DELETE 0` / `DELETE 0` |
| E | `DELETE 163`; sobram 893 conversas e 35 linhas de SLA |
| F | `UPDATE 4`, as quatro de `expired` para `waiting_operator` |
| G | 0 técnicas / 31 sem mensagem / 893 conversas / 35 SLA / 0 âncora inexistente / 39 175 eventos |

**Por que `conversas_sem_mensagem` é 31 e não 29.** São as 29 que já estavam
assim **mais as 2 protegidas pela #73**, cujas únicas mensagens eram técnicas e
saíram no passo C. Elas continuam existindo de propósito: têm histórico por
materializar. Se este número vier 29, o guard não prendeu — pare.

Status de SLA ao final: `expired` 21, `waiting_customer` 10, `waiting_operator` 4.

### 0.9 O que reconferir na hora

A base escreve continuamente. **Rode o passo A imediatamente antes do B** e
compare **forma**, não valor. Pare se:

- `fantasma_alvo` do A2 não bater com `alvo` do B;
- alguma conversa do A3 vier com `reais_preservadas = 0`;
- alguma linha do A4 vier com `acumuladores_zerados = false`;
- `protegida_73` vier **0** — significa que o guard não está prendendo;
- o A2 listar como `fantasma_alvo` alguma conversa que você reconhece como
  atendimento real.

---

## ⛔ Revalidação de 31/07/2026 — histórico, NÃO EXECUTE COMO ESTÁ

Revalidado contra `origin/main` @ `c396487`. **Banco remoto não tocado**: só
leitura de código, docs e git, mais um PostgreSQL 16 em contêiner descartável,
criado e removido.

**O procedimento está estruturalmente correto e uma consulta está errada.** Leia
as quatro seções abaixo antes de qualquer coisa.

### 1. O vocabulário NÃO mudou — e isso é boa notícia

`biz_content_placeholder` entrou pela PR #46 em **28/07**, portanto **antes**
deste procedimento ser escrito, e o `.sql` já o carrega desde a #52. As duas
listas coincidem hoje, com **11 tipos**:

```text
ack, receipt, reaction, status, protocol, revoked,
e2e_notification, notification_template, gp2, ciphertext, biz_content_placeholder
```

O último commit a tocar `conversation-identity.ts` é de 28/07. **Nenhum tipo
técnico entrou depois de 29/07.** Nesse ponto o procedimento está certo.

> **Deixou de valer em 2026-08-03.** Entraram três tipos — `album`,
> `pinned_message` e `group-history` —, e o vocabulário do código passou a ter
> **14**, contra os 11 deste `.sql`. É exatamente o descasamento que o aviso
> abaixo previa.
>
> Efeito medido na população-alvo: **nenhum**. Não existe conversa 100 % desses
> três tipos, então o número de fantasmas não muda (134 com as duas listas). O
> que muda são 7 conversas que passam a contar como **mistas**, de 14 para 21 —
> e mista é o que a limpeza preserva, então o descasamento erra para o lado
> conservador. Detalhamento no fim do arquivo.

> **Mas o teste que prende SQL e código só prende um lado.**
> `eventos-sistema-cleanup-sql.test.ts` garante que todo tipo do SQL é técnico
> para o código, e que as listas do SQL são iguais entre si — **não** garante que
> todo tipo do código está no SQL. Foi assim que `biz_content_placeholder` ficou
> de fora por um dia. Se um 12º tipo entrar no código, a suíte passa e a limpeza
> deixa mensagem técnica para trás. **Confira a lista à mão antes de aplicar.**

### 2. A PR #73 reclassifica fantasma × mista — e uma consulta ficou perigosa

A #73 fez passar a ser aceita a mensagem de grupo cujo único identificador de
chat é o JID do grupo em `from`/`to`, com o autor em `participant`. Entre
**20/07 e 31/07** essas mensagens morriam como `missing_chat_id`: **10.372
descartes, 9.686 recuperáveis**, com o payload inteiro preservado em
`waha_webhook_events`.

**A #73 não acrescenta nenhuma mensagem técnica.** Os 21 `gp2` só trocaram o
motivo do descarte, de `missing_chat_id` para `technical_message_type`, e
continuam não persistidos. O que ela muda é o **outro lado** da classificação:

> "Zero mensagem real" num chat de **grupo** deixou de ser evidência sobre o
> chat e passou a ser evidência sobre o bug. Uma conversa de grupo que hoje
> aparece como fantasma pode ser **um grupo vivo cujo histórico nunca foi
> materializado**.

As **fantasmas diretas não são afetadas**; as **de grupo** são a população
suspeita.

> **Remedido em 2026-08-03T16:01Z** — o número de diretas aqui era **150** e está
> errado. A contagem correta é **113 diretas + 21 de grupo = 134 fantasmas**, de
> 673 conversas (**19 %**). O total de grupo, 21, reproduz exatamente; foi só o de
> diretas que mudou.
>
> A causa mais provável da queda não é erro de medição e sim o tempo: uma
> fantasma que depois recebe uma mensagem real deixa de ser fantasma, e a base
> saiu de 6 811 para 17 009 mensagens entre as duas medições. Não confirmei
> conversa a conversa — **não identificado** qual parcela é isso e qual é
> diferença de método.
>
> ~~Use 113 / 21 / 134 ao retomar a limpeza~~ — **substituído pela §0**, medido
> em 03/08 18h05Z: 144 diretas + 21 de grupo = 165 fantasmas, menos 2 protegidas
> pela #73 = **163 de alvo**. A tabela abaixo é registro histórico de dois
> instantes, não o estado de hoje.

**A consequência é uma regressão real, não teórica.** A consulta que monta
`backup_eventos_sistema.alvo` — a lista congelada que os passos D e E apagam —
não olha para `waha_webhook_events`. Reproduzido em fixture local: com uma
conversa de grupo cujo único evento real ficou por materializar, **a consulta
original devolve 2 conversas e a corrigida devolve 1**.

**Use a consulta C2 do arquivo `.sql`** (seção datada de 31/07), que acrescenta o
guard `NOT EXISTS (evento bruto real para este chat)`. E a classe nova,
`chat_real_com_historico_nao_materializado`, na consulta C1.

Nenhum dos três critérios de parada do passo A olha para `waha_webhook_events` —
por isso o passo A, sozinho, **não** detecta este caso.

### 3. Três incoerências internas, restos da medição das 13h51

| passo | diz | mas a seção 2 / o `.sql` dizem |
| --- | --- | --- |
| E | `linhas_de_sla` esperado **13** (54 − 41) | **19** (59 − 40) |
| F | `UPDATE 2` | **3** — e o critério de parada logo abaixo usa 3 |
| 7 | `call_log`: 197 mensagens em 30 conversas | seção 1: **259 em 31** |

A primeira faz quem seguir o passo E ao pé da letra ver 19, concluir que algo
vazou e **parar uma execução correta** — ou reverter por engano. A terceira
importa porque a estimativa condicional da seção 7 (fantasmas 171→178, mistas
12→33) está ancorada no número velho.

### 4. Um risco de rollback que não existia

O rollback foi testado num espelho **parado**. Hoje as conversas de grupo são
**recriadas pela ingestão**: restaurar o backup pode colidir com a `UNIQUE
(workspace_id, waha_session, chat_id)` de `conversations`. Antes de restaurar,
confira se a conversa já voltou a existir — e, se voltou, restaure só as tabelas
dependentes, não a conversa.

### ⚠️ Todos os números deste documento envelheceram

A medição é de **28/07 18h**, com ~6.811 mensagens. Hoje a base passa de
**16.900 eventos brutos**. Nenhuma contagem citada aqui — mensagens, técnicas,
conversas, fantasmas, mistas, linhas de SLA, `DELETE n` esperado — descreve a
base atual. Elas continuam úteis como **forma** (proporções, relações entre os
passos), não como valor.

> **Reexecute a conferência do passo A imediatamente antes de aplicar, não antes
> de revisar.** A sincronização de histórico escreve continuamente, e a #73
> acabou de destravar 9.686 mensagens recuperáveis: a base muda em horas. Um
> número conferido de manhã não descreve a base da tarde. Se o intervalo entre
> conferir e aplicar passar de alguns minutos com sincronização ativa, confira de
> novo — e compare **forma**, não valor.

---

Nada aqui foi executado no Supabase remoto. Tudo que segue foi validado num
PostgreSQL 16.14 em contêiner, com o schema montado a partir de
`web/supabase/migrations` e carregado com um espelho somente-leitura dos dados
reais. O acesso ao remoto usado para medir e espelhar foi apenas `GET` via
PostgREST.

---

## 1. Estado atual (remedido em 2026-07-28, 18h)

Esta é a **terceira** medição. Ela substitui a das 13h51 porque duas coisas
mudaram desde então:

- **o vocabulário** — a PR #46 acrescentou `biz_content_placeholder` aos tipos
  técnicos, e a medição anterior não o alcançava;
- **a base** — a sincronização avançou de 4 613 para 6 811 mensagens.

A recontagem foi feita rodando as próprias consultas do arquivo `.sql` sobre um
espelho novo, baixado por `GET` via PostgREST e carregado num PostgreSQL 16.14 em
contêiner. Todas as colunas do remoto têm par local, conferido na carga.

**A medição anterior foi reproduzida antes de ser substituída.** Reconstruindo o
estado no instante em que a base tinha 4 613 mensagens (`2026-07-28 13:51:28`), as
consultas devolvem 652 conversas, 241 técnicas, 160 fantasmas, 8 mistas e 29 já
vazias — exatamente os números da versão anterior. É isso que autoriza confiar nos
números novos.

| | medição 13h51 | agora (18h) | |
|---|---|---|---|
| mensagens | 4 613 | **6 811** | base sincronizando |
| mensagens técnicas | 241 (5,2 %) | **279** (4,1 %) | +26 novas, +12 do vocabulário |
| conversas | 652 | **655** | 3 criadas depois |
| conversas fantasma | 160 | **171** (26 %) | 150 diretas, 21 grupos |
| fantasma com badge de não lida | 70 | **69** | somando 92 não lidas |
| conversas mistas (preservar) | 8 | **12** | +4, detalhado abaixo |
| já vazias antes (não são alvo) | 29 | **29** | não mudou |
| linhas de SLA | 54 | **59** | 5 novas |
| SLA que somem por cascata | 41 | **40** | −1: a ex-fantasma sobrevive |
| SLA a recalcular | 2 | **3** | +1 ancorada em técnica |
| eventos brutos (intocados) | 14 777 | **17 778** | |

Técnicas por tipo: `e2e_notification` 142 (132 in + 10 out),
`notification_template` 71 (47 in + 24 out), `gp2` 40 (34 out + 6 in),
`revoked` 14, `biz_content_placeholder` 12.

`call_log` continua fora do escopo — decisão fechada em
[`call-log-na-inbox.md`](call-log-na-inbox.md). São 259 mensagens em 31 conversas.

### De onde vem cada diferença

Tudo abaixo é medido, não estimado. O método foi reconstruir o estado no corte das
13h51 e classificar as mesmas conversas nos dois momentos.

**Fantasmas 160 → 171.** Duas causas em direções opostas:

- **−1** — uma conversa que era fantasma recebeu mensagem real e virou mista. É
  exatamente o efeito que se temia da sincronização, e aconteceu **uma vez**.
- **+12** — as doze conversas do `biz_content_placeholder`. No vocabulário
  anterior elas contavam como conversa real; agora são fantasmas.

Com o vocabulário **antigo** sobre a base **atual** dariam 159. A diferença de 12
é inteiramente do vocabulário: nenhuma outra conversa virou fantasma.

**Mistas 8 → 12.** +1 a ex-fantasma acima, +2 que eram só-real e receberam evento
técnico novo, +1 conversa criada depois do corte. **Nenhuma veio do
`biz_content_placeholder`**: as 12 conversas dele não têm mensagem real nenhuma —
por isso caem inteiras na classe fantasma, e não na mista.

**SLA 54 → 59 linhas, mas cascata 41 → 40.** Cinco linhas novas entraram; a
cascata *caiu* porque a conversa que deixou de ser fantasma tinha linha de SLA e
agora sobrevive. As 12 conversas do `biz_content_placeholder` **não têm linha de
SLA** — é por isso que o vocabulário novo não mexe na cascata.

**A recalcular 2 → 3.** Uma linha a mais ficou ancorada em evento técnico numa
conversa que sobrevive. As três têm acumuladores zerados e nenhuma está em status
terminal — a condição que torna o passo F determinável.

### Sobre a medição de 3 007 (a primeira)

A ressalva anterior continua valendo e não precisa ser reaberta: os números
daquela medição (mistas 17, SLA a recalcular 6) não são reproduzíveis a partir da
regra escrita no SQL, com nenhuma variante da assinatura. Vieram de agregação em
JS que nunca foi validada. As duas medições posteriores vieram do SQL.

**A base está sincronizando ativamente** — 2 160 mensagens entraram na hora
anterior a esta medição. Reconfira imediatamente antes de executar; o passo B
congela a lista para que o que é apagado seja exatamente o que foi conferido.

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

**Reconfirmado em 18h**, e a proporção piorou: hoje 628 das 655 conversas estão no
Kanban, e as **171 alvo estão todas lá** (171 de 171). Rodando a sequência sem o
passo D no espelho novo:

```
ERROR: update or delete on table "conversations" violates foreign key constraint
       "conversation_kanban_state_workspace_id_conversation_id_fkey"
```

Fora de uma transação isso deixa a base meio migrada: mensagens apagadas,
conversas fantasma ainda lá — agora sem nenhuma mensagem e ainda na Inbox.

**2. A conferência não mostrava tudo que o DELETE apagava — e a correção anterior
não resolvia.** A consulta de conversas órfãs usava `JOIN` e nunca listava as 29
conversas que já hoje não têm mensagem. Trocar por `LEFT JOIN` **não bastou**:
o `HAVING` continuava com `count(*) FILTER`, que conta a linha `NULL` produzida
pelo `LEFT JOIN` numa conversa vazia — `coalesce(NULL, NULL, '')` devolve `''`,
que não pertence ao vocabulário técnico, então o filtro contava 1 e o `HAVING = 0`
eliminava a linha.

Medido antes da correção desta rodada: a consulta devolvia **171 linhas, todas
`fantasma_desta_limpeza`**, com as 29 ainda invisíveis — o defeito que a versão
anterior dizia ter consertado. Trocando para
`count(m.external_message_id) FILTER`, a consulta passa a devolver **171 + 29**.

O `DELETE` nunca esteve em risco: o passo E usa a lista congelada no passo B, que
é montada com `JOIN` e exige mensagem técnica. As 29 nunca foram alvo. Cego estava
o olho, não a mão.

**3. O UPDATE de SLA sobrescreve status terminal.** Sem filtro ele alcança todas
as linhas vivas para consertar poucas, e o `CASE` só emite
`waiting_operator`/`waiting_customer`.

**Reconfirmado em 18h, e o dano hoje é maior.** Não há mais nenhuma conversa
`resolved` na base — mas há **54 linhas `expired`**. Executando a versão sem
filtro no espelho: `UPDATE 59`, e o resultado é 53 `waiting_operator` + 6
`waiting_customer`, com **zero `expired`**. Ou seja: 54 violações de SLA
registradas seriam apagadas de uma vez, das quais só 3 são fantasma.

**4. Faltava filtro de `workspace_id`** nos dois DELETE.

**5. A conferência de SLA duplicava linha** quando duas mensagens dividem o mesmo
instante de âncora (`JOIN` virou `EXISTS`), e casava conversa só por `id`,
ignorando `workspace_id`.

O que o SQL prometia e **se confirmou**: `waha_webhook_events` não é tocado por
nada, e a FK de `conversation_sla_metrics` é `CASCADE` e leva as linhas junto.

### A sequência inteira foi executada e termina

Passos B a F na ordem obrigatória, sobre o espelho de 18h:

| conferência final | valor |
|---|---|
| técnicas restantes | **0** |
| conversas sem mensagem | **29** (as que já estavam assim; nenhuma nova) |
| conversas totais | **484** (655 − 171) |
| linhas de SLA | **19** (59 − 40 por cascata) |
| SLA com âncora inexistente | **0** |
| status de SLA | `expired` 11, `waiting_customer` 5, `waiting_operator` 3 |
| backup | alvo 171, mensagens 279, conversas 171, `sla_ajustadas` 3 |

Sem erro em nenhum passo.

---

## 3. As 12 conversas mistas são preservadas

Confirmado no espelho de 18h, rodando a sequência inteira e conferindo depois:

| conversa | chat | técnicas removidas | mensagens que restaram |
|---|---|---|---|
| `7a336196…` | `120363328209240027@g.us` | 19 | 1 663 |
| `76e7ef55…` | `558592827407@c.us` | 6 | 847 |
| `d8486c31…` | `120363425619645873@g.us` | 4 | 3 |
| `03faa3da…` | `120363419995426262@g.us` | 2 | 995 |
| `4799ff83…` | `120363363444637332@g.us` | 2 | 962 |
| `53cddba6…` | `120363328209240027@g.us` | 1 | 193 |
| `6c3af7c1…` | `120363419464143076@g.us` | 1 | 68 |
| `cca527f5…` | `120363419464143076@g.us` | 1 | 45 |
| `94621a1d…` | `558596917853@c.us` | 1 | 9 |
| `89751a13…` | `5585920039000@c.us` | 1 | 5 |
| `8b0e09cd…` | `558587667647@c.us` | 1 | 1 |
| `7cf4f4dc…` | `558596318752@c.us` | 1 | 1 |

Nenhuma foi apagada; as **4 792** mensagens reais continuam lá. Repare em
`d8486c31…`: 4 técnicas para 3 reais. É a que chega mais perto de virar fantasma,
e ainda assim sobrevive — a regra é "tem pelo menos uma real", não uma proporção.

São preservadas por construção, em dois níveis:

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

## 4. As linhas de SLA que sobrevivem e precisam de ajuste

Hoje são **3** (eram 2 na medição das 13h51), e a premissa registrada continua não
se aplicando a elas.

```
conversation_id                       status   op_ms  cli_ms  resp_ms  respostas
7a336196-0675-4f8b-add2-75d707f9a4a9  expired      0       0        0          0
cca527f5-6239-483d-a9c9-85ec38ee92b6  expired      0       0        0          0
d8486c31-7b19-4f05-af00-997d5802fa2b  expired      0       0        0          0   <- nova
```

**Todos os acumuladores estão zerados.** A linha não foi contaminada por
intervalos medidos a partir de evento técnico: ela foi **criada** pelo evento
técnico e nunca viu uma transição. Não há o que separar. O mesmo vale para as 40
linhas que somem por cascata — todas com acumulador zero.

Não é acaso das três: **todas** as 43 linhas ancoradas em evento técnico (as 40 que
somem por cascata e estas 3) têm acumulador zero. Das 19 que sobrevivem, 14 têm
acumulador não-zero — e nenhuma delas está ancorada em evento técnico. Os dois
conjuntos não se cruzam. A propriedade se manteve com a base 48 % maior.

**As três estão em `expired`, e o passo F as converte para `waiting_operator`.**
Isso é o objetivo da limpeza, não um efeito colateral: são violações fantasma —
o relógio começou a correr num evento que ninguém enviou e ninguém podia
responder, estourou sozinho, e a mensagem que o ancorava some no passo C.
Reancorar na mensagem real remanescente é o conserto.

O que não pode acontecer é isso vazar para fora da lista: sem o filtro, o UPDATE
converteria as **54** linhas `expired` da base, das quais só 3 são fantasma. Ver
seção 2, item 3.

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

Efeito medido no espelho de 18h, executando o passo F depois de B–E:

```
7a336196…  expired → waiting_operator
           first_inbound  2026-07-24 13:11:52 → 2026-04-28 11:48:42
           relógio        2026-07-24 13:11:52 → 2026-07-28 15:58:18
cca527f5…  expired → waiting_operator
           first_inbound  2026-07-24 18:39:47 → 2026-07-21 19:30:01
           relógio        2026-07-24 18:39:47 → 2026-07-22 15:18:47
d8486c31…  expired → waiting_operator
           first_inbound  2026-07-27 23:32:34 → 2026-07-27 23:32:36
           relógio        2026-07-27 23:32:34 → 2026-07-28 16:21:17
```

As três saem de `expired` — um atraso que nunca existiu, contado a partir de uma
notificação técnica — para `waiting_operator`, com o relógio na última mensagem
real. Nenhuma tem outbound: ninguém respondeu, e continua assim.

Repare em `7a336196…`: o `first_inbound_at` recua quase três meses, de 24/07 para
28/04. A âncora técnica estava mascarando o início real da conversa — o grupo
existia desde abril e a métrica achava que tinha começado há quatro dias.

E em `d8486c31…`: o ajuste é de **2 segundos** no `first_inbound_at`. É a conversa
com 4 técnicas para 3 reais da seção 3; o evento técnico chegou 2 segundos antes
da primeira mensagem real. Mesmo aqui o conserto importa, porque o
`waiting_since_at` sai de 27/07 para 28/07 e a linha deixa de estar estourada.

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
Fora de pico: o passo 7 remove 171 conversas da Inbox e dos quadros de Kanban.

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

Esperado hoje: 171 / 279 / 171 / 40 / 171 / 0 / 0 / 3. **`alvo` e `conversas` têm
que bater**, e `alvo` tem que bater com o total de `fantasma_desta_limpeza` do
passo 1. Se `alvo` vier maior que isso, algo mudou na classificação: pare.

O backup fica na base. Não o apague antes de a Inbox estar conferida.

### Passo C — mensagens técnicas

Rode o **passo 5**. Esperado: `DELETE 279` — o mesmo número do passo 0 e de
`backup_eventos_sistema.whatsapp_messages`.

```sql
SELECT count(*) FROM public.whatsapp_messages
WHERE workspace_id = 'default-workspace'
  AND lower(coalesce(payload_json->>'type', payload_json->'_data'->>'type', '')) IN
  ('ack','receipt','reaction','status','protocol','revoked','e2e_notification','notification_template','gp2','ciphertext');
-- esperado: 0
SELECT count(*) FROM public.waha_webhook_events;  -- esperado: inalterado (17 778)
```

### Passo D — estado operacional das conversas alvo

Rode os três DELETE do **passo 6**. Esperado: 171 / 0 / 0.

Sem isto o passo E aborta. São cartões de Kanban, entregas de automação e jobs de
envio de conversas que estão prestes a deixar de existir — tudo no backup.

### Passo E — conversas fantasma

Rode o **passo 7**. Esperado: `DELETE 171`.

```sql
SELECT count(*) FROM public.conversations WHERE workspace_id = 'default-workspace';
-- esperado: 484  (655 - 171)
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
| `conversas_totais` | 484 |
| `linhas_de_sla` | 13 |
| `sla_com_ancora_inexistente` | 0 |
| `eventos_brutos_preservados` | 17 778 (inalterado) |

Depois, na aplicação: abrir a Inbox e conferir que as 171 conversas sumiram, que
as 92 não lidas fantasma sumiram do contador, e que as 12 conversas mistas da
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

- **Não toca em `waha_webhook_events`.** Os 17 778 eventos brutos continuam
  explicando o que chegou, e são o que torna as mensagens reconstruíveis.
- **Não apaga contatos.** 73 das 171 conversas fantasma têm `contact_id`. O
  contato pode ser compartilhado com outra conversa ou ter sido criado à mão.
  Limpar contatos é decisão separada.
- **Não apaga as 29 conversas que já hoje não têm mensagem.** Elas ficaram assim
  por outro motivo, ninguém as auditou, e a proposta original as levava junto sem
  as listar. Continuam aparecendo no passo 1 como `ja_vazia_antes`.
- **Não trata `call_log`.** 197 mensagens em 30 conversas. Se a decisão de produto
  for tratá-las como técnicas, refaça a conferência inteira: as fantasmas vão de
  171 para 178 e as mistas de 12 para 33.
- **Não mexe nas bases SQLite locais.** São recriadas a partir das migrations.

---

## 8. Como isto foi validado

- PostgreSQL 16.14 em contêiner, schema aplicado a partir de
  `web/supabase/migrations` (duas migrations precisaram de um `storage.buckets`
  stub, irrelevante aqui). As colunas de `whatsapp_messages`, `conversations`,
  `conversation_sla_metrics`, `waha_webhook_events` e `contacts` foram conferidas
  uma a uma contra a introspecção PostgREST do projeto remoto: idênticas.
- Espelho somente-leitura dos dados reais (6 811 mensagens, 655 conversas, 59
  linhas de SLA, 628 cartões de Kanban). Nesta rodada o `payload_json` foi
  copiado **na íntegra**, não reconstruído — e todas as colunas do remoto têm par
  local, conferido na carga. A medição anterior usava um payload sintético
  `{"type": …, "_data": {"type": …}}`; os números batem entre os dois métodos.
- Sequência original rodada no espelho: **abortou** no DELETE de conversas.
- Sequência corrigida rodada no espelho: completa, com os números da seção 1.
- Rollback rodado em seguida: restaura byte a byte.
- `apps/api/test/eventos-sistema-cleanup-sql.test.ts` prende o SQL ao código:
  o vocabulário técnico do arquivo tem que ser exatamente
  `technicalMessageTypes` de `conversation-identity.ts`, os DELETE têm que
  continuar comentados, a ordem dos passos e os guards não podem sumir. Nove
  mutações no SQL foram testadas contra a suíte; todas quebram algum teste.

---

## Remedição de 2026-08-03 e o efeito dos três tipos novos

Medido às 16:01Z, com 17 009 mensagens e 673 conversas.

| | 18h (registro acima) | 2026-08-03 16:01Z |
|---|---|---|
| conversas fantasma | 171 (150 diretas + 21 grupo) | **134** (113 diretas + 21 grupo) |
| % das conversas | 26 % | **19 %** |
| fantasma com badge de não lida | 69, somando 92 | **67**, somando 89 |
| conversas mistas (preservar) | 12 | **14** |
| já vazias antes (não são alvo) | 29 | **29** |

O total de grupo (21) e o de já vazias (29) reproduzem exatamente. Foi o número
de diretas que caiu, e a explicação mais provável é o tempo: fantasma que recebe
mensagem real deixa de ser fantasma, e a base mais que dobrou entre as duas
medições.

### O que os três tipos novos mudam aqui

`album`, `pinned_message` e `group-history` entraram em `technicalMessageTypes`
em 2026-08. Medindo a mesma base com as duas listas:

| | lista antiga (11 tipos) | lista nova (14 tipos) |
|---|---|---|
| conversas fantasma | 134 | **134** |
| conversas mistas | 14 | **21** |

**A população-alvo da limpeza não muda.** Nenhuma conversa é 100 % `album`,
`pinned_message` ou `group-history` — os três sempre convivem com mensagens
reais, o que faz sentido: um cabeçalho de álbum vem junto das fotos, um aviso de
fixar vem num grupo ativo.

O que muda são **7 conversas que passam de "só mensagens reais" para "mistas"**.
Mistas são as que a limpeza **preserva**, então o efeito é conservador: sete
conversas a mais na lista do que não se apaga.

> Isto reforça o alerta da seção anterior, agora com número: acrescentar tipo ao
> vocabulário do código **não** atualiza as listas escritas à mão neste `.sql`.
> Quem retomar a limpeza precisa decidir se `album`, `pinned_message` e
> `group-history` entram nela — e, se entrarem, refazer a contagem, porque as 21
> mistas mudam de composição.
