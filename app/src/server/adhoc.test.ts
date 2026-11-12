/// <reference types="bun" />
/**
 * A purchase that is not one of the shop's fixed quotes: named by the caller,
 * priced by the caller, and still held to the approved budget.
 */

import { afterEach, expect, test } from 'bun:test';
import { reseedDeck } from '../../scripts/deck.ts';
import { usd } from '../types.ts';
import { MAX_BUDGET_USD } from './budget.ts';
import { generateKeyPair, type KeyPair } from './crypto.ts';
import { openStore, type Store } from './db.ts';
import { DECK } from './deck.ts';
import { Engine } from './engine.ts';
import { habitA, many } from './habits.ts';
import { loadKeyring } from './keys.ts';
import { LiveVerifier } from './live.ts';
import type { ChargeArgs, OrderOutcome, PayPal } from './paypal.ts';
import { EMPTY_BANK, memoryReference, withSample } from './reference.ts';
import { localSigner } from './signer.ts';

const keyring = loadKeyring();

interface Fake {
  readonly paypal: PayPal;
  readonly orders: ChargeArgs[];
}

function fakePayPal(): Fake {
  const fake: Fake = {
    orders: [],
    paypal: {
      createSetupToken: async () => ({ id: 'SETUP1', approvalUrl: 'https://www.sandbox.paypal.com/approve' }),
      setupStatus: async () => 'APPROVED',
      savePaymentToken: async () => 'VAULT1',
      paymentToken: async () => {},
      async chargeSavedWallet(args): Promise<OrderOutcome> {
        fake.orders.push(args);
        return { kind: 'completed', orderId: `ORDER${fake.orders.length}`, captureId: `CAPTURE${fake.orders.length}` };
      },
      order: async (orderId) => ({ kind: 'unconfirmed', orderId, status: 'APPROVED' }),
    },
  };
  return fake;
}

let store: Store;
let engine: Engine;
let live: LiveVerifier;

afterEach(() => {
  live?.stop();
  engine?.stop();
});

async function night(): Promise<Fake> {
  const fake = fakePayPal();
  const key: KeyPair = generateKeyPair();
  const bank = many(habitA, 8).reduce(
    (b, numbers, i) => withSample(b, 'Test model', numbers, `test:${i}`, '2026-11-12T00:00:00Z'),
    EMPTY_BANK,
  );
  store = openStore(':memory:');
  reseedDeck(store, keyring, 'live');
  engine = new Engine(store, keyring, fake.paypal, {
    appHash: 'app-under-test',
    candidates: [{ vaultId: 'VAULT1', source: 'configured' }],
  });
  await engine.refreshWallet();
  live = new LiveVerifier({
    store,
    engine,
    keyring,
    signer: localSigner(key, {
      registryId: DECK.registryId,
      scope: 'stock_images',
      maxAmount: usd(MAX_BUDGET_USD),
      maxTtlMs: 10 * 60 * 1_000,
    }),
    erc8004: null,
    readRegistration: async () => ({ kind: 'unreachable', reason: 'not used' }),
    reference: memoryReference(bank),
    settleWaitMs: 500,
  });
  live.start();
  expect((await live.enroll()).ok).toBe(true);
  return fake;
}

const runIdOf = (data: { readonly [key: string]: unknown }): string => {
  const id = data.run_id;
  if (typeof id !== 'string') throw new Error('no run id');
  return id;
};

async function open(item: string, amount: number): Promise<{
  readonly runId: string;
  readonly signed: { readonly ok: boolean; readonly text: string; readonly data: { readonly [key: string]: unknown } };
}> {
  const begun = live.begin({ item, amount });
  expect(begun.ok).toBe(true);
  const runId = runIdOf(begun.data);
  expect(live.submitReply(runId, habitA(900).join(', ')).ok).toBe(true);
  return { runId, signed: await live.signAndSubmit(runId) };
}

