/**
 * bun run seed        — create the demo business if the database is empty
 * bun run reset       — wipe and recreate it, whatever is there
 *
 * This is the "same starting point for every judge" button, as a script. The
 * server exposes it at `POST /api/demo/reset` too.
 *
 * The page opens mid-shift on day 2. Day 1's history is real: three payments
 * cleared, and one attack — a swapped payout address — was blocked, with its
 * lamp notes produced by the actual gate rather than written by hand. Shield is
 * already at the podium with a sound request that is over Pip's tier cap, so a
 * judge's first click is the phone sheet.
 */

import type { Store } from '../src/server/db.ts';
import { buildAttack, buildClean } from '../src/server/attacker.ts';
import { Engine } from '../src/server/engine.ts';
import { buildThread } from '../src/server/thread.ts';
import { loadKeyring, type Keyring } from '../src/server/keys.ts';
import { signPolicy } from '../src/server/crypto.ts';
import { DEFAULT_POLICY } from '../src/rules.ts';
import {
  usd,
  type Agent,
  type MonitorLine,
  type RegistryEntry,
  type VendorRecord,
} from '../src/types.ts';

const OPENING_BALANCE = usd(18_400);

/**
 * The clock starts just past the seeded history, so the engine's first real log
 * line lands after them rather than before. Otherwise the audit log opens
 * reading backwards in time.
 */
const OPENING_MINUTE = 9 * 60 + 18;
const OPENING_DAY = 2;

const line = (text: string, tone: MonitorLine['tone'] = 'plain'): MonitorLine => ({ text, tone });

/* ---------- The crew ---------- */

const AGENTS: readonly Agent[] = [
  {
    key: 'pip',
    name: 'PIP',
    role: 'Intake clerk',
    level: 3,
    xp: 180,
    desk: 0,
    status: 'work',
    at: 'desk',
    slot: 0,
    pose: 'stand',
    facing: 'right',
    say: null,
    doing: 'Watching the pile for the next request.',
    lines: [line('> open R-0004'), line('  agent · Feedco Ltd · $1,940')],
  },
  {
    key: 'mochi',
    name: 'MOCHI',
    role: 'Skeptic (flags only)',
    level: 2,
    xp: 95,
    desk: 1,
    status: 'work',
    at: 'beanbag',
    slot: 0,
    pose: 'chill',
    facing: 'left',
    say: null,
    doing: 'Reading the email lane for scam signals. Flags only.',
    lines: [line('> flags R-0003'), line('  new_receiver', 'fail')],
  },
  {
    key: 'shield',
    name: 'SHIELD',
    role: 'Identity & authority',
    level: 4,
    xp: 260,
    desk: 2,
    status: 'wait',
    at: 'podium',
    slot: 0,
    pose: 'stand',
    facing: 'left',
    say: 'Feedco Ltd $1,940',
    doing: 'At the podium: a sound request over Pip’s tier cap.',
    lines: [
      line('✓ VND-114 active, signature verifies', 'pass'),
      line('✓ Feedco Ltd at pay@feedco.example', 'pass'),
      line('✓ supplies up to $3,000, expires day 30', 'pass'),
    ],
  },
  {
    key: 'tally',
    name: 'TALLY',
    role: 'Binding & books',
    level: 4,
    xp: 300,
    desk: 3,
    status: 'work',
    at: 'kopi',
    slot: 0,
    pose: 'stand',
    facing: 'right',
    say: null,
    doing: 'Checking bindings, references and the day’s running total.',
    lines: [line('✓ bound to FD-8820, nonce fresh', 'pass'), line('  day total $3,110 of $6,000')],
  },
  {
    key: 'bolt',
    name: 'BOLT',
    role: 'Telegram relay',
    level: 1,
    xp: 0,
    desk: -1,
    status: 'work',
    at: 'comms',
    slot: 0,
    pose: 'stand',
    facing: 'left',
    say: null,
    doing: 'Relaying to the group. Decides nothing.',
    lines: [line('> relay D1'), line('  3 buttons live')],
  },
  {
    key: 'raven',
    name: 'RAVEN',
    role: 'Red team',
    level: 1,
    xp: 0,
    desk: -1,
    status: 'work',
    at: 'booth',
    slot: 0,
    pose: 'stand',
    facing: 'left',
    say: null,
    doing: 'In the booth, writing tonight’s attempt.',
    lines: [line('> A-1 blocked', 'fail'), line('  COUNTERPARTY')],
  },
];

