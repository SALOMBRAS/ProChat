import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { defaultApiHosts, loadConfig } from '../src/config.js';
import { listenOn } from '../src/listen.js';
import type { RealtimeHub } from '../src/realtime.js';

// A API não tem autenticação: `x-workspace-id` vem cru do header. Escutar em
// `0.0.0.0` numa máquina com rede publica isso para a rede inteira — foi o caso
// medido em 03/08/2026, com a API respondendo em 192.168.20.151:3000 num /22.
// Escutar só no loopback calaria o webhook, porque o contêiner da WAHA alcança o
// host pelo gateway da bridge, não por 127.0.0.1. Daí a lista.
const directories: string[] = [];
const fechaveis: Array<{ close(callback: () => void): unknown }> = [];

async function servidor(hosts: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-hosts-'));
  directories.push(directory);
  const app = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), developmentUserId: '00000000-0000-4000-8000-000000000001' });
  const servers = await listenOn(app, app.locals.realtimeHub as RealtimeHub, hosts, 0);
  fechaveis.push(...servers);
  return { app, servers };
}

afterEach(async () => {
  await Promise.all(fechaveis.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('endereços em que a API escuta', () => {
  it('sobe um servidor por endereço da lista', async () => {
    const { servers } = await servidor(['127.0.0.1', '127.0.0.2']);
    expect(servers).toHaveLength(2);
    const enderecos = servers.map(server => (server.address() as AddressInfo).address);
    expect(enderecos).toEqual(['127.0.0.1', '127.0.0.2']);
  });

  it('atende de verdade em cada endereço, com portas independentes', async () => {
    const { servers } = await servidor(['127.0.0.1', '127.0.0.2']);
    for (const server of servers) {
      const { address, port } = server.address() as AddressInfo;
      const response = await fetch(`http://${address}:${port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok' });
    }
  });

  // Um endereço que não existe na máquina tem de falhar alto, no arranque, e não
  // deixar a API subir pela metade achando que está escutando onde não está.
  it('falha ao subir quando o endereço não existe na máquina', async () => {
    await expect(servidor(['203.0.113.7'])).rejects.toThrow(/203\.0\.113\.7/);
  });

  it('lê a lista de API_HOST e mantém 0.0.0.0 como padrão', () => {
    expect(loadConfig({ API_HOST: ' 127.0.0.1 , 172.17.0.1 ' } as NodeJS.ProcessEnv).apiHosts).toEqual(['127.0.0.1', '172.17.0.1']);
    expect(loadConfig({} as NodeJS.ProcessEnv).apiHosts).toEqual(defaultApiHosts);
    expect(defaultApiHosts).toEqual(['0.0.0.0']);
  });
});
