/**
 * The 2 a.m. deck, end to end: the wallet, the budget, two $8 images (the second
 * asks, because it crosses the threshold), the $5 that is refused, the three test requests — an impostor, the agent
 * at the wrong shop, the agent at the right one — and the wallet's own life:
 * connecting, waiting, cancelling, expiring, carrying over a reset.
 *
 * PayPal is a fake `fetch` that answers the way the Sandbox did in the tested
 * script, and records every call, so these tests assert two things at once:
 * what the gate decided, and exactly what was (or was not) sent to PayPal.
 * Nothing here touches the network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { ensureDeckScene, reseedDeck } from '../../scripts/deck.ts';
import { usd, type BoardSender, type Envelope } from '../types.ts';
import { buildClean } from './attacker.ts';
import { openStore, type Store } from './db.ts';
import { DECK, OTHER_MERCHANT } from './deck.ts';
import { Engine } from './engine.ts';
import { loadKeyring } from './keys.ts';
import { createPayPal, fromValue, toValue } from './paypal.ts';
import type { WalletCandidate } from './wallets.ts';

const keyring = loadKeyring();
const APP = 'app-hash-under-test';

/* ---------- A PayPal Sandbox that answers like the tested run ---------- */

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** How a new saved-wallet order answers. */
type ChargeBehaviour = 'completed' | 'buyer_action' | 'http422' | 'timeout' | 'hang' | 'pending';

/** What reading a setup token answers. `missing` is PayPal's 404 for a setup it no longer has. */
type SetupRead = 'APPROVED' | 'PAYER_ACTION_REQUIRED' | 'missing';

interface Fake {
  readonly calls: Call[];
  readonly paypal: ReturnType<typeof createPayPal>;
  /** Mutable switches a test flips mid-flow. */
  readonly state: {
    charge: ChargeBehaviour;
    setupRead: SetupRead;
    /** Wallet tokens PayPal knows for this merchant app. */
    readonly tokens: Set<string>;
    /** Pending orders become completed once this is true. */
    ordersSettle: boolean;
    /** Every wallet-token read fails without an answer. */
    unreachable: boolean;
  };
  release: () => void;
}

