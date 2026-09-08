/**
 * obsidian-cli command allowlist for the obsidian-bridge service.
 *
 * obsidian-cli drives the whole live Obsidian app — it has no concept of the
 * folder-level wall the rest of the agent's access is built on (the vault-*
 * host mounts). This module is that wall for obsidian-cli: every command not
 * listed here is refused outright (fail-closed), and every command that can
 * target a specific file/folder must do so with an explicit `path=`/`folder=`
 * under one of the configured allowed roots — `file=<name>` (fuzzy,
 * vault-wide name lookup) is never forwarded, because it could resolve to a
 * same-named note outside the wall. Commands whose output isn't scopable to a
 * path at all (vault-wide listings with no folder filter: `unresolved`,
 * `orphans`, `deadends`, `recents`, `tabs`, `workspace`, `bases`, `tag`,
 * `bookmarks`, `history:list`, `base:views`) are left out rather than risk a
 * filename leak.
 *
 * Also excluded entirely: anything that executes code or controls the app
 * rather than vault content — `eval`, `dev:*`, `devtools`, `command`,
 * `plugin:install`/`uninstall`/`enable`/`disable`/`reload`,
 * `theme:install`/`set`/`uninstall`, `restart`, `sync` (on/off),
 * `plugins:restrict`, `snippet:enable`/`disable`, `reload`.
 *
 * Which folders are in bounds is install-specific (every vault names its own
 * top-level folders), so it is configured at startup via `configureAllowedRoots`
 * (server.ts reads it from the OBSIDIAN_VAULT_ROOTS env var) rather than
 * hardcoded here.
 */

let allowedRoots: string[] | undefined;

/** Set once at startup. Throws if called with an empty list — an unconfigured allowlist must fail closed, not default-allow everything. */
export function configureAllowedRoots(roots: string[]): void {
  if (roots.length === 0) {
    throw new Error('obsidian-bridge: at least one allowed vault root is required');
  }
  allowedRoots = roots;
}

export function getAllowedRoots(): string[] {
  if (!allowedRoots) {
    throw new Error('obsidian-bridge: allowed vault roots not configured — call configureAllowedRoots first');
  }
  return allowedRoots;
}

export function isPathAllowed(raw: string): boolean {
  const p = raw.replace(/^\/+/, '');
  if (p.includes('..')) return false;
  return getAllowedRoots().some((root) => p === root || p.startsWith(`${root}/`));
}

export interface CommandSpec {
  /** Arg keys that must be vault-relative paths under ALLOWED_ROOTS when present. */
  pathFields: string[];
  /** Of pathFields, which must actually be present (non-empty) for the call to proceed. */
  required: string[];
}

/**
 * Every field name here is a LITERAL path for its command, per obsidian-cli's
 * own --help text (e.g. `bookmark`'s `file=<path>`, unlike most commands
 * where `file=<name>` is a fuzzy wikilink-style lookup). `file=` is rejected
 * for every command NOT listing it in pathFields.
 */
