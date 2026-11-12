/**
 * Reading the Demo Agent's ERC-8004 registration from a testnet.
 *
 * An ERC-8004 Identity Registry is an ERC-721 contract: an agent is a token,
 * its id is the token id, and whoever owns the token owns the registration.
 * Enrollment asks the chain three things, all at one block so they describe one
 * moment: which chain this is, who owns the agent's registration, and what its
 * registration file says.
 *
 * What a successful read establishes is narrow, and the page says no more than
 * this: at that block, that wallet owned that registration. Whether the wallet
 * is the team's is the comparison `LiveVerifier.enroll` makes against the
 * configured address. Nothing here is consulted when a payment is ruled on —
 * the chain is read at enrollment or refresh, and the gate runs on the local
 * registry.
 *
 * Raw JSON-RPC over `fetch`, with the two standard ERC-721 selectors written
 * out, so this needs no web3 library and holds no key: it only ever reads.
 * Buyer data, wallet tokens, budgets and payments never go near the chain.
 */

/** `ownerOf(uint256)` and `tokenURI(uint256)`: the standard ERC-721 selectors. */
const OWNER_OF = '0x6352211e';
const TOKEN_URI = '0xc87b56dd';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const TIMEOUT_MS = 10_000;

/** The largest registration file read out of a `data:` URI. */
const MAX_URI_BYTES = 32 * 1024;

export interface Erc8004Config {
  /** The network's name, as the page shows it. */
  readonly network: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  /** The Identity Registry contract. */
  readonly registry: string;
  /** The agent id, as a decimal string: it is a uint256. */
  readonly agentId: string;
  /** The wallet the team registered the agent with. */
  readonly expectedOwner: string;
  /** A public explorer page for this registration, or null when the network has none. */
  readonly explorerUrl: string | null;
}

/**
 * What the chain said.
 *
 * `statedKey` is the Ed25519 key the registration file names for AgentTrust:
 * a string when it names one, null when the file was read and names none, and
 * undefined when the file is not on-chain and so was not read.
 */
export type RegistrationRead =
  | {
      readonly kind: 'found';
      readonly chainId: number;
      readonly blockNumber: number;
      readonly owner: string;
      readonly agentUri: string | null;
      readonly statedKey: string | null | undefined;
    }
  /** The chain answered, and there is no such registration. */
  | { readonly kind: 'absent'; readonly blockNumber: number; readonly reason: string }
  /** The endpoint is a different chain than the one configured. */
  | { readonly kind: 'wrong_chain'; readonly chainId: number }
  /** Nothing could be established: the endpoint did not answer, or not usably. */
  | { readonly kind: 'unreachable'; readonly reason: string };

/* ---------- Configuration ---------- */

interface Network {
  readonly name: string;
  readonly chainId: number;
  /** A public, keyless endpoint. Rate-limited and best effort: set your own for anything that matters. */
  readonly rpcUrl: string;
  readonly explorer: string;
  readonly registry: string;
}

/**
 * The reference Identity Registry's testnet deployment, as the ERC-8004
 * contracts repository lists it (github.com/erc-8004/erc-8004-contracts). It is
 * the same address on every testnet listed there, and an upgradeable proxy:
 * calls go to this address, never to the implementation behind it.
 *
 * ERC-8004 is still a draft, and this deployment replaced an earlier one in
 * January 2026 — so the address can be overridden, and whatever was actually
 * read is what the page shows.
 */
export const REFERENCE_TESTNET_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

/** Public testnets this can be pointed at by name. */
export const NETWORKS: { readonly [key: string]: Network } = {
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    registry: REFERENCE_TESTNET_REGISTRY,
  },
  sepolia: {
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.etherscan.io',
    registry: REFERENCE_TESTNET_REGISTRY,
  },
};

/** The testnet used when none is named. */
export const DEFAULT_NETWORK = 'base-sepolia';