function fakePayPal(): Fake {
  const calls: Call[] = [];
  const state: Fake['state'] = {
    charge: 'completed',
    setupRead: 'APPROVED',
    tokens: new Set<string>(),
    ordersSettle: false,
    unreachable: false,
  };
  const orders = new Map<string, unknown>();
  let setups = 0;
  let release: () => void = () => {};

  // A bare response object rather than `new Response`: the view tests install
  // happy-dom's globals for the whole process, and this fake should not care.
  const respond = (status: number, data: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'paypal-debug-id' ? 'dbg123' : null) },
      json: async () => data,
    }) as unknown as Response;

  const completed = (id: string, amount: unknown) => ({
    id,
    status: 'COMPLETED',
    purchase_units: [{ payments: { captures: [{ id: `CAPTURE-${id}`, status: 'COMPLETED', amount }] } }],
  });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body = raw && headers['content-type'] === 'application/json' ? JSON.parse(raw) : raw;
    calls.push({ method, path: url.pathname, headers, body });
    const last = url.pathname.split('/').pop() ?? '';

    if (url.pathname === '/v1/oauth2/token') return respond(200, { access_token: 'tok', expires_in: 3600 });

    if (url.pathname === '/v3/vault/setup-tokens' && method === 'POST') {
      setups += 1;
      return respond(201, {
        id: `SETUP${setups}`,
        status: 'PAYER_ACTION_REQUIRED',
        links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/agreements/approve?ba_token=${setups}` }],
      });
    }
    if (url.pathname.startsWith('/v3/vault/setup-tokens/')) {
      if (state.setupRead === 'missing') {
        return respond(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
      }
      return respond(200, { id: last, status: state.setupRead });
    }

    if (url.pathname === '/v3/vault/payment-tokens' && method === 'POST') {
      state.tokens.add('VAULT1');
      return respond(201, { id: 'VAULT1' });
    }
    if (url.pathname.startsWith('/v3/vault/payment-tokens/')) {
      if (state.unreachable) throw new Error('connection reset');
      if (!state.tokens.has(last)) {
        return respond(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
      }
      return respond(200, { id: last, payment_source: { paypal: { email_address: 'buyer@example.com' } } });
    }

    if (url.pathname === '/v2/checkout/orders' && method === 'POST') {
      if (state.charge === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      if (state.charge === 'http422') {
        return respond(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYER_ACTION_REQUIRED' }] });
      }
      if (state.charge === 'hang') await new Promise<void>((resolve) => (release = resolve));

      const id = `ORDER${orders.size + 1}`;
      const amount = (body as { purchase_units: { amount: unknown }[] }).purchase_units[0]?.amount;
      orders.set(id, amount);
      if (state.charge === 'buyer_action') {
        return respond(201, {
          id,
          status: 'PAYER_ACTION_REQUIRED',
          links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=x' }],
        });
      }
      if (state.charge === 'pending') return respond(201, { id, status: 'APPROVED' });
      return respond(201, completed(id, amount));
    }
    if (url.pathname.startsWith('/v2/checkout/orders/')) {
      if (!orders.has(last)) return respond(404, { name: 'RESOURCE_NOT_FOUND' });
      return respond(200, state.ordersSettle ? completed(last, orders.get(last)) : { id: last, status: 'APPROVED' });
    }

    return respond(404, { name: 'RESOURCE_NOT_FOUND' });
  }) as unknown as typeof fetch;

  const paypal = createPayPal({ clientId: 'id', clientSecret: 'secret', returnBase: 'http://localhost:8787', fetchImpl });
  return { calls, paypal, state, release: () => release() };
}

const posts = (fake: Fake, path: string): Call[] =>
  fake.calls.filter((c) => c.method === 'POST' && c.path === path);
const orderPosts = (fake: Fake): Call[] => posts(fake, '/v2/checkout/orders');
const setupPosts = (fake: Fake): Call[] => posts(fake, '/v3/vault/setup-tokens');
const tokenReads = (fake: Fake): Call[] =>
  fake.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v3/vault/payment-tokens/'));

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the engine');
    await Bun.sleep(5);
  }
}

/* ---------- Driving the night ---------- */

let store: Store;
let engine: Engine;

afterEach(() => engine?.stop());

interface Night {
  readonly fake: Fake;
}

/** A fresh live night: credentials configured, nothing connected unless `candidates` say so. */
async function live(candidates: readonly WalletCandidate[] = []): Promise<Night> {
  const fake = fakePayPal();
  store = openStore(':memory:');
  reseedDeck(store, keyring, 'live');
  engine = new Engine(store, keyring, fake.paypal, { appHash: APP, candidates });
  await engine.refreshWallet();
  return { fake };
}

/** A night with no Sandbox credentials. */
function simulated(): void {
  store = openStore(':memory:');
  reseedDeck(store, keyring, 'simulated');
  engine = new Engine(store, keyring, null);
}

const wallet = () => store.walletView();
const grant = () => store.grantView();
const slot = (id: string) => {
  const found = store.deckView().find((s) => s.id === id);
  if (!found) throw new Error(`no slot ${id}`);
  return found;
};
const attempt = () => {
  const setup = store.walletSetup();
  if (!setup) throw new Error('no setup attempt');
  return setup;
};

/** The buyer's one consent: connect, agree on PayPal, come back. */
async function consent(): Promise<void> {
  const started = await engine.connectWallet();
  expect(started.ok).toBe(true);
  const back = await engine.walletReturned(attempt().attempt_id, attempt().setup_id);
  expect(back.ok).toBe(true);
}

/**
 * The agent asks for the next image. The first is the paying test request,
 * ruled at once; the others are queued for Pip, who does not walk in a test,
 * so they are handed straight to the gate. Never twice: a second ruling would
 * be a replay of a burned nonce.
 */
function buy(): string {
  const before = new Set(store.requests().map((r) => r.id));
  const outcome = engine.buyNextImage();
  expect(outcome.ok).toBe(true);
  const created = store.requests().find((r) => !before.has(r.id));
  if (!created) throw new Error('no request went to the gate');
  if (created.status === 'queued') engine.processRequest(created.id);
  return created.id;
}

/** One of the three test requests, which the engine rules on at once. */
function send(sender: BoardSender): string {
  const outcome = engine.sendFromBoard(sender);
  expect(outcome.ok).toBe(true);
  const id = store.deckSends().get(sender);
  if (!id) throw new Error(`${sender} sent nothing`);
  return id;
}

const sendView = (sender: BoardSender) => {
  const found = store.snapshot().sends.find((s) => s.sender === sender);
  if (!found) throw new Error(`no test request ${sender}`);
  return found;
};

/** Approve the open payment ask for this request. PayPal runs only after this. */
function approveAsk(requestId: string): void {
  const decision = store.decisions().find((item) => item.kind === 'payment' && item.requestId === requestId);
  if (!decision) throw new Error(`no ask waiting for ${requestId}`);
  expect(engine.resolveDecision(decision.id, 'approve', 'phone').ok).toBe(true);
}

/** Two $8 images, captured. The second crosses the 50% ask threshold, so the buyer approves it. */
async function twoImages(): Promise<void> {
  buy();
  await until(() => slot('S1').state === 'unlocked');
  const second = buy();
  expect(store.request(second)?.status).toBe('gated');
  approveAsk(second);
  await until(() => slot('S2').state === 'unlocked');
}

/** A request signed by the real Deck Agent under the buyer's real grant, for any reference and amount. */
function forged(reference: string, amount: number): Envelope {
  const buyer = store.vendor(DECK.principal);
  if (!buyer) throw new Error('no buyer');
  return buildClean({
    requestId: store.nextRequestId(),
    principal: DECK.principal,
    amount: usd(amount),
    reference,
    nowMs: Date.now(),
    keyring,
    receiver: buyer.receiver,
  }).envelope;
}

function gateIt(envelope: Envelope): string {
  engine.receiveEnvelope(envelope);
  engine.processRequest(envelope.id);
  return envelope.id;
}

/* ---------- Before anything ---------- */

describe('a new wallet: nothing is connected yet', () => {
  test('the wallet says so, the budget waits on it, and nothing can be bought', async () => {
    const { fake } = await live();

    expect(wallet()?.state).toBe('none');
    expect(wallet()?.mode).toBe('live');
    expect(grant()?.status).toBe('needs_wallet');
    expect(engine.approveGrant().ok).toBe(false);
    expect(engine.buyNextImage().ok).toBe(false);
    expect(orderPosts(fake)).toHaveLength(0);
  });
});

/* ---------- Step one: connecting with PayPal's consent ---------- */

describe('a new wallet: connecting with PayPal’s consent', () => {
  test('the setup body is the tested one, returning to a URL with this attempt’s id', async () => {
    const { fake } = await live();
    await engine.connectWallet();

    const setup = setupPosts(fake)[0];
    const id = attempt().attempt_id;
    expect(setup?.body).toEqual({
      payment_source: {
        paypal: {
          description: 'Save this test wallet for two USD 8 AgentTrust Sandbox payments',
          usage_pattern: 'IMMEDIATE',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: 'AgentTrust Sandbox',
            shipping_preference: 'NO_SHIPPING',
            return_url: `http://localhost:8787/paypal/approved/${id}`,
            cancel_url: `http://localhost:8787/paypal/cancelled/${id}`,
          },
        },
      },
    });
    expect(setup?.headers['paypal-request-id']).toBeTruthy();
    expect(wallet()?.state).toBe('waiting');
  });

  test('a return that is not from the current attempt changes nothing', async () => {
    const { fake } = await live();
    await engine.connectWallet();

    const wrongAttempt = await engine.walletReturned('00000000-0000-0000-0000-000000000000', attempt().setup_id);
    expect(wrongAttempt.ok).toBe(false);
    const wrongToken = await engine.walletReturned(attempt().attempt_id, 'SETUP-SOMEONE-ELSE');
    expect(wrongToken.ok).toBe(false);

    expect(wallet()?.state).toBe('waiting');
    expect(posts(fake, '/v3/vault/payment-tokens')).toHaveLength(0);
  });

  test('a matching return is still checked with PayPal: not agreed yet means not connected', async () => {
    const { fake } = await live();
    await engine.connectWallet();

    fake.state.setupRead = 'PAYER_ACTION_REQUIRED';
    const early = await engine.walletReturned(attempt().attempt_id, attempt().setup_id);
    expect(early.ok).toBe(false);
    expect(early.message).toContain('still waiting');
    expect(wallet()?.state).toBe('waiting');

    fake.state.setupRead = 'APPROVED';
    expect((await engine.walletReturned(attempt().attempt_id, attempt().setup_id)).ok).toBe(true);
    expect(wallet()?.state).toBe('connected');
    expect(wallet()?.source).toBe('consent');
    // The new token was confirmed with PayPal like any other wallet.
    expect(tokenReads(fake).some((c) => c.path.endsWith('/VAULT1'))).toBe(true);
  });

  test('"I’ve agreed in PayPal" finishes the same check when the redirect never arrives', async () => {
    await live();
    await engine.connectWallet();

    expect((await engine.checkWallet()).ok).toBe(true);
    expect(wallet()?.state).toBe('connected');
  });

  test('connected, the budget is offered — and purchases wait until it is allowed', async () => {
    await live();
    await consent();

    expect(grant()?.status).toBe('needs_approval');
    expect(engine.buyNextImage().ok).toBe(false);
    expect(engine.approveGrant().ok).toBe(true);
    expect(grant()?.status).toBe('active');
  });

  test('the snapshot never carries a wallet token, a setup token or the approval link', async () => {
    await live();
    await engine.connectWallet();
    const waiting = JSON.stringify(store.snapshot());
    expect(waiting).not.toContain('SETUP1');
    expect(waiting).not.toContain('sandbox.paypal.com');
    expect(waiting).not.toContain(attempt().attempt_id);

    await engine.checkWallet();
    const connected = JSON.stringify(store.snapshot());
    expect(connected).not.toContain('VAULT1');
  });
});

