/**
 * The live flow, end to end: a quote, the numeric challenge, the signing
 * challenge, the gate, PayPal — and every way it is meant to stop short.
 *
 * Nothing here touches a network. PayPal is an object that records what it was
 * asked, the signer is the real signing code running in this process, the chain
 * is a function that answers what a test tells it to, and the "model" is a
 * generator from `habits.ts` (a stand-in, not a measurement). What is real is
 * everything in between: the store, the engine, the gate and the Ed25519
 * signatures.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { reseedDeck } from '../../scripts/deck.ts';
import { usd, type Cents, type Envelope, type IdentityMode } from '../types.ts';
import { fingerprint, generateKeyPair, signEnvelope, type KeyPair } from './crypto.ts';
import { openStore, type Store } from './db.ts';
import { DECK, OTHER_MERCHANT } from './deck.ts';
import { Engine } from './engine.ts';
import type { Erc8004Config, RegistrationRead } from './erc8004.ts';
import { MIN_SAMPLES, PROBE, PROBE_PROMPT, uniformSamples } from './fingerprint.ts';
import { habitA, habitB, many } from './habits.ts';
import { loadKeyring } from './keys.ts';
import { CHALLENGE_TTL_MS, LiveVerifier, MAX_UNREAD_REPLIES, SIGN_TTL_MS, type ToolOutcome } from './live.ts';
import type { ChargeArgs, OrderOutcome, PayPal } from './paypal.ts';
import { EMPTY_BANK, memoryReference, withSample, type ReferenceBank, type ReferenceStore } from './reference.ts';
import { localSigner, SignerUnavailable, type SignerClient, type SignerPolicy } from './signer.ts';

const keyring = loadKeyring();
const MODEL = 'Test model';

/* ---------- Stand-ins ---------- */

interface FakePayPal {
  readonly paypal: PayPal;
  readonly orders: ChargeArgs[];
  /** How the next saved-wallet order answers. */
  answer: 'completed' | 'pending' | 'buyer_action';
}

function fakePayPal(): FakePayPal {
  const fake: FakePayPal = {
    orders: [],
    answer: 'completed',
    paypal: {
      createSetupToken: async () => ({ id: 'SETUP1', approvalUrl: 'https://www.sandbox.paypal.com/approve' }),
      setupStatus: async () => 'APPROVED',
      savePaymentToken: async () => 'VAULT1',
      paymentToken: async () => {},
      async chargeSavedWallet(args): Promise<OrderOutcome> {
        fake.orders.push(args);
        const orderId = `ORDER${fake.orders.length}`;
        if (fake.answer === 'pending') return { kind: 'unconfirmed', orderId, status: 'APPROVED' };
        if (fake.answer === 'buyer_action') return { kind: 'buyer_action', orderId };
        return { kind: 'completed', orderId, captureId: `CAPTURE${fake.orders.length}` };
      },
      order: async (orderId) => ({ kind: 'unconfirmed', orderId, status: 'APPROVED' }),
    },
  };
  return fake;
}

const POLICY: SignerPolicy = {
  registryId: DECK.registryId,
  scope: 'stock_images',
  maxAmount: DECK.budget,
  maxTtlMs: 10 * 60 * 1_000,
};

/** A bank with enough of one habit to be calibrated, recorded as the expected model. */
function bankOf(label: string, samples: readonly number[][], base: ReferenceBank = EMPTY_BANK): ReferenceBank {
  return samples.reduce((bank, numbers, i) => withSample(bank, label, numbers, `test:${i}`, '2026-11-12T00:00:00Z'), base);
}

const CALIBRATED = bankOf(MODEL, many(habitA, 8));

const CHAIN: Erc8004Config = {
  network: 'Base Sepolia',
  chainId: 84532,
  rpcUrl: 'https://rpc.invalid',
  registry: '0x1111111111111111111111111111111111111111',
  agentId: '42',
  expectedOwner: '0xAbCdEf0000000000000000000000000000000001',
  explorerUrl: 'https://sepolia.basescan.org/nft/0x1111111111111111111111111111111111111111/42',
};

const owned = (
  owner: string,
  statedKey: string | null = null,
): Extract<RegistrationRead, { readonly kind: 'found' }> => ({
  kind: 'found',
  chainId: CHAIN.chainId,
  blockNumber: 1_234_567,
  owner,
  agentUri: null,
  statedKey,
});

const csv = (numbers: readonly number[]): string => numbers.join(', ');

/** A reply the calibrated reference recognises, and one it does not. */
const matching = (seed = 900): string => csv(habitA(seed));
const uniform = (): string => csv(uniformSamples(1, 31_337)[0] ?? []);

/* ---------- Driving a night ---------- */

let store: Store;
let engine: Engine;
let live: LiveVerifier;

afterEach(() => {
  live?.stop();
  engine?.stop();
});

interface Night {
  readonly fake: FakePayPal | null;
  readonly key: KeyPair;
  readonly reference: ReferenceStore;
  /** The chain's current answer; a test swaps it. */
  chain: RegistrationRead;
  /** How many times enrollment asked the chain. */
  chainReads: number;
  /** Offset added to the clock, to let a challenge lapse. */
  skew: number;
}

interface NightOptions {
  readonly credentials?: boolean;
  readonly signer?: SignerClient | null;
  readonly erc8004?: Erc8004Config | null;
  /** Defaults to erc8004 when a registration is passed, and local otherwise. */
  readonly identityMode?: IdentityMode;
  readonly bank?: ReferenceBank;
  readonly calibrateAs?: string;
  readonly enroll?: boolean;
  /** When false, the wallet is connected but the grant is not approved yet. */
  readonly approve?: boolean;
}

/** Wallet connected, budget approved, signer running — and, unless told otherwise, enrolled. */
async function night(options: NightOptions = {}): Promise<Night> {
  const fake = options.credentials === false ? null : fakePayPal();
  const key = generateKeyPair();
  const state: Night = {
    fake,
    key,
    reference: memoryReference(options.bank ?? CALIBRATED),
    chain: owned(CHAIN.expectedOwner),
    chainReads: 0,
    skew: 0,
  };

  store = openStore(':memory:');
  reseedDeck(store, keyring, fake ? 'live' : 'simulated');
  engine = new Engine(store, keyring, fake?.paypal ?? null, {
    appHash: 'app-under-test',
    candidates: fake ? [{ vaultId: 'VAULT1', source: 'configured' }] : [],
  });
  if (fake) await engine.refreshWallet();
  else engine.simulateWallet();
  if (options.approve !== false) expect(engine.approveGrant().ok).toBe(true);

  const now = (): number => Date.now() + state.skew;
  live = new LiveVerifier({
    store,
    engine,
    keyring,
    signer: options.signer === undefined ? localSigner(key, POLICY, now) : options.signer,
    erc8004: options.erc8004 ?? null,
    identityMode: options.identityMode ?? (options.erc8004 ? 'erc8004' : 'local'),
    readRegistration: async () => {
      state.chainReads += 1;
      return state.chain;
    },
    reference: state.reference,
    endpoint: 'http://127.0.0.1:8789/mcp',
    calibrateAs: options.calibrateAs ?? null,
    now,
    settleWaitMs: 500,
  });
  live.start();
  if (options.enroll !== false) expect((await live.enroll()).ok).toBe(true);
  return state;
}

