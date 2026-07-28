# Aplicação de M1 e M2 — procedimento

SQL em [`migrations-propostas-contatos.sql`](./migrations-propostas-contatos.sql).
Racional de produto em [`contatos-bloqueio-exclusao.md`](./contatos-bloqueio-exclusao.md).

- **M1** — bloqueio de contato (colunas em `contacts` e `conversations`, tabela `contact_block_events`)
- **M2** — soft delete (coluna `deleted_at`, tabela `contact_deletion_log`, RPC `chatpro_delete_contact`)
- **M3** — purga LGPD: **fora deste procedimento.** Só depois de M1 e M2 aplicadas e validadas.

M1 e M2 são independentes entre si. A ordem abaixo é a recomendada, não obrigatória.

## Estado da validação

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

Copie a seção `M1 / Supabase` para `web/supabase/migrations/20260727000100_contact_block.sql` e aplique.

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

Copie a seção `M1 / SQLite` para `apps/api/migrations/021_contact_block.sql`.
O runner aplica sozinho no próximo boot da API.

**Verificação** (`node` a partir de `web/`):

```bash
node -e '
const D=require("better-sqlite3"); const db=new D(process.env.CHATPRO_DATABASE_PATH||"../.chatpro-data/backend.sqlite",{readonly:true});
console.log("contacts:", db.prepare("PRAGMA table_info(contacts)").all().map(c=>c.name).filter(n=>n.startsWith("block")));
console.log("conversations.blockedAt:", db.prepare("PRAGMA table_info(conversations)").all().some(c=>c.name==="blockedAt"));
console.log("contact_block_events:", db.prepare("SELECT count(*) c FROM sqlite_master WHERE type=\"table\" AND name=\"contact_block_events\"").get().c===1);
console.log("migration registrada:", db.prepare("SELECT count(*) c FROM schema_migrations WHERE id=\"021_contact_block.sql\"").get().c===1);
'
```

### Passo 3 — M2 no Supabase

Copie a seção `M2 / Supabase` para `web/supabase/migrations/20260727000200_contact_soft_delete.sql`.

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

Copie a seção `M2 / SQLite` para `apps/api/migrations/022_contact_soft_delete.sql`.

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

DELETE FROM schema_migrations WHERE id IN ('021_contact_block.sql','022_contact_soft_delete.sql');
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
