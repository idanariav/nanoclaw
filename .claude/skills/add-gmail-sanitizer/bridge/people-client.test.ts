import { describe, expect, it } from 'vitest';

import { matchesName } from './people-client.js';

describe('matchesName', () => {
  it('matches a display name exactly, case-insensitively', () => {
    expect(matchesName({ names: [{ displayName: 'Moshe Cohen' }] }, 'moshe cohen')).toBe(true);
  });

  it('matches ignoring surrounding whitespace on either side', () => {
    expect(matchesName({ names: [{ displayName: '  Moshe Cohen  ' }] }, 'Moshe Cohen')).toBe(true);
    expect(matchesName({ names: [{ displayName: 'Moshe Cohen' }] }, '  Moshe Cohen  ')).toBe(true);
  });

  it('does not match a different person with an overlapping first name', () => {
    expect(matchesName({ names: [{ displayName: 'Moshe Levi' }] }, 'Moshe Cohen')).toBe(false);
  });

  it('does not match a partial/substring name', () => {
    expect(matchesName({ names: [{ displayName: 'Moshe' }] }, 'Moshe Cohen')).toBe(false);
  });

  it('checks every alternate display name on the person', () => {
    const person = { names: [{ displayName: 'M. Cohen' }, { displayName: 'Moshe Cohen' }] };
    expect(matchesName(person, 'Moshe Cohen')).toBe(true);
  });

  it('returns false for a person with no names', () => {
    expect(matchesName({}, 'Moshe Cohen')).toBe(false);
  });
});
