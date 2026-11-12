'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { WALLET_KINDS, WALLETS, type WalletKind } from '@/lib/wallet-template';
import { Glyph, WalletIcon } from './PixelArt';

/** How long a chosen row shows as chosen before the sheet closes. Long enough to see, too short to wait for. */
const CHOSEN_MS = 280;

/**
 * Choosing a wallet is one decision, so it gets the whole sheet: a heading, a
 * close button, and three large rows. A row answers the tap at once — it is
 * marked chosen in place — and then the sheet closes and the choice is carried
 * to the wallet card. Closing without choosing changes nothing.
 *
 * A native `<dialog>` keeps what a sheet needs for free: focus stays inside,
 * Escape closes it, and focus returns to the button that opened it. It is a
 * bottom sheet on a phone and a centred overlay on a desktop; the page stays
 * visible behind it so it is clear where the choice lands.
 *
 * The rows are a radio group: arrow keys move between them, Enter or Space
 * chooses.
 */
export function WalletPicker({
  open,
  selected,
  onPick,
  onClose,
}: {
  readonly open: boolean;
  /** The wallet on the card now, if one has been chosen. */
  readonly selected: WalletKind | null;
  readonly onPick: (wallet: WalletKind) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const rows = useRef(new Map<WalletKind, HTMLButtonElement>());
  const [chosen, setChosen] = useState<WalletKind | null>(null);
  const [focused, setFocused] = useState<WalletKind>(selected ?? 'paypal');

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      const start = selected ?? 'paypal';
      setChosen(null);
      setFocused(start);
      el.showModal();
      rows.current.get(start)?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open, selected]);

  // Carry the choice forward a beat after the row has shown it. The latest
  // callback is read through a ref so a re-render cannot restart the beat.
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  useEffect(() => {
    if (chosen === null) return;
    const timer = setTimeout(() => {
      if (dialog.current?.open) pick.current(chosen);
    }, CHOSEN_MS);
    return () => clearTimeout(timer);
  }, [chosen]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, from: WalletKind): void => {
    const index = WALLET_KINDS.indexOf(from);
    const last = WALLET_KINDS.length - 1;
    const to =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? index === last ? 0 : index + 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? index === 0 ? last : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    const next = WALLET_KINDS[to];
    if (!next) return;
    setFocused(next);
    rows.current.get(next)?.focus();
  };

  const marked = chosen ?? selected;

  return (
    <dialog
      ref={dialog}
      className="wt-sheet wt-picker"
      aria-labelledby="wt-picker-title"
      aria-describedby="wt-picker-about"
      onClose={onClose}
      onClick={(event) => {
        // A click on the dialog element itself is a click on the backdrop.
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="wt-sheet-body">
        <header className="wt-sheet-head">
          <span className="wt-sheet-mark" aria-hidden="true">
            <Glyph name="wallet" size={26} />
          </span>
          <div>
            <h2 id="wt-picker-title">Choose a wallet</h2>
            <p id="wt-picker-about">It funds a practice round in this tab. Nothing is charged.</p>
          </div>
          <button type="button" className="wt-icon-btn" aria-label="Close" onClick={() => dialog.current?.close()}>
            <Glyph name="close" size={14} />
          </button>
        </header>

        <div className="wt-wallet-rows" role="radiogroup" aria-labelledby="wt-picker-title">
          {WALLET_KINDS.map((wallet) => {
            const isMarked = marked === wallet;
            return (
              <button
                key={wallet}
                ref={(el) => {
                  if (el) rows.current.set(wallet, el);
                  else rows.current.delete(wallet);
                }}
                type="button"
                role="radio"
                aria-checked={isMarked}
                tabIndex={focused === wallet ? 0 : -1}
                className="wt-wallet-row"
                data-chosen={chosen === wallet ? 'yes' : 'no'}
                disabled={chosen !== null && chosen !== wallet}
                onFocus={() => setFocused(wallet)}
                onKeyDown={(event) => move(event, wallet)}
                onClick={() => setChosen(wallet)}
              >
                <WalletIcon wallet={wallet} size={48} />
                <span className="wt-wallet-text">
                  <span className="wt-wallet-name">{WALLETS[wallet].label}</span>
                  <span className="wt-wallet-status">{WALLETS[wallet].status}</span>
                </span>
                <span className="wt-radio" aria-hidden="true">
                  {isMarked ? <Glyph name="check" size={14} /> : null}
                </span>
              </button>
            );
          })}
        </div>

        <p className="wt-sheet-foot">
          <a href="./paypal/">Open PayPal Sandbox</a> to connect a test wallet.
        </p>
      </div>
    </dialog>
  );
}
