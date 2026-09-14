import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { describe, expect, it, afterEach } from 'vitest';

import { accountSummaries, loadBankSyncAccounts } from './credentials.js';

describe('loadBankSyncAccounts', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeConfig(content: string): string {
    dir = mkdtempSync(path.join(tmpdir(), 'bank-sync-creds-'));
    const file = path.join(dir, 'bank-sync-credentials.json');
    writeFileSync(file, content);
    return file;
  }

  it('returns [] when the file does not exist', () => {
    expect(loadBankSyncAccounts('/does/not/exist/bank-sync-credentials.json')).toEqual([]);
  });

  it('returns [] on invalid JSON, never throws', () => {
    const file = writeConfig('{ not json');
    expect(loadBankSyncAccounts(file)).toEqual([]);
  });

  it('loads valid accounts and skips malformed entries', () => {
    const file = writeConfig(
      JSON.stringify({
        accounts: [
          { id: 'yahav-1', companyId: 'yahav', credentials: { username: 'u', password: 'p', nationalID: 'n' } },
          { id: 'missing-company', credentials: { username: 'u', password: 'p' } },
          { id: 'bad-company', companyId: 'notARealCompany', credentials: { username: 'u', password: 'p' } },
          { companyId: 'max', credentials: { username: 'u', password: 'p' } },
          { id: 'no-credentials', companyId: 'max' },
          { id: 'max-1', companyId: 'max', credentials: { username: 'u', password: 'p' } },
        ],
      }),
    );
    const accounts = loadBankSyncAccounts(file);
    expect(accounts.map((a) => a.id)).toEqual(['yahav-1', 'max-1']);
  });

  it('accountSummaries never includes credentials', () => {
    const file = writeConfig(
      JSON.stringify({
        accounts: [{ id: 'max-1', companyId: 'max', credentials: { username: 'secret-user', password: 'secret-pw' } }],
      }),
    );
    const summaries = accountSummaries(file);
    expect(summaries).toEqual([{ id: 'max-1', companyId: 'max' }]);
    expect(JSON.stringify(summaries)).not.toContain('secret');
  });
});
