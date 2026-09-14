import { describe, expect, it } from 'vitest';

import { createJob, getJob, setAccountDone, setAccountError, setAccountRunning } from './jobs.js';

describe('jobs', () => {
  it('starts every account as pending', () => {
    const job = createJob([
      { id: 'a', companyId: 'max' as never },
      { id: 'b', companyId: 'yahav' as never },
    ]);
    expect(getJob(job.runId)?.accounts).toEqual([
      { accountId: 'a', companyId: 'max', status: 'pending' },
      { accountId: 'b', companyId: 'yahav', status: 'pending' },
    ]);
  });

  it('moves one account through running -> done independently of others', () => {
    const job = createJob([
      { id: 'a', companyId: 'max' as never },
      { id: 'b', companyId: 'yahav' as never },
    ]);
    setAccountRunning(job.runId, 'a');
    const txns = [
      { accountNumber: '123', date: '2026-09-01', amount: -10, currency: 'ILS', description: 'x', status: 'completed' },
    ];
    setAccountDone(job.runId, 'a', txns);

    const accounts = getJob(job.runId)!.accounts;
    expect(accounts.find((a) => a.accountId === 'a')).toEqual({
      accountId: 'a',
      companyId: 'max',
      status: 'done',
      transactions: txns,
    });
    expect(accounts.find((a) => a.accountId === 'b')?.status).toBe('pending');
  });

  it('records a per-account error without touching other accounts', () => {
    const job = createJob([{ id: 'a', companyId: 'hapoalim' as never }]);
    setAccountRunning(job.runId, 'a');
    setAccountError(job.runId, 'a', 'INVALID_PASSWORD');
    expect(getJob(job.runId)!.accounts[0]).toEqual({
      accountId: 'a',
      companyId: 'hapoalim',
      status: 'error',
      error: 'INVALID_PASSWORD',
    });
  });

  it('getJob returns undefined for an unknown runId', () => {
    expect(getJob('does-not-exist')).toBeUndefined();
  });

  it('setAccountRunning/Done/Error on an unknown runId or accountId is a no-op, never throws', () => {
    expect(() => setAccountRunning('nope', 'nope')).not.toThrow();
    const job = createJob([{ id: 'a', companyId: 'max' as never }]);
    expect(() => setAccountDone(job.runId, 'not-a-real-account', [])).not.toThrow();
    expect(getJob(job.runId)!.accounts[0].status).toBe('pending');
  });
});
