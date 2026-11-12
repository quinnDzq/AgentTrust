'use client';

import { fmtUsd } from '@app/types.ts';
import { useState } from 'react';
import { api, type Ack } from '@/lib/api';
import { preflightOf, stampOf } from '@/lib/live';
import { useSnapshot } from '@/lib/useSnapshot';
import { BudgetRequest } from './BudgetRequest';
import { IdentityCard, type IdentityProofView } from './IdentityCard';
import { LiveRun } from './LiveRun';
import { Sprite } from './Sprite';
import { Preflight } from './Preflight';
import { Setup } from './Setup';
import { Tag } from './Tag';
import { TopBar } from './TopBar';
import './verify.css';
import './live.css';

/** The wallet and verification views share the buyer's payment session. */
export function VerifyPage({ view }: { readonly view: 'wallet' | 'verification' }) {
  const walletPage = view === 'wallet';
  const heading = walletPage ? 'Live Wallet' : 'Incoming payment';
  const { snap, offline, refresh } = useSnapshot();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [proof, setProof] = useState<IdentityProofView | null>(null);
  const [resetRequested, setResetRequested] = useState(false);

  const act = async (run: () => Promise<Ack>): Promise<void> => {
    setBusy(true);
    try {
      const ack = await run();
      setMessage(ack.message ?? null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  /**
   * Send the buyer to PayPal's own consent page. The window opens inside the
   * click, before the server answers, because a window opened later is
   * blocked as a popup; it is pointed at the approval link once that arrives.
   */
  const connect = async (): Promise<void> => {
    const popup = window.open('', 'agenttrust-paypal', 'popup,width=480,height=760');
    setBusy(true);
    try {
      const reply = await api.connect();
      if (reply.approvalUrl && popup) {
        popup.location.href = reply.approvalUrl;
      } else if (reply.approvalUrl) {
        window.location.assign(reply.approvalUrl);
        return;
      } else {
        popup?.close();
      }
      setMessage(reply.message ?? null);
    } catch (err) {
      popup?.close();
      setMessage(err instanceof Error ? err.message : 'PayPal did not start the setup.');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const { grant, wallet, enrollment, live } = snap ?? {};
  const preflight = snap && preflightOf(snap);
  if (!snap || !grant || !wallet || !enrollment || !preflight) {
    let status = 'Loading…';
    if (offline) status = 'Cannot reach the AgentTrust server. Start it with bun run dev in app/.';
    else if (snap) status = 'Payment verification is unavailable. Check the AgentTrust server.';

    return (
      <div className="vp-page">
        <TopBar wallet={null} grant={null} />
        <main className="vp-main lv-main">
          <h1 className="vp-title">{heading}</h1>
          <p className="vp-status" role="status">{status}</p>
        </main>
      </div>
    );
  }

  const setupActions = {
    busy: busy || offline,
    onConnect: () => void connect(),
    onCheck: () => void act(api.check),
    onApprove: (amount: number, askPct: number) => void act(() => api.approve(amount, askPct)),
    onBudget: (amount: number, askPct: number) => void act(() => api.setBudget(amount, askPct)),
  };
  const identityCard = (
    <IdentityCard
      enrollment={enrollment}
      busy={busy || offline}
      onEnroll={() => void act(api.enroll)}
      onProve={() =>
        void act(async () => {
          const result = await api.proveIdentity();
          if (result.nonce && result.signature && result.fingerprint && typeof result.verified === 'boolean') {
            setProof({
              nonce: result.nonce,
              signature: result.signature,
              verified: result.verified,
              result: result.result ?? (result.verified ? 'verified' : 'not verified'),
              fingerprint: result.fingerprint,
            });
          }
          return result;
        })
      }
      proof={proof}
    />
  );
  const latestPayment = walletPage && live ? { quote: live.quote, stamp: stampOf(live.stage) } : null;

  const resetSession = () => {
    setResetRequested(false);
    void act(async () => {
      const result = await api.reset();
      setProof(null);
      return result;
    });
  };

  return (
    <div className="vp-page">
      <TopBar
        wallet={wallet}
        grant={grant}
        busy={busy}
        onReset={() => {
          if (live || proof || wallet.state === 'connected') setResetRequested(true);
          else resetSession();
        }}
      />

      <main className="vp-main lv-main">
        <h1 className="vp-title">{heading}</h1>
        <p className="vp-status" role="status" aria-live="polite">
          {offline ? 'Lost the AgentTrust server. Retrying…' : (message ?? '')}
        </p>

        {resetRequested && (
          <section className="lv-proof" aria-label="Confirm session reset">
            <p className="lv-proof-result">Reset this session?</p>
            <p className="lv-proof-note">This clears the payment result and identity proof and resets the spending grant.</p>
            <div className="vp-step-row">
              <button type="button" className="vp-btn vp-btn-ghost" onClick={() => setResetRequested(false)}>
                Cancel
              </button>
              <button type="button" className="vp-btn vp-btn-gold" onClick={resetSession} disabled={busy || offline}>
                Reset session
              </button>
            </div>
          </section>
        )}

        {!walletPage && (
          <p><a className="vp-top-link" href="/verify/paypal/board/">Open Live Wallet</a></p>
        )}

        {walletPage ? (
          <>
            {identityCard}
            <Setup wallet={wallet} grant={grant} showConnected {...setupActions} />
          </>
        ) : (
          <>
            <Preflight snap={snap} preflight={preflight} {...setupActions} />
            {identityCard}
          </>
        )}

        <BudgetRequest
          grant={grant}
          busy={busy || offline}
          onDecide={(requestId, choice) => void act(() => api.decideBudget(requestId, choice))}
        />

        {latestPayment && (
          <a className="lv-wallet-payment" href="/verify/paypal/">
            <Sprite who="pip" size={40} decorative className="lv-icon" />
            <div className="lv-request-body">
              <p className="vp-label">Latest payment</p>
              <p>{latestPayment.quote.item} · {fmtUsd(latestPayment.quote.amount)}</p>
            </div>
            <span className={`vp-stamp vp-stamp-${latestPayment.stamp.tone}`}>{latestPayment.stamp.word}</span>
          </a>
        )}

        {!walletPage && (live ? (
          <LiveRun
            key={live.runId}
            run={live}
            enrollment={enrollment}
            grant={grant}
            busy={busy || offline}
            onDecide={(choice) => void act(() => api.decide(live.runId, choice))}
          />
        ) : (
          <div className="lv-waiting" role="status">
            <Sprite who="pip" size={40} decorative className="lv-icon" />
            <p>Waiting for a payment request.</p>
          </div>
        ))}
      </main>

      <footer className="vp-honesty">
        <span>
          <Tag kind={wallet.mode === 'live' ? 'real' : 'sim'} />
          {wallet.mode === 'live'
            ? ' PayPal Sandbox: the saved wallet and each capture, confirmed by PayPal.'
            : ' Configure PayPal Sandbox to connect a wallet and submit payments.'}
        </span>
        {enrollment.identityMode === 'local' ? (
          <span>
            <Tag kind="local" /> The agent’s identity: the signer’s Ed25519 key, enrolled on this server. Request
            signatures are checked against that key.
          </span>
        ) : (
          <span>
            <Tag kind="testnet" /> The ERC-8004 registration: read from the testnet when the agent was enrolled. It says who
            owns the registration, and nothing about a payment.
          </span>
        )}
        <span>
          <Tag kind="local" /> AgentTrust checks the model signal, Ed25519 signature and buyer’s grant.
        </span>
        <span>
          <Tag kind="advisory" /> The model signal is a match against the tested reference replies. It decides whether a
          signing challenge is offered; a payment rests on the signature and the grant.
        </span>
      </footer>
      <div className="vp-grain" aria-hidden="true" />
    </div>
  );
}
