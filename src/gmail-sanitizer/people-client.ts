/**
 * Raw Google People API access. Unlike gmail-client.ts (which returns
 * unredacted data for server.ts to anonymize), this file reduces every
 * response to presence-only booleans before returning — no name, email
 * address, or phone number value is ever assembled into a return value or
 * logged, so there is no raw-PII object anywhere for a caller-side bug to
 * leak. Requires the `contacts.readonly` OAuth scope on the gmail-sanitizer
 * OneCLI identity (see identity.ts's module comment for the shared-identity
 * caveat, and SKILL.md Phase 3 for connecting this scope).
 */
import { fetch } from 'undici';

import { getGmailSanitizerDispatcher } from './identity.js';

const PEOPLE_API = 'https://people.googleapis.com/v1';

interface RawPerson {
  names?: { displayName?: string }[];
  emailAddresses?: unknown[];
  phoneNumbers?: unknown[];
}

interface SearchContactsResponse {
  results?: { person?: RawPerson }[];
}

export interface ContactLookupResult {
  exists: boolean;
  has_email: boolean;
  has_phone: boolean;
}

/**
 * True if any of the person's display names matches the query exactly,
 * ignoring case and surrounding whitespace. Exported for unit testing —
 * pure function, no network I/O. Deliberately exact rather than fuzzy: the
 * People API's own search already does prefix/token matching to produce
 * candidates, so narrowing to an exact match here avoids a same-first-name
 * false positive turning into a false "exists: true".
 */
export function matchesName(person: RawPerson, query: string): boolean {
  const target = query.trim().toLowerCase();
  return (person.names ?? []).some((n) => (n.displayName ?? '').trim().toLowerCase() === target);
}

/**
 * Looks up a contact by full name and returns only whether it exists and
 * whether it has an email/phone on file — never the email or phone value
 * itself. Note: the People API's search index is built asynchronously from
 * the account's contacts, so a contact added moments ago may not be found
 * immediately.
 */
export async function lookupContact(name: string): Promise<ContactLookupResult> {
  const dispatcher = await getGmailSanitizerDispatcher();
  const url =
    `${PEOPLE_API}/people:searchContacts?query=${encodeURIComponent(name)}` +
    `&readMask=names,emailAddresses,phoneNumbers&pageSize=10`;
  const res = await fetch(url, { dispatcher });
  if (!res.ok) {
    throw new Error(`People API search -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const body = (await res.json()) as SearchContactsResponse;
  const match = (body.results ?? [])
    .map((r) => r.person)
    .filter((p): p is RawPerson => !!p)
    .find((p) => matchesName(p, name));

  if (!match) return { exists: false, has_email: false, has_phone: false };
  return {
    exists: true,
    has_email: (match.emailAddresses?.length ?? 0) > 0,
    has_phone: (match.phoneNumbers?.length ?? 0) > 0,
  };
}
