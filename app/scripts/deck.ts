/**
 * The AgentTrust deck scene: 2 a.m., one buyer asleep, one agent at work.
 *
 * bun run deck                         — create the scene if the deck database is empty
 * bun run deck:reset                   — start the night again; the PayPal wallet stays connected
 * bun run deck:reset -- --forget-wallet — also forget the wallet here (PayPal keeps it)
 *
 * It opens at 01:58 before anything has happened this run. The budget is not
 * approved, so the policy row is lapsed and nothing clears. Step one is the
 * PayPal Sandbox wallet — connected already if one carried over or is
 * pre-authorized, otherwise a one-time PayPal consent. Step two is allowing
 * the Deck Agent its $20, asked again every run. After that the first $8 image
 * clears on its own. The second $8 crosses the 50% ask threshold and waits for
 * the buyer; once they approve, the $5 icon pack is refused for passing the
 * budget, and Raven's $3 impostor is refused for a key nobody enrolled.
 *
 * Overduel's own scene in `seed.ts` is untouched, and its tests still run on it.
 */

import { randomUUID } from 'node:crypto';
import type { Store } from '../src/server/db.ts';
import { DECK, DECK_SLOTS } from '../src/server/deck.ts';
import { loadKeyring, type Keyring } from '../src/server/keys.ts';
import { signPolicy } from '../src/server/crypto.ts';
import { usd, type Agent, type Cents, type ChargeMode } from '../src/types.ts';

/** Where the deck scene keeps its world, so it never collides with Overduel's. */
export const DECK_DATABASE = 'data/agenttrust-deck.sqlite';

/* ---------- The crew, on the night shift ---------- */

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
    doing: 'Night shift: takes the Deck Agent’s requests off the pile.',
    lines: [],
  },
  {
    key: 'mochi',
    name: 'MOCHI',
    role: 'Skeptic (flags only)',
    level: 2,
    xp: 95,
    desk: 1,
    status: 'work',
    at: 'sleep',
    slot: 0,
    pose: 'sleep',
    facing: 'left',
    say: null,
    doing: 'Asleep. Mochi only reads email, and nobody emails at 2 a.m.',
    lines: [],
  },
  {
    key: 'shield',
    name: 'SHIELD',
    role: 'Identity & authority',
    level: 4,
    xp: 260,
    desk: 2,
    status: 'work',
    at: 'desk',
    slot: 2,
    pose: 'stand',
    facing: 'left',
    say: null,
    doing: 'Holds the agent registry: which keys are enrolled, and for whom.',
    lines: [],
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
    doing: 'Keeps the $20 budget: spent, reserved and what is left.',
    lines: [],
  },
  {
    key: 'bolt',
    name: 'BOLT',
    role: 'Relay to the buyer’s phone',
    level: 1,
    xp: 0,
    desk: -1,
    status: 'work',
    at: 'comms',
    slot: 0,
    pose: 'stand',
    facing: 'left',
    say: null,
    doing: 'Would wake the buyer. Counts every time it has to. Decides nothing.',
    lines: [],
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
    doing: 'In the booth, building an impostor with a key nobody enrolled.',
    lines: [],
  },
];

/* ---------- Seeding ---------- */

/**
 * Lay out the night.
 *
 * `mode` is whether this server can reach the PayPal Sandbox. It only changes
 * how the scene labels the wallet and the charges — the gate is the same.
 */
