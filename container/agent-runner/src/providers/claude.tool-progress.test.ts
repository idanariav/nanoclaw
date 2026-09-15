import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ClaudeProvider surfaces each assistant tool_use block as a 'progress'
// event with a human-readable label (e.g. "Reading foo.ts"), so
// DELIVER_PROGRESS_EVENTS installs can narrate tool calls, not just SDK
// task_notification system messages. Deleting the tool_use branch in
// claude.ts goes red here.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tool-progress-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('tool_use progress narration', () => {
  it('yields a progress event per tool_use block, in stream order', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/workspace/agent/notes.md' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    );

    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; message?: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string; message?: string });

    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.map((e) => e.message)).toEqual(['Reading notes.md', 'Running: echo hi']);
  });

  it('suppresses TodoWrite calls', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] } },
      { type: 'result', subtype: 'success', result: 'done' },
    );

    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string });

    expect(events.filter((e) => e.type === 'progress')).toHaveLength(0);
  });

  it('narrates MCP tool calls generically from their SDK-formed name', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-3' },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'mcp__gmail__gmail_search_emails', input: { query: 'is:unread' } }],
        },
      },
      { type: 'result', subtype: 'success', result: 'done' },
    );

    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; message?: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string; message?: string });

    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.map((e) => e.message)).toEqual(['Searching emails (is:unread)']);
  });
});
