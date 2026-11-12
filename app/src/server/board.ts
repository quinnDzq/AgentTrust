/**
 * The deck scene's three test senders.
 *
 * Each can request an asset from the demo catalog:
 *
 *   1 an impostor that relays to the Deck Agent's own model — identity fails
 *   2 the real Deck Agent, paying a shop its grant does not cover — authorization fails
 *   3 the real Deck Agent, paying the grant's shop — PayPal is called
 *
 * The impostor presents the Deck Agent's registry id and a copy of the buyer's
 * real grant, and its answers resemble the Deck Agent's model as closely as the
 * agent's own do. What it cannot present is a signature from the enrolled key.
 * The second is signed by that key, and the grant still refuses it: a valid
 * signature alone never answers whether the agent may spend. Only the third
 * reaches PayPal.
 *
 * Everything here builds real envelopes with the real keyring and turns the
 * gate's results into the deck's words. Nothing here decides: a test request
 * goes through `receiveEnvelope` and `processRequest` like any other.
 */

import {
  cents,
  fmtMoney,
  MAY_LAMPS,
  TERM_LABEL,
  WHO_LAMPS,
  type Answer,
  type AnswerState,
  type BoardSender,
  type Cents,
  type CheckResult,
  type Envelope,
  type EvidenceView,
  type GateContext,
  type LampId,
  type PayPalOutcome,
  type PayPalView,
  type Ruling,
  type RulingSummary,
  type TermView,
} from '../types.ts';
import { buildClean } from './attacker.ts';
import { generateKeyPair, signEnvelope } from './crypto.ts';
import { DECK, DECK_QUOTES, DECK_SLOTS, OTHER_MERCHANT, type Quote } from './deck.ts';
import { DEMO_MODEL } from './evidence.ts';
import type { ChargeRow } from './db.ts';
import type { Keyring } from './keys.ts';

const firstSlide = DECK_SLOTS[0];
if (!firstSlide) throw new Error('the deck has no first slide');

/** The first image is the default for callers that don't select a quote. */
export const BOARD_SLOT = firstSlide;

export interface SenderMeta {
  readonly n: number;
  readonly title: string;
  /** The title in a few words, for a tab. */
  readonly short: string;
  /** What the request is meant to show. */
  readonly shows: string;
  readonly blurb: string;
  /** An impostor, rather than the buyer's real agent. */
  readonly impostor: boolean;
  readonly merchant: string;
}

export const SENDERS: { readonly [S in BoardSender]: SenderMeta } = {
  impostor: {
    n: 1,
    title: 'Impostor: same model, unenrolled key',
    short: 'Impostor',
    shows: 'Identity fails',
    blurb:
      `Claims to be ${DECK.registryId}, relays to the ${DECK.agentName}’s own model and carries a copy of ` +
      'the buyer’s grant. It signs with a key nobody enrolled.',
    impostor: true,
    merchant: DECK.merchant,
  },
  other_shop: {
    n: 2,
    title: `${DECK.agentName} at ${OTHER_MERCHANT}`,
    short: `Agent at ${OTHER_MERCHANT}`,
    shows: 'Authorization fails',
    blurb: `The real agent and its enrolled key, at a shop that sells the same image for the same price.`,
    impostor: false,
    merchant: OTHER_MERCHANT,
  },
  agent: {
    n: 3,
    title: `${DECK.agentName} at ${DECK.merchant}`,
    short: `Agent at ${DECK.merchant}`,
    shows: 'PayPal pays',
    blurb: 'The real agent and its enrolled key, at the shop the buyer’s grant names.',
    impostor: false,
    merchant: DECK.merchant,
  },
};

export function boardQuotes(sender: BoardSender): readonly Quote[] {
  return DECK_QUOTES.filter((quote) => quote.merchant === SENDERS[sender].merchant);
}

/* ---------- Building the three envelopes ---------- */

export interface Send {
  readonly envelope: Envelope;
  readonly label: string;
}

/**
 * Build one sender's request, with real signatures.
 *
 * The impostor starts from exactly what the Deck Agent would send — its
 * registry id, the buyer's real grant, the same intent — and re-signs it with
 * a key of its own, because the enrolled key is the one thing it cannot copy.
 */
