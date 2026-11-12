/**
 * The buyer's spending cap for one deck run.
 *
 * The default is USD 20, overridable with `AGENTTRUST_DEFAULT_BUDGET`. A run
 * can offer a different cap before the buyer approves it — from the page, or
 * from `begin_verification` when the user tells the agent their budget. Once
 * approved, the cap is the signed policy the gate reads.
 */

import { usd, type Cents } from '../types.ts';
import { DECK } from './deck.ts';

/** The largest budget a run will offer. A demo cap, not a PayPal limit. */
export const MAX_BUDGET_USD = 10_000;

/** Default share of the budget above which a purchase asks the buyer. */
export const DEFAULT_ASK_THRESHOLD_PCT = 50;

export type BudgetParse =
  | { readonly ok: true; readonly cents: Cents }
  | { readonly ok: false; readonly message: string };

/**
 * A budget in major units, default currency USD.
 *
 * Positive, at least one cent, at most `MAX_BUDGET_USD`, and a whole number of
 * cents. Anything else is refused rather than rounded into a different cap.
 */
export function parseBudget(amount: number, currency?: string | null, noun: 'budget' | 'amount' = 'budget'): BudgetParse {
  const code = (currency ?? 'USD').trim().toUpperCase() || 'USD';
  if (code !== 'USD') return { ok: false, message: `Only USD ${noun}s are supported (got ${code}).` };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: `The ${noun} must be a positive amount of US dollars.` };
  }
  if (amount > MAX_BUDGET_USD) {
    return { ok: false, message: `The ${noun} cannot be more than USD ${MAX_BUDGET_USD.toLocaleString('en-US')}.` };
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents < 1 || Math.abs(amount * 100 - cents) > 1e-6) {
    return { ok: false, message: `The ${noun} must be a whole number of cents.` };
  }
  return { ok: true, cents: usd(amount) };
}

/** `AGENTTRUST_DEFAULT_BUDGET`, or USD 20. A bad value is reported and ignored. */
export function defaultBudgetFromEnv(env: { readonly [key: string]: string | undefined }): {
  readonly budget: Cents;
  readonly problem: string | null;
} {
  const raw = env.AGENTTRUST_DEFAULT_BUDGET?.trim() ?? '';
  if (raw === '') return { budget: DECK.budget, problem: null };
  const amount = Number(raw);
  const parsed = parseBudget(amount, 'USD');
  if (!parsed.ok) {
    return { budget: DECK.budget, problem: `AGENTTRUST_DEFAULT_BUDGET ${parsed.message} Using USD 20.00.` };
  }
  return { budget: parsed.cents, problem: null };
}

/**
 * `AGENTTRUST_ASK_THRESHOLD_PCT`, or 50.
 *
 * A whole percent from 0 to 100. A purchase strictly above this share of the
 * approved budget asks the buyer; so does the one that first takes cumulative
 * spend past it. A bad value is reported and ignored.
 */
export function askThresholdFromEnv(env: { readonly [key: string]: string | undefined }): {
  readonly pct: number;
  readonly problem: string | null;
} {
  const raw = env.AGENTTRUST_ASK_THRESHOLD_PCT?.trim() ?? '';
  if (raw === '') return { pct: DEFAULT_ASK_THRESHOLD_PCT, problem: null };
  if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100) {
    return {
      pct: DEFAULT_ASK_THRESHOLD_PCT,
      problem: `AGENTTRUST_ASK_THRESHOLD_PCT must be a whole percent from 0 to 100 (got ${raw}). Using ${DEFAULT_ASK_THRESHOLD_PCT}.`,
    };
  }
  return { pct: Number(raw), problem: null };
}
