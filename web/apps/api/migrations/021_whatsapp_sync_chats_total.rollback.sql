-- O SQLite só ganhou DROP COLUMN na 3.35; `better-sqlite3` embarca versão bem
-- mais nova, então a forma direta serve.
ALTER TABLE whatsapp_sync_jobs DROP COLUMN chatsTotal;
