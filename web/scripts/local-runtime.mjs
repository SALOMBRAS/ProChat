import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = resolve(root, 'apps', 'dashboard');
const nodeModules = resolve(root, 'node_modules');
const tsx = resolve(nodeModules, 'tsx', 'dist', 'cli.mjs');
const vite = resolve(nodeModules, 'vite', 'bin', 'vite.js');
/** O endereço em que o host aparece para os contêineres — o mesmo que
 *  `host.docker.internal` resolve com `extra_hosts: host-gateway`.
 *
 *  `os.networkInterfaces()` omite interface derrubada, e a `docker0` fica assim
 *  quando todos os contêineres estão em rede de compose. Por isso o fallback é
 *  `0.0.0.0` e não o loopback: ligar só no loopback calaria o webhook da WAHA em
 *  silêncio, que é pior do que continuar exposto e avisar. */
function apiHosts() {
  const iface = networkInterfaces().docker0;
  const gateway = iface?.find(entrada => entrada.family === 'IPv4')?.address;
  if (gateway) return `127.0.0.1,${gateway}`;
  console.warn('[local-runtime] docker0 sem IPv4 visível; a API vai escutar em 0.0.0.0.');
  console.warn('[local-runtime] Numa máquina em rede isso publica uma API sem autenticação.');
  console.warn('[local-runtime] Defina API_HOST=127.0.0.1,<gateway> em .env.local — veja docs/deploy-avaliacao.md.');
  return '0.0.0.0';
}

const databaseProvider = process.env.DATABASE_PROVIDER ?? 'sqlite';
const environment = {
  ...process.env,
  DATABASE_PROVIDER: databaseProvider,
  CHATPRO_DATA_DIR: resolve(root, '.chatpro-data'),
  CHATPRO_DATABASE_PATH: resolve(root, '.chatpro-data', 'backend.sqlite'),
  WHATSAPP_CONNECTION_ENABLED: process.env.WHATSAPP_CONNECTION_ENABLED ?? 'false',
  WHATSAPP_DEMO_MODE: process.env.WHATSAPP_DEMO_MODE ?? 'false',
  API_PORT: '3000',
  // Loopback para quem usa a máquina, e o gateway da bridge do Docker para o
  // contêiner da WAHA entregar o webhook (`host.docker.internal` resolve para
  // ele, não para 127.0.0.1). O que fica de fora é a interface de rede local:
  // esta API não tem autenticação, e em `0.0.0.0` qualquer um no mesmo /22 a
  // alcança. Sobrescreva com API_HOST se a sua bridge usar outro endereço.
  API_HOST: process.env.API_HOST ?? apiHosts(),
  WORKER_TRANSPORT_PORT: '3101',
};
const children = [];
let stopping = false;

function run(command, args, name, env = environment, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
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
  const deadline = setTimeout(() => process.exit(1), 10_000);
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)))).then(() => {
    clearTimeout(deadline);
    process.exit(exitCode);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(0));
process.once('exit', () => { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM'); });
const tsc = resolve(nodeModules, 'typescript', 'bin', 'tsc');
const build = run(process.execPath, [tsc, '-p', 'packages/contracts/tsconfig.json'], 'contracts');
build.once('exit', code => {
  if (code !== 0 || stopping) return;
  run(process.execPath, [tsx, 'apps/worker/src/main.ts'], 'worker');
  if (stopping) return;
  run(process.execPath, [tsx, 'apps/api/src/server.ts'], 'api');
  if (stopping) return;
  run(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], 'dashboard', environment, dashboard);
});
