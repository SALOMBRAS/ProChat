import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The API aborts its own HTTP request when the budget it announced runs out, and
 * that abort tells the caller nothing about what the worker was doing. Honouring
 * the announced budget here keeps the operation inside it no matter how many
 * provider calls it needs, and lets the worker answer with the real cause while
 * the caller is still listening.
 */
const storage = new AsyncLocalStorage<{ expiresAt: number }>();

/**
 * Time kept aside for the response to travel back to the API, so the worker
 * always finishes before the caller stops waiting. Proportional for the short
 * budgets used in tests, capped for the real ones.
 */
function reserve(budgetMs: number): number { return Math.min(500, Math.floor(budgetMs / 10)); }

export function withRequestDeadline<T>(budgetMs: number, run: () => Promise<T>): Promise<T> {
  return storage.run({ expiresAt: Date.now() + Math.max(1, budgetMs - reserve(budgetMs)) }, run);
}

/** Milliseconds left for the current command, or undefined outside a command. */
export function remainingBudgetMs(): number | undefined {
  const store = storage.getStore();
  return store === undefined ? undefined : store.expiresAt - Date.now();
}

/**
 * Work a command starts but does not wait for, such as provisioning a session in
 * the background. It outlives the command, so the caller's patience says nothing
 * about how long it may take; inheriting the deadline would make it fail the
 * moment the command that spawned it was answered.
 */
export function detached<T>(run: () => T): T { return storage.exit(run); }
