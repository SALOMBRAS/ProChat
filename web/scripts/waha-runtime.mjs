import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.WHATSAPP_DEMO_MODE !== 'false' || process.env.WHATSAPP_CONNECTION_ENABLED !== 'true') throw new Error('dev:waha requires WHATSAPP_DEMO_MODE=false and WHATSAPP_CONNECTION_ENABLED=true in .env.local');
if (!process.env.WAHA_API_KEY || process.env.WAHA_API_KEY.length < 32) throw new Error('dev:waha requires a WAHA_API_KEY with at least 32 characters in .env.local');
const compose = spawn('docker', ['compose', '-f', 'docker-compose.waha.yml', 'up', '--wait'], { cwd: root, stdio: 'inherit' }); let stopping = false;
const stop = () => { if (stopping) return; stopping = true; spawn('docker', ['compose', '-f', 'docker-compose.waha.yml', 'stop'], { cwd: root, stdio: 'inherit' }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop); compose.once('exit', code => { if (code !== 0) process.exitCode = code ?? 1; else { process.env.DATABASE_PROVIDER = 'supabase'; process.env.WHATSAPP_PROVIDER = 'waha'; void import('./local-runtime.mjs'); } });
