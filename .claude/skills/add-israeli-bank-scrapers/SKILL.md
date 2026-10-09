---
name: add-israeli-bank-scrapers
description: Give an agent group the ability to pull recent transactions from Israeli bank/credit-card accounts (Bank Hapoalim, Bank Yahav, Cal, Max, Isracard, and others supported by israeli-bank-scrapers) through a host-side bridge that holds the login credentials — the agent never sees them, only account ids and the resulting transactions. Use when the user wants an agent to read bank/credit-card transactions, reconcile spending against another record, or otherwise needs "this month's" account activity without handling credentials itself.
---

# Add Israeli Bank Scrapers

`bank-sync` is a host-side HTTP service (its own launchd/systemd unit, independent of the main NanoClaw process) that holds bank/credit-card login credentials and drives [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers) to fetch this-and-last-month's transactions. The credentials live in Bitwarden Secrets Manager and are fetched per scrape using a machine-account token kept in the macOS Keychain; `data/bank-sync-credentials.json` (git-ignored) holds only account ids/company types. No agent container mounts that file, and no route this service exposes ever echoes a credential value back — only account ids/company names and scraped transactions (date, amount, currency, description).

**No OTP/2FA handling.** As of `israeli-bank-scrapers@6.10.0`, the library's `otpCodeRetriever`/`getLongTermTwoFactorToken` hooks exist only for the `oneZero` scraper — none of hapoalim/yahav/max/visaCal/isracard's credential types carry an OTP field, and there's no way to relay a live code through for them. If a real login hits a 2FA/device-verification wall on the bank's site, that account's scrape just comes back with `status: "error"` — there's nothing to resume. Each account gets its own persistent Chromium profile dir (`data/bank-sync-profiles/<accountId>/`) as a best-effort way to reduce the odds of hitting such a wall (a returning browser profile is sometimes recognized by the bank's own site), but this isn't guaranteed.

## Phase 1: Pre-flight

```bash
test -f src/bank-sync/server.ts && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 5 to wire a new agent group.

## Phase 2: Copy the bridge

```bash
mkdir -p src/bank-sync
cp .claude/skills/add-israeli-bank-scrapers/bridge/*.ts src/bank-sync/
cp .claude/skills/add-israeli-bank-scrapers/mcp/bank-sync-mcp-stdio.ts container/agent-runner/src/bank-sync-mcp-stdio.ts
cp .claude/skills/add-israeli-bank-scrapers/mcp/bank-sync-client.ts container/agent-runner/src/bank-sync-client.ts
cp .claude/skills/add-israeli-bank-scrapers/setup-bank-sync-service.ts scripts/setup-bank-sync-service.ts
mkdir -p data
```

Add the pinned host-side dependency (skip if already present — check `package.json`):

```bash
pnpm add israeli-bank-scrapers@6.10.0
```

This pulls in `puppeteer` as a transitive dependency, whose own postinstall script downloads a pinned Chromium — pnpm's `onlyBuiltDependencies` policy blocks that build script by default (`Ignored build scripts: puppeteer@...`). **This is a deliberate stop, not a bug** — approving a build script lets it run arbitrary code during install, which this repo's supply-chain policy requires a human decision for. Ask the operator to choose one:

- Run `pnpm approve-builds` themselves and pick `puppeteer` — Chromium downloads automatically on the next install.
- Or set `BANK_SYNC_CHROME_PATH` in `.env` to an existing system Chrome/Chromium binary (e.g. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS) — `scraper-runner.ts` passes it as `executablePath` and no Chromium download is needed at all.

Do not run `pnpm approve-builds` on the operator's behalf.

Run the tests and confirm both trees typecheck:

```bash
pnpm exec vitest run src/bank-sync/credentials.test.ts src/bank-sync/jobs.test.ts src/bank-sync/scraper-runner.test.ts
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

`bank-sync-mcp-stdio.ts`/`bank-sync-client.ts` have no in-tree test — thin stdio forwarders with no functional logic of their own to guard (the real logic, and its tests, live on the `server.ts`/`scraper-runner.ts` side). Verify them directly with a real MCP handshake instead:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | BANK_SYNC_TOKEN=test bun run container/agent-runner/src/bank-sync-mcp-stdio.ts \
  | grep -o '"name":"[a-z_]*"'
```

Expect `bank_sync_accounts`, `bank_sync_start`, `bank_sync_status` (plus any local extension's, if one is installed).

## Phase 3: Configure accounts

Logins live in **Bitwarden Secrets Manager**, not on disk. The service fetches them at scrape time and holds them in memory only.

1. Install the `bws` CLI (no Homebrew formula; download from the `bitwarden/sdk-sm` GitHub releases, verify the SHA-256, put it at `~/.local/bin/bws` or set `BANK_SYNC_BWS_PATH`).
2. In Bitwarden: create a project (e.g. `bank-sync`), one secret per account — **key = the account id below, value = the credentials as a JSON object** — and a machine account with read access to that project only. Enter values in the web UI, never in chat.
3. Store the machine-account access token in the Keychain (prompts for the value): `security add-generic-password -s bank-sync-bws -a bank-sync -w`
4. Create `data/bank-sync-credentials.json` (git-ignored) listing only ids and company types:

```json
{
  "accounts": [
    { "id": "yahav-1", "companyId": "yahav" },
    { "id": "hapoalim-1", "companyId": "hapoalim" },
    { "id": "cal-1", "companyId": "visaCal" },
    { "id": "max-1", "companyId": "max" },
    { "id": "isracard-1", "companyId": "isracard" }
  ]
}
```

Secret value shapes: yahav `{"username","password","nationalID"}`, hapoalim `{"userCode","password"}`, visaCal/max `{"username","password"}`, isracard `{"id","card6Digits","password"}`. (An inline `credentials` object on an account entry still works and takes precedence, but defeats the purpose.)

Only include the accounts the operator actually has. Supported `companyId` values used by this walkthrough: `yahav`, `hapoalim`, `visaCal` (Cal), `max`, `isracard` (see `israeli-bank-scrapers`'s `CompanyTypes` export for the full list it supports beyond these).

## Phase 4: Install the service

```bash
pnpm exec tsx scripts/setup-bank-sync-service.ts
```

Generates `BANK_SYNC_TOKEN` in `.env` if missing, and sets up the launchd (macOS) or systemd (Linux) unit. Note the printed token for the next step.

## Phase 5: Wire the MCP tool to the target agent group

```bash
ncl groups config add-mcp-server --id <group-id> --name bank-sync \
  --command bun --args '["run","/app/src/bank-sync-mcp-stdio.ts"]' \
  --env '{"BANK_SYNC_URL":"http://host.docker.internal:8801","BANK_SYNC_TOKEN":"<token-from-phase-4>"}'
ncl groups restart --id <group-id>
```

## Verify

```bash
curl -s http://127.0.0.1:8801/accounts -H "Authorization: Bearer <token>"
```

Ask the agent to list its configured bank-sync accounts (`bank_sync_accounts`), then start a scrape (`bank_sync_start`) and poll `bank_sync_status` until every account is `done` or `error`. A first real run against live credentials is the only way to find out whether a given account hits a 2FA/device-verification wall this library can't get past — that's expected to be discovered here, not before.

## Troubleshooting

### `Failed to reach bank-sync at http://host.docker.internal:8801`

```bash
launchctl list | grep bank-sync   # macOS
systemctl --user status '*bank-sync*'   # Linux
tail -20 logs/bank-sync.error.log
```

### An account's status stays `error` with a message like `TIMEOUT` or a generic failure

Most likely a real 2FA/device-verification challenge this library can't complete programmatically for that company (see this file's intro). Try clearing `data/bank-sync-profiles/<accountId>/` and re-running once with `BANK_SYNC_CHROME_PATH` unset and `showBrowser` temporarily flipped to `true` in `scraper-runner.ts` to watch what the site is actually asking for — revert the `showBrowser` change afterward.

### `Ignored build scripts: puppeteer@...` and Chromium is missing at scrape time

See Phase 2 — either `pnpm approve-builds` (operator's own call) or set `BANK_SYNC_CHROME_PATH`.
