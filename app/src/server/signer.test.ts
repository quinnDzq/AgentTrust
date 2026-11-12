/**
 * The signer signs one thing: a purchase challenge that fits its own policy,
 * under a grant issued to its own key. Everything else is a refusal with a
 * reason — and the service answers nobody without the link token.
 */

import { describe, expect, test } from 'bun:test';
import { identityProofBytes, intentBytes } from '../canon.ts';
import { usd, type Cents, type Mandate } from '../types.ts';
import { generateKeyPair, signMandate, verify } from './crypto.ts';
import {
  answerSigner,
  CHALLENGE_KIND,
  httpSigner,
  localSigner,
  PROOF_KIND,
  signChallenge,
  SignerUnavailable,
  type SignerPolicy,
  type SigningChallenge,
} from './signer.ts';

const key = generateKeyPair();
const buyer = generateKeyPair();
const NOW = 1_800_000_000_000;

const POLICY: SignerPolicy = {
  registryId: 'AGT-DECK-1',
  scope: 'stock_images',
  maxAmount: usd(20),
  maxTtlMs: 10 * 60 * 1_000,
};

const grant = (over: Partial<Omit<Mandate, 'signature'>> = {}): Mandate =>
  signMandate(
    { principal: 'Sandbox buyer', agentKey: key.publicKey, scope: 'stock_images', maxPerPayment: usd(20), expiresDay: 1, ...over },
    buyer.secret,
  );

const challenge = (over: Partial<SigningChallenge> = {}): SigningChallenge => ({
  kind: CHALLENGE_KIND,
  runId: 'run-0001-test',
  registryId: 'AGT-DECK-1',
  mandate: grant(),
  intent: { amount: usd(8), receiver: 'Kestrel Stock', reference: 'KS-1041', scope: 'stock_images' },
  nonce: 'bm9uY2Utbm9uY2Ux',
  expiresAtMs: NOW + 5 * 60 * 1_000,
  ...over,
});

const refusal = (input: unknown): string => {
  const result = signChallenge(input, key, POLICY, NOW);
  if (result.ok) throw new Error('signed something it should have refused');
  return result.error;
};

