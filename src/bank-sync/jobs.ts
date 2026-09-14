/**
 * In-memory scrape-job store. A "job" is one /scrape/start request, covering
 * one or more accounts; each account progresses pending -> running ->
 * done|error independently, since one bank's login can fail while another
 * succeeds. Kept async/pollable (rather than one blocking HTTP call) purely
 * because scraping several accounts can take tens of seconds each — not
 * because of any human-input pause (this library has no OTP hook for any of
 * the supported companies; see scraper-runner.ts's module comment).
 *
 * Deliberately in-memory only: a host restart mid-scrape loses the job and
 * the caller just starts a new one. Not durable by design — there's nothing
 * here worth persisting across a restart.
 */
import { randomUUID } from 'crypto';

import type { CompanyTypes } from 'israeli-bank-scrapers';

export interface NormalizedTransaction {
  accountNumber: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  status: string;
}

export type AccountJobStatus = 'pending' | 'running' | 'done' | 'error';

export interface AccountJob {
  accountId: string;
  companyId: CompanyTypes;
  status: AccountJobStatus;
  transactions?: NormalizedTransaction[];
  error?: string;
}

export interface Job {
  runId: string;
  createdAt: number;
  accounts: AccountJob[];
}

const jobs = new Map<string, Job>();

// Jobs are small and short-lived (a handful of accounts, done within minutes) —
// this is just a backstop against unbounded growth on a long-running service,
// not a real retention policy.
const MAX_JOB_AGE_MS = 60 * 60 * 1000;

function pruneOldJobs(): void {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  for (const [runId, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(runId);
  }
}

export function createJob(accounts: { id: string; companyId: CompanyTypes }[]): Job {
  pruneOldJobs();
  const job: Job = {
    runId: randomUUID(),
    createdAt: Date.now(),
    accounts: accounts.map(({ id, companyId }) => ({ accountId: id, companyId, status: 'pending' as const })),
  };
  jobs.set(job.runId, job);
  return job;
}

export function getJob(runId: string): Job | undefined {
  return jobs.get(runId);
}

function getAccountJob(runId: string, accountId: string): AccountJob | undefined {
  return jobs.get(runId)?.accounts.find((a) => a.accountId === accountId);
}

export function setAccountRunning(runId: string, accountId: string): void {
  const account = getAccountJob(runId, accountId);
  if (account) account.status = 'running';
}

export function setAccountDone(runId: string, accountId: string, transactions: NormalizedTransaction[]): void {
  const account = getAccountJob(runId, accountId);
  if (!account) return;
  account.status = 'done';
  account.transactions = transactions;
}

export function setAccountError(runId: string, accountId: string, error: string): void {
  const account = getAccountJob(runId, accountId);
  if (!account) return;
  account.status = 'error';
  account.error = error;
}