const isAddress = (value: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(value);

/**
 * The registration to check, from the environment.
 *
 * Nothing set means no registration is configured, which is a state the page
 * shows honestly. Something set but incomplete is a mistake worth saying out
 * loud rather than silently treating as "not configured".
 */
export function erc8004FromEnv(env: { readonly [key: string]: string | undefined }): {
  readonly config: Erc8004Config | null;
  readonly problem: string | null;
} {
  const get = (name: string): string | null => env[name]?.trim() || null;
  const agentId = get('AGENTTRUST_ERC8004_AGENT_ID');
  const owner = get('AGENTTRUST_ERC8004_OWNER');
  if (agentId === null && owner === null) return { config: null, problem: null };

  const fail = (problem: string) => ({ config: null, problem });
  if (agentId === null || !/^\d{1,78}$/.test(agentId)) return fail('AGENTTRUST_ERC8004_AGENT_ID must be the agent id as a whole number.');
  if (owner === null || !isAddress(owner)) return fail('AGENTTRUST_ERC8004_OWNER must be the team wallet’s 0x address.');

  const key = (get('AGENTTRUST_ERC8004_NETWORK') ?? DEFAULT_NETWORK).toLowerCase();
  const known = NETWORKS[key];
  const registry = get('AGENTTRUST_ERC8004_REGISTRY') ?? known?.registry ?? null;
  if (registry === null || !isAddress(registry)) return fail('AGENTTRUST_ERC8004_REGISTRY must be the Identity Registry’s 0x address.');
  const chainText = get('AGENTTRUST_ERC8004_CHAIN_ID');
  const chainId = chainText === null ? (known?.chainId ?? null) : Number(chainText);
  const rpcUrl = get('AGENTTRUST_ERC8004_RPC_URL') ?? known?.rpcUrl ?? null;
  if (chainId === null || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return fail(`AGENTTRUST_ERC8004_NETWORK "${key}" is not one of ${Object.keys(NETWORKS).join(', ')}; set AGENTTRUST_ERC8004_CHAIN_ID.`);
  }
  if (rpcUrl === null || !/^https?:\/\//.test(rpcUrl)) return fail('AGENTTRUST_ERC8004_RPC_URL must be an http(s) JSON-RPC endpoint.');

  return {
    config: {
      network: known?.chainId === chainId ? known.name : `chain ${chainId}`,
      chainId,
      rpcUrl,
      registry,
      agentId,
      expectedOwner: owner,
      explorerUrl: known?.chainId === chainId ? `${known.explorer}/nft/${registry}/${agentId}` : null,
    },
    problem: null,
  };
}

/* ---------- Decoding ---------- */

/** A uint256 as the 32-byte word a call carries. */
const word = (decimal: string): string => BigInt(decimal).toString(16).padStart(64, '0');

const quantity = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) return null;
  const n = Number.parseInt(value, 16);
  return Number.isSafeInteger(n) ? n : null;
};

/** The address in a 32-byte return word, or null when it is not one. */
export function decodeAddress(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) return null;
  return `0x${result.slice(26).toLowerCase()}`;
}

/** An ABI-encoded `string` return value, or null when it is not one or is too long to be a registration URI. */
export function decodeString(result: unknown): string | null {
  if (typeof result !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(result)) return null;
  const bytes = Buffer.from(result.slice(2), 'hex');
  if (bytes.length < 64) return null;
  const offset = Number(BigInt(`0x${bytes.subarray(0, 32).toString('hex')}`));
  if (!Number.isSafeInteger(offset) || offset + 32 > bytes.length) return null;
  const length = Number(BigInt(`0x${bytes.subarray(offset, offset + 32).toString('hex')}`));
  if (!Number.isSafeInteger(length) || length > MAX_URI_BYTES || offset + 32 + length > bytes.length) return null;
  return bytes.subarray(offset + 32, offset + 32 + length).toString('utf8');
}

/** The name a registration file lists AgentTrust's signing key under. */
export const KEY_SERVICE = 'AgentTrust';

/**
 * The Ed25519 key a registration file names for AgentTrust.
 *
 * Only a file carried in the URI itself (`data:application/json`) is read: it
 * is the part of the registration that is actually on-chain. A file behind an
 * https or ipfs link is not fetched, and comes back undefined — not read —
 * rather than null, which means "read, and no key is named".
 */
