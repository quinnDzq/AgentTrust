/**
 * The wallet round's rules, with no React in them.
 *
 * A round is a practice run in one browser tab: a wallet, a currency and a
 * starting budget, then payment requests drawn at random and sent through
 * three layers. Nothing here talks to a server or moves money. The signing
 * keys are throwaway Ed25519 keys made by the browser, so the key check is a
 * real signature verification over a real request — just not one that pays.
 *
 * Amounts are integers in the currency's smallest unit throughout, so no
 * decision ever depends on binary floating point.
 */

export const WALLETS = {
  paypal: {
    label: 'PayPal',
    currencies: ['USD'],
    status: 'Simulated balance in USD.',
  },
  electronic: {
    label: 'E-wallet',
    currencies: ['USD', 'EUR', 'SGD', 'GBP'],
    status: 'Simulated balance in USD, EUR, SGD or GBP.',
  },
  blockchain: {
    label: 'Blockchain wallet',
    currencies: ['USDC', 'USDT'],
    status: 'Simulated balance in USDC or USDT.',
  },
} as const;

export type WalletKind = keyof typeof WALLETS;
export const WALLET_KINDS = Object.keys(WALLETS) as readonly WalletKind[];
export type TemplateCurrency = (typeof WALLETS)[WalletKind]['currencies'][number];

const TOKEN_DECIMALS = { USDC: 6, USDT: 6 } as const;

/** Who is in every request of the template. */
export const TEMPLATE_AGENT = 'Deck Agent';
export const TEMPLATE_MERCHANT = 'Kestrel Stock';
/** The simulated Layer 1 profile. Advisory: it never decides anything. */
export const TEMPLATE_MODEL_PROFILE = 'Claude';

export interface WalletDraft {
  readonly wallet: WalletKind;
  readonly currency: TemplateCurrency;
  readonly amount: string;
}

export interface WalletRound {
  readonly wallet: WalletKind;
  readonly currency: TemplateCurrency;
  readonly startingAmount: number;
  readonly remaining: number;
}

export interface TemplateRequest {
  readonly reference: string;
  readonly amount: number;
  readonly wrongKey: boolean;
}

export const DEFAULT_WALLET_DRAFT: WalletDraft = {
  wallet: 'paypal',
  currency: 'USD',
  amount: '20.00',
};

export function amountDecimals(currency: TemplateCurrency): number {
  return currency === 'USDC' || currency === 'USDT' ? TOKEN_DECIMALS[currency] : 2;
}

/** The currencies a wallet offers, as plain strings for comparing against a draft. */
export const currenciesOf = (wallet: WalletKind): readonly TemplateCurrency[] => WALLETS[wallet].currencies;

/** Move a draft to another wallet, keeping the currency when that wallet has it and the amount as typed. */
export function withWallet(draft: WalletDraft, wallet: WalletKind): WalletDraft {
  const currencies = currenciesOf(wallet);
  return {
    ...draft,
    wallet,
    currency: currencies.includes(draft.currency) ? draft.currency : (currencies[0] ?? draft.currency),
  };
}

/** Read decimal input without rounding it through binary floating point. */
export function parseAmount(input: string, currency: TemplateCurrency): number | null {
  const amount = input.trim();
  const decimals = amountDecimals(currency);
  if (!/^\d+(?:\.\d+)?$/.test(amount)) return null;
  const [major, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) return null;
  const units = Number(`${major}${fraction.padEnd(decimals, '0')}`);
  return Number.isSafeInteger(units) && units <= 1_000_000 * 10 ** decimals ? units : null;
}

/** Largest positive integer amount that is strictly below half the budget. */
export const drawCeiling = (startingAmount: number): number => Math.floor((startingAmount - 1) / 2);

/** The smallest starting amount that leaves at least one amount to draw. */
export const MIN_STARTING_UNITS = 3;

/** Exclude the previous value when at least two amounts are possible. */
export function drawAmount(ceiling: number, previous?: number): number {
  if (ceiling < 1) throw new RangeError('No positive amount fits below half the budget.');
  if (ceiling > 1 && previous !== undefined && previous >= 1 && previous <= ceiling) {
    const next = 1 + Math.floor(Math.random() * (ceiling - 1));
    return next >= previous ? next + 1 : next;
  }
  return 1 + Math.floor(Math.random() * ceiling);
}

export function formatAmount(units: number, currency: TemplateCurrency): string {
  const decimals = amountDecimals(currency);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  }).format(units / 10 ** decimals);
}

/** An amount with its currency, as every screen writes it. */
export const money = (units: number, currency: TemplateCurrency): string =>
  `${formatAmount(units, currency)} ${currency}`;

/* ---------- Layer 2: the registered key ---------- */

export function createTemplateKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
}

