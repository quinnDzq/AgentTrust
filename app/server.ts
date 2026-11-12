/** Local buyer controls, PayPal callbacks, and the separate MCP listener. */

import { extname, join, normalize, sep } from 'node:path';
import { DECK_DATABASE, ensureDeckScene, reseedDeck, seedDeck } from './scripts/deck.ts';
import { openStore } from './src/server/db.ts';
import { Engine } from './src/server/engine.ts';
import { loadKeyring } from './src/server/keys.ts';
import { payPalFromEnv, publicBaseUrl } from './src/server/paypal.ts';
import { erc8004FromEnv, readRegistration } from './src/server/erc8004.ts';
import { identityLogLine, identityModeFromEnv } from './src/server/identity.ts';
import { askThresholdFromEnv, defaultBudgetFromEnv, parseBudget } from './src/server/budget.ts';
import { LiveVerifier } from './src/server/live.ts';
import { CONNECTOR_PATH, createConnector } from './src/server/mcp.ts';
import { DEFAULT_REFERENCE_PATH, fileReference } from './src/server/reference.ts';
import { CONNECTOR_TOKEN_PATH, localSecret, SIGNER_LINK_PATH } from './src/server/secrets.ts';
import { httpSigner } from './src/server/signer.ts';
import { appHashOf, describeCandidates, walletCandidates } from './src/server/wallets.ts';
import { fmtUsd, type Cents, type VerificationSnapshot } from './src/types.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST?.trim() || '127.0.0.1';

const keyring = loadKeyring();
const store = openStore(process.env.DATABASE_PATH ?? DECK_DATABASE);

// Without Sandbox credentials, the server labels payments as simulated.
const PUBLIC_BASE = publicBaseUrl(process.env, PORT);
const paypal = payPalFromEnv(process.env, PUBLIC_BASE);
const chargeMode = paypal ? 'live' : 'simulated';

// Which merchant app this is, and any pre-authorized wallet it was pointed at.
// Read here, kept on the server, and checked with PayPal before any use.
const appHash = paypal ? appHashOf(process.env.PAYPAL_SANDBOX_CLIENT_ID?.trim() ?? '') : 'simulated';
const candidates = paypal ? walletCandidates(process.env, appHash) : [];
const defaultBudget = defaultBudgetFromEnv(process.env);
const askThreshold = askThresholdFromEnv(process.env);

if (!store.isSeeded()) {
  seedDeck(store, keyring, chargeMode, defaultBudget.budget, askThreshold.pct);
} else if (ensureDeckScene(store, keyring, chargeMode, defaultBudget.budget, askThreshold.pct)) {
  console.log(`Started a new payment session: PayPal Sandbox is ${paypal ? 'configured' : 'not configured'}.`);
}

const grant = store.deckGrant();
if (grant && grant.ask_pct == null) store.patchDeckGrant({ ask_pct: askThreshold.pct });

const engine = new Engine(store, keyring, paypal, { appHash, candidates });
engine.start({ runWorkLoop: false });

/** Ask PayPal which wallet is usable, and say what came of it. Never prints a token. */
const refreshWallet = (): void => {
  void engine.refreshWallet().then((outcome) => console.log(`[wallet] ${outcome.message}`));
};
refreshWallet();

/* ---------- the live flow: connector, signer, enrollment ---------- */

// The agent connects to a separate bearer-token-protected MCP listener.
const MCP_PORT = Number(process.env.MCP_PORT ?? 8789);
const MCP_HOST = process.env.MCP_HOST?.trim() || '127.0.0.1';
const CONNECTOR_ON = process.env.AGENTTRUST_CONNECTOR?.trim().toLowerCase() !== 'off';

const SIGNER_URL = process.env.AGENTTRUST_SIGNER_URL?.trim() || 'http://127.0.0.1:8788';
const SIGNER_ON = SIGNER_URL.toLowerCase() !== 'off';
const REFERENCE_PATH = process.env.AGENTTRUST_REFERENCE_PATH?.trim() || DEFAULT_REFERENCE_PATH;
const CALIBRATE_AS = process.env.AGENTTRUST_CALIBRATE_AS?.trim() || null;

const erc8004 = erc8004FromEnv(process.env);
const identity = identityModeFromEnv(process.env, erc8004.config !== null);

const live = new LiveVerifier({
  store,
  engine,
  keyring,
  signer: SIGNER_ON
    ? httpSigner({ url: SIGNER_URL, token: localSecret(SIGNER_LINK_PATH, process.env.AGENTTRUST_SIGNER_TOKEN) })
    : null,
  erc8004: erc8004.config,
  identityMode: identity.mode,
  readRegistration,
  reference: fileReference(REFERENCE_PATH),
  calibrateAs: CALIBRATE_AS,
  verifyBase: PUBLIC_BASE,
});

