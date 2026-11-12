/**
 * The page's client for the Bun server's JSON API.
 *
 * Paths are absolute from the origin's root, outside /verify: the API belongs
 * to the Bun server, which serves this page once it is exported, and which
 * `next dev` passes /api through to.
 */

import type { VerificationSnapshot } from '@app/types.ts';

export interface Ack {
  readonly ok: boolean;
  readonly message?: string;
  readonly error?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as T & { readonly error?: string };
  if (!res.ok) throw new Error(body.error ?? `${init?.method ?? 'GET'} ${path} failed (${res.status})`);
  return body;
}

const post = <T = Ack>(path: string, body?: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const api = {
  state: (): Promise<VerificationSnapshot> => call<VerificationSnapshot>('/api/state'),

  /** Offer a budget without approving it. US dollars, and the ask threshold as a percent of it. */
  setBudget: (budget: number, askThresholdPct: number): Promise<Ack> =>
    post('/api/grant/budget', { budget, currency: 'USD', askThresholdPct }),

  /** "Allow Deck Agent to spend up to $X": the buyer's grant for this run. Enforced by AgentTrust. */
  approve: (budget: number, askThresholdPct: number): Promise<Ack> =>
    post('/api/grant/approve', { budget, currency: 'USD', askThresholdPct }),

  /** The buyer approves or declines the purchase waiting on this run. The same run is captured or refused. */
  decide: (runId: string, choice: 'approve' | 'decline'): Promise<Ack> => post('/api/live/decide', { runId, choice }),

  /** The buyer approves or declines an agent's request to change the budget. The agent cannot call this. */
  decideBudget: (requestId: string, choice: 'approve' | 'decline'): Promise<Ack> =>
    post('/api/budget/decide', { requestId, choice }),

  /** A nonce the signer signs. Not a purchase, and PayPal is not called. */
  proveIdentity: (): Promise<
    Ack & {
      readonly nonce?: string;
      readonly signature?: string;
      readonly verified?: boolean;
      readonly result?: string;
      readonly fingerprint?: string;
    }
  > => post('/api/identity/prove'),

  /** Start or reopen the PayPal Sandbox consent. The link comes back to this browser only. */
  connect: (): Promise<Ack & { readonly approvalUrl?: string | null }> => post('/api/grant/paypal'),

  /** Ask PayPal again whether the setup was agreed, or whether the saved wallet is still good. */
  check: (): Promise<Ack> => post('/api/grant/check'),

  /** Read the signer's public key and, in erc8004 identity mode, the agent's registration. */
  enroll: (): Promise<Ack> => post('/api/agent/enroll'),

  /** Start a new buyer session and clear the wallet connection. */
  reset: (): Promise<Ack> => post('/api/session/reset'),
} as const;
