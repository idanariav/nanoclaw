import { describe, expect, it } from 'vitest';

import {
  ArtistPaymentTemplateError,
  computeInvoiceDeadline,
  parseArtistPaymentTemplate,
  renderArtistPaymentDrafts,
  type ArtistPaymentTemplate,
} from './artist-payment-drafts.js';
import type { ArtistPaymentRow } from './monthly-report.js';

function row(overrides: Partial<ArtistPaymentRow> = {}): ArtistPaymentRow {
  return {
    name: 'Ziv Harmelin',
    email: 'ziv@example.com',
    payeeName: '',
    payeeEmail: '',
    amount: '1500',
    ...overrides,
  };
}

describe('parseArtistPaymentTemplate', () => {
  it('splits the subject line from the body', () => {
    const parsed = parseArtistPaymentTemplate('Subject: Hi {{name}}\n\nBody line 1\nBody line 2');
    expect(parsed).toEqual({ subject: 'Hi {{name}}', body: 'Body line 1\nBody line 2' });
  });

  it('rejects a template with no Subject: line', () => {
    expect(() => parseArtistPaymentTemplate('just a body')).toThrow(ArtistPaymentTemplateError);
  });
});

describe('computeInvoiceDeadline', () => {
  it('returns the 7th of the following month', () => {
    expect(computeInvoiceDeadline(new Date(Date.UTC(2026, 8, 9)))).toBe('07/10/2026'); // Sept -> Oct
  });

  it('rolls over the year at December', () => {
    expect(computeInvoiceDeadline(new Date(Date.UTC(2026, 11, 20)))).toBe('07/01/2027');
  });
});

const TEMPLATE: ArtistPaymentTemplate = {
  subject: 'Payment for {{firstName}}',
  body: 'Hey {{firstName}}, you earned {{amount}}.\n{{#if (gt amount 1000)}}Large payment.{{else}}Small payment.{{/if}}\nDue {{invoiceDeadline}}.',
};
const REF_DATE = new Date(Date.UTC(2026, 8, 9));

describe('renderArtistPaymentDrafts', () => {
  it('renders subject/body with substitution and a comparison helper', () => {
    const { rendered, skipped } = renderArtistPaymentDrafts(
      [row({ name: 'Dana Cohen', amount: '2000' })],
      TEMPLATE,
      REF_DATE,
    );
    expect(skipped).toEqual([]);
    expect(rendered).toHaveLength(1);
    expect(rendered[0].subject).toBe('Payment for Dana');
    expect(rendered[0].body).toBe('Hey Dana, you earned 2000.\nLarge payment.\nDue 07/10/2026.');
    expect(rendered[0].to).toBe('ziv@example.com');
  });

  it('takes the else branch when the condition is false', () => {
    const { rendered } = renderArtistPaymentDrafts([row({ amount: '500' })], TEMPLATE, REF_DATE);
    expect(rendered[0].body).toContain('Small payment.');
  });

  it('prefers payeeEmail over the artist email when both are present', () => {
    const { rendered } = renderArtistPaymentDrafts(
      [row({ email: 'artist@example.com', payeeEmail: 'payee@example.com' })],
      TEMPLATE,
      REF_DATE,
    );
    expect(rendered[0].to).toBe('payee@example.com');
  });

  it('skips a row with no amount', () => {
    const { rendered, skipped } = renderArtistPaymentDrafts([row({ amount: '' })], TEMPLATE, REF_DATE);
    expect(rendered).toEqual([]);
    expect(skipped).toEqual([{ name: 'Ziv Harmelin', reason: 'amount is blank or not greater than zero' }]);
  });

  it('skips a row with a zero or non-numeric amount', () => {
    const { skipped } = renderArtistPaymentDrafts(
      [row({ amount: '0' }), row({ name: 'Bad Amount', amount: 'n/a' })],
      TEMPLATE,
      REF_DATE,
    );
    expect(skipped).toHaveLength(2);
  });

  it('skips a row with no resolvable email address', () => {
    const { rendered, skipped } = renderArtistPaymentDrafts([row({ email: '', payeeEmail: '' })], TEMPLATE, REF_DATE);
    expect(rendered).toEqual([]);
    expect(skipped).toEqual([{ name: 'Ziv Harmelin', reason: 'no email address on file' }]);
  });

  it('filters to onlyArtist when given', () => {
    const rows = [row({ name: 'Artist A' }), row({ name: 'Artist B' })];
    const { rendered } = renderArtistPaymentDrafts(rows, TEMPLATE, REF_DATE, 'Artist B');
    expect(rendered.map((r) => r.name)).toEqual(['Artist B']);
  });
});