export function statedKeyOf(agentUri: string | null): string | null | undefined {
  if (agentUri === null) return undefined;
  const match = /^data:application\/json(;charset=[^;,]+)?(;base64)?,(.*)$/s.exec(agentUri);
  if (!match) return undefined;

  let file: unknown;
  try {
    const body = match[3] ?? '';
    file = JSON.parse(match[2] ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body));
  } catch {
    return undefined;
  }
  if (typeof file !== 'object' || file === null) return null;

  const { services, endpoints } = file as { services?: unknown; endpoints?: unknown };
  for (const list of [services, endpoints]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as { name?: unknown; publicKey?: unknown }[]) {
      if (
        typeof entry?.name === 'string' &&
        entry.name.toLowerCase() === KEY_SERVICE.toLowerCase() &&
        typeof entry.publicKey === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(entry.publicKey)
      ) {
        return entry.publicKey;
      }
    }
  }
  return null;
}

/* ---------- Reading ---------- */

type RpcReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly reverted: boolean; readonly code: number | null };

class RpcDown extends Error {}

/**
 * Read a registration at the chain's latest block.
 *
 * Never throws. Every way of failing is one of the answers, so the caller can
 * put the actual result on screen.
 */
export async function readRegistration(
  config: Erc8004Config,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistrationRead> {
  let id = 0;

  async function rpc(method: string, params: readonly unknown[]): Promise<RpcReply> {
    let response: Response;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(TIMEOUT_MS)
          : undefined;
      response = await fetchImpl(config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new RpcDown(err instanceof Error && err.name === 'TimeoutError' ? 'the RPC endpoint timed out.' : 'the RPC endpoint did not answer.');
    }
    if (!response.ok) throw new RpcDown(`the RPC endpoint answered HTTP ${response.status}.`);

    const body = (await response.json().catch(() => null)) as
      | { result?: unknown; error?: { code?: unknown; message?: unknown } }
      | null;
    if (body === null || typeof body !== 'object') throw new RpcDown('the RPC endpoint’s answer was not JSON.');
    if (body.error) {
      const code = typeof body.error.code === 'number' ? body.error.code : null;
      const message = typeof body.error.message === 'string' ? body.error.message : '';
      // A contract that reverts is the chain answering "no". Anything else is the endpoint failing.
      return { ok: false, reverted: code === 3 || /revert/i.test(message), code };
    }
    return { ok: true, result: body.result };
  }

  try {
    const chain = await rpc('eth_chainId', []);
    const chainId = chain.ok ? quantity(chain.result) : null;
    if (chainId === null) return { kind: 'unreachable', reason: 'the RPC endpoint did not say which chain it is.' };
    if (chainId !== config.chainId) return { kind: 'wrong_chain', chainId };

    const head = await rpc('eth_blockNumber', []);
    const blockNumber = head.ok ? quantity(head.result) : null;
    if (blockNumber === null) return { kind: 'unreachable', reason: 'the RPC endpoint did not give a block number.' };
    const at = `0x${blockNumber.toString(16)}`;
    const call = (selector: string): Promise<RpcReply> =>
      rpc('eth_call', [{ to: config.registry, data: `${selector}${word(config.agentId)}` }, at]);

    const owned = await call(OWNER_OF);
    if (!owned.ok) {
      return owned.reverted
        ? { kind: 'absent', blockNumber, reason: 'the registry has no agent with that id.' }
        : { kind: 'unreachable', reason: `the RPC endpoint refused the read${owned.code === null ? '' : ` (error ${owned.code})`}.` };
    }
    const owner = decodeAddress(owned.result);
    if (owner === null) {
      return { kind: 'absent', blockNumber, reason: 'nothing at that address answers like an identity registry.' };
    }
    if (owner === ZERO_ADDRESS) return { kind: 'absent', blockNumber, reason: 'the registration has no owner.' };

    // The file is extra: a registry that will not give one still has an owner.
    const uri = await call(TOKEN_URI);
    const agentUri = uri.ok ? decodeString(uri.result) : null;

    return { kind: 'found', chainId, blockNumber, owner, agentUri, statedKey: statedKeyOf(agentUri) };
  } catch (err) {
    return { kind: 'unreachable', reason: err instanceof RpcDown ? err.message : 'the read failed.' };
  }
}
