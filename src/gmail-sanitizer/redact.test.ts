import { describe, expect, it } from 'vitest';

import { redactHtml, redactText } from './redact.js';

describe('redactText', () => {
  it('redacts a valid Israeli ID (checksum-passing) but not an invalid one', () => {
    // 300000007 passes the standard Teudat Zehut checksum.
    expect(redactText('ID: 300000007')).toBe('ID: [ID_REDACTED]');
    // Flip the last digit to break the checksum.
    expect(redactText('ID: 300000008')).toBe('ID: 300000008');
  });

  it('redacts Israeli mobile numbers, dashed and undashed', () => {
    expect(redactText('call 052-1234567')).toBe('call [PHONE_REDACTED]');
    expect(redactText('call 0521234567')).toBe('call [PHONE_REDACTED]');
  });

  it('redacts Israeli landline numbers', () => {
    expect(redactText('office 03-1234567')).toBe('office [PHONE_REDACTED]');
  });

  it('redacts +972 international format', () => {
    expect(redactText('call +972-52-1234567')).toBe('call [PHONE_REDACTED]');
    expect(redactText('call +972521234567')).toBe('call [PHONE_REDACTED]');
  });

  it('redacts IL IBAN', () => {
    expect(redactText('IBAN: IL620108000000099999999')).toBe('IBAN: [BANK_ACCOUNT_REDACTED]');
  });

  it('redacts dash-separated bank/branch/account', () => {
    expect(redactText('account 12-345-123456')).toBe('account [BANK_ACCOUNT_REDACTED]');
  });

  it('redacts labeled bank/branch/account triples', () => {
    expect(redactText('Bank: 12 Branch: 345 Account: 1234567')).toBe('[BANK_ACCOUNT_REDACTED]');
  });

  it('redacts Luhn-valid credit-card-shaped numbers', () => {
    // 4111 1111 1111 1111 is the standard Luhn-valid test Visa number.
    expect(redactText('card 4111111111111111')).toBe('card [BANK_ACCOUNT_REDACTED]');
    expect(redactText('card 4111 1111 1111 1111')).toBe('card [BANK_ACCOUNT_REDACTED]');
  });

  it('does not redact a Luhn-invalid long number', () => {
    expect(redactText('ref 1234567890123456')).toBe('ref 1234567890123456');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactText('Hi, see you Tuesday at 3pm.')).toBe('Hi, see you Tuesday at 3pm.');
  });

  it('handles empty string', () => {
    expect(redactText('')).toBe('');
  });
});

describe('redactHtml', () => {
  it('strips markup and redacts PII hidden in it', () => {
    const html = '<p>My phone is <b>052-1234567</b></p>';
    expect(redactHtml(html)).toContain('[PHONE_REDACTED]');
    expect(redactHtml(html)).not.toContain('1234567');
  });

  it('redacts PII inside an href/attribute-adjacent text node', () => {
    const html = '<a href="tel:0521234567">Call me: 052-1234567</a>';
    const result = redactHtml(html);
    expect(result).not.toContain('1234567');
  });
});
