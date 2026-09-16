import { describe, expect, it } from 'vitest';
import { buildInvocation, BridgeRequestError } from './allowlist.js';

describe('buildInvocation', () => {
  it('rejects an unknown command', () => {
    expect(() => buildInvocation({ command: 'eval' })).toThrow(BridgeRequestError);
  });

  it('rejects a missing command', () => {
    expect(() => buildInvocation({})).toThrow(BridgeRequestError);
  });

  it('builds argv for a read command with no args', () => {
    expect(buildInvocation({ command: 'workspace' })).toEqual({ argv: ['workspace'], stdin: undefined });
  });

  it('builds argv for a write command with positional + flags', () => {
    const result = buildInvocation({
      command: 'task-create',
      positional: ['Buy milk'],
      flags: { priority: 2, tags: 'errand' },
    });
    expect(result.argv).toEqual(['task', 'create', 'Buy milk', '--priority', '2', '--tags', 'errand']);
  });

  it('turns a true boolean flag into a bare flag and drops false', () => {
    const result = buildInvocation({
      command: 'task-query',
      positional: ['priority <= 2'],
      flags: { verbose: true, total: false },
    });
    expect(result.argv).toEqual(['task', 'query', 'priority <= 2', '--verbose']);
  });

  it('refuses a destructive command without confirm', () => {
    expect(() => buildInvocation({ command: 'task-delete', positional: ['abc'] })).toThrow(/destructive/);
  });

  it('strips confirm from the forwarded flags once present', () => {
    const result = buildInvocation({
      command: 'task-delete',
      positional: ['abc'],
      flags: { confirm: true },
    });
    expect(result.argv).toEqual(['task', 'delete', 'abc']);
  });

  it('rejects an invalid flag name', () => {
    expect(() => buildInvocation({ command: 'workspace', flags: { 'bad flag': 'x' } })).toThrow(/invalid flag name/);
  });

  it('rejects an object/array flag value', () => {
    expect(() => buildInvocation({ command: 'workspace', flags: { tags: ['a', 'b'] } })).toThrow(
      /must be a string, number, or boolean/,
    );
  });

  it('rejects stdin for a command that does not allow it', () => {
    expect(() => buildInvocation({ command: 'task-query', stdin: '{}' })).toThrow(/does not accept a stdin payload/);
  });

  it('accepts stdin for a bulk command', () => {
    const result = buildInvocation({ command: 'task-bulk-create', stdin: '{"items":[]}' });
    expect(result.argv).toEqual(['task', 'bulk-create']);
    expect(result.stdin).toBe('{"items":[]}');
  });

  it('rejects too many positional args', () => {
    expect(() => buildInvocation({ command: 'workspace', positional: Array(11).fill('x') })).toThrow(/positional/);
  });

  it('rejects a non-string positional entry', () => {
    expect(() => buildInvocation({ command: 'workspace', positional: [1] })).toThrow(/positional/);
  });
});