const runIdOf = (outcome: ToolOutcome): string => {
  const id = outcome.data.run_id;
  if (typeof id !== 'string') throw new Error(`no run id in: ${outcome.text}`);
  return id;
};

const view = () => {
  const found = store.snapshot().live;
  if (!found) throw new Error('no live run');
  return found;
};

const requests = () => store.requests();

/** Begin, answer the challenge with a recognised reply, and stop at the signing challenge. */
function toSigning(input: Parameters<LiveVerifier['begin']>[0] = { amount: 8 }): string {
  const runId = runIdOf(live.begin(input));
  expect(live.submitReply(runId, matching()).ok).toBe(true);
  expect(view().stage).toBe('awaiting_signature');
  return runId;
}

/* ---------- Step 1 of the flow: a quote, a run, a challenge ---------- */

describe('begin_verification', () => {
  test('"the USD 8.00 item at the test merchant" is the grant’s first $8 quote, and opens a run at Layer 1', async () => {
    await night();
    const outcome = live.begin({ amount: 8 });

    expect(outcome.ok).toBe(true);
    expect(outcome.data.quote).toEqual({
      merchant: 'Kestrel Stock',
      item: 'Harbor at dawn',
      reference: 'KS-1041',
      amount: 'USD 8.00',
    });
    expect(outcome.data.stage).toBe('awaiting_reply');
    expect(outcome.text).toContain(PROBE_PROMPT);

    const run = view();
    expect(run.runId).toBe(runIdOf(outcome));
    expect(run.prompt).toBe(PROBE_PROMPT);
    expect(run.challengeExpiresAt).toBeGreaterThan(Date.now() + CHALLENGE_TTL_MS - 5_000);
    expect(run.reply).toBeNull();
    expect(run.nonce).toBeNull();
    expect(run.signature).toBe('pending');
    expect(run.paypal).toBeNull();
    expect(requests()).toHaveLength(0);
  });

  test('a quote can be named by reference, item or merchant, and an unknown one lists what the shop quotes', async () => {
    await night();
    expect(live.begin({ reference: 'ks-1042' }).data.quote).toMatchObject({ item: 'Night market' });
    expect(live.begin({ item: 'icon' }).data.quote).toMatchObject({ reference: 'KS-2001', amount: 'USD 5.00' });
    expect(live.begin({ merchant: 'lark prints', amount: 8 }).data.quote).toMatchObject({ reference: 'LP-0388' });

    // A price the catalog does not quote is a purchase at the authorized merchant, not a miss.
    const custom = live.begin({ amount: 3 });
    expect(custom.ok).toBe(true);
    expect(custom.data.quote).toMatchObject({ merchant: 'Kestrel Stock', amount: 'USD 3.00' });

    // A shop that was described rather than named is not guessed at: the answer says what there is.
    const described = live.begin({ merchant: 'the test merchant', amount: 8 });
    expect(described.ok).toBe(false);
    expect(described.text).toBe(
      'There is no merchant "the test merchant" in the test catalog. The buyer’s authorized merchant is Kestrel Stock; ' +
        'the catalog also lists Lark Prints. Leave `merchant` out to search the authorized one.',
    );
  });

  test('asking twice for the same item returns the same run, not a second one', async () => {
    await night();
    const first = runIdOf(live.begin({ amount: 8 }));
    const second = live.begin({ amount: 8, merchant: 'Kestrel Stock' });
    expect(runIdOf(second)).toBe(first);
    expect(second.text).toContain('already has an open run');
  });

  test('nothing starts before the wallet is connected and the grant approved', async () => {
    const fake = fakePayPal();
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'live');
    engine = new Engine(store, keyring, fake.paypal, { appHash: 'app-under-test', candidates: [] });
    await engine.refreshWallet();
    live = new LiveVerifier({
      store,
      engine,
      keyring,
      signer: null,
      erc8004: null,
      readRegistration: async () => owned(CHAIN.expectedOwner),
      reference: memoryReference(CALIBRATED),
    });

    const outcome = live.begin({ amount: 8 });
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('wallet');
    expect(store.snapshot().live).toBeNull();
  });

  test('a stated budget is what the buyer is asked to approve, and spend past it is refused', async () => {
    const { fake } = await night({ approve: false });
    const offered = live.begin({ budget: 6, currency: 'usd', amount: 8 });
    expect(offered.ok).toBe(false);
    expect(offered.text).toContain('USD 6.00');
    expect(store.grantView()?.budget).toBe(usd(6));
    expect(store.snapshot().live).toBeNull();

    const ready = await live.readiness();
    expect(ready.text).toContain('USD 6.00');

    expect(engine.approveGrant().ok).toBe(true);
    expect(store.grantView()?.status).toBe('active');
    expect(store.grantView()?.left).toBe(usd(6));

    const outcome = await live.signAndSubmit(toSigning());
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('buyer grant');
    expect(fake?.orders).toHaveLength(0);

    expect(live.begin({ budget: 40 }).ok).toBe(false);
    expect(store.grantView()?.budget).toBe(usd(6));
  });

  test('a budget in another currency, or above the cap, is refused and changes nothing', async () => {
    await night({ approve: false });
    expect(live.begin({ budget: 10, currency: 'EUR' }).text).toContain('Only USD');
    expect(live.begin({ budget: 20_000 }).ok).toBe(false);
    expect(store.grantView()?.budget).toBe(usd(20));
  });
});

/* ---------- Layer 1: the reply ---------- */

