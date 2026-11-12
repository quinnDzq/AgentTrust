import type { RefObject } from 'react';
import {
  decisionReason,
  formatAmount,
  LAYER_TITLE,
  layerLine,
  layerMark,
  money,
  paymentStatus,
  TEMPLATE_AGENT,
  TEMPLATE_MERCHANT,
  WALLETS,
  type Layer,
  type LayerMark,
  type Outcome,
  type TemplateRequest,
  type WalletRound,
} from '@/lib/wallet-template';
import { Sprite } from '../Sprite';
import { Glyph, type GlyphName } from './PixelArt';

export type SlipPhase = 'ready' | 'checking' | 'decided';

const LAYERS: readonly Layer[] = [1, 2, 3];

const MARK_GLYPH: { readonly [M in LayerMark]: GlyphName } = {
  noted: 'check',
  pass: 'check',
  fail: 'cross',
  skipped: 'dash',
};

const MARK_WORD: { readonly [M in LayerMark]: string } = {
  noted: 'Noted',
  pass: 'Passed',
  fail: 'Failed',
  skipped: 'Skipped',
};

/** The receipt's headline: the outcome, and where a blocked request stopped. */
function outcomeTitle(outcome: Outcome): string {
  if (outcome.approved) return 'Approved';
  return outcome.stoppedAt === 2 ? 'Blocked at the key check' : 'Blocked at the budget check';
}

/**
 * The request, on paper. It is the one object that goes through the whole
 * flow, and its amount and recipient never leave the screen:
 *
 *   ready     the full request and the one button that sends it
 *   checking  folded down to its amount and recipient while the window works
 *   decided   the receipt: a stamp, the outcome, one reason, what happened to
 *             the money, and the evidence behind a control
 *
 * The wrong-key test is a switch on the request itself, off by default and
 * worded as a test, so it is found and chosen, never stumbled into.
 */
export function RequestSlip({
  request,
  round,
  phase,
  outcome,
  error,
  busy,
  onWrongKey,
  onSend,
  onSkip,
  onDraw,
  sendRef,
  titleRef,
}: {
  readonly request: TemplateRequest;
  readonly round: WalletRound;
  readonly phase: SlipPhase;
  readonly outcome: Outcome | null;
  readonly error: string;
  readonly busy: boolean;
  readonly onWrongKey: (wrongKey: boolean) => void;
  readonly onSend: () => void;
  readonly onSkip: () => void;
  readonly onDraw: (wrongKey: boolean) => void;
  readonly sendRef: RefObject<HTMLButtonElement | null>;
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const decided = phase === 'decided' && outcome !== null;
  const wallet = WALLETS[round.wallet].label;

  return (
    <article
      className="wt-paper wt-slip"
      data-phase={phase}
      data-test={request.wrongKey ? 'yes' : 'no'}
      data-approved={decided ? (outcome.approved ? 'yes' : 'no') : undefined}
      aria-label={decided ? 'Receipt' : 'Payment request'}
    >
      <header className="wt-slip-head">
        <span className="wt-slip-ref">Request {request.reference}</span>
        {request.wrongKey ? <span className="wt-chip wt-chip-test">Wrong-key test</span> : null}
        {decided ? (
          <span className="wt-stamp" data-approved={outcome.approved ? 'yes' : 'no'} aria-hidden="true">
            {outcome.approved ? 'APPROVED' : 'BLOCKED'}
          </span>
        ) : null}
      </header>

      <div className="wt-slip-main">
        <Sprite who={request.wrongKey ? 'raven' : 'pip'} size={48} decorative />
        <p className="wt-slip-amount">
          <span className="wt-slip-amount-value">{formatAmount(request.amount, round.currency)}</span>{' '}
          <span className="wt-slip-currency">{round.currency}</span>
        </p>
        <p className="wt-slip-to">
          to <strong>{TEMPLATE_MERCHANT}</strong>
        </p>
      </div>

      {phase === 'ready' ? (
        <>
          <p className="wt-slip-about">
            {TEMPLATE_AGENT}, an AI agent, asks to pay this from your {wallet} wallet.
          </p>
          <label className="wt-switch">
            <input
              type="checkbox"
              checked={request.wrongKey}
              disabled={busy}
              onChange={(event) => onWrongKey(event.target.checked)}
            />
            <span className="wt-switch-box" aria-hidden="true" />
            <span className="wt-switch-text">
              <span>Sign it with a wrong key</span>
              <small>A deliberate test. Layer 2 should stop it.</small>
            </span>
          </label>
          <button type="button" ref={sendRef} className="wt-btn wt-btn-gold wt-btn-wide" onClick={onSend} disabled={busy}>
            {busy ? 'Signing request…' : 'Send for verification'}
          </button>
          {error ? (
            <p className="wt-slip-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}

      {phase === 'checking' ? (
        <button type="button" className="wt-btn wt-btn-paper wt-skip" onClick={onSkip}>
          Skip to the result
        </button>
      ) : null}

      {decided ? (
        <div className="wt-receipt">
          <h2 className="wt-outcome" ref={titleRef} tabIndex={-1}>
            {outcomeTitle(outcome)}
          </h2>
          <p className="wt-reason">{decisionReason(outcome, request, round.currency)}</p>

          <dl className="wt-slip-facts">
            <div>
              <dt>Payment</dt>
              <dd>{paymentStatus(outcome)}</dd>
            </div>
            <div>
              <dt>Budget left</dt>
              <dd>
                {money(round.remaining, round.currency)}
                {outcome.approved ? '' : ' (unchanged)'}
              </dd>
            </div>
          </dl>

          <details className="wt-evidence">
            <summary>Show the evidence</summary>
            <ol>
              {LAYERS.map((layer) => {
                const mark = layerMark(outcome, layer);
                return (
                  <li key={layer} data-mark={mark}>
                    <span className="wt-evidence-mark">
                      <Glyph name={MARK_GLYPH[mark]} size={12} />
                    </span>
                    <span className="wt-evidence-body">
                      <strong>
                        Layer {layer}, {LAYER_TITLE[layer].toLowerCase()}: {MARK_WORD[mark].toLowerCase()}
                      </strong>
                      <span>
                        {layerLine(outcome, layer, request, round.currency)}
                        {layer === 1 ? ' Simulated, and advisory only.' : ''}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
            <dl className="wt-prints">
              <div>
                <dt>Registered key</dt>
                <dd>
                  <code>{outcome.key.registered}</code>
                </dd>
              </div>
              <div>
                <dt>Signed with</dt>
                <dd>
                  <code>{outcome.key.presented}</code>
                </dd>
              </div>
            </dl>
            <p className="wt-evidence-note">
              Throwaway Ed25519 keys made in this tab. Your browser verified the signature locally.
            </p>
          </details>

          <div className="wt-receipt-actions">
            <button type="button" className="wt-btn wt-btn-gold wt-btn-wide" onClick={() => onDraw(false)}>
              Draw another request
            </button>
            <button type="button" className="wt-btn wt-btn-paper wt-btn-wide" onClick={() => onDraw(true)}>
              Try a wrong-key request
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}
