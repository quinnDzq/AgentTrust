/**
 * The Demo Agent's signer: the one place its private key is used.
 *
 * In the live flow the agent's key does not live in the gateway. A separate
 * signer service holds it (`signer.ts` at the app root runs one), and the
 * connector asks it for a signature over one purchase challenge at a time. So
 * once the signer's key is the enrolled one, nothing in the gateway process can
 * produce a request the gate would accept as the agent's — including the
 * gateway itself.
 *
 * The signer is deliberately narrow. It does not sign bytes it is handed. It
 * is handed the *fields* of a purchase challenge, checks them against its own
 * policy, builds the canonical intent bytes itself (`src/canon.ts`, with their
 * domain prefix), and signs those. A caller cannot get a signature over a
 * login, a grant, a policy or free text out of it, whatever it sends.
 *
 * What a signature binds, because all of it is inside those bytes: the
 * gateway's one-time nonce and expiry, the merchant, quote reference and
 * amount, and the buyer's whole grant — which names this key.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  isMandateScope,
  type Cents,
  type Intent,
  type Mandate,
  type MandateScope,
} from '../types.ts';
import { identityProofBytes } from '../canon.ts';
import { sign, signEnvelope, type KeyPair } from './crypto.ts';

export const CHALLENGE_KIND = 'agenttrust/purchase-challenge/v1';
/** A nonce signed to show the enrolled key, and nothing that could be a payment. */
export const PROOF_KIND = 'agenttrust/identity-proof/v1';

export interface IdentityProof {
  readonly kind: typeof PROOF_KIND;
  readonly nonce: string;
  readonly registryId: string;
  readonly expiresAtMs: number;
}

/** One purchase the gateway asks the agent to put its key to. */
export interface SigningChallenge {
  readonly kind: typeof CHALLENGE_KIND;
  /** The live run this belongs to. Not signed; for the signer's own log. */
  readonly runId: string;
  readonly registryId: string;
  /** The buyer's grant to this agent's key, signed by the buyer. */
  readonly mandate: Mandate;
  readonly intent: Intent;
  /** The gateway's one-time nonce. The gate burns it on first use. */
  readonly nonce: string;
  readonly expiresAtMs: number;
}

/** What this signer is willing to sign. Its own limits, whatever a grant says. */
export interface SignerPolicy {
  readonly registryId: string;
  readonly scope: MandateScope;
  /** The largest single purchase it will put its key to. */
  readonly maxAmount: Cents;
  /** How far ahead a challenge may expire. A long-lived signature is a stealable one. */
  readonly maxTtlMs: number;
}

export type SignResult =
  | { readonly ok: true; readonly publicKey: string; readonly signature: string }
  | { readonly ok: false; readonly error: string };

const refuse = (error: string): SignResult => ({ ok: false, error });

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Check a challenge against the signer's policy and, only if every field is in
 * order, sign it.
 *
 * `input` is whatever arrived, so every field is checked before it is used and
 * nothing here throws: a refusal is an answer.
 */
