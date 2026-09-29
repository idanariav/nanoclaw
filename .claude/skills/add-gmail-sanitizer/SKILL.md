---
name: add-gmail-sanitizer
description: Give an agent Gmail/Drive access through a host-side bridge that anonymizes PII (phone numbers, bank accounts, national ID numbers) before it ever reaches the agent's context, plus a config-driven Excel template reader/editor for report attachments and a presence-only Google Contacts lookup. Use when the user wants an agent to search/read Gmail, save attachments or draft replies, read and edit spreadsheet reports from email, or check whether a contact exists without exposing sensitive personal data to the agent.
---

# Add Gmail Sanitizer

`gmail-sanitizer` is a host-side HTTP service (its own launchd/systemd unit, independent of the main NanoClaw process) that holds the real Gmail/Drive/Contacts OAuth credential and does three things before anything reaches an agent container:

1. **Deterministic PII anonymization** — phone numbers, IBANs/bank identifiers, Luhn-valid credit card numbers, and (Israeli) national ID numbers are replaced with numbered tokens (`[PHONE_1]`, `[BANK_ACCOUNT_2]`, ...). The same real value always gets the same token; a token can be copied back into a reply/draft and is resolved to the real value server-side, so the agent never holds the actual value, only a stable stand-in for it.
2. **Config-driven Excel report reading/editing** — a spreadsheet attachment is matched against templates in `data/gmail-excel-reports.json` (sheet name + header row, per template); an unrecognized file is refused rather than partially exposed. Sensitive columns (named per-template, not detected from content) get the same cell-level tokenization.
3. **Presence-only Google Contacts lookup** — `people-client.ts` searches Contacts by name and reduces the result to `{exists, has_email, has_phone}` before it ever leaves the function; no name, email address, or phone number value is assembled into a response anywhere. Exposed as its own opt-in `contacts_lookup` MCP tool (`contacts-mcp-stdio.ts`), wired separately from the `gmail_*` tools so it can be granted to a group independently of Gmail/Drive access.

