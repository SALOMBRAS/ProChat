import { linkPreviewSchema, type LinkPreview, type LinkPreviewProvider } from '@chatpro/contracts';
import { AppError } from '../errors.js';

const TIMEOUT_MS = 8_000;
const ENRICH_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 2;
const MAX_BODY_BYTES = 1_500_000;
const CACHE_MAX = 500;
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
// Portal que derruba conexão/estoura timeout (WAF, fora do ar) não se recupera
// em minutos — insistir é pagar 8 s de espera a cada tentativa. Falha de rede
// aprende por 1 h; falha de conteúdo (sem OG) segue curta, a página pode mudar.
const NETWORK_FAILURE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = { value: LinkPreview; expiresAt: number } | { error: AppError; expiresAt: number };

/** Retaguarda de prévia de link: raspa OG/Twitter e enriquece com oEmbed/API —
 *  o mesmo que o WhatsApp faz no cliente remetente, para quando a prévia nativa
 *  não existe. Não há endpoint WAHA para prévia de URL arbitrária e
 *  `/api/send/link-custom-preview` não roda no engine WEBJS, então a retaguarda
 *  é própria.
 *
 *  O endpoint é uma janela de SSRF em potencial (o operador cola uma URL e a API
 *  busca em nome dele), então `safeTarget` revalida esquema e host — inclusive a
 *  cada redirect. Cache em memória por processo: a prévia é reconstruível por
 *  definição, e persistir exigiria tabela nova (proibido sem solicitação). */
export class LinkPreviewService {
  private readonly cache = new Map<string, CacheEntry>();
  constructor(private readonly options: { fetchImpl?: typeof fetch; now?: () => number } = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }

  async preview(url: string): Promise<LinkPreview> {
    const target = safeTarget(url);
    const cached = this.cache.get(target.href);
    if (cached && cached.expiresAt > this.now()) {
      // Toque LRU: a ordem de inserção é o critério de despejo.
      this.cache.delete(target.href); this.cache.set(target.href, cached);
      if ('error' in cached) throw cached.error;
      return cached.value;
    }
    try {
      const value = await this.fetchPreview(target);
      this.remember(target.href, { value, expiresAt: this.now() + SUCCESS_TTL_MS });
      return value;
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError(422, 'VALIDATION_ERROR', 'Não foi possível gerar a prévia deste link', { reason: 'network' });
      // 400 nunca é cacheado: URL bloqueada é erro do pedido, não do destino.
      if (failure.status !== 400) this.remember(target.href, { error: failure, expiresAt: this.now() + (failure.details?.reason === 'network' ? NETWORK_FAILURE_TTL_MS : FAILURE_TTL_MS) });
      throw failure;
    }
  }

  private remember(key: string, entry: CacheEntry) {
    this.cache.delete(key); this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
  }

  private async fetchPreview(target: URL): Promise<LinkPreview> {
    const { url, html } = await this.fetchHtml(target);
    const metadata = extractMetadata(html, url);
    if (!metadata.title && !metadata.description && !metadata.imageUrl) throw new AppError(422, 'VALIDATION_ERROR', 'A página não tem informações para gerar a prévia');
    const hostname = new URL(url).hostname;
    const candidate = {
      url,
      domain: hostname,
      ...(metadata.title ? { title: metadata.title.slice(0, 500) } : {}),
      ...(metadata.description ? { description: metadata.description.slice(0, 2_000) } : {}),
      ...(metadata.imageUrl ? { imageUrl: metadata.imageUrl } : {}),
      ...(metadata.siteName ? { siteName: metadata.siteName.slice(0, 240) } : {}),
      ...(metadata.faviconUrl ? { faviconUrl: metadata.faviconUrl } : {}),
      provider: providerFromHostname(hostname),
    };
    const parsed = linkPreviewSchema.safeParse(candidate);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', 'A página não tem informações para gerar a prévia');
    return this.enrich(parsed.data);
  }

