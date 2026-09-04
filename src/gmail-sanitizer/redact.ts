/**
 * Deterministic PII redaction — no LLM involved. This runs inside the
 * gmail-sanitizer process, before any text is placed in an HTTP response an
 * agent container can read. Bias is toward over-redaction: a false-positive
 * redaction is a minor annoyance, a false-negative is a leak.
 *
 * Order matters: each pass consumes digit runs it matches (replacing them
 * with a `[..._REDACTED]` tag), so later passes never re-match digits an
 * earlier pass already redacted.
 */
import { convert as htmlToText } from 'html-to-text';

const IL_PHONE_RE =
  /(?:\+|00)972[-.\s]?(?:[2-489][-.\s]?\d{7}|5\d[-.\s]?\d{7})\b|\b0(?:[2-489][-.\s]?\d{7}|5\d[-.\s]?\d{7})\b/g;

const IL_IBAN_RE = /\bIL\d{2}[\s]?(?:\d{4}[\s]?){4}\d{1,4}\b/gi;

// Israeli bank-branch-account, dash-separated: bank (1-2) - branch (2-3) - account (6-9)
const IL_BANK_DASH_RE = /\b\d{1,2}-\d{2,3}-\d{6,9}\b/g;

// Hebrew/English labeled bank/branch/account triples in free text.
const IL_BANK_LABELED_RE =
  /(?:bank|בנק)[^\d\n]{0,12}(\d{1,2})[^\d\n]{0,12}(?:branch|סניף)[^\d\n]{0,12}(\d{2,3})[^\d\n]{0,12}(?:account|חשבון)[^\d\n]{0,12}(\d{4,9})/gi;

// Credit-card-shaped runs (13-19 digits, optionally grouped), Luhn-validated
// to cut down false positives on unrelated long numbers.
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Standard Israeli Teudat Zehut checksum (Luhn-like, weights 1/2 alternating). */
function isValidIsraeliId(idDigits: string): boolean {
  if (!/^\d{9}$/.test(idDigits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(idDigits[i]) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

function redactPhones(text: string): string {
  return text.replace(IL_PHONE_RE, '[PHONE_REDACTED]');
}

function redactBankIdentifiers(text: string): string {
  return text
    .replace(IL_IBAN_RE, '[BANK_ACCOUNT_REDACTED]')
    .replace(IL_BANK_LABELED_RE, '[BANK_ACCOUNT_REDACTED]')
    .replace(IL_BANK_DASH_RE, '[BANK_ACCOUNT_REDACTED]');
}

function redactCreditCards(text: string): string {
  return text.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    return luhnValid(digits) ? '[BANK_ACCOUNT_REDACTED]' : match;
  });
}

function redactIsraeliIds(text: string): string {
  return text.replace(/\b\d{9}\b/g, (match) => (isValidIsraeliId(match) ? '[ID_REDACTED]' : match));
}

/** Redact a plain-text string. Safe to call on subjects, snippets, and bodies. */
export function redactText(text: string): string {
  if (!text) return text;
  let result = text;
  result = redactPhones(result);
  result = redactBankIdentifiers(result);
  result = redactCreditCards(result);
  result = redactIsraeliIds(result);
  return result;
}

/** Convert an HTML email body to text, then redact. */
export function redactHtml(html: string): string {
  if (!html) return html;
  const text = htmlToText(html, { wordwrap: false });
  return redactText(text);
}