/** A short fingerprint of a public key: the first eight bytes of its SHA-256, in hex. */
async function fingerprint(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface KeyCheck {
  /** What `crypto.subtle.verify` said about the request's signature under the registered key. */
  readonly matches: boolean;
  /** Fingerprint of the key registered for the agent. */
  readonly registered: string;
  /** Fingerprint of the key that actually signed this request. */
  readonly presented: string;
}

/**
 * Sign the request and verify it against the registered key.
 *
 * The honest request is signed with the registered key. The deliberate test
 * is signed with a second key made on the spot, so the signature is real and
 * well formed, and simply not the registered key's. The verdict is the
 * verification's own answer; the two fingerprints are shown beside it.
 */
export async function checkTemplateKey(
  round: WalletRound,
  request: TemplateRequest,
  registered: CryptoKeyPair,
): Promise<KeyCheck> {
  const signer = request.wrongKey ? await createTemplateKey() : registered;
  const message = new TextEncoder().encode(
    JSON.stringify([round.wallet, round.currency, request.reference, request.amount]),
  );
  const signature = await crypto.subtle.sign('Ed25519', signer.privateKey, message);
  const matches = await crypto.subtle.verify('Ed25519', registered.publicKey, signature, message);
  return {
    matches,
    registered: await fingerprint(registered.publicKey),
    presented: await fingerprint(signer.publicKey),
  };
}

/* ---------- Layer 3: payment authorization ---------- */

export interface Authorization {
  readonly fits: boolean;
  readonly remainingBefore: number;
  /** What is left once this request is paid; unchanged when it does not fit. */
  readonly remainingAfter: number;
  /** How far over the remaining budget the request is; zero when it fits. */
  readonly overBy: number;
}

/** Compare a request with what is left of the round's budget. */
export function authorize(remaining: number, amount: number): Authorization {
  const fits = amount <= remaining;
  return {
    fits,
    remainingBefore: remaining,
    remainingAfter: fits ? remaining - amount : remaining,
    overBy: fits ? 0 : amount - remaining,
  };
}

/* ---------- One request, start to finish ---------- */

/** The layers, in the order a request meets them. */
export type Layer = 1 | 2 | 3;

export const LAYER_TITLE: { readonly [L in Layer]: string } = {
  1: 'Model signal',
  2: 'Registered key',
  3: 'Payment authorization',
};

/** A word or two for each layer, where the full title does not fit. */
export const LAYER_SHORT: { readonly [L in Layer]: string } = {
  1: 'Model',
  2: 'Key',
  3: 'Budget',
};

export interface Outcome {
  /** Layer 1. Simulated and advisory: recorded, never used to decide. */
  readonly modelProfile: string;
  readonly key: KeyCheck;
  /** Null when the request stopped at Layer 2 and Layer 3 was skipped. */
  readonly authorization: Authorization | null;
  readonly approved: boolean;
  /** The layer that stopped the request, or null when it was approved. */
  readonly stoppedAt: 2 | 3 | null;
}

/**
 * Run all three layers for a request. The staged screens replay this result;
 * they never compute a second one.
 */
export async function verifyRequest(
  round: WalletRound,
  request: TemplateRequest,
  registered: CryptoKeyPair,
): Promise<Outcome> {
  const key = await checkTemplateKey(round, request, registered);
  const authorization = key.matches ? authorize(round.remaining, request.amount) : null;
  const approved = authorization?.fits === true;
  return {
    modelProfile: TEMPLATE_MODEL_PROFILE,
    key,
    authorization,
    approved,
    stoppedAt: approved ? null : key.matches ? 3 : 2,
  };
}

/** The layers a request actually visits: a key mismatch ends it at Layer 2. */
export const layersVisited = (outcome: Outcome): readonly Layer[] => (outcome.key.matches ? [1, 2, 3] : [1, 2]);

/** How one layer came out. `noted` is Layer 1's only answer: it informs, it does not rule. */
export type LayerMark = 'noted' | 'pass' | 'fail' | 'skipped';

export function layerMark(outcome: Outcome, layer: Layer): LayerMark {
  switch (layer) {
    case 1:
      return 'noted';
    case 2:
      return outcome.key.matches ? 'pass' : 'fail';
    case 3:
      return outcome.authorization === null ? 'skipped' : outcome.authorization.fits ? 'pass' : 'fail';
    default: {
      const unreachable: never = layer;
      throw new Error(`no layer ${String(unreachable)}`);
    }
  }
}

/** Each layer's finding, in one plain sentence. */
export function layerLine(outcome: Outcome, layer: Layer, request: TemplateRequest, currency: TemplateCurrency): string {
  switch (layer) {
    case 1:
      return `Reads like a ${outcome.modelProfile} profile.`;
    case 2:
      return outcome.key.matches
        ? 'The signature matches the registered key.'
        : 'The signature does not match the registered key.';
    case 3: {
      const auth = outcome.authorization;
      if (auth === null) return 'Skipped. The request stopped at the key check.';
      return auth.fits
        ? `${money(request.amount, currency)} fits the ${money(auth.remainingBefore, currency)} left.`
        : `${money(request.amount, currency)} is more than the ${money(auth.remainingBefore, currency)} left.`;
    }
    default: {
      const unreachable: never = layer;
      throw new Error(`no layer ${String(unreachable)}`);
    }
  }
}

/** The receipt's one reason: why this request was approved or where it stopped. */
export function decisionReason(outcome: Outcome, request: TemplateRequest, currency: TemplateCurrency): string {
  if (outcome.stoppedAt === 2) {
    return 'It was signed with a key that is not the one registered for this agent.';
  }
  if (outcome.stoppedAt === 3 && outcome.authorization) {
    return `${money(request.amount, currency)} is more than the ${money(outcome.authorization.remainingBefore, currency)} left in this round.`;
  }
  return 'The registered key signed it, and the amount fits what is left.';
}

/** What happened to the money. A template approval is always simulated. */
export const paymentStatus = (outcome: Outcome): string =>
  outcome.approved ? 'Simulated approval. No money moved.' : 'Stopped before the wallet. No charge.';

/** One finished request, as the round's list keeps it. */
export interface RoundEntry {
  readonly reference: string;
  readonly amount: number;
  readonly wrongKey: boolean;
  readonly stoppedAt: 2 | 3 | null;
}

export const entryLabel = (entry: RoundEntry): string =>
  entry.stoppedAt === null ? 'Approved' : entry.stoppedAt === 2 ? 'Blocked at the key' : 'Blocked at the budget';
