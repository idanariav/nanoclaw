/**
 * A separate OneCLI agent identity, deliberately distinct from any NanoClaw
 * agent group's container identity. OneCLI's Gmail/Drive OAuth "apps" are
 * connected project-wide (there is no per-agent app scoping), so identity
 * separation alone does not keep a NanoClaw container from reaching them —
 * the actual enforcement is an explicit `onecli rules create --action block
 * --agent-id <container's agent id> --host-pattern gmail.googleapis.com`
 * (and www.googleapis.com for Drive), set up once outside this code. This
 * identity exists so the gateway has a distinct, unblocked identity for the
 * sanitizer's own requests to route through.
 */
import { OneCLI } from '@onecli-sh/sdk';
import { ProxyAgent } from 'undici';

import { readEnvFile } from '../env.js';

export const GMAIL_SANITIZER_ONECLI_IDENTIFIER = 'gmail-sanitizer';

const envConfig = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
const onecli = new OneCLI({ url: envConfig.ONECLI_URL, apiKey: envConfig.ONECLI_API_KEY });

let dispatcherPromise: Promise<ProxyAgent> | undefined;

async function resolveDispatcher(): Promise<ProxyAgent> {
  await onecli.ensureAgent({
    name: 'Gmail Sanitizer',
    identifier: GMAIL_SANITIZER_ONECLI_IDENTIFIER,
  });
  const config = await onecli.getContainerConfig({ agent: GMAIL_SANITIZER_ONECLI_IDENTIFIER });
  const rawProxyUrl = config.env.HTTPS_PROXY;
  if (!rawProxyUrl) {
    throw new Error(
      'OneCLI returned no HTTPS_PROXY for the gmail-sanitizer identity — is OneCLI running and reachable?',
    );
  }
  // getContainerConfig is written for containers, so it points at
  // host.docker.internal — only resolvable from inside Docker. This process
  // runs on the bare host by design (see file header), so swap it for the
  // loopback address the gateway is actually listening on.
  const proxyUrl = rawProxyUrl.replace('host.docker.internal', '127.0.0.1');
  return new ProxyAgent({
    uri: proxyUrl,
    requestTls: config.caCertificate ? { ca: config.caCertificate } : undefined,
  });
}

/**
 * Resolves the proxy dispatcher for the gmail-sanitizer OneCLI identity.
 * Cached for the process lifetime on success, so a OneCLI credential
 * rotation is picked up without a restart isn't paid for on every request.
 * A failure (OneCLI unreachable, gateway down) is NOT cached — the next
 * call retries from scratch instead of replaying the same rejection forever.
 */
export async function getGmailSanitizerDispatcher(): Promise<ProxyAgent> {
  if (!dispatcherPromise) {
    dispatcherPromise = resolveDispatcher().catch((err) => {
      dispatcherPromise = undefined;
      throw err;
    });
  }
  return dispatcherPromise;
}
