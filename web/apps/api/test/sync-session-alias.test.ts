import { describe, expect, it, vi } from 'vitest';
import { InboxController } from '../src/controllers/inbox.controller.js';

/**
 * Medido na conta de produção em 03/08/2026. `POST /inbox/sync/start` sem corpo
 * precisa descobrir sozinho qual sessão retomar, e refazia o hash
 * `sha256(workspaceId:session.id)` para chegar ao nome da WAHA. Esse hash é o nome
 * que a sessão teve **quando foi criada**; o worker a renomeou e guardou o nome
 * velho em `aliases`, então a conta passou a apontar para o alias:
 *
 *   wahaName    chatpro-87a9de0476d7df33378259135259bb5dfd16524f   job travado desde 28/07
 *   hash antigo chatpro-42217e8d030af3c738f272559e67befaf1533633   alias, job `completed` de 21/07
 *
 * O efeito não é um 404: o alias TEM job, e um job `completed`. Retomar por ele
 * respondia "Histórico sincronizado" com a sessão viva parada — o operador
 * clicava em "Retomar sincronização", a barra dizia que estava tudo certo, e
 * nenhuma conversa antiga aparecia.
 *
 * O dashboard cai neste caminho sempre que a lista de conversas ainda não
 * carregou, porque ele manda `conversationPage.items[0]?.whatsappSessionId`.
 */
const context = { correlationId: 'c-1', workspaceId: 'default-workspace', userId: 'u-1' };
const VIVO = 'chatpro-87a9de0476d7df33378259135259bb5dfd16524f';
const ALIAS = 'chatpro-42217e8d030af3c738f272559e67befaf1533633';
/** O id real da sessão desta conta: é dele que o hash antigo saía. */
const SESSION_ID = '9dfec9e5-c2a7-4ba9-9ff9-ccb1ed9c26f3';

const controller = (sessions: Array<{ id: string; status: string; wahaName?: string }>) => {
  const start = vi.fn(async (_workspaceId: string, wahaSession: string) => ({ wahaSession, status: 'pending' }));
  const inbox = new InboxController(
    {} as never, {} as never, {} as never, {} as never,
    { start } as never,
    { list: async () => sessions },
  );
  return { inbox, start };
};

const chamar = async (inbox: InboxController, body: unknown) => {
  let status = 0;
  let corpo: unknown;
  const res = { status: (value: number) => { status = value; return res; }, json: (value: unknown) => { corpo = value; return res; } };
  await inbox.startSync({ context, body } as never, res as never, (() => undefined) as never);
  return { status, corpo };
};

describe('retomar a sincronização sem dizer a sessão', () => {
  it('retoma o nome vivo da WAHA, não o alias que o hash antigo produzia', async () => {
    const { inbox, start } = controller([{ id: SESSION_ID, status: 'connected', wahaName: VIVO }]);

    const { status } = await chamar(inbox, {});

    expect(status).toBe(202);
    expect(start).toHaveBeenCalledWith('default-workspace', VIVO, expect.anything());
    // O alias tem um job `completed`: retomar por ele é o que fazia o operador ver
    // "Histórico sincronizado" com a sessão viva parada.
    expect(start).not.toHaveBeenCalledWith('default-workspace', ALIAS, expect.anything());
  });

  it('ignora sessão desconectada e escolhe a conectada', async () => {
    const { inbox, start } = controller([
      { id: 'outra', status: 'disconnected', wahaName: 'chatpro-desconectada' },
      { id: SESSION_ID, status: 'connected', wahaName: VIVO },
    ]);

    await chamar(inbox, {});

    expect(start).toHaveBeenCalledWith('default-workspace', VIVO, expect.anything());
  });

  it('sem sessão conectada, recusa com 409 em vez de inventar um nome', async () => {
    const { inbox, start } = controller([{ id: SESSION_ID, status: 'disconnected', wahaName: VIVO }]);

    await expect(chamar(inbox, {})).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(start).not.toHaveBeenCalled();
  });

  it('cai no hash derivado quando o worker não informa o nome', async () => {
    // O último recurso continua valendo: um worker mais velho não devolve
    // `wahaName`, e aí o nome de criação é o melhor palpite que existe.
    const { inbox, start } = controller([{ id: SESSION_ID, status: 'connected' }]);

    await chamar(inbox, {});

    expect(start).toHaveBeenCalledWith('default-workspace', ALIAS, expect.anything());
  });

  it('a sessão dita no corpo continua mandando, sem consultar o worker', async () => {
    const { inbox, start } = controller([{ id: SESSION_ID, status: 'connected', wahaName: VIVO }]);

    await chamar(inbox, { wahaSession: 'chatpro-escolhida-a-mao' });

    expect(start).toHaveBeenCalledWith('default-workspace', 'chatpro-escolhida-a-mao', expect.anything());
  });
});
