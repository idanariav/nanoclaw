import { describe, expect, it, vi, beforeEach } from 'vitest';

const scrapeMock = vi.fn();
vi.mock('israeli-bank-scrapers', () => ({
  createScraper: vi.fn(() => ({ scrape: scrapeMock })),
}));

const { createJob, getJob } = await import('./jobs.js');
const { runAccountScrape } = await import('./scraper-runner.js');

const account = {
  id: 'max-1',
  companyId: 'max' as never,
  credentials: { username: 'u', password: 'p' },
};

describe('runAccountScrape', () => {
  beforeEach(() => {
    scrapeMock.mockReset();
  });

  it('normalizes a successful scrape into flat transactions and marks the account done', async () => {
    scrapeMock.mockResolvedValue({
      success: true,
      accounts: [
        {
          accountNumber: '1234',
          txns: [
            {
              date: '2026-09-05T00:00:00.000Z',
              chargedAmount: -38.98,
              chargedCurrency: 'ILS',
              originalCurrency: 'ILS',
              description: 'עידן - הייטקזון',
              status: 'completed',
            },
          ],
        },
      ],
    });

    const job = createJob([{ id: account.id, companyId: account.companyId }]);
    await runAccountScrape(job.runId, account);

    const accountJob = getJob(job.runId)!.accounts[0];
    expect(accountJob.status).toBe('done');
    expect(accountJob.transactions).toEqual([
      {
        accountNumber: '1234',
        date: '2026-09-05T00:00:00.000Z',
        amount: -38.98,
        currency: 'ILS',
        description: 'עידן - הייטקזון',
        status: 'completed',
      },
    ]);
  });

  it('falls back to originalCurrency when chargedCurrency is absent', async () => {
    scrapeMock.mockResolvedValue({
      success: true,
      accounts: [
        {
          accountNumber: '1234',
          txns: [{ date: '2026-09-05', chargedAmount: 100, originalCurrency: 'USD', description: 'x', status: 'completed' }],
        },
      ],
    });
    const job = createJob([{ id: account.id, companyId: account.companyId }]);
    await runAccountScrape(job.runId, account);
    expect(getJob(job.runId)!.accounts[0].transactions![0].currency).toBe('USD');
  });

  it('records errorMessage on a failed scrape without throwing', async () => {
    scrapeMock.mockResolvedValue({ success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'bad password' });
    const job = createJob([{ id: account.id, companyId: account.companyId }]);
    await runAccountScrape(job.runId, account);
    const accountJob = getJob(job.runId)!.accounts[0];
    expect(accountJob.status).toBe('error');
    expect(accountJob.error).toBe('bad password');
  });

  it('falls back to errorType when errorMessage is absent', async () => {
    scrapeMock.mockResolvedValue({ success: false, errorType: 'TIMEOUT' });
    const job = createJob([{ id: account.id, companyId: account.companyId }]);
    await runAccountScrape(job.runId, account);
    expect(getJob(job.runId)!.accounts[0].error).toBe('TIMEOUT');
  });

  it('catches a thrown error from scrape() and records it instead of crashing', async () => {
    scrapeMock.mockRejectedValue(new Error('browser launch failed'));
    const job = createJob([{ id: account.id, companyId: account.companyId }]);
    await expect(runAccountScrape(job.runId, account)).resolves.toBeUndefined();
    const accountJob = getJob(job.runId)!.accounts[0];
    expect(accountJob.status).toBe('error');
    expect(accountJob.error).toBe('browser launch failed');
  });
});
