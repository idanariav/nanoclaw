import { describe, it, expect } from 'bun:test';

import { describeToolUse } from './tool-progress.js';

describe('describeToolUse', () => {
  it('suppresses TodoWrite', () => {
    expect(describeToolUse('TodoWrite', { todos: [] })).toBeNull();
  });

  it('describes Bash with the command', () => {
    expect(describeToolUse('Bash', { command: 'ls -la' })).toBe('Running: ls -la');
  });

  it('describes Bash with no command', () => {
    expect(describeToolUse('Bash', {})).toBe('Running a command');
  });

  it('describes Read/Write/Edit with the file basename', () => {
    expect(describeToolUse('Read', { file_path: '/workspace/agent/notes.md' })).toBe('Reading notes.md');
    expect(describeToolUse('Write', { file_path: '/workspace/agent/notes.md' })).toBe('Writing notes.md');
    expect(describeToolUse('Edit', { file_path: '/workspace/agent/notes.md' })).toBe('Editing notes.md');
  });

  it('describes Grep/Glob/WebFetch/WebSearch with their query', () => {
    expect(describeToolUse('Grep', { pattern: 'TODO' })).toBe('Searching for "TODO"');
    expect(describeToolUse('Glob', { pattern: '**/*.ts' })).toBe('Finding files matching **/*.ts');
    expect(describeToolUse('WebFetch', { url: 'https://example.com' })).toBe('Fetching https://example.com');
    expect(describeToolUse('WebSearch', { query: 'nanoclaw' })).toBe('Searching the web for "nanoclaw"');
  });

  it('truncates long values', () => {
    const longCmd = 'x'.repeat(200);
    const result = describeToolUse('Bash', { command: longCmd });
    expect(result!.length).toBeLessThan(100);
    expect(result!.endsWith('…')).toBe(true);
  });

  it('humanizes an MCP tool name generically, without per-skill hardcoding', () => {
    expect(describeToolUse('mcp__gmail__gmail_search_emails', { query: 'from:someone@example.com' })).toBe(
      'Searching emails (from:someone@example.com)',
    );
    expect(describeToolUse('mcp__gmail__gmail_read_email', { emailId: 'abc123' })).toBe('Reading email (abc123)');
    expect(describeToolUse('mcp__obsidian__obsidian_run', {})).toBe('Running');
  });

  it('falls back to a generic label for an unrecognized builtin tool', () => {
    expect(describeToolUse('SomeFutureTool', {})).toBe('Using SomeFutureTool');
  });

  it('handles non-object tool_use input', () => {
    expect(describeToolUse('Bash', undefined)).toBe('Running a command');
    expect(describeToolUse('Bash', null)).toBe('Running a command');
  });
});
