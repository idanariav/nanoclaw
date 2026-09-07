/**
 * Deterministic PII anonymization — no LLM involved. This runs inside the
 * gmail-sanitizer process, before any text is placed in an HTTP response an
 * agent container can read. Bias is toward over-detection: a false-positive
 * is a minor annoyance, a false-negative is a leak.
 *
 * Detected values are replaced with numbered tokens (`[PHONE_1]`,
 * `[BANK_ACCOUNT_2]`, `[ID_3]`, ...) rather than a single static tag, and
 * the real value is kept server-side in an AnonymizationStore. The same
 * value always gets the same token, and a token can be copied verbatim
 * between tool calls — deanonymizeText() swaps it back to the real value
 * right before text reaches Gmail (see server.ts's /drafts handler). The
 * agent's context never holds the real value, only the token.
 *
 * Order matters: each detection pass consumes the digit runs it matches
 * (replacing them with a token), so later passes never re-match digits an
 * earlier pass already replaced.
 *
 * The default store persists to data/gmail-anonymization-store.json so a
 * token survives a gmail-sanitizer restart, and self-expires: any entry
 * older than 14 days is dropped (on load and hourly thereafter), which is
 * what keeps the file from growing forever.
 */
import fs from 'fs';
import path from 'path';

import { convert as htmlToText } from 'html-to-text';

const IL_PHONE_RE =
  /(?:\+|00)972[-.\s]?(?:[2-489][-.\s]?\d{7}|5\d[-.\s]?\d{7})\b|\b0(?:[2-489][-.\s]?\d{7}|5\d[-.\s]?\d{7})\b/g;

// Non-Israeli phone numbers written with explicit group separators, e.g.
// "555-123-4567", "555.123.4567", "(555) 123-4567", "+1 555-123-4567".
const GENERIC_PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g;

const IL_IBAN_RE = /\bIL\d{2}[\s]?(?:\d{4}[\s]?){4}\d{1,4}\b/gi;

// Israeli bank-branch-account, dash-separated: bank (1-2) - branch (2-3) - account (6-9)
const IL_BANK_DASH_RE = /\b\d{1,2}-\d{2,3}-\d{6,9}\b/g;

// Hebrew/English labeled bank/branch/account fields in free text. Matched
// independently rather than as one chained "bank...branch...account"
// pattern — real emails put each field on its own line, and the bank field
// is often given by name ("בנק לאומי") rather than its numeric code, which
// would break a chain anchored on that field.
const IL_BANK_CODE_LABELED_RE = /(?:bank|בנק)[:\-\s]{0,5}(\d{1,2})\b/gi;
const IL_BANK_BRANCH_LABELED_RE = /(?:branch|סניף)[:\-\s]{0,5}(\d{2,3})\b/gi;
const IL_BANK_ACCOUNT_LABELED_RE = /(?:account|חשבון)[:\-\s]{0,5}(\d{4,9})\b/gi;

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

type PiiType = 'PHONE' | 'BANK_ACCOUNT' | 'ID';

const TOKEN_RE = /\[(?:PHONE|BANK_ACCOUNT|ID)_\d+\]/g;

// Entries older than this are dropped — both on load and on a periodic
// sweep — so the store can't grow forever on a long-running process.
const TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface Entry {
  key: string;
  token: string;
  value: string;
  createdAt: number;
}

/**
 * Bidirectional value<->token map, private to the gmail-sanitizer process.
 * A value is tokenized once and reused on every later match — across
 * emails, and (when persisted to disk) across process restarts — so the
 * same phone number always gets the same token wherever it appears. Values
 * are keyed by digits-only so the same number in different formats
 * ("052-1234567" vs "0521234567") still dedupes to one token.
 *
 * Passing `persistPath` makes the store durable: it loads existing entries
 * from that file on construction, writes new ones back immediately, and
 * sweeps out anything older than TTL_MS once an hour. Tests construct the
 * store with no path, so they stay in-memory only and never touch disk or
 * start a timer.
 */
