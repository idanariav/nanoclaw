/**
 * Standalone entrypoint. Runs as its own process (own service unit — see
 * scripts/setup-bank-sync-service.ts), independent of the main NanoClaw
 * host process and of any agent group's container. Binds to localhost only;
 * containers reach it via host.docker.internal.
 *
 * Bank/credit-card login credentials (fetched from Bitwarden Secrets Manager
 * per scrape) never leave this process — no route here echoes a credential value back, only
 * account ids/companyIds and the scraped transactions themselves.
 */
import http from 'http';

import { fetchBankCredentials } from './bws.js';
import { accountSummaries, loadBankSyncAccounts } from './credentials.js';
import { createJob, getJob } from './jobs.js';
import { runJobAccounts } from './scraper-runner.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const envConfig = readEnvFile(['BANK_SYNC_PORT', 'BANK_SYNC_TOKEN']);
const PORT = parseInt(envConfig.BANK_SYNC_PORT || '8801', 10);
const TOKEN = envConfig.BANK_SYNC_TOKEN;

if (!TOKEN) {
  log.fatal('BANK_SYNC_TOKEN is not set — refusing to start with no shared-secret auth');
  process.exit(1);
}

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

function handleListAccounts(res: http.ServerResponse): void {
  sendJson(res, 200, { accounts: accountSummaries() });
}

async function handleStartScrape(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const { accountIds } = body as { accountIds?: string[] };
  const configured = loadBankSyncAccounts();
  const selected = accountIds?.length ? configured.filter((a) => accountIds.includes(a.id)) : configured;

  if (selected.length === 0) {
    sendJson(res, 400, {
      error: accountIds?.length
        ? 'None of the requested accountIds match a configured account.'
        : 'No accounts are configured in data/bank-sync-credentials.json.',
    });
    return;
  }

  let withCreds: typeof selected;
  try {
    const secrets = await fetchBankCredentials();
    withCreds = selected.map((a) => ({ ...a, credentials: a.credentials ?? secrets.get(a.id) }));
  } catch (err) {
    log.error('bank-sync: fetching credentials from Bitwarden failed', { err });
    sendJson(res, 502, { error: 'Could not fetch credentials from Bitwarden Secrets Manager (see service log).' });
    return;
  }
  const missing = withCreds.filter((a) => !a.credentials).map((a) => a.id);
  if (missing.length) {
    sendJson(res, 400, { error: `No Bitwarden secret found for account(s): ${missing.join(', ')}` });
    return;
  }

  const job = createJob(selected.map(({ id, companyId }) => ({ id, companyId })));
  // Fire-and-forget: the HTTP response returns the runId immediately; the
  // caller polls /scrape/status/:runId while scraping runs in the background.
  runJobAccounts(job.runId, withCreds).catch((err) => {
    log.error('bank-sync: job run failed unexpectedly', { runId: job.runId, err });
  });
  sendJson(res, 200, { runId: job.runId });
}

function handleJobStatus(runId: string, res: http.ServerResponse): void {
  const job = getJob(runId);
  if (!job) {
    sendJson(res, 404, { error: `No job found for runId ${runId}` });
    return;
  }
  sendJson(res, 200, {
    runId: job.runId,
    accounts: job.accounts.map(({ accountId, companyId, status, transactions, error }) => ({
      accountId,
      companyId,
      status,
      transactions,
      error,
    })),
  });
}

const server = http.createServer(async (req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/accounts') {
      handleListAccounts(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/scrape/start') {
      await handleStartScrape(req, res);
      return;
    }

    const statusMatch = url.pathname.match(/^\/scrape\/status\/([^/]+)$/);
    if (req.method === 'GET' && statusMatch) {
      handleJobStatus(decodeURIComponent(statusMatch[1]), res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    log.error('bank-sync request failed', { url: req.url, err });
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log.info('bank-sync service started', { port: PORT });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
