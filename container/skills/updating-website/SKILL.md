---
name: updating-website
description: Update and publish Idan's personal website (personal-website-docusaurus). Use when asked to update, rebuild, publish, or deploy the personal website, or to sync its content.
---

# Updating the personal website

Idan's `personal-website-docusaurus` repo is mounted read-write at `/workspace/extra/personal-website-docusaurus` — the live repo on his Mac, not a copy. This skill only applies to agent groups with that mount. If the path doesn't exist, this skill isn't usable here — say so rather than guessing at a different location.

## Steps

1. `cd /workspace/extra/personal-website-docusaurus`
2. `npm run update-website`
3. `npm run build`
4. If the build succeeds and there are changes to commit, stage and commit them.
5. Push the commit.

## Git identity

This repo's `.git/config` is shared with Idan's own host checkout of the same repo — **never** run `git config` (local or global) to set `user.name`/`user.email` here, since that would silently change the identity on *his* commits too, not just yours. Always pass identity per-command with `-c`, which applies only to that one invocation and touches no config file:

```
git -c user.name=Elric -c user.email=elric@nanoclaw.local commit -m "..."
```

## Pushing

Push authenticates through the OneCLI gateway, which rewrites the `Authorization` header on outbound requests to `github.com` — but it only *rewrites* an existing header, it doesn't add one from scratch. So every push must send a placeholder `Authorization` header for the gateway to overwrite with the real credential:

```
git -c http.extraHeader="Authorization: Basic cGxhY2Vob2xkZXI=" push
```

Use `-c`, not `git config`, for the same shared-`.git/config` reason as the identity flags above — never persist this header to config.

If `git push` still fails with an auth error, the repo-scoped GitHub credential isn't set up or is misconfigured — tell Idan rather than retrying or working around it.
