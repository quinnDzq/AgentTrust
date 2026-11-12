/**
 * Reading an ERC-8004 registration: what each answer from a chain comes to.
 *
 * The chain here is a function that answers JSON-RPC the way a node does. The
 * shapes — a 32-byte owner word, an ABI-encoded string, error code 3 for a
 * revert — are the ones the reference registry returned when this reader was
 * run against it on Base Sepolia and Ethereum Sepolia.
 */

import { describe, expect, test } from 'bun:test';
import {
  decodeAddress,
  decodeString,
  erc8004FromEnv,
  KEY_SERVICE,
  readRegistration,
  REFERENCE_TESTNET_REGISTRY,
  statedKeyOf,
  type Erc8004Config,
} from './erc8004.ts';

const OWNER = '0x00000000000000000000000000000000000a11ce';
const KEY = Buffer.alloc(32, 42).toString('base64url');

const CONFIG: Erc8004Config = {
  network: 'Base Sepolia',
  chainId: 84532,
  rpcUrl: 'https://rpc.invalid',
  registry: REFERENCE_TESTNET_REGISTRY,
  agentId: '7',
  expectedOwner: OWNER,
  explorerUrl: null,
};

const hex = (n: number): string => `0x${n.toString(16)}`;
const ownerWord = (address: string): string => `0x${'0'.repeat(24)}${address.slice(2)}`;

/** ABI-encode a string the way `tokenURI` returns one. */
function abiString(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]);
  const word = (n: number): string => n.toString(16).padStart(64, '0');
  return `0x${word(32)}${word(bytes.length)}${padded.toString('hex')}`;
}

