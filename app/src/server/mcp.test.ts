/**
 * The connector, spoken to by the official MCP client.
 *
 * The protocol is the SDK's, so what is tested here is that the two halves
 * really meet: a client of each protocol era can find the seven tools and drive
 * one purchase through them, and nothing answers without the bearer token.
 *
 * The client's `fetch` is the connector's own handler, so no port is opened.
 */

// First, so the MCP client below is loaded onto the runtime's own fetch classes.
import './native-globals.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { reseedDeck } from '../../scripts/deck.ts';
import { generateKeyPair } from './crypto.ts';
import { openStore, type Store } from './db.ts';
import { DECK } from './deck.ts';
import { Engine } from './engine.ts';
import { habitA, many } from './habits.ts';
import { loadKeyring } from './keys.ts';
import { LiveVerifier } from './live.ts';
import { CONNECTOR_PATH, createConnector } from './mcp.ts';
import { EMPTY_BANK, memoryReference, withSample } from './reference.ts';
import { localSigner } from './signer.ts';

const keyring = loadKeyring();
const TOKEN = 'connector-token-for-tests-0123456789';
const URL_BASE = `http://connector.test${CONNECTOR_PATH}`;

let store: Store;
let engine: Engine;
let live: LiveVerifier;
let refused: string[];
let connector: ReturnType<typeof createConnector>;

afterEach(() => {
  live?.stop();
  engine?.stop();
});

/** A simulated night — no PayPal credentials — with the signer enrolled and a calibrated stand-in reference. */
async function night(): Promise<void> {
  store = openStore(':memory:');
  reseedDeck(store, keyring, 'simulated');
  engine = new Engine(store, keyring, null);
  engine.simulateWallet();
  engine.approveGrant();

  const bank = many(habitA, 8).reduce(
    (b, numbers, i) => withSample(b, 'Test model', numbers, `test:${i}`, '2026-11-12T00:00:00Z'),
    EMPTY_BANK,
  );
  live = new LiveVerifier({
    store,
    engine,
    keyring,
    signer: localSigner(generateKeyPair(), {
      registryId: DECK.registryId,
      scope: 'stock_images',
      maxAmount: DECK.budget,
      maxTtlMs: 600_000,
    }),
    erc8004: null,
    readRegistration: async () => ({ kind: 'unreachable', reason: 'not configured in this test' }),
    reference: memoryReference(bank),
    endpoint: URL_BASE,
    settleWaitMs: 500,
  });
  live.start();
  await live.enroll();

  refused = [];
  connector = createConnector({ live, token: TOKEN, onRefused: (why) => refused.push(why) });
}

async function connect(mode: 'legacy' | 'auto', token: string = TOKEN): Promise<Client> {
  const client = new Client({ name: 'connector-test', version: '0.0.0' }, { versionNegotiation: { mode } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(URL_BASE), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (input, init) => connector.fetch(new Request(input, init)),
    }),
  );
  return client;
}