describe('submit_model_reply', () => {
  test('a recognised reply passes Layer 1 and is issued a one-time signing challenge for the same run', async () => {
    await night();
    const runId = runIdOf(live.begin({ amount: 8 }));
    const reply = matching();
    const outcome = live.submitReply(runId, reply);

    expect(outcome.ok).toBe(true);
    expect(outcome.data.stage).toBe('awaiting_signature');
    expect(outcome.data.layer1_model_signal).toMatchObject({
      result: 'match',
      received: PROBE.count,
      asked: PROBE.count,
      closest_reference: MODEL,
      expected_model: MODEL,
    });

    const run = view();
    expect(run.reply).toBe(reply);
    expect(run.signal?.result).toBe('match');
    expect(run.signal?.score ?? 0).toBeGreaterThanOrEqual(run.signal?.threshold ?? 1);
    expect(run.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(run.signExpiresAt).toBeGreaterThan(Date.now() + SIGN_TTL_MS - 5_000);
    // Layer 1 passing moves no money and creates no request.
    expect(requests()).toHaveLength(0);
  });

  test('a reply with too few integers is not scored and the run stays at Layer 1', async () => {
    const { fake } = await night();
    const runId = runIdOf(live.begin({ amount: 8 }));
    const outcome = live.submitReply(runId, csv(habitA(900).slice(0, 120)));

    expect(outcome.ok).toBe(false);
    expect(outcome.data.stage).toBe('awaiting_reply');
    expect(outcome.text).toContain('Received 120 of 294 integers');
    expect(view().signal).toMatchObject({ result: 'insufficient', received: 120, closest: null });
    expect(view().nonce).toBeNull();

    const signed = await live.signAndSubmit(runId);
    expect(signed.ok).toBe(false);
    expect(signed.text).toContain('Layer 1 has not passed');
    expect(requests()).toHaveLength(0);
    expect(fake?.orders).toHaveLength(0);
  });

  test('an unreadable reply can be sent again a few times, then the run closes at Layer 1', async () => {
    await night();
    const runId = runIdOf(live.begin({ amount: 8 }));

    for (let attempt = 1; attempt < MAX_UNREAD_REPLIES; attempt++) {
      expect(live.submitReply(runId, 'seven, eight, nine').data.stage).toBe('awaiting_reply');
    }
    // A readable reply still goes through while tries remain…
    const other = runIdOf(live.begin({ reference: 'KS-1042' }));
    live.submitReply(other, 'x');
    expect(live.submitReply(other, matching()).data.stage).toBe('awaiting_signature');

    // …and the last unreadable one closes the run.
    const closed = live.submitReply(runId, '1.5, 2.5');
    expect(closed.data.stage).toBe('model_not_matched');
    expect(live.submitReply(runId, matching()).data.stage).toBe('model_not_matched');
  });

  test('a scored reply that does not match is final: uniform random integers stay at Layer 1', async () => {
    const { fake } = await night();
    const runId = runIdOf(live.begin({ amount: 8 }));
    const outcome = live.submitReply(runId, uniform());

    expect(outcome.ok).toBe(false);
    expect(outcome.data.stage).toBe('model_not_matched');
    expect(outcome.data.layer1_model_signal).toMatchObject({ result: 'unknown', received: PROBE.count });
    expect(outcome.text).toContain('No signing challenge was issued and PayPal was not called.');
    expect(view().signature).toBe('skipped');
    expect(view().authorization).toBe('skipped');

    // No second try against the same challenge, however good the next reply.
    const again = live.submitReply(runId, matching());
    expect(again.ok).toBe(false);
    expect(again.text).toContain('already recorded');
    expect(view().signal?.result).toBe('unknown');
    expect((await live.signAndSubmit(runId)).ok).toBe(false);
    expect(fake?.orders).toHaveLength(0);
  });

  test('a reply that matches a different tested model is named as that model and does not pass', async () => {
    await night({ bank: bankOf('Other model', many(habitB, 8), CALIBRATED) });
    const runId = runIdOf(live.begin({ amount: 8 }));
    const outcome = live.submitReply(runId, csv(habitB(900)));

    expect(outcome.data.stage).toBe('model_not_matched');
    expect(outcome.data.layer1_model_signal).toMatchObject({
      result: 'other_model',
      closest_reference: 'Other model',
      expected_model: MODEL,
    });
  });

  test('with no calibrated reference nothing matches, and the result says how many samples there are', async () => {
    await night({ bank: bankOf(MODEL, many(habitA, MIN_SAMPLES - 1)) });
    const runId = runIdOf(live.begin({ amount: 8 }));
    const outcome = live.submitReply(runId, matching());

    expect(outcome.data.stage).toBe('model_not_matched');
    expect(outcome.data.layer1_model_signal).toMatchObject({ result: 'no_reference' });
    expect(view().signal?.note).toBe(`No calibrated reference for ${MODEL} yet: 4 of 5 samples recorded.`);

    await night({ bank: EMPTY_BANK });
    const empty = live.submitReply(runIdOf(live.begin({ amount: 8 })), matching());
    expect(empty.data.layer1_model_signal).toMatchObject({ result: 'no_reference', expected_model: null });
  });

  test('the same reply sent twice returns the recorded result; nothing is re-scored', async () => {
    await night();
    const runId = runIdOf(live.begin({ amount: 8 }));
    const reply = matching();
    live.submitReply(runId, reply);
    const nonce = view().nonce;

    const again = live.submitReply(runId, reply);
    expect(again.ok).toBe(true);
    expect(again.data.stage).toBe('awaiting_signature');
    expect(view().nonce).toBe(nonce);

    // A reply that did not match, sent again, is told the same thing again — not that it passed.
    const other = runIdOf(live.begin({ reference: 'KS-1042' }));
    const miss = uniform();
    expect(live.submitReply(other, miss).ok).toBe(false);
    const repeated = live.submitReply(other, miss);
    expect(repeated.ok).toBe(false);
    expect(repeated.data.stage).toBe('model_not_matched');
    expect(repeated.text).not.toContain('already recorded');
  });

  test('a reply for a run that does not exist, or that lapsed, is refused', async () => {
    const state = await night();
    expect(live.submitReply('no-such-run-id', matching()).ok).toBe(false);

    const runId = runIdOf(live.begin({ amount: 8 }));
    state.skew = CHALLENGE_TTL_MS + 1_000;
    const late = live.submitReply(runId, matching());
    expect(late.ok).toBe(false);
    expect(late.data.stage).toBe('expired');
    expect(late.text).toBe(
      'The numeric challenge expired before a reply arrived. Nothing was charged. Start again with begin_verification.',
    );
    expect(view().note).toBe('The numeric challenge expired before a reply arrived.');
    expect(view().reply).toBeNull();
  });

  test('calibration mode records a readable reply as a reference sample and never scores or signs it', async () => {
    const state = await night({ bank: EMPTY_BANK, calibrateAs: 'Grok Bot' });
    const runId = runIdOf(live.begin({ amount: 8 }));
    const outcome = live.submitReply(runId, matching());

    expect(outcome.data.stage).toBe('model_not_matched');
    expect(outcome.data.layer1_model_signal).toMatchObject({ result: 'recorded' });
    expect(state.reference.bank().models).toHaveLength(1);
    expect(state.reference.bank().models[0]?.samples[0]?.source).toBe(`run:${runId}`);
    expect(state.reference.status()).toMatchObject({ expected: 'Grok Bot', samples: 1, calibrated: false });
    expect(view().nonce).toBeNull();
    expect(store.snapshot().connector).toMatchObject({ calibratingAs: 'Grok Bot', referenceSamples: 1 });

    // An unreadable reply is not a sample.
    const second = runIdOf(live.begin({ reference: 'KS-1042' }));
    live.submitReply(second, 'not numbers');
    expect(state.reference.status().samples).toBe(1);
  });
});

/* ---------- Enrollment: the signer's key and its registration ---------- */

describe('enrolling the Demo Agent', () => {
  test('before enrollment the registry holds the scripted practice key, and a run stops at Layer 2', async () => {
    const { fake, key } = await night({ enroll: false });
    const enrollment = store.snapshot().enrollment;
    expect(enrollment).toMatchObject({ status: 'none', active: false, keyPrint: null });
    expect(store.registryEntry(DECK.registryId)?.key).not.toBe(key.publicKey);

    const outcome = await live.signAndSubmit(toSigning());
    expect(outcome.ok).toBe(false);
    expect(outcome.data.stage).toBe('identity_failed');
    expect(view().signatureNote).toBe('Deck Agent is not enrolled: no signer key is in the registry.');
    expect(requests()).toHaveLength(0);
    expect(fake?.orders).toHaveLength(0);
  });

  test('with no registration configured the key is enrolled locally, and that is a complete enrollment', async () => {
    const { key } = await night();
    const print = fingerprint(key.publicKey);
    expect(store.registryEntry(DECK.registryId)?.key).toBe(key.publicKey);
    expect(store.snapshot().enrollment).toMatchObject({
      status: 'local',
      identityMode: 'local',
      active: true,
      configured: false,
      network: null,
      blockNumber: null,
      keyPrint: print,
    });
    const ready = await live.readiness();
    expect(ready.data).toMatchObject({ ready: true, ready_to_record: true, missing: [], caveats: [] });
    expect(ready.text).toContain(`Local key enrolled (Ed25519, fingerprint ${print})`);
    expect(ready.text).not.toContain('ERC-8004');
  });

  test('a local enrollment stored before identity mode was recorded still counts as a local pass', async () => {
    await night();
    store.db.query('UPDATE agent_enrollment SET identity_mode = NULL WHERE registry_id = $id').run({ $id: DECK.registryId });
    live.stop();
    live.start();
    expect(store.snapshot().enrollment).toMatchObject({ status: 'local', identityMode: 'local', active: true });
    const ready = await live.readiness();
    expect(ready.data.caveats).toEqual([]);
    expect(ready.text).toContain('Local key enrolled (Ed25519, fingerprint');
    expect(ready.text).not.toContain('ERC-8004');
  });

  test('local identity mode counts the enrolled key as a full pass and does not read the chain', async () => {
    const state = await night({ identityMode: 'local', erc8004: CHAIN });
    const print = fingerprint(state.key.publicKey);
    expect(state.chainReads).toBe(0);
    expect(store.snapshot().enrollment).toMatchObject({
      status: 'local',
      identityMode: 'local',
      active: true,
      configured: false,
      network: null,
      agentId: null,
    });

    const ready = await live.readiness();
    expect(ready.data).toMatchObject({ ready: true, ready_to_record: true, caveats: [], missing: [] });
    expect(ready.text).toContain(`Local key enrolled (Ed25519, fingerprint ${print})`);
    expect(JSON.stringify(ready.data)).not.toContain('ERC-8004');

    const outcome = await live.signAndSubmit(toSigning());
    expect(outcome.data.stage).toBe('paid');
    expect(outcome.text).toContain(`Local key enrolled (Ed25519, fingerprint ${print})`);
    expect(outcome.text).toContain('request signature passed');
    expect(outcome.text).not.toContain('ERC-8004');
    expect(outcome.data.layer2_identity).toMatchObject({
      identity: `Local key enrolled (Ed25519, fingerprint ${print})`,
      erc8004_registration: null,
      request_signature: 'passed',
    });
    expect(view().signatureNote).toBe('Signed with AGT-DECK-1’s enrolled key; covers exactly $8 to Kestrel Stock, used once.');
  });

  test('a change of identity mode drops an enrollment made under the other mode', async () => {
    const state = await night({ erc8004: CHAIN });
    expect(store.snapshot().enrollment?.status).toBe('verified');
    const reads = state.chainReads;

    live.stop();
    live = new LiveVerifier({
      store,
      engine,
      keyring,
      signer: localSigner(state.key, POLICY, () => Date.now() + state.skew),
      erc8004: CHAIN,
      readRegistration: async () => {
        state.chainReads += 1;
        return state.chain;
      },
      reference: state.reference,
      identityMode: 'local',
      now: () => Date.now() + state.skew,
      settleWaitMs: 500,
    });
    live.start();

    expect(state.chainReads).toBe(reads);
    expect(store.snapshot().enrollment).toMatchObject({ status: 'none', identityMode: 'local', active: false });
    expect(store.snapshot().enrollment?.note).toContain('The identity check changed. Enroll again.');
    expect(store.registryEntry(DECK.registryId)?.key).not.toBe(state.key.publicKey);

    expect((await live.enroll()).ok).toBe(true);
    expect(state.chainReads).toBe(reads);
    expect(store.snapshot().enrollment).toMatchObject({ status: 'local', identityMode: 'local', active: true });
  });

  test('a registration owned by the expected wallet is verified, with the chain, contract, agent id and block', async () => {
    const { key } = await night({ erc8004: CHAIN });
    expect(store.registryEntry(DECK.registryId)?.key).toBe(key.publicKey);
    expect(store.snapshot().enrollment).toMatchObject({
      status: 'verified',
      active: true,
      configured: true,
      network: 'Base Sepolia',
      chainId: 84532,
      registry: CHAIN.registry,
      agentId: '42',
      owner: CHAIN.expectedOwner,
      expectedOwner: CHAIN.expectedOwner,
      blockNumber: 1_234_567,
      explorerUrl: CHAIN.explorerUrl,
      keyBinding: 'not_stated',
      note: null,
    });
    expect(store.snapshot().enrollment?.checkedAt).toBeGreaterThan(Date.now() - 5_000);
  });

  test('the owner is compared as an address, whatever its letter case', async () => {
    const state = await night({ erc8004: CHAIN, enroll: false });
    state.chain = owned(CHAIN.expectedOwner.toLowerCase());
    expect((await live.enroll()).ok).toBe(true);
    expect(store.snapshot().enrollment?.status).toBe('verified');
  });

  test('a registration owned by another wallet fails: the key is not enrolled and the actual owner is shown', async () => {
    const state = await night({ erc8004: CHAIN, enroll: false });
    const stranger = '0x9999999999999999999999999999999999999999';
    state.chain = owned(stranger);

    const outcome = await live.enroll();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(`Registration owner is ${stranger}; expected the team wallet ${CHAIN.expectedOwner}.`);
    expect(store.snapshot().enrollment).toMatchObject({ status: 'failed', active: false, owner: stranger });
    expect(store.registryEntry(DECK.registryId)?.key).not.toBe(state.key.publicKey);

    const run = await live.signAndSubmit(toSigning());
    expect(run.data.stage).toBe('identity_failed');
    expect(view().signatureNote).toContain('ERC-8004 registration check failed. Registration owner is');
    expect(requests()).toHaveLength(0);
    expect(state.fake?.orders).toHaveLength(0);
  });

  test('a mismatch found on refresh takes an enrolled key back out of the registry', async () => {
    const state = await night({ erc8004: CHAIN });
    expect(store.snapshot().enrollment?.active).toBe(true);

    state.chain = owned('0x9999999999999999999999999999999999999999');
    expect((await live.enroll()).ok).toBe(false);
    expect(store.snapshot().enrollment).toMatchObject({ status: 'failed', active: false });
    expect(store.registryEntry(DECK.registryId)?.key).not.toBe(state.key.publicKey);
  });

  test('a chain that cannot be read leaves the check unresolved, with the reason', async () => {
    const state = await night({ erc8004: CHAIN, enroll: false });
    state.chain = { kind: 'unreachable', reason: 'the RPC endpoint did not answer.' };

    expect((await live.enroll()).ok).toBe(false);
    expect(store.snapshot().enrollment).toMatchObject({
      status: 'unresolved',
      active: false,
      note: 'Could not read Base Sepolia: the RPC endpoint did not answer.',
    });
    expect((await live.signAndSubmit(toSigning())).data.stage).toBe('identity_failed');
  });

  test('a failed refresh leaves an earlier verified check standing, and says the refresh failed', async () => {
    const state = await night({ erc8004: CHAIN });
    state.chain = { kind: 'unreachable', reason: 'the RPC endpoint timed out.' };

    const outcome = await live.enroll();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('The earlier verified check stands.');
    const enrollment = store.snapshot().enrollment;
    expect(enrollment).toMatchObject({ status: 'verified', active: true, blockNumber: 1_234_567 });
    expect(enrollment?.note).toContain('Refresh failed at');
    expect(enrollment?.note).toContain('Showing the check from block 1234567.');
  });

  test('the wrong chain, and a registration that does not exist, both fail', async () => {
    const state = await night({ erc8004: CHAIN, enroll: false });
    state.chain = { kind: 'wrong_chain', chainId: 1 };
    await live.enroll();
    expect(store.snapshot().enrollment).toMatchObject({
      status: 'failed',
      note: 'The RPC endpoint is chain 1, not Base Sepolia (84532).',
    });

    state.chain = { kind: 'absent', blockNumber: 77, reason: 'the registry has no agent with that id.' };
    await live.enroll();
    expect(store.snapshot().enrollment).toMatchObject({ status: 'failed', blockNumber: 77 });
    expect(store.snapshot().enrollment?.note).toContain('Agent 42 is not registered');
  });

  test('a registration that names the signer’s key is bound to it; one that names another key fails', async () => {
    const state = await night({ erc8004: CHAIN, enroll: false });
    state.chain = owned(CHAIN.expectedOwner, state.key.publicKey);
    await live.enroll();
    expect(store.snapshot().enrollment).toMatchObject({ status: 'verified', keyBinding: 'matches' });

    state.chain = owned(CHAIN.expectedOwner, generateKeyPair().publicKey);
    await live.enroll();
    expect(store.snapshot().enrollment).toMatchObject({ status: 'failed', keyBinding: 'differs', active: false });

    // A registration file behind a link is not fetched, so nothing is known about the key it names.
    state.chain = { ...owned(CHAIN.expectedOwner), statedKey: undefined };
    await live.enroll();
    expect(store.snapshot().enrollment).toMatchObject({ status: 'verified', keyBinding: 'unreadable' });
  });

  test('a signer that cannot be reached leaves the enrollment unresolved; one for another agent fails', async () => {
    const away: SignerClient = {
      identity: async () => {
        throw new SignerUnavailable('The signer service did not answer.');
      },
      sign: async () => ({ ok: false, error: 'unreachable' }),
      prove: async () => {
        throw new SignerUnavailable('The signer service did not answer.');
      },
    };
    await night({ signer: away, enroll: false });
    expect((await live.enroll()).ok).toBe(false);
    expect(store.snapshot().enrollment).toMatchObject({ status: 'unresolved', active: false });
    expect(store.snapshot().connector).toMatchObject({ signer: 'unreachable' });

    const other = generateKeyPair();
    await night({ signer: localSigner(other, { ...POLICY, registryId: 'AGT-OTHER' }), enroll: false });
    expect((await live.enroll()).message).toBe(`The signer service is AGT-OTHER, not ${DECK.registryId}.`);
    expect(store.snapshot().enrollment?.status).toBe('failed');
  });

  test('a demo reset keeps the enrollment and puts the signer’s key back in the fresh registry', async () => {
    const { key } = await night({ erc8004: CHAIN });
    toSigning();

    engine.stop();
    reseedDeck(store, keyring, 'live');
    engine.start();
    // The seed wrote the scripted key; the run of the old night is gone.
    expect(store.registryEntry(DECK.registryId)?.key).not.toBe(key.publicKey);
    expect(store.snapshot().live).toBeNull();

    live.start();
    expect(store.registryEntry(DECK.registryId)?.key).toBe(key.publicKey);
    expect(store.snapshot().enrollment).toMatchObject({ status: 'verified', active: true, blockNumber: 1_234_567 });
  });

  test('once the signer holds the key, the scripted senders cannot sign as the agent — the impostor still can try', async () => {
    await night();
    expect(engine.sendFromBoard('agent').ok).toBe(false);
    expect(engine.sendFromBoard('other_shop').message).toContain('held by the signer service');
    expect(engine.buyNextImage().ok).toBe(false);

    const sends = store.snapshot().sends;
    expect(sends.find((s) => s.sender === 'agent')?.state).toBe('locked');
    expect(sends.find((s) => s.sender === 'impostor')?.state).toBe('ready');
    expect(engine.sendFromBoard('impostor').ok).toBe(true);
  });
});

/* ---------- Layers 2 and 3, and PayPal ---------- */

describe('sign_and_submit', () => {
  test('a valid signature under a verified registration, inside the grant: PayPal captures USD 8.00 once', async () => {
    const { fake } = await night({ erc8004: CHAIN });
    const runId = toSigning();
    const nonce = view().nonce;
    const outcome = await live.signAndSubmit(runId);

    expect(outcome.ok).toBe(true);
    expect(outcome.data.stage).toBe('paid');
    expect(outcome.data.payment).toEqual({
      provider: 'PayPal Sandbox',
      status: 'COMPLETED',
      amount: 'USD 8.00',
      order_id: 'ORDER1',
      capture_id: 'CAPTURE1',
      request_id: 'R-0001',
    });
    expect(outcome.data.budget).toEqual({ authorized: 'USD 20.00', left: 'USD 12.00', ask_threshold_pct: 50 });
    expect(outcome.text).toContain('PayPal Sandbox · COMPLETED · USD 8.00');
    expect(outcome.text).toContain('Order ID: ORDER1 · Capture ID: CAPTURE1');
    expect(outcome.text).toContain('Layer 3: Buyer authorization passed · within the approved $20 budget ($20 left).');
    expect(outcome.text).toContain('USD 12.00 of the USD 20.00 authorized budget is left.');

    expect(fake?.orders).toHaveLength(1);
    expect(fake?.orders[0]?.amount).toBe(usd(8));
    expect(fake?.orders[0]?.vaultId).toBe('VAULT1');

    const run = view();
    expect(run.stage).toBe('paid');
    expect(run.requestId).toBe('R-0001');
    expect(run.signature).toBe('passed');
    expect(run.signatureNote).toBe('Signed with AGT-DECK-1’s enrolled key; covers exactly $8 to Kestrel Stock, used once.');
    expect(run.authorization).toBe('passed');
    expect(run.authorizationLine).toBe('Buyer authorization passed · within the approved $20 budget ($20 left)');
    expect(run.paypal).toMatchObject({ outcome: 'captured', mode: 'live', orderId: 'ORDER1', captureId: 'CAPTURE1' });

    // The request the gate ruled on is the challenge this server issued, signed by the signer's key.
    const envelope = store.envelope('R-0001');
    expect(envelope?.nonce).toBe(nonce ?? '');
    expect(envelope?.agent).toEqual({ key: store.registryEntry(DECK.registryId)?.key ?? '', registryId: DECK.registryId });
    expect(envelope?.intent).toEqual({ amount: usd(8), receiver: 'Kestrel Stock', reference: 'KS-1041', scope: 'stock_images' });
    expect(envelope?.mandate.agentKey).toBe(envelope?.agent.key ?? '');
    expect(store.grantView()).toMatchObject({ spent: usd(8), left: usd(12) });
    expect(store.deckView().find((s) => s.reference === 'KS-1041')?.state).toBe('unlocked');
  });

  test('calling it again, or twice at once, returns the same attempt: one request, one PayPal order', async () => {
    const { fake } = await night();
    const runId = toSigning();

    const [a, b] = await Promise.all([live.signAndSubmit(runId), live.signAndSubmit(runId)]);
    const c = await live.signAndSubmit(runId);

    for (const outcome of [a, b, c]) {
      expect(outcome.data.stage).toBe('paid');
      expect(outcome.data.payment).toMatchObject({ order_id: 'ORDER1', capture_id: 'CAPTURE1', request_id: 'R-0001' });
    }
    expect(requests()).toHaveLength(1);
    expect(fake?.orders).toHaveLength(1);
  });

  test('beginning the same item again after it is paid returns its receipt and starts nothing', async () => {
    const { fake } = await night();
    const runId = toSigning();
    await live.signAndSubmit(runId);

    const again = live.begin({ amount: 8 });
    expect(runIdOf(again)).toBe(runId);
    expect(again.data.stage).toBe('paid');
    expect(again.text).toContain('already bought in this session');
    expect(fake?.orders).toHaveLength(1);
  });

  test('a challenge already submitted is found by its nonce, never signed a second time', async () => {
    const { fake } = await night();
    const runId = toSigning();
    await live.signAndSubmit(runId);

    // As if the first call had been cut off before it recorded the request.
    store.patchLiveRun(runId, { stage: 'signing', request_id: null });
    const outcome = await live.signAndSubmit(runId);
    expect(outcome.data.payment).toMatchObject({ request_id: 'R-0001', order_id: 'ORDER1' });
    expect(requests()).toHaveLength(1);
    expect(fake?.orders).toHaveLength(1);
  });

  test('a signer whose key changed since enrollment refuses: the grant names the enrolled key, not its own', async () => {
    const state = await night();
    live.stop();
    live = new LiveVerifier({
      store,
      engine,
      keyring,
      signer: localSigner(generateKeyPair(), POLICY),
      erc8004: null,
      readRegistration: async () => state.chain,
      reference: state.reference,
      settleWaitMs: 500,
    });

    const outcome = await live.signAndSubmit(toSigning());
    expect(outcome.data.stage).toBe('identity_failed');
    expect(view().signatureNote).toBe('The signer refused: the buyer grant was issued to a different key.');
    expect(requests()).toHaveLength(0);
    expect(state.fake?.orders).toHaveLength(0);
  });

  test('a wrong key that signs anyway fails identity at the gate, and PayPal is not called', async () => {
    const state = await night();
    const stranger = generateKeyPair();
    const enrolledKey = store.registryEntry(DECK.registryId)?.key;
    live.stop();
    live = new LiveVerifier({
      store,
      engine,
      keyring,
      // Signs exactly the challenge it is given, with a key nobody enrolled.
      signer: {
        identity: async () => ({ registryId: DECK.registryId, publicKey: stranger.publicKey }),
        sign: async (challenge) => ({
          ok: true,
          publicKey: stranger.publicKey,
          signature: signEnvelope({
            id: '',
            origin: 'agent',
            registryId: challenge.registryId,
            mandate: challenge.mandate,
            intent: challenge.intent,
            expiresAtMs: challenge.expiresAtMs,
            agentSecret: stranger.secret,
            nonce: challenge.nonce,
          }).signature,
        }),
        prove: async () => ({ ok: false, error: 'not used' }),
      },
      erc8004: null,
      readRegistration: async () => state.chain,
      reference: state.reference,
      settleWaitMs: 500,
    });

    const outcome = await live.signAndSubmit(toSigning());
    expect(outcome.ok).toBe(false);
    expect(outcome.data.stage).toBe('identity_failed');
    expect(outcome.text).toContain('Refused at Layer 2');
    expect(outcome.text).toContain('PayPal was not called');

    const run = view();
    expect(run.signature).toBe('failed');
    expect(run.signatureNote).toBe('Not signed with AGT-DECK-1’s enrolled key.');
    expect(run.authorization).toBe('skipped');
    expect(run.paypal).toMatchObject({ outcome: 'not_called' });
    expect(store.registryEntry(DECK.registryId)?.key).toBe(enrolledKey ?? '');
    expect(store.request('R-0001')).toMatchObject({ status: 'blocked', verdict: 'DENY', lamp: 'AGENT_IDENTITY' });
    expect(state.fake?.orders).toHaveLength(0);
  });

  test('a paid request cannot be presented again, and its signature does not stretch to another quote', async () => {
    const { fake } = await night();
    await live.signAndSubmit(toSigning());
    const { id: _id, ...parts } = store.envelope('R-0001') as Envelope;

    // The same envelope again: its image is bought, so it never reaches the gate.
    const replay = engine.submitSigned(parts, 'replay');
    expect(replay.ok).toBe(false);
    expect(replay.message).toContain('already bought');
    expect(replay.requestId).toBeNull();

    // The same signature over an edited quote reaches the gate and is denied:
    // it does not cover these bytes, and its nonce has been seen.
    const edited = engine.submitSigned({ ...parts, intent: { ...parts.intent, reference: 'KS-1042' } }, 'edited replay');
    expect(edited.requestId).toBe('R-0002');
    expect(store.gateRun('R-0002').find((c) => c.check === 'INTENT_BINDING')?.outcome).toBe('fail');
    expect(store.request('R-0002')).toMatchObject({ status: 'blocked', verdict: 'DENY' });
    expect(fake?.orders).toHaveLength(1);
  });

  test('the same signed envelope presented at the gate twice is denied the second time on the nonce', async () => {
    const { fake, key } = await night();
    const runId = toSigning({ merchant: OTHER_MERCHANT, amount: 8 });
    await live.signAndSubmit(runId);
    const first = store.envelope('R-0001') as Envelope;
    expect(first.agent.key).toBe(key.publicKey);

    const { id: _id, ...parts } = first;
    const again = engine.submitSigned(parts, 'replay');
    expect(again.requestId).toBe('R-0002');
    const binding = store.gateRun('R-0002').find((c) => c.check === 'INTENT_BINDING');
    expect(binding).toMatchObject({ outcome: 'fail', note: `nonce ${first.nonce} has been used before` });
    expect(fake?.orders).toHaveLength(0);
  });

  test('a signing challenge that lapses is never signed', async () => {
    const state = await night();
    const runId = toSigning();
    state.skew = SIGN_TTL_MS + 1_000;

    const outcome = await live.signAndSubmit(runId);
    expect(outcome.ok).toBe(false);
    expect(outcome.data.stage).toBe('expired');
    expect(view().note).toBe('The signing challenge expired before it was signed.');
    expect(requests()).toHaveLength(0);
    expect(state.fake?.orders).toHaveLength(0);
  });

  test('a signer that is away leaves the challenge open; one that refuses stops the run', async () => {
    const state = await night();
    let mode: 'away' | 'refuse' | 'sign' = 'away';
    const real = localSigner(state.key, POLICY);
    live.stop();
    live = new LiveVerifier({
      store,
      engine,
      keyring,
      signer: {
        identity: real.identity,
        async sign(challenge) {
          if (mode === 'away') throw new SignerUnavailable('The signer service did not answer.');
          if (mode === 'refuse') return { ok: false, error: 'the amount is over this signer’s limit' };
          return real.sign(challenge);
        },
        prove: (proof) => real.prove(proof),
      },
      erc8004: null,
      readRegistration: async () => state.chain,
      reference: state.reference,
      endpoint: 'http://127.0.0.1:8789/mcp',
      settleWaitMs: 500,
    });

    const runId = toSigning();
    const away = await live.signAndSubmit(runId);
    expect(away.ok).toBe(false);
    expect(away.data.stage).toBe('awaiting_signature');
    expect(away.text).toContain('the challenge is still open');
    expect(store.snapshot().connector).toMatchObject({ signer: 'unreachable' });

    mode = 'sign';
    expect((await live.signAndSubmit(runId)).data.stage).toBe('paid');
    expect(store.snapshot().connector).toMatchObject({ signer: 'reachable' });

    mode = 'refuse';
    const refused = await live.signAndSubmit(toSigning({ reference: 'KS-1042' }));
    expect(refused.data.stage).toBe('identity_failed');
    expect(view().signatureNote).toBe('The signer refused: the amount is over this signer’s limit.');
    expect(state.fake?.orders).toHaveLength(1);
  });

  test('the real agent at a shop the grant does not cover passes identity and fails authorization', async () => {
    const { fake } = await night();
    const outcome = await live.signAndSubmit(toSigning({ merchant: OTHER_MERCHANT, amount: 8 }));

    expect(outcome.data.stage).toBe('authorization_failed');
    expect(outcome.text).toContain('Refused at Layer 3');
    const run = view();
    expect(run.signature).toBe('passed');
    expect(run.authorization).toBe('failed');
    expect(run.authorizationLine).toBe('Buyer authorization failed · the grant covers Kestrel Stock, not Lark Prints');
    expect(run.paypal).toMatchObject({ outcome: 'not_called' });
    expect(fake?.orders).toHaveLength(0);
  });

  test('USD 20.00 → 12.00, the second USD 8.00 asks, then the USD 5.00 item is refused', async () => {
    const { fake } = await night();
    await live.signAndSubmit(toSigning({ reference: 'KS-1041' }));
    expect(store.grantView()?.left).toBe(usd(12));
    const second = toSigning({ reference: 'KS-1042' });
    const asked = await live.signAndSubmit(second);
    expect(asked.data.stage).toBe('needs_buyer');
    expect(asked.data.needs_buyer_approval).toBe(true);
    expect(asked.text).toContain('ask threshold');
    expect(fake?.orders).toHaveLength(1);
    expect(engine.decideLivePurchase(second, 'approve').ok).toBe(true);
    expect((await live.signAndSubmit(second)).data.stage).toBe('paid');
    expect(store.grantView()?.left).toBe(usd(4));

    const third = await live.signAndSubmit(toSigning({ reference: 'KS-2001' }));
    expect(third.ok).toBe(false);
    expect(third.data.stage).toBe('authorization_failed');
    expect(third.data.layer3_authorization).toMatchObject({ result: 'failed' });
    expect(third.text).toContain('would exceed budget: $16 spent, $4 left');
    expect(third.text).toContain('PayPal was not called');
    expect(view().authorization).toBe('failed');
    expect(fake?.orders).toHaveLength(2);
  });

  test('a revoked agent is still heard, and refused at identity', async () => {
    const { fake } = await night();
    const runId = toSigning();
    expect(engine.revokeAgent().ok).toBe(true);

    const outcome = await live.signAndSubmit(runId);
    expect(outcome.data.stage).toBe('identity_failed');
    expect(view().signatureNote).toBe('AGT-DECK-1 was revoked by the buyer.');
    expect(fake?.orders).toHaveLength(0);
  });

  test('a charge PayPal has not confirmed is pending, then unconfirmed — never paid', async () => {
    const { fake } = await night();
    if (fake) fake.answer = 'pending';
    const runId = toSigning();
    const outcome = await live.signAndSubmit(runId);

    expect(outcome.data.stage).toBe('payment_unconfirmed');
    expect(outcome.data.payment).toMatchObject({ status: 'UNCONFIRMED', capture_id: null });
    expect(outcome.text).toContain('It is not paid until PayPal says so.');
    expect(live.status(runId).data.stage).toBe('payment_unconfirmed');
  });

  test('PayPal asking for the buyer is not a payment', async () => {
    const { fake } = await night();
    if (fake) fake.answer = 'buyer_action';
    const outcome = await live.signAndSubmit(toSigning());

    expect(outcome.ok).toBe(false);
    expect(outcome.data.stage).toBe('payment_failed');
    expect(outcome.data.payment).toMatchObject({ status: 'BUYER_ACTION_REQUIRED', capture_id: null });
    expect(store.grantView()?.left).toBe(usd(20));
  });

  test('without PayPal credentials every check runs and the result is SIMULATED, never COMPLETED', async () => {
    await night({ credentials: false });
    const outcome = await live.signAndSubmit(toSigning());

    expect(outcome.data.stage).toBe('simulated');
    expect(outcome.data.payment).toMatchObject({
      provider: 'Simulated (no PayPal credentials)',
      status: 'SIMULATED',
      order_id: null,
      capture_id: null,
    });
    expect(outcome.text).toContain('Do not report this as paid.');
    expect(outcome.text).not.toContain('COMPLETED');
    expect(view().stage).toBe('simulated');
  });
});

/* ---------- Reading a run, and the connector itself ---------- */

describe('get_purchase_status and get_connector_status', () => {
  test('status reports the same run the page shows, at every stage', async () => {
    await night({ erc8004: CHAIN });
    const runId = runIdOf(live.begin({ amount: 8 }));
    expect(live.status(runId).data.stage).toBe('awaiting_reply');

    live.submitReply(runId, matching());
    expect(live.status(runId).data.stage).toBe('awaiting_signature');

    await live.signAndSubmit(runId);
    const done = live.status(runId);
    expect(done.data.stage).toBe(view().stage);
    expect(done.data.final).toBe(true);
    expect(done.data.layer2_identity).toMatchObject({
      erc8004_registration: 'verified (Base Sepolia, agent 42, block 1234567)',
      network: 'Base Sepolia',
      registry_contract: CHAIN.registry,
      agent_id: '42',
      request_signature: 'passed',
    });
    expect(live.status('no-such-run-id').ok).toBe(false);
  });

  test('readiness lists exactly what is missing, and says ready only when nothing is', async () => {
    await night({ erc8004: CHAIN });
    const ready = await live.readiness();
    expect(ready.data).toMatchObject({ ready: true, ready_to_record: true, missing: [], caveats: [], signer: 'reachable' });
    expect(ready.text).toContain('ready for a live run');

    // A simulated wallet can rehearse. A local key is a full enrollment, so it is not a caveat.
    await night({ credentials: false });
    const rehearsal = await live.readiness();
    expect(rehearsal.data).toMatchObject({ ready: true, ready_to_record: false, missing: [] });
    expect(rehearsal.data.caveats).toEqual([
      'no PayPal credentials on this server, so a charge is simulated and never a Sandbox capture',
    ]);
    expect(rehearsal.text).toContain('ready for a rehearsal run. Not ready to record');
    expect(rehearsal.text).not.toContain('ERC-8004');

    // erc8004 mode still withholds "verified" until a registration checks out.
    await night({ credentials: false, identityMode: 'erc8004' });
    const unchecked = await live.readiness();
    expect(unchecked.data).toMatchObject({ ready: true, ready_to_record: false, missing: [] });
    expect(unchecked.data.caveats).toEqual([
      'no PayPal credentials on this server, so a charge is simulated and never a Sandbox capture',
      'no ERC-8004 registration is configured, so the agent’s registration cannot be shown as verified',
    ]);

    await night({ bank: EMPTY_BANK, enroll: false });
    const not = await live.readiness();
    expect(not.data.ready).toBe(false);
    expect(not.data.missing).toEqual([
      'the agent’s enrollment is not enrolled',
      'no model reference has been recorded yet',
    ]);
  });

  test('the page is told who called last and how far calibration is — and never a token or a key', async () => {
    const { key } = await night();
    live.heard('get_connector_status');
    const connector = store.snapshot().connector;
    expect(connector).toMatchObject({
      endpoint: 'http://127.0.0.1:8789/mcp',
      lastTool: 'get_connector_status',
      expectedModel: MODEL,
      referenceSamples: 8,
      referenceNeeded: MIN_SAMPLES,
      calibrated: true,
      calibratingAs: null,
    });

    await live.signAndSubmit(toSigning());
    const everything = JSON.stringify(store.snapshot());
    expect(everything).not.toContain(key.secret.d);
    expect(everything).not.toContain('VAULT1');
  });

  test('a server that is not serving the connector publishes no connector state', async () => {
    await night();
    live.serving(null);
    expect(store.snapshot().connector).toBeNull();
  });
});

/* ---------- Layer 2 on the page: a proof, and the signed payload ---------- */

describe('identity proof', () => {
  test('a nonce is signed and verified against the enrolled key, and PayPal is not called', async () => {
    const { fake } = await night();
    const before = store.requests().length;
    const proof = await live.proveIdentity();
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    expect(proof.verified).toBe(true);
    expect(proof.result).toBe('verified');
    expect(proof.nonce.length).toBeGreaterThanOrEqual(16);
    expect(proof.signature.length).toBeGreaterThan(20);
    expect(proof.fingerprint).toBe(store.snapshot().enrollment?.keyPrint ?? '');
    expect(store.requests()).toHaveLength(before);
    expect(fake?.orders ?? []).toHaveLength(0);
  });

  test('a signed run shows the payload Layer 2 draws, and a signer refusal has no signature', async () => {
    const { fake } = await night();
    await live.signAndSubmit(toSigning());
    const signed = view().signed;
    if (!signed) throw new Error('the purchase was not signed');
    expect(signed.verified).toBe(true);
    expect(signed.merchant).toBe('Kestrel Stock');
    expect(signed.item).toBe('Harbor at dawn');
    expect(signed.amount).toBe(usd(8));
    expect(signed.grantCap).toBe(usd(20));
    expect(signed.signature.length).toBeGreaterThan(20);
    expect(fake?.orders).toHaveLength(1);

    live.stop();
    engine.stop();
    await night({ approve: false });
    expect(engine.approveGrant(usd(4)).ok).toBe(true);
    const refused = await live.signAndSubmit(toSigning());
    expect(refused.data.stage).toBe('identity_failed');
    expect(refused.text).toContain('amount is over the buyer grant');
    expect(view().signed).toBeNull();
  });
});

/* ---------- What the amounts are made of ---------- */

test('amounts stay integer cents from the catalog to the signed intent', async () => {
  await night();
  await live.signAndSubmit(toSigning({ reference: 'KS-2001' }));
  const amount: Cents | undefined = store.envelope('R-0001')?.intent.amount;
  expect(amount).toBe(usd(5));
  expect(Number.isInteger(amount)).toBe(true);
});
