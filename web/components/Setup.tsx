'use client';

import { useEffect, useRef, useState } from 'react';
import { cents, fmtMoney, type GrantView, type WalletView } from '@app/types.ts';
import { Tag } from './Tag';

/** `2000` cents as `20`, `2050` as `20.50`. */
function dollarsText(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

function dollarsOf(text: string): number | null {
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

/** A whole percent from 0 to 100, or null when the field is not one. */
function percentOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const pct = Number(trimmed);
  return pct <= 100 ? pct : null;
}

/**
 * What has to be true before any test request can go: a PayPal Sandbox wallet
 * PayPal has confirmed, and this run's budget, approved by the buyer. Hidden
 * once both are done — the top bar keeps showing them.
 */
export function Setup({
  wallet,
  grant,
  busy,
  onConnect,
  onCheck,
  onApprove,
  onBudget,
  showConnected = false,
}: {
  readonly wallet: WalletView;
  readonly grant: GrantView;
  readonly busy: boolean;
  readonly showConnected?: boolean;
  readonly onConnect: () => void;
  readonly onCheck: () => void;
  /** Approve the grant at this amount, in US dollars, with this ask threshold. */
  readonly onApprove: (amount: number, askThresholdPct: number) => void;
  /** Remember this amount and ask threshold on the grant before it is approved. */
  readonly onBudget: (amount: number, askThresholdPct: number) => void;
}) {
  const live = wallet.mode === 'live';
  const connected = wallet.state === 'connected';
  const [draft, setDraft] = useState(() => dollarsText(grant.budget));
  const [pctDraft, setPctDraft] = useState(() => String(grant.askThresholdPct));
  const [focused, setFocused] = useState(false);
  const [pctFocused, setPctFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!focused) setDraft(dollarsText(grant.budget));
  }, [grant.budget, focused]);

  useEffect(() => {
    if (!pctFocused) setPctDraft(String(grant.askThresholdPct));
  }, [grant.askThresholdPct, pctFocused]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  const editable = grant.status === 'needs_wallet' || grant.status === 'needs_approval';
  const shown = dollarsOf(draft);
  const shownPct = percentOf(pctDraft);
  const buttonAmount = shown === null ? grant.budget : cents(Math.round(shown * 100));

  function scheduleSave(amountText: string, pctText: string): void {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const amount = dollarsOf(amountText);
      const pct = percentOf(pctText);
      if (amount === null || pct === null || !editable) return;
      if (Math.round(amount * 100) === grant.budget && pct === grant.askThresholdPct) return;
      setError(null);
      onBudget(amount, pct);
    }, 400);
  }

  if (grant.status === 'revoked') {
    return (
      <section className="vp-setup" aria-label="Wallet and spending grant">
        <p className="vp-setup-line">
          <Tag kind="local" /> The buyer revoked the {grant.registryId} key. Every request now fails identity.
        </p>
      </section>
    );
  }
  if (!showConnected && connected && grant.status === 'active') return null;

  return (
    <section className="vp-setup" aria-label="Wallet and spending grant">
      <div className="vp-step" data-done={connected ? 'yes' : 'no'}>
        <span className="vp-step-n">{connected ? '✓' : '1'}</span>
        <div className="vp-step-body">
          <p className="vp-step-title">
            PayPal Sandbox wallet <Tag kind={live ? 'real' : 'sim'} />
          </p>
          {connected ? (
            <p className="vp-step-text">Connected. PayPal confirmed the saved wallet.</p>
          ) : !live ? (
            <p className="vp-step-text">Add the PayPal Sandbox app credentials and restart AgentTrust.</p>
          ) : wallet.state === 'checking' ? (
            <p className="vp-step-text">Checking the saved wallet with PayPal…</p>
          ) : (
            <>
              <p className="vp-step-text">
                {wallet.state === 'waiting'
                  ? 'Waiting for you in PayPal. Sign in as the Sandbox buyer and agree once.'
                  : wallet.state === 'expired'
                    ? 'That PayPal setup expired. A fresh one takes one more sign-in.'
                    : wallet.state === 'cancelled'
                      ? 'Cancelled. Nothing was saved.'
                      : 'Sign in as the Sandbox buyer on PayPal’s page and agree once. Nothing is charged.'}
              </p>
              {wallet.note ? <p className="vp-step-note">{wallet.note}</p> : null}
              <div className="vp-step-row">
                <button type="button" className="vp-btn vp-btn-gold" onClick={onConnect} disabled={busy}>
                  {wallet.state === 'waiting' ? 'Reopen PayPal' : 'Connect PayPal Sandbox'}
                </button>
                {wallet.state === 'waiting' || wallet.canRecheck ? (
                  <button type="button" className="vp-btn vp-btn-ghost" onClick={onCheck} disabled={busy}>
                    {wallet.state === 'waiting' ? 'I’ve agreed in PayPal' : 'Check again'}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="vp-step" data-done={grant.status === 'active' ? 'yes' : 'no'}>
        <span className="vp-step-n">2</span>
        <div className="vp-step-body">
          <p className="vp-step-title">
            The buyer’s grant <Tag kind="local" />
          </p>
          <p className="vp-step-text">
            {grant.registryId} may pay {grant.merchant} up to {fmtMoney(buttonAmount)}, {grant.until}. A purchase over{' '}
            {shownPct ?? grant.askThresholdPct}% of that asks you first. Asked again every run.
          </p>
          {grant.status === 'active' ? (
            <p className="vp-step-note">{fmtMoney(grant.left)} of {fmtMoney(grant.budget)} left.</p>
          ) : (
            <div className="vp-step-row">
              <label className="vp-budget">
                USD
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  max={10000}
                  step={0.01}
                  aria-label="Budget in US dollars"
                  value={draft}
                  disabled={busy || !editable}
                  onFocus={() => setFocused(true)}
                  onBlur={() => {
                    setFocused(false);
                    const amount = dollarsOf(draft);
                    const pct = percentOf(pctDraft);
                    if (amount === null) {
                      setError('Enter a budget greater than zero.');
                      return;
                    }
                    if (pct === null) {
                      setError('Enter an ask threshold from 0 to 100.');
                      return;
                    }
                    setError(null);
                    if (Math.round(amount * 100) !== grant.budget || pct !== grant.askThresholdPct) onBudget(amount, pct);
                  }}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError(null);
                    scheduleSave(event.target.value, pctDraft);
                  }}
                />
              </label>
              <label className="vp-budget vp-budget-pct">
                Ask above
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  aria-label="Ask threshold as a percent of the budget"
                  value={pctDraft}
                  disabled={busy || !editable}
                  onFocus={() => setPctFocused(true)}
                  onBlur={() => {
                    setPctFocused(false);
                    const amount = dollarsOf(draft);
                    const pct = percentOf(pctDraft);
                    if (pct === null) {
                      setError('Enter an ask threshold from 0 to 100.');
                      return;
                    }
                    if (amount === null) {
                      setError('Enter a budget greater than zero.');
                      return;
                    }
                    setError(null);
                    if (Math.round(amount * 100) !== grant.budget || pct !== grant.askThresholdPct) onBudget(amount, pct);
                  }}
                  onChange={(event) => {
                    setPctDraft(event.target.value);
                    setError(null);
                    scheduleSave(draft, event.target.value);
                  }}
                />
                %
              </label>
              <button
                type="button"
                className="vp-btn vp-btn-gold"
                onClick={() => {
                  const amount = dollarsOf(draft);
                  const pct = percentOf(pctDraft);
                  if (amount === null) {
                    setError('Enter a budget greater than zero.');
                    return;
                  }
                  if (pct === null) {
                    setError('Enter an ask threshold from 0 to 100.');
                    return;
                  }
                  setError(null);
                  if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
                  onApprove(amount, pct);
                }}
                disabled={busy || grant.status !== 'needs_approval'}
              >
                Allow Deck Agent to spend up to {fmtMoney(buttonAmount)}
              </button>
            </div>
          )}
          {error ? <p className="vp-step-note">{error}</p> : null}
        </div>
      </div>
    </section>
  );
}