/* ---------- The night itself ---------- */

describe('with a saved wallet: $20 → $12 → $4 and no further prompt', () => {
  test('two $8 captures with the tested order body, then $4 left and zero prompts', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();

    buy();
    await until(() => slot('S1').state === 'unlocked');
    expect(store.grantView()?.left).toBe(usd(12));
    const second = buy();
    expect(store.request(second)?.status).toBe('gated');
    expect(orderPosts(fake)).toHaveLength(1);
    approveAsk(second);
    await until(() => slot('S2').state === 'unlocked');

    const orders = orderPosts(fake);
    expect(orders).toHaveLength(2);
    for (const order of orders) {
      const body = order.body as {
        intent: string;
        purchase_units: { amount: unknown; invoice_id: string }[];
        payment_source: unknown;
      };
      expect(body.intent).toBe('CAPTURE');
      expect(body.purchase_units[0]?.amount).toEqual({ currency_code: 'USD', value: '8.00' });
      expect(body.purchase_units[0]?.invoice_id.startsWith('agenttrust-')).toBe(true);
      expect(body.payment_source).toEqual({
        paypal: { vault_id: 'VAULT1', stored_credential: { payment_initiator: 'MERCHANT', usage: 'DERIVED' } },
      });
    }
    expect(orders[0]?.headers['paypal-request-id']).not.toBe(orders[1]?.headers['paypal-request-id']);

    const snap = store.snapshot();
    expect(snap.deck.map((s) => s.captureId)).toEqual(['CAPTURE-ORDER1', 'CAPTURE-ORDER2', null]);
    expect(snap.deck[0]?.mode).toBe('live');
    expect(snap.grant?.spent).toBe(usd(16));
    expect(snap.grant?.left).toBe(usd(4));
    expect(snap.buyerPrompts).toBe(0);
  });

  test('the $5 icon pack is refused by the budget before PayPal is called', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    await twoImages();

    const id = buy();
    expect(store.request(id)?.status).toBe('blocked');
    expect(store.request(id)?.lamp).toBe('OUR_POLICY');
    expect(slot('S3').state).toBe('blocked');
    expect(slot('S3').note).toContain('would exceed budget: $16 spent, $4 left');
    expect(store.decisions()).toHaveLength(0);
    expect(orderPosts(fake)).toHaveLength(2);
  });

  test('revoking the Deck Agent refuses its next request at lamp 1, and the wallet stays connected', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();

    expect(engine.revokeAgent().ok).toBe(true);
    expect(grant()?.status).toBe('revoked');
    expect(wallet()?.state).toBe('connected');

    const id = buy();
    expect(store.request(id)?.lamp).toBe('AGENT_IDENTITY');
    expect(store.gateRun(id)[0]?.note).toContain('was revoked');
    expect(orderPosts(fake)).toHaveLength(0);
  });
});

