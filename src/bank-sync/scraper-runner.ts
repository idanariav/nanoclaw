/**
 * Drives israeli-bank-scrapers for one account at a time, updating jobs.ts
 * as each finishes.
 *
 * No OTP/2FA handling: as of israeli-bank-scrapers@6.10.0, the
 * otpCodeRetriever/getLongTermTwoFactorToken hooks (see the library's
 * scrapers/interface.d.ts and scrapers/one-zero.ts) exist ONLY for the
 * oneZero scraper. None of hapoalim/yahav/max/visaCal/isracard's credential
 * types carry an OTP field, and hapoalim.js only distinguishes
 * InvalidPassword/ChangePassword as special login outcomes — there is no
 * library hook to relay a live code through for any of them. If a real login
 * ever hits a 2FA/device-verification wall on the bank's site, `.scrape()`
 * just fails (surfaced here as a normal account error) — there's nothing to
 * resume.
 *
 * Best-effort mitigation: each account gets its own persistent Chromium
 * profile dir (`--user-data-dir`) under data/bank-sync-profiles/<accountId>/,
 * so cookies/local-storage survive across runs — some bank sites recognize a
 * returning browser profile and skip a device-verification challenge they'd
 * otherwise show a fresh profile. This is outside the scraper library's own
 * knowledge (plain Chromium args), not a guarantee.
 */
import path from 'path';

import { createScraper, type ScraperCredentials } from 'israeli-bank-scrapers';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { BankSyncAccount } from './credentials.js';
import { setAccountRunning, setAccountDone, setAccountError, type NormalizedTransaction } from './jobs.js';

const PROFILES_DIR = path.resolve(process.cwd(), 'data', 'bank-sync-profiles');

// Optional: point at a system Chrome/Chromium instead of puppeteer's own
// bundled one. Needed if the operator hasn't run `pnpm approve-builds` to
// let puppeteer's postinstall download its pinned Chromium (a supply-chain
// decision this skill deliberately does not make on its own — see SKILL.md).
const { BANK_SYNC_CHROME_PATH } = readEnvFile(['BANK_SYNC_CHROME_PATH']);

function firstDayOfPreviousMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}

function normalizeTransactions(
  accounts:
    | {
        accountNumber: string;
        txns: {
          date: string;
          chargedAmount: number;
          chargedCurrency?: string;
          originalCurrency: string;
          description: string;
          status: string;
        }[];
      }[]
    | undefined,
): NormalizedTransaction[] {
  const out: NormalizedTransaction[] = [];
  for (const account of accounts ?? []) {
    for (const txn of account.txns) {
      out.push({
        accountNumber: account.accountNumber,
        date: txn.date,
        amount: txn.chargedAmount,
        currency: txn.chargedCurrency ?? txn.originalCurrency,
        description: txn.description,
        status: txn.status,
      });
    }
  }
  return out;
}

export async function runAccountScrape(runId: string, account: BankSyncAccount): Promise<void> {
  setAccountRunning(runId, account.id);
  try {
    const scraper = createScraper({
      companyId: account.companyId,
      startDate: firstDayOfPreviousMonth(),
      showBrowser: false,
      executablePath: BANK_SYNC_CHROME_PATH,
      args: [`--user-data-dir=${path.join(PROFILES_DIR, account.id)}`],
    });
    const result = await scraper.scrape(account.credentials as ScraperCredentials);
    if (!result.success) {
      setAccountError(runId, account.id, result.errorMessage || result.errorType || 'scrape failed');
      return;
    }
    setAccountDone(runId, account.id, normalizeTransactions(result.accounts));
  } catch (err) {
    log.error('bank-sync: scrape threw', { accountId: account.id, err });
    setAccountError(runId, account.id, err instanceof Error ? err.message : String(err));
  }
}

/** Sequential, not parallel — a handful of personal accounts don't need several concurrent Chromium instances, and it keeps host resource usage predictable. */
export async function runJobAccounts(runId: string, accounts: BankSyncAccount[]): Promise<void> {
  for (const account of accounts) {
    await runAccountScrape(runId, account);
  }
}
