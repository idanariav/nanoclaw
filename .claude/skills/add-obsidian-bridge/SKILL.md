---
name: add-obsidian-bridge
description: Bridge a live Obsidian.app vault (macOS) to an agent's obsidian_run MCP tool, via a host-side service that forwards a fail-closed allowlist of obsidian-cli commands. Use when the user wants an agent to drive their actual running Obsidian app — reading/writing notes, properties, tags, links, Bases queries, Templater — beyond what a plain filesystem mount of the vault can do (backlinks/aliases as Obsidian itself resolves them, opening a note in the UI, file history).
---

# Add Obsidian Bridge

`obsidian-cli` (Obsidian.app's own CLI) is a macOS Mach-O binary that talks to the *running* Obsidian app over a local Unix socket — it cannot run inside a Linux container, and a second, disconnected Obsidian instance in the container can't substitute for it (it wouldn't be the vault the user is looking at, and Obsidian's own internal state — `.obsidian/` — isn't safe to share between two concurrently-running instances).

This skill adds a small host-side HTTP service (its own launchd unit, independent of the main NanoClaw process) that runs *next to* the real Obsidian.app, validates every request against a fail-closed command + path allowlist, and forwards approved ones to the real `obsidian-cli`. The agent reaches it through a thin stdio MCP tool (`obsidian_run`).

**This is complementary to, not a replacement for, mounting the vault's folders directly into the container** (via `ncl groups config add-mount`). Plain file reads/writes/search should go through the mount + whatever indexing tools you use — this bridge is for the narrow slice that only the live app can do: Bases queries and Templater execution as the running app evaluates them, alias/backlink resolution as Obsidian's own metadata cache has it, file history, opening a note in the UI.

## Phase 1: Pre-flight

macOS only, and requires Obsidian.app with the CLI feature:

```bash
[ "$(uname)" = "Darwin" ] && echo OK || echo "NOT_MACOS — this skill cannot run"
test -f /Applications/Obsidian.app/Contents/MacOS/obsidian-cli && echo OK || echo "obsidian-cli not found — is Obsidian.app installed?"
```

Check if already applied:

```bash
test -f src/obsidian-bridge/server.ts && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 4 to wire a new agent group, or Phase 5 if only reconfiguring.

## Phase 2: Ask what's in bounds

Two things only the user can answer:

1. **Which top-level vault folders** should the bridge be allowed to touch? (e.g. `Scaffolding,Sources,Content`). These should match whatever folders are already mounted read/write into the target agent group's container — the bridge's allowlist and the container's filesystem mounts should agree on the same boundary, or the agent can see a folder it can't ask the bridge about (or vice versa).
2. **Which agent group** gets the `obsidian_run` tool?

## Phase 3: Copy the bridge

```bash
mkdir -p src/obsidian-bridge
cp .claude/skills/add-obsidian-bridge/bridge/server.ts src/obsidian-bridge/server.ts
cp .claude/skills/add-obsidian-bridge/bridge/allowlist.ts src/obsidian-bridge/allowlist.ts
cp .claude/skills/add-obsidian-bridge/bridge/allowlist.test.ts src/obsidian-bridge/allowlist.test.ts
cp .claude/skills/add-obsidian-bridge/mcp/obsidian-mcp-stdio.ts container/agent-runner/src/obsidian-mcp-stdio.ts
cp .claude/skills/add-obsidian-bridge/setup-obsidian-bridge-service.ts scripts/setup-obsidian-bridge-service.ts
```

Run the dependency/behavior guard — it exercises the allowlist's actual command and path logic, not just file existence:

```bash
pnpm exec vitest run src/obsidian-bridge/allowlist.test.ts
pnpm run build
```

## Phase 4: Configure and install the service

Add the vault's allowed roots to `.env` (from Phase 2) — this is a config file with secrets in it, so do it directly rather than through a generic file-edit path if your environment restricts that:

```bash
grep -q '^OBSIDIAN_VAULT_ROOTS=' .env || echo 'OBSIDIAN_VAULT_ROOTS=Scaffolding,Sources,Content' >> .env
```

Then run the setup script — it generates `OBSIDIAN_BRIDGE_TOKEN` if missing, verifies `OBSIDIAN_VAULT_ROOTS` is set (refuses to continue otherwise — an unconfigured allowlist must fail closed, not silently allow everything), and installs the launchd service:

```bash
pnpm exec tsx scripts/setup-obsidian-bridge-service.ts
```

Note the printed `OBSIDIAN_BRIDGE_TOKEN` value for the next step.

## Phase 5: Wire the MCP tool to the target agent group

```bash
ncl groups config add-mcp-server --id <group-id> --name obsidian \
  --command bun --args '["run","/app/src/obsidian-mcp-stdio.ts"]' \
  --env '{"OBSIDIAN_BRIDGE_URL":"http://host.docker.internal:8800","OBSIDIAN_BRIDGE_TOKEN":"<token-from-phase-4>"}'
ncl groups restart --id <group-id>
```

If the bridge runs on a non-default port (`OBSIDIAN_BRIDGE_PORT` in `.env`), match it in `OBSIDIAN_BRIDGE_URL`.

## Phase 6: Tell the agent how to use it

Add a short section to the target group's `instructions.prepend.md` (or its equivalent per-group instructions file) covering: what `obsidian_run` is for versus the plain filesystem mounts, the exact allowed root folders, and that `file=<name>` fuzzy lookup is refused (always use `path=` with an explicit vault-relative path). See `container/agent-runner/src/obsidian-mcp-stdio.ts`'s tool description for the concrete command list — it's generated from the same allowlist the bridge enforces, so it can't drift from what actually works.

## Verify

```bash
docker exec "$(docker ps --filter "name=<group-id>" --format '{{.Names}}' | head -1)" \
  sh -c 'echo "{}" | bun run /app/src/obsidian-mcp-stdio.ts' &
sleep 1; kill %1 2>/dev/null   # just confirms the MCP process starts without crashing
```

Then ask the agent to run `obsidian_run` with `command: "vault"` (no path needed) and confirm it gets a real response, not a connection error.

## Troubleshooting

### `Failed to reach obsidian-bridge at http://host.docker.internal:8800`

The launchd service isn't running, or `host.docker.internal` isn't resolving from inside the container (Linux Docker needs `--add-host=host.docker.internal:host-gateway`, which the host's container spawn logic already adds for every session — check `container-runner.ts`'s host-gateway args if this fails on Linux).

```bash
launchctl list | grep obsidian-bridge
tail -20 logs/obsidian-bridge.error.log
```

### `command not allowed` / `path outside allowed scope`

Working as intended — the allowlist is fail-closed. If a command that should be reachable is being rejected, it's either missing from `ALLOWED_COMMANDS` in `allowlist.ts` (check obsidian-cli's own `--help` for the exact command name) or the path isn't under one of the configured `OBSIDIAN_VAULT_ROOTS`.
