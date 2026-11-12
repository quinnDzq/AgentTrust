/// <reference types="bun" />
/**
 * The live view's wording rules, on their own.
 *
 * Three matter most. An ERC-8004 registration reads "verified" only when the
 * server recorded it as verified. A local Ed25519 enrollment is a full pass
 * and does not mention ERC-8004. The receipt says COMPLETED only for a capture
 * PayPal confirmed in live Sandbox mode. And the preflight says ready only
 * when every part of a live run is in place — in erc8004 mode a key enrolled
 * without its registration checked is enough to rehearse, and not enough to
 * call ready.
 *
 * Run with `bun test`. TypeScript 6 loads no @types package unasked, hence the
 * reference above: Bun's types for this file, none for the page.
 */

import { describe, expect, test } from 'bun:test';
import {
  usd,
  type ConnectorView,
  type EnrollmentView,
  type GrantView,
  type LiveRunView,
  type LiveStage,
  type ModelSignalView,
  type PayPalView,
  type VerificationSnapshot,
  type WalletView,
} from '@app/types.ts';
import {
  activeLayer,
  authorizationOf,
  budgetRefusal,
  modelLine,
  preflightOf,
  receiptOf,
  registrationRow,
  shortAddress,
  signatureRow,
  stampOf,
} from './live';

/* ---------- Fixtures: a run as the server reports it ---------- */

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const OWNER = '0x00000000000000000000000000000000000a11ce';

const enrollment = (over: Partial<EnrollmentView> = {}): EnrollmentView => ({
  status: 'verified',
  identityMode: 'erc8004',
  registryId: 'AGT-DECK-1',
  agentName: 'Deck Agent',
  keyPrint: 'f80e7178',
  publicKey: 'ZW5yb2xsZWQta2V5LWZvci10aGUtdGVzdA',
  active: true,
  configured: true,
  network: 'Base Sepolia',
  chainId: 84532,
  registry: REGISTRY,
  agentId: '42',
  owner: OWNER,
  expectedOwner: OWNER,
  keyBinding: 'not_stated',
  blockNumber: 57_790_696,
  checkedAt: 1_794_480_000_000,
  explorerUrl: `https://sepolia.basescan.org/nft/${REGISTRY}/42`,
  note: null,
  ...over,
});

const wallet = (over: Partial<WalletView> = {}): WalletView => ({
  state: 'connected',
  mode: 'live',
  source: 'consent',
  note: null,
  canRecheck: true,
  ...over,
});

const grant = (over: Partial<GrantView> = {}): GrantView => ({
  principal: 'Sandbox buyer',
  merchant: 'Kestrel Stock',
  registryId: 'AGT-DECK-1',
  keyPrint: 'f80e7178',
  budget: usd(20),
  spent: usd(0),
  reserved: usd(0),
  left: usd(20),
  askThresholdPct: 50,
  until: 'end of tonight',
  status: 'active',
  approved: true,
  pendingBudgetRequest: null,
  ...over,
});

const connector = (over: Partial<ConnectorView> = {}): ConnectorView => ({
  endpoint: 'http://127.0.0.1:8789/mcp',
  lastCallAt: 1_794_480_000_000,
  lastTool: 'get_connector_status',
  signer: 'reachable',
  signerNote: null,
  expectedModel: 'Grok Bot',
  referenceSamples: 8,
  referenceNeeded: 5,
  calibrated: true,
  calibratingAs: null,
  ...over,
});

const signal = (over: Partial<ModelSignalView> = {}): ModelSignalView => ({
  result: 'match',
  probe: 'numeric-294-355/v1',
  received: 294,
  asked: 294,
  expectedModel: 'Grok Bot',
  closest: 'Grok Bot',
  score: 0.89,
  threshold: 0.86,
  candidates: [
    { label: 'Grok Bot', score: 0.89, threshold: 0.86, samples: 8, synthetic: false },
    { label: 'Uniform random baseline', score: 0.76, threshold: null, samples: 24, synthetic: true },
  ],
  note: 'Matches the Grok Bot reference: 0.89, at or above its calibrated 0.86.',
  ...over,
});