let connectorServer: ReturnType<typeof Bun.serve> | null = null;
let connectorNote = 'off';

// Whatever an earlier process wrote about its connector is not true of this
// one until this one is listening.
store.setConnector(null);
live.start();

if (CONNECTOR_ON) {
  const connector = createConnector({
    live,
    token: localSecret(CONNECTOR_TOKEN_PATH, process.env.AGENTTRUST_MCP_TOKEN),
    allowedOrigins: (process.env.AGENTTRUST_MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    onRefused: (why) => console.log(`[connector] refused: ${why}`),
  });
  try {
    connectorServer = Bun.serve({ port: MCP_PORT, hostname: MCP_HOST, fetch: (req) => connector.fetch(req) });
    connectorNote = `http://${MCP_HOST}:${MCP_PORT}${CONNECTOR_PATH}`;
    live.serving(connectorNote);
  } catch (err) {
    // A second server on this machine — a preview on another port — still runs; it just has no connector.
    connectorNote = `not started: ${err instanceof Error ? err.message : 'the port could not be opened'}`;
  }
}

/* ---------- replies ---------- */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const ok = (message?: string): Response =>
  jsonResponse(message === undefined ? { ok: true } : { ok: true, message });

const fail = (error: string, status = 400): Response => jsonResponse({ ok: false, error }, status);

async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** A budget from the page. No body means "keep the cap already on the grant". */
function readBudget(payload: { budget?: unknown; currency?: unknown } | null):
  | { readonly ok: true; readonly cents?: Cents }
  | { readonly ok: false; readonly message: string } {
  const currency = typeof payload?.currency === 'string' ? payload.currency : undefined;
  if (!payload || (payload.budget === undefined && (currency === undefined || currency.trim() === ''))) return { ok: true };
  if (typeof payload.budget !== 'number') return { ok: false, message: 'Pass budget as a number of US dollars.' };
  const parsed = parseBudget(payload.budget, currency);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, cents: parsed.cents };
}

/** The ask threshold from the page, as a whole percent of the budget. */
function readAskPct(value: unknown):
  | { readonly ok: true; readonly pct?: number }
  | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    return { ok: false, message: 'Ask threshold must be a whole percent from 0 to 100.' };
  }
  return { ok: true, pct: value };
}

/* ---------- the exported verification page ---------- */

const VERIFY_URL = '/verify/paypal/';
const VERIFY_DIR = join(import.meta.dir, '..', 'web', 'out');

