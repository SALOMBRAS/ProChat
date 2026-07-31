/** Contagem de chamadas ao PostgREST por endpoint, para diagnóstico de volume.
 *
 * Existe porque a pergunta "quem está gerando N requisições por segundo contra o
 * Supabase" não se responde por leitura de código: o custo de uma rota da API é
 * o fan-out dela, e o fan-out só aparece quando se conta a chamada HTTP de fato.
 * `supabase-js` aceita um `fetch` próprio, então o ponto de contagem é o mesmo
 * que o cliente usa para falar com o banco — não há caminho por fora.
 *
 * Desligado por padrão. `SUPABASE_CALL_STATS=1` liga; sem isso o cliente recebe
 * o `fetch` global e este módulo não entra no caminho quente.
 *
 * A atribuição de chamador vem da pilha capturada no momento da chamada. É cara
 * o bastante para não ficar ligada em produção e barata o bastante para um
 * minuto de diagnóstico, e é o que transforma "a tabela X recebe muita leitura"
 * em "a função Y pede a tabela X".
 */
export type SupabaseCall = { method: string; table: string; caller: string };
export type SupabaseCallTally = { key: string; method: string; table: string; caller: string; count: number };

const counts = new Map<string, { call: SupabaseCall; count: number }>();
let installed = false;

export function supabaseCallStatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUPABASE_CALL_STATS === '1';
}

/** `/rest/v1/conversations?select=...` vira `conversations`; o resto do path
 * (storage, auth) fica com o primeiro segmento, que já basta para separar. */
export function endpointFrom(url: string): string {
  try {
    const { pathname } = new URL(url);
    const rest = pathname.match(/\/rest\/v1\/([^/?]+)/);
    if (rest) return rest[1];
    const first = pathname.replace(/^\/+/, '').split('/').slice(0, 3).join('/');
    return first || pathname;
  } catch {
    return 'url-invalida';
  }
}

/** Primeiro quadro da pilha dentro de `apps/api/src` que não seja este módulo
 * nem o próprio `supabase-js`: é quem, no nosso código, pediu o dado. */
export function callerFrom(stack: string | undefined): string {
  if (!stack) return 'desconhecido';
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('supabase-call-stats')) continue;
    if (line.includes('/node_modules/')) continue;
    const match = line.match(/at\s+(?:async\s+)?([^\s(]+)?\s*\(?([^)]*apps\/api\/src\/[^):]+):(\d+):\d+\)?/);
    if (!match) continue;
    const file = match[2].split('apps/api/src/')[1];
    return `${file}:${match[3]}${match[1] && match[1] !== 'null' ? ` (${match[1]})` : ''}`;
  }
  return 'fora de apps/api/src';
}

export function recordSupabaseCall(call: SupabaseCall): void {
  const key = `${call.method} ${call.table} <- ${call.caller}`;
  const current = counts.get(key);
  if (current) current.count++;
  else counts.set(key, { call, count: 1 });
}

export function supabaseCallTally(): SupabaseCallTally[] {
  return [...counts].map(([key, { call, count }]) => ({ key, ...call, count })).sort((a, b) => b.count - a.count);
}

export function resetSupabaseCallTally(): void { counts.clear(); installed = false; }

/** Envelopa um `fetch` para contar cada chamada. Devolve o próprio `base`
 * quando a contagem está desligada, para não pagar nada no caminho normal. */
export function countingFetch(base: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): typeof fetch {
  if (!supabaseCallStatsEnabled(env)) return base;
  installed = true;
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    recordSupabaseCall({ method, table: endpointFrom(url), caller: callerFrom(new Error().stack) });
    return base(input as never, init);
  }) as typeof fetch;
}

export function supabaseCallStatsInstalled(): boolean { return installed; }
