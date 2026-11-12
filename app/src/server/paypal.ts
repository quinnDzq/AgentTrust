/**
 * The PayPal Sandbox calls, ported from `sandbox/paypal.mjs`.
 *
 * That script is the tested baseline: one buyer saved a PayPal Wallet once, and
 * the same merchant then completed two USD 8 captures with no further buyer
 * interaction. The request bodies here are the same ones field for field —
 * `IMMEDIATE` wallet setup, then Orders v2 `CAPTURE` orders on the saved token
 * with `stored_credential: { payment_initiator: 'MERCHANT', usage: 'DERIVED' }`
 * — so the demo makes the calls that test proved. The differences are the
 * order `description` text and the return URLs, which follow the port the
 * server runs on (8787 in the tested setup) and end in the setup attempt's id,
 * so a return can be matched to the attempt that started it. One read is new:
 * `paymentToken`, which asks PayPal whether a saved wallet token is still valid
 * for this merchant app before the demo uses it.
 *
 * Nothing here decides whether to pay. The engine calls it from
 * `clearPayment` only, which is reachable with an `ALLOW` and nothing else
 * (rule 3 in CLAUDE.md). Credentials, tokens and approval links stay on the
 * server: errors carry PayPal's issue codes and debug id, never a secret.
 */

import type { Cents } from '../types.ts';

const API = 'https://api-m.sandbox.paypal.com';
const SETUP_TOKENS = '/v3/vault/setup-tokens';
const PAYMENT_TOKENS = '/v3/vault/payment-tokens';
const ORDERS = '/v2/checkout/orders';
const TIMEOUT_MS = 20_000;

/** The only origins a Sandbox approval link may point at. */
const APPROVAL_ORIGINS = ['https://sandbox.paypal.com', 'https://www.sandbox.paypal.com'];

/** PayPal ids and issue codes, or nothing. Keeps arbitrary response text out of logs. */
export function code(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_-]{1,120}$/i.test(value) ? value : undefined;
}

/** `800` cents as PayPal's `"8.00"`. Integer arithmetic, never a float. */
export function toValue(amount: Cents): string {
  const whole = Math.trunc(amount / 100);
  const rest = Math.abs(amount % 100);
  return `${whole}.${String(rest).padStart(2, '0')}`;
}

/** PayPal's `"8.00"` as cents, or null when it is not a plain amount. */
export function fromValue(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const whole = Number(match[1]);
  const rest = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + rest;
}

/**
 * PayPal refused, or never answered.
 *
 * `status` is the HTTP status when PayPal answered and null when the call
 * failed without a response — a timeout or a dropped connection, after which
 * we cannot know whether anything was charged.
 */
export class PayPalError extends Error {
  readonly status: number | null;
  readonly debugId: string | null;

  constructor(message: string, status: number | null, debugId: string | null) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.debugId = debugId;
  }

  /**
   * True when PayPal answered with a 4xx: the request was refused and nothing
   * was created, so a reservation can be released. A 5xx or no answer at all
   * is not definitive — the order may exist — so the reservation is kept until
   * someone reconciles it.
   */
  get definitive(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}

export interface SetupToken {
  readonly id: string;
  readonly approvalUrl: string;
}

/** What one saved-wallet order came to. */
export type OrderOutcome =
  | { readonly kind: 'completed'; readonly orderId: string; readonly captureId: string }
  | { readonly kind: 'buyer_action'; readonly orderId: string }
  | { readonly kind: 'unconfirmed'; readonly orderId: string; readonly status: string };

export interface ChargeArgs {
  readonly vaultId: string;
  readonly amount: Cents;
  readonly invoiceId: string;
  /** Sent as `PayPal-Request-Id`, so a retry returns the original order. */
  readonly requestId: string;
  readonly description: string;
}

export interface PayPal {
  /**
   * Start saving the buyer's wallet. The approval link goes to the buyer, and
   * PayPal sends them back to a URL ending in `attemptId`.
   */
  createSetupToken(requestId: string, attemptId: string): Promise<SetupToken>;
  setupStatus(setupId: string): Promise<string>;
  /** Exchange an approved setup token for the saved wallet token. */
  savePaymentToken(setupId: string, requestId: string): Promise<string>;
  /**
   * Confirm a saved wallet token with PayPal: it exists for this merchant app
   * and is a PayPal wallet. Resolves with nothing, or throws a `PayPalError`
   * — 404 when PayPal does not have it.
   */
  paymentToken(vaultId: string): Promise<void>;
  /** Create a `CAPTURE` order on the saved wallet. Can move funds immediately. */
  chargeSavedWallet(args: ChargeArgs): Promise<OrderOutcome>;
  /** Read an order back, to confirm or reconcile a charge. */
  order(orderId: string, expected: Cents): Promise<OrderOutcome>;
}

