# Remove Israeli Bank Scrapers

Every step is idempotent — safe to re-run. **Do not remove this if a `local-`-prefixed reconciliation extension skill is still installed** — it depends on `container/agent-runner/src/bank-sync-client.ts`. Remove the local extension first.

## 1. Unwire the MCP tool from every agent group it was added to

```bash
ncl groups config remove-mcp-server --id <group-id> --name bank-sync
ncl groups restart --id <group-id>
```

## 2. Unload and delete the launchd/systemd service

```bash
label="$(pnpm exec tsx -e "import('./src/install-slug.js').then(m => console.log(m.getLaunchdLabel(process.cwd()) + '-bank-sync'))" 2>/dev/null)"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null \
  || launchctl unload "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null \
  || true
rm -f "$HOME/Library/LaunchAgents/$label.plist"

unit="$(pnpm exec tsx -e "import('./src/install-slug.js').then(m => console.log(m.getSystemdUnit(process.cwd()) + '-bank-sync'))" 2>/dev/null)"
systemctl --user disable --now "$unit" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$unit.service"

rm -f dist/bank-sync/server.js logs/bank-sync.log logs/bank-sync.error.log
```

## 3. Remove the copied files and credentials

```bash
rm -rf src/bank-sync
rm -f container/agent-runner/src/bank-sync-mcp-stdio.ts
rm -f container/agent-runner/src/bank-sync-client.ts
rm -f scripts/setup-bank-sync-service.ts
rm -f data/bank-sync-credentials.json
rm -rf data/bank-sync-profiles
```

## 4. Remove the `.env` entries

Delete `BANK_SYNC_TOKEN`, `BANK_SYNC_PORT` (if set), and `BANK_SYNC_CHROME_PATH` (if set) from `.env`.

## 5. Remove the dependency

```bash
pnpm remove israeli-bank-scrapers
```

## 6. Rebuild

```bash
pnpm run build
```