export function signChallenge(input: unknown, key: KeyPair, policy: SignerPolicy, nowMs: number): SignResult {
  if (typeof input !== 'object' || input === null) return refuse('the challenge is not an object');
  const c = input as { readonly [K in keyof SigningChallenge]?: unknown };

  if (c.kind !== CHALLENGE_KIND) return refuse('this signer only signs AgentTrust purchase challenges');
  if (c.registryId !== policy.registryId) return refuse(`this signer is ${policy.registryId}, not the agent named`);
  if (typeof c.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(c.nonce)) {
    return refuse('the challenge has no usable one-time nonce');
  }

  if (!Number.isSafeInteger(c.expiresAtMs)) return refuse('the challenge has no expiry');
  const expiresAtMs = c.expiresAtMs as number;
  if (expiresAtMs <= nowMs) return refuse('the challenge has already expired');
  if (expiresAtMs > nowMs + policy.maxTtlMs) return refuse('the challenge stays valid longer than this signer allows');

  const intent = c.intent as { readonly [K in keyof Intent]?: unknown } | null | undefined;
  if (typeof intent !== 'object' || intent === null) return refuse('the challenge names no purchase');
  if (!isCount(intent.amount) || intent.amount === 0) return refuse('the amount is not a whole number of cents');
  if (intent.amount > policy.maxAmount) return refuse('the amount is over this signer’s limit');
  if (!isText(intent.receiver, 120)) return refuse('the challenge names no merchant');
  if (!isText(intent.reference, 64)) return refuse('the challenge names no quote');
  if (intent.scope !== policy.scope) return refuse(`this signer only signs ${policy.scope} purchases`);

  const mandate = c.mandate as { readonly [K in keyof Mandate]?: unknown } | null | undefined;
  if (typeof mandate !== 'object' || mandate === null) return refuse('the challenge carries no buyer grant');
  // Signing under a grant issued to somebody else would be lending this key's
  // name to a different agent's authority.
  if (mandate.agentKey !== key.publicKey) return refuse('the buyer grant was issued to a different key');
  if (!isText(mandate.principal, 120)) return refuse('the buyer grant names no buyer');
  if (typeof mandate.scope !== 'string' || !isMandateScope(mandate.scope) || mandate.scope !== policy.scope) {
    return refuse('the buyer grant does not cover this kind of purchase');
  }
  if (!isCount(mandate.maxPerPayment) || intent.amount > mandate.maxPerPayment) {
    return refuse('the amount is over the buyer grant');
  }
  if (!isCount(mandate.expiresDay)) return refuse('the buyer grant has no expiry');
  if (!isText(mandate.signature, 200)) return refuse('the buyer grant is not signed');

  const envelope = signEnvelope({
    id: '',
    origin: 'agent',
    registryId: policy.registryId,
    mandate: {
      principal: mandate.principal,
      agentKey: key.publicKey,
      scope: mandate.scope,
      maxPerPayment: mandate.maxPerPayment as Cents,
      expiresDay: mandate.expiresDay,
      signature: mandate.signature,
    },
    intent: {
      amount: intent.amount as Cents,
      receiver: intent.receiver,
      reference: intent.reference,
      scope: policy.scope,
    },
    expiresAtMs,
    agentSecret: key.secret,
    nonce: c.nonce,
  });

  return { ok: true, publicKey: key.publicKey, signature: envelope.signature };
}

/**
 * Sign a nonce as this agent. The bytes are not a purchase, so the signature
 * cannot be submitted to the gate or to PayPal.
 */
export function signIdentityProof(input: unknown, key: KeyPair, policy: SignerPolicy, nowMs: number): SignResult {
  if (typeof input !== 'object' || input === null) return refuse('the challenge is not an object');
  const proof = input as { readonly [K in keyof IdentityProof]?: unknown };
  if (proof.kind !== PROOF_KIND) return refuse('this is not an identity proof');
  if (proof.registryId !== policy.registryId) return refuse(`this signer is ${policy.registryId}, not the agent named`);
  if (typeof proof.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(proof.nonce)) {
    return refuse('the challenge has no usable nonce');
  }
  if (!Number.isSafeInteger(proof.expiresAtMs)) return refuse('the challenge has no expiry');
  const expiresAtMs = proof.expiresAtMs as number;
  if (expiresAtMs <= nowMs) return refuse('the challenge has already expired');
  if (expiresAtMs > nowMs + 2 * 60 * 1_000) return refuse('an identity proof stays valid for two minutes at most');

  const signature = sign(
    identityProofBytes({ nonce: proof.nonce, registryId: policy.registryId, expiresAtMs }),
    key.secret,
  );
  return { ok: true, publicKey: key.publicKey, signature };
}

/* ---------- The gateway's side: asking a signer ---------- */

export interface SignerIdentity {
  readonly registryId: string;
  /** Ed25519 public key, base64url: the string the registry enrolls. */
  readonly publicKey: string;
}

/** The signer could not be asked at all. A refusal is not this: that is a `SignResult`. */
export class SignerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignerUnavailable';
  }
}

