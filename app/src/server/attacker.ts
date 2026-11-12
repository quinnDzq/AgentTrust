/**
 * Raven's attack book, as code.
 *
 * Every entry builds a *real* envelope with real keys — the demo counterparties
 * are simulated locally, so Raven can hold a stolen agent key and sign with it.
 * Nothing here knows what the gate checks; each attack simply does the dishonest
 * thing and the lamps decide. That is the point: if a new attack gets through,
 * it got through honestly.
 *
 * The clean builder at the top is the control. Every attack is one deviation
 * from it, which is what makes the duel lane readable — a card says which single
 * thing was wrong.
 *
 * `buildAttack` is pure given its arguments. It performs no IO, so the engine's
 * nightly raid is deterministic apart from the amounts.
 */

import { usd, type AttackKind, type Cents, type Envelope, type Intent, type Mandate, type MandateScope } from '../types.ts';
import { signEnvelope, signMandate, type KeyPair, type SecretKey } from './crypto.ts';
import type { Counterparty, Keyring } from './keys.ts';

/** How long a well-behaved envelope stays good. Short, because it can be. */
export const ENVELOPE_TTL_MS = 15 * 60 * 1_000;

export interface AttackInput {
  readonly kind: AttackKind;
  readonly requestId: string;
  readonly day: number;
  readonly nowMs: number;
  readonly keyring: Keyring;
  /** Where the money should really go, so a swap is visibly a swap. */
  readonly receiverOf: (principal: string) => string | null;
  /** A nonce the gate has already burned, for the replay attack. */
  readonly usedNonce: string | null;
  /** A reference already paid, for the duplicate attack. */
  readonly paidReference: string | null;
}

export interface Attempt {
  readonly envelope: Envelope;
  readonly principal: string;
  readonly amount: Cents;
  /** One line for the inbox and the duel lane. */
  readonly label: string;
  /** True for the lanes where a model read prose. Tints the inbox item. */
  readonly suspicious: boolean;
}

/* ---------- The cast, by name ---------- */

function find(keyring: Keyring, principal: string): Counterparty {
  const found = keyring.counterparties.find((c) => c.principal === principal);
  if (!found) throw new Error(`no counterparty "${principal}" in the keyring`);
  return found;
}

/** A grant the principal really signed. The honest starting point. */
function grantFor(
  party: Counterparty,
  over: { readonly scope?: MandateScope; readonly cap?: Cents; readonly expiresDay?: number } = {},
): Mandate {
  return signMandate(
    {
      principal: party.principal,
      agentKey: party.agentKey.publicKey,
      scope: over.scope ?? party.scope,
      maxPerPayment: over.cap ?? party.cap ?? usd(3_000),
      expiresDay: over.expiresDay ?? party.grantExpiresDay ?? 30,
    },
    party.principalKey.secret,
  );
}

const ask = (
  amount: Cents,
  receiver: string,
  reference: string,
  scope: MandateScope,
): Intent => ({ amount, receiver, reference, scope });

/* ---------- The builder ---------- */

/**
 * An honest request. Used as the control in the demo and as the base every
 * attack deviates from.
 */
export function buildClean(args: {
  readonly requestId: string;
  readonly principal: string;
  readonly amount: Cents;
  readonly reference: string;
  readonly nowMs: number;
  readonly keyring: Keyring;
  readonly receiver: string;
}): Attempt {
  const party = find(args.keyring, args.principal);
  const mandate = grantFor(party);

  return {
    envelope: signEnvelope({
      id: args.requestId,
      origin: 'agent',
      registryId: party.registryId,
      mandate,
      intent: ask(args.amount, args.receiver, args.reference, party.scope),
      expiresAtMs: args.nowMs + ENVELOPE_TTL_MS,
      agentSecret: party.agentKey.secret,
    }),
    principal: party.principal,
    amount: args.amount,
    label: `${party.principal} · ${args.reference}`,
    suspicious: false,
  };
}

/** An email-lane request: nothing signed, a stub grant, a model's reading. */
function emailLane(args: {
  readonly requestId: string;
  readonly principal: string;
  readonly amount: Cents;
  readonly receiver: string;
  readonly reference: string;
  readonly scope: MandateScope;
  readonly nowMs: number;
}): Envelope {
  return {
    id: args.requestId,
    origin: 'email',
    agent: { key: '', registryId: 'EMAIL' },
    // The stub the Envelope doc describes: a principal a model read out of
    // prose, and nothing else. The mandate lamp is skipped, not fed a lie.
    mandate: {
      principal: args.principal,
      agentKey: '',
      scope: args.scope,
      maxPerPayment: usd(0),
      expiresDay: 0,
      signature: '',
    },
    intent: ask(args.amount, args.receiver, args.reference, args.scope),
    nonce: `email-${args.requestId}`,
    expiresAtMs: args.nowMs + ENVELOPE_TTL_MS,
    signature: '',
  };
}

