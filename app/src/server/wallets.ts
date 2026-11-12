/**
 * Where a pre-authorized PayPal Sandbox wallet can come from, server-side.
 *
 * Read once when the server starts, and never sent anywhere — not to the
 * browser, not to the log:
 *
 *   - `PAYPAL_SANDBOX_VAULT_ID` — a wallet token the team saved for this
 *     merchant app and hands to a judge along with the Sandbox credentials, so
 *     the judge can run the demo without creating or signing in to a PayPal
 *     account.
 *   - `PAYPAL_SANDBOX_STATE_DIR` — the folder `sandbox/paypal.mjs` keeps its
 *     runs in (`.paypal-sandbox` at the repository root). A run whose `app`
 *     hash matches this server's client id saved its wallet for the same
 *     merchant app and test buyer, so the demo reuses that token instead of
 *     asking the buyer to log in again.
 *
 * Nothing here is trusted until PayPal confirms it: `Engine.refreshWallet`
 * asks PayPal about each one before a charge may use it.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { code } from './paypal.ts';

export interface WalletCandidate {
  readonly vaultId: string;
  readonly source: 'configured' | 'tested_run';
}

/** The merchant app a wallet belongs to — the same hash the tested script stores as `app`. */
export function appHashOf(clientId: string): string {
  return createHash('sha256').update(clientId).digest('hex');
}

/** Every pre-authorized wallet this server was pointed at, configured first. */
export function walletCandidates(
  env: Record<string, string | undefined>,
  appHash: string,
): WalletCandidate[] {
  const found: WalletCandidate[] = [];

  const configured = code(env.PAYPAL_SANDBOX_VAULT_ID?.trim());
  if (configured) found.push({ vaultId: configured, source: 'configured' });

  const dir = env.PAYPAL_SANDBOX_STATE_DIR?.trim();
  if (dir) found.push(...testedRuns(dir, appHash));

  return found;
}

/** Wallets the tested script saved for this merchant app, newest run first. */
function testedRuns(dir: string, appHash: string): WalletCandidate[] {
  let runs: string[];
  try {
    runs = readdirSync(dir);
  } catch {
    return [];
  }

  const found: { readonly vaultId: string; readonly at: number }[] = [];
  for (const run of runs) {
    const file = join(dir, run, 'state.json');
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as { app?: unknown; vaultId?: unknown };
      const vaultId = code(state.vaultId);
      if (state.app === appHash && vaultId) found.push({ vaultId, at: statSync(file).mtimeMs });
    } catch {
      // Not a run folder, or a run that never saved a wallet: nothing to reuse.
    }
  }

  return found
    .sort((a, b) => b.at - a.at)
    .map(({ vaultId }) => ({ vaultId, source: 'tested_run' as const }));
}

/** What was found, for the startup line. Counts and kinds, never the tokens. */
export function describeCandidates(candidates: readonly WalletCandidate[]): string {
  const configured = candidates.filter((c) => c.source === 'configured').length;
  const tested = candidates.filter((c) => c.source === 'tested_run').length;
  const parts = [
    configured > 0 ? 'a configured pre-authorized wallet' : null,
    tested > 0 ? `${tested} wallet${tested === 1 ? '' : 's'} from the tested Sandbox run` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' and ') : 'no pre-authorized wallet';
}