export class AnonymizationStore {
  private byKey = new Map<string, Entry>();
  private byToken = new Map<string, Entry>();
  private counters: Record<PiiType, number> = { PHONE: 0, BANK_ACCOUNT: 0, ID: 0 };
  private readonly persistPath?: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath;
    if (!persistPath) return;
    this.load();
    const sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }

  tokenize(type: PiiType, rawValue: string): string {
    const key = `${type}:${rawValue.replace(/\D/g, '')}`;
    const existing = this.byKey.get(key);
    if (existing) return existing.token;

    this.counters[type] += 1;
    const entry: Entry = { key, token: `[${type}_${this.counters[type]}]`, value: rawValue, createdAt: Date.now() };
    this.byKey.set(key, entry);
    this.byToken.set(entry.token, entry);
    this.save();
    return entry.token;
  }

  /** Replace every token in `text` with the real value it stands for. Unrecognized (or expired) tokens are left as-is. */
  detokenize(text: string): string {
    return text.replace(TOKEN_RE, (token) => this.byToken.get(token)?.value ?? token);
  }

  /** Drop entries older than TTL_MS. Returns whether anything was removed. */
  private sweep(): boolean {
    const cutoff = Date.now() - TTL_MS;
    let changed = false;
    for (const entry of this.byKey.values()) {
      if (entry.createdAt < cutoff) {
        this.byKey.delete(entry.key);
        this.byToken.delete(entry.token);
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  private load(): void {
    if (!this.persistPath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistPath, 'utf-8');
    } catch {
      return; // no store file yet — fresh start
    }
    let parsed: { entries?: Entry[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt file — start fresh rather than crash the service
    }
    const cutoff = Date.now() - TTL_MS;
    for (const entry of parsed.entries ?? []) {
      if (entry.createdAt < cutoff) continue;
      this.byKey.set(entry.key, entry);
      this.byToken.set(entry.token, entry);
      const type = entry.key.slice(0, entry.key.indexOf(':')) as PiiType;
      const num = Number(entry.token.slice(entry.token.lastIndexOf('_') + 1, -1));
      if (Number.isFinite(num) && num > this.counters[type]) this.counters[type] = num;
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({ entries: [...this.byKey.values()] }, null, 2) + '\n');
    } catch {
      // Best-effort — an unwritable store file degrades to in-memory-only
      // for this process, not a hard failure.
    }
  }
}

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), 'data', 'gmail-anonymization-store.json');

/** Shared store for the process's lifetime — server.ts anonymizes reads and deanonymizes draft writes against the same instance. */
const defaultStore = new AnonymizationStore(DEFAULT_STORE_PATH);

function anonymizePhones(text: string, store: AnonymizationStore): string {
  let result = text.replace(IL_PHONE_RE, (m) => store.tokenize('PHONE', m));
  result = result.replace(GENERIC_PHONE_RE, (m) => store.tokenize('PHONE', m));
  return result;
}

function anonymizeBankIdentifiers(text: string, store: AnonymizationStore): string {
  let result = text.replace(IL_IBAN_RE, (m) => store.tokenize('BANK_ACCOUNT', m));
  result = result.replace(IL_BANK_CODE_LABELED_RE, (m) => store.tokenize('BANK_ACCOUNT', m));
  result = result.replace(IL_BANK_BRANCH_LABELED_RE, (m) => store.tokenize('BANK_ACCOUNT', m));
  result = result.replace(IL_BANK_ACCOUNT_LABELED_RE, (m) => store.tokenize('BANK_ACCOUNT', m));
  result = result.replace(IL_BANK_DASH_RE, (m) => store.tokenize('BANK_ACCOUNT', m));
  return result;
}

function anonymizeCreditCards(text: string, store: AnonymizationStore): string {
  return text.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    return luhnValid(digits) ? store.tokenize('BANK_ACCOUNT', match) : match;
  });
}

function anonymizeIsraeliIds(text: string, store: AnonymizationStore): string {
  return text.replace(/\b\d{9}\b/g, (match) => (isValidIsraeliId(match) ? store.tokenize('ID', match) : match));
}

/** Anonymize a plain-text string. Safe to call on subjects, snippets, and bodies. */
export function anonymizeText(text: string, store: AnonymizationStore = defaultStore): string {
  if (!text) return text;
  let result = text;
  result = anonymizePhones(result, store);
  result = anonymizeBankIdentifiers(result, store);
  result = anonymizeCreditCards(result, store);
  result = anonymizeIsraeliIds(result, store);
  return result;
}

/** Convert an HTML email body to text, then anonymize. */
export function anonymizeHtml(html: string, store: AnonymizationStore = defaultStore): string {
  if (!html) return html;
  const text = htmlToText(html, { wordwrap: false });
  return anonymizeText(text, store);
}

/** Replace anonymization tokens (e.g. `[PHONE_1]`) with the real values they stand for. Used right before text reaches Gmail. */
export function deanonymizeText(text: string, store: AnonymizationStore = defaultStore): string {
  if (!text) return text;
  return store.detokenize(text);
}
