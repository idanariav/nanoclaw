import { describe, it, expect, beforeEach } from 'vitest';

import { BridgeRequestError, buildArgv, configureAllowedRoots, getAllowedRoots, isPathAllowed } from './allowlist.js';

describe('obsidian-bridge allowlist', () => {
  beforeEach(() => {
    configureAllowedRoots(['Scaffolding', 'Sources', 'Content']);
  });

  describe('configureAllowedRoots', () => {
    it('rejects an empty list — an unconfigured allowlist must fail closed', () => {
      expect(() => configureAllowedRoots([])).toThrow(/at least one/);
    });

    it('is readable back via getAllowedRoots', () => {
      configureAllowedRoots(['Foo', 'Bar']);
      expect(getAllowedRoots()).toEqual(['Foo', 'Bar']);
    });
  });

  describe('isPathAllowed', () => {
    it('allows a path under a configured root', () => {
      expect(isPathAllowed('Content/Claims/foo.md')).toBe(true);
    });

    it('allows the bare root itself', () => {
      expect(isPathAllowed('Content')).toBe(true);
    });

    it('rejects a path outside every configured root', () => {
      expect(isPathAllowed('Domains/secret.md')).toBe(false);
    });

    it('rejects a root-name prefix that is not actually the folder (e.g. "Contentious")', () => {
      expect(isPathAllowed('Contentious/foo.md')).toBe(false);
    });

    it('rejects path traversal even under an allowed root', () => {
      expect(isPathAllowed('Content/../Domains/secret.md')).toBe(false);
    });

    it('strips a leading slash before checking', () => {
      expect(isPathAllowed('/Content/foo.md')).toBe(true);
    });
  });

  describe('buildArgv', () => {
    it('rejects a command not on the allowlist', () => {
      expect(() => buildArgv('eval', {})).toThrow(BridgeRequestError);
      try {
        buildArgv('eval', {});
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeRequestError);
        expect((err as BridgeRequestError).status).toBe(403);
      }
    });

    it('rejects vault= override regardless of command', () => {
      expect(() => buildArgv('read', { path: 'Content/foo.md', vault: 'other' })).toThrow(/vault=/);
    });

    it('rejects file= for a command that only accepts path=', () => {
      expect(() => buildArgv('read', { file: 'foo' })).toThrow(/file=/);
    });

    it('allows file= for a command whose spec explicitly lists it', () => {
      // bookmark lists 'file' in pathFields with no required fields.
      const argv = buildArgv('bookmark', { file: 'Content/foo.md' });
      expect(argv).toEqual(['bookmark', 'file=Content/foo.md']);
    });

    it('requires a command\'s required fields', () => {
      expect(() => buildArgv('read', {})).toThrow(/'path=' is required/);
    });

    it('rejects a required path field pointing outside the allowed roots', () => {
      expect(() => buildArgv('read', { path: 'Domains/secret.md' })).toThrow(/path outside allowed scope/);
    });

    it('builds correct argv for a valid call, preserving key=value order', () => {
      const argv = buildArgv('create', { path: 'Content/Claims/foo.md', content: 'hello world' });
      expect(argv).toEqual(['create', 'path=Content/Claims/foo.md', 'content=hello world']);
    });

    it('renders a true boolean flag as a bare key, and drops false/undefined', () => {
      const argv = buildArgv('history', { path: 'Content/foo.md', verbose: true, total: false });
      expect(argv).toEqual(['history', 'path=Content/foo.md', 'verbose']);
    });

    it('allows a command with no path fields and no args', () => {
      expect(buildArgv('vault', {})).toEqual(['vault']);
    });
  });
});
