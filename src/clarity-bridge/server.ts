/**
 * Standalone entrypoint. Runs as its own process (own service unit — see
 * scripts/setup-clarity-bridge-service.ts), independent of the main
 * NanoClaw host process and of any agent group's container. Binds to
 * localhost only; containers reach it via host.docker.internal.
 *
 * The Clarity task-manager CLI is a signed-in, host-installed binary — the
 * signed-in session lives in Clarity's own app-support directory and is
 * never exposed to a container. This service is the bridge: it runs on the
 * host (already signed in), and forwards allowlisted commands to it.
 *
 * Every request goes through allowlist.ts first — that's the boundary this
 * service exists to enforce.
 */
import { execFile } from 'child_process';
import http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { BridgeRequestBody, BridgeRequestError, buildInvocation } from './allowlist.js';

const envConfig = readEnvFile(['CLARITY_BRIDGE_PORT', 'CLARITY_BRIDGE_TOKEN', 'CLARITY_CLI_BIN']);
const PORT = parseInt(envConfig.CLARITY_BRIDGE_PORT || '8802', 10);
const TOKEN = envConfig.CLARITY_BRIDGE_TOKEN;
const CLARITY_CLI_BIN = envConfig.CLARITY_CLI_BIN || '/opt/homebrew/bin/clarity';

if (!TOKEN) {
  log.fatal('CLARITY_BRIDGE_TOKEN is not set — refusing to start with no shared-secret auth');
  process.exit(1);
}

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

function runClarityCli(argv: string[], stdin?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      CLARITY_CLI_BIN,
      argv,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const exitCode = err && 'code' in err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({ stdout, stderr, exitCode });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as BridgeRequestBody;

  let invocation: { argv: string[]; stdin?: string };
  try {
    invocation = buildInvocation(body);
  } catch (err) {
    if (err instanceof BridgeRequestError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }

  log.info('clarity-bridge running command', { command: body.command });
  const result = await runClarityCli(invocation.argv, invocation.stdin);
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
    log.error('clarity-bridge request failed', { url: req.url, err });
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log.info('clarity-bridge service started', { port: PORT });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