const textOf = (result: { content?: unknown }): string =>
  (Array.isArray(result.content) ? result.content : [])
    .map((block: { type?: string; text?: string }) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');

const dataOf = (result: { structuredContent?: unknown }): { readonly [key: string]: unknown } =>
  (result.structuredContent ?? {}) as { readonly [key: string]: unknown };

const post = (body: unknown, headers: Record<string, string> = {}, path = CONNECTOR_PATH): Promise<Response> =>
  connector.fetch(
    new Request(`http://connector.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    }),
  );

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

for (const mode of ['legacy', 'auto'] as const) {
  describe(`an MCP client (${mode === 'legacy' ? '2025-era handshake' : 'negotiating the current revision'})`, () => {
    test('finds seven tools, the flow’s instructions, and which of them only read', async () => {
      await night();
      const client = await connect(mode);

      expect(client.getServerVersion()).toMatchObject({ name: 'agenttrust' });
      expect(client.getInstructions()).toContain('begin_verification');

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'begin_verification',
        'get_budget_request_status',
        'get_connector_status',
        'get_purchase_status',
        'request_budget_change',
        'sign_and_submit',
        'submit_model_reply',
      ]);
      expect(tools.some((t) => /approve|set_budget|decide/i.test(t.name))).toBe(false);
      const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
      expect(readOnly).toEqual(['get_budget_request_status', 'get_connector_status', 'get_purchase_status']);
      const change = tools.find((t) => t.name === 'request_budget_change');
      expect(change?.description).toContain('never changes');
      expect(change?.description).toContain('cannot approve');

      const begin = tools.find((t) => t.name === 'begin_verification');
      expect(begin?.description).toContain('budget');
      expect(JSON.stringify(begin?.inputSchema)).toContain('budget');
      expect(JSON.stringify(begin?.inputSchema)).toContain('currency');
      expect(client.getInstructions()).toContain('my budget is $30');

      const reply = tools.find((t) => t.name === 'submit_model_reply');
      expect(reply?.inputSchema).toMatchObject({ type: 'object', required: ['run_id', 'reply'] });
      // Every setup step stays off the connector: there is nothing here that resets, enrolls or approves.
      expect(tools.some((t) => /reset|enroll|approve|grant|wallet|revoke/.test(t.name))).toBe(false);
      await client.close();
    });

    test('drives one purchase from quote to receipt, and the page shows the same run', async () => {
      await night();
      const client = await connect(mode);

      const status = await client.callTool({ name: 'get_connector_status', arguments: {} });
      expect(status.isError).toBeFalsy();
      expect(dataOf(status)).toMatchObject({ ready: true, ready_to_record: false, signer: 'reachable' });

      const begun = await client.callTool({ name: 'begin_verification', arguments: { amount_usd: 8 } });
      expect(begun.isError).toBeFalsy();
      const runId = dataOf(begun).run_id as string;
      expect(dataOf(begun)).toMatchObject({ stage: 'awaiting_reply', quote: { reference: 'KS-1041', amount: 'USD 8.00' } });
      expect(textOf(begun)).toContain('Choose 294 integers from 1 through 355');

      const scored = await client.callTool({
        name: 'submit_model_reply',
        arguments: { run_id: runId, reply: habitA(4242).join(', ') },
      });
      expect(dataOf(scored)).toMatchObject({ stage: 'awaiting_signature', layer1_model_signal: { result: 'match', received: 294 } });

      const submitted = await client.callTool({ name: 'sign_and_submit', arguments: { run_id: runId } });
      // No PayPal credentials in this test: every check ran, and it says so instead of claiming a payment.
      expect(dataOf(submitted)).toMatchObject({
        stage: 'simulated',
        payment: { status: 'SIMULATED', request_id: 'R-0001' },
        layer3_authorization: { result: 'passed', line: 'Buyer authorization passed · within the approved $20 budget ($20 left)' },
        budget: { authorized: 'USD 20.00', left: 'USD 12.00' },
      });

      const read = await client.callTool({ name: 'get_purchase_status', arguments: { run_id: runId } });
      expect(dataOf(read)).toMatchObject({ run_id: runId, stage: 'simulated', final: true });

      const page = store.snapshot();
      expect(page.live).toMatchObject({ runId, stage: 'simulated', requestId: 'R-0001' });
      expect(page.connector).toMatchObject({ lastTool: 'get_purchase_status' });
      expect(store.requests()).toHaveLength(1);
      await client.close();
    });

    test('a refusal comes back as a tool error with the reason, not as a protocol failure', async () => {
      await night();
      const client = await connect(mode);

      const unknown = await client.callTool({ name: 'sign_and_submit', arguments: { run_id: 'no-such-run-id' } });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toContain('There is no run "no-such-run-id"');

      const begun = await client.callTool({ name: 'begin_verification', arguments: { item: 'night market' } });
      const short = await client.callTool({
        name: 'submit_model_reply',
        arguments: { run_id: dataOf(begun).run_id, reply: '1, 2, 3' },
      });
      expect(short.isError).toBe(true);
      expect(dataOf(short)).toMatchObject({ stage: 'awaiting_reply', layer1_model_signal: { result: 'insufficient', received: 3 } });
      await client.close();
    });
  });
}

describe('who may call', () => {
  test('without the bearer token nothing answers — not even the handshake', async () => {
    await night();
    for (const headers of [{}, { authorization: 'Bearer wrong-token-0000000000000000' }, { authorization: `Basic ${TOKEN}` }]) {
      const response = await post(INITIALIZE, headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="agenttrust"');
      expect(await response.text()).not.toContain('agenttrust"}');
    }
    expect(refused).toEqual(['no bearer token', 'wrong bearer token', 'no bearer token']);
    // The refusals named no token, and a client with the wrong one cannot connect at all.
    expect(refused.join(' ')).not.toContain(TOKEN);
    await expect(connect('legacy', 'wrong-token-0000000000000000')).rejects.toThrow();
    expect(store.snapshot().connector?.lastTool ?? null).toBeNull();
  });

  test('with it, a hand-written 2025-era handshake is answered, as JSON or as one event', async () => {
    await night();
    const response = await post(INITIALIZE, { authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);

    // The SDK may answer a 2025-era request as a single JSON body or as a one-event stream; a client accepts both.
    const raw = await response.text();
    const json = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? (raw.split('\n').find((line) => line.startsWith('data:')) ?? '').slice('data:'.length)
      : raw;
    const body = JSON.parse(json) as { result?: { serverInfo?: { name?: string }; capabilities?: { tools?: unknown } } };
    expect(body.result?.serverInfo?.name).toBe('agenttrust');
    expect(body.result?.capabilities?.tools).toBeDefined();
  });

  test('a web page’s origin is refused, and an allowed one is let through to the token check', async () => {
    await night();
    const fromPage = await post(INITIALIZE, { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' });
    expect(fromPage.status).toBe(403);
    expect(refused).toEqual(['origin https://evil.example is not allowed']);

    connector = createConnector({ live, token: TOKEN, allowedOrigins: ['https://console.example'] });
    expect((await post(INITIALIZE, { authorization: `Bearer ${TOKEN}`, origin: 'https://console.example' })).status).toBe(200);
    expect((await post(INITIALIZE, { origin: 'https://console.example' })).status).toBe(401);
  });

  test('only the one path exists on the connector: the setup and demo routes are not there to find', async () => {
    await night();
    for (const path of ['/', '/api/state', '/api/demo/reset', '/api/grant/approve', '/api/budget/decide', '/api/agent/enroll', '/mcp/extra']) {
      const response = await post({}, { authorization: `Bearer ${TOKEN}` }, path);
      expect(response.status).toBe(404);
    }
  });
});
