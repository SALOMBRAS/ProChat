# Aplicação de M1 e M2 — procedimento

SQL em [`migrations-propostas-contatos.sql`](./migrations-propostas-contatos.sql).
Racional de produto em [`contatos-bloqueio-exclusao.md`](./contatos-bloqueio-exclusao.md).

- **M1** — bloqueio de contato (colunas em `contacts` e `conversations`, tabela `contact_block_events`)
- **M2** — soft delete (coluna `deleted_at`, tabela `contact_deletion_log`, RPC `chatpro_delete_contact`)
- **M3** — purga LGPD: **fora deste procedimento.** Só depois de M1 e M2 aplicadas e validadas.

M1 e M2 são independentes entre si. A ordem abaixo é a recomendada, não obrigatória.

## Estado da validação

> **Revalidado em 31/07/2026 contra `origin/main` @ `c396487`.** O banco remoto
> **não foi tocado**: PostgreSQL 16.14 em contêiner descartável e SQLite pelo
> runner real do repositório.
>
> **O SQL de M1 e M2 continua aplicando limpo e não precisou de ajuste.** Desde
> o `98a984d` que a PR #42 ancorou passaram 51 commits, e
> `git diff --stat 98a984d..origin/main -- web/apps/api/migrations web/supabase/migrations supabase/migrations`
> volta **vazio**: nenhuma migration versionada mudou. As quatro mudanças
> apontadas como risco não colidem:
>
> | mudança | veredito |
> | --- | --- |
> | INSERT nomeado em `contacts` (PR #32) | **não colide** — é código; o `catch` nu virou `conflictOn` |
> | adoção de opt-out (PR #36) | **não colide com M1/M2** — alcança só `opt_out_history`, que é território de M3 |
> | sanitização de nome de arquivo (PR #79) | **não colide** — toca `attachment-outbox.service.ts` e um teste, zero SQL |
> | coluna `chatsTotal` (PR #91, aberta) | **não colide por objeto** — vai para `whatsapp_sync_jobs`. **Colide por numeração**, ver abaixo |
>
> A `020_contact_identity_aliases.sql` também não colide — e M1 **depende** dela.
>
> **Duas correções que esta revalidação obrigou**, e que a #42 não tinha como ver:

### 1. A suíte de verificação Postgres não testava o que dizia testar

`migrations-m1-m2-verificacao.sql` criava a conversa de teste **sem
`last_status_change`**, que é `NOT NULL` no Supabase desde
`20260719000200_multioperator_conversation_management.sql:11` — anterior ao SHA
que a #42 ancorou. Medido agora, em PostgreSQL 16.14:

```text
INSERT antigo  -> ERROR: null value in column "last_status_change" ... violates not-null constraint
passo 10       -> (0 rows)          esperado: v1

INSERT corrigido -> ok
passo 10         -> v1
```

O passo 10 é **a asserção central de M2** — "soft delete preserva o vínculo da
conversa". Como a suíte roda com `\set ON_ERROR_STOP off` e é conferida a olho,
`(0 rows)` no lugar de `v1` **lia como sucesso**. A validação Postgres da #42
rodou sobre uma suíte que não afirmava nada nesse ponto.

Corrigido neste commit. O `.mjs` do SQLite não pegava o defeito porque lá
`lastStatusChange` é **nullable** (`011_multioperator_conversation_management.sql:8`)
— uma assimetria SQLite × Supabase preexistente, registrada aqui e **não**
corrigida, porque é assunto próprio e fora deste procedimento.

### 2. `ON_ERROR_STOP` estava desligado — e é por isso que a falha passou

A suíte rodava com `\set ON_ERROR_STOP off` e era conferida **a olho**, contra
uma lista de "ERRO ESPERADO" no rodapé. Foi isso que deixou `(0 rows)` no passo
10 passar por um mês: sem `ON_ERROR_STOP`, **nenhuma falha tem consequência**.

Agora fica **ligado**. O que impedia ligá-lo eram os nove comandos que *devem*
falhar — com `ON_ERROR_STOP on`, cada um abortaria a suíte. Eles passaram por
`pg_temp.espera_erro()`, que afirma **os dois lados**:

```sql
SELECT pg_temp.espera_erro(
  $q$UPDATE public.contacts SET block_state='invalido' WHERE ...$q$,
  'contacts_block_state_check', 'CHECK de block_state');
```

- se o comando **passa** quando devia falhar → `VERIFICACAO_FALHOU`, aborta;
- se falha com **outro** erro → `VERIFICACAO_FALHOU`, aborta;
- se falha pelo motivo certo → `NOTICE ok`.

Antes, o rodapé pedia para o operador conferir a olho que os erros dos passos
5, 6, 8, 12 e 14-18 eram os esperados. **Isso agora é asserção, não leitura.** A
função vive em `pg_temp` e some com a sessão: a suíte roda contra produção e não
deixa objeto para trás.

Medido em PostgreSQL 16.14, com M1 e M2 aplicadas:

```text
suíte corrigida   -> exit 0, 9 NOTICE ok, passo 10 devolve v1
suíte sem a coluna do passo 4 -> ERROR ... violates not-null constraint, exit 3
```

O `exit 3` é a diferença que importa: a falha virou **dura e scriptável**, em vez
de uma linha a mais no meio da saída.

### 3. As outras suítes de verificação do repositório

Varridas todas. **Nenhuma outra tem o mesmo defeito**, e a razão é diferente em
cada caso:

| arquivo | executável? | veredito |
| --- | --- | --- |
| `migrations-m1-m2-verificacao.sql` | sim, `psql -f` | **era o problema** — corrigido aqui |
| `migrations-m1-m2-verificacao.mjs` | sim, `node` | **ok** — tem `throws()`, reporta `no()` e sai com `process.exit(1)`; falha alto por construção |
| `migrations-propostas-contatos.sql` | por seção | **ok** — o procedimento já manda `ON_ERROR_STOP=1` ao aplicar |
| `migrations-propostas-eventos-sistema.sql` | por consulta | **não se aplica** — quase tudo comentado, para rodar consulta a consulta |
| `migrations-propostas-sla.sql` | por consulta | **não se aplica** — idem, 14 linhas ativas |
| `migrations-propostas-nome-de-arquivo.sql` | por passo | **registrar** — tem 44 linhas ativas e passos numerados; se alguém rodar com `psql -f`, um passo que falhe não interrompe os seguintes. Não corrigido aqui: é assunto da PR que o criou |

### 4. A numeração `021` foi reivindicada por outra PR

O arquivo de proposta manda M1 para `apps/api/migrations/022_contact_block.sql`.
A **PR #91**, aberta, reivindica `apps/api/migrations/021_whatsapp_sync_chats_total.sql`.

Não é falha — medido em banco descartável, os dois coexistem e ambos aplicam,
porque `022_contact_block.sql` ordena antes de `021_whatsapp…` (`c` < `w`). Mas
duas migrations com o mesmo número é dívida imediata. **Antes de aplicar,
renumere M1 e M2 para os próximos livres**, conferindo o diretório na hora:

```bash
ls web/apps/api/migrations/ | tail -3
ls web/supabase/migrations/ | tail -3
```

### 5. A armadilha do `.rollback.sql` **não** alcança M1/M2

O runner do SQLite varria `*.sql` e trataria um `.rollback.sql` como migration.
A #91 corrige com `!file.endsWith('.rollback.sql')`, e **o filtro é geral** —
cobre qualquer arquivo futuro com esse sufixo, não só o dela.

M1 e M2 não caem nessa armadilha **hoje**, porque os rollbacks delas são seções
dentro do arquivo de proposta, para rodar à mão, e não arquivos no diretório
varrido. Se alguém adotar a convenção da #91 e colar o rollback ao lado da
migration, aí sim passa a valer — e o rollback de M1 é bem mais destrutivo que o
de `chatsTotal`, porque derruba seis colunas de `contacts` e uma de
`conversations` **sem `IF EXISTS`**.

Uma correção ao que se dizia da armadilha, medida em SQLite descartável: o
`.rollback.sql` ordena **antes** da migration, não depois — em
`021_x.rollback.sql` contra `021_x.sql`, o caractere que difere é `r` (0x72)
contra `s` (0x73). Os dois modos de falha:

| estado do banco | o que acontecia |
| --- | --- |
| **novo** | o rollback roda primeiro e estoura `no such column`, **abortando o `migrate()` inteiro** — falha alta |
| **já com a migration aplicada** | o rollback é o único pendente: derruba a coluna **em silêncio**, registra-se em `schema_migrations`, e a migration nunca reaplica |

O desfecho é diferente do que se supunha; a correção é a mesma.

### ⚠️ A conferência envelhece

Tudo acima vale para o schema, que muda por PR. **As contagens de linha, não.**

> **Reexecute a conferência do passo 1 imediatamente antes de aplicar, não antes
> de revisar.** A sincronização de histórico escreve continuamente: um número
> conferido de manhã não descreve a base da tarde. Se o intervalo entre conferir
> e aplicar passar de alguns minutos com sincronização ativa, confira de novo.

---

## Estado da validação anterior

Revalidado em 28/07/2026 contra `origin/main` @ `98a984d`, em **PostgreSQL 16.14**
(contêiner descartável) e **SQLite 3.53.2** (runner real do repositório). O banco
remoto não foi tocado.

| | Resultado |
|---|---|
| M1 + M2 aplicam limpo | sim, nos dois bancos |
| Idempotentes (reaplicação) | sim, nos dois bancos |
| Rollback completo | sim — schema volta byte a byte ao original |
| RPC `chatpro_delete_contact` | soft / restore / purge-rejeitado / modo inválido / não encontrado / guarda de workspace — todos corretos |
| `security invoker`, grant só a `service_role` | confirmado |

O pré-requisito de código (INSERT nomeado) **já está em `main`** desde `998a871`.
Confirmado por execução: após M1 e M2 o INSERT nomeado funciona e o posicional
quebra. **Não há mais bloqueio de código para aplicar M1 e M2.**

---

## Antes de começar

1. **Backup.** No Supabase, Database → Backups, ou `pg_dump` da instância. Sem backup, não comece.
2. **Janela.** M1 e M2 são `ADD COLUMN` com default e `CREATE TABLE`. Não reescrevem tabela e não travam leitura em Postgres 16. A operação é rápida mesmo com a tabela populada.
3. **Confira o ponto de partida:**

```sql
-- deve retornar 0 linhas: nenhuma coluna de M1/M2 existe ainda
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='contacts'
   AND (column_name LIKE 'block%' OR column_name='deleted_at');
```

---

## Ordem de aplicação

### Passo 1 — M1 no Supabase

Copie a seção `M1 / Supabase` para `web/supabase/migrations/20260731000200_contact_block.sql` e aplique.

**Verificação:**

```sql
-- 5 colunas em contacts
SELECT column_name FROM information_schema.columns
 WHERE table_name='contacts' AND column_name LIKE 'block%' ORDER BY 1;
-- esperado: block_confirmed_at, block_last_error_safe, block_propagation,
--           block_requested_at, block_state

-- coluna em conversations
SELECT column_name FROM information_schema.columns
 WHERE table_name='conversations' AND column_name='blocked_at';

-- tabela de auditoria
SELECT to_regclass('public.contact_block_events');

-- os dois CHECK nomeados
SELECT conname FROM pg_constraint
 WHERE conrelid='public.contacts'::regclass AND contype='c'
   AND conname IN ('contacts_block_state_check','contacts_block_propagation_check');

-- nenhum contato existente foi alterado: todos em 'active'/'none'
SELECT block_state, block_propagation, count(*) FROM public.contacts GROUP BY 1,2;
```

### Passo 2 — M1 no SQLite

Copie a seção `M1 / SQLite` para `apps/api/migrations/022_contact_block.sql`.
O runner aplica sozinho no próximo boot da API.

**Verificação** (`node` a partir de `web/`):

```bash
node -e '
const D=require("better-sqlite3"); const db=new D(process.env.CHATPRO_DATABASE_PATH||"../.chatpro-data/backend.sqlite",{readonly:true});
console.log("contacts:", db.prepare("PRAGMA table_info(contacts)").all().map(c=>c.name).filter(n=>n.startsWith("block")));
console.log("conversations.blockedAt:", db.prepare("PRAGMA table_info(conversations)").all().some(c=>c.name==="blockedAt"));
console.log("contact_block_events:", db.prepare("SELECT count(*) c FROM sqlite_master WHERE type=\"table\" AND name=\"contact_block_events\"").get().c===1);
console.log("migration registrada:", db.prepare("SELECT count(*) c FROM schema_migrations WHERE id=\"022_contact_block.sql\"").get().c===1);
'
```

### Passo 3 — M2 no Supabase

Copie a seção `M2 / Supabase` para `web/supabase/migrations/20260731000300_contact_soft_delete.sql`.

**Verificação:**

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name='contacts' AND column_name='deleted_at';
SELECT to_regclass('public.contact_deletion_log');

-- a RPC existe, é security invoker e só service_role executa
SELECT p.proname, p.prosecdef AS security_definer, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='chatpro_delete_contact';
-- esperado: security_definer = f
--           proacl = {postgres=X/postgres,service_role=X/postgres}
```

### Passo 4 — M2 no SQLite

Copie a seção `M2 / SQLite` para `apps/api/migrations/023_contact_soft_delete.sql`.

> **Atenção:** o SQLite não tem RPC. O equivalente de `chatpro_delete_contact` é
> uma transação em `sqlite-domain.repository.ts`, com a mesma ordem de passos e o
> mesmo JSON de retorno. Isso é **código, não migration**, e não está neste
> procedimento. Até existir, o soft delete só funciona no Supabase.

### Passo 5 — reiniciar a API no Supabase

**Não pule.** A sondagem de capacidade de schema é **cacheada por cliente**: a API
descobre uma vez se `identifier_hash` e as colunas novas existem e guarda o
resultado. Sem reiniciar, o processo antigo continua achando que M1 e M2 não foram
aplicadas — e o sintoma é silencioso, não um erro.

- Supabase Dashboard → Settings → API → **Restart server**, ou
- reinicie o processo da API (`apps/api`) que fala com o Supabase.

Depois do restart, rode a suíte de verificação do próximo passo.

### Passo 6 — verificação funcional

Ver [testes de integração](#testes-de-integração) abaixo.

---

## Rollback

Reverte na **ordem inversa**: M2 primeiro, M1 depois. Validado por execução nos dois
bancos — o schema volta ao original, e no SQLite o `INSERT` posicional volta a
funcionar (prova de que a tabela é idêntica à de antes).

**Supabase** — as seções `M2 / ROLLBACK` e `M1 / ROLLBACK` do arquivo de proposta já
vêm com `BEGIN`/`COMMIT`:

```sql
-- 1) M2
BEGIN;
DROP FUNCTION IF EXISTS public.chatpro_delete_contact(text, text, text, text, text);
DROP INDEX IF EXISTS public.idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS public.contact_deletion_log;
DROP INDEX IF EXISTS public.idx_contacts_workspace_created_active;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS deleted_at;
COMMIT;

-- 2) M1  (índices e CHECKs ANTES das colunas)
BEGIN;
DROP INDEX IF EXISTS public.idx_contact_block_events_contact;
DROP TABLE IF EXISTS public.contact_block_events;
DROP INDEX IF EXISTS public.idx_conversations_blocked;
ALTER TABLE public.conversations DROP COLUMN IF EXISTS blocked_at;
DROP INDEX IF EXISTS public.idx_contacts_block_state;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_propagation_check;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_block_state_check;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_last_error_safe;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_confirmed_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_requested_at;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_propagation;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS block_state;
COMMIT;
```

**SQLite** — fora do runner (o runner já abre transação; `BEGIN` dentro dele falha).
Remova também as linhas de `schema_migrations`, senão o runner considera as
migrations aplicadas e não as reexecuta:

```sql
DROP INDEX IF EXISTS idx_contact_deletion_log_contact;
DROP TABLE IF EXISTS contact_deletion_log;
DROP INDEX IF EXISTS idx_contacts_workspace_created_active;
ALTER TABLE contacts DROP COLUMN deletedAt;

DROP INDEX IF EXISTS idx_contact_block_events_contact;
DROP TABLE IF EXISTS contact_block_events;
DROP INDEX IF EXISTS idx_conversations_blocked;
DROP INDEX IF EXISTS idx_contacts_block_state;
ALTER TABLE conversations DROP COLUMN blockedAt;
ALTER TABLE contacts DROP COLUMN blockLastErrorSafe;
ALTER TABLE contacts DROP COLUMN blockConfirmedAt;
ALTER TABLE contacts DROP COLUMN blockRequestedAt;
ALTER TABLE contacts DROP COLUMN blockPropagation;
ALTER TABLE contacts DROP COLUMN blockState;

DELETE FROM schema_migrations WHERE id IN ('022_contact_block.sql','023_contact_soft_delete.sql');
```

**Depois de qualquer rollback no Supabase, reinicie a API de novo** — pelo mesmo
motivo do passo 5, na direção contrária.

### O que o rollback NÃO desfaz

`ALTER TABLE ... DROP COLUMN` descarta os dados daquelas colunas. Reverter M2
**apaga o registro de quem foi soft-deleted** e o `contact_deletion_log` inteiro.
Os contatos voltam a aparecer como ativos, porque `deleted_at` deixou de existir.
Se já houver exclusões reais em produção, exporte antes:

```sql
\copy (SELECT * FROM public.contact_deletion_log) TO 'deletion-log-backup.csv' CSV HEADER
\copy (SELECT id, workspace_id, deleted_at FROM public.contacts WHERE deleted_at IS NOT NULL) TO 'soft-deleted-backup.csv' CSV HEADER
```

---

## Testes de integração

Duas suítes, para rodar **depois** de aplicar. Nenhuma escreve fora do workspace de
teste, e ambas limpam o que criam.

- **Supabase/Postgres:** [`migrations-m1-m2-verificacao.sql`](./migrations-m1-m2-verificacao.sql)

  ```bash
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=0 -f web/docs/migrations-m1-m2-verificacao.sql
  ```

- **SQLite:** [`migrations-m1-m2-verificacao.mjs`](./migrations-m1-m2-verificacao.mjs)

  ```bash
  cd web && node docs/migrations-m1-m2-verificacao.mjs            # usa CHATPRO_DATABASE_PATH
  cd web && node docs/migrations-m1-m2-verificacao.mjs --fresh    # banco novo em tmp, não toca no seu
  ```

Ambas saem com código 0 se tudo passar, 1 se algo falhar.

### O que as suítes provam

| # | Verificação | Por que importa |
|---|---|---|
| 1 | Colunas, índices e tabelas de M1 existem | a migration rodou |
| 2 | `CHECK` de `block_state`/`block_propagation` recusa valor inválido | a máquina de estados é imposta pelo banco |
| 3 | Índice parcial de bloqueio é usado com `<>` (`EXPLAIN`) | a reconciliação não vira varredura |
| 4 | Contatos preexistentes ficaram `active`/`none` | a migration não alterou dado nenhum |
| 5 | `INSERT` com colunas nomeadas funciona depois do `ADD COLUMN` | o pré-requisito de código continua valendo |
| 6 | `deleted_at` e `contact_deletion_log` existem | M2 rodou |
| 7 | RPC é `security invoker` e só `service_role` executa | segue a convenção das outras 18 RPCs |
| 8 | `soft` marca, grava log e **preserva** `conversations.contact_id` | soft delete é reversível e não dispara a FK |
| 9 | `restore` limpa `deleted_at` | a reversão funciona |
| 10 | `purge` é recusado com mensagem explícita | M3 não foi aplicada; falha alto, não corrompe |
| 11 | Modo inválido, contato inexistente e workspace vazio dão erro certo | contrato de erro estável |
| 12 | Telefone continua ocupado após soft delete | comportamento conhecido — ver "unicidade de telefone" na proposta |
| 13 | Reaplicar M1/M2 não quebra | idempotência |

---

## Riscos conhecidos

1. **Não reiniciar a API depois de aplicar** deixa o sistema achando que as
   migrations não existem, em silêncio. É o erro mais provável deste procedimento.
2. **Nunca reaplique M2 depois de M3.** O `CREATE OR REPLACE` troca o corpo *com*
   purga pelo corpo *sem* purga, com exit 0 e sem aviso, e o modo `purge` some.
3. **Telefone ocupado após soft delete** (item 12): esperado, mas visível ao
   operador. Precisa de decisão de UI antes de expor o soft delete.
4. **Soft delete no SQLite ainda não tem a transação equivalente à RPC.** Aplicar
   M2 no SQLite cria o schema, não o comportamento.
5. **Defeito preexistente da FK `conversations`** (`ON DELETE SET NULL` sem lista de
   colunas): não afeta M1 nem M2, que não apagam linha. Afeta M3, que já o
   contorna. Consertar a constraint é trabalho separado.
6. **Reconstrução do banco do zero não é suportada.** Confirmado por execução: as
   migrations de `supabase/migrations/` (raiz) e `web/supabase/migrations/` não
   reproduzem o schema sozinhas — `contacts` está numa, `conversations` na outra, e
   10 das 15 da raiz falham sem a outra. Aplique sempre no banco que já tem estado.
