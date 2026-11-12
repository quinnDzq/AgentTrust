import { fmtMoney, type GrantView, type WalletView } from '@app/types.ts';
import { Tag } from './Tag';

export function TopBar({
  view,
  wallet,
  grant,
  busy = false,
  onReset,
}: {
  readonly view: 'wallet' | 'verification';
  readonly wallet: WalletView | null;
  readonly grant: GrantView | null;
  readonly busy?: boolean;
  readonly onReset?: () => void;
}) {
  const connected = wallet?.state === 'connected';
  return (
    <nav className="vp-top" aria-label="AgentTrust">
      <a className="vp-brand" href="/verify/">
        AGENTTRUST
      </a>
      <div className="vp-top-pages">
        <a className="vp-top-link" href="/verify/">Home</a>
        <a className="vp-top-link" href="/verify/paypal/board/" aria-current={view === 'wallet' ? 'page' : undefined}>
          Live Wallet
        </a>
        <a className="vp-top-link" href="/verify/paypal/" aria-current={view === 'verification' ? 'page' : undefined}>
          Live verification
        </a>
      </div>
      <div className="vp-top-chips">
        {wallet ? (
          <span className="vp-chip" data-ok={connected ? 'yes' : 'no'}>
            {connected ? 'Sandbox wallet connected' : 'Wallet not connected'}
            <Tag kind={wallet.mode === 'live' ? 'real' : 'sim'} />
          </span>
        ) : null}
        {grant ? (
          <span className="vp-chip" data-ok={grant.status === 'active' ? 'yes' : 'no'}>
            {grant.status === 'active'
              ? `${fmtMoney(grant.left)} of ${fmtMoney(grant.budget)} left`
              : grant.status === 'revoked'
                ? 'Agent revoked'
                : `Up to ${fmtMoney(grant.budget)}`}
            <Tag kind="local" />
          </span>
        ) : null}
        {onReset && (
          <button type="button" className="vp-btn vp-btn-ghost vp-btn-small" onClick={onReset} disabled={busy}>
            Reset
          </button>
        )}
      </div>
    </nav>
  );
}