test('the page saves the ask threshold with the grant, and a later change is refused', async () => {
  await night();
  expect(engine.setAskThreshold(70).ok).toBe(true);
  expect(engine.approveGrant(usd(1000)).ok).toBe(true);
  expect(store.grantView()?.askThresholdPct).toBe(70);
  expect(engine.setAskThreshold(40).ok).toBe(false);
  expect(store.grantView()?.askThresholdPct).toBe(70);
});

test('a named price opens a purchase: $300 passes, $666 asks, and approving that run captures it', async () => {
  const fake = await night();
  expect(engine.approveGrant(usd(1000)).ok).toBe(true);
  expect(store.grantView()?.askThresholdPct).toBe(50);
  const policy = store.policy();
  expect(policy.dailyTotal).toBe(usd(1000));
  expect(policy.originCeiling.agent).toBe(usd(1000));
  expect(policy.perPayment).toEqual({
    1: usd(1000),
    2: usd(1000),
    3: usd(1000),
    4: usd(1000),
    5: usd(1000),
  });

  const catalog = live.begin({ amount: 8 });
  expect(catalog.ok).toBe(true);
  expect(catalog.data.quote).toMatchObject({ reference: 'KS-1041', item: 'Harbor at dawn', amount: 'USD 8.00' });

  const small = await open('Lens', 300);
  expect(small.signed.ok).toBe(true);
  expect(small.signed.data.stage).toBe('paid');
  expect(small.signed.data.needs_buyer_approval).toBe(false);
  expect(small.signed.data.message_for_user).toBeNull();
  expect(small.signed.text).toContain('within the approved $1,000 budget ($1,000 left)');
  expect(fake.orders.map((order) => order.amount)).toEqual([usd(300)]);

  const first = live.begin({ item: 'Camera', amount: 666 });
  expect(first.ok).toBe(true);
  expect(first.text).not.toContain('No quote at');
  expect(first.data.quote).toMatchObject({ merchant: 'Kestrel Stock', item: 'Camera', amount: 'USD 666.00' });
  const firstId = runIdOf(first.data);
  expect(runIdOf(live.begin({ item: 'camera', amount: 666 }).data)).toBe(firstId);
  expect(live.submitReply(firstId, habitA(900).join(', ')).ok).toBe(true);

  const asked = await live.signAndSubmit(firstId);
  expect(asked.ok).toBe(false);
  expect(asked.data.stage).toBe('needs_buyer');
  expect(asked.data.needs_buyer_approval).toBe(true);
  expect(asked.data.layer3_authorization).toMatchObject({ result: 'ask' });
  expect(asked.text).toContain(
    '$666 is 67% of your $1,000 budget, over your 50% ask threshold, buyer confirmation needed',
  );
  expect(asked.text).toContain('PayPal was not called');
  expect(asked.text).not.toContain('would exceed budget');
  expect(asked.text).not.toContain('unusual');
  const message = asked.data.message_for_user;
  if (typeof message !== 'string') throw new Error('message_for_user was not a string');
  expect(message).toContain('$666 is 67% of your $1,000 budget');
  expect(message).toContain('50%');
  expect(message).toContain('$300 spent');
  expect(message).toContain('$700 left');
  expect(message).toContain('verify page');
  expect(message).toContain(firstId);
  expect(live.status(firstId).data.needs_buyer_approval).toBe(true);
  expect(live.status(firstId).data.message_for_user).toBe(message);
  const repeated = await live.signAndSubmit(firstId);
  expect(repeated.data.stage).toBe('needs_buyer');
  expect(fake.orders).toHaveLength(1);

  expect(engine.decideLivePurchase(firstId, 'approve').ok).toBe(true);
  const paid = await live.signAndSubmit(firstId);
  expect(paid.ok).toBe(true);
  expect(paid.data.stage).toBe('paid');
  expect(paid.data.needs_buyer_approval).toBe(false);
  expect(paid.data.message_for_user).toBeNull();
  expect(paid.data.payment).toMatchObject({ status: 'COMPLETED', order_id: 'ORDER2', capture_id: 'CAPTURE2' });
  expect(paid.text).toContain('the buyer approved this purchase');
  expect(live.status(firstId).data.stage).toBe('paid');
  expect(store.grantView()?.left).toBe(usd(34));
  expect(fake.orders.map((order) => order.amount)).toEqual([usd(300), usd(666)]);

  const over = await open('Bag', 400);
  expect(over.signed.ok).toBe(false);
  expect(over.signed.data.stage).toBe('authorization_failed');
  expect(over.signed.data.needs_buyer_approval).toBe(false);
  expect(over.signed.text).toContain('would exceed budget: $966 spent, $34 left');
  expect(over.signed.text).not.toContain('ask threshold');
  expect(over.signed.text).toContain('PayPal was not called');
  expect(fake.orders).toHaveLength(2);
});

