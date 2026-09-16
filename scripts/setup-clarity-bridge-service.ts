/**
 * scripts/setup-clarity-bridge-service.ts — install and start the
 * clarity-bridge service as its own service unit, independent of the main
 * NanoClaw service. Mirrors setup-obsidian-bridge-service.ts's shape.
 *
 * Usage: pnpm exec tsx scripts/setup-clarity-bridge-service.ts
 *
 * macOS only — the Clarity task-manager CLI's signed-in session lives in the
 * desktop app's own app-support directory on this Mac; there is nothing to
 * bridge to on any other machine.
 *
 * Generates CLARITY_BRIDGE_TOKEN into .env if not already present (the
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

const CLARITY_CLI_BIN = process.env.CLARITY_CLI_BIN || '/opt/homebrew/bin/clarity';

function ensureToken(): void {
  const envPath = path.join(projectRoot, '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  if (/^CLARITY_BRIDGE_TOKEN=/m.test(content)) {
    console.log('CLARITY_BRIDGE_TOKEN already set in .env — leaving it as-is.');
    return;
  }
  const token = randomBytes(24).toString('hex');
  const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
  fs.appendFileSync(envPath, `${suffix}CLARITY_BRIDGE_TOKEN=${token}\n`);
  console.log('Generated CLARITY_BRIDGE_TOKEN and appended it to .env.');
  console.log('Use this same value in the --env for `ncl groups config add-mcp-server` (CLARITY_BRIDGE_TOKEN):');
  console.log(`  ${token}`);
}

function nodePath(): string {
  return execSync('which node', { encoding: 'utf-8' }).trim();
}

function setupLaunchd(): void {
  const label = `${getLaunchdLabel(projectRoot)}-clarity-bridge`;
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
        <string>${projectRoot}/dist/clarity-bridge/server.js</string>
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
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/clarity-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/clarity-bridge.error.log</string>
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

  console.log(`clarity-bridge service loaded as ${label}.`);
  console.log(`Logs: ${projectRoot}/logs/clarity-bridge.log`);
}

if (platform !== 'darwin') {
  console.error(`clarity-bridge is macOS-only (the signed-in Clarity CLI session lives on this Mac). Platform: ${platform}.`);
  process.exit(1);
}

if (!fs.existsSync(CLARITY_CLI_BIN)) {
  console.error(`clarity CLI not found at ${CLARITY_CLI_BIN}. Install it from Clarity's Settings → Advanced → Command-Line Tool, or set CLARITY_CLI_BIN.`);
  process.exit(1);
}

fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
ensureToken();
setupLaunchd();
