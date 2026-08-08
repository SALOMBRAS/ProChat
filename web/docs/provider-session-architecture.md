# Provider session interna

## Objetivo

`whatsapp_provider_sessions` representa uma conexão de WhatsApp específica de
um provider dentro de um workspace. Seu `id` é o `providerSessionId`: uma chave
interna e estável. Ela não é um JID, não é `providerDeviceId` e não deve ser
renderizada no Dashboard.

Uma sessão pública do ChatPro pode ter o mesmo nome em providers diferentes:

```text
workspace default + waha + comercial -> providerSessionId A
workspace default + gowa + comercial -> providerSessionId B
```

Mesmo que o `sessionId` seja igual, A e B são conexões diferentes. O resolver
consulta sempre os três valores (`workspaceId`, `provider`, `sessionId`) e só
devolve o UUID interno correspondente. Ele não cria sessões durante a consulta.

## Estado desta fase

O resolver possui adaptadores SQLite e Supabase, mas ainda não é usado pela
Inbox. `wahaSession` permanece nas tabelas e nos fluxos existentes para que
WAHA continue funcionando sem alteração de comportamento.

O GOWA já persiste seus vínculos em `whatsapp_provider_sessions`. Uma futura
adoção de WAHA precisará criar, de forma controlada, uma linha `provider=waha`
para cada sessão WAHA existente antes de qualquer backfill.

## Migração futura

Sem alterar `wahaSession` de imediato, a próxima migration deverá adicionar um
`providerSessionId` inicialmente anulável às tabelas dependentes de canal:

- `waha_webhook_events`;
- `whatsapp_messages`;
- `conversations`;
- `whatsapp_identities`;
- `whatsapp_groups`;
- `whatsapp_sync_jobs`;
- `inbox_outbox_jobs`.

O backfill deverá resolver cada linha antiga por `workspaceId + provider=waha +
wahaSession`, registrar exceções sem apagar dados e validar a cobertura antes
de tornar a nova referência obrigatória. As chaves e consultas de deduplicação
também deverão trocar o escopo legado por `providerSessionId`.

`contacts` e `contact_identifiers` não recebem `providerSessionId`: eles são
entidades de CRM do workspace e podem representar o mesmo cliente em mais de
uma conexão WhatsApp.