test('a purchase that first takes cumulative spend past the ask threshold asks, and declining refuses it', async () => {
  const fake = await night();
  expect(engine.approveGrant(usd(1000)).ok).toBe(true);

  const small = await open('Lens', 300);
  expect(small.signed.data.stage).toBe('paid');
  expect(fake.orders).toHaveLength(1);

  const cross = await open('Strap', 400);
  expect(cross.signed.ok).toBe(false);
  expect(cross.signed.data.stage).toBe('needs_buyer');
  expect(cross.signed.data.needs_buyer_approval).toBe(true);
  expect(cross.signed.text).toContain(
    '$400 would take spending to $700, 70% of your $1,000 budget, over your 50% ask threshold, buyer confirmation needed',
  );
  const crossMessage = cross.signed.data.message_for_user;
  if (typeof crossMessage !== 'string') throw new Error('message_for_user was not a string');
  expect(crossMessage).toContain('buyer must approve or decline');
  expect(fake.orders).toHaveLength(1);

  expect(engine.decideLivePurchase(cross.runId, 'decline').ok).toBe(true);
  const declined = live.status(cross.runId);
  expect(declined.data.stage).toBe('authorization_failed');
  expect(declined.data.needs_buyer_approval).toBe(false);
  expect(declined.text).toContain('Buyer declined this purchase');
  expect(declined.text).toContain('PayPal was not called');
  expect(fake.orders).toHaveLength(1);

  const over = await open('Case', 800);
  expect(over.signed.data.stage).toBe('authorization_failed');
  expect(over.signed.text).toContain('would exceed budget: $300 spent, $700 left');
  expect(over.signed.text).not.toContain('ask threshold');
  expect(fake.orders).toHaveLength(1);
});