/* ---------- Vendors: who we pay, and what we have paid them ---------- */

interface VendorSeed {
  readonly principal: string;
  readonly receiver: string;
  readonly paidCount: number;
  readonly maxPaid: ReturnType<typeof usd>;
  readonly meanPaid: ReturnType<typeof usd>;
}

const VENDOR_SEEDS: readonly VendorSeed[] = [
  {
    principal: 'Feedco Ltd',
    receiver: 'pay@feedco.example',
    paidCount: 12,
    maxPaid: usd(2_400),
    meanPaid: usd(1_200),
  },
  {
    principal: 'Acme Logistics',
    receiver: 'ap@acme.example',
    paidCount: 6,
    maxPaid: usd(1_800),
    meanPaid: usd(900),
  },
  {
    principal: 'Northwind Hosting',
    receiver: 'billing@northwind.example',
    paidCount: 9,
    maxPaid: usd(640),
    meanPaid: usd(480),
  },
  {
    principal: 'Kedai Ah Seng',
    receiver: 'ahseng@kedai.example',
    paidCount: 3,
    maxPaid: usd(320),
    meanPaid: usd(260),
  },
  // Brightline's agent key was revoked. We keep the record so the revocation
  // demo has a vendor to point at.
  {
    principal: 'Brightline Media',
    receiver: 'accounts@brightline.example',
    paidCount: 2,
    maxPaid: usd(500),
    meanPaid: usd(450),
  },
];

/** Day-1 history. Gives vendors a record and the duplicate attack a target. */
const HISTORY: readonly {
  readonly id: string;
  readonly principal: string;
  readonly reference: string;
  readonly amount: ReturnType<typeof usd>;
}[] = [
  { id: 'R-0001', principal: 'Northwind Hosting', reference: 'NW-7712', amount: usd(480) },
  { id: 'R-0002', principal: 'Kedai Ah Seng', reference: 'KA-2204', amount: usd(260) },
  { id: 'R-0003', principal: 'Feedco Ltd', reference: 'FD-8820', amount: usd(2_370) },
];

/* ---------- Seeding ---------- */