/* ---------- The three test requests ---------- */

describe('the three test senders', () => {
  /** A live night with the wallet connected and the budget approved. */
  async function ready(): Promise<Fake> {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    return fake;
  }

  test('the impostor fails identity on the key alone, authorization is not reached, and PayPal is not called', async () => {
    const fake = await ready();
    const id = send('impostor');

    const request = store.request(id);
    expect(request?.status).toBe('blocked');
    expect(request?.lamp).toBe('AGENT_IDENTITY');
    // It presents the Deck Agent's own id and a copy of the buyer's real grant.
    expect(request?.registryId).toBe(DECK.registryId);

    const view = sendView('impostor');
    expect(view.summary?.who.state).toBe('no');
    const who = view.summary?.who.terms ?? [];
    expect(who.find((t) => t.lamp === 'AGENT_IDENTITY')).toMatchObject({
      outcome: 'fail',
      text: `not signed with ${DECK.registryId}’s enrolled key`,
    });
    // Its signature is sound under its own key: the request was not altered.
    expect(who.find((t) => t.lamp === 'INTENT_BINDING')?.outcome).toBe('pass');
    expect(view.summary?.may.state).toBe('not_reached');
    // Not reached on screen, but nothing hidden: the gate's own finding is in the footnote.
    expect(view.summary?.footnote).toContain('the grant was issued to a different key');

    expect(view.paypal?.outcome).toBe('not_called');
    expect(view.caption).toBe('Same behaviour. Wrong key.');
    expect(orderPosts(fake)).toHaveLength(0);
    expect(store.grantView()?.left).toBe(usd(20));
  });

  test('the Deck Agent at Lark Prints passes identity and fails authorization on the merchant alone', async () => {
    const fake = await ready();
    const id = send('other_shop');

    expect(store.request(id)?.lamp).toBe('COUNTERPARTY');
    const view = sendView('other_shop');
    expect(view.summary?.who.state).toBe('yes');
    expect(view.summary?.may.state).toBe('no');
    const failing = (view.summary?.may.terms ?? []).filter((t) => t.outcome !== 'pass');
    expect(failing).toEqual([
      { lamp: 'COUNTERPARTY', outcome: 'fail', text: `the grant covers ${DECK.merchant}, not ${OTHER_MERCHANT}` },
    ]);
    // Lark Prints' own quote for the image is real, at the same price: only the shop is wrong.
    expect(store.gateRun(id).find((c) => c.check === 'OUR_POLICY')?.outcome).toBe('pass');

    // A request outside the grant is refused, not turned into an address change for the buyer.
    expect(store.decisions()).toHaveLength(0);
    expect(view.paypal?.outcome).toBe('not_called');
    expect(view.caption).toBe('Right agent. Not allowed there.');
    expect(orderPosts(fake)).toHaveLength(0);
  });

  test('the Deck Agent at Kestrel Stock passes both, and PayPal captures it once', async () => {
    const fake = await ready();
    send('agent');
    await until(() => slot('S1').state === 'unlocked');

    const view = sendView('agent');
    expect(view.summary?.who.state).toBe('yes');
    expect(view.summary?.may.state).toBe('yes');
    expect(view.paypal).toMatchObject({ outcome: 'captured', mode: 'live', captureId: 'CAPTURE-ORDER1' });
    expect(view.caption).toBe('Right agent, right shop: PayPal paid.');
    expect(orderPosts(fake)).toHaveLength(1);
    expect(store.grantView()?.left).toBe(usd(12));
  });

  test('all three: only one PayPal call, whatever the order, and each goes once a run', async () => {
    const fake = await ready();
    send('agent');
    await until(() => slot('S1').state === 'unlocked');
    send('impostor');
    send('other_shop');

    // After the image is bought the other two still fail exactly where they did.
    expect(sendView('impostor').summary?.who.state).toBe('no');
    expect(sendView('other_shop').summary?.may.terms.filter((t) => t.outcome === 'fail').map((t) => t.lamp)).toEqual([
      'COUNTERPARTY',
    ]);
    expect(orderPosts(fake)).toHaveLength(1);

    expect(engine.sendFromBoard('impostor').ok).toBe(false);
    expect(engine.sendFromBoard('agent').ok).toBe(false);
    expect(store.snapshot().sends.every((s) => s.state === 'sent')).toBe(true);
    expect(orderPosts(fake)).toHaveLength(1);
  });

  test('model evidence never decides: the impostor resembles the agent’s model as closely as the agent does', async () => {
    await ready();
    send('impostor');
    send('agent');

    const impostor = sendView('impostor');
    const agent = sendView('agent');
    expect(impostor.evidence?.resembles).toBe('Claude');
    expect(agent.evidence?.resembles).toBe('Claude');
    expect(impostor.evidence?.score ?? 0).toBeGreaterThanOrEqual(agent.evidence?.score ?? 1);
    // Same evidence, opposite verdicts: only the key told them apart.
    expect(impostor.verdict).toBe('DENY');
    expect(agent.verdict).toBe('ALLOW');
  });

  test('a selected quote keeps its merchant and price through signing, the receipt and capture', async () => {
    const fake = await ready();
    const [wrongShop, allowed] = [sendView('other_shop'), sendView('agent')].map((view) =>
      view.availableQuotes.find((quote) => quote.amount === usd(5)),
    );
    if (!wrongShop || !allowed) throw new Error('both shops must offer the $5 quote');

    expect(engine.sendFromBoard('agent', wrongShop.reference).ok).toBe(false);
    expect(engine.sendFromBoard('other_shop', wrongShop.reference).ok).toBe(true);
    expect(sendView('other_shop')).toMatchObject({ ...wrongShop, paypal: { outcome: 'not_called' } });
    expect(orderPosts(fake)).toHaveLength(0);

    expect(engine.sendFromBoard('agent', allowed.reference).ok).toBe(true);
    await until(() => slot('S3').state === 'unlocked');
    expect(sendView('agent')).toMatchObject({ ...allowed, paypal: { outcome: 'captured', amount: usd(5) } });
    expect(orderPosts(fake)).toHaveLength(1);
    expect(store.grantView()?.left).toBe(usd(15));
  });

  test('nothing is offered until the wallet and the budget are in place, nor while a charge is with PayPal', async () => {
    const { fake } = await live();
    expect(store.snapshot().sends.map((s) => s.state)).toEqual(['locked', 'locked', 'locked']);
    expect(engine.sendFromBoard('impostor').ok).toBe(false);

    await consent();
    expect(engine.sendFromBoard('impostor').ok).toBe(false);
    engine.approveGrant();
    expect(store.snapshot().sends.map((s) => s.state)).toEqual(['ready', 'ready', 'ready']);

    fake.state.charge = 'hang';
    send('agent');
    await until(() => fake.calls.some((c) => c.path === '/v2/checkout/orders'));
    expect(store.snapshot().sends.map((s) => s.state)).toEqual(['locked', 'locked', 'sent']);
    expect(engine.sendFromBoard('impostor').ok).toBe(false);
    fake.release();
    await until(() => slot('S1').state === 'unlocked');
    expect(sendView('impostor').state).toBe('ready');
  });

  test('buying the first image from the studio is the paying test request, not a second purchase', async () => {
    const fake = await ready();
    buy();
    await until(() => slot('S1').state === 'unlocked');

    expect(store.deckSends().has('agent')).toBe(true);
    expect(sendView('agent').paypal?.outcome).toBe('captured');
    expect(engine.sendFromBoard('agent').ok).toBe(false);
    expect(orderPosts(fake)).toHaveLength(1);
  });

  test('a reset sends all three again; the wallet stays connected', async () => {
    const fake = await ready();
    send('impostor');
    reseedDeck(store, keyring, 'live');
    await engine.refreshWallet();

    expect(wallet()?.state).toBe('connected');
    expect(store.deckSends().size).toBe(0);
    expect(store.snapshot().sends.map((s) => s.state)).toEqual(['locked', 'locked', 'locked']);
    engine.approveGrant();
    expect(store.snapshot().sends.map((s) => s.state)).toEqual(['ready', 'ready', 'ready']);
    expect(orderPosts(fake)).toHaveLength(0);
  });
});

