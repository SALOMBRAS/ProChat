import { AppError } from '../errors.js';

/**
 * Optimistic concurrency on the Kanban card exists to protect a human: it is what
 * tells an operator that someone else moved the card while they were dragging it.
 * The automation has no operator to tell, so a lost race there is not an answer —
 * it is a card that silently stayed put while the message that should have moved
 * it was already claimed as delivered.
 *
 * Repeating the move as-is would lose again: the attempt carries the same stale
 * `expectedUpdatedAt` that lost the first time, so the conflict is guaranteed, not
 * probable. What converges is re-reading the state and deciding again — the winner
 * of the race has already advanced the stage, so the second reader either finds no
 * rule left to apply or finds `manualOverride` and steps aside. Bounded attempts,
 * and every wait spread by jitter so two writers that collided once do not collide
 * again in lockstep.
 */
export type KanbanRetry = {
  attempts: number;
  sleep: (milliseconds: number) => Promise<void>;
  random: () => number;
};

export const kanbanRetryDefaults = { attempts: 3, baseMs: 50, capMs: 400 } as const;

export function kanbanRetry(overrides: Partial<KanbanRetry> = {}): KanbanRetry {
  return {
    attempts: overrides.attempts ?? kanbanRetryDefaults.attempts,
    sleep: overrides.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    random: overrides.random ?? Math.random,
  };
}

/**
 * Half the window is fixed and half is drawn, so the delay always grows with the
 * attempt and never collapses to zero — a jitter that can return 0 reintroduces
 * the immediate repeat it exists to prevent.
 */
export function kanbanRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const window = Math.min(kanbanRetryDefaults.baseMs * 2 ** Math.max(0, attempt - 1), kanbanRetryDefaults.capMs);
  return Math.round(window / 2 + random() * (window / 2));
}

/**
 * Both providers surface the lost race the same way: Postgres raises `40001` and
 * `fail()` turns it into this AppError, and the SQLite service compares the
 * timestamp in process and throws the same one. One predicate covers both.
 */
export function isKanbanConflict(error: unknown): boolean {
  return error instanceof AppError && error.status === 409 && error.code === 'CONFLICT';
}
