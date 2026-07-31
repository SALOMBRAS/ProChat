import { beforeEach, describe, expect, it } from 'vitest';
import { callerFrom, countingFetch, endpointFrom, recordSupabaseCall, resetSupabaseCallTally, supabaseCallStatsEnabled, supabaseCallTally } from '../src/persistence/supabase-call-stats.js';

beforeEach(() => resetSupabaseCallTally());

describe('contagem de chamadas ao PostgREST', () => {
  // O agrupamento é por tabela porque é assim que a pergunta é feita — "quem
  // está martelando qual tabela" — e o `select` da query mudaria a chave sem
  // mudar a resposta.
  it('reduz a URL do PostgREST ao nome da tabela', () => {
    expect(endpointFrom('https://x.supabase.co/rest/v1/conversations?select=*&workspace_id=eq.a')).toBe('conversations');
    expect(endpointFrom('https://x.supabase.co/rest/v1/workspace_sla_config?select=*')).toBe('workspace_sla_config');
    expect(endpointFrom('https://x.supabase.co/storage/v1/object/sign/media/a.jpg')).toBe('storage/v1/object');
    expect(endpointFrom('nao é uma url')).toBe('url-invalida');
  });

  // Sem o chamador, a contagem diz que a tabela é lida muito e não diz por quem;
  // era exatamente esse o buraco entre "10 GET/s" e "quem os emite".
  it('atribui a chamada ao primeiro quadro em apps/api/src, ignorando dependências', () => {
    const stack = [
      'Error',
      '    at recordSupabaseCall (/w/apps/api/src/persistence/supabase-call-stats.ts:60:20)',
      '    at fetch (/w/node_modules/@supabase/postgrest-js/dist/index.js:120:15)',
      '    at SupabaseSlaStore.getConfig (/w/apps/api/src/services/sla.service.ts:149:44)',
      '    at SlaService.tick (/w/apps/api/src/services/sla.service.ts:130:20)',
    ].join('\n');
    expect(callerFrom(stack)).toBe('services/sla.service.ts:149 (SupabaseSlaStore.getConfig)');
    expect(callerFrom(undefined)).toBe('desconhecido');
    expect(callerFrom('Error\n    at foo (/w/node_modules/x/index.js:1:1)')).toBe('fora de apps/api/src');
  });

  it('ordena o tally do mais chamado para o menos e soma repetições', () => {
    recordSupabaseCall({ method: 'GET', table: 'conversations', caller: 'a.ts:1' });
    recordSupabaseCall({ method: 'GET', table: 'conversations', caller: 'a.ts:1' });
    recordSupabaseCall({ method: 'PATCH', table: 'conversations', caller: 'b.ts:2' });
    expect(supabaseCallTally().map(({ method, table, count }) => ({ method, table, count }))).toEqual([
      { method: 'GET', table: 'conversations', count: 2 },
      { method: 'PATCH', table: 'conversations', count: 1 },
    ]);
    resetSupabaseCallTally();
    expect(supabaseCallTally()).toEqual([]);
  });

  // Instrumentação que fica ligada por engano vira custo permanente: capturar
  // pilha em todo fetch não é coisa de caminho quente. Desligado, o cliente tem
  // de receber o mesmo `fetch` que receberia sem este módulo.
  it('devolve o fetch original, e não um invólucro, quando está desligada', () => {
    const base = (async () => new Response('')) as unknown as typeof fetch;
    expect(supabaseCallStatsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(countingFetch(base, {} as NodeJS.ProcessEnv)).toBe(base);
    expect(countingFetch(base, { SUPABASE_CALL_STATS: '0' } as unknown as NodeJS.ProcessEnv)).toBe(base);
    expect(countingFetch(base, { SUPABASE_CALL_STATS: '1' } as unknown as NodeJS.ProcessEnv)).not.toBe(base);
  });

  it('conta método e tabela de cada chamada e repassa a requisição', async () => {
    const chamadas: string[] = [];
    const base = (async (input: unknown, init?: { method?: string }) => { chamadas.push(`${init?.method ?? 'GET'} ${String(input)}`); return new Response('[]'); }) as unknown as typeof fetch;
    const wrapped = countingFetch(base, { SUPABASE_CALL_STATS: '1' } as unknown as NodeJS.ProcessEnv);
    await wrapped('https://x.supabase.co/rest/v1/conversations?select=*');
    await wrapped('https://x.supabase.co/rest/v1/conversations?select=id');
    await wrapped('https://x.supabase.co/rest/v1/whatsapp_messages', { method: 'POST' });
    const tally = supabaseCallTally();
    expect(tally.map(({ method, table, count }) => ({ method, table, count }))).toEqual([
      { method: 'GET', table: 'conversations', count: 2 },
      { method: 'POST', table: 'whatsapp_messages', count: 1 },
    ]);
    expect(chamadas).toHaveLength(3);
    // A pilha é capturada de verdade a cada chamada, e não substituída por um
    // rótulo fixo: daqui, de fora de `apps/api/src`, a atribuição tem de ser a
    // que `callerFrom` produz para esse caso — nunca 'desconhecido', que é o
    // valor de quando não há pilha nenhuma.
    expect(tally.map(item => item.caller)).toEqual(['fora de apps/api/src', 'fora de apps/api/src']);
  });
});
