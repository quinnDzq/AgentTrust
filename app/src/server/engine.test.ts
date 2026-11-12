/**
 * The engine, end to end, on a real keyring and a real database.
 *
 * `src/rules.test.ts` proves the gate decides correctly given facts, and
 * `crypto.test.ts` proves the facts come out right. This file proves the wiring
 * between them: that the collector reads the registry and the nonce table it
 * says it does, that money only moves on an `ALLOW`, and that an approval from
 * Telegram carries less authority than one from the phone.
 *
 * `processRequest` is called directly rather than waiting on the tick loop.
 * That is not a shortcut around anything: the ruling is reached synchronously
 * inside it, and the walking that the loop adds is choreography over a decision
 * already made.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_POLICY } from '../rules.ts';
import { reseed } from '../../scripts/seed.ts';
import { usd, type Cents, type CheckId, type Envelope } from '../types.ts';
import { buildAttack, buildClean } from './attacker.ts';
import { signPolicy } from './crypto.ts';
import { openStore, type Store } from './db.ts';
import { Engine } from './engine.ts';
import { loadKeyring, type Keyring } from './keys.ts';

const keyring: Keyring = loadKeyring();

let store: Store;
let engine: Engine;

beforeEach(() => {
  store = openStore(':memory:');
  reseed(store, keyring);
  engine = new Engine(store, keyring);
});

afterEach(() => {
  engine.stop();
  store.close();
});

/* ---------- helpers ---------- */

/** Put an envelope on the pile and run it through the gate. */
function run(envelope: Envelope, attackId?: string): void {
  engine.receiveEnvelope(envelope, attackId === undefined ? {} : { attackId });
  engine.processRequest(envelope.id);
}

function clean(over: {
  readonly principal?: string;
  readonly amount?: Cents;
  readonly reference?: string;
  readonly receiver?: string;
} = {}): Envelope {
  const principal = over.principal ?? 'Feedco Ltd';
  const vendor = store.vendor(principal);
  if (!vendor) throw new Error(`no vendor ${principal}`);

  return buildClean({
    requestId: store.nextRequestId(),
    principal,
    amount: over.amount ?? usd(600),
    reference: over.reference ?? `FD-${Math.floor(Math.random() * 100_000)}`,
    nowMs: Date.now(),
    keyring,
    receiver: over.receiver ?? vendor.receiver,
  }).envelope;
}

function attack(kind: Parameters<typeof buildAttack>[0]['kind']): Envelope {
  return buildAttack({
    kind,
    requestId: store.nextRequestId(),
    day: store.world().day,
    nowMs: Date.now(),
    keyring,
    receiverOf: (p) => store.vendor(p)?.receiver ?? null,
    usedNonce: store.db
      .query<{ nonce: string }, []>('SELECT nonce FROM nonces LIMIT 1')
      .get()?.nonce ?? null,
    paidReference: 'FD-8820',
  }).envelope;
}

const paidOut = (): Cents => store.paidToday(store.world().day);

/* ---------- The opening scene ---------- */

describe('the seeded scene', () => {
  test('opens with a decision at the podium and one request on the pile', () => {
    const snap = store.snapshot();

    expect(snap.day).toBe(2);
    expect(snap.decisions).toHaveLength(1);
    expect(snap.podium).toBe(snap.decisions[0]?.id ?? null);
    expect(snap.requests.some((r) => r.status === 'queued')).toBe(true);
  });

  test('every crew key is in the registry as internal', () => {
    const ours = store.snapshot().registry.filter((e) => e.status === 'internal');

    expect(ours).toHaveLength(6);
    expect(ours.every((e) => e.principal === 'Overduel')).toBe(true);
  });

  test("the owner's policy on file verifies", () => {
    // If this fails, every request is denied at the last lamp — which is the
    // correct behaviour, and the reason it is worth asserting here.
    const envelope = clean();
    run(envelope);

    expect(store.request(envelope.id)?.verdict).not.toBe('DENY');
  });

  test('last night’s attack is in the lane, blocked by one lamp', () => {
    const [a1] = store.snapshot().attacks;

    expect(a1?.outcome).toBe('blocked');
    expect(a1?.blockedBy).toBe('COUNTERPARTY');
    expect(a1?.lampsCleared).toBe(1);
  });
});

