export type DashboardSessionStatus = { status: string; total: number };

/** Keeps dashboard session data independent from the session provider shape. */
export const summarizeSessionsByStatus = (sessions: unknown): DashboardSessionStatus[] => {
  if (!Array.isArray(sessions)) return [];
  const totals = new Map<string, number>();
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const status = (session as { status?: unknown }).status;
    if (typeof status !== 'string' || !status) continue;
    totals.set(status, (totals.get(status) ?? 0) + 1);
  }
  return [...totals].map(([status, total]) => ({ status, total }));
};

/**
 * Nomes de sessão WAHA que ainda existem, para o painel parar de contar conversa
 * de um pareamento que foi substituído.
 *
 * `undefined` significa "não deu para saber" e mantém a contagem anterior: o
 * controller já engole a falha do worker devolvendo lista vazia, e um provider
 * que não preenche `wahaName` responderia o mesmo. Zerar o KPI por causa disso
 * seria pior que contar demais.
 *
 * O status não entra: sessão que existe mas está parada ou reconectando continua
 * sendo atendimento da operação atual. O que se quer excluir é a sessão que
 * deixou de existir.
 */
export const activeSessionNames = (sessions: unknown): ReadonlySet<string> | undefined => {
  if (!Array.isArray(sessions)) return undefined;
  const names = new Set<string>();
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const name = (session as { wahaName?: unknown }).wahaName;
    if (typeof name === 'string' && name) names.add(name);
    // Pareamento anterior que o worker ainda roteia para a sessão viva: a
    // conversa gravada com esse nome continua alcançável e continua contando.
    const aliases = (session as { aliases?: unknown }).aliases;
    if (Array.isArray(aliases)) for (const alias of aliases) if (typeof alias === 'string' && alias) names.add(alias);
  }
  return names.size ? names : undefined;
};
