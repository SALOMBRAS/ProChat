# Banco de dados e isolamento

## Provedores

O desenvolvimento local usa SQLite via `better-sqlite3`; runtime remoto usa
Supabase/PostgREST. Serviços críticos possuem implementações para ambos. Toda
consulta deve filtrar `workspaceId`/`workspace_id`.

## Domínios principais

- Conversas e mensagens: `conversations`, `whatsapp_messages`.
- Identidade: `contacts`, `contact_identifiers`,
  `pending_contact_identities`, `whatsapp_identities` e grupos WhatsApp.
- Contexto Inbox: `conversation_metadata`, etiquetas e eventos operacionais.
- Operação: usuários, equipes, filas e jobs de roteamento.
- Kanban: boards, stages, estado/eventos de conversa e automações idempotentes.
- SLA: configuração por workspace e `conversation_sla_metrics`.
- CRM: contatos, tags, pipelines, stages, leads, notas, atividades e campanhas.

## Regras de mudança

Migrations SQLite estão em `apps/api/migrations`; migrations Supabase em
`supabase/migrations`. Não crie nem aplique migration sem autorização explícita.
Não faça backfill, reset, truncate ou SQL remoto por inferência. Consulte os
serviços existentes antes de criar tabelas, endpoints ou consultas paralelas.
