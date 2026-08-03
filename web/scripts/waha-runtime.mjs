import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.WHATSAPP_DEMO_MODE !== 'false' || process.env.WHATSAPP_CONNECTION_ENABLED !== 'true') throw new Error('dev:waha requires WHATSAPP_DEMO_MODE=false and WHATSAPP_CONNECTION_ENABLED=true in .env.local');
if (!process.env.WAHA_API_KEY || process.env.WAHA_API_KEY.length < 32) throw new Error('dev:waha requires a WAHA_API_KEY with at least 32 characters in .env.local');
/**
 * `docker compose stop` marca o contêiner como parado de propósito, e é
 * exatamente isso que desliga o `restart: unless-stopped` declarado no compose:
 * depois dele a WAHA não volta nem quando a máquina reinicia. Em
 * desenvolvimento é o comportamento que se quer — um Ctrl-C derruba a pilha
 * inteira junto. Numa sincronização de histórico, que leva horas, é o defeito:
 * medido em 03/08/2026, o contêiner saiu com 143 (SIGTERM) no meio da corrida,
 * com os logs mostrando requisições completando normalmente até o último
 * segundo. Não foi carga; foi este `stop`.
 *
 * A escolha mora aqui, e não na política de restart, porque a política é global
 * e não distingue as duas intenções: trocar `unless-stopped` por `always` faria
 * a WAHA ressuscitar no boot mesmo depois de uma parada deliberada, comprando a
 * corrida longa ao preço de tirar do operador a capacidade de desligar. Quem
 * sabe qual das duas intenções vale é quem invoca o runtime, então ela entra
 * como opção explícita, com o comportamento de desenvolvimento como padrão.
 */
const manterWaha = process.argv.includes('--keep-waha');
const compose = spawn('docker', ['compose', '-f', 'docker-compose.waha.yml', 'up', '--wait'], { cwd: root, stdio: 'inherit' }); let stopping = false;
const stop = () => { if (stopping) return; stopping = true; if (manterWaha) { console.log('[waha] --keep-waha: o contêiner segue no ar para a sincronização continuar'); return; } spawn('docker', ['compose', '-f', 'docker-compose.waha.yml', 'stop'], { cwd: root, stdio: 'inherit' }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop); compose.once('exit', code => { if (code !== 0) process.exitCode = code ?? 1; else { process.env.DATABASE_PROVIDER = 'supabase'; process.env.WHATSAPP_PROVIDER = 'waha'; void import('./local-runtime.mjs'); } });