describe('what the signer signs', () => {
  test('a purchase challenge in policy: the signature covers exactly the canonical intent bytes', () => {
    const asked = challenge();
    const result = signChallenge(asked, key, POLICY, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.publicKey).toBe(key.publicKey);
    const bytes = intentBytes({
      intent: asked.intent,
      mandate: asked.mandate,
      nonce: asked.nonce,
      expiresAtMs: asked.expiresAtMs,
    });
    expect(verify(key.publicKey, bytes, result.signature)).toBe(true);

    // Bound to the nonce, the quote and the grant: change any one and it no longer verifies.
    const other = (edit: Parameters<typeof intentBytes>[0]): string => intentBytes(edit);
    const base = { intent: asked.intent, mandate: asked.mandate, nonce: asked.nonce, expiresAtMs: asked.expiresAtMs };
    for (const edited of [
      other({ ...base, nonce: 'YW5vdGhlci1ub25jZQ' }),
      other({ ...base, intent: { ...asked.intent, amount: usd(9) } }),
      other({ ...base, intent: { ...asked.intent, receiver: 'Lark Prints' } }),
      other({ ...base, intent: { ...asked.intent, reference: 'KS-1042' } }),
      other({ ...base, mandate: grant({ maxPerPayment: usd(500) }) }),
      other({ ...base, expiresAtMs: asked.expiresAtMs + 1 }),
    ]) {
      expect(verify(key.publicKey, edited, result.signature)).toBe(false);
    }
  });

  test('it never signs what it is handed: only fields it has checked and bytes it built itself', () => {
    expect(refusal('pay me')).toBe('the challenge is not an object');
    expect(refusal(null)).toBe('the challenge is not an object');
    expect(refusal({ ...challenge(), kind: 'login' })).toBe('this signer only signs AgentTrust purchase challenges');
    expect(refusal({ kind: CHALLENGE_KIND, bytes: 'overduel/v1/policy|…' })).toContain('this signer is AGT-DECK-1');
  });

  test('another agent’s name, a missing nonce, a stale or long-lived expiry are refused', () => {
    expect(refusal(challenge({ registryId: 'AGT-OTHER' }))).toBe('this signer is AGT-DECK-1, not the agent named');
    expect(refusal(challenge({ nonce: 'short' }))).toBe('the challenge has no usable one-time nonce');
    expect(refusal(challenge({ nonce: 'has spaces in it!!' }))).toBe('the challenge has no usable one-time nonce');
    expect(refusal(challenge({ expiresAtMs: NOW }))).toBe('the challenge has already expired');
    expect(refusal(challenge({ expiresAtMs: NOW + POLICY.maxTtlMs + 1 }))).toBe(
      'the challenge stays valid longer than this signer allows',
    );
    expect(refusal({ ...challenge(), expiresAtMs: 'soon' })).toBe('the challenge has no expiry');
  });

  test('the amount must be whole cents, inside its own limit and inside the grant', () => {
    const intent = challenge().intent;
    expect(refusal(challenge({ intent: { ...intent, amount: usd(20.01) } }))).toBe('the amount is over this signer’s limit');
    expect(refusal(challenge({ intent: { ...intent, amount: 0 as Cents } }))).toBe('the amount is not a whole number of cents');
    expect(refusal(challenge({ intent: { ...intent, amount: 8.5 as Cents } }))).toBe('the amount is not a whole number of cents');
    expect(refusal(challenge({ intent: { ...intent, amount: -800 as Cents } }))).toBe('the amount is not a whole number of cents');
    expect(refusal(challenge({ mandate: grant({ maxPerPayment: usd(5) }) }))).toBe('the amount is over the buyer grant');
  });

  test('only its own kind of purchase, under a grant issued to its own key', () => {
    const intent = challenge().intent;
    expect(refusal(challenge({ intent: { ...intent, scope: 'payout' } }))).toBe('this signer only signs stock_images purchases');
    expect(refusal(challenge({ mandate: grant({ scope: 'payout' }) }))).toBe('the buyer grant does not cover this kind of purchase');
    expect(refusal(challenge({ mandate: grant({ agentKey: generateKeyPair().publicKey }) }))).toBe(
      'the buyer grant was issued to a different key',
    );
    expect(refusal({ ...challenge(), mandate: null })).toBe('the challenge carries no buyer grant');
    expect(refusal(challenge({ mandate: { ...grant(), signature: '' } }))).toBe('the buyer grant is not signed');
    expect(refusal({ ...challenge(), intent: undefined })).toBe('the challenge names no purchase');
    expect(refusal(challenge({ intent: { ...intent, receiver: '' } }))).toBe('the challenge names no merchant');
  });
});

