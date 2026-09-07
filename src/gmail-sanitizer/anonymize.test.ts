import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnonymizationStore, anonymizeHtml, anonymizeText, deanonymizeText } from './anonymize.js';

let store: AnonymizationStore;

beforeEach(() => {
  store = new AnonymizationStore();
});

describe('anonymizeText', () => {
  it('anonymizes a valid Israeli ID (checksum-passing) but not an invalid one', () => {
    // 300000007 passes the standard Teudat Zehut checksum.
    expect(anonymizeText('ID: 300000007', store)).toBe('ID: [ID_1]');
    // Flip the last digit to break the checksum.
    expect(anonymizeText('ID: 300000008', store)).toBe('ID: 300000008');
  });

  it('anonymizes Israeli mobile numbers, dashed and undashed', () => {
    expect(anonymizeText('call 052-1234567', store)).toBe('call [PHONE_1]');
    expect(anonymizeText('call 0521234567', store)).toBe('call [PHONE_1]');
  });

  it('anonymizes Israeli landline numbers', () => {
    expect(anonymizeText('office 03-1234567', store)).toBe('office [PHONE_1]');
  });

  it('anonymizes +972 international format', () => {
    expect(anonymizeText('call +972-52-1234567', store)).toBe('call [PHONE_1]');
    expect(anonymizeText('call +972521234567', store)).toBe('call [PHONE_1]');
  });

  it('anonymizes US-style dashed phone numbers', () => {
    expect(anonymizeText('call 555-123-4567', store)).toBe('call [PHONE_1]');
    expect(anonymizeText('call (555) 123-4567', store)).toBe('call [PHONE_1]');
    // A leading country code changes the digits-only dedup key, so this is a distinct token.
    expect(anonymizeText('call +1 555-123-4567', store)).toBe('call [PHONE_2]');
  });

  it('anonymizes IL IBAN', () => {
    expect(anonymizeText('IBAN: IL620108000000099999999', store)).toBe('IBAN: [BANK_ACCOUNT_1]');
  });

  it('anonymizes dash-separated bank/branch/account', () => {
    expect(anonymizeText('account 12-345-123456', store)).toBe('account [BANK_ACCOUNT_1]');
  });

  it('anonymizes labeled bank/branch/account triples, each as its own token', () => {
    expect(anonymizeText('Bank: 12 Branch: 345 Account: 1234567', store)).toBe(
      '[BANK_ACCOUNT_1] [BANK_ACCOUNT_2] [BANK_ACCOUNT_3]',
    );
  });

  it('anonymizes a Hebrew bank-details block with one field per line and the bank given by name', () => {
    const text = 'שם פרטי שם משפחה\nבנק לאומי\nסניף 111\nחשבון 1111111';
    const result = anonymizeText(text, store);
    expect(result).toBe('שם פרטי שם משפחה\nבנק לאומי\n[BANK_ACCOUNT_1]\n[BANK_ACCOUNT_2]');
    expect(result).not.toContain('111');
  });

  it('anonymizes Luhn-valid credit-card-shaped numbers', () => {
    // 4111 1111 1111 1111 is the standard Luhn-valid test Visa number.
    expect(anonymizeText('card 4111111111111111', store)).toBe('card [BANK_ACCOUNT_1]');
    expect(anonymizeText('card 4111 1111 1111 1111', store)).toBe('card [BANK_ACCOUNT_1]');
  });

  it('does not anonymize a Luhn-invalid long number', () => {
    expect(anonymizeText('ref 1234567890123456', store)).toBe('ref 1234567890123456');
  });

  it('leaves ordinary text untouched', () => {
    expect(anonymizeText('Hi, see you Tuesday at 3pm.', store)).toBe('Hi, see you Tuesday at 3pm.');
  });

  it('handles empty string', () => {
    expect(anonymizeText('', store)).toBe('');
  });

  it('reuses the same token for the same value seen again, even reformatted', () => {
    const first = anonymizeText('call 052-1234567', store);
    const second = anonymizeText('call again: 0521234567', store);
    expect(first).toBe('call [PHONE_1]');
    expect(second).toBe('call again: [PHONE_1]');
  });

  it('assigns increasing per-type counters to distinct values', () => {
    expect(anonymizeText('052-1234567 and 03-1234567', store)).toBe('[PHONE_1] and [PHONE_2]');
  });
});

describe('anonymizeHtml', () => {
  it('strips markup and anonymizes PII hidden in it', () => {
    const html = '<p>My phone is <b>052-1234567</b></p>';
    expect(anonymizeHtml(html, store)).toContain('[PHONE_1]');
    expect(anonymizeHtml(html, store)).not.toContain('1234567');
  });

  it('anonymizes PII inside an href/attribute-adjacent text node', () => {
    const html = '<a href="tel:0521234567">Call me: 052-1234567</a>';
    const result = anonymizeHtml(html, store);
    expect(result).not.toContain('1234567');
  });
});

describe('deanonymizeText', () => {
  it('round-trips a token back to the real value', () => {
    const anonymized = anonymizeText('call me at 052-1234567', store);
    expect(anonymized).toBe('call me at [PHONE_1]');
    expect(deanonymizeText(anonymized, store)).toBe('call me at 052-1234567');
  });

  it('resolves a token copied into unrelated text, not just the original sentence', () => {
    anonymizeText('052-1234567', store);
    expect(deanonymizeText('here is the number: [PHONE_1]', store)).toBe('here is the number: 052-1234567');
  });

  it('leaves an unrecognized token untouched', () => {
    expect(deanonymizeText('made up: [PHONE_99]', store)).toBe('made up: [PHONE_99]');
  });

  it('leaves ordinary text untouched', () => {
    expect(deanonymizeText('Hi, see you Tuesday at 3pm.', store)).toBe('Hi, see you Tuesday at 3pm.');
  });
});

describe('disk persistence', () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anonymize-store-test-'));
    storePath = path.join(dir, 'store.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives across store instances (e.g. a process restart)', () => {
    const before = new AnonymizationStore(storePath);
    const token = anonymizeText('call 052-1234567', before);
    expect(token).toBe('call [PHONE_1]');

    const after = new AnonymizationStore(storePath);
    expect(deanonymizeText('[PHONE_1]', after)).toBe('052-1234567');
  });

  it('continues per-type numbering from what was loaded, instead of restarting at 1', () => {
    const before = new AnonymizationStore(storePath);
    anonymizeText('052-1234567', before);

    const after = new AnonymizationStore(storePath);
    expect(anonymizeText('03-1234567', after)).toBe('[PHONE_2]');
  });

  it('drops an entry older than 14 days when the store is loaded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const before = new AnonymizationStore(storePath);
    anonymizeText('052-1234567', before);

    vi.setSystemTime(new Date('2026-01-16T00:00:01Z')); // 15 days + 1s later
    const after = new AnonymizationStore(storePath);
    expect(deanonymizeText('[PHONE_1]', after)).toBe('[PHONE_1]'); // token no longer resolvable
    // The counter also resets, since the expired entry no longer counts as "loaded".
    expect(anonymizeText('03-1234567', after)).toBe('[PHONE_1]');
  });

  it('keeps an entry that is under 14 days old when the store is loaded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const before = new AnonymizationStore(storePath);
    anonymizeText('052-1234567', before);

    vi.setSystemTime(new Date('2026-01-14T23:59:00Z')); // just under 14 days later
    const after = new AnonymizationStore(storePath);
    expect(deanonymizeText('[PHONE_1]', after)).toBe('052-1234567');
  });
});