const paypal = (over: Partial<PayPalView> = {}): PayPalView => ({
  outcome: 'captured',
  mode: 'live',
  amount: usd(8),
  orderId: '5XJ12345AB678901C',
  captureId: '8AB98765CD432109E',
  note: null,
  ...over,
});

const run = (over: Partial<LiveRunView> = {}): LiveRunView => ({
  runId: '3f0c9a52-0000-4000-8000-000000000001',
  stage: 'paid',
  quote: { merchant: 'Kestrel Stock', reference: 'KS-1041', item: 'Harbor at dawn', amount: usd(8) },
  createdAt: 1_794_480_000_000,
  updatedAt: 1_794_480_060_000,
  prompt: 'Choose 294 integers from 1 through 355 by first instinct.',
  challengeExpiresAt: 1_794_480_600_000,
  reply: '12, 250, 87',
  signal: signal(),
  nonce: 'bm9uY2Utbm9uY2Ux',
  signExpiresAt: 1_794_480_300_000,
  requestId: 'R-0001',
  signature: 'passed',
  signatureNote: 'Signed with AGT-DECK-1’s enrolled key; covers exactly $8 to Kestrel Stock, used once.',
  authorization: 'passed',
  authorizationLine: 'Buyer authorization passed · USD 8.00 of USD 20.00',
  verdict: 'ALLOW',
  summary: null,
  paypal: paypal(),
  note: null,
  signed: null,
  ...over,
});

const snap = (over: Partial<VerificationSnapshot>): VerificationSnapshot =>
  ({ seq: 1, wallet: wallet(), grant: grant(), enrollment: enrollment(), connector: connector(), live: null, ...over });

const STAGES: readonly LiveStage[] = [
  'awaiting_reply',
  'model_not_matched',
  'awaiting_signature',
  'expired',
  'verifying',
  'identity_failed',
  'authorization_failed',
  'needs_buyer',
  'charging',
  'paid',
  'simulated',
  'payment_failed',
  'payment_unconfirmed',
];

/* ---------- Preflight ---------- */