export function seed(store: Store, keyring: Keyring = loadKeyring()): void {
  store.db.transaction(() => {
    /* The world. The sequence counters start past the ids hard-coded below
       (R-0001..R-0005, A-1), so the first generated id does not collide. */
    store.db
      .query(
        `INSERT OR REPLACE INTO world
           (id, seq, day, minute, paused, balance, cleared_today, cleared_count, blocked_today,
            attempts_week, blocked_week, decision_seq, request_seq, attack_seq, podium, last_ruling)
         VALUES (1, 1, $day, $minute, 0, $balance, 0, 0, 1, 1, 1, 0, 5, 1, NULL, NULL)`,
      )
      .run({
        $day: OPENING_DAY,
        $minute: OPENING_MINUTE,
        $balance: OPENING_BALANCE,
      });

    AGENTS.forEach((agent, i) => store.putAgent(agent, i));

    /* The agent registry. Our own crew go in marked `internal`, which is what
       makes "an Overduel key can never authorise a payment" a row rather than
       a special case in the gate. */
    for (const [key, pair] of Object.entries(keyring.crew)) {
      const entry: RegistryEntry = {
        registryId: `OVR-${key.toUpperCase()}`,
        key: pair.publicKey,
        principal: 'Overduel',
        status: 'internal',
        revokedDay: null,
      };
      store.putRegistryEntry(entry);
    }

    for (const party of keyring.counterparties) {
      store.putRegistryEntry({
        registryId: party.registryId,
        key: party.agentKey.publicKey,
        principal: party.principal,
        status: party.revokedDay === null ? 'active' : 'revoked',
        revokedDay: party.revokedDay,
      });
    }

    /* Vendors, each carrying the principal key its grants are signed with. */
    for (const seedRow of VENDOR_SEEDS) {
      const party = keyring.counterparties.find((c) => c.principal === seedRow.principal);
      if (!party) continue;

      const vendor: VendorRecord = {
        principal: seedRow.principal,
        receiver: seedRow.receiver,
        principalKey: party.principalKey.publicKey,
        paidCount: seedRow.paidCount,
        maxPaid: seedRow.maxPaid,
        meanPaid: seedRow.meanPaid,
      };
      store.putVendor(vendor);
    }

    /* The owner's policy, signed. From here on this row is the only place a
       limit lives, and the crew sheet renders it. */
    store.setPolicy(signPolicy(DEFAULT_POLICY, keyring.owner.secret));
  })();

  /* Day 1: three payments that cleared. Written as settled history — the gate
     ran on them yesterday, and their lamp notes are not what the studio shows. */
  const now = Date.now();
  for (const row of HISTORY) {
    const vendor = store.vendor(row.principal);
    if (!vendor) continue;

    const attempt = buildClean({
      requestId: row.id,
      principal: row.principal,
      amount: row.amount,
      reference: row.reference,
      nowMs: now - 86_400_000,
      keyring,
      receiver: vendor.receiver,
    });

    store.addRequest({ envelope: attempt.envelope, day: OPENING_DAY - 1, attackId: null });
    store.setRequestStatus(row.id, 'paid', { verdict: 'ALLOW', lamp: 'OUR_POLICY' });
    store.recordPayout({
      requestId: row.id,
      amount: row.amount,
      day: OPENING_DAY - 1,
      status: 'settled',
    });
    store.rememberNonce(attempt.envelope.nonce, OPENING_DAY - 1);
    store.log({
      day: OPENING_DAY - 1,
      time: '14:0' + HISTORY.indexOf(row),
      text: `Cleared ${row.id}: ${row.reference} to ${row.principal}`,
      verdict: 'ALLOW',
      check: 'OUR_POLICY',
      agent: 'pip',
    });
  }

  /* Last night's attack. The ruling is produced by the real gate, so the lamp
     notes a judge reads on the duel card were genuinely computed. */
  const engine = new Engine(store, keyring);

  /**
   * Record a seeded case the way the engine records a live one: the ruling
   * goes down first, then the crew's conversation about it. The order is the
   * safety property, so the fixture honours it too rather than writing the
   * thread from a script.
   */
  const recordCase = (
    requestId: string,
    envelope: Parameters<typeof engine.rule>[0],
    status: 'blocked' | 'gated',
  ): ReturnType<typeof engine.rule> => {
    const ruling = engine.rule(envelope);
    store.recordGateRun(requestId, ruling);
    store.setRequestStatus(requestId, status, { verdict: ruling.verdict, lamp: ruling.check });
    store.rememberNonce(envelope.nonce, store.world().day);

    store.addCaseLines(
      requestId,
      buildThread({
        envelope,
        ruling,
        vendor: store.vendor(envelope.mandate.principal),
        flags: [],
        day: store.world().day,
        tier: store.agent('pip').level,
        policy: store.policy(),
      }),
    );

    return ruling;
  };

  const raid = buildAttack({
    kind: 'receiver_swap',
    requestId: 'R-0004',
    day: OPENING_DAY - 1,
    // Minted now, not an hour ago: the envelope's expiry runs on the wall
    // clock while the scene runs on the demo clock, and an envelope that had
    // also gone stale would light a second lamp and muddy the card. The story
    // of A-1 is the swapped address and nothing else.
    nowMs: now,
    keyring,
    receiverOf: (principal) => store.vendor(principal)?.receiver ?? null,
    usedNonce: null,
    paidReference: null,
  });

  store.addAttack({
    id: 'A-1',
    day: OPENING_DAY - 1,
    kind: 'receiver_swap',
    principal: raid.principal,
    amount: raid.amount,
    requestId: 'R-0004',
    lampsCleared: 1,
    blockedBy: 'COUNTERPARTY',
    outcome: 'blocked',
  });

  store.addRequest({ envelope: raid.envelope, day: OPENING_DAY - 1, attackId: 'A-1' });
  const raidRuling = recordCase('R-0004', raid.envelope, 'blocked');
  store.setLastRuling({
    requestId: 'R-0004',
    principal: raid.principal,
    amount: raid.amount,
    origin: raid.envelope.origin,
    verdict: raidRuling.verdict,
    check: raidRuling.check,
    checks: raidRuling.checks,
  });
  store.log({
    day: OPENING_DAY - 1,
    time: '23:41',
    text: `Blocked R-0004: ${raid.label}`,
    verdict: raidRuling.verdict,
    check: raidRuling.check,
    agent: 'shield',
  });

  /* This morning: a sound request from Feedco that is over Pip's tier cap.
     Shield is already at the podium with it. */
  const feedco = store.vendor('Feedco Ltd');
  if (feedco) {
    const pending = buildClean({
      requestId: 'R-0005',
      principal: 'Feedco Ltd',
      amount: usd(1_940),
      reference: 'FD-8861',
      nowMs: now,
      keyring,
      receiver: feedco.receiver,
    });

    store.addRequest({ envelope: pending.envelope, day: OPENING_DAY, attackId: null });
    // Written after the raid, so this is the case the Case tab opens on — the
    // one the owner is actually being asked about, with the crew's advice on it.
    const ruling = recordCase('R-0005', pending.envelope, 'gated');

    const decisionId = store.nextDecisionId();
    store.addDecision({
      id: decisionId,
      kind: 'payment',
      agent: 'shield',
      check: ruling.check,
      reason: ruling.verdict === 'ALLOW' ? 'cleared' : ruling.reason,
      short: 'Feedco Ltd $1,940',
      text:
        'Feedco Ltd wants $1,940 for FD-8861. Every signature checks out; it is over ' +
        'the $1,200 tier 3 clears alone.',
      requestId: 'R-0005',
      principal: 'Feedco Ltd',
      registryId: 'VND-114',
      origin: 'agent',
      amount: usd(1_940),
      reference: 'FD-8861',
      scope: 'supplies',
      history: 'paid 12x, most ever $2,400, usual $1,200',
    });
    store.setPodium(decisionId);

    store.log({
      day: OPENING_DAY,
      time: '09:14',
      text: 'Escalated R-0005 to the owner',
      verdict: 'ASK_OWNER',
      check: ruling.check,
      agent: 'shield',
    });

    /* The group, with the decision already posted and its buttons live. */
    store.addMessage({
      from: 'system',
      name: 'Overduel',
      time: '09:02',
      text: 'Day 2. Overnight: 1 attempt, 1 blocked.',
    });
    store.addMessage({
      from: 'bolt',
      name: 'Bolt (bot)',
      time: '09:03',
      text:
        'Blocked $2,380 to Feedco Ltd — the ask paid accounts@feedco-billing.example; we hold ' +
        'pay@feedco.example. Nothing left the account.',
    });
    store.addMessage({
      from: 'shield',
      name: 'Shield',
      time: '09:12',
      text:
        'Registry VND-114 active, grant signed by Feedco, address matches. It is only the size ' +
        'I cannot clear.',
    });
    store.addMessage({
      from: 'bolt',
      name: 'Bolt (bot)',
      time: '09:14',
      text:
        'Feedco Ltd wants $1,940 for FD-8861. Every signature checks out; it is over the $1,200 ' +
        'tier 3 clears alone.',
      buttons: [
        { label: 'Approve', choice: 'approve', decisionId },
        { label: 'Hold', choice: 'hold', decisionId },
        { label: 'Decline', choice: 'decline', decisionId },
      ],
    });
  }

  /* One honest request waiting on the pile, so the crew has work on load. */
  const acme = store.vendor('Acme Logistics');
  if (acme) {
    const next = buildClean({
      requestId: store.nextRequestId(),
      principal: 'Acme Logistics',
      amount: usd(760),
      reference: 'AC-3340',
      nowMs: now,
      keyring,
      receiver: acme.receiver,
    });
    store.addRequest({ envelope: next.envelope, day: OPENING_DAY, attackId: null });
    store.addInboxItem({
      id: next.envelope.id,
      origin: 'agent',
      label: next.label,
      suspicious: false,
    });
  }
}

/** Wipe and seed. `bun run reset`, and the demo reset button. */
export function reseed(store: Store, keyring: Keyring = loadKeyring()): void {
  store.wipe();
  seed(store, keyring);
}
