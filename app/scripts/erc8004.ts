/**
 * bun run erc8004 — the Demo Agent's ERC-8004 registration, from the operator's side.
 *
 *   bun run erc8004 file [--key <public key>] [--name "<name>"] [--mcp <https url>]
 *       Print the registration file for the agent and the `data:` URI to
 *       register it with. The signer's public key is read from the running
 *       signer service, or given with --key.
 *
 *   bun run erc8004 check
 *       Read the configured registration from the chain and print what it says:
 *       the same read enrollment makes, with nothing written anywhere.
 *
 * This script never sends a transaction and never sees a wallet key.
 * Registering is done with the team's own wallet, in the tool the team already
 * uses — a block explorer's write tab, or Foundry's `cast send`. The file it
 * prints names the signer's Ed25519 key under an "AgentTrust" service, which is
 * what lets enrollment say the registration and the enrolled key belong
 * together. ERC-8004 has no field for a public key; that entry is AgentTrust's
 * own convention inside the spec's `services` list.
 */

import { fingerprint } from '../src/server/crypto.ts';
import { DECK } from '../src/server/deck.ts';
import {
  DEFAULT_NETWORK,
  erc8004FromEnv,
  KEY_SERVICE,
  NETWORKS,
  readRegistration,
  statedKeyOf,
} from '../src/server/erc8004.ts';
import { localSecret, SIGNER_LINK_PATH } from '../src/server/secrets.ts';
import { httpSigner } from '../src/server/signer.ts';

const [command = 'check', ...rest] = process.argv.slice(2);

const flag = (name: string): string | null => {
  const at = rest.indexOf(`--${name}`);
  return at === -1 ? null : (rest[at + 1] ?? null);
};

async function signerKey(): Promise<string> {
  const given = flag('key');
  if (given) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(given)) throw new Error('--key must be the signer’s base64url Ed25519 public key (43 characters)');
    return given;
  }
  const url = process.env.AGENTTRUST_SIGNER_URL?.trim() || 'http://127.0.0.1:8788';
  const signer = httpSigner({ url, token: localSecret(SIGNER_LINK_PATH, process.env.AGENTTRUST_SIGNER_TOKEN) });
  try {
    const identity = await signer.identity();
    if (identity.registryId !== DECK.registryId) throw new Error(`the signer at ${url} is ${identity.registryId}, not ${DECK.registryId}`);
    return identity.publicKey;
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : 'The signer did not answer.'} Start it with \`bun run signer\`, or pass --key <public key>.`,
    );
  }
}

async function file(): Promise<void> {
  const key = await signerKey();
  const mcp = flag('mcp');
  const networkKey = (process.env.AGENTTRUST_ERC8004_NETWORK?.trim() || DEFAULT_NETWORK).toLowerCase();
  const network = NETWORKS[networkKey];

  // The shape ERC-8004 gives a registration file. `registrations` is filled in
  // once the agent id is known — it is only assigned when the transaction is mined.
  const registration = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: flag('name') ?? 'AgentTrust Demo Agent',
    description:
      'Demo agent for the AgentTrust checkout gateway. It signs scoped purchase requests with the Ed25519 key listed under the AgentTrust service.',
    image: flag('image') ?? '',
    services: [
      ...(mcp ? [{ name: 'MCP', endpoint: mcp, version: '2026-07-28' }] : []),
      {
        name: KEY_SERVICE,
        endpoint: `urn:agenttrust:${DECK.registryId}`,
        version: '1',
        keyType: 'Ed25519',
        publicKey: key,
      },
    ],
    x402Support: false,
    active: true,
    registrations: [],
    supportedTrust: [],
  };

  const uri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration), 'utf8').toString('base64')}`;
  if (statedKeyOf(uri) !== key) throw new Error('the file did not read back with the key it was written with');

  console.log('Registration file:\n');
  console.log(JSON.stringify(registration, null, 2));
  console.log(`\nSigner key fingerprint: ${fingerprint(key)}`);
  console.log(`\nAgent URI (${uri.length} characters) — pass this to register(string agentURI):\n`);
  console.log(uri);
  console.log(
    `\nRegister it with the team’s test wallet on ${network?.name ?? networkKey}, at the Identity Registry ${network?.registry ?? '(set AGENTTRUST_ERC8004_REGISTRY)'}:\n` +
      (network ? `  · In a browser: ${network.explorer}/address/${network.registry}#writeProxyContract → register(string agentURI)\n` : '') +
      `  · With Foundry:  cast send ${network?.registry ?? '<registry>'} "register(string)" "<the URI above>" --rpc-url ${network?.rpcUrl ?? '<rpc>'} --private-key <team wallet key>\n` +
      '\nThe agent id is in the transaction’s Registered event (and the NFT it mints). Then set, where the server reads its environment:\n' +
      `  AGENTTRUST_ERC8004_NETWORK=${networkKey}\n  AGENTTRUST_ERC8004_AGENT_ID=<the agent id>\n  AGENTTRUST_ERC8004_OWNER=<the team wallet’s address>\n` +
      '\nRestart the server, run `bun run erc8004 check`, then press Enroll on the live view.',
  );
}

async function check(): Promise<void> {
  const { config, problem } = erc8004FromEnv(process.env);
  if (!config) {
    throw new Error(
      problem ??
        'No registration is configured. Set AGENTTRUST_ERC8004_AGENT_ID and AGENTTRUST_ERC8004_OWNER (and AGENTTRUST_ERC8004_NETWORK if not base-sepolia).',
    );
  }

  console.log(`Reading agent ${config.agentId} from ${config.registry} on ${config.network} (chain ${config.chainId})…`);
  const read = await readRegistration(config);
  switch (read.kind) {
    case 'found': {
      const ours = read.owner.toLowerCase() === config.expectedOwner.toLowerCase();
      console.log(`  block      ${read.blockNumber}`);
      console.log(`  owner      ${read.owner}  ${ours ? '✓ the expected team wallet' : `✗ expected ${config.expectedOwner}`}`);
      console.log(
        `  file       ${read.agentUri === null ? 'none returned' : read.agentUri.length > 80 ? `${read.agentUri.slice(0, 80)}… (${read.agentUri.length} characters)` : read.agentUri}`,
      );
      console.log(
        `  signer key ${
          read.statedKey === undefined
            ? 'not read: the file is not carried on-chain'
            : read.statedKey === null
              ? 'the file names no AgentTrust key'
              : `${read.statedKey} (fingerprint ${fingerprint(read.statedKey)})`
        }`,
      );
      if (config.explorerUrl) console.log(`  explorer   ${config.explorerUrl}`);
      if (!ours) process.exit(2);
      break;
    }
    case 'absent':
      console.log(`  ✗ not registered at block ${read.blockNumber}: ${read.reason}`);
      process.exit(2);
      break;
    case 'wrong_chain':
      console.log(`  ✗ the RPC endpoint is chain ${read.chainId}, not ${config.chainId}`);
      process.exit(2);
      break;
    case 'unreachable':
      console.log(`  ? could not be read: ${read.reason}`);
      process.exit(3);
      break;
    default: {
      const unreachable: never = read;
      throw new Error(`unhandled read ${JSON.stringify(unreachable)}`);
    }
  }
}

try {
  if (command === 'file') await file();
  else if (command === 'check') await check();
  else throw new Error(`unknown command "${command}". Try: file, check`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