/* ---------- The shop's fixed quotes ---------- */

describe('the deck charges only the shop’s fixed quotes', () => {
  test('the legacy demo request is refused in the deck scene', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();

    expect(engine.sendDemoRequest(DECK.principal, 2_000)).toBe(false);
    expect(store.requests()).toHaveLength(0);
    expect(orderPosts(fake)).toHaveLength(0);
  });

  test('a signed request for a reference the shop never quoted is denied at lamp 5', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();

    const id = gateIt(forged('SB-0007', 20));
    expect(store.request(id)?.status).toBe('blocked');
    expect(store.request(id)?.lamp).toBe('OUR_POLICY');
    expect(store.gateRun(id).find((c) => c.check === 'OUR_POLICY')?.note).toContain('not an open quote');
    expect(orderPosts(fake)).toHaveLength(0);
  });

  test('a real quote at a made-up price is denied at lamp 5', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();

    const id = gateIt(forged('KS-1041', 1));
    expect(store.request(id)?.lamp).toBe('OUR_POLICY');
    expect(store.gateRun(id).find((c) => c.check === 'OUR_POLICY')?.note).toContain('quote for KS-1041');
    expect(orderPosts(fake)).toHaveLength(0);
  });

  test('a quote already being paid cannot be paid again at the same time', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    fake.state.charge = 'hang';

    buy();
    await until(() => orderPosts(fake).length === 1);
    const second = gateIt(forged('KS-1041', 8));
    expect(store.request(second)?.status).toBe('blocked');
    expect(store.gateRun(second).find((c) => c.check === 'OUR_POLICY')?.note).toContain('not an open quote');
    expect(orderPosts(fake)).toHaveLength(1);
    fake.release();
  });

  test('a quote is the shop’s own: one shop’s reference cannot pay another', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();

    // Kestrel Stock's reference, paid to the shop that quoted it: fine on the quote check.
    expect(engine.rule(forged('KS-1041', 8)).checks.find((c) => c.check === 'OUR_POLICY')?.outcome).toBe('pass');

    // Lark Prints' reference, sent to Kestrel Stock: Kestrel never quoted it.
    const larkRef = gateIt(forged('LP-0388', 8));
    expect(store.request(larkRef)?.lamp).toBe('OUR_POLICY');
    expect(store.gateRun(larkRef).find((c) => c.check === 'OUR_POLICY')?.note).toContain('not an open quote');

    // Kestrel's reference, sent to Lark Prints: refused at the merchant, and the quote fails too.
    const elsewhere = buildClean({
      requestId: store.nextRequestId(),
      principal: DECK.principal,
      amount: usd(8),
      reference: 'KS-1041',
      nowMs: Date.now(),
      keyring,
      receiver: OTHER_MERCHANT,
    }).envelope;
    const id = gateIt(elsewhere);
    const checks = store.gateRun(id);
    expect(store.request(id)?.lamp).toBe('COUNTERPARTY');
    expect(checks.find((c) => c.check === 'OUR_POLICY')?.note).toContain('not an open quote');
    expect(orderPosts(fake)).toHaveLength(0);
  });
});

