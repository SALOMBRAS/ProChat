import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { LinkPreviewService } from '../src/services/link-preview.service.js';
import { createApp } from '../src/app.js';

const page = (body: string) => `<!doctype html><html><head>${body}</head><body></body></html>`;
const html = (body: string, status = 200) => new Response(page(body), { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

type FetchStub = ReturnType<typeof vi.fn>;
const service = (fetchImpl: FetchStub, now?: () => number) => new LinkPreviewService({ fetchImpl: fetchImpl as never, ...(now ? { now } : {}) });

describe('LinkPreviewService extração', () => {
  it('lê OG na ordem property-depois-content e resolve URL relativa de imagem', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html('<meta content="Café" property="og:title"><meta content="/cover.png" property="og:image"><meta content="Cafeteria" property="og:site_name">'));
    const preview = await service(fetchImpl).preview('https://example.com/post');
    expect(preview).toMatchObject({ url: 'https://example.com/post', domain: 'example.com', title: 'Café', imageUrl: 'https://example.com/cover.png', siteName: 'Cafeteria', provider: 'generic', faviconUrl: 'https://example.com/favicon.ico' });
  });

  it('lê OG na ordem content-depois-property', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html('<meta property="og:title" content="Chá">'));
    await expect(service(fetchImpl).preview('https://example.com/a')).resolves.toMatchObject({ title: 'Chá' });
  });

  it('cai no twitter: quando og: falta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html('<meta name="twitter:title" content="Pássaro"><meta name="twitter:description" content="Azul">'));
    await expect(service(fetchImpl).preview('https://example.com/b')).resolves.toMatchObject({ title: 'Pássaro', description: 'Azul' });
  });

  it('cai no <title> e na meta description quando nem og: nem twitter: existem', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html('<title>Página simples</title><meta name="description" content="Resumo">'));
    await expect(service(fetchImpl).preview('https://example.com/c')).resolves.toMatchObject({ title: 'Página simples', description: 'Resumo' });
  });

  it('decodifica entidades, com &amp; por último para não decodificar duas vezes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html('<meta property="og:title" content="Fish &amp; Chips &lt;3 &amp;amp; cia">'));
    await expect(service(fetchImpl).preview('https://example.com/d')).resolves.toMatchObject({ title: 'Fish & Chips <3 &amp; cia' });
  });

  it('usa /favicon.ico do domínio quando a página não declara ícone', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html('<meta property="og:title" content="T">'));
    await expect(service(fetchImpl).preview('https://example.com/e')).resolves.toMatchObject({ faviconUrl: 'https://example.com/favicon.ico' });
  });

  it('segue redirect revalidando o destino e grava a URL final', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(redirect('https://cdn.example.com/final'))
      .mockResolvedValueOnce(html('<meta property="og:title" content="Destino">'));
    const preview = await service(fetchImpl).preview('https://example.com/curto');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(preview).toMatchObject({ url: 'https://cdn.example.com/final', domain: 'cdn.example.com', title: 'Destino' });
  });

  it('recusa conteúdo que não é HTML com 422', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    await expect(service(fetchImpl).preview('https://example.com/doc.pdf')).rejects.toMatchObject({ status: 422 });
  });

  it('recusa página sem nenhuma informação de prévia com 422', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html(''));
    await expect(service(fetchImpl).preview('https://example.com/vazia')).rejects.toMatchObject({ status: 422 });
  });
});

