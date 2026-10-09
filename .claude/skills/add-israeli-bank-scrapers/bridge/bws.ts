/**
 * Fetches bank/credit-card login credentials from Bitwarden Secrets Manager at
 * scrape time. The machine-account access token lives in the macOS Keychain
 * (service "bank-sync-bws"), is handed to `bws` via its environment (never
 * argv), and neither it nor the fetched credentials are written anywhere.
 *
 * Convention: one secret per account — key = the account id from
 * data/bank-sync-credentials.json, value = the credentials as a JSON object
 * (e.g. {"username":"...","password":"..."}).
 */
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';

import type { ScraperCredentials } from 'israeli-bank-scrapers';

import { log } from '../log.js';

const KEYCHAIN_SERVICE = 'bank-sync-bws';
// launchd's PATH is minimal, so default to the absolute install location.
const BWS_PATH = process.env.BANK_SYNC_BWS_PATH || path.join(os.homedir(), '.local', 'bin', 'bws');

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Exported for tests. Malformed entries are skipped (key only is logged, never a value). */
export function parseBwsSecrets(json: string): Map<string, ScraperCredentials> {
  const out = new Map<string, ScraperCredentials>();
  for (const entry of JSON.parse(json) as { key?: unknown; value?: unknown }[]) {
    try {
      if (typeof entry.key !== 'string' || typeof entry.value !== 'string') throw new Error('bad shape');
      const creds = JSON.parse(entry.value);
      if (typeof creds !== 'object' || creds === null || Array.isArray(creds)) throw new Error('not an object');
      out.set(entry.key, creds as ScraperCredentials);
    } catch {
      log.error('bank-sync: skipping malformed Bitwarden secret', { key: entry.key });
    }
  }
  return out;
}

/** Credentials by account id, for every secret the machine account can read. */
export async function fetchBankCredentials(): Promise<Map<string, ScraperCredentials>> {
  const token = (await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])).trim();
  const stdout = await run(BWS_PATH, ['secret', 'list', '--output', 'json'], {
    ...process.env,
    BWS_ACCESS_TOKEN: token,
  });
  return parseBwsSecrets(stdout);
}