export interface SignerClient {
  /** Which agent the signer is, and its public key. Throws `SignerUnavailable`. */
  identity(): Promise<SignerIdentity>;
  /** Ask for one signature. Resolves with a refusal; throws `SignerUnavailable` when it cannot be asked. */
  sign(challenge: SigningChallenge): Promise<SignResult>;
  /** Ask the signer to sign a nonce. Not a purchase. */
  prove(proof: IdentityProof): Promise<SignResult>;
}

/** A signer in this process. For tests, where there is no second process to ask. */
export function localSigner(key: KeyPair, policy: SignerPolicy, now: () => number = Date.now): SignerClient {
  return {
    identity: async () => ({ registryId: policy.registryId, publicKey: key.publicKey }),
    sign: async (challenge) => signChallenge(challenge, key, policy, now()),
    prove: async (proof) => signIdentityProof(proof, key, policy, now()),
  };
}

const TIMEOUT_MS = 8_000;

/** The signer service, over HTTP on this machine. The token keeps other local processes from asking. */
export function httpSigner(options: {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}): SignerClient {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.url.replace(/\/+$/, '');

  async function call(path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(TIMEOUT_MS)
          : undefined;
      response = await doFetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new SignerUnavailable('The signer service did not answer.');
    }
    if (response.status === 401) throw new SignerUnavailable('The signer service refused this server’s token.');
    const parsed: unknown = await response.json().catch(() => null);
    if (parsed === null || typeof parsed !== 'object') {
      throw new SignerUnavailable(`The signer service answered HTTP ${response.status} without a result.`);
    }
    return parsed;
  }

  return {
    async identity() {
      const got = (await call('/identity')) as { registryId?: unknown; publicKey?: unknown };
      if (!isText(got.registryId, 64) || !isText(got.publicKey, 64)) {
        throw new SignerUnavailable('The signer service did not say which key it holds.');
      }
      return { registryId: got.registryId, publicKey: got.publicKey };
    },
    async sign(challenge) {
      return readSign(await call('/sign', challenge));
    },
    async prove(proof) {
      return readSign(await call('/prove', proof));
    },
  };

  function readSign(got: unknown): SignResult {
    const body = got as { ok?: unknown; publicKey?: unknown; signature?: unknown; error?: unknown };
    if (body.ok === true && isText(body.publicKey, 64) && isText(body.signature, 200)) {
      return { ok: true, publicKey: body.publicKey, signature: body.signature };
    }
    return { ok: false, error: isText(body.error, 200) ? body.error : 'the signer gave no reason' };
  }
}

/* ---------- The service's side: answering ---------- */

export interface SignerReply {
  readonly status: number;
  readonly body: unknown;
}

/** Compare two secrets without leaking, through timing, where they first differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Answer one request to the signer service.
 *
 * Plain values in, plain values out, so the whole of what the service does is
 * testable without a socket. A request from a web page carries an `Origin`;
 * the connector's never does, so anything with one is refused before the token
 * is even looked at.
 */
export function answerSigner(
  request: {
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
    readonly origin: string | null;
    readonly body: unknown;
  },
  service: { readonly key: KeyPair; readonly policy: SignerPolicy; readonly token: string; readonly now: () => number },
): SignerReply {
  if (request.origin !== null) return { status: 403, body: { ok: false, error: 'not for browsers' } };

  const presented = request.authorization?.startsWith('Bearer ') ? request.authorization.slice('Bearer '.length) : '';
  if (!sameSecret(presented, service.token)) return { status: 401, body: { ok: false, error: 'unauthorized' } };

  if (request.method === 'GET' && request.path === '/identity') {
    return { status: 200, body: { registryId: service.policy.registryId, publicKey: service.key.publicKey } };
  }
  if (request.method === 'POST' && request.path === '/sign') {
    const result = signChallenge(request.body, service.key, service.policy, service.now());
    return { status: result.ok ? 200 : 422, body: result };
  }
  if (request.method === 'POST' && request.path === '/prove') {
    const result = signIdentityProof(request.body, service.key, service.policy, service.now());
    return { status: result.ok ? 200 : 422, body: result };
  }
  return { status: 404, body: { ok: false, error: 'not found' } };
}
