'use client';

import { fmtMoney, fmtUsd, type GrantView } from '@app/types.ts';

/**
 * A budget change the agent asked for. The buyer approves or declines it here.
 * Nothing on the connector can answer it, and the grant stays as it is until
 * the buyer does.
 */
export function BudgetRequest({
  grant,
  busy,
  onDecide,
}: {
  readonly grant: GrantView;
  readonly busy: boolean;
  readonly onDecide: (requestId: string, choice: 'approve' | 'decline') => void;
}) {
  const pending = grant.pendingBudgetRequest;
  if (!pending) return null;

  return (
    <section className="vp-budget-request" aria-label="Budget change">
      <p className="vp-label">Budget change · waiting for you</p>
      <p className="vp-step-title">
        {fmtMoney(pending.current)} → {fmtMoney(pending.requested)}
      </p>
      <p className="vp-step-text">
        The agent asked to raise the budget from {fmtUsd(pending.current)} to {fmtUsd(pending.requested)}. Purchases
        already made stay on the record, and the ask threshold stays {grant.askThresholdPct}%.
      </p>
      <p className="vp-step-text">{pending.reason}</p>
      <div className="vp-step-row">
        <button
          type="button"
          className="vp-btn vp-btn-gold"
          disabled={busy}
          onClick={() => onDecide(pending.requestId, 'approve')}
        >
          Approve {fmtMoney(pending.requested)}
        </button>
        <button
          type="button"
          className="vp-btn vp-btn-ghost"
          disabled={busy}
          onClick={() => onDecide(pending.requestId, 'decline')}
        >
          Decline
        </button>
      </div>
    </section>
  );
}
