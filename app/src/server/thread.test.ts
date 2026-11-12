/**
 * The crew's voices.
 *
 * Two properties matter here and the rest is colour:
 *
 *   1. **The conversation can never contradict the ruling.** The verdict line
 *      is spoken by the gate and by nobody else, and it says what the `Ruling`
 *      says. A pet cannot talk a lamp into changing colour, and the screen
 *      must not look as though one could.
 *
 *   2. **They are allowed to disagree about advice.** When the gate asks the
 *      owner, two pets landing on opposite recommendations is the feature:
 *      it is what makes the owner's tap a judgment rather than a formality.
 */

import { describe, expect, test } from 'bun:test';
import { DEFAULT_POLICY, gate } from '../rules.ts';
import { usd, type Envelope, type GateContext, type Policy, type VendorRecord } from '../types.ts';
import { buildThread, type CaseLine } from './thread.ts';

const NOW = 1_700_000_000_000;
const POLICY: Policy = { ...DEFAULT_POLICY, signature: 'sig' };

const FEEDCO: VendorRecord = {
  principal: 'Feedco Ltd',
  receiver: 'pay@feedco.example',
  principalKey: 'PUB',
  paidCount: 12,
  maxPaid: usd(2_400),
  meanPaid: usd(1_200),
};

function envelope(over: Partial<Envelope['intent']> & { origin?: Envelope['origin'] } = {}): Envelope {
  const { origin, ...intent } = over;
  return {
    id: 'R-1',
    origin: origin ?? 'agent',
    agent: { key: 'KEY', registryId: 'VND-114' },
    mandate: {
      principal: 'Feedco Ltd',
      agentKey: 'KEY',
      scope: 'supplies',
      maxPerPayment: usd(3_000),
      expiresDay: 30,
      signature: 'm',
    },
    intent: {
      amount: usd(900),
      receiver: 'pay@feedco.example',
      reference: 'FD-1',
      scope: 'supplies',
      ...intent,
    },
    nonce: 'n1',
    expiresAtMs: NOW + 60_000,
    signature: 's',
  };
}

