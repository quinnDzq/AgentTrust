'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createTemplateKey,
  DEFAULT_WALLET_DRAFT,
  decisionReason,
  drawAmount,
  drawCeiling,
  layerLine,
  layersVisited,
  verifyRequest,
  withWallet,
  type Layer,
  type Outcome,
  type RoundEntry,
  type TemplateRequest,
  type WalletDraft,
  type WalletKind,
  type WalletRound,
} from '@/lib/wallet-template';
import { GatewayWindow, lampStates, StepLamps, type Scene } from './wallet/Gateway';
import { Glyph } from './wallet/PixelArt';
import { RequestSlip } from './wallet/RequestSlip';
import { RoundBar, RoundDetails, RoundSheet } from './wallet/Round';
import { WalletPicker } from './wallet/WalletPicker';
import { WalletSetup } from './wallet/WalletSetup';
import './wallet-template.css';

const WORKING_MS = 800;
const VERDICT_MS = 1300;

type Phase = { at: 'ready' } | { at: 'layer'; layer: Layer; beat: 'working' | 'verdict' } | { at: 'decided' };
type FocusTarget = 'amount' | 'send' | 'window' | 'receipt';

export function WalletTemplate() {
  const [draft, setDraft] = useState<WalletDraft>(DEFAULT_WALLET_DRAFT);
  const [walletChosen, setWalletChosen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [round, setRound] = useState<WalletRound | null>(null);
  const [request, setRequest] = useState<TemplateRequest | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: 'ready' });
  const [entries, setEntries] = useState<RoundEntry[]>([]);
  const [roundSheetOpen, setRoundSheetOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');

  const keys = useRef<Promise<CryptoKeyPair> | null>(null);
  const nextReference = useRef(0);
  // Holds the request through signing and playback. Clearing it claims the
  // result once, even if Skip and the last timer reach the decision together.
  const pending = useRef<TemplateRequest | null>(null);
  const focusNext = useRef<FocusTarget | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const windowRef = useRef<HTMLElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const target = focusNext.current;
    if (!target || pickerOpen || roundSheetOpen) return;
    focusNext.current = null;
    const refs = { amount: amountRef, send: sendRef, window: windowRef, receipt: titleRef };
    const element = refs[target].current;
    element?.focus();
    if (target === 'receipt') {
      const slip = element?.closest('.wt-slip');
      const bounds = slip?.getBoundingClientRect();
      if (bounds && bounds.height < window.innerHeight - 110 && bounds.bottom > window.innerHeight) {
        slip?.scrollIntoView({ block: 'end' });
      }
    }
  });

  function pick(wallet: WalletKind) {
    focusNext.current = 'amount';
    setDraft((current) => withWallet(current, wallet));
    setWalletChosen(true);
    setPickerOpen(false);
  }

  function draw(currentRound: WalletRound, wrongKey = false, previous?: number) {
    nextReference.current += 1;
    focusNext.current = 'send';
    setRequest({
      reference: `DEMO-${String(nextReference.current).padStart(3, '0')}`,
      amount: drawAmount(drawCeiling(currentRound.startingAmount), previous),
      wrongKey,
    });
    setOutcome(null);
    setPhase({ at: 'ready' });
    setError('');
    setAnnounce('');
  }

  function startRound(settings: WalletDraft, amount: number) {
    const nextRound = { wallet: settings.wallet, currency: settings.currency, startingAmount: amount, remaining: amount };
    nextReference.current = 0;
    setEntries([]);
    setRound(nextRound);
    draw(nextRound);
  }

  function endRound() {
    if (pending.current) return;
    focusNext.current = 'amount';
    keys.current = null;
    setRoundSheetOpen(false);
    setRound(null);
    setRequest(null);
    setOutcome(null);
    setEntries([]);
    setPhase({ at: 'ready' });
    setError('');
    setAnnounce('');
  }

  async function send() {
    if (!round || !request || phase.at !== 'ready' || pending.current) return;
    pending.current = request;
    setBusy(true);
    setError('');
    try {
      keys.current ??= createTemplateKey();
      const result = await verifyRequest(round, request, await keys.current);
      focusNext.current = 'window';
      setOutcome(result);
      setPhase({ at: 'layer', layer: 1, beat: 'working' });
      setAnnounce('Layer 1. Reading the model signal.');
    } catch {
      keys.current = null;
      pending.current = null;
      focusNext.current = 'send';
      setError('This browser cannot sign here. Open the page on localhost or over HTTPS.');
    } finally {
      setBusy(false);
    }
  }

  const finish = useCallback(() => {
    if (!round || !request || !outcome || pending.current !== request) return;
    pending.current = null;
    if (outcome.approved && outcome.authorization) {
      setRound({ ...round, remaining: outcome.authorization.remainingAfter });
    }
    setEntries((current) => [...current, { ...request, stoppedAt: outcome.stoppedAt }]);
    const active = document.activeElement;
    if (active === document.body || flowRef.current?.contains(active)) {
      focusNext.current = 'receipt';
    }
    setPhase({ at: 'decided' });
    const verdict = outcome.approved ? 'Simulated approval.' : 'Payment blocked.';
    const skipped = outcome.stoppedAt === 2 ? ' Layer 3 was skipped.' : '';
    setAnnounce(`${verdict} ${decisionReason(outcome, request, round.currency)}${skipped}`);
  }, [outcome, request, round]);

  useEffect(() => {
    if (phase.at !== 'layer' || !round || !request || !outcome) return;
    const { layer, beat } = phase;
    const visited = layersVisited(outcome);
    const timer = setTimeout(() => {
      if (pending.current !== request) return;
      if (beat === 'working') {
        setPhase({ at: 'layer', layer, beat: 'verdict' });
        setAnnounce(`Layer ${layer}. ${layerLine(outcome, layer, request, round.currency)}`);
      } else {
        const next = visited[visited.indexOf(layer) + 1];
        if (next) setPhase({ at: 'layer', layer: next, beat: 'working' });
        else finish();
      }
    }, beat === 'working' ? WORKING_MS : VERDICT_MS);
    return () => clearTimeout(timer);
  }, [finish, outcome, phase, request, round]);

  const scene: Scene = phase.at === 'layer'
    ? { kind: 'layer', layer: phase.layer, beat: phase.beat }
    : { kind: phase.at === 'decided' ? 'decision' : 'idle' };
  const checking = phase.at === 'layer';
  const heading = !walletChosen ? 'Verify a payment' : round ? 'Verify a payment' : 'Set up your wallet';

  return (
    <div className="wt-page">
      <nav className="wt-top" aria-label="AgentTrust">
        <div className="wt-top-inner">
          <a className="wt-brand" href="/verify/">AGENTTRUST</a>
          <span className="wt-session"><i aria-hidden="true" />Browser simulation</span>
          <div className="wt-nav-actions">
            <a href="/verify/paypal/">Live view</a>
          </div>
        </div>
      </nav>

      <main className="wt-main" data-view={!walletChosen ? 'empty' : round ? 'round' : 'setup'}>
        <header className="wt-heading">
          <h1>{heading}</h1>
          {!walletChosen ? (
            <>
              <p>Follow an AI agent’s payment request through three checks. Pick a wallet to start a practice round.</p>
              <button type="button" className="wt-btn wt-btn-gold" aria-haspopup="dialog" onClick={() => setPickerOpen(true)}>
                <Glyph name="wallet" size={18} />
                Choose a wallet
              </button>
            </>
          ) : null}
        </header>

        {!walletChosen ? (
          <GatewayWindow scene={{ kind: 'idle' }} outcome={null} request={null} round={null} />
        ) : round && request ? (
          <>
            <RoundBar round={round} onOpen={() => setRoundSheetOpen(true)} gearRef={gearRef} />
            <div className="wt-round-layout">
              <aside className="wt-rail" aria-label="Round settings">
                <h2>Round settings</h2>
                <RoundDetails round={round} entries={entries} busy={busy || checking} onEnd={endRound} />
              </aside>
              <div className="wt-flow" ref={flowRef}>
                <StepLamps states={lampStates(outcome, phase.at === 'layer' ? phase : phase.at)} />
                <GatewayWindow scene={scene} outcome={outcome} request={request} round={round} windowRef={windowRef} />
                <RequestSlip
                  key={request.reference}
                  request={request}
                  round={round}
                  phase={checking ? 'checking' : phase.at === 'decided' ? 'decided' : 'ready'}
                  outcome={outcome}
                  error={error}
                  busy={busy}
                  onWrongKey={(wrongKey) => setRequest({ ...request, wrongKey })}
                  onSend={() => void send()}
                  onSkip={finish}
                  onDraw={(wrongKey) => draw(round, wrongKey, request.amount)}
                  sendRef={sendRef}
                  titleRef={titleRef}
                />
              </div>
            </div>
            <RoundSheet
              open={roundSheetOpen}
              round={round}
              entries={entries}
              busy={busy || checking}
              onEnd={endRound}
              onClose={() => setRoundSheetOpen(false)}
            />
          </>
        ) : (
          <WalletSetup
            draft={draft}
            onDraft={setDraft}
            onChangeWallet={() => setPickerOpen(true)}
            onStart={startRound}
            amountRef={amountRef}
          />
        )}
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</p>
      </main>

      <footer className="wt-footer">
        This tab runs a practice round in your browser. The live view shows the server’s own session.
      </footer>
      <WalletPicker
        open={pickerOpen}
        selected={walletChosen ? draft.wallet : null}
        onPick={pick}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
