/**
 * clarity CLI command allowlist for the clarity-bridge service.
 *
 * Unlike obsidian-cli, the Clarity CLI has no filesystem-path concept to wall
 * off — tasks/projects/tags are DB rows, addressed by id or name, and the
 * CLI's own domain layer already validates board/column/project/tag names.
 * So this allowlist's job is narrower: name which subcommands are reachable
 * at all (fail-closed — everything else is refused), and require an explicit
 * `confirm: true` flag for destructive ones (delete-class commands) so a
 * model can't wipe data as a side effect of a malformed call.
 *
 * Every entry mirrors a row in cli/README.md's command table in the Clarity
 * repo. `write: true` marks a command that mutates the DB.
 */

export interface CommandSpec {
  /** The literal argv words that select this subcommand, e.g. ['task', 'create']. */
  subcommand: string[];
  write: boolean;
  /** Delete-class commands: require flags.confirm === true (stripped before forwarding). */
  destructive?: boolean;
  /** task bulk-create/bulk-update/bulk-delete: JSON payload goes on stdin, not a file path. */
  allowsStdin?: boolean;
}

export const ALLOWED_COMMANDS: Record<string, CommandSpec> = {
  workspace: { subcommand: ['workspace'], write: false },
  tools: { subcommand: ['tools'], write: false },
  'view-run': { subcommand: ['view', 'run'], write: false },
  'task-query': { subcommand: ['task', 'query'], write: false },
  'task-get': { subcommand: ['task', 'get'], write: false },
  'task-create': { subcommand: ['task', 'create'], write: true },
  'task-update': { subcommand: ['task', 'update'], write: true },
  'task-complete': { subcommand: ['task', 'complete'], write: true },
  'task-delete': { subcommand: ['task', 'delete'], write: true, destructive: true },
  'task-bulk-create': { subcommand: ['task', 'bulk-create'], write: true, allowsStdin: true },
  'task-bulk-update': { subcommand: ['task', 'bulk-update'], write: true, allowsStdin: true },
  'task-bulk-delete': { subcommand: ['task', 'bulk-delete'], write: true, destructive: true, allowsStdin: true },
  'milestone-create': { subcommand: ['milestone-create'], write: true },
  'tag-create': { subcommand: ['tag', 'create'], write: true },
  'tag-update': { subcommand: ['tag', 'update'], write: true },
  'tag-delete': { subcommand: ['tag', 'delete'], write: true, destructive: true },
  'project-create': { subcommand: ['project', 'create'], write: true },
  'project-update': { subcommand: ['project', 'update'], write: true },
  'project-delete': { subcommand: ['project', 'delete'], write: true, destructive: true },
  'checklist-add': { subcommand: ['checklist', 'add'], write: true },
  'checklist-set-done': { subcommand: ['checklist', 'set-done'], write: true },
  'checklist-rename': { subcommand: ['checklist', 'rename'], write: true },
  'checklist-delete': { subcommand: ['checklist', 'delete'], write: true, destructive: true },
  'habit-list': { subcommand: ['habit', 'list'], write: false },
  'habit-complete': { subcommand: ['habit', 'complete'], write: true },
  'habit-set-day': { subcommand: ['habit', 'set-day'], write: true },
  'packing-list': { subcommand: ['packing', 'list'], write: false },
  'packing-create-template': { subcommand: ['packing', 'create-template'], write: true },
  'packing-create-instance': { subcommand: ['packing', 'create-instance'], write: true },
  'packing-update-item': { subcommand: ['packing', 'update-item'], write: true },
};

const FLAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const MAX_POSITIONAL = 10;
const MAX_STRING_LEN = 4000;

export class BridgeRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeRequestBody {
  command?: string;
  positional?: unknown;
  flags?: unknown;
  stdin?: unknown;
}

/**
 * Validate a bridge request against the allowlist and turn it into an argv
 * array (+ optional stdin payload) for the clarity CLI. Throws
 * BridgeRequestError (never forwards a rejected command) — callers turn that
 * into the HTTP response.
 */
export function buildInvocation(body: BridgeRequestBody): { argv: string[]; stdin?: string } {
  const { command } = body;
  if (!command || typeof command !== 'string') {
    throw new BridgeRequestError(400, 'command is required');
  }
  const spec = ALLOWED_COMMANDS[command];
  if (!spec) {
    throw new BridgeRequestError(403, `command not allowed: "${command}"`);
  }

  const positional = body.positional ?? [];
  if (
    !Array.isArray(positional) ||
    positional.length > MAX_POSITIONAL ||
    !positional.every((p) => typeof p === 'string' && p.length <= MAX_STRING_LEN)
  ) {
    throw new BridgeRequestError(
      400,
      `positional must be an array of at most ${MAX_POSITIONAL} strings, each ≤${MAX_STRING_LEN} chars`,
    );
  }

  const flags = { ...(isPlainObject(body.flags) ? body.flags : {}) } as Record<string, unknown>;

  if (spec.destructive) {
    if (flags.confirm !== true) {
      throw new BridgeRequestError(400, `"${command}" is destructive — pass flags: { confirm: true } to proceed`);
    }
    delete flags.confirm;
  }

  for (const [key, value] of Object.entries(flags)) {
    if (!FLAG_NAME_RE.test(key)) {
      throw new BridgeRequestError(400, `invalid flag name: "${key}"`);
    }
    if (typeof value === 'string' && value.length > MAX_STRING_LEN) {
      throw new BridgeRequestError(400, `flag "${key}" exceeds ${MAX_STRING_LEN} chars`);
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new BridgeRequestError(400, `flag "${key}" must be a string, number, or boolean`);
    }
  }

  let stdin: string | undefined;
  if (body.stdin !== undefined) {
    if (!spec.allowsStdin) {
      throw new BridgeRequestError(400, `"${command}" does not accept a stdin payload`);
    }
    if (typeof body.stdin !== 'string') {
      throw new BridgeRequestError(400, 'stdin must be a string (JSON payload)');
    }
    stdin = body.stdin;
  }

  const argv = [...spec.subcommand, ...(positional as string[])];
  for (const [key, value] of Object.entries(flags)) {
    if (value === true) argv.push(`--${key}`);
    else if (value === false) continue;
    else argv.push(`--${key}`, String(value));
  }

  return { argv, stdin };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
