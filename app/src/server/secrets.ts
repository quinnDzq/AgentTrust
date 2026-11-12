/**
 * Local shared secrets, and the signer's own key file.
 *
 * Two tokens keep the live flow's parts from being used by anything else on
 * the machine or the network:
 *
 *   - the **connector token**, which the agent platform sends as a bearer token
 *     with every MCP request, and
 *   - the **signer link token**, which this server sends to the signer service.
 *
 * Each is 32 random bytes, generated on first use into a git-ignored file under
 * `keys/` that only its owner can read, or taken from the environment when the
 * two processes do not share a disk. Neither is ever logged or put in a
 * snapshot: the startup line names the file, not the value.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPair, type KeyPair } from './crypto.ts';

export const CONNECTOR_TOKEN_PATH = 'keys/connector.local.json';
export const SIGNER_LINK_PATH = 'keys/signer-link.local.json';
export const SIGNER_KEY_PATH = 'keys/signer.local.json';

function writePrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // `mode` only applies when the file is created; make sure of it either way.
  chmodSync(path, 0o600);
}

const usable = (token: unknown): token is string => typeof token === 'string' && token.length >= 24;

/**
 * A shared secret: the environment's when one is set, otherwise the file's,
 * created on first use.
 */
export function localSecret(path: string, fromEnv: string | undefined): string {
  const given = fromEnv?.trim();
  if (given) {
    if (!usable(given)) throw new Error('a shared secret set in the environment must be at least 24 characters');
    return given;
  }

  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown };
    if (usable(stored.token)) return stored.token;
  }
  const token = randomBytes(32).toString('base64url');
  writePrivate(path, { token });
  return token;
}

/**
 * The signer service's own key pair, generated the first time it starts.
 *
 * Only the signer process calls this. The gateway never reads the file: it
 * learns the public half by asking the signer, and enrolls that.
 */
export function signerKey(path: string = SIGNER_KEY_PATH): KeyPair {
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { key?: KeyPair };
    if (stored.key?.publicKey && stored.key.secret?.d && stored.key.secret.x === stored.key.publicKey) {
      return stored.key;
    }
    throw new Error(`${path} does not hold a usable key; move it aside to generate a new one`);
  }
  const key = generateKeyPair();
  writePrivate(path, { version: 1, key });
  return key;
}
