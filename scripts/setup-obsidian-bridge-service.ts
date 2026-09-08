/**
 * scripts/setup-obsidian-bridge-service.ts — install and start the
 * obsidian-bridge service as its own service unit, independent of the main
 * NanoClaw service. Mirrors setup-gmail-sanitizer-service.ts's shape.
 *
 * Usage: pnpm exec tsx scripts/setup-obsidian-bridge-service.ts
 *
 * macOS only — obsidian-cli is a macOS Mach-O binary that talks to the
 * running Obsidian.app over a local Unix socket; there is nothing to bridge
 * to on any other platform.
 *
 * Generates OBSIDIAN_BRIDGE_TOKEN into .env if not already present (the
 * shared secret the agent's container uses to authenticate to this service).
 */
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getLaunchdLabel } from '../src/install-slug.js';

const projectRoot = process.cwd();
const homeDir = os.homedir();
const platform = os.platform();

const OBSIDIAN_CLI_BIN = '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli';

function ensureToken(): void {
  const envPath = path.join(projectRoot, '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  if (/^OBSIDIAN_BRIDGE_TOKEN=/m.test(content)) {
    console.log('OBSIDIAN_BRIDGE_TOKEN already set in .env — leaving it as-is.');
    return;
  }
  const token = randomBytes(24).toString('hex');
  const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
  fs.appendFileSync(envPath, `${suffix}OBSIDIAN_BRIDGE_TOKEN=${token}\n`);
  console.log('Generated OBSIDIAN_BRIDGE_TOKEN and appended it to .env.');
  console.log('Use this same value in the --env for `ncl groups config add-mcp-server` (OBSIDIAN_BRIDGE_TOKEN):');
  console.log(`  ${token}`);
}

/**
 * Which top-level vault folders obsidian-cli requests may target — every
 * vault names its own, so this has no sane hardcoded default. The bridge
 * refuses to start without it (see server.ts): an unconfigured allowlist
 * must fail closed, not silently allow everything.
 */
function ensureVaultRoots(): void {
  const envPath = path.join(projectRoot, '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  if (/^OBSIDIAN_VAULT_ROOTS=/m.test(content)) {
    console.log('OBSIDIAN_VAULT_ROOTS already set in .env — leaving it as-is.');
    return;
  }
  console.error(
    'OBSIDIAN_VAULT_ROOTS is not set in .env. Add a comma-separated list of the ' +
      "vault's top-level folders the bridge may operate on, e.g.:\n\n" +
      '  OBSIDIAN_VAULT_ROOTS=Scaffolding,Sources,Content\n\n' +
      'These should match the folders actually mounted into the target agent group\'s ' +
      'container (see its vault-* mounts). Add the line and re-run this script.',
  );
  process.exit(1);
}

function nodePath(): string {
  return execSync('which node', { encoding: 'utf-8' }).trim();
}

function setupLaunchd(): void {
  const label = `${getLaunchdLabel(projectRoot)}-obsidian-bridge`;
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath()}</string>
        <string>${projectRoot}/dist/obsidian-bridge/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/obsidian-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/obsidian-bridge.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  console.log(`Wrote launchd plist: ${plistPath}`);

  try {
    execSync(`launchctl unload ${JSON.stringify(plistPath)}`, { stdio: 'ignore' });
  } catch {
    /* not previously loaded — fine */
  }
  execSync(`launchctl load ${JSON.stringify(plistPath)}`, { stdio: 'inherit' });
  execSync(`launchctl kickstart -k gui/${process.getuid!()}/${label}`, { stdio: 'inherit' });

  console.log(`obsidian-bridge service loaded as ${label}.`);
  console.log(`Logs: ${projectRoot}/logs/obsidian-bridge.log`);
}

if (platform !== 'darwin') {
  console.error(`obsidian-bridge is macOS-only (obsidian-cli talks to Obsidian.app on this Mac). Platform: ${platform}.`);
  process.exit(1);
}

if (!fs.existsSync(OBSIDIAN_CLI_BIN)) {
  console.error(`obsidian-cli not found at ${OBSIDIAN_CLI_BIN} — is Obsidian.app installed?`);
  process.exit(1);
}

fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
ensureToken();
ensureVaultRoots();
setupLaunchd();