export function buildSend(
  sender: BoardSender,
  args: { readonly requestId: string; readonly nowMs: number; readonly keyring: Keyring; readonly quote: Quote },
): Send {
  const meta = SENDERS[sender];
  const { quote } = args;

  const genuine = buildClean({
    requestId: args.requestId,
    principal: DECK.principal,
    amount: quote.price,
    reference: quote.reference,
    nowMs: args.nowMs,
    keyring: args.keyring,
    receiver: meta.merchant,
  }).envelope;

  const label = `${meta.title} · ${quote.title} ${fmtMoney(quote.price)}`;

  switch (sender) {
    case 'agent':
    case 'other_shop':
      return { envelope: genuine, label };
    case 'impostor': {
      const own = generateKeyPair();
      return {
        envelope: signEnvelope({
          id: genuine.id,
          origin: genuine.origin,
          registryId: genuine.agent.registryId,
          mandate: genuine.mandate,
          intent: genuine.intent,
          expiresAtMs: genuine.expiresAtMs,
          agentSecret: own.secret,
        }),
        label,
      };
    }
    default: {
      const unreachable: never = sender;
      throw new Error(`no sender ${String(unreachable)}`);
    }
  }
}

/* ---------- The two questions, in the deck's words ---------- */

const scopeWords = (scope: string): string => scope.replace(/_/g, ' ');

/**
 * One lamp's result in the deck's words.
 *
 * The gate's own notes are written for Overduel's back office ("we hold
 * Kestrel Stock for Sandbox buyer", "inside tier 3"). These say the same fact
 * as a buyer would put it. Facts only: every text is derived from the check's
 * outcome and the facts the gate was given, never from the verdict.
 */
function termText(lamp: LampId, check: CheckResult, env: Envelope, ctx: GateContext): string {
  const amount = fmtMoney(env.intent.amount);
  const passed = check.outcome === 'pass';

  switch (lamp) {
    case 'AGENT_IDENTITY':
      if (passed) return `signed with ${env.agent.registryId}’s enrolled key`;
      if (ctx.registry === 'active' && !ctx.agentSigValid) {
        return `not signed with ${env.agent.registryId}’s enrolled key`;
      }
      if (ctx.registry === 'revoked') return `${env.agent.registryId} was revoked by the buyer`;
      return check.note;
    case 'INTENT_BINDING':
      if (passed) return `covers exactly ${amount} to ${env.intent.receiver}, used once`;
      return check.note;
    case 'COUNTERPARTY': {
      if (passed) return `${env.intent.receiver} is the grant’s merchant`;
      const held = ctx.counterparty?.receiver;
      if (held && held !== env.intent.receiver) return `the grant covers ${held}, not ${env.intent.receiver}`;
      return check.note;
    }
    case 'MANDATE':
      if (passed) {
        return (
          `issued to this key: ${scopeWords(env.mandate.scope)} up to ` +
          `${fmtMoney(env.mandate.maxPerPayment)}, until ${DECK.until}`
        );
      }
      return check.note;
    case 'OUR_POLICY':
      // The gate already says this in the buyer's words when a grant is the limit.
      return check.note;
    default: {
      const unreachable: never = lamp;
      throw new Error(`no lamp ${String(unreachable)}`);
    }
  }
}

function terms(lamps: readonly LampId[], ruling: Ruling, env: Envelope, ctx: GateContext): TermView[] {
  return lamps.flatMap((lamp) => {
    const check = ruling.checks.find((c) => c.check === lamp);
    return check ? [{ lamp, outcome: check.outcome, text: termText(lamp, check, env, ctx) }] : [];
  });
}

const failed = (list: readonly TermView[]): TermView[] => list.filter((t) => t.outcome === 'fail');

/**
 * The ruling as WHO and MAY.
 *
 * Display only, and computed after the ruling exists. MAY is "not reached"
 * when WHO failed, because a gateway should not ask what an unidentified
 * sender may spend — but the gate did evaluate it, so the footnote says what it
 * found there. Nothing is dropped.
 */
