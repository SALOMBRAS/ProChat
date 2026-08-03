import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { defaultCorsAllowedOrigins, loadConfig } from '../src/config.js';

// A origem do dashboard deixa de ser `localhost:5173` no momento em que ele é
// publicado. Enquanto a lista era literal no código, o front publicado não
// falava com a API — e o navegador recusa antes de a requisição sair, então o
// sintoma aparece no console do usuário, não no log do servidor.
const directories: string[] = [];
const app = async (corsAllowedOrigins?: readonly string[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'chatpro-cors-'));
  directories.push(directory);
  return createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), developmentUserId: '00000000-0000-4000-8000-000000000001', ...(corsAllowedOrigins ? { corsAllowedOrigins } : {}) });
};

afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

describe('origens aceitas pelo navegador', () => {
  it('aceita a origem configurada e devolve o cabeçalho para ela', async () => {
    const server = await app(['https://painel.exemplo.com']);
    const response = await request(server).get('/health').set('origin', 'https://painel.exemplo.com').expect(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://painel.exemplo.com');
    expect(response.headers.vary).toBe('Origin');
  });

  it('recusa origem fora da lista configurada', async () => {
    const server = await app(['https://painel.exemplo.com']);
    await request(server).get('/health').set('origin', 'https://outro.exemplo.com').expect(403)
      .expect(response => expect(response.body.error.code).toBe('CORS_ORIGIN_DENIED'));
  });

  // O padrão de desenvolvimento não pode ter mudado: quem não configura nada
  // continua com o Vite funcionando como antes.
  it('preserva o dashboard local quando nada é configurado', async () => {
    const server = await app();
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173'])
      await request(server).get('/health').set('origin', origin).expect(200)
        .expect(response => expect(response.headers['access-control-allow-origin']).toBe(origin));
    await request(server).get('/health').set('origin', 'https://painel.exemplo.com').expect(403);
  });

  it('responde o preflight da origem configurada sem tocar na rota', async () => {
    const server = await app(['https://painel.exemplo.com']);
    await request(server).options('/api/v1/inbox/conversations').set('origin', 'https://painel.exemplo.com').expect(204)
      .expect(response => expect(response.headers['access-control-allow-methods']).toContain('POST'));
  });

  // Requisição sem `Origin` é servidor-para-servidor — o webhook da WAHA, por
  // exemplo. Bloqueá-la por CORS quebraria a ingestão sem nenhum ganho.
  it('deixa passar quem não manda origem nenhuma', async () => {
    const server = await app(['https://painel.exemplo.com']);
    await request(server).get('/health').expect(200)
      .expect(response => expect(response.headers['access-control-allow-origin']).toBeUndefined());
  });

  it('lê a lista da variável de ambiente, aparando espaço e barra final', () => {
    const config = loadConfig({ CORS_ALLOWED_ORIGINS: ' https://a.exemplo.com , https://b.exemplo.com/ ' } as NodeJS.ProcessEnv);
    expect(config.corsAllowedOrigins).toEqual(['https://a.exemplo.com', 'https://b.exemplo.com']);
    expect(loadConfig({} as NodeJS.ProcessEnv).corsAllowedOrigins).toEqual(defaultCorsAllowedOrigins);
  });
});