function context(patch: Partial<GateContext> = {}): GateContext {
  return {
    paused: false,
    nowMs: NOW,
    day: 12,
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

/** Gate it for real, then let the crew talk about what the gate decided. */
function thread(env: Envelope, ctx: GateContext = context()): CaseLine[] {
  const ruling = gate(env, ctx);
  return buildThread({
    envelope: env,
    ruling,
    vendor: ctx.counterparty,
    flags: ctx.flags,
    day: ctx.day,
    tier: ctx.tier,
    policy: ctx.policy,
  });
}

const beats = (lines: readonly CaseLine[]): string[] => lines.map((l) => l.beat);

/* ---------- The verdict is not theirs ---------- */

describe('the verdict', () => {
  test('is spoken by the gate and by nobody else', () => {
    for (const env of [
      envelope(),
      envelope({ receiver: 'elsewhere@example' }),
      envelope({ amount: usd(2_900) }),
    ]) {
      const spoken = thread(env).filter((l) => l.beat === 'verdict');

      expect(spoken).toHaveLength(1);
      expect(spoken[0]?.from).toBe('gate');
    }
  });

  test('says what the ruling says, and cites the lamp that settled it', () => {
    const env = envelope({ receiver: 'accounts@feedco-billing.example' });
    const ctx = context();
    const ruling = gate(env, ctx);
    const verdict = thread(env, ctx).find((l) => l.beat === 'verdict');

    expect(ruling.verdict).toBe('DENY');
    expect(verdict?.cites).toBe(ruling.check);
    expect(verdict?.text).toContain('BLOCKED');
    expect(verdict?.text).toContain(ruling.verdict === 'ALLOW' ? '' : ruling.reason);
  });

  test('no pet speaks after it except to recommend', () => {
    // Once the ruling is down, the only thing left to do is advise the owner.
    const lines = thread(envelope(), context({ tier: 1 }));
    const after = lines.slice(lines.findIndex((l) => l.beat === 'verdict') + 1);

    expect(after.length).toBeGreaterThan(0);
    expect(after.every((l) => l.beat === 'recommend')).toBe(true);
  });
});

/* ---------- Quiet when nothing is wrong ---------- */

describe('a clean pass', () => {
  test('gets two lines and no argument', () => {
    const lines = thread(envelope());

    expect(beats(lines)).toEqual(['open', 'report', 'verdict']);
  });

  test('the quiet is the signal: a block says far more', () => {
    const clean = thread(envelope());
    const blocked = thread(envelope({ receiver: 'elsewhere@example' }));

    expect(blocked.length).toBeGreaterThan(clean.length);
    expect(beats(blocked)).toContain('argue');
  });
});

/* ---------- They argue ---------- */

describe('the argument', () => {
  test('a swapped address gets both sides of it', () => {
    const lines = thread(envelope({ receiver: 'accounts@feedco-billing.example' }));
    const argued = lines.filter((l) => l.beat === 'argue');

    expect(argued.length).toBeGreaterThan(1);
    // One points out that everything else was clean...
    expect(argued.some((l) => l.from === 'tally')).toBe(true);
    // ...the other points out that this was the plan.
    expect(argued.some((l) => l.from === 'mochi')).toBe(true);
  });

  test('a revoked agent gets the point made about it', () => {
    const lines = thread(envelope(), context({ registry: 'revoked' }));
    const argued = lines.filter((l) => l.beat === 'argue');

    expect(argued[0]?.from).toBe('shield');
    expect(argued[0]?.text).toContain('signature is real');
  });

  test('every argued line is a pet, never the gate', () => {
    const lines = thread(envelope({ amount: usd(2_900) }), context({ registry: 'revoked' }));

    expect(lines.filter((l) => l.beat === 'argue').every((l) => l.from !== 'gate')).toBe(true);
  });
});

/* ---------- They disagree about advice ---------- */

describe('recommendations', () => {
  test('only appear when the owner is being asked', () => {
    expect(beats(thread(envelope()))).not.toContain('recommend');
    expect(beats(thread(envelope({ receiver: 'elsewhere@example' })))).not.toContain('recommend');
    expect(beats(thread(envelope(), context({ tier: 1 })))).toContain('recommend');
  });

  test('two pets land on opposite sides of an unauthenticated request', () => {
    // The email lane: nothing is signed, but the vendor and the address are
    // ours. Tally reads the books and would pay; Mochi reads the lane and
    // would not. Neither is wrong, which is exactly why it is the owner's call.
    const env = envelope({ origin: 'email', amount: usd(1_200) });
    const ctx = context({
      registry: 'unknown',
      agentSigValid: false,
      flags: [{ kind: 'urgency', note: 'large amount on an unauthenticated lane' }],
    });

    const advice = thread(env, ctx).filter((l) => l.beat === 'recommend');
    const tally = advice.find((l) => l.from === 'tally')?.text ?? '';
    const mochi = advice.find((l) => l.from === 'mochi')?.text ?? '';

    expect(tally).toContain('Pay it');
    expect(mochi).toContain('I would hold it');
  });

  test('Shield states the consequence without recommending either way', () => {
    const advice = thread(envelope(), context({ tier: 1 })).filter((l) => l.beat === 'recommend');
    const shield = advice.find((l) => l.from === 'shield')?.text ?? '';

    expect(shield).toContain('Approving pays');
    expect(shield).toContain('will not without you');
  });
});

/* ---------- Determinism ---------- */

test('the same case always produces the same thread', () => {
  // It is a pure function of a settled ruling, which is what lets it be
  // swapped for a model later without the rest of the app noticing.
  const env = envelope({ receiver: 'elsewhere@example' });

  expect(thread(env)).toEqual(thread(env));
});