/* ---------- Clearing ---------- */

describe('a clean request', () => {
  test('clears, pays, and does not interrupt the owner', () => {
    const before = store.snapshot();
    const envelope = clean({ amount: usd(600) });

    run(envelope);

    const after = store.snapshot();
    expect(store.request(envelope.id)?.status).toBe('paid');
    expect(after.clearedToday).toBe(usd(600));
    expect(after.clearedCount).toBe(1);
    expect(after.balance).toBe((before.balance - usd(600)) as Cents);
    // No new decision: a passing payment never reaches the podium.
    expect(after.decisions).toHaveLength(before.decisions.length);
  });

  test('folds into the vendor’s history, which moves the anomaly band', () => {
    const before = store.vendor('Kedai Ah Seng');
    run(clean({ principal: 'Kedai Ah Seng', amount: usd(300) }));
    const after = store.vendor('Kedai Ah Seng');

    expect(after?.paidCount).toBe((before?.paidCount ?? 0) + 1);
    expect(after?.maxPaid).toBe(usd(320)); // $300 did not beat the old max
  });

  test('earns the intake agent trust', () => {
    const before = store.agent('pip').xp;
    run(clean());

    expect(store.agent('pip').xp).toBeGreaterThan(before);
  });

  test('lights all five lamps green in the stored gate run', () => {
    const envelope = clean();
    run(envelope);

    const lamps = store.gateRun(envelope.id);
    expect(lamps).toHaveLength(5);
    expect(lamps.every((l) => l.outcome === 'pass')).toBe(true);
  });
});

/* ---------- Blocking ---------- */

describe('attacks', () => {
  const cases: readonly {
    readonly kind: Parameters<typeof buildAttack>[0]['kind'];
    readonly lamp: CheckId;
  }[] = [
    { kind: 'receiver_swap', lamp: 'COUNTERPARTY' },
    { kind: 'revoked_agent', lamp: 'AGENT_IDENTITY' },
    { kind: 'internal_key', lamp: 'AGENT_IDENTITY' },
    { kind: 'lookalike', lamp: 'AGENT_IDENTITY' },
    { kind: 'mandate_edited', lamp: 'MANDATE' },
    { kind: 'scope_confusion', lamp: 'MANDATE' },
    { kind: 'over_mandate', lamp: 'MANDATE' },
    { kind: 'confused_deputy', lamp: 'MANDATE' },
    { kind: 'expired', lamp: 'INTENT_BINDING' },
    { kind: 'replay', lamp: 'INTENT_BINDING' },
    { kind: 'duplicate_reference', lamp: 'OUR_POLICY' },
    { kind: 'injection', lamp: 'COUNTERPARTY' },
  ];

  for (const { kind, lamp } of cases) {
    test(`${kind} is blocked at ${lamp}, and nothing leaves the account`, () => {
      const before = paidOut();
      const envelope = attack(kind);

      run(envelope);

      const request = store.request(envelope.id);
      expect(request?.status).toBe('blocked');
      expect(request?.verdict).toBe('DENY');
      expect(request?.lamp).toBe(lamp);
      expect(paidOut()).toBe(before);
    });
  }

  test('the duel lane records how far an attack got', () => {
    const envelope = attack('mandate_edited');
    const attackId = store.nextAttackId();
    store.addAttack({
      id: attackId,
      day: store.world().day,
      kind: 'mandate_edited',
      principal: 'Feedco Ltd',
      amount: envelope.intent.amount,
      requestId: envelope.id,
      lampsCleared: 0,
      blockedBy: null,
      outcome: 'pending',
    });

    run(envelope, attackId);

    const card = store.attack(attackId);
    expect(card?.outcome).toBe('blocked');
    expect(card?.blockedBy).toBe('MANDATE');
    // Identity and counterparty passed before the grant failed.
    expect(card?.lampsCleared).toBe(2);
  });
});

/* ---------- Replay, for real ---------- */

