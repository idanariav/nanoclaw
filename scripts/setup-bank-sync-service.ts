/**
 * scripts/setup-bank-sync-service.ts — install and start the bank-sync
 * service as its own service unit, independent of the main NanoClaw
 * service. Mirrors setup/service.ts's launchd/systemd shape, but for a
 * distinct process/label so the two can be started, stopped, and inspected
 * separately — this one holds the bank/credit-card login credentials, the
 * main service never does.
 *
 * Usage: pnpm exec tsx scripts/setup-bank-sync-service.ts
 *
 * Generates BANK_SYNC_TOKEN into .env if not already present (the shared
 * secret the agent's container uses to authenticate to this service — NOT a
 * bank credential, which never leaves this process).
 */
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';

const projectRoot = process.cwd();
const homeDir = os.homedir();
const platform = os.platform();

function ensureToken(): void {
  const envPath = path.join(projectRoot, '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  if (/^BANK_SYNC_TOKEN=/m.test(content)) {
    console.log('BANK_SYNC_TOKEN already set in .env — leaving it as-is.');
    return;
  }
  const token = randomBytes(24).toString('hex');
  const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
  fs.appendFileSync(envPath, `${suffix}BANK_SYNC_TOKEN=${token}\n`);
  console.log('Generated BANK_SYNC_TOKEN and appended it to .env.');
  console.log('Use this same value in the --env for `ncl groups config add-mcp-server` (BANK_SYNC_TOKEN):');
  console.log(`  ${token}`);
}

function nodePath(): string {
  return execSync('which node', { encoding: 'utf-8' }).trim();
}

function setupLaunchd(): void {
  const label = `${getLaunchdLabel(projectRoot)}-bank-sync`;
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
        <string>${projectRoot}/dist/bank-sync/server.js</string>
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
    <string>${projectRoot}/logs/bank-sync.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/bank-sync.error.log</string>
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

  console.log(`bank-sync service loaded as ${label}.`);
  console.log(`Logs: ${projectRoot}/logs/bank-sync.log`);
}

function setupSystemd(): void {
  const unitName = `${getSystemdUnit(projectRoot)}-bank-sync`;
  const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, `${unitName}.service`);

  const unit = `[Unit]
Description=NanoClaw Bank Sync
After=network.target

[Service]
Type=simple
ExecStart=${nodePath()} ${projectRoot}/dist/bank-sync/server.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
StandardOutput=append:${projectRoot}/logs/bank-sync.log
StandardError=append:${projectRoot}/logs/bank-sync.error.log

[Install]
WantedBy=default.target`;

  fs.writeFileSync(unitPath, unit);
  console.log(`Wrote systemd unit: ${unitPath}`);

  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync(`systemctl --user enable ${unitName}`, { stdio: 'inherit' });
  execSync(`systemctl --user restart ${unitName}`, { stdio: 'inherit' });

  console.log(`bank-sync service started as ${unitName}.`);
  console.log(`Logs: ${projectRoot}/logs/bank-sync.log`);
}

fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
ensureToken();

if (platform === 'darwin') {
  setupLaunchd();
} else if (platform === 'linux') {
  setupSystemd();
} else {
  console.error(`Unsupported platform: ${platform}. Run "node dist/bank-sync/server.js" manually instead.`);
  process.exit(1);
}