describe('LinkPreviewService enriquecimento', () => {
  it('YouTube: oEmbed preenche autor e miniatura sem derrubar o título da página', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(html('<title>Vídeo X</title>'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ author_name: 'Canal Y', thumbnail_url: 'https://i.ytimg.com/vi/abc/hqdefault.jpg', title: 'Título oEmbed' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const preview = await service(fetchImpl).preview('https://www.youtube.com/watch?v=abc');
    expect(preview).toMatchObject({ provider: 'youtube', title: 'Vídeo X', author: 'Canal Y', imageUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' });
    expect(String(fetchImpl.mock.calls[1][0])).toContain('youtube.com/oembed');
  });

  it('TikTok: oEmbed quebrado não derruba a prévia, que segue só com OG', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(html('<meta property="og:title" content="Dança">'))
      .mockResolvedValueOnce(new Response('erro', { status: 500 }));
    await expect(service(fetchImpl).preview('https://www.tiktok.com/@user/video/1')).resolves.toMatchObject({ provider: 'tiktok', title: 'Dança' });
  });

  it('GitHub: repo ganha descrição com estrelas e linguagem, com User-Agent próprio', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(html('<meta property="og:title" content="owner/repo">'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ description: 'Ferramenta', stargazers_count: 123, language: 'TypeScript' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const preview = await service(fetchImpl).preview('https://github.com/owner/repo');
    expect(preview).toMatchObject({ provider: 'github', author: 'owner', description: 'Ferramenta — ★ 123 · TypeScript' });
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://api.github.com/repos/owner/repo');
    expect((fetchImpl.mock.calls[1][1] as { headers: Record<string, string> }).headers['user-agent']).toBe('chatpro-link-preview');
  });
});

describe('LinkPreviewService SSRF', () => {
  it.each(['http://127.0.0.1/admin', 'http://localhost:3000/health', 'http://192.168.0.1/', 'http://10.0.0.4/', 'http://169.254.1.1/latest/meta-data', 'http://[::1]/', 'http://intranet.local/', 'http://service.internal/'])('recusa %s sem buscar nada', async (url) => {
    const fetchImpl = vi.fn();
    await expect(service(fetchImpl).preview(url)).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('recusa esquema que não é http(s)', async () => {
    const fetchImpl = vi.fn();
    await expect(service(fetchImpl).preview('ftp://example.com/arquivo')).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('recusa redirect para dentro da rede depois de uma única busca', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect('http://127.0.0.1/interno'));
    await expect(service(fetchImpl).preview('https://example.com/curto')).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('LinkPreviewService cache', () => {
  it('repetição do mesmo link custa uma única busca', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html('<meta property="og:title" content="T">'));
    const instance = service(fetchImpl);
    await instance.preview('https://example.com/a');
    await instance.preview('https://example.com/a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falha também fica cacheada: a segunda tentativa não busca de novo', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const instance = service(fetchImpl);
    await expect(instance.preview('https://example.com/doc')).rejects.toMatchObject({ status: 422 });
    await expect(instance.preview('https://example.com/doc')).rejects.toMatchObject({ status: 422 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('rota GET /api/v1/inbox/link-preview', () => {
  const directories: string[] = [];
  const apps: Array<{ locals: { persistenceDatabase?: { close(): void } } }> = [];
  const headers = { 'x-workspace-id': 'workspace-a', 'x-user-id': 'user-a' };
  afterEach(() => { vi.unstubAllGlobals(); apps.splice(0).forEach(instance => instance.locals.persistenceDatabase?.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
  const app = async () => { const directory = mkdtempSync(join(tmpdir(), 'chatpro-linkpreview-')); directories.push(directory); const instance = await createApp({ port: 0, nodeEnv: 'test', workerTransportUrl: 'http://127.0.0.1:1/internal/transport', workerTransportTimeoutMs: 20, databaseProvider: 'sqlite', databasePath: join(directory, 'api.sqlite'), developmentUserId: '00000000-0000-4000-8000-000000000001' }); apps.push(instance); return instance; };

  it('devolve 200 com a prévia raspada pela retaguarda', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html('<meta property="og:title" content="Notícia">')));
    const response = await request(await app()).get(`/api/v1/inbox/link-preview?url=${encodeURIComponent('https://example.com/noticia')}`).set(headers).expect(200);
    expect(response.body).toMatchObject({ url: 'https://example.com/noticia', title: 'Notícia', provider: 'generic' });
  });

  it('devolve 400 para endereço de rede interna', async () => {
    const stub = vi.fn(); vi.stubGlobal('fetch', stub);
    await request(await app()).get(`/api/v1/inbox/link-preview?url=${encodeURIComponent('http://127.0.0.1/admin')}`).set(headers).expect(400);
    expect(stub).not.toHaveBeenCalled();
  });

  it('devolve 400 sem o parâmetro url', async () => {
    await request(await app()).get('/api/v1/inbox/link-preview').set(headers).expect(400);
  });
});
