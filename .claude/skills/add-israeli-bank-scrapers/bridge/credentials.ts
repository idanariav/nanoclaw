/**
 * Loads the configured bank/credit-card accounts (id + companyId) from
 * data/bank-sync-credentials.json (git-ignored — data/ is fully ignored
 * repo-wide). The login secrets themselves live in Bitwarden Secrets Manager
 * and are fetched at scrape time (see bws.ts); an entry may still carry inline
 * `credentials`, which take precedence. No agent container mounts this file,
 * and the MCP tools this service exposes never echo a credential value back.
 *
 * Same fail-safe convention as gmail-sanitizer's excel-reports.ts
 * (loadReportTemplates): a missing file, invalid JSON, or a malformed entry
 * never crashes the service — it's just treated as "no accounts configured"
 * (per-entry for a malformed one).
 */
import fs from 'fs';
import path from 'path';

import { CompanyTypes, type ScraperCredentials } from 'israeli-bank-scrapers';

import { log } from '../log.js';

const CREDENTIALS_PATH = path.resolve(process.cwd(), 'data', 'bank-sync-credentials.json');

const VALID_COMPANY_IDS = new Set<string>(Object.values(CompanyTypes));

export interface BankSyncAccount {
  id: string;
  companyId: CompanyTypes;
  credentials?: ScraperCredentials;
}

function isValidAccount(raw: unknown): raw is BankSyncAccount {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return false;
  if (typeof r.companyId !== 'string' || !VALID_COMPANY_IDS.has(r.companyId)) return false;
  if (r.credentials !== undefined && (typeof r.credentials !== 'object' || r.credentials === null)) return false;
  return true;
}

/** Exported (with an overridable path) so tests can point it at a fixture file instead of the real data/ directory. */
export function loadBankSyncAccounts(configPath: string = CREDENTIALS_PATH): BankSyncAccount[] {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.error('bank-sync: cannot read bank-sync-credentials.json', { err });
    return []; // no config yet — nothing configured until data/bank-sync-credentials.json exists
  }

  let parsed: { accounts?: unknown[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('bank-sync: data/bank-sync-credentials.json is not valid JSON', { err });
    return []; // corrupt config — fail safe, never crash the service
  }

  const accounts: BankSyncAccount[] = [];
  for (const entry of parsed.accounts ?? []) {
    if (!isValidAccount(entry)) {
      log.error('bank-sync: skipping malformed account entry in bank-sync-credentials.json');
      continue;
    }
    accounts.push(entry);
  }
  return accounts;
}

/** Non-secret summary — what the MCP `bank_sync_accounts` tool and Homer are allowed to see. */
export function accountSummaries(configPath?: string): { id: string; companyId: CompanyTypes }[] {
  return loadBankSyncAccounts(configPath).map(({ id, companyId }) => ({ id, companyId }));
}
