import { fmtMoney, type GrantView, type WalletView } from '@app/types.ts';
import { Tag } from './Tag';

export function TopBar({
  page,
  wallet,
  grant,
  busy,
  onReset,
}: {
  /** What this page is, beside the wordmark. */
  readonly page: string;
  readonly wallet: WalletView | null;
  readonly grant: GrantView | null;
  readonly busy: boolean;
  readonly onReset: () => void;
}) {
  const connected = wallet?.state === 'connected';
  return (
    <nav className="vp-top" aria-label="AgentTrust">
      <a className="vp-brand" href="/verify/paypal/">
        AGENTTRUST
      </a>
      <span className="vp-top-page">{page}</span>
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
        <button type="button" className="vp-btn vp-btn-ghost vp-btn-small" onClick={onReset} disabled={busy}>
          Reset
        </button>
      </div>
    </nav>
  );
}
