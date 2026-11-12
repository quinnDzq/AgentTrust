/**
 * Canonical bytes: the exact string that gets signed.
 *
 * Every signature in Overduel is over the output of this file and nothing else.
 * Two properties matter, and both are why this is hand-rolled rather than
 * `JSON.stringify`:
 *
 *   1. **Unambiguous.** Every key and value is length-prefixed, so no value can
 *      forge a field boundary. A receiver of `a=1&b` cannot be re-read as two
 *      fields, because the length says it is one. `JSON.stringify` is not safe
 *      here: key order is insertion order, and unicode escaping differs between
 *      implementations, so the same intent can serialise two ways.
 *
 *   2. **Domain-separated.** Each kind of signed object has its own prefix, so
 *      a mandate signature can never be replayed as an intent signature even
 *      if the fields happen to line up.
 *
 * An intent's bytes embed the *whole* canonical mandate rather than a hash of
 * it. That binds a request to the exact grant it was made under, and it keeps
 * this file pure: no hashing, no crypto, no Node. It is imported by the browser
 * bundle and by the tests, and it never touches a key.
 *
 * The format is frozen. Changing it invalidates every signature ever made, so
 * a change means a new domain string (`.../v2`), never an edit to v1.
 */

import { LEVELS, ORIGINS, type Cents, type Intent, type Mandate, type Policy } from './types.ts';

/* ---------- The encoder ---------- */

type Field = readonly [key: string, value: string];

/**
 * `domain|count|len:key=len:value&len:key=len:value…`
 *
 * Field order is the order given, never sorted: the caller lists them
 * explicitly so the shape is readable at the call site and a reordering is a
 * visible diff rather than a silent re-encoding.
 */
function canonical(domain: string, fields: readonly Field[]): string {
  const body = fields.map(([k, v]) => `${k.length}:${k}=${v.length}:${v}`).join('&');
  return `${domain}|${fields.length}|${body}`;
}

/** An integer, as text. Throws rather than sign a float or a NaN. */
function int(n: number): string {
  if (!Number.isInteger(n)) {
    throw new RangeError(`canonical bytes need an integer, got ${n}`);
  }
  return String(n);
}

const money = (c: Cents): string => int(c);

/* ---------- The signed objects ---------- */

export const MANDATE_DOMAIN = 'overduel/v1/mandate';
export const INTENT_DOMAIN = 'overduel/v1/intent';
export const POLICY_DOMAIN = 'overduel/v1/policy';
/** A nonce the signer signs to prove it holds the enrolled key. Not a payment. */
export const IDENTITY_DOMAIN = 'agenttrust/v1/identity-proof';

/**
 * A principal's grant to one of its agents, as the principal signed it.
 *
 * Signed by the *principal*, so raising `maxPerPayment` or widening `scope`
 * after the fact breaks the signature. This is the half of the chain the
 * counterparty's own key cannot forge.
 */
/**
 * Bytes for one identity proof: a nonce, which agent, and when it expires.
 *
 * A different domain from a payment, so this signature cannot be spent.
 */
export function identityProofBytes(proof: {
  readonly nonce: string;
  readonly registryId: string;
  readonly expiresAtMs: number;
}): string {
  return canonical(IDENTITY_DOMAIN, [
    ['nonce', proof.nonce],
    ['registryId', proof.registryId],
    ['expiresAtMs', int(proof.expiresAtMs)],
  ]);
}

export function mandateBytes(mandate: Omit<Mandate, 'signature'>): string {
  return canonical(MANDATE_DOMAIN, [
    ['principal', mandate.principal],
    ['agentKey', mandate.agentKey],
    ['scope', mandate.scope],
    ['maxPerPayment', money(mandate.maxPerPayment)],
    ['expiresDay', int(mandate.expiresDay)],
  ]);
}

/**
 * One payment request, as the counterparty's agent signed it.
 *
 * The mandate is embedded whole, so a valid signature proves the agent asked
 * for *this* amount, to *this* receiver, under *this* grant. Swapping the
 * receiver, editing the amount, or pairing the request with a different
 * mandate all break it.
 *
 * `nonce` and `expiresAtMs` are inside the signature, which is what makes a
 * replay detectable rather than merely unlikely.
 */
export function intentBytes(args: {
  readonly intent: Intent;
  readonly mandate: Mandate;
  readonly nonce: string;
  readonly expiresAtMs: number;
}): string {
  const { intent, mandate, nonce, expiresAtMs } = args;
  return canonical(INTENT_DOMAIN, [
    ['amount', money(intent.amount)],
    ['receiver', intent.receiver],
    ['reference', intent.reference],
    ['scope', intent.scope],
    ['nonce', nonce],
    ['expiresAtMs', int(expiresAtMs)],
    // The grant, in full. Binds the request to one specific mandate.
    ['mandate', mandateBytes(mandate)],
  ]);
}

/**
 * The owner's own mandate to the crew: the caps the gate enforces.
 *
 * Signed so that a tampered database row is detectable. `gate()` is handed the
 * policy as plain data; whether its signature verified is the engine's job to
 * establish before calling.
 */
export function policyBytes(policy: Omit<Policy, 'signature'>): string {
  return canonical(POLICY_DOMAIN, [
    ['expiresDay', int(policy.expiresDay)],
    ['dailyTotal', money(policy.dailyTotal)],
    ['telegramCap', money(policy.telegramCap)],
    // Iterated over the frozen `LEVELS` and `ORIGINS` lists rather than
    // `Object.keys`, so the field order is fixed by the source and not by how
    // the object happened to be built.
    ...LEVELS.map((l): Field => [`perPayment.${l}`, money(policy.perPayment[l])]),
    ...ORIGINS.map((o): Field => [`originCeiling.${o}`, money(policy.originCeiling[o])]),
  ]);
}