By default the agent can only ever reach Drive files it created itself (or was handed the exact id of) — that's what the `drive.file` OAuth scope guarantees, and it's the right default. If the agent needs to browse and manage files someone else put in a specific Drive folder (existing reports, manual uploads, new versions of a file it didn't create), see the **optional folder-scoped Drive access** note in Phase 3 — it trades a broader OAuth grant for an app-enforced boundary around one folder, rather than leaving the agent with either "sees nothing it didn't create" or "sees your entire Drive."

The anonymizer's actual detection patterns are Israeli/Hebrew-specific (phone formats, Teudat Zehut checksum, "בנק"/"סניף"/"חשבון" labels) — this is real locale-specific detection logic, not a stray hardcoded value. If your locale needs different patterns, edit `anonymize.ts`'s regexes directly; that file is the one genuinely non-generic piece of this otherwise install-agnostic skill.

**Extension point for a bespoke report:** a report with real structure beyond "named columns" (cross-sheet relationships, structural edits, macro-equivalent logic) doesn't fit the generic Excel template engine. Rather than that logic getting hardcoded into this skill, `server.ts` and `gmail-mcp-stdio.ts` each look for an optional local module (`./local-report-extension.js` and `./local-monthly-report-mcp.js` respectively) and wire in whatever routes/tools it exports — see each file's module comment. Neither generic file has to change, or know anything about what such an extension does. See `/learn` or a `local-`-prefixed skill for how to build one for your own report.

## Phase 1: Pre-flight

Check if already applied:

```bash
test -f src/gmail-sanitizer/server.ts && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 4 to wire a new agent group.

Confirm OneCLI is set up (this skill uses it for the Gmail/Drive OAuth identity — see `identity.ts`):

```bash
onecli version 2>/dev/null && echo ONECLI_OK || echo "ONECLI_MISSING — run /init-onecli first"
```

## Phase 2: Copy the bridge

```bash
mkdir -p src/gmail-sanitizer
cp .claude/skills/add-gmail-sanitizer/bridge/*.ts src/gmail-sanitizer/
cp .claude/skills/add-gmail-sanitizer/mcp/gmail-mcp-stdio.ts container/agent-runner/src/gmail-mcp-stdio.ts
cp .claude/skills/add-gmail-sanitizer/mcp/contacts-mcp-stdio.ts container/agent-runner/src/contacts-mcp-stdio.ts
cp .claude/skills/add-gmail-sanitizer/mcp/gmail-sanitizer-client.ts container/agent-runner/src/gmail-sanitizer-client.ts
cp .claude/skills/add-gmail-sanitizer/setup-gmail-sanitizer-service.ts scripts/setup-gmail-sanitizer-service.ts
```

Run the tests that ship with it, and confirm both trees typecheck:

```bash
pnpm exec vitest run src/gmail-sanitizer/anonymize.test.ts src/gmail-sanitizer/excel-reports.test.ts src/gmail-sanitizer/people-client.test.ts
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

`gmail-mcp-stdio.ts` has no in-tree test — it's a thin stdio forwarder with no functional logic of its own to guard (the real logic, and its tests, live on the server.ts side). Verify it directly with a real MCP handshake instead:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | GMAIL_SANITIZER_TOKEN=test bun run container/agent-runner/src/gmail-mcp-stdio.ts \
  | grep -o '"name":"[a-z_]*"'
```

Expect the 9 generic `gmail_*` tool names (plus any local extension's, if one is installed). `contacts-mcp-stdio.ts` is verified the same way, substituting itself for the gmail one; expect just `contacts_lookup`.

## Phase 3: Set up Gmail/Drive/Contacts OAuth and install the service

The Gmail/Drive/Contacts credential lives in OneCLI, under a dedicated identity (`gmail-sanitizer`, see `identity.ts`) kept separate from any agent's own container identity — so it must be explicitly blocked from every NanoClaw container via a OneCLI rule, or every agent could reach it directly:

```bash
onecli agents create --name "Gmail Sanitizer" --identifier gmail-sanitizer
# Connect Gmail + Drive OAuth to this agent identity via the OneCLI web UI (http://127.0.0.1:10254)
# If contacts_lookup is wanted, also connect a Google People API / Contacts
# scope (contacts.readonly) to the SAME identity there.
onecli rules create --action block --agent-id <every-other-agent-id> --host-pattern gmail.googleapis.com
onecli rules create --action block --agent-id <every-other-agent-id> --host-pattern www.googleapis.com
onecli rules create --action block --agent-id <every-other-agent-id> --host-pattern people.googleapis.com
```

Then install the service — generates `GMAIL_SANITIZER_TOKEN` in `.env` if missing, and sets up the launchd (macOS) or systemd (Linux) unit:

```bash
pnpm exec tsx scripts/setup-gmail-sanitizer-service.ts
```

Note the printed `GMAIL_SANITIZER_TOKEN` for the next step.

**Optional: folder-scoped Drive access.** `drive.file` alone can never see a file the agent didn't create — there's no way to grant "browse just this folder" as an OAuth scope, Google's `drive.file` grant is per-file/per-picker-selection only. To let the agent list and manage everything in one existing Drive folder (including files it didn't create), do both of these together — either alone is unsafe:

1. In the OneCLI web UI, connect the full `drive` scope (`https://www.googleapis.com/auth/drive`) to the `gmail-sanitizer` identity instead of (or in addition to) `drive.file` — for read-only browsing without letting the agent overwrite files it didn't create, `drive.readonly` is enough instead.
2. Set `GMAIL_SANITIZER_DRIVE_FOLDER_ID` in `.env` to that folder's id (the segment after `/folders/` in its share link). Once set, `drive-client.ts` enforces it as an app-level boundary independent of the OAuth grant: every operation on a caller-supplied `driveFileId` (read, download, overwrite) is checked to be a direct child of this folder and rejected (403) otherwise, and new uploads go there instead of the auto-created "Nanoclaw" folder. This is what actually keeps the agent inside that one folder even though the OAuth grant itself covers your whole Drive.

Skip both if the agent only ever needs to save/reopen files it created itself (the common case) — the default `drive.file` scope already covers that with no extra config.

## Phase 4: Wire the MCP tool(s) to the target agent group

Wire `gmail`, `contacts`, or both — they're independent, so a group can have either without the other:

```bash
ncl groups config add-mcp-server --id <group-id> --name gmail \
  --command bun --args '["run","/app/src/gmail-mcp-stdio.ts"]' \
  --env '{"GMAIL_SANITIZER_URL":"http://host.docker.internal:8799","GMAIL_SANITIZER_TOKEN":"<token-from-phase-3>"}'
ncl groups config add-mcp-server --id <group-id> --name contacts \
  --command bun --args '["run","/app/src/contacts-mcp-stdio.ts"]' \
  --env '{"GMAIL_SANITIZER_URL":"http://host.docker.internal:8799","GMAIL_SANITIZER_TOKEN":"<token-from-phase-3>"}'
ncl groups restart --id <group-id>
```

## Phase 5: Configure report templates (optional)

If the agent needs to read/edit an Excel attachment, add a template to `data/gmail-excel-reports.json` (create it if missing — an empty/missing config means every report is "unrecognized"):

```json
{
  "reports": [
    {
      "id": "example-report",
      "sheets": [
        {
          "sheetName": "Sheet1",
          "headerRow": 1,
          "expectedHeaders": ["Name", "Amount", "Account Number"],
          "sensitiveColumns": ["Account Number"],
          "keyColumn": "Name"
        }
      ]
    }
  ]
}
```

No restart needed — `excel-reports.ts` reads this file fresh on every request.

## Verify

```bash
curl -s http://127.0.0.1:8799/emails?q=is:unread -H "Authorization: Bearer <token>" | head -c 200
curl -s "http://127.0.0.1:8799/contacts/lookup?name=Some+Contact" -H "Authorization: Bearer <token>"
```

Ask the agent to search Gmail and confirm subjects/snippets come back with `[PHONE_n]`/`[BANK_ACCOUNT_n]`-style tokens where PII would otherwise appear. Ask it to look up a contact you know exists and confirm the reply is booleans only (`{"exists":true,"has_email":true,"has_phone":false}`-shaped), never an email address or phone number.

## Troubleshooting

### `Failed to reach gmail-sanitizer at http://host.docker.internal:8799`

```bash
launchctl list | grep gmail-sanitizer   # macOS
systemctl --user status '*gmail-sanitizer*'   # Linux
tail -20 logs/gmail-sanitizer.error.log
```

### `This spreadsheet does not match any configured report template`

Working as intended — nothing about an unrecognized file's data is exposed. The error response includes the sheets/headers it actually found; add a matching template to `data/gmail-excel-reports.json` (Phase 5).

### `Drive file <id> is outside the scoped folder` (403)

Expected behavior, not a bug — `GMAIL_SANITIZER_DRIVE_FOLDER_ID` is set and the agent (or a call from `gmail_create_draft`'s `attachments`, `gmail_read_excel_attachment`'s `driveFileId`, etc.) referenced a file outside that folder. Move the file into the scoped folder, or drop `GMAIL_SANITIZER_DRIVE_FOLDER_ID` from `.env` if unscoped access was actually intended.

### `contacts_lookup` always returns `exists: false` for a contact you know is there

- Confirm the People API / Contacts scope was actually connected to the `gmail-sanitizer` identity in the OneCLI web UI (Phase 3) — a missing connection surfaces as a 401/403 from the bridge, not a clean `false`.
- The People API's search index is built asynchronously from the account's contacts and can lag behind a very recent add/edit.
- The match is exact (case-insensitive) against the contact's display name — a spelling difference (nickname, missing middle name, reordered name) won't match. This is deliberate: fuzzy matching here would risk a false "exists: true" for a different person.
