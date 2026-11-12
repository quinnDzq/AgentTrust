/**
 * The keyring: who holds which key.
 *
 * Three groups, and the difference between them is the whole security story:
 *
 *   - **Ours.** The owner's key signs the policy. The crew each hold one so
 *     the audit log can prove which agent did what. None of them can authorise
 *     a payment: the gate denies `registry: 'internal'`, so an Overduel key is
 *     worthless as a payment credential by construction.
 *
 *   - **Counterparties'.** Each demo vendor has two: a *principal* key that
 *     signs grants, and an *agent* key that signs payment requests. We hold
 *     only their public halves in the registry, which is what a real
 *     deployment would have.
 *
 *   - **The demo's.** Because the counterparties are simulated locally, this
 *     file also generates their private keys so the app can play both sides on
 *     one laptop. In a real deployment those simply would not exist here.
 *
 * Secrets live in `keys/secrets.local.json`, which is git-ignored and
 * generated on demand, or in `OVERDUEL_SECRETS` as JSON for a deployment with
 * no writable disk. The public registry is derived from them, never stored
 * separately, so the two can never drift.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AGENT_ORDER, type AgentKey, type Cents, type MandateScope } from '../types.ts';
import { generateKeyPair, type KeyPair } from './crypto.ts';
import { DECK } from './deck.ts';

const SECRETS_PATH = process.env.OVERDUEL_KEYS_PATH ?? 'keys/secrets.local.json';

/** A simulated counterparty: a company, its grant-signing key, and its agent. */
export interface Counterparty {
  readonly principal: string;
  readonly registryId: string;
  /** What this vendor's agent is normally allowed to bill us for. */
  readonly scope: MandateScope;
  /** Signs grants. We hold the public half in the vendor record. */
  readonly principalKey: KeyPair;
  /** Signs payment requests. We hold the public half in the agent registry. */
  readonly agentKey: KeyPair;
  /** Set when this agent's key has been pulled, for the revocation demo. */
  readonly revokedDay: number | null;
  /** The per-payment cap this principal's grants carry, when not the default. */
  readonly cap?: Cents;
  /** The demo day this principal's grants lapse, when not the default. */
  readonly grantExpiresDay?: number;
}

export interface Keyring {
  readonly owner: KeyPair;
  readonly crew: { readonly [K in AgentKey]: KeyPair };
  readonly counterparties: readonly Counterparty[];
}

/**
 * The cast of counterparties the demo plays against.
 *
 * Brightline is revoked on purpose: a revoked agent holding a real, still
 * mathematically valid key is the cleanest demonstration that a good signature
 * is not the same thing as authority.
 */
const CAST: readonly {
  readonly principal: string;
  readonly registryId: string;
  readonly scope: MandateScope;
  readonly revokedDay: number | null;
  readonly cap?: Cents;
  readonly grantExpiresDay?: number;
}[] = [
  { principal: 'Feedco Ltd', registryId: 'VND-114', scope: 'supplies', revokedDay: null },
  { principal: 'Acme Logistics', registryId: 'VND-207', scope: 'logistics', revokedDay: null },
  { principal: 'Northwind Hosting', registryId: 'VND-318', scope: 'hosting', revokedDay: null },
  { principal: 'Kedai Ah Seng', registryId: 'VND-422', scope: 'supplies', revokedDay: null },
  { principal: 'Brightline Media', registryId: 'VND-109', scope: 'subscription', revokedDay: 9 },
  // The AgentTrust deck scene: the buyer's grant to its own agent. The grant
  // never pays more than the whole budget in one go, and lapses with the night.
  {
    principal: DECK.principal,
    registryId: DECK.registryId,
    scope: 'stock_images',
    revokedDay: null,
    cap: DECK.budget,
    grantExpiresDay: DECK.day,
  },
];

/* ---------- On disk ---------- */

