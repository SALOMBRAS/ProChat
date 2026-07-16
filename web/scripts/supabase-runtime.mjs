// Reuse the coordinated local runtime while selecting the remote persistence
// adapter. Credentials are read only from the ignored .env.local file.
process.env.DATABASE_PROVIDER = 'supabase';
process.env.WHATSAPP_CONNECTION_ENABLED = 'false';
process.env.WHATSAPP_DEMO_MODE = 'true';

await import('./local-runtime.mjs');