  /** Redirect manual: cada `Location` é resolvido contra a URL corrente e passa
   *  por `safeTarget` de novo — redirect para dentro da rede é recusado. */
  private async fetchHtml(target: URL): Promise<{ url: string; html: string }> {
    let current = target;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await this.request(current.href);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirect === MAX_REDIRECTS) break;
        current = safeTarget(new URL(location, current).href);
        continue;
      }
      if (!response.ok) throw new AppError(422, 'VALIDATION_ERROR', 'Não foi possível gerar a prévia deste link');
      const type = response.headers.get('content-type') ?? '';
      if (!type.toLowerCase().includes('text/html')) throw new AppError(422, 'VALIDATION_ERROR', 'O link não aponta para uma página web');
      return { url: current.href, html: await readLimited(response) };
    }
    throw new AppError(422, 'VALIDATION_ERROR', 'Não foi possível gerar a prévia deste link');
  }

  /** Melhor esforço: qualquer falha cai no catch e a prévia segue só com OG. */
  private async enrich(preview: LinkPreview): Promise<LinkPreview> {
    try {
      if (preview.provider === 'youtube') return await this.oembed(preview, `https://www.youtube.com/oembed?url=${encodeURIComponent(preview.url)}&format=json`);
      if (preview.provider === 'tiktok') return await this.oembed(preview, `https://www.tiktok.com/oembed?url=${encodeURIComponent(preview.url)}`);
      if (preview.provider === 'github') return await this.github(preview);
      return preview;
    } catch { return preview; }
  }

  /** oEmbed preenche só o que está vazio: OG da página vence onde preenchido. */
  private async oembed(preview: LinkPreview, endpoint: string): Promise<LinkPreview> {
    const response = await this.request(endpoint, ENRICH_TIMEOUT_MS, { accept: 'application/json' });
    if (!response.ok) return preview;
    const data = await response.json().catch(() => undefined) as { author_name?: unknown; thumbnail_url?: unknown; title?: unknown } | undefined;
    if (!data) return preview;
    const author = typeof data.author_name === 'string' && data.author_name.trim() ? data.author_name.trim().slice(0, 240) : undefined;
    const imageUrl = typeof data.thumbnail_url === 'string' && data.thumbnail_url.trim() ? data.thumbnail_url.trim() : undefined;
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 500) : undefined;
    return { ...preview, ...(preview.author || !author ? {} : { author }), ...(preview.imageUrl || !imageUrl ? {} : { imageUrl }), ...(preview.title || !title ? {} : { title }) };
  }

  /** Só URLs `github.com/{owner}/{repo}` exatas; API pública, sem token. */
  private async github(preview: LinkPreview): Promise<LinkPreview> {
    const match = new URL(preview.url).pathname.match(/^\/([^/?#]+)\/([^/?#]+)\/?$/);
    if (!match) return preview;
    const [, owner, repo] = match;
    const response = await this.request(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, ENRICH_TIMEOUT_MS, { accept: 'application/vnd.github+json', 'user-agent': 'chatpro-link-preview' });
    if (!response.ok) return preview;
    const data = await response.json().catch(() => undefined) as { description?: unknown; stargazers_count?: unknown; language?: unknown } | undefined;
    if (!data) return preview;
    const description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : undefined;
    const stars = typeof data.stargazers_count === 'number' && Number.isFinite(data.stargazers_count) ? data.stargazers_count : undefined;
    const language = typeof data.language === 'string' && data.language.trim() ? data.language.trim() : undefined;
    const base = preview.description ?? description;
    const suffix = stars !== undefined || language ? ` — ${[stars !== undefined ? `★ ${stars}` : undefined, language].filter(Boolean).join(' · ')}` : '';
    return { ...preview, ...(preview.author ? {} : { author: owner.slice(0, 240) }), ...(base ? { description: `${base}${suffix}`.slice(0, 2_000) } : {}) };
  }

  private async request(url: string, timeoutMs = TIMEOUT_MS, headers: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // O fetch do Node se identifica como bot ("undici"/"node") e portais —
      // governo (.jus.br, .gov.br), stacks antigas, CDNs com WAF — respondem
      // 403/406 ou simplesmente travam. Um UA de navegador destranca a prévia
      // dessa classe de site sem mudar nada na segurança (o alvo já passou por
      // `safeTarget`; quem recebe o UA é o site público, não a rede interna).
      return await (this.options.fetchImpl ?? fetch)(url, { headers: { accept: 'text/html,application/json', 'user-agent': BROWSER_UA, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8', ...headers }, redirect: 'manual', signal: controller.signal });
    } catch { throw new AppError(422, 'VALIDATION_ERROR', 'Não foi possível gerar a prévia deste link', { reason: 'network' }); }
    finally { clearTimeout(timer); }
  }
}
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => undefined); break; }
    chunks.push(value);
  }
  const buffer = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8').decode(buffer);
}

