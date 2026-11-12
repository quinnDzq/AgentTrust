'use client';

import {
  fmtMoney,
  fmtUsd,
  type EnrollmentView,
  type GrantView,
  type LiveRunView,
} from '@app/types.ts';
import { truncateMiddle } from './IdentityCard';
import { useEffect, type ReactNode } from 'react';
import {
  activeLayer,
  authorizationOf,
  budgetRefusal,
  clock,
  MARK_GLYPH,
  modelLine,
  receiptOf,
  registrationRow,
  signatureRow,
  stampOf,
  type CertificateRow,
  type Mark,
} from '@/lib/live';
import { Tag, type TagKind } from './Tag';

const MARK_WORD: { readonly [M in Mark]: string } = {
  pass: 'passed',
  fail: 'failed',
  ask: 'needs attention',
  wait: 'not yet',
  off: 'not reached',
};

function MarkBadge({ mark }: { readonly mark: Mark }) {
  return (
    <span className={`vp-mark vp-mark-${mark}`} role="img" aria-label={MARK_WORD[mark]}>
      {MARK_GLYPH[mark]}
    </span>
  );
}

function LayerHead({
  n,
  title,
  mark,
  tag,
}: {
  readonly n: number;
  readonly title: string;
  readonly mark: Mark;
  readonly tag: TagKind;
}) {
  return (
    <header className="lv-layer-head">
      <span className="vp-row-n">Layer {n}</span>
      <h3 className="lv-layer-title">{title}</h3>
      <Tag kind={tag} />
      <MarkBadge mark={mark} />
    </header>
  );
}

