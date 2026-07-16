# Persistência local do backend

## APIs de domÃ­nio

`/api/v1/domain` expÃµe contatos, tags, templates, CRM, opt-out, campanhas, configuraÃ§Ãµes e dashboard. Tags com vÃ­nculos nÃ£o podem ser excluÃ­das. Opt-out Ã© histÃ³rico e exclui contatos da preparaÃ§Ã£o de campanhas. Campanhas usam somente `draft`, `scheduled`, `ready`, `blocked` e `cancelled`, sem worker, envio ou conclusÃ£o. O pipeline padrÃ£o sÃ³ Ã© criado por `POST /crm/initialize`. NÃ£o hÃ¡ autenticaÃ§Ã£o nem integraÃ§Ã£o WhatsApp nesta fase.
A API usa SQLite local via `better-sqlite3`, isolada do banco Electron. A migration está em `web/apps/api/migrations/001_initial_persistence.sql` e é aplicada pelo adaptador `src/persistence/database.ts`, com journal `schema_migrations`.

Os repositórios em `src/persistence/repositories.ts` expõem operações básicas por `workspaceId`; serviços podem depender de suas interfaces, não do driver. O banco de desenvolvimento padrão é `web/.chatpro-data/backend.sqlite` (ou `CHATPRO_DATABASE_PATH`) e permanece ignorado. Testes usam diretórios temporários removíveis.

O modelo inclui contatos, tags, opt-out, templates, CRM, campanhas e configurações. As relações usam chaves compostas por workspace para impedir referências cruzadas. `initializeWorkspaceCrm` cria etapas padrão somente quando chamado explicitamente.

A camada de domínio não depende de SQLite além dos adaptadores, permitindo implementar os mesmos contratos em PostgreSQL/Supabase depois. Ainda não há endpoints CRUD, autenticação, mensagens, envio, QR ou credenciais WhatsApp.

## Providers de persistência

O provider atual e padrão é `sqlite`. `DATABASE_PROVIDER` aceita somente `sqlite` ou `supabase`; se omitido, permanece `sqlite`. Esta configuração ainda não troca o runtime da API: a próxima tarefa deve adaptar o serviço de domínio e o bootstrap para consumir os contratos assíncronos dos repositories antes de habilitar o provider Supabase.

O adapter Supabase está em `web/apps/api/src/persistence/supabase.ts` e `supabase-repositories.ts`; `provider.ts` é o ponto de composição que escolhe o adapter pela configuração. Ele usa `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` somente quando for explicitamente instanciado; nenhum valor real deve ser versionado. `SUPABASE_ANON_KEY` não é necessária neste backend, pois as operações de servidor usarão a chave de serviço quando a troca for aprovada.

Os repositories SQLite continuam em `repositories.ts`; os equivalentes Supabase cobrem contacts, tags e relações, templates, pipelines, stages, leads, campaigns, workspace settings, opt-out history, lead notes e activities. O contrato `WorkspaceRepository` aceita implementações síncronas (SQLite) ou assíncronas (Supabase), para que services não dependam do driver.

## Migrations Supabase

### Estado remoto validado

Em 2026-07-16, o projeto remoto `ChatPro` (`fdywcjkxxvyfkybcjgsu`, `sa-east-1`) foi vinculado e recebeu as migrations `20260715000100_chatpro_domain_rpcs.sql` e `20260716000100_grant_chatpro_service_role_table_access.sql`. A segunda corrige os privilegios de tabelas para `service_role`, preservando RLS e sem conceder acesso publico; tambem recarrega o schema do PostgREST.

A CLI foi executada via `npx --yes supabase@2.109.1`, sem instalacao global ou dependencia de runtime. Copie `web/.env.example` para o arquivo ignorado `web/.env.local` e preencha as variaveis somente localmente. `SUPABASE_SERVICE_ROLE_KEY` e exclusivamente de backend e nunca deve ser exposta ao frontend.

O smoke remoto validou settings, tags, contatos e vinculos, templates, pipeline, leads, movimentacao, notas, opt-out, campanhas, calculo de destinatarios, dashboard, listagens e isolamento por `workspace_id`. Os dados artificiais `smoke-*` foram removidos ao fim. SQLite continua disponivel para testes e rollback temporario; o runtime Supabase nao cria banco SQLite.

O paragrafo de preparacao historica abaixo descreve o estado anterior a esta validacao remota.

A migration PostgreSQL oficial está em `supabase/migrations/20260715000000_initial_chatpro_persistence.sql`. Ela preserva chaves compostas por `workspace_id`, FKs, índices, unicidade, constraints, timestamps e a tabela `campaign_recipients` do schema SQLite, além das tabelas de domínio. Aplique-a ao projeto Supabase existente em uma tarefa posterior, usando a CLI oficial vinculada ao projeto; esta preparação não executa link, push ou conexão remota.

RLS está habilitada em todas as tabelas da migration e não há políticas públicas. As políticas finais devem ser definidas junto da futura autenticação e do modelo de acesso por workspace.