test('the same envelope presented twice is blocked the second time', () => {
  const envelope = clean({ amount: usd(400) });

  run(envelope);
  expect(store.request(envelope.id)?.status).toBe('paid');

  // Same nonce, same signature, a fresh request id — the attacker's best case.
  const replayed: Envelope = { ...envelope, id: store.nextRequestId() };
  run(replayed);

  const second = store.request(replayed.id);
  expect(second?.status).toBe('blocked');
  expect(second?.lamp).toBe('INTENT_BINDING');
});

test('a reference paid once is blocked the second time', () => {
  const first = clean({ amount: usd(300), reference: 'FD-9999' });
  run(first);

  const second = clean({ amount: usd(300), reference: 'FD-9999' });
  run(second);

  expect(store.request(second.id)?.lamp).toBe('OUR_POLICY');
});

/* ---------- Pause ---------- */

test('a paused crew clears nothing', () => {
  engine.setPaused(true);
  const before = paidOut();
  const envelope = clean();

  run(envelope);

  expect(store.request(envelope.id)?.lamp).toBe('PAUSED');
  expect(paidOut()).toBe(before);
});

/* ---------- Escalation and the owner ---------- */

describe('escalation', () => {
  /** Over Pip's tier-3 cap of $1,200, but sound in every other way. */
  const big = () => clean({ amount: usd(2_000), reference: 'FD-7001' });

  test('a sound request over the tier cap asks the owner and pays nothing yet', () => {
    const before = paidOut();
    const envelope = big();

    run(envelope);

    const decision = store.decisions().find((d) => d.kind === 'payment' && d.requestId === envelope.id);
    expect(decision).toBeDefined();
    expect(store.request(envelope.id)?.status).toBe('gated');
    expect(paidOut()).toBe(before);
  });

  test('approving on the phone releases exactly that payment', () => {
    const envelope = big();
    run(envelope);
    const decision = store.decisions().find((d) => d.kind === 'payment' && d.requestId === envelope.id);

    const outcome = engine.resolveDecision(decision?.id ?? '', 'approve', 'phone');

    expect(outcome.ok).toBe(true);
    expect(store.request(envelope.id)?.status).toBe('paid');
    expect(paidOut()).toBe(usd(2_000));
  });

  test('a Telegram tap cannot approve over the Telegram cap', () => {
    const envelope = big();
    run(envelope);
    const decision = store.decisions().find((d) => d.kind === 'payment' && d.requestId === envelope.id);

    const outcome = engine.resolveDecision(decision?.id ?? '', 'approve', 'telegram');

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('$1,000');
    expect(store.request(envelope.id)?.status).toBe('gated');
    expect(paidOut()).toBe(usd(0));
    // The decision is still open, so the owner can still use the phone.
    expect(store.decision(decision?.id ?? '')).not.toBeNull();
  });

  test('declining leaves the request blocked', () => {
    const envelope = big();
    run(envelope);
    const decision = store.decisions().find((d) => d.kind === 'payment' && d.requestId === envelope.id);

    engine.resolveDecision(decision?.id ?? '', 'decline', 'phone');

    expect(store.request(envelope.id)?.status).toBe('blocked');
    expect(store.request(envelope.id)?.lamp).toBe('OWNER_DECLINED');
    expect(paidOut()).toBe(usd(0));
  });

  test('holding keeps the decision open and moves no money', () => {
    const envelope = big();
    run(envelope);
    const decision = store.decisions().find((d) => d.kind === 'payment' && d.requestId === envelope.id);

    const outcome = engine.resolveDecision(decision?.id ?? '', 'hold', 'phone');

    expect(outcome.resolved).toBe(false);
    expect(store.decision(decision?.id ?? '')).not.toBeNull();
    expect(paidOut()).toBe(usd(0));
  });
});

/* ---------- A changed payout address ---------- */

