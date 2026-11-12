/**
 * Which proof counts as the Demo Agent's identity.
 *
 * Either one is enough:
 *
 * - `local` — the signer holds the Ed25519 private key and this server holds
 *   the enrolled public key. That pair is a complete enrollment. This is the
 *   default, so a demo does not need a testnet registration.
 * - `erc8004` — the on-chain registration must verify.
 * - `auto` — `erc8004` when a registration is configured, otherwise `local`.
 *
 * The request signature is checked the same way in every mode. Only the
 * identity proof changes.
 */

import type { IdentityMode } from '../types.ts';

export interface IdentityChoice {
  readonly mode: IdentityMode;
  readonly problem: string | null;
}

/**
 * `AGENTTRUST_IDENTITY_MODE` from the environment.
 *
 * Unset means local. An unknown value is a mistake worth saying out loud; the
 * server still runs in local mode rather than refusing to start.
 */
export function identityModeFromEnv(
  env: { readonly [key: string]: string | undefined },
  erc8004Configured: boolean,
): IdentityChoice {
  const raw = env.AGENTTRUST_IDENTITY_MODE?.trim() ?? '';
  const key = raw.toLowerCase();
  if (key === '' || key === 'local') return { mode: 'local', problem: null };
  if (key === 'erc8004') return { mode: 'erc8004', problem: null };
  if (key === 'auto') return { mode: erc8004Configured ? 'erc8004' : 'local', problem: null };
  return {
    mode: 'local',
    problem: `AGENTTRUST_IDENTITY_MODE "${raw}" is not local, erc8004 or auto. Using local.`,
  };
}

/** One startup line. Local mode does not mention a missing registration. */
export function identityLogLine(
  choice: IdentityChoice,
  erc: { readonly config: { readonly agentId: string; readonly registry: string; readonly network: string } | null; readonly problem: string | null },
): string {
  if (choice.problem) return choice.problem;
  if (choice.mode === 'local') return 'local key pair (Ed25519)';
  if (erc.config) return `ERC-8004 agent ${erc.config.agentId} in ${erc.config.registry} on ${erc.config.network}`;
  return `ERC-8004 ${erc.problem ?? 'no registration configured'}`;
}
