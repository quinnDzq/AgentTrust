'use client';

import { useState } from 'react';
import { api, type Ack } from '@/lib/api';
import { preflightOf } from '@/lib/live';
import { useSnapshot } from '@/lib/useSnapshot';
import { BudgetRequest } from './BudgetRequest';
import { IdentityCard, type IdentityProofView } from './IdentityCard';
import { LiveRun } from './LiveRun';
import { Preflight } from './Preflight';
import { Tag } from './Tag';
import { TopBar } from './TopBar';
import './verify.css';
import './live.css';

/**
 * The live payment verification view.
 *
 * It has a preflight — PayPal's consent, the buyer's grant, the agent's
 * enrollment — and after that the only control is Approve or Decline, when a
 * purchase is over the ask threshold. The request comes in through the
 * connector, and everything drawn below the preflight is the server's own
 * record of the run: the numeric challenge and the reply as it arrived, the
 * certificate, one authorization line, and the receipt.
 */
export function VerifyPage() {
  const { snap, offline, refresh } = useSnapshot();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [proof, setProof] = useState<IdentityProofView | null>(null);

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

  if (!snap) {
    return (
      <div className="vp-page vp-empty">
        <p className="vp-label">AGENTTRUST</p>
        <p>{offline ? 'Cannot reach the AgentTrust server. Start it with `bun run dev` in app/.' : 'Loading…'}</p>
      </div>
    );
  }

  const { grant, wallet, enrollment, live } = snap;
  const preflight = preflightOf(snap);
  if (!grant || !wallet || !enrollment || !preflight) {
    return (
      <div className="vp-page vp-empty">
        <p className="vp-label">AGENTTRUST</p>
        <p>Payment verification is unavailable. Check the AgentTrust server.</p>
      </div>
    );
  }

  return (
    <div className="vp-page">
      <TopBar
        page="Live verification"
        wallet={wallet}
        grant={grant}
        busy={busy}
        onReset={() => void act(async () => {
          const result = await api.reset();
          setProof(null);
          return result;
        })}
      />

      <main className="vp-main lv-main">
        <h1 className="vp-title">Incoming payment</h1>

        <Preflight
          snap={snap}
          preflight={preflight}
          busy={busy || offline}
          onConnect={() => void connect()}
          onCheck={() => void act(api.check)}
          onApprove={(amount, askPct) => void act(() => api.approve(amount, askPct))}
          onBudget={(amount, askPct) => void act(() => api.setBudget(amount, askPct))}
        />

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

        <BudgetRequest
          grant={grant}
          busy={busy || offline}
          onDecide={(requestId, choice) => void act(() => api.decideBudget(requestId, choice))}
        />

        {live ? (
          <LiveRun
            key={live.runId}
            run={live}
            enrollment={enrollment}
            grant={grant}
            busy={busy || offline}
            onDecide={(choice) => void act(() => api.decide(live.runId, choice))}
          />
        ) : (
          <p className="lv-muted" role="status">Waiting for a payment request.</p>
        )}

        <p className="vp-status" role="status" aria-live="polite">
          {offline ? 'Lost the AgentTrust server. Retrying…' : (message ?? '')}
        </p>
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
