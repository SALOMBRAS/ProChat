import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = resolve(root, 'node_modules');
const tsx = resolve(nodeModules, 'tsx', 'dist', 'cli.mjs');
const vite = resolve(nodeModules, 'vite', 'bin', 'vite.js');
const databaseProvider = process.env.DATABASE_PROVIDER ?? 'sqlite';
const environment = {
  ...process.env,
  DATABASE_PROVIDER: databaseProvider,
  CHATPRO_DATA_DIR: resolve(root, '.chatpro-data'),
  CHATPRO_DATABASE_PATH: resolve(root, '.chatpro-data', 'backend.sqlite'),
  WHATSAPP_CONNECTION_ENABLED: 'false',
  WHATSAPP_DEMO_MODE: 'false',
  API_PORT: '3000',
  WORKER_TRANSPORT_PORT: '3101',
};
const children = [];
let stopping = false;

function run(command, args, name, env = environment) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
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
  run(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], 'dashboard');
});
