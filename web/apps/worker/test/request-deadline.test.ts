import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detached, remainingBudgetMs, withRequestDeadline } from '../src/request-deadline.js';

/**
 * O relógio é congelado de propósito. O que estes testes afirmam é a conta que
 * `withRequestDeadline` faz — orçamento menos reserva —, não quanto tempo o
 * processo levou para chegar até a asserção.
 *
 * Com o relógio real o caso de 1 ms disputava com o scheduler: `reserve(1)` é 0,
 * o prazo vira `Date.now() + 1`, e bastava o event loop gastar 1 ms entre gravar
 * o prazo e lê-lo para o resultado ser 0. Falhava cerca de 1 vez em 5 e reprovava
 * merge por sorte.
 *
 * `toFake: ['Date']` congela só o relógio; os `setTimeout` abaixo continuam
 * reais, porque o que eles exercitam é isolamento entre contextos async e não
 * passagem de tempo. A passagem de tempo, que antes era acidente, agora tem teste
 * próprio e explícito.
 */
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('request deadline', () => {
  it('has no budget outside a command', () => { expect(remainingBudgetMs()).toBeUndefined(); });

  it('keeps back enough of the budget for the answer to reach the caller', async () => {
    const remaining = await withRequestDeadline(30_000, async () => remainingBudgetMs());
    expect(remaining).toBeLessThanOrEqual(29_500);
    expect(remaining).toBeGreaterThan(29_000);
  });

  it('still leaves a usable budget when the caller allows very little time', async () => {
    // The reserve is proportional below 5 s, so a small budget is not consumed
    // entirely by it and a command can still attempt one call.
    expect(await withRequestDeadline(100, async () => remainingBudgetMs())).toBeGreaterThan(80);
    expect(await withRequestDeadline(1, async () => remainingBudgetMs())).toBeGreaterThan(0);
  });

  it('spends the budget as time passes', async () => {
    // Antes ninguém provava isto: o decaimento só acontecia por acidente, entre
    // uma linha e outra, e nenhuma asserção o media.
    await withRequestDeadline(10_000, async () => {
      expect(remainingBudgetMs()).toBe(9_500);
      vi.setSystemTime(Date.now() + 400);
      expect(remainingBudgetMs()).toBe(9_100);
      vi.setSystemTime(Date.now() + 9_200);
      expect(remainingBudgetMs()).toBeLessThan(0);
    });
  });

  it('does not let one command spend another command budget', async () => {
    const observed = new Map<string, number | undefined>();
    const command = (label: string, budget: number) => withRequestDeadline(budget, async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      observed.set(label, remainingBudgetMs());
    });
    await Promise.all([command('short', 200), command('long', 20_000)]);
    expect(observed.get('short')).toBeLessThan(200);
    expect(observed.get('long')).toBeGreaterThan(19_000);
  });

  it('detaches background work from the command budget without disturbing the command', async () => {
    let insideDetached: number | undefined = -1;
    const afterDetached = await withRequestDeadline(1_000, async () => {
      insideDetached = await detached(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return remainingBudgetMs(); });
      return remainingBudgetMs();
    });
    expect(insideDetached).toBeUndefined();
    expect(afterDetached).toBeGreaterThan(0);
    expect(remainingBudgetMs()).toBeUndefined();
  });
});
