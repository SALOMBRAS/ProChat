import { describe, expect, it } from 'vitest';
import { summarizeSessionsByStatus } from '../src/services/dashboard-sessions.js';

describe('dashboard session status summary', () => {
  it('returns an empty summary when there are no sessions', () => {
    expect(summarizeSessionsByStatus([])).toEqual([]);
  });

  it('counts one connected session', () => {
    expect(summarizeSessionsByStatus([{ status: 'connected' }])).toEqual([{ status: 'connected', total: 1 }]);
  });

  it('groups multiple sessions by status', () => {
    expect(summarizeSessionsByStatus([{ status: 'connected' }, { status: 'disconnected' }, { status: 'connected' }])).toEqual([{ status: 'connected', total: 2 }, { status: 'disconnected', total: 1 }]);
  });

  it('returns an empty summary for an invalid session response', () => {
    expect(summarizeSessionsByStatus({ sessions: 'invalid' })).toEqual([]);
  });
});
