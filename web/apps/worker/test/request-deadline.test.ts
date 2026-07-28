import { describe, expect, it } from 'vitest';
import { detached, remainingBudgetMs, withRequestDeadline } from '../src/request-deadline.js';

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