const dataUri = (file: unknown): string =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(file), 'utf8').toString('base64')}`;

interface Call {
  readonly method: string;
  readonly params: readonly unknown[];
}

type Answer = { result: unknown } | { error: { code: number; message: string } } | 'down' | { http: number };

/** A node that answers each method as told, and records what it was asked. */
function chain(answers: { readonly [method: string]: Answer | ((call: Call) => Answer) }): {
  readonly fetchImpl: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = JSON.parse(String(init?.body)) as Call & { id: number };
    calls.push({ method: call.method, params: call.params });
    const key = call.method === 'eth_call' ? `eth_call:${(call.params[0] as { data: string }).data.slice(0, 10)}` : call.method;
    const told = answers[key] ?? answers[call.method];
    const answer = typeof told === 'function' ? told(call) : told;
    if (answer === undefined || answer === 'down') throw new Error('socket hang up');
    if ('http' in answer) return { ok: false, status: answer.http, json: async () => ({}) } as unknown as Response;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: call.id, ...answer }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OWNER_OF = 'eth_call:0x6352211e';
const TOKEN_URI = 'eth_call:0xc87b56dd';

const healthy = (uri: string) => ({
  eth_chainId: { result: hex(84532) },
  eth_blockNumber: { result: hex(57_790_696) },
  [OWNER_OF]: { result: ownerWord(OWNER) },
  [TOKEN_URI]: { result: abiString(uri) },
});

describe('reading a registration', () => {
  test('the owner, the block and the file, all read at one block from the registry itself', async () => {
    const uri = dataUri({ name: 'Deck Agent', services: [{ name: KEY_SERVICE, endpoint: 'urn:agenttrust:AGT-DECK-1', publicKey: KEY }] });
    const { fetchImpl, calls } = chain(healthy(uri));
    const read = await readRegistration(CONFIG, fetchImpl);

    expect(read).toEqual({
      kind: 'found',
      chainId: 84532,
      blockNumber: 57_790_696,
      owner: OWNER,
      agentUri: uri,
      statedKey: KEY,
    });

    const ethCalls = calls.filter((c) => c.method === 'eth_call');
    expect(ethCalls).toHaveLength(2);
    for (const call of ethCalls) {
      const [tx, block] = call.params as [{ to: string; data: string }, string];
      expect(tx.to).toBe(REFERENCE_TESTNET_REGISTRY);
      // The agent id as one 32-byte word after the selector.
      expect(tx.data.slice(10)).toBe('7'.padStart(64, '0'));
      expect(block).toBe(hex(57_790_696));
    }
  });

  test('a registry that reverts for the id has no such agent: that is an answer, not an outage', async () => {
    const { fetchImpl } = chain({
      ...healthy(''),
      [OWNER_OF]: { error: { code: 3, message: 'execution reverted' } },
    });
    expect(await readRegistration(CONFIG, fetchImpl)).toEqual({
      kind: 'absent',
      blockNumber: 57_790_696,
      reason: 'the registry has no agent with that id.',
    });
  });

  test('an address with no registry behind it, or an unowned registration, is absent too', async () => {
    const empty = chain({ ...healthy(''), [OWNER_OF]: { result: '0x' } });
    expect(await readRegistration(CONFIG, empty.fetchImpl)).toMatchObject({
      kind: 'absent',
      reason: 'nothing at that address answers like an identity registry.',
    });

    const burned = chain({ ...healthy(''), [OWNER_OF]: { result: ownerWord(`0x${'0'.repeat(40)}`) } });
    expect(await readRegistration(CONFIG, burned.fetchImpl)).toMatchObject({ kind: 'absent' });
  });

  test('an endpoint on another chain is the wrong chain, and nothing more is asked of it', async () => {
    const { fetchImpl, calls } = chain({ ...healthy(''), eth_chainId: { result: hex(1) } });
    expect(await readRegistration(CONFIG, fetchImpl)).toEqual({ kind: 'wrong_chain', chainId: 1 });
    expect(calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  test('an endpoint that is down, slow, or answering errors establishes nothing', async () => {
    expect(await readRegistration(CONFIG, chain({ eth_chainId: 'down' }).fetchImpl)).toEqual({
      kind: 'unreachable',
      reason: 'the RPC endpoint did not answer.',
    });
    expect(await readRegistration(CONFIG, chain({ eth_chainId: { http: 429 } }).fetchImpl)).toEqual({
      kind: 'unreachable',
      reason: 'the RPC endpoint answered HTTP 429.',
    });
    expect(await readRegistration(CONFIG, chain({ ...healthy(''), eth_blockNumber: { result: 'latest' } }).fetchImpl)).toMatchObject({
      kind: 'unreachable',
    });
    // An error that is not a revert is the endpoint failing, not the chain saying no.
    const limited = chain({ ...healthy(''), [OWNER_OF]: { error: { code: -32005, message: 'rate limit exceeded' } } });
    expect(await readRegistration(CONFIG, limited.fetchImpl)).toEqual({
      kind: 'unreachable',
      reason: 'the RPC endpoint refused the read (error -32005).',
    });
  });

  test('the owner is still found when the registry gives no file', async () => {
    const { fetchImpl } = chain({ ...healthy(''), [TOKEN_URI]: { error: { code: 3, message: 'execution reverted' } } });
    expect(await readRegistration(CONFIG, fetchImpl)).toMatchObject({ kind: 'found', owner: OWNER, agentUri: null, statedKey: undefined });
  });
});

describe('the key a registration names', () => {
  test('a file carried on-chain is read: the AgentTrust service’s key, or null when it names none', () => {
    expect(statedKeyOf(dataUri({ services: [{ name: 'MCP', endpoint: 'https://x' }, { name: 'agenttrust', publicKey: KEY }] }))).toBe(KEY);
    expect(statedKeyOf(dataUri({ endpoints: [{ name: KEY_SERVICE, publicKey: KEY }] }))).toBe(KEY);
    expect(statedKeyOf(dataUri({ name: 'an agent', services: [{ name: 'MCP', endpoint: 'https://x' }] }))).toBeNull();
    expect(statedKeyOf(dataUri({ services: [{ name: KEY_SERVICE, publicKey: 'not a key' }] }))).toBeNull();
    expect(statedKeyOf(`data:application/json,${encodeURIComponent(JSON.stringify({ services: [{ name: KEY_SERVICE, publicKey: KEY }] }))}`)).toBe(KEY);
  });

  test('a file behind a link is not fetched, so nothing is known about it', () => {
    expect(statedKeyOf('ipfs://QmPxKi3ZZW3i3kkrwoer8E5o9TRimh2X5KJxjwaTc')).toBeUndefined();
    expect(statedKeyOf('https://example.com/agent.json')).toBeUndefined();
    expect(statedKeyOf('data:application/json;base64,!!!not-json!!!')).toBeUndefined();
    expect(statedKeyOf(null)).toBeUndefined();
  });
});

describe('decoding what a node returns', () => {
  test('an address is the last twenty bytes of one word, and nothing else is an address', () => {
    expect(decodeAddress(ownerWord('0xABCDEF0000000000000000000000000000000001'))).toBe('0xabcdef0000000000000000000000000000000001');
    expect(decodeAddress('0x')).toBeNull();
    expect(decodeAddress(`${ownerWord(OWNER)}00`)).toBeNull();
    expect(decodeAddress(42)).toBeNull();
  });

  test('a string survives the round trip, and a malformed or oversized one is refused', () => {
    for (const text of ['', 'ipfs://abc', 'data:application/json;base64,eyJ9', 'ünïcödé ✓', 'x'.repeat(777)]) {
      expect(decodeString(abiString(text))).toBe(text);
    }
    expect(decodeString('0x')).toBeNull();
    expect(decodeString(`0x${'f'.repeat(128)}`)).toBeNull();
    expect(decodeString(abiString('x'.repeat(40_000)))).toBeNull();
    expect(decodeString('0xzz')).toBeNull();
  });
});

describe('configuration', () => {
  test('nothing set is no registration, which is a state and not a mistake', () => {
    expect(erc8004FromEnv({})).toEqual({ config: null, problem: null });
  });

  test('an agent id and the team wallet are enough: Base Sepolia and the reference registry are the defaults', () => {
    const { config, problem } = erc8004FromEnv({ AGENTTRUST_ERC8004_AGENT_ID: '0', AGENTTRUST_ERC8004_OWNER: OWNER });
    expect(problem).toBeNull();
    expect(config).toEqual({
      network: 'Base Sepolia',
      chainId: 84532,
      rpcUrl: 'https://sepolia.base.org',
      registry: REFERENCE_TESTNET_REGISTRY,
      agentId: '0',
      expectedOwner: OWNER,
      explorerUrl: `https://sepolia.basescan.org/nft/${REFERENCE_TESTNET_REGISTRY}/0`,
    });
  });

  test('another named testnet, or a chain of your own with its own endpoint and registry', () => {
    expect(
      erc8004FromEnv({
        AGENTTRUST_ERC8004_NETWORK: 'Sepolia',
        AGENTTRUST_ERC8004_AGENT_ID: '12',
        AGENTTRUST_ERC8004_OWNER: OWNER,
      }).config,
    ).toMatchObject({ network: 'Ethereum Sepolia', chainId: 11155111 });

    const custom = erc8004FromEnv({
      AGENTTRUST_ERC8004_NETWORK: 'my-devnet',
      AGENTTRUST_ERC8004_CHAIN_ID: '31337',
      AGENTTRUST_ERC8004_RPC_URL: 'http://127.0.0.1:8545',
      AGENTTRUST_ERC8004_REGISTRY: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      AGENTTRUST_ERC8004_AGENT_ID: '1',
      AGENTTRUST_ERC8004_OWNER: OWNER,
    });
    expect(custom.config).toMatchObject({ network: 'chain 31337', chainId: 31337, explorerUrl: null });
  });

  test('half a configuration is said out loud rather than read as none', () => {
    expect(erc8004FromEnv({ AGENTTRUST_ERC8004_AGENT_ID: '3' }).problem).toContain('AGENTTRUST_ERC8004_OWNER');
    expect(erc8004FromEnv({ AGENTTRUST_ERC8004_OWNER: OWNER }).problem).toContain('AGENTTRUST_ERC8004_AGENT_ID');
    expect(erc8004FromEnv({ AGENTTRUST_ERC8004_AGENT_ID: 'seven', AGENTTRUST_ERC8004_OWNER: OWNER }).config).toBeNull();
    expect(erc8004FromEnv({ AGENTTRUST_ERC8004_AGENT_ID: '3', AGENTTRUST_ERC8004_OWNER: '0x123' }).config).toBeNull();
    expect(
      erc8004FromEnv({ AGENTTRUST_ERC8004_NETWORK: 'my-devnet', AGENTTRUST_ERC8004_AGENT_ID: '3', AGENTTRUST_ERC8004_OWNER: OWNER }).problem,
    ).toContain('AGENTTRUST_ERC8004_REGISTRY');
  });
});
