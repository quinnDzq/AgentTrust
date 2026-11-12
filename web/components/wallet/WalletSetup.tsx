'use client';

import { useId, useState, type FormEvent, type RefObject } from 'react';
import {
  amountDecimals,
  currenciesOf,
  drawCeiling,
  formatAmount,
  MIN_STARTING_UNITS,
  money,
  parseAmount,
  WALLETS,
  type TemplateCurrency,
  type WalletDraft,
} from '@/lib/wallet-template';
import { WalletIcon } from './PixelArt';

/** Round numbers a thumb can pick instead of typing. In whole units of the currency. */
const PRESETS = [10, 20, 50, 100] as const;

/**
 * The chosen wallet, as a card, with the two things it needs before a round:
 * a currency and a starting budget. They sit on the card because they belong
 * to this wallet — change the wallet and the currencies on offer change with
 * it. The amount is the largest thing on the card and is edited in place.
 *
 * What is typed here is a draft. It survives opening the picker and backing
 * out, and it survives a round: ending one comes back to this card as it was.
 */
export function WalletSetup({
  draft,
  onDraft,
  onChangeWallet,
  onStart,
  amountRef,
}: {
  readonly draft: WalletDraft;
  readonly onDraft: (draft: WalletDraft) => void;
  readonly onChangeWallet: () => void;
  readonly onStart: (draft: WalletDraft, amount: number) => void;
  readonly amountRef: RefObject<HTMLInputElement | null>;
}) {
  const [tried, setTried] = useState(false);
  const hintId = useId();

  const amount = parseAmount(draft.amount, draft.currency);
  const ceiling = amount === null ? 0 : drawCeiling(amount);
  const valid = amount !== null && ceiling >= 1;
  const showError = tried && !valid;
  const currencies = currenciesOf(draft.wallet);

  const start = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (amount === null || ceiling < 1) {
      setTried(true);
      amountRef.current?.focus();
      return;
    }
    onStart(draft, amount);
  };

  const setCurrency = (currency: TemplateCurrency): void => onDraft({ ...draft, currency });

  return (
    <form className="wt-setup" onSubmit={start} noValidate>
      <section className="wt-paper wt-card" aria-label="Chosen wallet">
        <header className="wt-card-head">
          <WalletIcon wallet={draft.wallet} size={56} />
          <div className="wt-card-id">
            <h2>{WALLETS[draft.wallet].label}</h2>
            <p>
              <span className="wt-chip wt-chip-sim">Simulated</span> No money moves in this round.
            </p>
          </div>
          <button type="button" className="wt-btn wt-btn-paper" onClick={onChangeWallet}>
            Change wallet
          </button>
        </header>

        <fieldset className="wt-field">
          <legend className="wt-field-name">Currency</legend>
          <div className="wt-seg">
            {currencies.map((currency) => (
              <label key={currency} className="wt-seg-item">
                <input
                  className="sr-only"
                  type="radio"
                  name={`${hintId}-currency`}
                  value={currency}
                  checked={draft.currency === currency}
                  onChange={() => setCurrency(currency)}
                />
                {currency}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="wt-field">
          <label className="wt-field-name" htmlFor={`${hintId}-amount`}>
            Starting budget
          </label>
          <div className="wt-amount-field" data-invalid={showError ? 'yes' : 'no'}>
            <input
              id={`${hintId}-amount`}
              ref={amountRef}
              className="wt-amount-input"
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="go"
              value={draft.amount}
              aria-describedby={`${hintId}-hint`}
              aria-invalid={showError ? true : undefined}
              onChange={(event) => onDraft({ ...draft, amount: event.target.value })}
            />
            <span className="wt-amount-unit">{draft.currency}</span>
          </div>
          <div className="wt-presets" aria-label="Quick amounts">
            {PRESETS.map((preset) => {
              const text = preset.toFixed(2);
              return (
                <button
                  key={preset}
                  type="button"
                  className="wt-preset"
                  aria-pressed={draft.amount.trim() === text}
                  onClick={() => onDraft({ ...draft, amount: text })}
                >
                  {preset}
                </button>
              );
            })}
          </div>
          <p className="wt-field-hint" id={`${hintId}-hint`} data-error={showError ? 'yes' : 'no'} role={showError ? 'alert' : undefined}>
            {showError
              ? `Enter an amount between ${formatAmount(MIN_STARTING_UNITS, draft.currency)} and 1,000,000 ${draft.currency}, with up to ${amountDecimals(draft.currency)} decimal places.`
              : valid
                ? `Requests are drawn at random, up to ${money(ceiling, draft.currency)}.`
                : 'Each request is under half the starting budget.'}
          </p>
        </div>
      </section>

      <button type="submit" className="wt-btn wt-btn-gold wt-btn-wide">
        Start round
      </button>
      <p className="wt-fineprint">Starting locks the wallet, currency and budget until you end the round.</p>
    </form>
  );
}
