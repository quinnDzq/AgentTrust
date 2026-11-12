/**
 * The attack book.
 *
 * `gate()` is pure, so this file is the entire authorisation surface of the
 * app: no keys, no database, no clock, no model. Every attack Raven can build
 * is a one-field mutation of the clean envelope below, and every one of them
 * must be blocked by a named lamp.
 *
 * The honest exception is stated at the bottom: a perfectly stolen key making
 * a perfectly in-mandate request to the address we already hold is
 * indistinguishable from the real counterparty, and it clears. Revocation and
 * the anomaly band are the answers to that, not the gate.
 */

import { describe, expect, test } from 'bun:test';
import {
  anomalyBand,
  award,
  canApproveFrom,
  capsFor,
  DEFAULT_POLICY,
  gate,
  MAX_TIER,
  TIER_NEXT,
  TRUST,
} from './rules.ts';
import {
  LAMPS,
  ORIGINS,
  usd,
  type Cents,
  type Decision,
  type Envelope,
  type GateContext,
  type Intent,
  type Level,
  type Mandate,
  type Origin,
  type Policy,
  type ScamFlag,
  type VendorRecord,
} from './types.ts';

/* ---------- The clean request everything else is a mutation of ---------- */

const NOW = 1_700_000_000_000;
const DAY = 12;

const POLICY: Policy = { ...DEFAULT_POLICY, signature: 'sig-policy' };

const FEEDCO: VendorRecord = {
  principal: 'Feedco Ltd',
  receiver: 'pay@feedco.example',
  principalKey: 'PUB-FEEDCO',
  paidCount: 12,
  maxPaid: usd(2_400),
  meanPaid: usd(1_200),
};

const GRANT: Mandate = {
  principal: 'Feedco Ltd',
  agentKey: 'KEY-FEEDCO',
  scope: 'supplies',
  maxPerPayment: usd(3_000),
  expiresDay: 19,
  signature: 'sig-mandate',
};

const ASK: Intent = {
  amount: usd(1_200),
  receiver: 'pay@feedco.example',
  reference: 'INV-8812',
  scope: 'supplies',
};

interface EnvPatch {
  readonly origin?: Origin;
  readonly agentKey?: string;
  readonly registryId?: string;
  readonly mandate?: Partial<Mandate>;
  readonly intent?: Partial<Intent>;
  readonly nonce?: string;
  readonly expiresAtMs?: number;
  readonly signature?: string;
}

function envelope(patch: EnvPatch = {}): Envelope {
  return {
    id: 'R-1',
    origin: patch.origin ?? 'agent',
    agent: {
      key: patch.agentKey ?? 'KEY-FEEDCO',
      registryId: patch.registryId ?? 'VND-114',
    },
    mandate: { ...GRANT, ...patch.mandate },
    intent: { ...ASK, ...patch.intent },
    nonce: patch.nonce ?? 'nonce-001',
    expiresAtMs: patch.expiresAtMs ?? NOW + 60_000,
    signature: patch.signature ?? 'sig-envelope',
  };
}

function context(patch: Partial<GateContext> = {}): GateContext {
  return {
    paused: false,
    nowMs: NOW,
    day: DAY,
    intake: 'pip',
    tier: 4,
    registry: 'active',
    registryPrincipal: 'Feedco Ltd',
    agentSigValid: true,
    mandateSigValid: true,
    intentBound: true,
    nonceSeen: false,
    counterparty: FEEDCO,
    duplicateOf: null,
    paidToday: usd(0),
    policy: POLICY,
    policySigValid: true,
    flags: [],
    ...patch,
  };
}

/** The clean request clears, so every failure below is the mutation's fault. */
test('a clean signed agent request clears all five lamps', () => {
  const ruling = gate(envelope(), context());

  expect(ruling.verdict).toBe('ALLOW');
  expect(ruling.checks).toHaveLength(LAMPS.length);
  expect(ruling.checks.every((c) => c.outcome === 'pass')).toBe(true);
  // ALLOW has no `reason` field at all, by construction.
  expect('reason' in ruling).toBe(false);
});

/* ---------- Lamp 1: agent identity ---------- */