export const ALLOWED_COMMANDS: Record<string, CommandSpec> = {
  aliases: { pathFields: ['path'], required: ['path'] },
  append: { pathFields: ['path'], required: ['path'] },
  backlinks: { pathFields: ['path'], required: ['path'] },
  'base:create': { pathFields: ['path'], required: ['path'] },
  'base:query': { pathFields: ['path'], required: ['path'] },
  bookmark: { pathFields: ['file', 'folder'], required: [] },
  commands: { pathFields: [], required: [] },
  create: { pathFields: ['path'], required: ['path'] },
  delete: { pathFields: ['path'], required: ['path'] },
  diff: { pathFields: ['path'], required: ['path'] },
  file: { pathFields: ['path'], required: ['path'] },
  files: { pathFields: ['folder'], required: ['folder'] },
  folder: { pathFields: ['path'], required: ['path'] },
  folders: { pathFields: ['folder'], required: ['folder'] },
  help: { pathFields: [], required: [] },
  history: { pathFields: ['path'], required: ['path'] },
  'history:open': { pathFields: ['path'], required: ['path'] },
  'history:read': { pathFields: ['path'], required: ['path'] },
  'history:restore': { pathFields: ['path'], required: ['path'] },
  hotkey: { pathFields: [], required: [] },
  hotkeys: { pathFields: [], required: [] },
  links: { pathFields: ['path'], required: ['path'] },
  move: { pathFields: ['path', 'to'], required: ['path', 'to'] },
  open: { pathFields: ['path'], required: ['path'] },
  outline: { pathFields: ['path'], required: ['path'] },
  plugin: { pathFields: [], required: [] },
  plugins: { pathFields: [], required: [] },
  'plugins:enabled': { pathFields: [], required: [] },
  prepend: { pathFields: ['path'], required: ['path'] },
  properties: { pathFields: ['path'], required: ['path'] },
  'property:read': { pathFields: ['path'], required: ['path'] },
  'property:remove': { pathFields: ['path'], required: ['path'] },
  'property:set': { pathFields: ['path'], required: ['path'] },
  random: { pathFields: ['folder'], required: ['folder'] },
  'random:read': { pathFields: ['folder'], required: ['folder'] },
  read: { pathFields: ['path'], required: ['path'] },
  rename: { pathFields: ['path'], required: ['path'] },
  'sync:history': { pathFields: ['path'], required: ['path'] },
  'sync:open': { pathFields: ['path'], required: ['path'] },
  'sync:read': { pathFields: ['path'], required: ['path'] },
  'sync:restore': { pathFields: ['path'], required: ['path'] },
  'sync:status': { pathFields: [], required: [] },
  'tab:open': { pathFields: ['file'], required: ['file'] },
  snippets: { pathFields: [], required: [] },
  'snippets:enabled': { pathFields: [], required: [] },
  task: { pathFields: ['path'], required: ['path'] },
  tasks: { pathFields: ['path'], required: ['path'] },
  'templater:create-from-template': { pathFields: ['template', 'file'], required: ['template', 'file'] },
  tags: { pathFields: ['path'], required: ['path'] },
  theme: { pathFields: [], required: [] },
  themes: { pathFields: [], required: [] },
  vault: { pathFields: [], required: [] },
  vaults: { pathFields: [], required: [] },
  version: { pathFields: [], required: [] },
};

export class BridgeRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Validate a {command, args} request against the allowlist and turn it into
 * an argv array for obsidian-cli. Throws BridgeRequestError (never forwards
 * a rejected command) — callers turn that into the HTTP response.
 */
export function buildArgv(command: string, rawArgs: Record<string, unknown>): string[] {
  const spec = ALLOWED_COMMANDS[command];
  if (!spec) {
    throw new BridgeRequestError(403, `command not allowed: "${command}"`);
  }

  if ('vault' in rawArgs) {
    throw new BridgeRequestError(400, `'vault=' may not be overridden — the bridge always targets the default vault`);
  }

  if ('file' in rawArgs && !spec.pathFields.includes('file')) {
    throw new BridgeRequestError(
      400,
      `'file=' (fuzzy name lookup, can resolve outside the allowed folders) is not permitted for "${command}" — use 'path=' with an explicit vault-relative path instead`,
    );
  }

  for (const field of spec.required) {
    const v = rawArgs[field];
    if (v === undefined || v === '') {
      throw new BridgeRequestError(400, `'${field}=' is required for command "${command}"`);
    }
  }

  for (const field of spec.pathFields) {
    const v = rawArgs[field];
    if (typeof v === 'string' && v !== '' && !isPathAllowed(v)) {
      throw new BridgeRequestError(
        403,
        `path outside allowed scope: ${field}=${v} (must be under ${getAllowedRoots().join('/, ')}/)`,
      );
    }
  }

  const argv = [command];
  for (const [key, value] of Object.entries(rawArgs)) {
    if (value === true) argv.push(key);
    else if (value === false || value === undefined || value === null) continue;
    else argv.push(`${key}=${String(value)}`);
  }
  return argv;
}
