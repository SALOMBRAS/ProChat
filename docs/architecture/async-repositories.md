# Async repositories

The API now composes `route → validation/controller → DomainService → DomainRepository`.
SQLite remains the default provider; its synchronous driver is isolated in the SQLite adapter and exposed through asynchronous repository methods. Local compound operations retain SQLite transactions.

Bootstrap awaits provider composition before creating the HTTP server. `DATABASE_PROVIDER=supabase` validates its required configuration and is selected through the same factory, but remote domain CRUD remains deliberately disabled until the versioned RPC package for atomic compound operations is deployed and credentials are locally validated. No remote smoke test is performed by default.