/* ---------- Already connected: no login at all ---------- */

describe('already connected: a pre-authorized wallet', () => {
  test('a configured token PayPal confirms connects without any consent, and pays', async () => {
    const fake = fakePayPal();
    fake.state.tokens.add('PREAUTH1');
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'live');
    engine = new Engine(store, keyring, fake.paypal, {
      appHash: APP,
      candidates: [{ vaultId: 'PREAUTH1', source: 'configured' }],
    });

    expect((await engine.refreshWallet()).ok).toBe(true);
    expect(wallet()?.state).toBe('connected');
    expect(wallet()?.source).toBe('configured');
    expect(setupPosts(fake)).toHaveLength(0);
    expect(tokenReads(fake).map((c) => c.path)).toEqual(['/v3/vault/payment-tokens/PREAUTH1']);

    engine.approveGrant();
    buy();
    await until(() => slot('S1').state === 'unlocked');
    const body = orderPosts(fake)[0]?.body as { payment_source: { paypal: { vault_id: string } } };
    expect(body.payment_source.paypal.vault_id).toBe('PREAUTH1');
  });

  test('a configured token PayPal does not know is not used, and says why', async () => {
    const fake = fakePayPal();
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'live');
    engine = new Engine(store, keyring, fake.paypal, {
      appHash: APP,
      candidates: [{ vaultId: 'NOT-A-TOKEN', source: 'configured' }],
    });

    expect((await engine.refreshWallet()).ok).toBe(false);
    expect(wallet()?.state).toBe('none');
    expect(wallet()?.note).toContain('pre-authorized wallet');
    expect(engine.approveGrant().ok).toBe(false);
  });

  test('the tested run’s wallet is used when nothing is configured, and checked first', async () => {
    const fake = fakePayPal();
    fake.state.tokens.add('TESTED1');
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'live');
    engine = new Engine(store, keyring, fake.paypal, {
      appHash: APP,
      candidates: [
        { vaultId: 'GONE-CONFIGURED', source: 'configured' },
        { vaultId: 'TESTED1', source: 'tested_run' },
      ],
    });

    await engine.refreshWallet();
    expect(wallet()?.state).toBe('connected');
    expect(wallet()?.source).toBe('tested_run');
  });

  test('while PayPal is being asked, nothing can be charged', async () => {
    const fake = fakePayPal();
    fake.state.tokens.add('PREAUTH1');
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'live');
    engine = new Engine(store, keyring, fake.paypal, {
      appHash: APP,
      candidates: [{ vaultId: 'PREAUTH1', source: 'configured' }],
    });

    const check = engine.refreshWallet();
    expect(wallet()?.state).toBe('checking');
    expect(grant()?.status).toBe('needs_wallet');
    await check;
    expect(wallet()?.state).toBe('connected');
  });

  test('if PayPal cannot be reached, a saved wallet is kept for "Check again"', async () => {
    const { fake } = await live();
    await consent();

    fake.state.unreachable = true;
    expect((await engine.refreshWallet()).ok).toBe(false);
    expect(wallet()?.state).toBe('none');
    expect(wallet()?.note).toContain('Couldn’t reach PayPal');
    expect(wallet()?.canRecheck).toBe(true);

    fake.state.unreachable = false;
    expect((await engine.checkWallet()).ok).toBe(true);
    expect(wallet()?.state).toBe('connected');
    expect(wallet()?.source).toBe('consent');
  });

  test('the latest thing that happened is what the wallet shows', async () => {
    const fake = fakePayPal();
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'live');
    engine = new Engine(store, keyring, fake.paypal, {
      appHash: APP,
      candidates: [{ vaultId: 'NOT-A-TOKEN', source: 'configured' }],
    });

    // A setup cancelled earlier, then a check that finds the configured token
    // refused: the check is the news, not the old cancel.
    await engine.connectWallet();
    engine.cancelWalletSetup(null);
    expect(wallet()?.state).toBe('cancelled');
    await engine.refreshWallet();
    expect(wallet()?.state).toBe('none');
    expect(wallet()?.note).toContain('pre-authorized wallet');

    // And a new attempt after that check is the news again.
    await engine.connectWallet();
    engine.cancelWalletSetup(null);
    expect(wallet()?.state).toBe('cancelled');
    expect(wallet()?.note).toBe('Cancelled here.');
  });

  test('a saved wallet is only reused by the merchant app that saved it', async () => {
    const { fake } = await live();
    await consent();

    const otherApp = new Engine(store, keyring, fake.paypal, { appHash: 'another-app', candidates: [] });
    await otherApp.refreshWallet();
    expect(wallet()?.state).toBe('none');
    otherApp.stop();
  });
});

