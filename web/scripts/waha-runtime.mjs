import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wacallsRoot = resolve(root, '..', 'auditoria', 'WaCalls');
const wacallsExe = resolve(wacallsRoot, 'wacalls.exe');

if (process.env.WHATSAPP_DEMO_MODE !== 'false' || process.env.WHATSAPP_CONNECTION_ENABLED !== 'true') throw new Error('dev:waha requires WHATSAPP_DEMO_MODE=false and WHATSAPP_CONNECTION_ENABLED=true in .env.local');
if (!process.env.WAHA_API_KEY || process.env.WAHA_API_KEY.length < 32) throw new Error('dev:waha requires a WAHA_API_KEY with at least 32 characters in .env.local');

let stopping = false;
const children = [];

function run(command, args, name, cwd = root) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, PATH: `${resolve(wacallsRoot, '..', '..', 'tools', 'go', 'bin')};${process.env.PATH}` } });
  children.push(child);
  child.once('error', error => {
    if (!stopping) {
      console.error(`${name} could not start: ${error.message}`);
      shutdown(1);
    }
  });
  child.once('exit', (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(`${name} exited unexpectedly (${signal ?? code}).`);
      shutdown(1);
    }
  });
  return child;
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill('SIGTERM');
  const deadline = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    setTimeout(() => process.exit(exitCode), 1_000);
  }, 10_000);
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)))).then(() => {
    clearTimeout(deadline);
    process.exit(exitCode);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(0));
process.once('exit', () => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });

/**
 * `docker compose stop` marca o contêiner como parado de propósito, e é
 * exatamente isso que desliga o `restart: unless-stopped` declarado no compose:
 * depois dele a WAHA não volta nem quando a máquina reinicia. Em
 * desenvolvimento é o comportamento que se quer — um Ctrl-C derruba a pilha
 * inteira junto. Numa sincronização de histórico, que leva horas, é o defeito:
 * medido em 03/08/2026, o contêiner saiu com 143 (SIGTERM) no meio da corrida,
 * com os logs mostrando requisições completando normalmente até o último
 * segundo. Não foi carga; foi este `stop`.
 */
const manterWaha = process.argv.includes('--keep-waha');
const compose = run('docker', ['compose', '-f', 'docker-compose.waha.yml', 'up', '--wait'], 'waha');

// Inicia o WaCalls (serviço Go de chamadas) automaticamente
async function startWacalls() {
  const portaLivre = await new Promise(resolve => {
    const sonda = createServer();
    sonda.once('error', () => resolve(false));
    sonda.listen(8080, '127.0.0.1', () => sonda.close(() => resolve(true)));
  });
  if (!portaLivre) {
    console.log('[wacalls] porta 8080 já ocupada — assumindo que o WaCalls já está rodando.');
    return;
  }
  console.log('[wacalls] iniciando WaCalls em http://localhost:8080 ...');
  run(wacallsExe, ['-addr', ':8080', '-static', 'client/dist', '-db', 'wacalls.db', '-debug'], 'wacalls', wacallsRoot);
}

compose.once('exit', code => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return;
  }
  process.env.DATABASE_PROVIDER = 'supabase';
  process.env.WHATSAPP_PROVIDER = 'waha';
  void startWacalls();
  void import('./local-runtime.mjs');
});

const stopWaha = () => { if (stopping) return; stopping = true; if (manterWaha) { console.log('[waha] --keep-waha: o contêiner segue no ar para a sincronização continuar'); return; } spawn('docker', ['compose', '-f', 'docker-compose.waha.yml', 'stop'], { cwd: root, stdio: 'inherit' }); };
process.once('SIGINT', stopWaha);
process.once('SIGTERM', stopWaha);
