/**
 * bun run keys — generate the agent keyring.
 *
 * Writes `keys/secrets.local.json` (git-ignored) and prints the public
 * registry that is derived from it. Safe to re-run: it replaces the keyring,
 * which invalidates every signature made under the old one, so re-run
 * `bun run reset` afterwards to re-sign the seeded world.
 */

import { fingerprint } from '../src/server/crypto.ts';
import { regenerate, SECRETS_FILE } from '../src/server/keys.ts';
import { AGENT_ORDER } from '../src/types.ts';

const keyring = regenerate();

console.log(`Wrote ${SECRETS_FILE}\n`);

console.log('Ours — these can never authorise a payment (registry: internal):');
console.log(`  owner            ${fingerprint(keyring.owner.publicKey)}  signs the policy`);
for (const key of AGENT_ORDER) {
  const pair = keyring.crew[key];
  console.log(`  ${key.padEnd(16)} ${fingerprint(pair.publicKey)}`);
}

console.log('\nCounterparties — public halves go in the registry:');
for (const c of keyring.counterparties) {
  const state = c.revokedDay === null ? 'active' : `revoked day ${c.revokedDay}`;
  console.log(
    `  ${c.registryId}  ${c.principal.padEnd(19)} ${c.scope.padEnd(13)} ${state}\n` +
      `            principal ${fingerprint(c.principalKey.publicKey)}  agent ${fingerprint(c.agentKey.publicKey)}`,
  );
}

console.log('\nNext: bun run reset');
