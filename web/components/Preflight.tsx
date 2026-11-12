import type { VerificationSnapshot } from '@app/types.ts';
import type { Preflight as PreflightView, PreflightItem, PreflightState } from '@/lib/live';
import { Setup } from './Setup';

const GLYPH: { readonly [S in PreflightState]: string } = { ok: '✓', todo: '·', problem: '✗' };
const WORD: { readonly [S in PreflightState]: string } = { ok: 'in place', todo: 'to do', problem: 'needs attention' };

function Item({ item, action }: { readonly item: PreflightItem; readonly action?: React.ReactNode }) {
  return (
    <li className="lv-check" data-state={item.state}>
      <span className="lv-check-mark" role="img" aria-label={WORD[item.state]}>
        {GLYPH[item.state]}
      </span>
      <span className="lv-check-label">{item.label}</span>
      <span className="lv-check-detail">{item.detail}</span>
      {action}
    </li>
  );
}

/**
 * What has to be in place before a recording, and the few buttons that put it
 * there: PayPal's consent, the buyer's grant, and the agent's enrollment.
 *
 * Every one of these is a setup step on the server's own port. None is a tool
 * on the connector, so an agent platform can run a purchase and cannot grant
 * itself the means to. Once everything is in place this folds to one line and
 * stays out of the recording's way.
 */
export function Preflight({
  snap,
  preflight,
  busy,
  onConnect,
  onCheck,
  onApprove,
  onBudget,
}: {
  readonly snap: VerificationSnapshot;
  readonly preflight: PreflightView;
  readonly busy: boolean;
  readonly onConnect: () => void;
  readonly onCheck: () => void;
  readonly onApprove: (amount: number, askThresholdPct: number) => void;
  readonly onBudget: (amount: number, askThresholdPct: number) => void;
}) {
  const { wallet, grant, enrollment } = snap;
  if (!wallet || !grant || !enrollment) return null;

  const list = (
    <ul className="lv-checks">
      {preflight.items
        .filter((item) => item.key !== 'enrollment')
        .map((item) => (
          <Item key={item.key} item={item} />
        ))}
    </ul>
  );

  if (preflight.ready) {
    return (
      <details className="lv-preflight" data-ready="yes">
        <summary>
          <span className="lv-check-mark" aria-hidden="true">✓</span>
          Preflight complete
          <span className="lv-preflight-sum">{preflight.items.map((item) => item.label).join(' · ')}</span>
        </summary>
        {list}
      </details>
    );
  }

  const open = preflight.items.filter((item) => item.state !== 'ok').length;
  return (
    <section className="lv-preflight" data-ready="no" aria-label="Preflight">
      <p className="vp-label">
        Preflight · {open} of {preflight.items.length} still open
      </p>
      <Setup
        wallet={wallet}
        grant={grant}
        busy={busy}
        onConnect={onConnect}
        onCheck={onCheck}
        onApprove={onApprove}
        onBudget={onBudget}
      />
      {list}
    </section>
  );
}