const VERIFY_TYPES: { readonly [ext: string]: string } = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function verifyPage(pathname: string): Promise<Response> {
  let rest: string;
  try {
    rest = decodeURIComponent(pathname.slice('/verify/'.length));
  } catch {
    return new Response('Bad path', { status: 400 });
  }
  // Only files inside the export, whatever the path says.
  const target = normalize(join(VERIFY_DIR, rest));
  const section = join(VERIFY_DIR, rest.startsWith('_next/static/') ? '_next/static' : 'paypal');
  if (target !== section && !target.startsWith(section + sep)) {
    return new Response('Not found', { status: 404 });
  }

  for (const candidate of [target, join(target, 'index.html')]) {
    const found = Bun.file(candidate);
    if (!(await found.exists())) continue;
    const immutable = rest.startsWith('_next/static/');
    return new Response(found, {
      headers: {
        'content-type': VERIFY_TYPES[extname(candidate)] ?? 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      },
    });
  }

  if (!(await Bun.file(join(VERIFY_DIR, 'paypal', 'index.html')).exists())) {
    return new Response('Build the verification page with bun run build in web/.', { status: 503 });
  }
  return new Response('Not found', { status: 404 });
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page PayPal sends the buyer back to. It reflects nothing from the URL —
 * PayPal's query string carries tokens — and closes itself if it can.
 */
const returnPage = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      '<style>body{font-family:system-ui,sans-serif;background:#15121B;color:#F4ECD8;display:grid;' +
      'place-items:center;min-height:100vh;margin:0}main{max-width:30rem;padding:2rem;text-align:center}' +
      'a{color:#E8B64A}</style></head><body><main>' +
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="${VERIFY_URL}">Back to AgentTrust</a></p>` +
      '</main><script>setTimeout(function(){try{window.close()}catch(e){}},1500)</script></body></html>',
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );

/* ---------- routes ---------- */

async function route(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const { method } = req;

  // Browser requests to buyer controls must use JSON. Cross-origin forms
  // cannot send it, and the server does not grant CORS access to these routes.
  if (method === 'POST' && pathname.startsWith('/api/')) {
    const contentType = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return fail('Send application/json.', 415);
  }

  if (method === 'GET') {
    if (pathname === '/' || pathname === '/verify/paypal') {
      return new Response(null, { status: 308, headers: { location: VERIFY_URL } });
    }
    if (
      pathname === VERIFY_URL ||
      /^\/verify\/paypal\/(?:index\.html|(?:index|__next[^/]+)\.txt)$/.test(pathname) ||
      pathname.startsWith('/verify/_next/static/')
    ) {
      return verifyPage(pathname);
    }
  }

  if (method === 'GET' && pathname === '/api/state') {
    const snapshot: VerificationSnapshot = {
      seq: store.world().seq,
      grant: store.grantView(),
      wallet: store.walletView(),
      live: store.liveView(),
      enrollment: store.enrollmentView(),
      connector: store.connectorView(),
    };
    return jsonResponse(snapshot);
  }

  // The wallet's connection status, and nothing else: no token, no link.
  if (method === 'GET' && pathname === '/api/wallet') {
    return jsonResponse(store.walletView());
  }

  if ((method === 'POST' && pathname === '/api/grant/budget') || (method === 'POST' && pathname === '/api/grant/approve')) {
    const payload = await body<{ budget?: unknown; currency?: unknown; askThresholdPct?: unknown }>(req);
    const read = readBudget(payload);
    if (!read.ok) return fail(read.message);
    const threshold = readAskPct(payload?.askThresholdPct);
    if (!threshold.ok) return fail(threshold.message);
    if (threshold.pct !== undefined) {
      const set = engine.setAskThreshold(threshold.pct);
      if (!set.ok) return fail(set.message);
    }
    const outcome =
      pathname === '/api/grant/budget'
        ? read.cents === undefined
          ? threshold.pct === undefined
            ? { ok: false, message: 'Pass budget as a number of US dollars.' }
            : { ok: true, message: `Ask threshold is ${threshold.pct}% of the budget.` }
          : engine.offerBudget(read.cents)
        : read.cents === undefined
          ? engine.approveGrant()
          : engine.approveGrant(read.cents);
    return outcome.ok ? ok(outcome.message) : fail(outcome.message);
  }

  if (method === 'POST' && pathname === '/api/identity/prove') {
    const outcome = await live.proveIdentity();
    return outcome.ok ? jsonResponse(outcome) : fail(outcome.message);
  }

  if (method === 'POST' && pathname === '/api/budget/decide') {
    const payload = await body<{ requestId?: unknown; choice?: unknown }>(req);
    if (typeof payload?.requestId !== 'string' || payload.requestId.trim() === '') return fail('Pass the request id.');
    if (payload.choice !== 'approve' && payload.choice !== 'decline') return fail('Choose approve or decline.');
    const outcome = engine.decideBudgetRequest(payload.requestId, payload.choice);
    return outcome.ok ? ok(outcome.message) : fail(outcome.message);
  }

  if (method === 'POST' && pathname === '/api/live/decide') {
    const payload = await body<{ runId?: unknown; choice?: unknown }>(req);
    if (typeof payload?.runId !== 'string' || payload.runId.trim() === '') return fail('Pass the run id.');
    if (payload.choice !== 'approve' && payload.choice !== 'decline') return fail('Choose approve or decline.');
    const outcome = engine.decideLivePurchase(payload.runId, payload.choice);
    return outcome.ok ? ok(outcome.message) : fail(outcome.message);
  }

  // "Connect PayPal Sandbox" and "Reopen PayPal". The approval link goes back
  // to this browser only, to open in a window. It is not logged and never
  // appears in a snapshot.
  if (method === 'POST' && pathname === '/api/grant/paypal') {
    const outcome = await engine.connectWallet();
    if (!outcome.ok) return fail(outcome.message);
    return jsonResponse({ ok: true, message: outcome.message, approvalUrl: outcome.approvalUrl ?? null });
  }

  // "I've agreed in PayPal" while a setup waits; "Check again" otherwise.
  if (method === 'POST' && pathname === '/api/grant/check') {
    const outcome = await engine.checkWallet();
    return outcome.ok ? ok(outcome.message) : fail(outcome.message);
  }

  if (method === 'POST' && pathname === '/api/grant/cancel') {
    const outcome = engine.cancelWalletSetup(null);
    return outcome.ok ? ok(outcome.message) : fail(outcome.message);
  }

  // "Enroll" and "Refresh": read the signer's public key and, in erc8004
  // identity mode, the agent's registration. Private, like every setup step:
  // the connector cannot reach it.
  if (method === 'POST' && pathname === '/api/agent/enroll') {
    const outcome = await live.enroll();
    return outcome.ok ? ok(outcome.message) : fail(outcome.message, 409);
  }

  if (method === 'POST' && pathname === '/api/grant/revoke') {
    const outcome = engine.revokeAgent();
    return outcome.ok ? ok(outcome.message) : fail(outcome.message);
  }

  if (method === 'POST' && pathname === '/api/payments/reconcile') {
    const outcome = await engine.reconcileCharges();
    return outcome.ok ? ok(outcome.message) : fail(outcome.message);
  }

  // PayPal sends the buyer here after the consent page. The path ends in the
  // attempt id this server put in the return URL; PayPal adds the id of the
  // setup token it approved. The engine checks both belong to the current
  // attempt, then asks PayPal. Nothing from the URL is echoed onto the page.
  const approvedMatch = pathname.match(/^\/paypal\/approved\/([A-Za-z0-9-]{8,64})$/);
  if (method === 'GET' && approvedMatch) {
    const returned = url.searchParams.get('approval_token_id');
    // For the terminal only: which parameters came back. Never their values.
    console.log(`[paypal] buyer returned · params: ${[...url.searchParams.keys()].join(', ') || 'none'}`);
    const outcome = await engine.walletReturned(approvedMatch[1] ?? '', returned);
    console.log(`[paypal] wallet setup: ${outcome.ok ? 'connected' : outcome.message}`);
    return returnPage(
      outcome.ok ? 'Wallet connected' : 'Not connected',
      outcome.ok ? 'You can close this window and return to AgentTrust.' : outcome.message,
    );
  }

  const cancelledMatch = pathname.match(/^\/paypal\/cancelled\/([A-Za-z0-9-]{8,64})$/);
  if (method === 'GET' && cancelledMatch) {
    const outcome = engine.cancelWalletSetup(cancelledMatch[1] ?? '');
    return returnPage(
      outcome.ok ? 'Cancelled' : 'Not changed',
      outcome.ok ? 'Nothing was saved. You can connect again from AgentTrust.' : outcome.message,
    );
  }

  // A return with no attempt id cannot be matched to any attempt, so it
  // changes nothing — whatever it claims.
  if (method === 'GET' && (pathname === '/paypal/approved' || pathname === '/paypal/cancelled')) {
    return returnPage('Not changed', 'This PayPal return is not from the current setup. Start again from AgentTrust.');
  }
  if (method === 'POST' && pathname === '/api/session/reset') {
    engine.stop();
    reseedDeck(store, keyring, chargeMode, defaultBudget.budget, askThreshold.pct);
    store.forgetPaypalWallet();
    engine.start({ runWorkLoop: false });
    live.start();
    refreshWallet();
    return ok(
      candidates.length > 0
        ? 'Session reset. The saved wallet will be checked with PayPal again. Approve the budget to continue.'
        : 'Session reset. Connect the PayPal wallet and approve the budget to continue.',
    );
  }

  if (method === 'GET' && pathname === '/api/health') {
    return jsonResponse({ ok: true });
  }

  return pathname.startsWith('/api/')
    ? fail(`no route for ${method} ${pathname}`, 404)
    : new Response('Not found', { status: 404 });
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      return await route(req, url);
    } catch (err) {
      console.error(`[server] ${req.method} ${url.pathname} failed:`, err);
      return fail(err instanceof Error ? err.message : 'something went wrong', 500);
    }
  },
});

/** Let the engine's timers and the database close cleanly on Ctrl-C. */
function shutdown(signal: string): void {
  console.log(`\n${signal}: stopping AgentTrust.`);
  engine.stop();
  live.stop();
  void connectorServer?.stop();
  void server.stop();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(
  `AgentTrust → http://localhost:${PORT}${VERIFY_URL}` +
    `\n  PayPal Sandbox: ${paypal ? 'configured' : 'not configured — set the Sandbox app credentials before connecting a wallet'}` +
    `\n  PayPal return URLs → ${PUBLIC_BASE}/paypal/approved/…` +
    (paypal ? `\n  Wallet: ${describeCandidates(candidates)} to check with PayPal` : '') +
    `\n  Default budget: ${fmtUsd(defaultBudget.budget)}` +
    (defaultBudget.problem ? `\n  ${defaultBudget.problem}` : '') +
    `\n  Ask threshold: ${askThreshold.pct}% of the budget` +
    (askThreshold.problem ? `\n  ${askThreshold.problem}` : '') +
    `\n  Identity: ${identityLogLine(identity, erc8004)}` +
    (identity.mode === 'local' && erc8004.problem ? `\n  ERC-8004: ${erc8004.problem}` : '') +
    `\n  Connector (MCP): ${connectorNote}` +
    (connectorServer
      ? ` · bearer token in ${process.env.AGENTTRUST_MCP_TOKEN ? 'AGENTTRUST_MCP_TOKEN' : `app/${CONNECTOR_TOKEN_PATH}`}`
      : '') +
    `\n  Signer: ${SIGNER_ON ? SIGNER_URL : 'off'}` +
    `\n  Model reference: ${REFERENCE_PATH}` +
    (CALIBRATE_AS ? `\n  CALIBRATION MODE: replies are recorded as "${CALIBRATE_AS}" and never scored` : ''),
);
