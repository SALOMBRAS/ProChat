import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'auditoria', 'WaCalls');
const wacallsExe = resolve(root, 'wacalls.exe');

/** Verifica se a porta 8080 está livre. */
async function portaLivre(porta) {
  return new Promise(resolve => {
    const sonda = createServer();
    sonda.once('error', () => resolve(false));
    sonda.listen(porta, '127.0.0.1', () => sonda.close(() => resolve(true)));
  });
}

const livre = await portaLivre(8080);
if (!livre) {
  console.log('[wacalls] porta 8080 já ocupada — assumindo que o WaCalls já está rodando.');
  process.exit(0);
}

console.log('[wacalls] iniciando WaCalls em http://localhost:8080 ...');

const child = spawn(wacallsExe, [
  '-addr', ':8080',
  '-static', 'client/dist',
  '-db', 'wacalls.db',
  '-debug'
], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PATH: `${resolve(root, '..', '..', 'tools', 'go', 'bin')};${process.env.PATH}` }
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[wacalls] encerrando WaCalls...');
  if (!child.killed) child.kill('SIGTERM');
  setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 10_000);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

child.once('exit', code => {
  if (!stopping && code !== 0) {
    console.error(`[wacalls] WaCalls saiu com código ${code}.`);
    process.exitCode = code ?? 1;
  }
});