export function seedDeck(
  store: Store,
  keyring: Keyring = loadKeyring(),
  mode: ChargeMode = 'simulated',
  budget: Cents = DECK.budget,
  askPct = 50,
): void {
  const buyer = keyring.counterparties.find((c) => c.principal === DECK.principal);
  if (!buyer) throw new Error(`no "${DECK.principal}" in the keyring — run \`bun run keys\``);

  store.db.transaction(() => {
    store.db
      .query(
        `INSERT OR REPLACE INTO world
           (id, seq, day, minute, paused, balance, cleared_today, cleared_count, blocked_today,
            attempts_week, blocked_week, decision_seq, request_seq, attack_seq, podium, last_ruling)
         VALUES (1, 1, $day, $minute, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL)`,
      )
      .run({ $day: DECK.day, $minute: DECK.openingMinute });

    AGENTS.forEach((agent, i) => store.putAgent(agent, i));

    // The crew are ours and can never pay — the same `internal` rows as in
    // Overduel. The Deck Agent is the one enrolled key that can.
    for (const [key, pair] of Object.entries(keyring.crew)) {
      store.putRegistryEntry({
        registryId: `OVR-${key.toUpperCase()}`,
        key: pair.publicKey,
        principal: 'Overduel',
        status: 'internal',
        revokedDay: null,
      });
    }
    store.putRegistryEntry({
      registryId: DECK.registryId,
      key: buyer.agentKey.publicKey,
      principal: DECK.principal,
      status: 'active',
      revokedDay: null,
    });

    // The buyer's record: whose grants we verify, and the one shop the grant
    // may pay. A request to pay anyone else fails lamp 2.
    store.putVendor({
      principal: DECK.principal,
      receiver: DECK.merchant,
      principalKey: buyer.principalKey.publicKey,
      paidCount: 0,
      maxPaid: usd(0),
      meanPaid: usd(0),
    });

    // A policy that has already lapsed: until the wallet is connected and this
    // run's budget approved there is no live authority, so lamp 5 refuses
    // everything. Activation re-signs it with tonight's date — see
    // `Engine.activateIfReady`.
    store.setPolicy(
      signPolicy(
        {
          expiresDay: DECK.day - 1,
          dailyTotal: budget,
          telegramCap: usd(0),
          perPayment: { 1: budget, 2: budget, 3: budget, 4: budget, 5: budget },
          originCeiling: { agent: budget, portal: usd(0), email: usd(0) },
        },
        keyring.owner.secret,
      ),
    );

    // A new run: its own id, its budget not yet approved. The PayPal wallet
    // and any unresolved charges are not touched — they carry across runs.
    store.putDeckGrant({
      run_id: randomUUID(),
      registry_id: DECK.registryId,
      merchant: DECK.merchant,
      budget,
      mode,
      approved: 0,
      ask_pct: askPct,
    });

    DECK_SLOTS.forEach((slot, i) => store.putDeckSlot(slot, i + 1));

    store.log({
      day: DECK.day,
      time: '01:58',
      text:
        `The buyer is asleep. ${DECK.agentName} is finishing the 9 a.m. pitch deck and needs ` +
        `three images from ${DECK.merchant}`,
      verdict: 'ALLOW',
      check: 'CLOCK',
    });
  })();
}

/**
 * Wipe this run and seed a new one. `bun run deck:reset`, and the Reset button.
 *
 * The PayPal wallet and unresolved charges live in tables `wipe` leaves alone,
 * so a replay needs no new login and nothing waiting on PayPal is lost.
 */
export function reseedDeck(
  store: Store,
  keyring: Keyring = loadKeyring(),
  mode: ChargeMode = 'simulated',
  budget: Cents = DECK.budget,
  askPct = 50,
): void {
  store.wipe();
  seedDeck(store, keyring, mode, budget, askPct);
}

/**
 * Make sure the database holds a deck run for this server's PayPal setting.
 *
 * Starts the night again when there is no run — a database from before runs
 * existed, or one seeded for Overduel's tables only — or when the run was
 * seeded under the other setting: credentials added or removed, or after
 * `bun run deck:reset`, which always seeds the simulated night. Either would
 * show buttons the server then refuses. Returns true when it re-seeded.
 */
export function ensureDeckScene(
  store: Store,
  keyring: Keyring,
  mode: ChargeMode,
  budget: Cents = DECK.budget,
  askPct = 50,
): boolean {
  const grant = store.deckGrant();
  if (grant && grant.mode === mode) return false;
  reseedDeck(store, keyring, mode, budget, askPct);
  return true;
}