/**
 * An honest request that simply arrived as prose.
 *
 * Not an attack: a real vendor, the address we hold, a real invoice number.
 * It is here because the email lane is part of normal traffic rather than only
 * a thing attackers use, and because an unauthenticated request for a
 * non-trivial amount is exactly where the crew should disagree about what the
 * owner ought to do.
 */
export function buildEmailRequest(args: {
  readonly requestId: string;
  readonly principal: string;
  readonly amount: Cents;
  readonly reference: string;
  readonly receiver: string;
  readonly scope: MandateScope;
  readonly nowMs: number;
}): Attempt {
  return {
    envelope: emailLane(args),
    principal: args.principal,
    amount: args.amount,
    label: `Invoice ${args.reference} — ${args.principal}`,
    suspicious: false,
  };
}

/**
 * Build one attack.
 *
 * Each branch names the lamp it is aimed at, but nothing here enforces that —
 * the gate is the only thing that decides, and `src/rules.test.ts` is where the
 * claim is actually checked.
 */
export function buildAttack(input: AttackInput): Attempt {
  const { kind, requestId, nowMs, keyring, day } = input;
  const feedco = find(keyring, 'Feedco Ltd');
  const acme = find(keyring, 'Acme Logistics');
  const northwind = find(keyring, 'Northwind Hosting');
  const brightline = find(keyring, 'Brightline Media');

  const held = (principal: string): string => input.receiverOf(principal) ?? 'unknown@example';
  const ttl = nowMs + ENVELOPE_TTL_MS;

  const attempt = (
    envelope: Envelope,
    principal: string,
    amount: Cents,
    label: string,
    suspicious = false,
  ): Attempt => ({ envelope, principal, amount, label, suspicious });

  switch (kind) {
    /* Aimed at lamp 1 — identity. */

    case 'revoked_agent': {
      // Brightline's key is real and its signature is perfect. It was pulled.
      const amount = usd(420);
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: brightline.registryId,
          mandate: grantFor(brightline),
          intent: ask(amount, held(brightline.principal), 'BL-5567', brightline.scope),
          expiresAtMs: ttl,
          agentSecret: brightline.agentKey.secret,
        }),
        brightline.principal,
        amount,
        'Brightline Media · renewal BL-5567',
      );
    }

    case 'internal_key': {
      // Raven signing as itself. Worthless by construction.
      const amount = usd(2_900);
      const self: KeyPair = keyring.crew.raven;
      const mandate = signMandate(
        {
          principal: 'Feedco Ltd',
          agentKey: self.publicKey,
          scope: 'supplies',
          maxPerPayment: usd(5_000),
          expiresDay: 30,
        },
        self.secret,
      );
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: 'OVR-RAVEN',
          mandate,
          intent: ask(amount, held('Feedco Ltd'), 'FD-9001', 'supplies'),
          expiresAtMs: ttl,
          agentSecret: self.secret,
        }),
        'Feedco Ltd',
        amount,
        'Feedco Ltd · FD-9001 (self-signed)',
      );
    }

    case 'lookalike': {
      // VND-1l4, with a lowercase L where the one should be.
      const amount = usd(1_850);
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: 'VND-1l4',
          mandate: grantFor(feedco),
          intent: ask(amount, held(feedco.principal), 'FD-8830', feedco.scope),
          expiresAtMs: ttl,
          agentSecret: feedco.agentKey.secret,
        }),
        feedco.principal,
        amount,
        'Feedco Ltd · FD-8830 (VND-1l4)',
      );
    }

    /* Aimed at lamp 2 — the counterparty. */

    case 'receiver_swap': {
      // Cryptographically perfect, asking for a different address.
      const amount = usd(2_380);
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: feedco.registryId,
          mandate: grantFor(feedco),
          intent: ask(amount, 'accounts@feedco-billing.example', 'FD-8841', feedco.scope),
          expiresAtMs: ttl,
          agentSecret: feedco.agentKey.secret,
        }),
        feedco.principal,
        amount,
        'Feedco Ltd · FD-8841 "new bank details"',
      );
    }

    case 'injection': {
      // The endgame of every prompt injection: pay somewhere else. Whatever the
      // prose said, the address still has to match the one we hold.
      const amount = usd(280);
      return attempt(
        emailLane({
          requestId,
          principal: 'Northwind Hosting',
          amount,
          receiver: 'billing@northwind-invoices.example',
          reference: 'NW-7741',
          scope: northwind.scope,
          nowMs,
        }),
        northwind.principal,
        amount,
        'URGENT: updated remittance — Northwind',
        true,
      );
    }

    /* Aimed at lamp 3 — the grant. */

    case 'mandate_edited': {
      // The cap is raised in the grant and the envelope is re-signed around it.
      // The agent half verifies; the principal's half does not.
      const amount = usd(7_400);
      const forged: Mandate = { ...grantFor(feedco), maxPerPayment: usd(99_000) };
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: feedco.registryId,
          mandate: forged,
          intent: ask(amount, held(feedco.principal), 'FD-8852', feedco.scope),
          expiresAtMs: ttl,
          agentSecret: feedco.agentKey.secret,
        }),
        feedco.principal,
        amount,
        'Feedco Ltd · FD-8852 (raised grant)',
      );
    }

    case 'scope_confusion': {
      // A hosting grant used to request a payout.
      const amount = usd(1_600);
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: northwind.registryId,
          mandate: grantFor(northwind, { scope: 'hosting' }),
          intent: ask(amount, held(northwind.principal), 'NW-7750', 'payout'),
          expiresAtMs: ttl,
          agentSecret: northwind.agentKey.secret,
        }),
        northwind.principal,
        amount,
        'Northwind Hosting · NW-7750 (payout)',
      );
    }

    case 'over_mandate': {
      // More than the principal itself allowed. Nobody here can consent for it.
      const amount = usd(4_800);
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: acme.registryId,
          mandate: grantFor(acme, { cap: usd(1_500) }),
          intent: ask(amount, held(acme.principal), 'AC-3312', acme.scope),
          expiresAtMs: ttl,
          agentSecret: acme.agentKey.secret,
        }),
        acme.principal,
        amount,
        'Acme Logistics · AC-3312 (over grant)',
      );
    }

    case 'confused_deputy': {
      // Feedco's agent key presenting Acme's genuine grant.
      const amount = usd(1_950);
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: feedco.registryId,
          mandate: grantFor(acme),
          intent: ask(amount, held(acme.principal), 'AC-3320', acme.scope),
          expiresAtMs: ttl,
          agentSecret: feedco.agentKey.secret,
        }),
        acme.principal,
        amount,
        'Acme Logistics · AC-3320 (via Feedco’s agent)',
      );
    }

    /* Aimed at lamp 4 — binding. */

    case 'replay': {
      // A real past envelope, presented again with its nonce intact.
      const amount = usd(1_240);
      const nonce = input.usedNonce ?? 'nonce-already-burned';
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: feedco.registryId,
          mandate: grantFor(feedco),
          intent: ask(amount, held(feedco.principal), 'FD-8812', feedco.scope),
          expiresAtMs: ttl,
          agentSecret: feedco.agentKey.secret,
          nonce,
        }),
        feedco.principal,
        amount,
        'Feedco Ltd · FD-8812 (replayed)',
      );
    }

    case 'expired': {
      const amount = usd(990);
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: acme.registryId,
          mandate: grantFor(acme),
          intent: ask(amount, held(acme.principal), 'AC-3301', acme.scope),
          expiresAtMs: nowMs - 60_000,
          agentSecret: acme.agentKey.secret,
        }),
        acme.principal,
        amount,
        'Acme Logistics · AC-3301 (stale)',
      );
    }

    /* Aimed at lamp 5 — our policy. */

    case 'duplicate_reference': {
      const amount = usd(1_200);
      const reference = input.paidReference ?? 'FD-8800';
      return attempt(
        signEnvelope({
          id: requestId,
          origin: 'agent',
          registryId: feedco.registryId,
          mandate: grantFor(feedco),
          intent: ask(amount, held(feedco.principal), reference, feedco.scope),
          expiresAtMs: ttl,
          agentSecret: feedco.agentKey.secret,
        }),
        feedco.principal,
        amount,
        `Feedco Ltd · ${reference} (second time)`,
      );
    }

    default: {
      // Exhaustive: a new attack kind must be built before it compiles.
      const unreachable: never = kind;
      throw new Error(`no builder for attack ${String(unreachable)} on day ${day}`);
    }
  }
}

/**
 * The nightly roster.
 *
 * Ordered so the first nights show the attacks whose lamp is easiest to read,
 * and the later ones show the subtle chain attacks. A judge watching from day 1
 * sees the gate get harder to fool, not noisier.
 */
export const RAID_SCHEDULE: readonly (readonly AttackKind[])[] = [
  ['receiver_swap'],
  ['revoked_agent', 'injection'],
  ['mandate_edited'],
  ['scope_confusion', 'replay'],
  ['confused_deputy'],
  ['over_mandate', 'lookalike'],
  ['internal_key', 'expired'],
  ['duplicate_reference'],
];

/**
 * Every attack, in one ordered list.
 *
 * The demo button walks this rather than picking at random, so pressing it
 * repeatedly shows a different lamp each time instead of the same one twice.
 */
export const ATTACK_KINDS: readonly AttackKind[] = RAID_SCHEDULE.flat();

/** Which attacks run on `day`. Wraps, so the duel never runs out. */
export function raidFor(day: number): readonly AttackKind[] {
  const index = Math.max(0, day - 2) % RAID_SCHEDULE.length;
  return RAID_SCHEDULE[index] ?? [];
}

export type { SecretKey };