/* ---------- Waiting, cancelled, expired ---------- */

describe('retry and replay: waiting, cancelled, expired', () => {
  test('reopening a waiting setup reuses its link while PayPal still has it', async () => {
    const { fake } = await live();
    const first = await engine.connectWallet();

    fake.state.setupRead = 'PAYER_ACTION_REQUIRED';
    const again = await engine.connectWallet();
    expect(again.approvalUrl).toBe(first.approvalUrl);
    expect(setupPosts(fake)).toHaveLength(1);
  });

  test('a setup PayPal no longer has shows as expired, and the retry is a fresh attempt', async () => {
    const { fake } = await live();
    await engine.connectWallet();
    const old = attempt();

    fake.state.setupRead = 'missing';
    const reopened = await engine.connectWallet();
    expect(reopened.ok).toBe(false);
    expect(wallet()?.state).toBe('expired');

    fake.state.setupRead = 'APPROVED';
    const fresh = await engine.connectWallet();
    expect(fresh.approvalUrl).toContain('ba_token=2');
    expect(attempt().attempt_id).not.toBe(old.attempt_id);
    const [one, two] = setupPosts(fake);
    // A repeated PayPal-Request-Id would hand back the dead setup.
    expect(one?.headers['paypal-request-id']).not.toBe(two?.headers['paypal-request-id']);

    // The old attempt's return is refused; the new one's connects.
    expect((await engine.walletReturned(old.attempt_id, old.setup_id)).ok).toBe(false);
    expect((await engine.walletReturned(attempt().attempt_id, attempt().setup_id)).ok).toBe(true);
  });

  test('a setup that expires at the return also shows as expired', async () => {
    const { fake } = await live();
    await engine.connectWallet();

    fake.state.setupRead = 'missing';
    const back = await engine.walletReturned(attempt().attempt_id, attempt().setup_id);
    expect(back.ok).toBe(false);
    expect(wallet()?.state).toBe('expired');
  });

  test('cancelling on PayPal’s page, or here, leaves nothing saved; a stale cancel is ignored', async () => {
    const { fake } = await live();
    await engine.connectWallet();

    expect(engine.cancelWalletSetup('not-this-attempt').ok).toBe(false);
    expect(wallet()?.state).toBe('waiting');

    expect(engine.cancelWalletSetup(attempt().attempt_id).ok).toBe(true);
    expect(wallet()?.state).toBe('cancelled');
    expect(posts(fake, '/v3/vault/payment-tokens')).toHaveLength(0);

    await engine.connectWallet();
    expect(wallet()?.state).toBe('waiting');
    expect(engine.cancelWalletSetup(null).ok).toBe(true);
    expect(wallet()?.state).toBe('cancelled');
    expect(setupPosts(fake)).toHaveLength(2);
  });

  test('forgetting the saved wallet requires a new PayPal login; a configured vault id is checked again', async () => {
    const { fake } = await live();
    await consent();
    expect(wallet()?.source).toBe('consent');

    store.forgetPaypalWallet();
    await engine.refreshWallet();
    expect(wallet()?.state).toBe('none');
    expect(setupPosts(fake)).toHaveLength(1);

    engine.stop();
    const pre = fakePayPal();
    pre.state.tokens.add('PREAUTH1');
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'live');
    engine = new Engine(store, keyring, pre.paypal, {
      appHash: APP,
      candidates: [{ vaultId: 'PREAUTH1', source: 'configured' }],
    });
    await engine.refreshWallet();
    store.forgetPaypalWallet();
    await engine.refreshWallet();
    expect(wallet()?.state).toBe('connected');
    expect(wallet()?.source).toBe('configured');
    expect(setupPosts(pre)).toHaveLength(0);
  });

  test('the amount on the approve button is the cap the gate enforces', async () => {
    const { fake } = await live();
    await consent();
    expect(engine.offerBudget(usd(12)).ok).toBe(true);
    expect(grant()?.budget).toBe(usd(12));
    expect(engine.approveGrant(usd(6)).ok).toBe(true);
    expect(grant()?.budget).toBe(usd(6));
    expect(grant()?.left).toBe(usd(6));
    expect(engine.offerBudget(usd(40)).ok).toBe(false);
    expect(grant()?.budget).toBe(usd(6));

    const id = gateIt(forged('KS-1041', 8));
    expect(store.request(id)?.status).not.toBe('paid');
    expect(orderPosts(fake)).toHaveLength(0);
  });

  test('a demo reset keeps the wallet connected but asks for the budget again', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    buy();
    await until(() => slot('S1').state === 'unlocked');

    engine.stop();
    reseedDeck(store, keyring, 'live');
    engine.start();
    const reads = tokenReads(fake).length;
    await engine.refreshWallet();

    expect(tokenReads(fake).length).toBe(reads + 1); // asked PayPal again
    expect(setupPosts(fake)).toHaveLength(1); // no new login
    expect(wallet()?.state).toBe('connected');
    expect(grant()?.status).toBe('needs_approval');
    expect(grant()?.left).toBe(usd(20));
    expect(store.deckView().every((s) => s.state === 'locked')).toBe(true);
    expect(engine.buyNextImage().ok).toBe(false);

    engine.approveGrant();
    buy();
    await until(() => slot('S1').state === 'unlocked');
    expect(orderPosts(fake)).toHaveLength(2);
    expect(store.snapshot().buyerPrompts).toBe(0);
  });

  test('a run seeded under the other PayPal setting starts a new night', () => {
    store = openStore(':memory:');
    reseedDeck(store, keyring, 'simulated');
    expect(ensureDeckScene(store, keyring, 'simulated')).toBe(false);
    expect(ensureDeckScene(store, keyring, 'live')).toBe(true);
    expect(store.walletView()?.mode).toBe('live');
    store.close();
  });
});