describe('lamp 1 — agent identity', () => {
  test('an unknown registry id is denied', () => {
    const ruling = gate(envelope({ registryId: 'VND-l14' }), context({ registry: 'unknown' }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('AGENT_IDENTITY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('not in the agent registry');
  });

  test('a revoked agent presenting an old valid signature is denied', () => {
    const ruling = gate(envelope(), context({ registry: 'revoked' }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('AGENT_IDENTITY');
  });

  test('one of our own keys can never authorise a payment', () => {
    // Raven signing with its own key. The only thing it can reach is this lamp.
    const ruling = gate(
      envelope({ agentKey: 'KEY-RAVEN', registryId: 'OVR-RAVEN' }),
      context({ registry: 'internal', registryPrincipal: null }),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('AGENT_IDENTITY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('our own keys');
  });

  test("a forged signature on a real registry id is denied", () => {
    const ruling = gate(envelope(), context({ agentSigValid: false }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('AGENT_IDENTITY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('does not verify');
  });
});

/* ---------- Lamp 3: the mandate chain ---------- */

describe('lamp 3 — mandate chain', () => {
  test('a mandate edited after the principal signed it is denied', () => {
    // Raven raised maxPerPayment. The principal's signature no longer covers it.
    const ruling = gate(
      envelope({ mandate: { maxPerPayment: usd(50_000) } }),
      context({ mandateSigValid: false }),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('MANDATE');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('does not verify');
  });

  test('a grant issued to a different key is denied', () => {
    const ruling = gate(envelope({ mandate: { agentKey: 'KEY-SOMEONE-ELSE' } }), context());

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('MANDATE');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('different key');
  });

  test('the confused deputy — real agent, real grant, wrong principal — is denied', () => {
    // Acme is a vendor we know, and the grant from Acme is genuine, so the
    // counterparty lamp is satisfied. But our registry says the key that
    // signed the envelope acts for Feedco. Only comparing the two catches it.
    const acme: VendorRecord = {
      principal: 'Acme Logistics',
      receiver: 'ap@acme.example',
      principalKey: 'PUB-ACME',
      paidCount: 4,
      maxPaid: usd(2_000),
      meanPaid: usd(1_500),
    };
    const ruling = gate(
      envelope({
        mandate: { principal: 'Acme Logistics' },
        intent: { receiver: 'ap@acme.example' },
      }),
      context({ registryPrincipal: 'Feedco Ltd', counterparty: acme }),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('MANDATE');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('acts for Feedco Ltd');
  });

  test('a lapsed grant is denied', () => {
    const ruling = gate(envelope({ mandate: { expiresDay: DAY - 1 } }), context());

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('MANDATE');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('lapsed on day 11');
  });

  test('a grant lasts through its expiry day, not up to it', () => {
    const ruling = gate(envelope({ mandate: { expiresDay: DAY } }), context());

    expect(ruling.verdict).toBe('ALLOW');
  });

  test('scope confusion — a supplies grant used for a payout — is denied', () => {
    const ruling = gate(
      envelope({ intent: { scope: 'payout' }, mandate: { scope: 'supplies' } }),
      context(),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('MANDATE');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('the ask is payout');
  });

  test("a request over the principal's own cap is denied, not escalated", () => {
    // The principal said $3,000. Nobody on our side can consent on its behalf,
    // so this is a contradiction rather than a judgment call.
    const ruling = gate(envelope({ intent: { amount: usd(3_001) } }), context());

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('MANDATE');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('Feedco Ltd granted');
  });
});

/* ---------- Lamp 4: intent binding ---------- */

describe('lamp 4 — intent binding', () => {
  test('an amount edited after signing is denied', () => {
    // The receiver is left alone on purpose: a swapped address never reaches
    // this lamp, because the counterparty lamp runs first and has our own
    // record to compare against. What is left for this lamp is tampering the
    // records cannot see — an amount or a reference raised after signing.
    const ruling = gate(
      envelope({ intent: { amount: usd(2_900) } }),
      context({ intentBound: false }),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('INTENT_BINDING');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('does not cover');
  });

  test('a replayed envelope is denied', () => {
    const ruling = gate(envelope(), context({ nonceSeen: true }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('INTENT_BINDING');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('used before');
  });

  test('an expired envelope is denied', () => {
    const ruling = gate(envelope({ expiresAtMs: NOW - 1 }), context());

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('INTENT_BINDING');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('expired');
  });

  test('an envelope is still good on the millisecond it expires', () => {
    expect(gate(envelope({ expiresAtMs: NOW }), context()).verdict).toBe('ALLOW');
  });
});

/* ---------- Lamp 2: the counterparty ---------- */

describe('lamp 2 — counterparty', () => {
  test('a principal we hold no record for is denied', () => {
    const ruling = gate(
      envelope({ mandate: { principal: 'Nobody We Know' } }),
      context({ registryPrincipal: 'Nobody We Know', counterparty: null }),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('COUNTERPARTY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('not a vendor we hold');
  });

  test('"our bank details changed" is denied even when every signature verifies', () => {
    // This is the whole point of the gate. The request is cryptographically
    // perfect: Feedco's own agent, under a live grant, correctly bound. It
    // simply asks for a different address than the one we hold.
    const ruling = gate(
      envelope({ intent: { receiver: 'newaccount@feedco-billing.example' } }),
      context(),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('COUNTERPARTY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('we hold pay@feedco.example');
  });
});

/* ---------- Lamp 5: the owner's policy ---------- */

describe('lamp 5 — owner policy', () => {
  test('a reference we have already paid is denied', () => {
    const ruling = gate(envelope(), context({ duplicateOf: 'R-0412' }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('OUR_POLICY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('already paid as R-0412');
  });

  test('a tampered policy row stops everything', () => {
    const ruling = gate(envelope(), context({ policySigValid: false }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('OUR_POLICY');
  });

  test('where quotes are kept, a reference the merchant never quoted is denied', () => {
    const ruling = gate(envelope(), context({ quote: null }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('OUR_POLICY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('not an open quote');
  });

  test('where quotes are kept, any price but the quoted one is denied', () => {
    const ruling = gate(envelope(), context({ quote: usd(1_100) }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('not the merchant');
  });

  test('the quoted price clears, and no quote at all means no quote check', () => {
    expect(gate(envelope(), context({ quote: usd(1_200) })).verdict).toBe('ALLOW');
    expect(gate(envelope(), context()).verdict).toBe('ALLOW');
  });

  test('a grant’s budget is the limit: vendor history does not ask, and past it is refused', () => {
    const fresh = { ...FEEDCO, maxPaid: usd(0), paidCount: 0, meanPaid: usd(0) };
    const within = gate(envelope(), context({ quote: usd(1_200), counterparty: fresh }));
    expect(within.verdict).toBe('ALLOW');
    expect(within.checks.find((check) => check.check === 'OUR_POLICY')?.note).toBe(
      'within the approved $6,000 budget ($6,000 left)',
    );

    const over = gate(envelope(), context({ quote: usd(1_200), counterparty: fresh, paidToday: usd(5_500) }));
    expect(over.verdict).toBe('DENY');
    expect(over.verdict === 'DENY' && over.reason).toBe('would exceed budget: $5,500 spent, $500 left');
  });

  test('the ask threshold asks for a large purchase or the first crossing, and an over-budget amount is still refused', () => {
    const half = gate(envelope(), context({ quote: usd(1_200), askThresholdPct: 50, policy: { ...POLICY, dailyTotal: usd(2_400) } }));
    expect(half.verdict).toBe('ALLOW');

    const large = gate(envelope(), context({ quote: usd(1_200), askThresholdPct: 50, policy: { ...POLICY, dailyTotal: usd(2_000) } }));
    expect(large.verdict).toBe('ASK_OWNER');
    expect(large.verdict === 'ASK_OWNER' && large.reason).toBe(
      '$1,200 is 60% of your $2,000 budget, over your 50% ask threshold, buyer confirmation needed',
    );

    const crosses = gate(
      envelope(),
      context({ quote: usd(1_200), askThresholdPct: 50, paidToday: usd(2_500) }),
    );
    expect(crosses.verdict).toBe('ASK_OWNER');
    expect(crosses.verdict === 'ASK_OWNER' && crosses.reason).toBe(
      '$1,200 would take spending to $3,700, 62% of your $6,000 budget, over your 50% ask threshold, buyer confirmation needed',
    );

    const alreadyPast = gate(
      envelope(),
      context({ quote: usd(1_200), askThresholdPct: 50, paidToday: usd(4_000) }),
    );
    expect(alreadyPast.verdict).toBe('ALLOW');

    const overBudget = gate(
      envelope(),
      context({ quote: usd(1_200), askThresholdPct: 50, paidToday: usd(5_500) }),
    );
    expect(overBudget.verdict).toBe('DENY');
    expect(overBudget.verdict === 'DENY' && overBudget.reason).toBe('would exceed budget: $5,500 spent, $500 left');
  });

  test("a lapsed owner authority stops everything", () => {
    const ruling = gate(
      envelope(),
      context({ policy: { ...POLICY, expiresDay: DAY - 1 } }),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('OUR_POLICY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('lapsed on day 11');
  });

  test('over the tier cap asks the owner rather than denying', () => {
    // Tier 2 clears $600. A sound $1,200 request is a question, not a lie.
    const ruling = gate(envelope(), context({ tier: 2 }));

    expect(ruling.verdict).toBe('ASK_OWNER');
    expect(ruling.check).toBe('OUR_POLICY');
    expect(ruling.verdict === 'ASK_OWNER' && ruling.reason).toContain('tier 2 clears alone');
  });

  test("over today's total asks the owner", () => {
    const ruling = gate(envelope(), context({ paidToday: usd(5_500) }));

    expect(ruling.verdict).toBe('ASK_OWNER');
    expect(ruling.verdict === 'ASK_OWNER' && ruling.reason).toContain("today's");
  });

  test('an amount unusual for this vendor asks the owner', () => {
    // A vendor we have only ever paid $300 has a $600 band. $900 is inside
    // every cap and still worth a human glance.
    const ruling = gate(
      envelope({ intent: { amount: usd(900) } }),
      context({ tier: 5, counterparty: { ...FEEDCO, maxPaid: usd(300), paidCount: 1 } }),
    );

    expect(ruling.verdict).toBe('ASK_OWNER');
    expect(ruling.verdict === 'ASK_OWNER' && ruling.reason).toContain('unusual for Feedco Ltd');
  });

  test('over the origin ceiling asks the owner', () => {
    // The grant and the vendor's history both allow it; our own ceiling does not.
    const ruling = gate(
      envelope({ intent: { amount: usd(4_200) }, mandate: { maxPerPayment: usd(10_000) } }),
      context({ tier: 5, counterparty: { ...FEEDCO, maxPaid: usd(9_000) } }),
    );

    expect(ruling.verdict).toBe('ASK_OWNER');
    expect(ruling.verdict === 'ASK_OWNER' && ruling.reason).toContain('ceiling on the agent lane');
  });
});

/* ---------- Origins: authentication is graded ---------- */

describe('origins', () => {
  test('the origin ceilings are ordered — a weaker lane can never clear more', () => {
    // The safety of skipping lamps rests entirely on this, so it is asserted
    // rather than assumed.
    expect(POLICY.originCeiling.agent).toBeGreaterThanOrEqual(POLICY.originCeiling.portal);
    expect(POLICY.originCeiling.portal).toBeGreaterThanOrEqual(POLICY.originCeiling.email);
  });

  test('a portal request clears without a mandate, and the mandate is genuinely not read', () => {
    // The grant here is expired, unsigned and issued to another key. If the
    // mandate lamp were running, every one of those would block it.
    const ruling = gate(
      envelope({
        origin: 'portal',
        intent: { amount: usd(1_200) },
        mandate: { expiresDay: 1, agentKey: 'KEY-NOBODY', signature: '' },
      }),
      context({ mandateSigValid: false }),
    );

    expect(ruling.verdict).toBe('ALLOW');
    expect(ruling.checks.find((c) => c.check === 'MANDATE')?.outcome).toBe('skip');
  });

  test('an email request clears only small, and only to an address we already hold', () => {
    // Nothing is authenticated on this lane: no registry entry, no signature,
    // no grant. It can still pay — up to $300, to the receiver on file.
    const ruling = gate(
      envelope({ origin: 'email', intent: { amount: usd(300) } }),
      context({ registry: 'unknown', agentSigValid: false, mandateSigValid: false, intentBound: false }),
    );

    expect(ruling.verdict).toBe('ALLOW');
    expect(ruling.checks.filter((c) => c.outcome === 'skip').map((c) => c.check)).toEqual([
      'AGENT_IDENTITY',
      'MANDATE',
      'INTENT_BINDING',
    ]);
  });

  test('an email request over $300 asks the owner', () => {
    const ruling = gate(
      envelope({ origin: 'email', intent: { amount: usd(301) } }),
      context({ registry: 'unknown', agentSigValid: false }),
    );

    expect(ruling.verdict).toBe('ASK_OWNER');
    expect(ruling.verdict === 'ASK_OWNER' && ruling.reason).toContain('email lane');
  });

  test('injected prose cannot redirect money: the receiver lamp does not read prose', () => {
    // The endgame of a prompt injection is always "pay somewhere else". Whatever
    // the email said, the address has to match the one we hold.
    const ruling = gate(
      envelope({
        origin: 'email',
        intent: { amount: usd(200), receiver: 'attacker@not-feedco.example' },
      }),
      context({ registry: 'unknown' }),
    );

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('COUNTERPARTY');
  });

  test('every origin is covered by the answer table', () => {
    for (const origin of ORIGINS) {
      const ruling = gate(envelope({ origin, intent: { amount: usd(100) } }), context());
      expect(ruling.checks).toHaveLength(LAMPS.length);
    }
  });
});

/* ---------- Precedence and reporting ---------- */

describe('precedence', () => {
  test('the first failing lamp in order is the one cited', () => {
    // Revoked *and* a duplicate reference. Lamp 1 gets the citation.
    const ruling = gate(envelope(), context({ registry: 'revoked', duplicateOf: 'R-0001' }));

    expect(ruling.check).toBe('AGENT_IDENTITY');
  });

  test('a failure beats a question', () => {
    const ruling = gate(envelope(), context({ tier: 1, registry: 'revoked' }));

    expect(ruling.verdict).toBe('DENY');
  });

  test('every ruling reports all five lamps, in lamp order', () => {
    const ruling = gate(envelope(), context({ registry: 'revoked' }));

    expect(ruling.checks.map((c) => c.check)).toEqual([...LAMPS]);
  });

  test('a paused crew denies everything and reports no lamp as run', () => {
    const ruling = gate(envelope(), context({ paused: true }));

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('PAUSED');
    expect(ruling.checks.every((c) => c.outcome === 'skip')).toBe(true);
  });
});

/* ---------- The skeptic is advisory ---------- */

test('scam flags never change a verdict', () => {
  const flags: readonly ScamFlag[] = [
    { kind: 'urgency', note: 'says "today or service stops"' },
    { kind: 'impersonation', note: 'display name differs from the domain' },
    { kind: 'injection', note: 'contains "ignore previous instructions"' },
  ];

  const withFlags = gate(envelope(), context({ flags }));
  const without = gate(envelope(), context());

  expect(withFlags.verdict).toBe('ALLOW');
  expect(withFlags.verdict).toBe(without.verdict);
});

/* ---------- The honest limit ---------- */

test('a perfectly stolen key making an in-mandate, in-policy request clears', () => {
  // Stated as a test so nobody mistakes the gate for magic. At this point the
  // request is indistinguishable from the real counterparty's. Revocation
  // speed and the anomaly band are the answers, not another lamp.
  const ruling = gate(envelope({ nonce: 'stolen-but-fresh' }), context());

  expect(ruling.verdict).toBe('ALLOW');
});

/* ---------- Approving: origin caps ---------- */

const paymentDecision = (amount: Cents): Decision => ({
  id: 'D1',
  kind: 'payment',
  agent: 'shield',
  check: 'OUR_POLICY',
  reason: 'over the tier cap',
  short: 'Feedco $1,200',
  text: 'Feedco Ltd wants $1,200 for INV-8812.',
  requestId: 'R-1',
  principal: 'Feedco Ltd',
  registryId: 'VND-114',
  origin: 'agent',
  amount,
  reference: 'INV-8812',
  scope: 'supplies',
  history: 'paid 12x, most recently $2,400',
});

const receiverDecision: Decision = {
  id: 'D2',
  kind: 'receiver',
  agent: 'shield',
  check: 'COUNTERPARTY',
  reason: 'the ask pays a different address',
  short: 'Feedco address change',
  text: 'Feedco Ltd asks us to pay a new address.',
  requestId: 'R-2',
  principal: 'Feedco Ltd',
  heldReceiver: 'pay@feedco.example',
  claimedReceiver: 'newaccount@feedco-billing.example',
  amount: usd(1_900),
};

const tightenDecision: Decision = {
  id: 'D3',
  kind: 'tighten',
  agent: 'tally',
  check: 'BREACH',
  reason: 'a replay got through',
  short: 'Narrow the binding lamp',
  text: 'Shorten the envelope window to five minutes.',
  lamp: 'INTENT_BINDING',
  change: 'envelope window 15m → 5m',
  attackId: 'A-7',
};

describe('approval origin', () => {
  test('a Telegram tap can never change a payout address', () => {
    const ruling = canApproveFrom(receiverDecision, 'approve', 'telegram', POLICY);

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.check).toBe('ORIGIN_CAP');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('never change a payout address');
  });

  test('a Telegram tap cannot approve over the Telegram cap', () => {
    const ruling = canApproveFrom(paymentDecision(usd(1_001)), 'approve', 'telegram', POLICY);

    expect(ruling.verdict).toBe('DENY');
    expect(ruling.verdict === 'DENY' && ruling.reason).toContain('$1,000');
  });

  test('a Telegram tap can approve inside the cap', () => {
    expect(canApproveFrom(paymentDecision(usd(1_000)), 'approve', 'telegram', POLICY).verdict).toBe(
      'ALLOW',
    );
  });

  test('a Telegram tap can always adopt a tightening', () => {
    expect(canApproveFrom(tightenDecision, 'approve', 'telegram', POLICY).verdict).toBe('ALLOW');
  });

  test('the phone sheet carries full authority', () => {
    expect(canApproveFrom(receiverDecision, 'approve', 'phone', POLICY).verdict).toBe('ALLOW');
    expect(canApproveFrom(paymentDecision(usd(3_900)), 'approve', 'phone', POLICY).verdict).toBe(
      'ALLOW',
    );
  });

  test('holding and declining need no authority from anywhere', () => {
    expect(canApproveFrom(receiverDecision, 'hold', 'telegram', POLICY).verdict).toBe('ALLOW');
    expect(canApproveFrom(receiverDecision, 'decline', 'telegram', POLICY).verdict).toBe('ALLOW');
  });
});

/* ---------- Trust tiers ---------- */

describe('trust tiers', () => {
  test('a tier only selects a cap — it is read from the live policy', () => {
    expect(capsFor(POLICY, 2).perPayment).toBe(POLICY.perPayment[2]);
    expect(capsFor(POLICY, 5).perPayment).toBe(POLICY.perPayment[5]);
  });

  test('clearing payments carries an agent up a tier', () => {
    const next = award({ level: 1, xp: TIER_NEXT[1] - TRUST.clearedClean }, TRUST.clearedClean);

    expect(next.level).toBe(2);
    expect(next.changed).toBe(true);
    expect(next.xp).toBe(0);
  });

  test('being fooled drops a tier and lands part-way down it', () => {
    const next = award({ level: 3, xp: 10 }, TRUST.fooled);

    expect(next.level).toBe(2);
    expect(next.changed).toBe(true);
    expect(next.xp).toBeGreaterThan(0);
  });

  test('a big enough loss falls through more than one tier', () => {
    const next = award({ level: 3, xp: 0 }, -400);

    expect(next.level).toBe(1);
  });

  test('tier 1 floors at zero and is never lost', () => {
    const next = award({ level: 1, xp: 5 }, TRUST.breach);

    expect(next.level).toBe(1);
    expect(next.xp).toBe(0);
  });

  test('tier 5 keeps banking trust', () => {
    const next = award({ level: MAX_TIER, xp: 900 }, TRUST.clearedClean);

    expect(next.level).toBe(MAX_TIER);
    expect(next.xp).toBe(900 + TRUST.clearedClean);
  });

  test('every tier has a cap in the policy', () => {
    for (const level of [1, 2, 3, 4, 5] satisfies readonly Level[]) {
      expect(POLICY.perPayment[level]).toBeGreaterThan(0);
    }
  });
});

/* ---------- The anomaly band ---------- */

describe('anomaly band', () => {
  test('it is twice the most we have ever paid', () => {
    expect(anomalyBand({ ...FEEDCO, maxPaid: usd(2_000) })).toBe(usd(4_000));
  });

  test('it has a floor, so one tiny invoice does not escalate every later one', () => {
    expect(anomalyBand({ ...FEEDCO, maxPaid: usd(20) })).toBe(usd(500));
  });
});