test('a budget change stays pending until the buyer approves it, and then Layer 2 accepts the new cap', async () => {
  const fake = await night();
  expect(engine.approveGrant(usd(500)).ok).toBe(true);

  const small = await open('Lens', 100);
  expect(small.signed.data.stage).toBe('paid');
  expect(store.grantView()?.spent).toBe(usd(100));

  const blocked = await open('Camera', 666);
  expect(blocked.signed.ok).toBe(false);
  expect(blocked.signed.data.stage).toBe('identity_failed');
  expect(blocked.signed.text).toContain('amount is over the buyer grant');
  expect(store.grantView()?.budget).toBe(usd(500));
  expect(fake.orders.map((order) => order.amount)).toEqual([usd(100)]);

  const direct = live.begin({ budget: 1000, item: 'Tripod', amount: 10 });
  expect(direct.ok).toBe(false);
  expect(direct.text).toContain('already approved');
  expect(store.grantView()?.budget).toBe(usd(500));

  const asked = live.requestBudgetChange(1000, 'The camera is USD 666.');
  expect(asked.ok).toBe(true);
  expect(asked.data).toMatchObject({
    status: 'pending',
    current_budget: 'USD 500.00',
    requested_budget: 'USD 1,000.00',
    resulting_budget: 'USD 500.00',
    needs_buyer_approval: true,
    approval_url: 'http://localhost:8787/verify/paypal/',
  });
  expect(asked.data.message_for_user).toContain('Stop and tell the user');
  expect(asked.data.message_for_user).toContain('no tool');
  const requestId = asked.data.request_id;
  if (typeof requestId !== 'string') throw new Error('no request id');
  expect(store.grantView()?.budget).toBe(usd(500));
  expect(store.policy().dailyTotal).toBe(usd(500));
  expect(store.grantView()?.pendingBudgetRequest).toMatchObject({ requestId, requested: usd(1000) });

  const connector = await live.readiness();
  expect(connector.data.grant).toMatchObject({
    pending_budget_request: { request_id: requestId, status: 'pending', needs_buyer_approval: true },
  });
  expect(live.budgetRequestStatus(requestId).data).toMatchObject({ status: 'pending', resulting_budget: 'USD 500.00' });

  expect(engine.decideBudgetRequest(requestId, 'approve').ok).toBe(true);
  expect(store.grantView()).toMatchObject({
    budget: usd(1000),
    spent: usd(100),
    left: usd(900),
    askThresholdPct: 50,
    pendingBudgetRequest: null,
  });
  expect(store.policy().dailyTotal).toBe(usd(1000));
  expect(store.policy().originCeiling.agent).toBe(usd(1000));
  expect(store.policy().perPayment).toEqual({
    1: usd(1000),
    2: usd(1000),
    3: usd(1000),
    4: usd(1000),
    5: usd(1000),
  });
  expect(live.budgetRequestStatus(requestId).data).toMatchObject({
    status: 'approved',
    resulting_budget: 'USD 1,000.00',
    needs_buyer_approval: false,
  });

  const raised = await open('Body', 666);
  expect(raised.signed.data.stage).toBe('needs_buyer');
  expect(raised.signed.data.layer2_identity).toMatchObject({ request_signature: 'passed' });
  expect(raised.signed.text).toContain('$666 is 67% of your $1,000 budget, over your 50% ask threshold');
  expect(raised.signed.text).not.toContain('buyer grant');
  expect(raised.signed.data.needs_buyer_approval).toBe(true);
  expect(fake.orders).toHaveLength(1);
});

test('a newer budget request replaces the pending one, and a decline leaves the grant alone', async () => {
  await night();
  expect(engine.approveGrant(usd(500)).ok).toBe(true);

  const first = live.requestBudgetChange(1000, 'First ask.');
  const firstId = first.data.request_id;
  if (typeof firstId !== 'string') throw new Error('no request id');
  const second = live.requestBudgetChange(1200, 'A later ask.');
  const secondId = second.data.request_id;
  if (typeof secondId !== 'string') throw new Error('no request id');
  expect(secondId).not.toBe(firstId);
  expect(live.budgetRequestStatus(firstId).data.status).toBe('declined');
  expect(live.budgetRequestStatus(firstId).data.message_for_user).toContain('replaced');
  expect(second.data.status).toBe('pending');
  expect(store.grantView()?.budget).toBe(usd(500));
  expect(store.grantView()?.pendingBudgetRequest?.requested).toBe(usd(1200));

  expect(engine.decideBudgetRequest(secondId, 'decline').ok).toBe(true);
  expect(store.grantView()?.budget).toBe(usd(500));
  expect(store.policy().dailyTotal).toBe(usd(500));
  expect(store.grantView()?.pendingBudgetRequest).toBeNull();
  expect(store.deckGrant()?.ask_pct).toBe(50);
  expect(live.budgetRequestStatus(secondId).data).toMatchObject({
    status: 'declined',
    resulting_budget: 'USD 500.00',
    needs_buyer_approval: false,
  });
  expect(engine.decideBudgetRequest(secondId, 'approve').ok).toBe(false);
  expect(store.grantView()?.budget).toBe(usd(500));
});
