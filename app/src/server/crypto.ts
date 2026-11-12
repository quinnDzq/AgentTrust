/**
 * Ed25519 keys, signing and verification.
 *
 * The only file that touches a private key. `gate()` never calls in here — it
 * is handed booleans. The engine's collector calls `verifyEnvelope` once per
 * request and puts the results in `GateContext`, which is what keeps the
 * authorisation surface pure and testable without a key.
 *
 * Keys are carried as base64url JWK coordinates rather than PEM: `x` is the
 * 32-byte public key and `d` the private seed, both single-line, both safe in
 * JSON and in an environment variable. A public key *is* its string, which is
 * what the agent registry publishes.
 *
 * The one rule in here that matters: **`verify` never throws.** Every argument
 * to it came from an attacker, so a malformed signature, a truncated key or a
 * non-base64 blob has to come back `false`. A thrown exception on that path
 * would turn a blocked payment into a 500 and take the gate offline, which is
 * a denial of service with extra steps.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import { intentBytes, mandateBytes, policyBytes } from '../canon.ts';
import type { Envelope, Intent, Mandate, Origin, Policy } from '../types.ts';

/* ---------- Keys ---------- */

/** A private key: the seed `d`, plus the public `x` it belongs to. */
export interface SecretKey {
  readonly d: string;
  readonly x: string;
}

export interface KeyPair {
  /** base64url, 32 bytes. This is the string the registry publishes. */
  readonly publicKey: string;
  readonly secret: SecretKey;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as { x?: string };
  const priv = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string };

  if (!pub.x || !priv.d) throw new Error('ed25519 key export did not produce JWK coordinates');

  return { publicKey: pub.x, secret: { d: priv.d, x: pub.x } };
}

/** A short, stable label for a key. For display only — never compared. */
export function fingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 8);
}

/** A fresh nonce. One use, and the gate remembers it forever. */
export function newNonce(): string {
  return randomBytes(12).toString('base64url');
}

/* ---------- Signing ---------- */

function privateKeyOf(secret: SecretKey) {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: secret.d, x: secret.x },
    format: 'jwk',
  });
}

export function sign(message: string, secret: SecretKey): string {
  return nodeSign(null, Buffer.from(message, 'utf8'), privateKeyOf(secret)).toString('base64url');
}

/**
 * Verify `signature` over `message` under `publicKey`.
 *
 * Returns `false` for anything that is not a good signature, including
 * garbage: see the note at the top of this file. There is deliberately no
 * variant of this that throws.
 */
export function verify(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    });
    return nodeVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/* ---------- The signed objects ---------- */

/** Issue a grant, signed by the principal. */
export function signMandate(
  fields: Omit<Mandate, 'signature'>,
  principalSecret: SecretKey,
): Mandate {
  return { ...fields, signature: sign(mandateBytes(fields), principalSecret) };
}

/** Sign the owner's policy. Only the owner's key may. */
export function signPolicy(fields: Omit<Policy, 'signature'>, ownerSecret: SecretKey): Policy {
  return { ...fields, signature: sign(policyBytes(fields), ownerSecret) };
}

/** Build a payment request, signed by a counterparty's agent over the intent. */
export function signEnvelope(args: {
  readonly id: string;
  readonly origin: Origin;
  readonly registryId: string;
  readonly mandate: Mandate;
  readonly intent: Intent;
  readonly expiresAtMs: number;
  readonly agentSecret: SecretKey;
  readonly nonce?: string;
}): Envelope {
  const nonce = args.nonce ?? newNonce();
  const bytes = intentBytes({
    intent: args.intent,
    mandate: args.mandate,
    nonce,
    expiresAtMs: args.expiresAtMs,
  });

  return {
    id: args.id,
    origin: args.origin,
    agent: { key: args.agentSecret.x, registryId: args.registryId },
    mandate: args.mandate,
    intent: args.intent,
    nonce,
    expiresAtMs: args.expiresAtMs,
    signature: sign(bytes, args.agentSecret),
  };
}

/* ---------- The collector's half ---------- */

/** What verification established. Every field lands in `GateContext`. */
export interface Verification {
  readonly agentSigValid: boolean;
  readonly mandateSigValid: boolean;
  readonly intentBound: boolean;
}

/**
 * Check both signatures on an envelope.
 *
 * `agentSigValid` and `intentBound` are the same cryptographic fact looked at
 * from two sides, and both are reported because the lamps ask different
 * questions of it: lamp 1 asks "is this really that agent", lamp 4 asks "does
 * what it signed match what it is asking for". A signature that verifies under
 * the registry's key but over *different* bytes than this intent means the
 * envelope was edited in flight, which is binding, not identity.
 *
 * `principalKey` is null when we hold no record for the claimed principal. The
 * counterparty lamp reports that, and it runs before the mandate lamp — so a
 * `mandateSigValid: false` here is never the first thing the owner is told.
 */
export function verifyEnvelope(
  env: Envelope,
  registryKey: string | null,
  principalKey: string | null,
): Verification {
  const bytes = intentBytes({
    intent: env.intent,
    mandate: env.mandate,
    nonce: env.nonce,
    expiresAtMs: env.expiresAtMs,
  });

  // Identity: does the signature verify under the key the *registry* holds for
  // this agent, over any bytes at all? Checked against the registry's key and
  // not the envelope's own claim, so swapping `agent.key` proves nothing.
  const agentSigValid = registryKey !== null && verify(registryKey, bytes, env.signature);

  const mandateSigValid =
    principalKey !== null && verify(principalKey, mandateBytes(env.mandate), env.mandate.signature);

  // Binding: the key the envelope itself presents, over exactly these bytes.
  // Together with the identity check above, a mismatch between the two means
  // the envelope was altered after signing.
  const intentBound = verify(env.agent.key, bytes, env.signature);

  return { agentSigValid, mandateSigValid, intentBound };
}

/** Verify the owner's policy row against the owner's public key. */
export function verifyPolicy(policy: Policy, ownerKey: string): boolean {
  const { signature, ...fields } = policy;
  return verify(ownerKey, policyBytes(fields), signature);
}
