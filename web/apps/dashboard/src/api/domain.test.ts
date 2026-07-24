import { describe, expect, it } from 'vitest';
import { connectedSessionsCount } from './domain.js';

describe('connectedSessionsCount', () => {
  it('returns zero when there are no sessions', () => {
    expect(connectedSessionsCount([])).toBe(0);
  });

  it('counts one connected session', () => {
    expect(connectedSessionsCount([{ status: 'connected', total: 1 }])).toBe(1);
  });

  it('counts only connected sessions across multiple statuses', () => {
    expect(connectedSessionsCount([{ status: 'connected', total: 2 }, { status: 'disconnected', total: 3 }, { status: 'waiting_qr', total: 1 }])).toBe(2);
  });

  it('returns zero for an invalid API response instead of NaN', () => {
    expect(connectedSessionsCount([{ status: 'connected', total: undefined }, { status: 'connected', total: 'not-a-number' }, null])).toBe(0);
  });
});
