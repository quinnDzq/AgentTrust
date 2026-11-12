'use client';

import { useEffect, useRef } from 'react';
import {
  entryLabel,
  formatAmount,
  money,
  WALLETS,
  type RoundEntry,
  type WalletRound,
} from '@/lib/wallet-template';
import { Glyph, WalletIcon } from './PixelArt';

/** What is left of the round's budget, as a bar. The number beside it is the fact; this is the glance. */
function BudgetMeter({ round }: { readonly round: WalletRound }) {
  const share = round.startingAmount > 0 ? Math.max(0, Math.min(1, round.remaining / round.startingAmount)) : 0;
  return (
    <div
      className="wt-meter"
      role="meter"
      aria-label="Budget left"
      aria-valuemin={0}
      aria-valuemax={round.startingAmount}
      aria-valuenow={round.remaining}
      aria-valuetext={`${money(round.remaining, round.currency)} left of ${money(round.startingAmount, round.currency)}`}
    >
      <span className="wt-meter-fill" style={{ width: `${(share * 100).toFixed(2)}%` }} />
    </div>
  );
}

/**
 * The round, in one line, in the same place from the first request to the
 * last receipt: which wallet, and how much of its budget is left. The gear
 * opens the locked settings.
 */
export function RoundBar({
  round,
  onOpen,
  gearRef,
}: {
  readonly round: WalletRound;
  readonly onOpen: () => void;
  readonly gearRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <section className="wt-roundbar" data-wallet={round.wallet} aria-label="This round">
      <WalletIcon wallet={round.wallet} size={40} />
      <div className="wt-roundbar-id">
        <span className="wt-roundbar-name">{WALLETS[round.wallet].label}</span>
        <span className="wt-chip wt-chip-sim">Simulated</span>
      </div>
      <p className="wt-roundbar-left">
        <strong>{formatAmount(round.remaining, round.currency)}</strong> {round.currency} left
        <span className="wt-roundbar-of">of {formatAmount(round.startingAmount, round.currency)}</span>
      </p>
      <button
        type="button"
        ref={gearRef}
        className="wt-icon-btn wt-roundbar-gear"
        aria-label="Round settings"
        aria-haspopup="dialog"
        onClick={onOpen}
      >
        <Glyph name="gear" size={18} />
      </button>
      <BudgetMeter round={round} />
    </section>
  );
}

/**
 * The locked settings and what the round has done so far. Read-only on
 * purpose: a round's wallet, currency and budget are fixed when it starts, so
 * every receipt in it means the same thing. Ending the round is the way back
 * to editing them.
 */
export function RoundDetails({
  round,
  entries,
  busy,
  onEnd,
}: {
  readonly round: WalletRound;
  readonly entries: readonly RoundEntry[];
  readonly busy: boolean;
  readonly onEnd: () => void;
}) {
  return (
    <div className="wt-round-details">
      <p className="wt-locked">
        <Glyph name="lock" size={14} /> Locked for this round
      </p>
      <dl className="wt-facts">
        <div>
          <dt>Wallet</dt>
          <dd>
            {WALLETS[round.wallet].label} <span className="wt-chip wt-chip-sim">Simulated</span>
          </dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{round.currency}</dd>
        </div>
        <div>
          <dt>Starting budget</dt>
          <dd>{money(round.startingAmount, round.currency)}</dd>
        </div>
        <div>
          <dt>Left</dt>
          <dd>{money(round.remaining, round.currency)}</dd>
        </div>
      </dl>

      <h3 className="wt-log-title">Requests this round</h3>
      {entries.length === 0 ? (
        <p className="wt-log-empty">None sent yet.</p>
      ) : (
        <ol className="wt-log">
          {entries.map((entry) => (
            <li key={entry.reference} data-outcome={entry.stoppedAt === null ? 'approved' : 'blocked'}>
              <span className="wt-log-ref">{entry.reference}</span>
              <span className="wt-log-amount">{money(entry.amount, round.currency)}</span>
              <span className="wt-log-result">
                {entryLabel(entry)}
                {entry.wrongKey ? ' (wrong-key test)' : ''}
              </span>
            </li>
          ))}
        </ol>
      )}

      <button type="button" className="wt-btn wt-btn-ghost wt-btn-wide" onClick={onEnd} disabled={busy}>
        End round
      </button>
      <p className="wt-fineprint">Ending the round unlocks the wallet, currency and budget for editing.</p>
    </div>
  );
}

/** The locked view as a sheet, for screens with no room to keep it open. */
export function RoundSheet({
  open,
  round,
  entries,
  busy,
  onEnd,
  onClose,
}: {
  readonly open: boolean;
  readonly round: WalletRound;
  readonly entries: readonly RoundEntry[];
  readonly busy: boolean;
  readonly onEnd: () => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="wt-sheet"
      aria-labelledby="wt-round-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="wt-sheet-body">
        <header className="wt-sheet-head">
          <WalletIcon wallet={round.wallet} size={48} />
          <div>
            <h2 id="wt-round-title">Round settings</h2>
            <p>Fixed when the round started.</p>
          </div>
          <button type="button" className="wt-icon-btn" aria-label="Close" onClick={() => dialog.current?.close()}>
            <Glyph name="close" size={14} />
          </button>
        </header>
        <RoundDetails round={round} entries={entries} busy={busy} onEnd={onEnd} />
      </div>
    </dialog>
  );
}
