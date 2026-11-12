/**
 * One live run, as the page and the chat are told about it.
 *
 * A pure function of what was recorded: the run's own row, the request it
 * became, the gate's ruling read as WHO and MAY, and the PayPal charge. The
 * verification page draws this and `get_purchase_status` reports it, so the two
 * windows of the recording can never tell different stories about one run.
 *
 * Nothing here decides anything. Every line is worded from an outcome that
 * already exists.
 */

import {
  fmtUsd,
  type Cents,
  type CheckId,
  type LiveCheck,
  type Envelope,
  type LiveRunView,
  type LiveStage,
  type SignedPayloadView,
  type ModelSignalView,
  type Request,
  type RulingSummary,
  type TermView,
} from '../types.ts';
import { paypalView } from './board.ts';
import type { ChargeRow, LiveRunRow } from './db.ts';

export interface LiveFacts {
  /** The request the run became, once its signed envelope went to the gate. */
  readonly request: Request | null;
  readonly summary: RulingSummary | null;
  readonly charge: ChargeRow | null;
  /** The buyer's authorized budget for this run, as the grant states it. */
  readonly budget: Cents;
  /** The envelope the run became, once it was signed and submitted. */
  readonly envelope: Envelope | null;
}

const texts = (terms: readonly TermView[]): string => terms.map((term) => term.text).join('; ');

const capital = (s: string): string => (s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1));

/** Where a run is. Before the gate it is the run's own stage; after, it follows the request. */
export function liveStage(row: LiveRunRow, facts: LiveFacts): LiveStage {
  const { request, summary, charge } = facts;

  if (!row.request_id || !request) {
    switch (row.stage) {
      case 'challenge':
        return 'awaiting_reply';
      case 'not_matched':
        return 'model_not_matched';
      case 'signing':
        return 'awaiting_signature';
      case 'expired':
        return 'expired';
      default:
        // `stopped`: Layer 2 could not go ahead — the enrollment or the signer.
        return 'identity_failed';
    }
  }

  switch (request.status) {
    case 'queued':
    case 'intake':
      return 'verifying';
    case 'gated':
    case 'waiting':
      return 'needs_buyer';
    case 'charging':
      return charge?.status === 'unknown' ? 'payment_unconfirmed' : 'charging';
    case 'paid':
      // PAID is for a capture PayPal confirmed, in live Sandbox mode, and nothing else.
      return charge?.mode === 'live' && charge.status === 'completed' ? 'paid' : 'simulated';
    case 'blocked':
      if (request.lamp === 'OWNER_DECLINED') return 'authorization_failed';
      if (summary?.who.state === 'no') return 'identity_failed';
      if (summary?.may.state === 'no' || summary?.who.state === 'not_reached') return 'authorization_failed';
      return 'payment_failed';
    default: {
      const unreachable: never = request.status;
      throw new Error(`no live stage for ${String(unreachable)}`);
    }
  }
}

function signatureOf(row: LiveRunRow, summary: RulingSummary | null): { check: LiveCheck; note: string | null } {
  if (!row.request_id || !summary) {
    switch (row.stage) {
      case 'challenge':
      case 'signing':
        return { check: 'pending', note: null };
      case 'stopped':
        return { check: 'failed', note: row.note };
      default:
        return { check: 'skipped', note: null };
    }
  }

  switch (summary.who.state) {
    case 'yes':
      return { check: 'passed', note: `${capital(texts(summary.who.terms))}.` };
    case 'no':
      return { check: 'failed', note: `${capital(texts(summary.who.terms.filter((t) => t.outcome === 'fail')))}.` };
    case 'ask':
    case 'not_reached':
      return { check: 'skipped', note: null };
    default: {
      const unreachable: never = summary.who.state;
      throw new Error(`no signature state for ${String(unreachable)}`);
    }
  }
}

function authorizationOf(
  row: LiveRunRow,
  summary: RulingSummary | null,
  amount: Cents,
  budget: Cents,
  lamp: CheckId | null,
): { check: LiveCheck; line: string | null } {
  if (lamp === 'OWNER_DECLINED') return { check: 'failed', line: 'Buyer declined this purchase.' };
  if (!row.request_id || !summary) {
    const waiting = row.stage === 'challenge' || row.stage === 'signing';
    return { check: waiting ? 'pending' : 'skipped', line: null };
  }

  switch (summary.may.state) {
    case 'yes': {
      const budgetLine = summary.may.terms.find((term) => term.lamp === 'OUR_POLICY' && term.outcome === 'pass')?.text;
      return {
        check: 'passed',
        line: `Buyer authorization passed · ${budgetLine ?? `${fmtUsd(amount)} of ${fmtUsd(budget)}`}`,
      };
    }
    case 'no':
      return {
        check: 'failed',
        line: `Buyer authorization failed · ${texts(summary.may.terms.filter((t) => t.outcome === 'fail'))}`,
      };
    case 'ask':
      return {
        check: 'ask',
        line: `Buyer authorization needed · ${texts(summary.may.terms.filter((t) => t.outcome === 'ask'))}`,
      };
    case 'not_reached':
      return { check: 'skipped', line: null };
    default: {
      const unreachable: never = summary.may.state;
      throw new Error(`no authorization state for ${String(unreachable)}`);
    }
  }
}

export function buildLiveView(row: LiveRunRow, facts: LiveFacts): LiveRunView {
  const amount = row.amount as Cents;
  const signature = signatureOf(row, facts.summary);
  const authorization = authorizationOf(row, facts.summary, amount, facts.budget, facts.request?.lamp ?? null);
  const signed = signedOf(row, facts.envelope, signature.check === 'passed', signature.note);

  return {
    runId: row.run_id,
    stage: liveStage(row, facts),
    quote: { merchant: row.merchant, reference: row.reference, item: row.title, amount },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    prompt: row.prompt,
    challengeExpiresAt: row.challenge_expires_at,
    reply: row.reply,
    signal: row.signal ? (JSON.parse(row.signal) as ModelSignalView) : null,
    nonce: row.nonce,
    signExpiresAt: row.sign_expires_at,
    requestId: row.request_id,
    signature: signature.check,
    signatureNote: signature.note,
    authorization: authorization.check,
    authorizationLine: authorization.line,
    verdict: facts.request?.verdict ?? null,
    summary: facts.summary,
    // PayPal's side only exists once a request does: before that, nothing was asked of it.
    paypal: facts.request ? paypalView(facts.charge, amount) : null,
    note: row.note,
    signed,
  };
}

function signedOf(
  row: LiveRunRow,
  envelope: Envelope | null,
  verified: boolean,
  reason: string | null,
): SignedPayloadView | null {
  if (!envelope) return null;
  return {
    amount: envelope.intent.amount,
    merchant: envelope.intent.receiver,
    item: row.title,
    runId: row.run_id,
    grantCap: envelope.mandate.maxPerPayment,
    signature: envelope.signature,
    verified,
    reason: verified ? null : reason,
  };
}
