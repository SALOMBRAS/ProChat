import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

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

// O `npm run dev` não passa --env-file como os outros runtimes; sem isto as
// credenciais de bootstrap (CHATPRO_ADMIN_EMAIL/PASSWORD) e demais ajustes do
// .env.local nunca chegariam aos processos filhos.
const envFile = resolve(root, '.env.local');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
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
  // O prazo escala para SIGKILL em vez de desistir. Sair aqui, como antes,
  // deixava órfão todo filho que ignorasse o SIGTERM: o pai morria, eles
  // seguiam segurando 3000/3101/5173, e o arranque seguinte colidia com eles.
  //
  // Medido em 03/08/2026 contra o serviço de usuário: `systemctl stop` gastava
  // os 30 s inteiros do `TimeoutStopSec` e terminava com o systemd matando o
  // cgroup, ainda deixando processo para trás. Aconteceu duas vezes no mesmo
  // dia, e uma delas o SIGKILL atrasado alcançou a instância *seguinte* —
  // o vite subiu, anunciou a porta e morreu com SIGKILL segundos depois.
  //
  // O par 10 s / 30 s já estava na ordem certa; o defeito não era o número, era
  // o desligamento entregar ao systemd um trabalho que é dele.
  const deadline = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    // SIGKILL não se ignora, mas o evento `exit` ainda precisa de um tique para
    // chegar. Este último prazo é só para o processo não ficar preso caso um
    // filho já esteja zumbi, com o pai esperando um `exit` que não vem.
    setTimeout(() => process.exit(exitCode), 1_000);
  }, 10_000);
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve)))).then(() => {
    clearTimeout(deadline);
    process.exit(exitCode);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(0));
// SIGKILL, e não SIGTERM: quem continua vivo neste ponto já ignorou um SIGTERM,
// e esta é a última oportunidade de não deixar processo solto.
process.once('exit', () => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
/** Recusa subir quando alguma porta já está ocupada.
 *
 *  Sem isto o arranque ia longe antes de descobrir o problema: o `tsc` compilava,
 *  o worker subia, e só então a API ou o vite falhavam ao vincular — deixando
 *  meia pilha no ar e um erro que não diz o que aconteceu. Sob `Restart=always`
 *  isso vira laço: medido em 03/08/2026, 37 reinícios seguidos porque um runtime
 *  em primeiro plano segurava a 5173.
 *
 *  O código 78 (`EX_CONFIG`) é escolhido para a unit poder distingui-lo de uma
 *  queda comum com `RestartPreventExitStatus=78`: porta ocupada é problema de
 *  ambiente e reiniciar não conserta, então a unit deve parar e ficar visível
 *  em vez de girar a noite toda. */
const PORTA_LIVRE = 78;
async function portaOcupada(porta) {
  return new Promise(resolve => {
    const sonda = createServer();
    sonda.once('error', () => resolve(true));
    sonda.listen(porta, '127.0.0.1', () => sonda.close(() => resolve(false)));
  });
}
const ocupadas = [];
for (const [porta, dono] of [[3000, 'API'], [3101, 'worker'], [5173, 'dashboard']]) {
  if (await portaOcupada(porta)) ocupadas.push(`${porta} (${dono})`);
}
if (ocupadas.length) {
  console.error(`[local-runtime] recusando subir: porta em uso — ${ocupadas.join(', ')}.`);
  console.error('[local-runtime] Um desligamento anterior deixou processo para trás, ou há outro runtime no ar.');
  console.error("[local-runtime] Veja quem segura com: ss -ltnp | grep -E ':(3000|3101|5173) '");
  process.exit(PORTA_LIVRE);
}

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
