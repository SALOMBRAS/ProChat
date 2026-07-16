// Starts the existing local runtime with Supabase and the real WhatsApp worker.
// Credentials remain only in the ignored CHATPRO_DATA_DIR tree.
process.env.DATABASE_PROVIDER = 'supabase';

if (process.env.WHATSAPP_DEMO_MODE !== 'false' || process.env.WHATSAPP_CONNECTION_ENABLED !== 'true') {
  throw new Error('dev:whatsapp requires WHATSAPP_DEMO_MODE=false and WHATSAPP_CONNECTION_ENABLED=true in .env.local');
}

await import('./local-runtime.mjs');
