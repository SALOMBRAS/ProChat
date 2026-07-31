# Divergências de schema entre SQLite e Supabase

**31/07/2026. Registro, não correção.** A regra crítica nº 1 do `CLAUDE.md` manda
preservar compatibilidade entre os dois provedores. Este documento lista onde os
schemas **divergem hoje**, para a correção ser decidida com a lista à vista em vez
de descoberta uma por vez.

Nenhuma das divergências abaixo foi corrigida. Nenhuma migration foi criada ou
aplicada, e o banco remoto não foi consultado nem escrito.

---

## Método

Os dois schemas foram **construídos e introspectados**, não lidos:

- **SQLite** — as 21 migrations de `web/apps/api/migrations/` aplicadas pelo
  runner real do repositório, num banco em memória, e lidas por
  `PRAGMA table_info`.
- **PostgreSQL 16.14** — contêiner descartável, com as duas árvores
  (`supabase/migrations/` e `web/supabase/migrations/`) aplicadas, e lidas por
  `information_schema.columns`.

Comparação por `(tabela, coluna)` normalizados de `camelCase` para `snake_case`.

**357 colunas em comum. 10 divergem em nulabilidade** — e a separação entre elas
é o resultado que importa.

---

## As duas divergências reais

Colunas que **não** são chave primária e cuja nulabilidade difere. São duas.

### `conversations.last_status_change`

| | |
| --- | --- |
| SQLite | `ALTER TABLE conversations ADD COLUMN lastStatusChange TEXT;` — **nullable** |
| Supabase | `ALTER TABLE public.conversations ALTER COLUMN last_status_change SET NOT NULL;` — **NOT NULL** |

<sub>— `011_multioperator_conversation_management.sql:8` e
`20260719000200_multioperator_conversation_management.sql:11`</sub>

A migration do Supabase adiciona a coluna nullable, faz backfill com
`COALESCE(last_status_change, updated_at)` e **então** aplica o `NOT NULL`. A do
SQLite faz o backfill e **para antes** do terceiro passo.

**Custo já pago.** Foi essa divergência que escondeu, por um mês, que a suíte de
verificação de M1/M2 não testava a asserção central de M2: o `INSERT` de teste
omitia a coluna, quebrava só no Postgres, e o `.mjs` do SQLite passava 34/34
porque ali a coluna aceita nulo. Detalhes na PR #94.

**É a mais perigosa das duas**, porque a assimetria faz o teste local mentir
sobre o remoto — que é exatamente o modo de falha que a regra nº 1 existe para
impedir.

### `inbox_outbox_jobs.client_request_id`

| | |
| --- | --- |
| SQLite | `clientRequestId TEXT` — **nullable** |
| Supabase | `client_request_id text NOT NULL` |

O campo é a chave de idempotência do envio de anexo, gerada no cliente e exigida
pelo Zod do controller (`z.string().uuid()`), então **na prática nunca chega
nulo** por nenhum caminho da aplicação. A divergência é latente: só apareceria
num `INSERT` direto ou num teste que montasse a linha à mão — e no SQLite ele
passaria.

---

## As oito que não são divergência

Todas as outras oito são a **mesma coisa, uma vez por tabela**: a coluna é
`PRIMARY KEY` e o SQLite reporta `notnull=0`.

```text
conversation_kanban_events.id      kanban_boards.id       routing_jobs.id
kanban_stages.id                   routing_queues.id      teams.id
workspace_users.id                 workspace_sla_config.workspace_id
```

Não é descuido de quem escreveu as migrations: **o SQLite permite `NULL` numa
`PRIMARY KEY` que não seja `INTEGER PRIMARY KEY`**, por compatibilidade com
versões antigas, e `PRAGMA table_info` reflete isso. No PostgreSQL, `PRIMARY KEY`
implica `NOT NULL` sempre.

É sistêmico e vale para **toda** tabela com PK textual. Corrigir exigiria
acrescentar `NOT NULL` explícito a cada PK do SQLite — mudança mecânica, ampla, e
sem efeito prático enquanto todo caminho de escrita passar pela aplicação, que
sempre gera o id.

**Registrado como conhecido e classificado como não-defeito**, para a próxima
varredura não gastar tempo redescobrindo.

---

## O que esta varredura NÃO cobriu

Comparou apenas **nulabilidade de colunas em comum**. Ficam fora, e continuam
**não identificados**:

- **Tipos.** `TEXT` no SQLite contra `timestamptz`, `numeric`, `jsonb`, `uuid` no
  Postgres é a norma do projeto, não divergência — mas uma diferença real de
  precisão ou de faixa passaria despercebida aqui.
- **`CHECK`, `DEFAULT` e `UNIQUE`.** Não comparados.
- **Tabelas que existem só de um lado.** A varredura olhou a interseção; o que
  existe só numa árvore não aparece.
- **Funções e RPCs.** O SQLite não tem, por construção; toda RPC do Supabase é,
  por definição, lógica que o SQLite implementa em TypeScript. Comparar as duas
  exigiria ler cada par.
- **O estado real do banco remoto.** Tudo aqui vem das migrations versionadas. Se
  o remoto divergir delas — e o repositório já registrou esse caso em
  `kanban-sla-remote-reconciliation.md` —, a lista acima descreve o que deveria
  estar lá, não o que está.

---

## Como repetir

A comparação é reprodutível e não toca o remoto. O roteiro:

1. Aplicar `web/apps/api/migrations/*.sql` (menos `.rollback.sql`) num SQLite em
   memória, pelo runner real, e ler `PRAGMA table_info` de cada tabela.
2. Subir um PostgreSQL descartável, aplicar `supabase/migrations/` e
   `web/supabase/migrations/` na ordem, e ler `information_schema.columns`.
3. Normalizar `camelCase` → `snake_case` e comparar `is_nullable` por
   `(tabela, coluna)`.
4. Separar as que são `pk=1` no SQLite: essas são o artefato descrito acima, não
   divergência.

O passo 4 é o que evita relatar dez problemas quando existem dois.