/* ---------- Unresolved payments ---------- */

describe('unresolved payments stay available for reconciliation', () => {
  test('a reservation counts against the budget while the charge is with PayPal', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    fake.state.charge = 'hang';

    buy();
    await until(() => orderPosts(fake).length === 1);
    expect(store.grantView()?.reserved).toBe(usd(8));
    expect(engine.buyNextImage().ok).toBe(false); // one at a time

    fake.release();
    await until(() => slot('S1').state === 'unlocked');
    expect(store.grantView()?.reserved).toBe(usd(0));
    expect(store.grantView()?.spent).toBe(usd(8));
  });

  test('PayPal asking for the buyer releases the budget and counts a prompt', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    fake.state.charge = 'buyer_action';

    buy();
    await until(() => slot('S1').state === 'blocked');
    expect(store.snapshot().buyerPrompts).toBe(1);
    expect(store.grantView()?.left).toBe(usd(20));
  });

  test('a refusal with PAYER_ACTION_REQUIRED is a prompt too, and releases the budget', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    fake.state.charge = 'http422';

    buy();
    await until(() => slot('S1').state === 'blocked');
    expect(store.snapshot().buyerPrompts).toBe(1);
    expect(store.grantView()?.left).toBe(usd(20));
  });

  test('no answer keeps the budget reserved and stops the next purchase', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    fake.state.charge = 'timeout';

    const id = buy();
    await until(() => store.charge(id)?.status === 'unknown');
    expect(slot('S1').state).toBe('charging');
    expect(store.grantView()?.reserved).toBe(usd(8));
    expect(store.snapshot().unresolved.count).toBe(1);
    expect(store.snapshot().unresolved.withoutOrder).toBe(1);
    expect(engine.buyNextImage().ok).toBe(false);
  });

  test('a pending charge survives a reset and is settled by reconciliation on its own record', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    fake.state.charge = 'pending';

    const id = buy();
    await until(() => store.charge(id)?.status === 'unknown');
    const pending = store.charge(id);
    if (!pending) throw new Error('no charge');

    engine.stop();
    reseedDeck(store, keyring, 'live');
    engine.start();
    await engine.refreshWallet();

    // Carried over, from an earlier run, and not holding this run up.
    expect(store.snapshot().unresolved).toEqual({ count: 1, fromEarlierRuns: 1, withoutOrder: 0 });
    expect(store.chargesInFlight()).toBe(0);

    fake.state.ordersSettle = true;
    const outcome = await engine.reconcileCharges();
    expect(outcome.message).toContain('Settled 1 of 1');
    expect(store.chargeById(pending.paypal_request_id)?.status).toBe('completed');
    expect(store.snapshot().unresolved.count).toBe(0);
    // This run's budget and slots were never touched by the old charge.
    expect(store.grantView()?.spent).toBe(usd(0));
    expect(store.deckView().every((s) => s.state === 'locked')).toBe(true);
  });

  test('a charge a stopped server left in flight becomes unknown when the engine starts again', async () => {
    const { fake } = await live();
    await consent();
    engine.approveGrant();
    fake.state.charge = 'hang';

    const id = buy();
    await until(() => store.charge(id)?.status === 'submitted');
    engine.stop();

    // A new process: it is not waiting on that call.
    const restarted = new Engine(store, keyring, fake.paypal, { appHash: APP });
    restarted.start();
    expect(store.charge(id)?.status).toBe('unknown');
    expect(store.snapshot().unresolved.count).toBe(1);
    restarted.stop();
    fake.release();
  });
});

/* ---------- No credentials ---------- */

describe('without PayPal credentials', () => {
  test('the consent and the charges are simulated, and labelled so', async () => {
    simulated();
    expect(wallet()?.mode).toBe('simulated');
    expect((await engine.connectWallet()).ok).toBe(false);
    expect(engine.simulateWallet().ok).toBe(true);
    expect(wallet()?.state).toBe('connected');
    expect(wallet()?.source).toBe('simulated');
    expect(engine.approveGrant().ok).toBe(true);

    buy();
    expect(slot('S1').state).toBe('unlocked');
    expect(slot('S1').mode).toBe('simulated');
    expect(slot('S1').captureId).toBeNull();
  });

  test('a simulated consent is refused when PayPal is configured', async () => {
    await live();
    expect(engine.simulateWallet().ok).toBe(false);
  });
});

describe('PayPal amounts', () => {
  test('cents and PayPal values round-trip without floats', () => {
    expect(toValue(usd(8))).toBe('8.00');
    expect(toValue(usd(20.5))).toBe('20.50');
    expect(fromValue('8.00')).toBe(800);
    expect(fromValue('8')).toBe(800);
    expect(fromValue('8.5')).toBe(850);
    expect(fromValue('8.001')).toBeNull();
    expect(fromValue(8)).toBeNull();
  });
});
