/**
 * The AgentTrust deck scene, as constants.
 *
 * It is 2 a.m. The buyer is asleep, and their agent is finishing tomorrow's
 * 9 a.m. pitch deck. It needs three images from one stock-photo shop. Before
 * bed the buyer connected a PayPal Sandbox wallet and allowed the agent a $20
 * budget, so the agent can license them without waking anyone — and the third
 * image, which would take it past $20, waits for the morning instead.
 *
 * The roles map onto Overduel's like this. The buyer is the *principal*: it
 * signs the grant (the mandate) to its agent and the budget (the policy). The
 * shop is the *receiver* on the buyer's record. The gate stands in for a
 * proposed PayPal grant service, so everything it decides here is local
 * prototype behaviour; the wallet and the captures are PayPal Sandbox.
 */

import { usd, type Cents, type WalletSource } from '../types.ts';

export const DECK = {
  /** Who signs the grant and owns the PayPal wallet. */
  principal: 'Sandbox buyer',
  /** The buyer's agent, as the registry knows it. */
  registryId: 'AGT-DECK-1',
  agentName: 'Deck Agent',
  /** The only place the grant may pay. */
  merchant: 'Kestrel Stock',
  budget: usd(20),
  currency: 'USD',
  /** The scene is one night: the grant and the budget lapse after day 1. */
  day: 1,
  openingMinute: 1 * 60 + 58,
  until: 'end of tonight',
} as const;

export interface DeckSlotSeed {
  readonly id: string;
  readonly title: string;
  readonly price: Cents;
  /** The shop's quote reference. The duplicate and quote checks key on it. */
  readonly reference: string;
}

/** Two images that fit the grant, then one that would take it over $20. */
export const DECK_SLOTS: readonly DeckSlotSeed[] = [
  { id: 'S1', title: 'Harbor at dawn', price: usd(8), reference: 'KS-1041' },
  { id: 'S2', title: 'Night market', price: usd(8), reference: 'KS-1042' },
  { id: 'S3', title: 'Icon pack', price: usd(5), reference: 'KS-2001' },
];

/**
 * The other shop. It sells the same assets at the same prices under its own
 * reference, and the buyer's grant does not cover it — so a request to pay it
 * differs from the real one in the merchant and nothing else.
 */
export const OTHER_MERCHANT = 'Lark Prints';

export interface Quote {
  readonly merchant: string;
  readonly reference: string;
  readonly title: string;
  readonly price: Cents;
}

/**
 * Everything the two shops quote tonight. These are the only charges the deck
 * can make: the gate refuses a reference the shop being paid never quoted —
 * including another shop's — and any other price.
 */
export const DECK_QUOTES: readonly Quote[] = [
  ...DECK_SLOTS.map(({ reference, title, price }) => ({ merchant: DECK.merchant, reference, title, price })),
  { merchant: OTHER_MERCHANT, reference: 'LP-0388', title: 'Harbor at dawn', price: usd(8) },
  { merchant: OTHER_MERCHANT, reference: 'LP-0389', title: 'Night market', price: usd(8) },
  { merchant: OTHER_MERCHANT, reference: 'LP-0390', title: 'Icon pack', price: usd(5) },
];

/** What one shop quotes for a reference, or null when that shop never quoted it. */
export function quotedPrice(merchant: string, reference: string): Cents | null {
  return DECK_QUOTES.find((q) => q.merchant === merchant && q.reference === reference)?.price ?? null;
}

/** How each wallet source reads in the log. Never a token. */
export const WALLET_SOURCE_LABEL: { readonly [S in WalletSource]: string } = {
  consent: 'wallet saved with the buyer’s PayPal consent',
  configured: 'pre-authorized Sandbox wallet configured for this demo',
  tested_run: 'wallet saved in the tested Sandbox run',
  simulated: 'simulated wallet',
};