describe('the signer service', () => {
  const service = { key, policy: POLICY, token: 'a-link-token-that-is-long-enough', now: () => NOW };
  const ask = (over: Partial<Parameters<typeof answerSigner>[0]>) =>
    answerSigner(
      { method: 'POST', path: '/sign', authorization: `Bearer ${service.token}`, origin: null, body: challenge(), ...over },
      service,
    );

  test('with the link token it says which key it holds, and signs', () => {
    expect(ask({ method: 'GET', path: '/identity', body: null })).toEqual({
      status: 200,
      body: { registryId: 'AGT-DECK-1', publicKey: key.publicKey },
    });
    const signed = ask({});
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ ok: true, publicKey: key.publicKey });
    // The answer never carries the private half.
    expect(JSON.stringify(signed.body)).not.toContain(key.secret.d);
  });

  test('without it, or with a wrong one, nothing is signed and nothing is said', () => {
    for (const authorization of [null, '', 'Bearer wrong', `Basic ${service.token}`, service.token]) {
      const reply = ask({ authorization });
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({ ok: false, error: 'unauthorized' });
    }
    expect(ask({ method: 'GET', path: '/identity', authorization: null, body: null }).status).toBe(401);
  });

  test('a request from a web page is refused before the token is looked at', () => {
    expect(ask({ origin: 'https://evil.example' })).toEqual({ status: 403, body: { ok: false, error: 'not for browsers' } });
    expect(ask({ origin: 'http://localhost:8787' }).status).toBe(403);
  });

  test('an identity proof is a nonce signature, not a purchase', () => {
    const proof = { kind: PROOF_KIND, nonce: 'nonce-nonce-nonce', registryId: 'AGT-DECK-1', expiresAtMs: NOW + 60_000 };
    const signed = ask({ path: '/prove', body: proof });
    expect(signed.status).toBe(200);
    const body = signed.body as { ok: boolean; signature: string; publicKey: string };
    expect(body.ok).toBe(true);
    expect(body.publicKey).toBe(key.publicKey);
    expect(verify(key.publicKey, identityProofBytes(proof), body.signature)).toBe(true);
    expect(verify(key.publicKey, 'not the nonce', body.signature)).toBe(false);
    expect(JSON.stringify(signed.body)).not.toContain(key.secret.d);
    expect(ask({ path: '/prove', body: challenge() }).status).toBe(422);
  });

  test('a refusal is a 422 with the reason; anything else is not found', () => {
    const refused = ask({ body: challenge({ registryId: 'AGT-OTHER' }) });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ ok: false, error: 'this signer is AGT-DECK-1, not the agent named' });
    expect(ask({ path: '/keys' }).status).toBe(404);
    expect(ask({ method: 'GET', path: '/sign' }).status).toBe(404);
  });
});

describe('asking a signer', () => {
  test('in process, the client is the same code the service runs', async () => {
    const client = localSigner(key, POLICY, () => NOW);
    expect(await client.identity()).toEqual({ registryId: 'AGT-DECK-1', publicKey: key.publicKey });
    expect((await client.sign(challenge())).ok).toBe(true);
    expect(await client.sign(challenge({ nonce: 'x' }))).toEqual({ ok: false, error: 'the challenge has no usable one-time nonce' });
  });

  test('over HTTP it sends the token, and tells a refusal from a signer that cannot be asked', async () => {
    const service = { key, policy: POLICY, token: 'a-link-token-that-is-long-enough', now: () => NOW };
    const seen: { url: string; authorization: string | undefined }[] = [];
    let down = false;

    // A bare response object: the view tests install happy-dom's globals for the whole process.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (down) throw new Error('connection refused');
      const url = new URL(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: url.pathname, authorization: headers.authorization });
      const reply = answerSigner(
        {
          method: init?.method ?? 'GET',
          path: url.pathname,
          authorization: headers.authorization ?? null,
          origin: null,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        },
        service,
      );
      return { status: reply.status, ok: reply.status < 300, json: async () => reply.body } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = httpSigner({ url: 'http://127.0.0.1:8788/', token: service.token, fetchImpl });
    expect(await client.identity()).toEqual({ registryId: 'AGT-DECK-1', publicKey: key.publicKey });
    expect((await client.sign(challenge())).ok).toBe(true);
    expect(await client.sign(challenge({ registryId: 'AGT-OTHER' }))).toEqual({
      ok: false,
      error: 'this signer is AGT-DECK-1, not the agent named',
    });
    expect(seen.map((call) => call.url)).toEqual(['/identity', '/sign', '/sign']);
    expect(seen.every((call) => call.authorization === `Bearer ${service.token}`)).toBe(true);

    const stranger = httpSigner({ url: 'http://127.0.0.1:8788', token: 'not-the-link-token-at-all-000', fetchImpl });
    await expect(stranger.identity()).rejects.toBeInstanceOf(SignerUnavailable);

    down = true;
    await expect(client.sign(challenge())).rejects.toBeInstanceOf(SignerUnavailable);
  });
});
