import { describe, expect, it } from 'vitest';

import { parseBwsSecrets } from './bws.js';

describe('parseBwsSecrets', () => {
  it('maps secret key to parsed credentials and skips malformed entries', () => {
    const json = JSON.stringify([
      { key: 'max-1', value: '{"username":"u","password":"p"}' },
      { key: 'bad-json', value: 'not json' },
      { key: 'not-object', value: '"str"' },
      { key: 'array', value: '[1]' },
      { value: '{}' },
    ]);
    const map = parseBwsSecrets(json);
    expect([...map.keys()]).toEqual(['max-1']);
    expect(map.get('max-1')).toEqual({ username: 'u', password: 'p' });
  });
});
