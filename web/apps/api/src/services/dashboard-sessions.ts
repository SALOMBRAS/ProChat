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