export interface PayPalOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Where PayPal sends the buyer back, e.g. `http://localhost:8787`. */
  readonly returnBase: string;
  readonly fetchImpl?: typeof fetch;
}

/* ---------- Reading an order ---------- */

interface OrderBody {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly links?: readonly { readonly rel?: unknown }[];
  readonly purchase_units?: readonly {
    readonly payments?: {
      readonly captures?: readonly {
        readonly id?: unknown;
        readonly status?: unknown;
        readonly amount?: { readonly currency_code?: unknown; readonly value?: unknown };
      }[];
    };
  }[];
}

/** The script's test, verbatim: PayPal wants the buyer back on screen. */
export function requiresBuyer(order: OrderBody): boolean {
  return (
    order.status === 'PAYER_ACTION_REQUIRED' ||
    (order.links ?? []).some((link) => link.rel === 'payer-action' || link.rel === 'approve')
  );
}

const captureOf = (order: OrderBody) => order.purchase_units?.[0]?.payments?.captures?.[0];

/**
 * Decide what an order body proves, using the same checks as the script: the
 * order and its first capture are both `COMPLETED`, in USD, for exactly the
 * amount asked. Anything less is `unconfirmed`, never a guess at success.
 */
export function outcomeOf(order: OrderBody, expected: Cents, expectedId?: string): OrderOutcome {
  const orderId = code(order.id) ?? expectedId ?? '';
  if (requiresBuyer(order)) return { kind: 'buyer_action', orderId };

  const capture = captureOf(order);
  const captureId = code(capture?.id);
  const confirmed =
    orderId !== '' &&
    (expectedId === undefined || orderId === expectedId) &&
    order.status === 'COMPLETED' &&
    captureId !== undefined &&
    capture?.status === 'COMPLETED' &&
    capture.amount?.currency_code === 'USD' &&
    fromValue(capture.amount.value) === expected;

  if (confirmed && captureId) return { kind: 'completed', orderId, captureId };
  return { kind: 'unconfirmed', orderId, status: code(order.status) ?? 'unknown' };
}

/* ---------- The client ---------- */