function Certificate({ row, tag }: { readonly row: CertificateRow; readonly tag: TagKind }) {
  return (
    <div className="lv-cert-row" data-mark={row.mark}>
      <p className="lv-cert-title">
        <span className="lv-cert-mark" aria-hidden="true">
          {MARK_GLYPH[row.mark]}
        </span>
        {row.title}
        <Tag kind={tag} />
      </p>
      {row.detail ? <p className="lv-cert-detail">{row.detail}</p> : null}
      {row.facts.length > 0 ? (
        <dl className="lv-facts">
          {row.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>
                {fact.href ? (
                  <a href={fact.href} target="_blank" rel="noreferrer noopener">
                    {fact.value} ↗
                  </a>
                ) : (
                  fact.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * The layer's mark, from the certificate's two rows. One failure fails it, and
 * it only passes when both rows do: a signature beside an identity proof the
 * server did not accept asks for attention rather than reading as a clean pass.
 */
function layerMark(rows: readonly CertificateRow[]): Mark {
  if (rows.some((row) => row.mark === 'fail')) return 'fail';
  if (rows.every((row) => row.mark === 'pass')) return 'pass';
  if (rows.some((row) => row.mark === 'ask' || row.mark === 'pass')) return 'ask';
  return rows.every((row) => row.mark === 'off') ? 'off' : 'wait';
}

/**
 * One live run, drawn from what the server recorded and nothing else.
 *
 * The request arrives through the connector and each layer fills in as the
 * server reaches it. When a purchase is over the ask threshold, Approve and
 * Decline are the buyer’s answer for this same run.
 */
export function LiveRun({
  run,
  enrollment,
  grant,
  busy = false,
  onDecide,
}: {
  readonly run: LiveRunView;
  readonly enrollment: EnrollmentView;
  readonly grant: GrantView | null;
  readonly busy?: boolean;
  readonly onDecide?: (choice: 'approve' | 'decline') => void;
}) {
  const stamp = stampOf(run.stage);
  const model = modelLine(run);
  const registration = registrationRow(enrollment);
  const signature = signatureRow(run, enrollment);
  const authorization = authorizationOf(run);
  const receipt = receiptOf(run, grant);
  const overBudget =
    run.stage === 'needs_buyer' && grant && !authorization.line?.includes('would exceed budget')
      ? budgetRefusal(grant, run.quote.amount)
      : null;
  const layer = activeLayer(run.stage);

  // Bring the layer the run just reached into view. The server moved; the page follows.
  useEffect(() => {
    const target = document.getElementById(layer === 4 ? 'lv-receipt' : `lv-layer-${layer}`);
    if (!target) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, [layer, run.runId]);

  const signal = run.signal;
  // Once the run is past Layer 1 the reply folds down to a few lines; it is still all there to scroll.
  const replyOpen = layer === 1 || run.stage === 'awaiting_signature';

  return (
    <article className="lv-run" aria-label="Live verification run" aria-live="polite">
      <header className="lv-request">
        <div className="lv-request-body">
          <p className="vp-label">
            {enrollment.agentName} requests · run {run.runId.slice(0, 8)}
          </p>
          <h2 className="lv-amount">{fmtUsd(run.quote.amount)}</h2>
          <p className="vp-order">
            <strong>{run.quote.item}</strong> from {run.quote.merchant} · quote {run.quote.reference}
          </p>
        </div>
        <span className={`vp-stamp vp-stamp-${stamp.tone}`} key={stamp.word}>
          {stamp.word}
        </span>
      </header>

      <section id="lv-layer-1" className="lv-layer" data-mark={model.mark} data-active={layer === 1 ? 'yes' : 'no'}>
        <LayerHead n={1} title="Model signal" mark={model.mark} tag="local" />
        <p className="lv-headline">{model.headline}</p>

        <dl className="lv-evidence">
          <div>
            <dt>Prompt</dt>
            <dd>{run.prompt}</dd>
          </div>
          <div>
            <dt>
              Reply
              {model.count ? <span className="lv-count">{model.count}</span> : null}
            </dt>
            <dd>
              {run.reply === null ? (
                <span className="lv-muted">None yet. The challenge is open until {clock(run.challengeExpiresAt)}.</span>
              ) : (
                <pre className="lv-reply" data-open={replyOpen ? 'yes' : 'no'} tabIndex={0}>
                  {run.reply}
                </pre>
              )}
            </dd>
          </div>
        </dl>

        {signal && signal.candidates.length > 0 ? (
          <div className="lv-candidates">
            <p className="lv-candidates-head">
              Closest reference: <strong>{signal.closest}</strong>
              {signal.score === null ? null : <> · similarity {signal.score.toFixed(2)}</>}
              {signal.threshold === null ? null : <> · calibrated threshold {signal.threshold.toFixed(2)}</>}
            </p>
            <ul>
              {signal.candidates.map((candidate, index) => (
                <li key={candidate.label} data-closest={index === 0 ? 'yes' : 'no'}>
                  <span className="lv-cand-name">
                    {candidate.label}
                    {candidate.label === signal.expectedModel ? <em> · this agent’s model</em> : null}
                    {candidate.synthetic ? <em> · generated</em> : <em> · {candidate.samples} replies</em>}
                  </span>
                  <span className="lv-bar" aria-hidden="true">
                    <i style={{ width: `${Math.round(candidate.score * 100)}%` }} />
                    {candidate.threshold === null ? null : <b style={{ left: `${Math.round(candidate.threshold * 100)}%` }} />}
                  </span>
                  <span className="lv-cand-score">{candidate.score.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section
        id="lv-layer-2"
        className="lv-layer"
        data-mark={layerMark([registration, signature])}
        data-active={layer === 2 ? 'yes' : 'no'}
      >
        <LayerHead n={2} title="Registered key" mark={layerMark([registration, signature])} tag="local" />
        <div className="lv-certificate" data-sealed={registration.mark === 'pass' && signature.mark === 'pass' ? 'yes' : 'no'}>
          <p className="lv-certificate-title">Agent certificate · {enrollment.agentName}</p>
          <Certificate row={registration} tag={enrollment.identityMode === 'local' ? 'local' : 'testnet'} />
          <Certificate row={signature} tag="local" />
          {run.signed ? (
            <div className="lv-signed">
              <p className="lv-cert-title">What was signed</p>
              <dl className="lv-facts">
                <div>
                  <dt>Amount</dt>
                  <dd>{fmtMoney(run.signed.amount)}</dd>
                </div>
                <div>
                  <dt>Merchant</dt>
                  <dd>{run.signed.merchant}</dd>
                </div>
                <div>
                  <dt>Item</dt>
                  <dd>{run.signed.item}</dd>
                </div>
                <div>
                  <dt>Run</dt>
                  <dd>
                    <code>{truncateMiddle(run.signed.runId, 8, 4)}</code>
                  </dd>
                </div>
                <div>
                  <dt>Buyer grant cap</dt>
                  <dd>{fmtMoney(run.signed.grantCap)}</dd>
                </div>
                <div>
                  <dt>Signature</dt>
                  <dd>
                    <code>{truncateMiddle(run.signed.signature, 12, 8)}</code>
                  </dd>
                </div>
              </dl>
              <p className="lv-verify" data-verified={run.signed.verified ? 'yes' : 'no'}>
                {run.signed.verified ? '✓ Signature verified' : `✗ ${run.signed.reason ?? 'Signature not verified'}`}
              </p>
            </div>
          ) : run.signature === 'failed' && run.signatureNote ? (
            <p className="lv-verify" data-verified="no">
              ✗ {run.signatureNote}
            </p>
          ) : null}
        </div>
      </section>

      <section id="lv-layer-3" className="lv-layer" data-mark={authorization.mark} data-active={layer === 3 ? 'yes' : 'no'}>
        <LayerHead n={3} title="Payment authorization" mark={authorization.mark} tag="local" />
        <p className="lv-authorization">{authorization.line}</p>
        {overBudget ? <p className="lv-authorization">{overBudget}</p> : null}
        {run.stage === 'needs_buyer' && onDecide ? (
          <div className="vp-step-row">
            <button type="button" className="vp-btn vp-btn-gold" disabled={busy} onClick={() => onDecide('approve')}>
              Approve
            </button>
            <button type="button" className="vp-btn vp-btn-ghost" disabled={busy} onClick={() => onDecide('decline')}>
              Decline
            </button>
          </div>
        ) : null}
      </section>

      {receipt ? (
        <section id="lv-receipt" className="lv-receipt" data-tone={receipt.tone} aria-label="Receipt">
          <header className="lv-receipt-head">
            <p className="lv-receipt-provider">
              {receipt.provider} <Tag kind={receipt.tag} />
            </p>
            <span className="lv-receipt-status" key={receipt.status}>
              {receipt.status}
            </span>
          </header>
          <p className="lv-receipt-amount">{receipt.amount}</p>
          <dl className="lv-facts">
            <ReceiptFact label="Order ID" value={receipt.orderId} />
            <ReceiptFact label="Capture ID" value={receipt.captureId} />
          </dl>
          {receipt.note ? <p className="lv-receipt-note">{receipt.note}</p> : null}
          {receipt.budgetLine ? <p className="lv-receipt-budget">{receipt.budgetLine}</p> : null}
        </section>
      ) : null}

      {/* A signing challenge that lapsed is the one stop no layer's own row explains. */}
      {run.note && run.stage === 'expired' && signal ? <p className="lv-note">{run.note}</p> : null}
    </article>
  );
}

function ReceiptFact({ label, value }: { readonly label: string; readonly value: string | null }): ReactNode {
  if (value === null) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
