# Remove Obsidian Bridge

Every step is idempotent — safe to re-run. Repeat Phase-5-equivalent steps (MCP server removal) for every agent group this was wired to.

## 1. Unwire the MCP tool from every agent group it was added to

```bash
ncl groups config remove-mcp-server --id <group-id> --name obsidian
ncl groups restart --id <group-id>
```

## 2. Unload and delete the launchd service

```bash
label="$(pnpm exec tsx -e "import('./src/install-slug.js').then(m => console.log(m.getLaunchdLabel(process.cwd()) + '-obsidian-bridge'))" 2>/dev/null)"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null \
  || launchctl unload "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null \
  || true
rm -f "$HOME/Library/LaunchAgents/$label.plist" \
      dist/obsidian-bridge/server.js \
      logs/obsidian-bridge.log \
      logs/obsidian-bridge.error.log
```

## 3. Remove the copied files

```bash
rm -rf src/obsidian-bridge
rm -f container/agent-runner/src/obsidian-mcp-stdio.ts
rm -f scripts/setup-obsidian-bridge-service.ts
```

## 4. Remove the `.env` entries

Delete the `OBSIDIAN_BRIDGE_TOKEN`, `OBSIDIAN_BRIDGE_PORT` (if set), and `OBSIDIAN_VAULT_ROOTS` lines from `.env`. This file often needs to be edited directly rather than through a generic file-edit path — same reasoning as installing it.

## 5. Rebuild

```bash
pnpm run build
```
