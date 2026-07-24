# Validação remota — RPC de identidade de contato

Data: 2026-07-23 (America/Sao_Paulo)
Project ref: `vhfixhqfwusobczmubfu`

## Resultado

Aplicada com sucesso a migration `20260723000100_contact_identity_atomic.sql`.
O acesso automatizado foi feito com `npx supabase@2.109.1 db query --linked`,
usando a sessão administrativa já autenticada e o projeto já vinculado. Nenhuma
outra migration foi executada.

O primeiro ciclo de validação detectou duas referências ambíguas de
`phone_number` no SQL. O rollback automático removeu a função e seu registro
de histórico, sem dados remanescentes. A migration foi então corrigida para
qualificar `public.contacts.phone_number` e usar a constraint
`contacts_workspace_id_phone_number_key` no conflito de telefone. O segundo
dry-run e a aplicação final passaram.

## Preflight e dry-run

- A migration não constava em `supabase_migrations.schema_migrations` e a RPC
  ainda não existia antes da aplicação.
- Os campos `id`, `workspace_id` e `contact_id` das tabelas envolvidas são
  `text`; as PKs, FK composta e unicidades por workspace esperadas estavam
  presentes.
- O dry-run executou `BEGIN`, criou a função, concedeu `EXECUTE` a
  `service_role`, invocou a RPC e executou `ROLLBACK`.
- Após o rollback, não havia função remanescente.

## Confirmações pós-aplicação

- Assinatura: `public.chatpro_resolve_contact_identity(text, text, text, jsonb, text)`.
- A função usa `SECURITY DEFINER` com `search_path=public` e
  `service_role` tem `EXECUTE`.
- Foi executado `NOTIFY pgrst, 'reload schema'`.
- A chamada HTTP à RPC via PostgREST retornou HTTP 200, sem `PGRST202` nem
  `PGRST205`. O caso usado (`phone_number` nulo e identificadores vazios) não
  cria ou altera dados.

## Matriz remota

Em uma transação revertida, foram validados: criação e reutilização de contato
existente, reutilização por alias, isolamento entre workspaces, LID sem
telefone permanecendo pendente e identidade de grupo sem criação de contato.
Não houve erro `23503` nem chave duplicada não tratada.

Não foi executado um teste remoto de duas conexões concorrentes: o canal de
Management API não mantém transações entre chamadas e a política da tarefa não
permite persistir registros artificiais para esse ensaio. A função foi
validada no dry-run e nos testes locais de caracterização, e seus advisory
locks permanecem parte da implementação aplicada.

## Limites operacionais

Não houve deploy, push, backfill, merge, limpeza de dados de produção ou
alteração de frontend. O rollback inicial foi necessário apenas para corrigir
a migration antes da aplicação final; não há rollback pendente.
