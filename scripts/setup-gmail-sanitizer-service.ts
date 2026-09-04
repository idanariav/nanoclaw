/**
 * scripts/setup-gmail-sanitizer-service.ts — install and start the
 * gmail-sanitizer service as its own service unit, independent of the main
 * NanoClaw service. Mirrors setup/service.ts's launchd/systemd shape, but
 * for a distinct process/label so the two can be started, stopped, and
 * inspected separately — this one holds the Gmail/Drive OneCLI identity,
 * the main service never does.
 *
 * Usage: pnpm exec tsx scripts/setup-gmail-sanitizer-service.ts
 *
 * Generates GMAIL_SANITIZER_TOKEN into .env if not already present (the
 * shared secret Elric's container uses to authenticate to this service —
 * NOT a Gmail/Drive credential, which never leaves this process).
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
  if (/^GMAIL_SANITIZER_TOKEN=/m.test(content)) {
    console.log('GMAIL_SANITIZER_TOKEN already set in .env — leaving it as-is.');
    return;
  }
  const token = randomBytes(24).toString('hex');
  const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
  fs.appendFileSync(envPath, `${suffix}GMAIL_SANITIZER_TOKEN=${token}\n`);
  console.log('Generated GMAIL_SANITIZER_TOKEN and appended it to .env.');
  console.log(
    'Use this same value in the --env for `ncl groups config add-mcp-server` (GMAIL_SANITIZER_TOKEN):',
  );
  console.log(`  ${token}`);
}

function nodePath(): string {
  return execSync('which node', { encoding: 'utf-8' }).trim();
}

function setupLaunchd(): void {
  const label = `${getLaunchdLabel(projectRoot)}-gmail-sanitizer`;
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
        <string>${projectRoot}/dist/gmail-sanitizer/server.js</string>
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
    <string>${projectRoot}/logs/gmail-sanitizer.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/gmail-sanitizer.error.log</string>
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

  console.log(`gmail-sanitizer service loaded as ${label}.`);
  console.log(`Logs: ${projectRoot}/logs/gmail-sanitizer.log`);
}

function setupSystemd(): void {
  const unitName = `${getSystemdUnit(projectRoot)}-gmail-sanitizer`;
  const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, `${unitName}.service`);

  const unit = `[Unit]
Description=NanoClaw Gmail Sanitizer
After=network.target

[Service]
Type=simple
ExecStart=${nodePath()} ${projectRoot}/dist/gmail-sanitizer/server.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
StandardOutput=append:${projectRoot}/logs/gmail-sanitizer.log
StandardError=append:${projectRoot}/logs/gmail-sanitizer.error.log

[Install]
WantedBy=default.target`;

  fs.writeFileSync(unitPath, unit);
  console.log(`Wrote systemd unit: ${unitPath}`);

  execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
  execSync(`systemctl --user enable ${unitName}`, { stdio: 'inherit' });
  execSync(`systemctl --user restart ${unitName}`, { stdio: 'inherit' });

  console.log(`gmail-sanitizer service started as ${unitName}.`);
  console.log(`Logs: ${projectRoot}/logs/gmail-sanitizer.log`);
}

fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
ensureToken();

if (platform === 'darwin') {
  setupLaunchd();
} else if (platform === 'linux') {
  setupSystemd();
} else {
  console.error(`Unsupported platform: ${platform}. Run "node dist/gmail-sanitizer/server.js" manually instead.`);
  process.exit(1);
}
