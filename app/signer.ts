/**
 * bun run signer — the Demo Agent's signer service.
 *
 * One small process that holds the agent's private key and nothing else. The
 * gateway asks it for a signature over one purchase challenge at a time, so a
 * live run needs no interactive step and the key never enters the gateway.
 *
 * It listens on this machine only, answers only a caller that presents the
 * link token, refuses anything a browser sends, and signs only what
 * `signChallenge` accepts: a purchase, in its own scope, under a grant issued
 * to its own key, within its own limit, expiring soon. See `src/server/signer.ts`.
 *
 * The key is generated on first start into `keys/signer.local.json`. Enroll it
 * from the verification page afterwards; a new key needs a new enrollment.
 */

import { MAX_BUDGET_USD } from './src/server/budget.ts';
import { fingerprint } from './src/server/crypto.ts';
import { DECK } from './src/server/deck.ts';
import { localSecret, SIGNER_KEY_PATH, SIGNER_LINK_PATH, signerKey } from './src/server/secrets.ts';
import { answerSigner, type SignerPolicy } from './src/server/signer.ts';
import { fmtUsd, usd } from './src/types.ts';

const PORT = Number(process.env.SIGNER_PORT ?? 8788);
const HOST = '127.0.0.1';

const key = signerKey(process.env.AGENTTRUST_SIGNER_KEY_PATH ?? SIGNER_KEY_PATH);
const token = localSecret(SIGNER_LINK_PATH, process.env.AGENTTRUST_SIGNER_TOKEN);

/**
 * This signer's own ceiling. The buyer's approved grant can be narrower; it
 * can never widen this. The ceiling is the demo's largest budget, so a $500
 * purchase under a $1,000 grant is not blocked here.
 */
const policy: SignerPolicy = {
  registryId: DECK.registryId,
  scope: 'stock_images',
  maxAmount: usd(MAX_BUDGET_USD),
  maxTtlMs: 10 * 60 * 1_000,
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    let body: unknown = null;
    if (req.method === 'POST') {
      // A challenge is a few hundred bytes. Anything large is not one.
      const text = await req.text();
      if (text.length > 16_384) return json(413, { ok: false, error: 'too large' });
      try {
        body = JSON.parse(text);
      } catch {
        return json(400, { ok: false, error: 'not JSON' });
      }
    }

    const reply = answerSigner(
      {
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get('authorization'),
        origin: req.headers.get('origin'),
        body,
      },
      { key, policy, token, now: Date.now },
    );

    if (req.method === 'POST' && url.pathname === '/sign' && reply.status !== 401 && reply.status !== 403) {
      // What was asked and what came of it. Never the signature, never the token.
      const asked = body as { runId?: unknown; intent?: { amount?: unknown; receiver?: unknown; reference?: unknown } } | null;
      const result = reply.body as { ok?: boolean; error?: string };
      const text = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 60).replace(/[^\w .:-]/g, '?') : '?');
      console.log(
        `[signer] run ${text(asked?.runId)} · ${typeof asked?.intent?.amount === 'number' ? asked.intent.amount : '?'}¢ ` +
          `to ${text(asked?.intent?.receiver)} for ${text(asked?.intent?.reference)} → ` +
          (result.ok ? 'signed' : `refused: ${result.error ?? 'no reason'}`),
      );
    }
    return json(reply.status, reply.body);
  },
});

function shutdown(): void {
  void server.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  `AgentTrust signer → http://${HOST}:${PORT} (this machine only)\n` +
    `  agent ${policy.registryId} · public key ${key.publicKey} · fingerprint ${fingerprint(key.publicKey)}\n` +
    `  signs ${policy.scope} purchases up to ${fmtUsd(policy.maxAmount)}, under a grant issued to this key\n` +
    `  the private key stays in ${process.env.AGENTTRUST_SIGNER_KEY_PATH ?? SIGNER_KEY_PATH}; the public key above is what gets enrolled`,
);
