# Reconciliação remota: Kanban e SLA

Data: 2026-07-23

## Escopo e segurança

- Projeto Supabase: `vhfixhqfwusobczmubfu`.
- Nenhuma operação destrutiva foi executada: sem `DELETE`, `TRUNCATE`, reset, backfill, mensagens ou movimentações de conversa.
- A execução usou a CLI oficial via `npx supabase`, já autenticada e vinculada ao projeto.

## Inventário inicial

O histórico remoto não continha as versões `20260720000300`, `20260720000400` nem `20260720000500`. A inspeção do `pg_class` e do PostgREST confirmou a ausência de:

- `workspace_sla_config`
- `conversation_sla_metrics`
- `kanban_boards`
- `kanban_stages`
- `conversation_kanban_state`
- `conversation_kanban_events`
- `kanban_automation_deliveries`

## Dry-run e aplicação

Cada grupo foi executado dentro de `BEGIN`/`ROLLBACK`. Os dry-runs concluíram sem erro e a consulta posterior confirmou que nenhum objeto permaneceu.

Foram aplicadas somente as migrations relacionadas:

1. `20260720000300_inbox_sla.sql`
2. `20260720000400_operational_kanban.sql`
3. `20260720000500_kanban_automation_idempotency.sql` — necessária porque a tabela de idempotência, usada pela automação Kanban existente, também estava ausente.

Depois da aplicação, as três versões foram registradas no histórico remoto. O schema final contém as sete tabelas, os índices SLA/Kanban esperados e RLS ativo. Os grants de `service_role` são definidos pelas migrations aplicadas.

## PostgREST e runtime

Foi executado `NOTIFY pgrst, 'reload schema'`. O PostgREST remoto respondeu `200` para `kanban_boards`, sem `PGRST202` ou `PGRST205`.

Um harness efêmero da API, usando `.env.local` e o provider Supabase, validou:

- `GET /api/v1/inbox/kanban/boards` — 200
- `GET /api/v1/workspace/sla-config` — 200
- `GET /api/v1/inbox/operations/sla-summary` — 200
- `GET /api/v1/inbox/conversations` — 200
- Um ciclo completo do timer SLA (mais de 60 segundos) — sem `SLA tick failed` ou erro de tabela ausente.

A consulta de métricas de uma conversa sem registro SLA pode retornar 404 por ausência legítima de métrica; isso não representa falha estrutural.

Durante a inicialização do harness houve logs de conflito de sincronização de identidade WAHA já fora do escopo desta reconciliação. Nenhuma alteração foi feita em contatos, aliases ou WAHA.
