/**
 * Standalone entrypoint. Runs as its own process (own service unit — see
 * scripts/setup-obsidian-bridge-service.ts), independent of the main
 * NanoClaw host process and of any agent group's container. Binds to
 * localhost only; containers reach it via host.docker.internal.
 *
 * obsidian-cli (Obsidian.app's own CLI) is a macOS Mach-O binary that talks
 * to the live Obsidian app over a local Unix socket — it cannot run inside a
 * Linux container. This service is the bridge: it runs on the host (where
 * Obsidian.app actually is), and forwards allowlisted commands to it.
 *
 * Every request goes through allowlist.ts first — that's the boundary this
 * service exists to enforce, both which commands are reachable at all and
 * which vault paths a command may target.
 */
import { execFile } from 'child_process';
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { BridgeRequestError, buildArgv } from './allowlist.js';

const envConfig = readEnvFile(['OBSIDIAN_BRIDGE_PORT', 'OBSIDIAN_BRIDGE_TOKEN']);
const PORT = parseInt(envConfig.OBSIDIAN_BRIDGE_PORT || '8800', 10);
const TOKEN = envConfig.OBSIDIAN_BRIDGE_TOKEN;

if (!TOKEN) {
  log.fatal('OBSIDIAN_BRIDGE_TOKEN is not set — refusing to start with no shared-secret auth');
  process.exit(1);
}

const OBSIDIAN_CLI_BIN = '/Applications/Obsidian.app/Contents/MacOS/obsidian-cli';
const EXEC_TIMEOUT_MS = 30_000;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function runObsidianCli(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      OBSIDIAN_CLI_BIN,
      argv,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const exitCode = err && 'code' in err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({ stdout, stderr, exitCode });
      },
    );
  });
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { command?: string; args?: Record<string, unknown> };
  if (!body.command) {
    sendJson(res, 400, { error: 'command is required' });
    return;
  }

  let argv: string[];
  try {
    argv = buildArgv(body.command, body.args ?? {});
  } catch (err) {
    if (err instanceof BridgeRequestError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }

  log.info('obsidian-bridge running command', { command: body.command });
  const result = await runObsidianCli(argv);
  sendJson(res, 200, result);
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');

  try {
    if (req.method === 'POST' && url.pathname === '/run') {
      await handleRun(req, res);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    log.error('obsidian-bridge request failed', { url: req.url, err });
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log.info('obsidian-bridge service started', { port: PORT });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