export function summarize(env: Envelope, ruling: Ruling, ctx: GateContext): RulingSummary {
  const whoTerms = terms(WHO_LAMPS, ruling, env, ctx);
  const mayTerms = terms(MAY_LAMPS, ruling, env, ctx);

  if (ruling.check === 'PAUSED') {
    return {
      who: { state: 'not_reached', terms: whoTerms },
      may: { state: 'not_reached', terms: mayTerms },
      footnote: 'The buyer paused the agents: the gate refuses everything until they resume.',
    };
  }

  const whoState: AnswerState = failed(whoTerms).length > 0 ? 'no' : 'yes';
  const mayState: AnswerState =
    whoState !== 'yes'
      ? 'not_reached'
      : failed(mayTerms).length > 0
        ? 'no'
        : mayTerms.some((t) => t.outcome === 'ask')
          ? 'ask'
          : 'yes';

  let footnote: string | null = null;
  if (mayState === 'not_reached') {
    const alsoFailed = failed(mayTerms);
    footnote =
      alsoFailed.length > 0
        ? `MAY was not reached. The gate still runs every lamp, and on that side it found: ${alsoFailed
            .map((t) => `${TERM_LABEL[t.lamp]} — ${t.text}`)
            .join('; ')}.`
        : 'MAY was not reached. The gate still runs every lamp, and that side would have passed.';
  }

  return { who: { state: whoState, terms: whoTerms }, may: { state: mayState, terms: mayTerms }, footnote };
}

/** The MAY terms that stopped a request, by their one-word names. */
export const failingLabels = (answer: Answer): string[] =>
  answer.terms.filter((t) => t.outcome === 'fail' || t.outcome === 'ask').map((t) => TERM_LABEL[t.lamp]);

/* ---------- PayPal's side ---------- */

const OUTCOME_OF: { readonly [status: string]: PayPalOutcome } = {
  reserved: 'calling',
  submitted: 'calling',
  completed: 'captured',
  simulated: 'simulated',
  buyer_action: 'needs_buyer',
  failed: 'refused',
  unknown: 'unknown',
};

/** What PayPal did for a request: nothing at all when there is no charge for it. */
export function paypalView(charge: ChargeRow | null, amount: Cents): PayPalView {
  if (!charge) {
    return { outcome: 'not_called', mode: null, amount, orderId: null, captureId: null, note: null };
  }
  return {
    outcome: OUTCOME_OF[charge.status] ?? 'unknown',
    mode: charge.mode === 'live' ? 'live' : 'simulated',
    amount: cents(charge.amount),
    orderId: charge.order_id,
    captureId: charge.capture_id,
    note: charge.note,
  };
}

/* ---------- One line on what happened ---------- */

/** What the evidence said about a sender's behaviour, in two or three words. */
function behaviour(evidence: EvidenceView): string {
  if (evidence.resembles === null) return 'Unknown behaviour';
  return evidence.resembles === DEMO_MODEL ? 'Same behaviour' : 'Other behaviour';
}

/** One line on what a sent test request came to: the two checks, then PayPal. */
export function captionFor(summary: RulingSummary, evidence: EvidenceView, paypal: PayPalView): string {
  if (summary.who.state === 'not_reached') return 'Paused: nothing was checked.';

  if (summary.who.state === 'no') {
    const revoked = summary.who.terms.some((t) => t.outcome === 'fail' && t.text.includes('revoked'));
    return `${behaviour(evidence)}. ${revoked ? 'Key revoked.' : 'Wrong key.'}`;
  }

  switch (summary.may.state) {
    case 'no': {
      const labels = failingLabels(summary.may);
      return labels.length === 1 && labels[0] === 'merchant'
        ? 'Right agent. Not allowed there.'
        : `Right agent. Not allowed: ${labels.join(', ')}.`;
    }
    case 'ask':
      return 'Right agent. Over budget: it waits for the buyer.';
    case 'not_reached':
      return 'Not checked.';
    case 'yes':
      break;
    default: {
      const unreachable: never = summary.may.state;
      throw new Error(`no answer ${String(unreachable)}`);
    }
  }

  switch (paypal.outcome) {
    case 'captured':
      return 'Right agent, right shop: PayPal paid.';
    case 'simulated':
      return 'Right agent, right shop: charge simulated, no PayPal credentials.';
    case 'calling':
      return 'Right agent, right shop: PayPal is answering…';
    case 'needs_buyer':
      return 'Both checks passed, but PayPal asked for the buyer.';
    case 'refused':
      return 'Both checks passed; PayPal refused the charge.';
    case 'unknown':
      return 'Both checks passed; PayPal has not confirmed it yet.';
    case 'not_called':
      return 'Both checks passed, but no PayPal wallet was connected to charge.';
    default: {
      const unreachable: never = paypal.outcome;
      throw new Error(`no PayPal outcome ${String(unreachable)}`);
    }
  }
}