export function createPayPal(options: PayPalOptions): PayPal {
  const doFetch = options.fetchImpl ?? fetch;
  let token: { readonly value: string; readonly expiresAt: number } | null = null;

  async function call<T>(
    path: string,
    { method = 'GET', body, headers = {} }: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<T> {
    let response: Response;
    try {
      const signal = timeoutSignal();
      response = await doFetch(`${API}${path}`, {
        method,
        ...(body === undefined ? {} : { body }),
        headers: { Accept: 'application/json', ...headers },
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'did not answer';
      throw new PayPalError(`PayPal ${method} ${shortPath(path)} ${why}`, null, null);
    }

    const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;

    if (!response.ok) {
      const details = Array.isArray(result?.details) ? (result.details as { issue?: unknown }[]) : [];
      const issues = [result?.name, result?.error, ...details.map((d) => d?.issue)];
      const debugId = code(response.headers.get('paypal-debug-id')) ?? code(result?.debug_id) ?? null;
      throw new PayPalError(
        [
          `PayPal ${method} ${shortPath(path)} returned HTTP ${response.status}`,
          ...new Set(issues.map(code).filter(Boolean)),
          debugId && `debug ID ${debugId}`,
        ]
          .filter(Boolean)
          .join(' | '),
        response.status,
        debugId,
      );
    }

    if (!result) throw new PayPalError(`PayPal ${method} returned an unreadable response`, response.status, null);
    return result as T;
  }

  async function bearer(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;

    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
    const oauth = await call<{ access_token?: unknown; expires_in?: unknown }>('/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (typeof oauth.access_token !== 'string') {
      throw new PayPalError('PayPal did not return a Sandbox access token', null, null);
    }

    const life = typeof oauth.expires_in === 'number' ? oauth.expires_in : 300;
    token = { value: oauth.access_token, expiresAt: Date.now() + Math.max(30, life - 60) * 1_000 };
    return token.value;
  }

  const get = async <T>(path: string): Promise<T> =>
    call<T>(path, { headers: { Authorization: `Bearer ${await bearer()}` } });

  const post = async <T>(path: string, requestId: string, body: unknown): Promise<T> =>
    call<T>(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await bearer()}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': requestId,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });

  const readOrder = async (orderId: string, expected: Cents): Promise<OrderOutcome> => {
    const body = await get<OrderBody>(`${ORDERS}/${encodeURIComponent(orderId)}`);
    return outcomeOf(body, expected, orderId);
  };

  return {
    async createSetupToken(requestId, attemptId) {
      const attempt = encodeURIComponent(attemptId);
      const setup = await post<{ id?: unknown; links?: readonly { rel?: unknown; href?: unknown }[] }>(
        SETUP_TOKENS,
        requestId,
        {
          payment_source: {
            paypal: {
              description: 'Save this test wallet for two USD 8 AgentTrust Sandbox payments',
              usage_pattern: 'IMMEDIATE',
              usage_type: 'MERCHANT',
              customer_type: 'CONSUMER',
              permit_multiple_payment_tokens: false,
              experience_context: {
                brand_name: 'AgentTrust Sandbox',
                shipping_preference: 'NO_SHIPPING',
                return_url: `${options.returnBase}/paypal/approved/${attempt}`,
                cancel_url: `${options.returnBase}/paypal/cancelled/${attempt}`,
              },
            },
          },
        },
      );

      const id = code(setup.id);
      const href = setup.links?.find((link) => link.rel === 'approve')?.href;
      if (!id || typeof href !== 'string') {
        throw new PayPalError('PayPal did not return a setup token and buyer approval link', null, null);
      }
      if (!APPROVAL_ORIGINS.includes(new URL(href).origin)) {
        throw new PayPalError('PayPal did not return a Sandbox approval URL', null, null);
      }
      return { id, approvalUrl: href };
    },

    async setupStatus(setupId) {
      const setup = await get<{ status?: unknown }>(`${SETUP_TOKENS}/${encodeURIComponent(setupId)}`);
      return code(setup.status) ?? 'UNKNOWN';
    },

    async savePaymentToken(setupId, requestId) {
      const wallet = await post<{ id?: unknown }>(PAYMENT_TOKENS, requestId, {
        payment_source: { token: { id: setupId, type: 'SETUP_TOKEN' } },
      });
      const id = code(wallet.id);
      if (!id) throw new PayPalError('PayPal did not return a saved wallet token', null, null);
      return id;
    },

    async paymentToken(vaultId) {
      const token = await get<{ id?: unknown; payment_source?: { paypal?: unknown } }>(
        `${PAYMENT_TOKENS}/${encodeURIComponent(vaultId)}`,
      );
      const paypalSource = token.payment_source?.paypal;
      if (code(token.id) !== vaultId || typeof paypalSource !== 'object' || paypalSource === null) {
        // PayPal answered, but not with this PayPal wallet. Not a 404, so it is
        // reported as a refusal rather than as "not found".
        throw new PayPalError('PayPal did not confirm a PayPal wallet for that token', 422, null);
      }
    },

    async chargeSavedWallet(args) {
      const created = await post<OrderBody>(ORDERS, args.requestId, {
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: { currency_code: 'USD', value: toValue(args.amount) },
            invoice_id: args.invoiceId,
            description: args.description,
          },
        ],
        payment_source: {
          paypal: {
            vault_id: args.vaultId,
            stored_credential: { payment_initiator: 'MERCHANT', usage: 'DERIVED' },
          },
        },
      });

      const orderId = code(created.id);
      if (!orderId) {
        // An answer with no order id is the script's "stays stopped" case.
        throw new PayPalError('PayPal did not return an order id', null, null);
      }

      const first = outcomeOf(created, args.amount, orderId);
      if (first.kind !== 'unconfirmed') return first;

      // A completed order sometimes comes back before its capture is attached.
      // Read it once, as the script does, before calling it unconfirmed.
      return readOrder(orderId, args.amount);
    },

    order: readOrder,
  };
}

/**
 * Where PayPal sends the buyer back, e.g. `http://localhost:8787` or a public tunnel.
 *
 * `PUBLIC_BASE_URL` wins when it is set. Trailing slashes are dropped so the
 * return and cancel paths are not `//paypal/...`.
 */
export function publicBaseUrl(env: { readonly [key: string]: string | undefined }, port: number): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
  return configured.length > 0 ? configured : `http://localhost:${port}`;
}

/**
 * Build the client from the environment, or null when it is not configured.
 *
 * The variable names are the tested script's, so the one git-ignored `.env`
 * from `sandbox/README.md` works for both.
 */
export function payPalFromEnv(
  env: Record<string, string | undefined>,
  returnBase: string,
  fetchImpl?: typeof fetch,
): PayPal | null {
  const clientId = env.PAYPAL_SANDBOX_CLIENT_ID?.trim();
  const clientSecret = env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return createPayPal({ clientId, clientSecret, returnBase, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** `/v2/checkout/orders/ABC` as `/v2/checkout/orders` — no ids in error text. */
function shortPath(path: string): string {
  return path.split('/').slice(0, 4).join('/');
}

/**
 * A 20-second timeout, where the runtime has `AbortSignal.timeout`.
 *
 * Bun does. The view tests install happy-dom's browser globals for the whole
 * test process, and its `AbortSignal` does not — so rather than crash before a
 * request is even sent, the call simply runs without a timeout there.
 */
function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
}
