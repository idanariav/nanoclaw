import path from 'path';

/**
 * Human-readable "what is the agent doing right now" labels for SDK
 * `tool_use` blocks, surfaced as mid-turn `progress` events
 * (NANOCLAW_DELIVER_PROGRESS_EVENTS — see claude.ts). Generic by design: MCP
 * tools (gmail, bank-sync, obsidian, any future `/add-*` skill) get a
 * humanized label derived from their tool name rather than a hardcoded
 * per-skill mapping, so a newly installed MCP tool narrates itself with no
 * changes here.
 */

const SUPPRESSED_TOOLS = new Set(['TodoWrite']);

const IRREGULAR_GERUNDS: Record<string, string> = {
  get: 'getting',
  set: 'setting',
  run: 'running',
  put: 'putting',
  stop: 'stopping',
};

function gerund(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR_GERUNDS[lower]) return IRREGULAR_GERUNDS[lower];
  if (lower.endsWith('e') && !lower.endsWith('ee')) return `${lower.slice(0, -1)}ing`;
  return `${lower}ing`;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Pick the first string-valued argument from a set of common identifying keys. */
function firstStringArg(input: Record<string, unknown>): string | undefined {
  for (const key of ['query', 'q', 'search', 'subject', 'path', 'file', 'filename', 'url', 'id', 'emailId', 'name']) {
    const v = input[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function describeFileTool(verb: string, input: Record<string, unknown>): string {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  return filePath ? `${verb} ${path.basename(filePath)}` : `${verb} a file`;
}

function describeMcpToolUse(name: string, input: Record<string, unknown>): string {
  // SDK-formed MCP tool names: mcp__<server>__<tool>.
  const parts = name.split('__');
  const server = parts.length > 1 ? parts[1] : undefined;
  let rest = parts.length > 2 ? parts.slice(2).join('_') : name;
  if (server && rest.toLowerCase().startsWith(`${server.toLowerCase()}_`)) {
    rest = rest.slice(server.length + 1);
  }
  const words = rest.split('_').filter(Boolean);
  if (words.length === 0) return `Using ${server ?? name}`;
  const [verb, ...tail] = words;
  const label = [capitalize(gerund(verb!)), ...tail].join(' ');
  const detail = firstStringArg(input);
  return detail ? `${label} (${truncate(detail, 60)})` : label;
}

function describeBuiltinToolUse(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      return cmd ? `Running: ${truncate(cmd, 80)}` : 'Running a command';
    }
    case 'Read':
      return describeFileTool('Reading', input);
    case 'Write':
      return describeFileTool('Writing', input);
    case 'Edit':
      return describeFileTool('Editing', input);
    case 'NotebookEdit':
      return describeFileTool('Editing notebook', input);
    case 'Grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
      return pattern ? `Searching for "${truncate(pattern, 60)}"` : 'Searching files';
    }
    case 'Glob': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
      return pattern ? `Finding files matching ${pattern}` : 'Finding files';
    }
    case 'WebFetch': {
      const url = typeof input.url === 'string' ? input.url : undefined;
      return url ? `Fetching ${truncate(url, 80)}` : 'Fetching a page';
    }
    case 'WebSearch': {
      const query = typeof input.query === 'string' ? input.query : undefined;
      return query ? `Searching the web for "${truncate(query, 60)}"` : 'Searching the web';
    }
    case 'Task': {
      const description = typeof input.description === 'string' ? input.description : undefined;
      return description ? `Delegating: ${truncate(description, 60)}` : 'Delegating to a subagent';
    }
    case 'TaskOutput':
      return 'Checking a subagent’s output';
    case 'TaskStop':
      return 'Stopping a subagent';
    case 'TeamCreate':
      return 'Creating a team';
    case 'TeamDelete':
      return 'Disbanding a team';
    case 'ToolSearch':
      return 'Looking up a tool';
    case 'Skill': {
      const skill = typeof input.skill === 'string' ? input.skill : undefined;
      return skill ? `Using the ${skill} skill` : 'Using a skill';
    }
    default:
      return null;
  }
}

/**
 * Describe an SDK `tool_use` block as a short present-progressive status
 * line, or return null to suppress it (bookkeeping tools with no useful
 * signal for the user, e.g. TodoWrite).
 */
export function describeToolUse(name: string, rawInput: unknown): string | null {
  if (SUPPRESSED_TOOLS.has(name)) return null;
  const input = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
  if (name.startsWith('mcp__')) return describeMcpToolUse(name, input);
  return describeBuiltinToolUse(name, input) ?? `Using ${name}`;
}