describe('preflight', () => {
  test('ready only when every part of a live run is in place', () => {
    const all = preflightOf(snap({}));
    expect(all?.ready).toBe(true);
    expect(all?.items.map((item) => item.key)).toEqual(['wallet', 'grant', 'enrollment', 'signer', 'reference', 'connector']);
    expect(all?.items.every((item) => item.state === 'ok')).toBe(true);
    expect(all?.items.find((item) => item.key === 'enrollment')?.detail).toBe(
      'ERC-8004 registration verified · Base Sepolia · agent 42 · block 57790696.',
    );
  });

  test('each missing part is named, in the order it is set up', () => {
    const none = preflightOf(
      snap({
        wallet: wallet({ state: 'none' }),
        grant: grant({ status: 'needs_wallet' }),
        enrollment: enrollment({ status: 'none', active: false, keyPrint: null, blockNumber: null }),
        connector: connector({ signer: 'not_checked', expectedModel: null, referenceSamples: 0, calibrated: false, lastCallAt: null, lastTool: null }),
      }),
    );
    expect(none?.ready).toBe(false);
    expect(none?.items.map((item) => item.state)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(none?.items.find((item) => item.key === 'connector')?.detail).toBe(
      'Listening at http://127.0.0.1:8789/mcp. No client has called yet.',
    );
  });

  test('a local key enrollment is a complete preflight step and does not mention ERC-8004', () => {
    const local = preflightOf(
      snap({
        enrollment: enrollment({
          status: 'local',
          identityMode: 'local',
          configured: false,
          network: null,
          chainId: null,
          registry: null,
          agentId: null,
          owner: null,
          expectedOwner: null,
          keyBinding: null,
          blockNumber: null,
          explorerUrl: null,
        }),
      }),
    );
    expect(local?.ready).toBe(true);
    const item = local?.items.find((i) => i.key === 'enrollment');
    expect(item).toMatchObject({
      state: 'ok',
      detail: 'Local key enrolled (Ed25519, fingerprint f80e7178).',
    });
    expect(item?.detail).not.toContain('ERC-8004');
  });

  test('in erc8004 mode a key enrolled with no registration checked can rehearse, and is not ready', () => {
    const local = preflightOf(
      snap({
        enrollment: enrollment({
          status: 'local',
          identityMode: 'erc8004',
          configured: false,
          network: null,
          agentId: null,
          blockNumber: null,
        }),
      }),
    );
    expect(local?.ready).toBe(false);
    const item = local?.items.find((i) => i.key === 'enrollment');
    expect(item?.state).toBe('todo');
    expect(item?.detail).toBe('Signer key enrolled. No ERC-8004 registration is configured to check.');
    expect(item?.detail).not.toContain('verified');
  });

  test('a simulated wallet can rehearse, and is not ready either', () => {
    const simulated = preflightOf(snap({ wallet: wallet({ mode: 'simulated', source: 'simulated' }) }));
    expect(simulated?.ready).toBe(false);
    expect(simulated?.items.find((item) => item.key === 'wallet')).toMatchObject({
      state: 'todo',
      detail: 'Simulated: no PayPal credentials on this server, so nothing is charged.',
    });
  });

  test('a failed registration, a signer that is away and calibration mode are problems, with the actual reason', () => {
    const owner = 'Registration owner is 0x9999999999999999999999999999999999999999; expected the team wallet 0xabc.';
    const bad = preflightOf(
      snap({
        enrollment: enrollment({ status: 'failed', active: false, note: owner }),
        connector: connector({ signer: 'unreachable', signerNote: 'The signer service did not answer.', calibratingAs: 'Grok Bot', referenceSamples: 3, calibrated: false }),
      }),
    );
    const of = (key: string) => bad?.items.find((item) => item.key === key);
    expect(of('enrollment')).toMatchObject({ state: 'problem', detail: owner });
    expect(of('signer')).toMatchObject({ state: 'problem', detail: 'The signer service did not answer.' });
    expect(of('reference')?.state).toBe('problem');
    expect(of('reference')?.detail).toContain('recorded as Grok Bot (3 of 5) and not scored');
  });

  test('too few recorded replies says nothing can match yet', () => {
    const thin = preflightOf(snap({ connector: connector({ referenceSamples: 2, calibrated: false }) }));
    expect(thin?.items.find((item) => item.key === 'reference')).toMatchObject({
      state: 'todo',
      detail: 'Grok Bot · 2 of 5 recorded replies. Nothing can match yet.',
    });
  });

  test('no connector on this server is a problem; outside the deck scene there is no preflight', () => {
    expect(preflightOf(snap({ connector: null }))?.items.find((item) => item.key === 'connector')?.state).toBe('problem');
    expect(preflightOf(snap({ enrollment: null }))).toBeNull();
  });
});

/* ---------- The stamp ---------- */

describe('the stamp', () => {
  test('every stage has one, and only a confirmed live capture is stamped PAID', () => {
    const words = STAGES.map((stage) => stampOf(stage).word);
    expect(new Set(words).size).toBe(STAGES.length);
    expect(STAGES.filter((stage) => stampOf(stage).word === 'PAID')).toEqual(['paid']);
    expect(stampOf('simulated')).toEqual({ word: 'SIMULATED', tone: 'sim' });
    expect(stampOf('payment_unconfirmed').tone).toBe('pending');
    expect(stampOf('charging').tone).toBe('pending');
  });

  test('a stopped run says which layer stopped it', () => {
    expect(stampOf('model_not_matched').word).toBe('STOPPED AT LAYER 1');
    expect(stampOf('identity_failed').word).toBe('REFUSED AT LAYER 2');
    expect(stampOf('authorization_failed').word).toBe('REFUSED AT LAYER 3');
    expect(STAGES.map(activeLayer).every((layer) => layer >= 1 && layer <= 4)).toBe(true);
    expect(activeLayer('awaiting_signature')).toBe(2);
    expect(activeLayer('paid')).toBe(4);
  });
});

/* ---------- Layer 1 ---------- */

describe('the model signal', () => {
  test('a match shows the count and the closest reference from this run', () => {
    const line = modelLine(run());
    expect(line).toMatchObject({ mark: 'pass', count: '294 of 294 integers received' });
    expect(line.closest?.label).toBe('Grok Bot');
    expect(line.headline).toContain('Matches the Grok Bot reference');
  });

  test('a reply that was not scored keeps waiting while the challenge is open, and fails once it is closed', () => {
    const short = signal({ result: 'insufficient', received: 120, closest: null, score: null, threshold: null, candidates: [], note: 'Received 120 of 294 integers; at least 265 are needed to score.' });
    expect(modelLine(run({ stage: 'awaiting_reply', signal: short }))).toMatchObject({
      mark: 'wait',
      count: '120 of 294 integers received',
      closest: null,
    });
    expect(modelLine(run({ stage: 'model_not_matched', signal: short })).mark).toBe('fail');
  });

  test('unknown, another model and no reference all fail, and none is worded as a match', () => {
    for (const result of ['unknown', 'other_model', 'no_reference'] as const) {
      const line = modelLine(run({ stage: 'model_not_matched', signal: signal({ result, note: `result ${result}` }) }));
      expect(line.mark).toBe('fail');
    }
    expect(modelLine(run({ stage: 'model_not_matched', signal: signal({ result: 'recorded', note: 'Recorded as a reference sample.' }) })).mark).toBe('ask');
  });

  test('before any reply it waits; after the challenge lapsed it says so', () => {
    expect(modelLine(run({ stage: 'awaiting_reply', signal: null, reply: null }))).toMatchObject({ mark: 'wait', count: null });
    expect(modelLine(run({ stage: 'expired', signal: null, reply: null, note: 'The numeric challenge expired before a reply arrived.' }))).toMatchObject({
      mark: 'fail',
      headline: 'The numeric challenge expired before a reply arrived.',
    });
  });
});

/* ---------- Layer 2 ---------- */

describe('the certificate', () => {
  test('a verified registration says so, with the testnet, the registry contract and the actual agent id', () => {
    const row = registrationRow(enrollment());
    expect(row.mark).toBe('pass');
    expect(row.title).toBe('ERC-8004 registration verified');
    expect(row.facts).toEqual([
      { label: 'Testnet', value: 'Base Sepolia · chain 84532' },
      { label: 'Registry contract', value: REGISTRY },
      { label: 'Agent ID', value: '42', href: `https://sepolia.basescan.org/nft/${REGISTRY}/42` },
      { label: 'Owner', value: OWNER },
      { label: 'Checked at', value: expect.stringContaining('block 57790696') },
    ]);
  });

  test('"verified" is never said of anything else', () => {
    const others: EnrollmentView[] = [
      enrollment({ status: 'local', configured: false }),
      enrollment({ status: 'failed', active: false, note: 'Registration owner is 0x99…; expected the team wallet 0xab….' }),
      enrollment({ status: 'unresolved', active: false, note: 'Could not read Base Sepolia: the RPC endpoint did not answer.' }),
      enrollment({ status: 'none', active: false }),
      enrollment({ status: 'verified', active: false }),
    ];
    for (const view of others) {
      const row = registrationRow(view);
      expect(row.title).not.toContain('verified');
      expect(row.mark).not.toBe('pass');
    }
    expect(registrationRow(others[0] as EnrollmentView).title).toBe('ERC-8004 registration not configured');
    const enrolledLocally = registrationRow(
      enrollment({
        status: 'local',
        identityMode: 'local',
        configured: false,
        network: null,
        chainId: null,
        registry: null,
        agentId: null,
        owner: null,
        expectedOwner: null,
        keyBinding: null,
        blockNumber: null,
        explorerUrl: null,
      }),
    );
    expect(enrolledLocally).toMatchObject({
      mark: 'pass',
      title: 'Local key enrolled (Ed25519, fingerprint f80e7178)',
    });
    expect(JSON.stringify(enrolledLocally)).not.toContain('ERC-8004');
    expect(enrolledLocally.facts).toEqual([
      { label: 'Key', value: 'Ed25519 · f80e7178' },
      { label: 'Agent', value: 'AGT-DECK-1' },
    ]);
    // The request signature is the same row whichever identity proof was used.
    expect(signatureRow(run(), enrollment({ status: 'local', identityMode: 'local', configured: false }))).toEqual(
      signatureRow(run(), enrollment()),
    );
    expect(registrationRow(others[1] as EnrollmentView)).toMatchObject({ mark: 'fail', title: 'ERC-8004 registration failed' });
    expect(registrationRow(others[1] as EnrollmentView).detail).toContain('Registration owner is');
    expect(registrationRow(others[2] as EnrollmentView)).toMatchObject({ mark: 'ask', title: 'ERC-8004 registration unresolved' });
  });

  test('a registration that names the signing key says so', () => {
    expect(registrationRow(enrollment({ keyBinding: 'matches' })).detail).toBe(
      'Owned by the expected team wallet, and the registration names this signing key.',
    );
    expect(registrationRow(enrollment()).detail).toBe('Owned by the expected team wallet.');
  });

  test('the signature row follows the gate: verified, not accepted, waiting, or never asked', () => {
    const passed = signatureRow(run(), enrollment());
    expect(passed).toMatchObject({ mark: 'pass', title: 'Request signature verified' });
    expect(passed.facts).toEqual([
      { label: 'Registered key', value: 'AGT-DECK-1 · f80e7178' },
      { label: 'One-time nonce', value: 'bm9uY2Utbm9uY2Ux' },
      { label: 'Request', value: 'R-0001 · quote KS-1041' },
    ]);

    const failed = signatureRow(run({ stage: 'identity_failed', signature: 'failed', signatureNote: 'Not signed with AGT-DECK-1’s enrolled key.' }), enrollment());
    expect(failed).toMatchObject({ mark: 'fail', title: 'Request signature not accepted', detail: 'Not signed with AGT-DECK-1’s enrolled key.' });

    // Stopped before the gate: nothing was signed. A signer's refusal is shown as it was given…
    const refused = signatureRow(
      run({ stage: 'identity_failed', signature: 'failed', requestId: null, signatureNote: 'The signer refused: the buyer grant was issued to a different key.' }),
      enrollment(),
    );
    expect(refused).toMatchObject({ mark: 'fail', title: 'Request not signed', detail: 'The signer refused: the buyer grant was issued to a different key.' });

    // …and when the enrollment is what is missing, the registration row carries the reason once.
    const unenrolled = signatureRow(
      run({ stage: 'identity_failed', signature: 'failed', requestId: null, signatureNote: 'ERC-8004 registration check failed. Registration owner is 0x99….' }),
      enrollment({ status: 'failed', active: false }),
    );
    expect(unenrolled).toMatchObject({
      mark: 'fail',
      title: 'Request not signed',
      detail: 'No signature was asked for: the agent’s enrollment is not in place.',
    });

    const waiting = signatureRow(run({ stage: 'awaiting_signature', signature: 'pending', requestId: null }), enrollment());
    expect(waiting).toMatchObject({ mark: 'wait', title: 'Signing challenge issued' });
    expect(waiting.title).not.toContain('verified');

    expect(signatureRow(run({ stage: 'model_not_matched', signature: 'skipped' }), enrollment())).toMatchObject({
      mark: 'off',
      title: 'Request signature not checked',
    });
    expect(signatureRow(run({ stage: 'awaiting_reply', signature: 'pending', nonce: null, requestId: null }), enrollment()).mark).toBe('wait');
  });
});

/* ---------- Layer 3 ---------- */

describe('the authorization line', () => {
  test('the budget sentence is only used when this amount would pass the cap', () => {
    const open = grant({ spent: usd(0), reserved: usd(0), left: usd(1000), budget: usd(1000) });
    expect(budgetRefusal(open, usd(666))).toBeNull();
    expect(
      budgetRefusal(grant({ spent: usd(999), reserved: usd(0), left: usd(1), budget: usd(1000) }), usd(200)),
    ).toBe('would exceed budget: $999 spent, $1 left');
  });

  test('one line, in the server’s words', () => {
    expect(authorizationOf(run())).toEqual({ mark: 'pass', line: 'Buyer authorization passed · USD 8.00 of USD 20.00' });
    expect(
      authorizationOf(run({ authorization: 'failed', authorizationLine: 'Buyer authorization failed · the grant covers Kestrel Stock, not Lark Prints' })),
    ).toEqual({ mark: 'fail', line: 'Buyer authorization failed · the grant covers Kestrel Stock, not Lark Prints' });
    expect(authorizationOf(run({ authorization: 'ask', authorizationLine: 'Buyer authorization needed · $5 is more than the $4 left tonight' })).mark).toBe('ask');
    expect(authorizationOf(run({ authorization: 'pending', authorizationLine: null })).mark).toBe('wait');
    expect(authorizationOf(run({ authorization: 'skipped', authorizationLine: null }))).toEqual({
      mark: 'off',
      line: 'Buyer authorization · not checked',
    });
  });
});

/* ---------- The receipt ---------- */

describe('the receipt', () => {
  test('a live capture is PayPal Sandbox · COMPLETED with the order, the capture and what is left', () => {
    expect(receiptOf(run(), grant({ spent: usd(8), left: usd(12) }))).toEqual({
      provider: 'PayPal Sandbox',
      status: 'COMPLETED',
      tone: 'ok',
      amount: 'USD 8.00',
      orderId: '5XJ12345AB678901C',
      captureId: '8AB98765CD432109E',
      budgetLine: 'USD 12.00 of USD 20.00 authorized budget left',
      note: null,
      tag: 'real',
    });
  });

  test('COMPLETED is never shown for a simulated, pending, unconfirmed or refused charge', () => {
    const others: PayPalView[] = [
      paypal({ outcome: 'captured', mode: 'simulated', orderId: null, captureId: null }),
      paypal({ outcome: 'simulated', mode: 'simulated', orderId: null, captureId: null }),
      paypal({ outcome: 'calling', captureId: null }),
      paypal({ outcome: 'unknown', captureId: null }),
      paypal({ outcome: 'needs_buyer', captureId: null }),
      paypal({ outcome: 'refused', orderId: null, captureId: null, note: 'PayPal POST /v2/checkout/orders returned HTTP 422' }),
    ];
    for (const view of others) {
      const receipt = receiptOf(run({ paypal: view }), grant());
      expect(receipt?.status).not.toBe('COMPLETED');
      expect(receipt?.tone).not.toBe('ok');
    }
    expect(receiptOf(run({ paypal: others[0] ?? null }), grant())).toMatchObject({ provider: 'No PayPal call', status: 'SIMULATED', tag: 'sim' });
    expect(receiptOf(run({ paypal: others[3] ?? null }), grant())).toMatchObject({ status: 'NOT CONFIRMED', budgetLine: null });
  });

  test('there is no receipt before PayPal was asked, or when it never was', () => {
    expect(receiptOf(run({ paypal: null }), grant())).toBeNull();
    expect(receiptOf(run({ paypal: paypal({ outcome: 'not_called', mode: null, orderId: null, captureId: null }) }), grant())).toBeNull();
  });
});

test('an address is shortened from the middle, and a missing one is a dash', () => {
  expect(shortAddress(REGISTRY)).toBe('0x8004…BD9e');
  expect(shortAddress(null)).toBe('—');
});
