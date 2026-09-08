# Remove Gmail Sanitizer

Every step is idempotent — safe to re-run. **Do not remove this if a `local-`-prefixed report extension skill is still installed** — it depends on `src/gmail-sanitizer/report-source.ts` and `container/agent-runner/src/gmail-sanitizer-client.ts`. Remove the local extension first.

## 1. Unwire the MCP tool from every agent group it was added to

```bash
ncl groups config remove-mcp-server --id <group-id> --name gmail
ncl groups restart --id <group-id>
```

## 2. Unload and delete the launchd/systemd service

```bash
label="$(pnpm exec tsx -e "import('./src/install-slug.js').then(m => console.log(m.getLaunchdLabel(process.cwd()) + '-gmail-sanitizer'))" 2>/dev/null)"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null \
  || launchctl unload "$HOME/Library/LaunchAgents/$label.plist" 2>/dev/null \
  || true
rm -f "$HOME/Library/LaunchAgents/$label.plist"

unit="$(pnpm exec tsx -e "import('./src/install-slug.js').then(m => console.log(m.getSystemdUnit(process.cwd()) + '-gmail-sanitizer'))" 2>/dev/null)"
systemctl --user disable --now "$unit" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$unit.service"

rm -f dist/gmail-sanitizer/server.js logs/gmail-sanitizer.log logs/gmail-sanitizer.error.log
```

## 3. Remove the OneCLI identity and rules

```bash
onecli agents delete --identifier gmail-sanitizer
# Remove the block rules created in Phase 3 of SKILL.md for gmail.googleapis.com / www.googleapis.com, if no longer needed.
```

## 4. Remove the copied files

```bash
rm -rf src/gmail-sanitizer
rm -f container/agent-runner/src/gmail-mcp-stdio.ts
rm -f container/agent-runner/src/gmail-sanitizer-client.ts
rm -f scripts/setup-gmail-sanitizer-service.ts
rm -f data/gmail-excel-reports.json data/gmail-anonymization-store.json
```

## 5. Remove the `.env` entries

Delete `GMAIL_SANITIZER_TOKEN` and `GMAIL_SANITIZER_PORT` (if set) from `.env`.

## 6. Rebuild

```bash
pnpm run build
```