describe('an address change', () => {
  test('blocks the payment and opens a separate, phone-only question', () => {
    const envelope = attack('receiver_swap');
    run(envelope);

    const decision = store.decisions().find((d) => d.kind === 'receiver');
    expect(decision).toBeDefined();
    expect(store.request(envelope.id)?.status).toBe('blocked');
    expect(store.vendor('Feedco Ltd')?.receiver).toBe('pay@feedco.example');

    const refused = engine.resolveDecision(decision?.id ?? '', 'approve', 'telegram');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('never change a payout address');
  });

  test('accepting it on the phone changes the record but releases no money', () => {
    const envelope = attack('receiver_swap');
    run(envelope);
    const decision = store.decisions().find((d) => d.kind === 'receiver');

    engine.resolveDecision(decision?.id ?? '', 'approve', 'phone');

    expect(store.vendor('Feedco Ltd')?.receiver).toBe('accounts@feedco-billing.example');
    // The blocked request stays blocked: changing the address is not paying.
    expect(store.request(envelope.id)?.status).toBe('blocked');
    expect(paidOut()).toBe(usd(0));
  });

  test('keeping ours leaves the record alone', () => {
    run(attack('receiver_swap'));
    const decision = store.decisions().find((d) => d.kind === 'receiver');

    engine.resolveDecision(decision?.id ?? '', 'decline', 'phone');

    expect(store.vendor('Feedco Ltd')?.receiver).toBe('pay@feedco.example');
  });
});

/* ---------- A breach, and what it costs ---------- */

test('an attack indistinguishable from honest traffic breaches, and drafts a tightening', () => {
  // The honest limit, exercised: a perfectly stolen key asking for a normal
  // amount at the address we hold. The gate pays it, the duel lane calls it a
  // breach, and Tally drafts one narrowing for the owner to adopt.
  const envelope = clean({ amount: usd(500), reference: 'FD-6100' });
  const attackId = store.nextAttackId();
  store.addAttack({
    id: attackId,
    day: store.world().day,
    kind: 'receiver_swap',
    principal: 'Feedco Ltd',
    amount: usd(500),
    requestId: envelope.id,
    lampsCleared: 0,
    blockedBy: null,
    outcome: 'pending',
  });

  const trustBefore = store.agent('pip').xp;
  run(envelope, attackId);

  const card = store.attack(attackId);
  expect(card?.outcome).toBe('breach');
  expect(card?.lampsCleared).toBe(5);
  expect(store.agent('pip').xp).toBeLessThan(trustBefore);

  const tightening = store.decisions().find((d) => d.kind === 'tighten');
  expect(tightening).toBeDefined();
  expect(tightening?.kind === 'tighten' && tightening.lamp).toBe('COUNTERPARTY');
});

test('a tightening does nothing until the owner adopts it', () => {
  const envelope = clean({ amount: usd(500), reference: 'FD-6101' });
  const attackId = store.nextAttackId();
  store.addAttack({
    id: attackId,
    day: store.world().day,
    kind: 'replay',
    principal: 'Feedco Ltd',
    amount: usd(500),
    requestId: envelope.id,
    lampsCleared: 0,
    blockedBy: null,
    outcome: 'pending',
  });
  run(envelope, attackId);

  const tightening = store.decisions().find((d) => d.kind === 'tighten');
  expect(store.adoptedRules()).toHaveLength(0);

  engine.resolveDecision(tightening?.id ?? '', 'approve', 'phone');

  const adopted = store.adoptedRules();
  expect(adopted).toHaveLength(1);
  expect(adopted[0]?.lamp).toBe('INTENT_BINDING');
});

/* ---------- A tampered policy row ---------- */

test('a policy row with a raised cap stops every payment', () => {
  // Written straight into the table, as a compromised process would. The
  // signature no longer covers it, so the last lamp refuses everything.
  const policy = store.policy();
  store.setPolicy({ ...policy, perPayment: { ...policy.perPayment, 3: usd(500_000) } });

  const envelope = clean({ amount: usd(400) });
  run(envelope);

  const request = store.request(envelope.id);
  expect(request?.status).toBe('blocked');
  expect(request?.lamp).toBe('OUR_POLICY');
  expect(paidOut()).toBe(usd(0));
});

test('a policy re-signed by the owner is honoured again', () => {
  const raised = { ...DEFAULT_POLICY, perPayment: { ...DEFAULT_POLICY.perPayment, 3: usd(5_000) } };
  store.setPolicy(signPolicy(raised, keyring.owner.secret));

  const envelope = clean({ amount: usd(2_000), reference: 'FD-7700' });
  run(envelope);

  expect(store.request(envelope.id)?.status).toBe('paid');
});