/** Guarda de SSRF: só http(s) público. A URL WHATWG normaliza IPv4 alternativo
 *  (`0x7f.1`, `2130706433`) para a forma pontilhada antes da checagem. */
function safeTarget(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Link inválido'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError(400, 'VALIDATION_ERROR', 'O link precisa começar com http:// ou https://');
  if (blockedHostname(url.hostname)) throw new AppError(400, 'VALIDATION_ERROR', 'Este endereço não é permitido');
  return url;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::' || host === '::1' || host === '[::]' || host === '[::1]') return true;
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return true;
  if (/^\[?(fc|fd)[0-9a-f:]/.test(host)) return true;
  const mapped = host.match(/^\[?::ffff:(\d+\.\d+\.\d+\.\d+)\]?$/);
  const ipv4 = mapped ? mapped[1] : host;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) return false;
  const [a, b] = ipv4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function providerFromHostname(hostname: string): LinkPreviewProvider {
  const host = hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'github.com') return 'github';
  if (host === 'open.spotify.com') return 'spotify';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.watch') return 'facebook';
  if (host === 'figma.com' || host.endsWith('.figma.com')) return 'figma';
  if (host === 'notion.so' || host.endsWith('.notion.site')) return 'notion';
  if (host === 'drive.google.com' || host === 'docs.google.com') return 'google-drive';
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) return 'dropbox';
  return 'generic';
}

type PageMetadata = { title?: string; description?: string; imageUrl?: string; siteName?: string; faviconUrl?: string };

/** Varre `<meta>` tag a tag — as duas ordens de atributo (`property`/`content`)
 *  aparecem na prática. Prioridade og: → twitter: → <title>/meta description. */
function extractMetadata(html: string, pageUrl: string): PageMetadata {
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let plainDescription: string | undefined;
  let iconHref: string | undefined;
  const tagPattern = /<meta\s[^>]*>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0];
    const key = (attrValue(tag, 'property') ?? attrValue(tag, 'name') ?? '').toLowerCase();
    const content = attrValue(tag, 'content');
    if (!key || content === undefined) continue;
    const value = clean(decodeEntities(content));
    if (!value) continue;
    if (key.startsWith('og:')) og[key.slice(3)] ??= value;
    else if (key.startsWith('twitter:')) twitter[key.slice(8)] ??= value;
    else if (key === 'description') plainDescription ??= value;
  }
  const iconMatch = html.match(/<link\s[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i);
  if (iconMatch) iconHref = attrValue(iconMatch[0], 'href');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const resolve = (value?: string) => { if (!value) return undefined; try { return new URL(value, pageUrl).href; } catch { return undefined; } };
  return {
    title: og.title ?? twitter.title ?? (titleMatch ? clean(decodeEntities(titleMatch[1])) : undefined),
    description: og.description ?? twitter.description ?? plainDescription,
    imageUrl: resolve(og.image ?? twitter.image),
    siteName: og.site_name,
    faviconUrl: resolve(iconHref) ?? resolve('/favicon.ico'),
  };
}

function attrValue(tag: string, name: string): string | undefined {
  const doubleQuoted = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  if (doubleQuoted) return doubleQuoted[1];
  const singleQuoted = tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return singleQuoted?.[1];
}

/** `&amp;` por último, para não decodificar duas vezes. */
function decodeEntities(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function clean(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