interface StoredKeyring {
  readonly version: 1;
  readonly owner: KeyPair;
  readonly crew: Record<string, KeyPair>;
  readonly counterparties: readonly {
    readonly registryId: string;
    readonly principalKey: KeyPair;
    readonly agentKey: KeyPair;
  }[];
}

function build(): StoredKeyring {
  const crew: Record<string, KeyPair> = {};
  for (const key of AGENT_ORDER) crew[key] = generateKeyPair();

  return {
    version: 1,
    owner: generateKeyPair(),
    crew,
    counterparties: CAST.map(({ registryId }) => ({
      registryId,
      principalKey: generateKeyPair(),
      agentKey: generateKeyPair(),
    })),
  };
}

function hydrate(stored: StoredKeyring): Keyring {
  const crew = Object.fromEntries(
    AGENT_ORDER.map((key) => {
      const pair = stored.crew[key];
      if (!pair) throw new Error(`keyring is missing a key for ${key} — run \`bun run keys\``);
      return [key, pair];
    }),
  ) as { readonly [K in AgentKey]: KeyPair };

  const counterparties = CAST.map((entry): Counterparty => {
    const pairs = stored.counterparties.find((c) => c.registryId === entry.registryId);
    if (!pairs) {
      throw new Error(`keyring is missing keys for ${entry.registryId} — run \`bun run keys\``);
    }
    return { ...entry, principalKey: pairs.principalKey, agentKey: pairs.agentKey };
  });

  return { owner: stored.owner, crew, counterparties };
}

/**
 * Load the keyring, generating one on first run.
 *
 * `OVERDUEL_SECRETS` wins when it is set, so a deployment can hold the whole
 * keyring in one environment variable and never write to disk.
 */
export function loadKeyring(): Keyring {
  const fromEnv = process.env.OVERDUEL_SECRETS;
  if (fromEnv) {
    const { stored, added } = withNewCast(JSON.parse(fromEnv) as StoredKeyring);
    if (added.length > 0) {
      // Nowhere to persist them, so they last as long as this process does.
      console.warn(`[keys] generated in-memory keys for ${added.join(', ')}; add them to OVERDUEL_SECRETS`);
    }
    return hydrate(stored);
  }

  if (existsSync(SECRETS_PATH)) {
    const { stored, added } = withNewCast(
      JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) as StoredKeyring,
    );
    if (added.length > 0) writeKeyring(stored);
    return hydrate(stored);
  }

  const fresh = build();
  writeKeyring(fresh);
  return hydrate(fresh);
}

/**
 * Give any cast member added since the keyring was written its own keys.
 *
 * Existing keys are never touched, so every signature already in the database
 * stays valid. Only a counterparty the keyring has never heard of — the deck
 * scene's buyer, for a keyring made before it existed — gets a fresh pair.
 */
function withNewCast(stored: StoredKeyring): { stored: StoredKeyring; added: string[] } {
  const missing = CAST.filter(
    (entry) => !stored.counterparties.some((c) => c.registryId === entry.registryId),
  );
  if (missing.length === 0) return { stored, added: [] };

  return {
    stored: {
      ...stored,
      counterparties: [
        ...stored.counterparties,
        ...missing.map(({ registryId }) => ({
          registryId,
          principalKey: generateKeyPair(),
          agentKey: generateKeyPair(),
        })),
      ],
    },
    added: missing.map((entry) => entry.registryId),
  };
}

/** Write a keyring to disk, creating `keys/` if it is not there yet. */
export function writeKeyring(keyring: StoredKeyring): void {
  mkdirSync(dirname(SECRETS_PATH), { recursive: true });
  writeFileSync(SECRETS_PATH, `${JSON.stringify(keyring, null, 2)}\n`, 'utf8');
}

/** Generate a brand new keyring, replacing whatever is on disk. */
export function regenerate(): Keyring {
  const fresh = build();
  writeKeyring(fresh);
  return hydrate(fresh);
}

export const SECRETS_FILE = SECRETS_PATH;
