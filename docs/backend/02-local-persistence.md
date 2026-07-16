# Persistência local do backend

A API usa SQLite local via `better-sqlite3`, isolada do banco Electron. A migration está em `web/apps/api/migrations/001_initial_persistence.sql` e é aplicada pelo adaptador `src/persistence/database.ts`, com journal `schema_migrations`.

Os repositórios em `src/persistence/repositories.ts` expõem operações básicas por `workspaceId`; serviços podem depender de suas interfaces, não do driver. O banco de desenvolvimento padrão é `web/.chatpro-data/backend.sqlite` (ou `CHATPRO_DATABASE_PATH`) e permanece ignorado. Testes usam diretórios temporários removíveis.

O modelo inclui contatos, tags, opt-out, templates, CRM, campanhas e configurações. As relações usam chaves compostas por workspace para impedir referências cruzadas. `initializeWorkspaceCrm` cria etapas padrão somente quando chamado explicitamente.

A camada de domínio não depende de SQLite além dos adaptadores, permitindo implementar os mesmos contratos em PostgreSQL/Supabase depois. Ainda não há endpoints CRUD, autenticação, mensagens, envio, QR ou credenciais WhatsApp.