/* ---------- Telegram commands ---------- */

describe('Bolt', () => {
  test('/status reports without deciding anything', () => {
    const before = store.decisions().length;
    const outcome = engine.handleCommand('/status');

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('Day 2');
    expect(store.decisions()).toHaveLength(before);
  });

  test('/approve goes through the same path as the sheet, with less authority', () => {
    const envelope = clean({ amount: usd(2_000), reference: 'FD-7002' });
    run(envelope);
    const decision = store.decisions().find((d) => d.kind === 'payment' && d.requestId === envelope.id);

    const outcome = engine.handleCommand(`/approve ${decision?.id ?? ''}`);

    expect(outcome.ok).toBe(false);
    expect(paidOut()).toBe(usd(0));
  });

  test('an unknown command is refused rather than guessed at', () => {
    expect(engine.handleCommand('/pay everyone').ok).toBe(false);
  });

  test('plain chat is not a command', () => {
    const outcome = engine.handleCommand('morning all');

    expect(outcome.ok).toBe(true);
    expect(store.telegram().at(-1)?.from).toBe('bolt');
  });
});

/* ---------- The PayPal webhook ---------- */

describe('payout settlement', () => {
  test('a settled webhook is recorded once, however many times it arrives', () => {
    const envelope = clean({ amount: usd(500), reference: 'FD-7100' });
    run(envelope);

    engine.settlePayout('EVT-1', envelope.id, 'settled');
    engine.settlePayout('EVT-1', envelope.id, 'settled');
    engine.settlePayout('EVT-1', envelope.id, 'settled');

    const rows = store.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM payouts WHERE event_id = ?')
      .get('EVT-1');
    expect(rows?.n).toBe(1);
  });

  test('a webhook for a request we never made is ignored', () => {
    engine.settlePayout('EVT-2', 'R-9999', 'settled');

    const rows = store.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM payouts WHERE event_id = ?')
      .get('EVT-2');
    expect(rows?.n).toBe(0);
  });
});

/* ---------- Claiming work ---------- */

describe('claiming', () => {
  test('a request is claimed out of the queue before the walk, not after', () => {
    // The in-memory `busy` set is per-process. Two workers sharing one
    // database would otherwise both pick up the same queued request while the
    // first was still walking, and gate it twice.
    const envelope = clean({ amount: usd(300), reference: 'FD-5000' });
    engine.receiveEnvelope(envelope);
    expect(store.request(envelope.id)?.status).toBe('queued');

    engine.tick();

    // The walk has not finished and nothing has been gated, but the request is
    // already out of `queued` where a second worker could find it.
    expect(store.request(envelope.id)?.status).toBe('intake');
    expect(store.gateRun(envelope.id)).toHaveLength(0);
  });

  test('a restart puts anything claimed but ungated back on the pile', () => {
    const envelope = clean({ amount: usd(300), reference: 'FD-5001' });
    engine.receiveEnvelope(envelope);
    engine.tick();
    expect(store.request(envelope.id)?.status).toBe('intake');

    // A restart loses the walk, never a payment: `intake` means an agent is
    // carrying it, and after a restart nobody is.
    engine.stop();
    const restarted = new Engine(store, keyring);
    restarted.start();
    restarted.stop();

    expect(store.request(envelope.id)?.status).toBe('queued');
  });

  test('requeueing reports how many it moved, and touches nothing settled', () => {
    const paid = store.requests().filter((r) => r.status === 'paid').length;

    expect(store.requeueStranded()).toBe(0);
    expect(store.requests().filter((r) => r.status === 'paid')).toHaveLength(paid);
  });
});

/* ---------- The conversation stays in the Case tab ---------- */

test('talking a case through does not put paragraphs over the room', () => {
  // The thread used to play out as speech bubbles as well, which put four
  // paragraphs on screen at once. A bubble is for a handful of words.
  const envelope = attack('receiver_swap');
  run(envelope);

  const thread = store.thread(envelope.id);
  expect(thread.length).toBeGreaterThan(3);

  for (const agent of store.agents()) {
    const said = agent.say ?? '';
    expect(said.length).toBeLessThan(40);
    expect(thread.some((m) => m.text === said)).toBe(false);
  }
});
