import { describe, expect, it } from 'vitest';
import { SupabaseWhatsAppHistorySyncStore, type SyncJob } from '../src/services/whatsapp-history-sync.service.js';

/**
 * Medido em produção em 03/08/2026: a coluna `chats_total`, criada pela migration
 * 20260731000100, existia no repositório e NÃO no banco remoto. O código da mesma
 * PR grava a coluna em todo `save()`, então o PostgREST devolvia
 *
 *   42703 column whatsapp_sync_jobs.chats_total does not exist
 *
 * o erro subia sem tratamento e `POST /inbox/sync/start` respondia 500
 * "Unexpected service error". Como todo checkpoint passa pelo mesmo `save`, o
 * efeito não foi perder o denominador do banner: foi a sincronização de
 * histórico parar por completo, e o operador ficar vendo o "Falhou" de uma
 * execução de seis dias antes.
 */
const job = (extra: Partial<SyncJob> = {}): SyncJob => ({
  id: 'job-1', workspaceId: 'workspace-a', wahaSession: 'waha-a', status: 'pending',
  currentChatId: null, chatCursor: '0', messageCursor: null,
  chatsProcessed: 0, messagesProcessed: 0, chatsTotal: null,
  startedAt: '2026-08-03T00:00:00.000Z', completedAt: null, lastErrorSafe: null,
  updatedAt: '2026-08-03T00:00:00.000Z', ...extra,
});

// As duas formas reais, capturadas do PostgREST em 03/08/2026. Elas diferem, e
// a primeira versão desta correção casava só a de leitura — por isso o `upsert`,
// que é o que quebra, continuava passando reto.
const erroLeitura = { code: '42703', message: 'column whatsapp_sync_jobs.chats_total does not exist' };
const erroEscrita = { code: 'PGRST204', message: "Could not find the 'chats_total' column of 'whatsapp_sync_jobs' in the schema cache" };
const erroColunaAusente = erroEscrita;

/** Registra cada upsert e devolve o erro que o teste programar para ele. */
function cliente(erros: Array<{ code: string; message: string } | null>) {
  const upserts: Array<Record<string, unknown>> = [];
  const client = {
    from: () => ({
      upsert: (linha: Record<string, unknown>) => {
        upserts.push(linha);
        return Promise.resolve({ error: erros[upserts.length - 1] ?? null });
      },
    }),
  } as never;
  return { client, upserts };
}

describe('checkpoint da sincronização quando chats_total não existe no schema', () => {
  it('regrava o job sem o contador em vez de deixar a sincronização morrer', async () => {
    const { client, upserts } = cliente([erroColunaAusente, null]);
    await new SupabaseWhatsAppHistorySyncStore(client).save(job({ chatsProcessed: 7, messagesProcessed: 900 }));
    expect(upserts).toHaveLength(2);
    expect(upserts[0]).toHaveProperty('chats_total');
    // A segunda tentativa perde o contador e preserva o trabalho.
    expect(upserts[1]).not.toHaveProperty('chats_total');
    expect(upserts[1]).toMatchObject({ id: 'job-1', workspace_id: 'workspace-a', chats_processed: 7, messages_processed: 900, status: 'pending' });
  });

  it('grava uma vez só quando a coluna existe, sem pagar a repetição', async () => {
    const { client, upserts } = cliente([null]);
    await new SupabaseWhatsAppHistorySyncStore(client).save(job({ chatsTotal: 550 }));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ chats_total: 550 });
  });

  it('volta a gravar o contador assim que a migration entra, sem reiniciar o processo', async () => {
    // Primeira gravação sem a coluna, segunda com ela — é o que acontece quando
    // a migration é aplicada com a API no ar. Uma sondagem cacheada responderia
    // "ausente" para sempre até o restart; a repetição se cura sozinha.
    const { client, upserts } = cliente([erroColunaAusente, null, null]);
    const store = new SupabaseWhatsAppHistorySyncStore(client);
    await store.save(job());
    await store.save(job({ chatsTotal: 550 }));
    expect(upserts).toHaveLength(3);
    expect(upserts[2]).toMatchObject({ chats_total: 550 });
  });

  it('propaga erro de outra coluna em vez de escondê-lo', async () => {
    const outro = { code: 'PGRST204', message: "Could not find the 'chat_cursor' column of 'whatsapp_sync_jobs' in the schema cache" };
    const { client, upserts } = cliente([outro]);
    await expect(new SupabaseWhatsAppHistorySyncStore(client).save(job())).rejects.toMatchObject({ code: 'PGRST204' });
    expect(upserts).toHaveLength(1);
  });

  it('reconhece também a forma de leitura do erro, não só a de escrita', async () => {
    const { client, upserts } = cliente([erroLeitura, null]);
    await new SupabaseWhatsAppHistorySyncStore(client).save(job());
    expect(upserts).toHaveLength(2);
    expect(upserts[1]).not.toHaveProperty('chats_total');
  });

  it('propaga erro que não é de coluna ausente', async () => {
    const { client } = cliente([{ code: '23505', message: 'duplicate key value violates unique constraint' }]);
    await expect(new SupabaseWhatsAppHistorySyncStore(client).save(job())).rejects.toMatchObject({ code: '23505' });
  });

  it('propaga a falha da regravação, para o defeito não virar silêncio', async () => {
    const { client } = cliente([erroColunaAusente, { code: '08006', message: 'connection failure' }]);
    await expect(new SupabaseWhatsAppHistorySyncStore(client).save(job())).rejects.toMatchObject({ code: '08006' });
  });
});
