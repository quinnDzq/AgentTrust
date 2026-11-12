/**
 * Sources of verification evidence:
 *
 *   REAL      a PayPal Sandbox call made it happen
 *   TESTNET   read from a public testnet when the agent was enrolled
 *   LOCAL     verified or enforced by AgentTrust
 *   SIM       scripted or hand-written here; no PayPal call
 *   ADVISORY  evidence that grants nothing
 */

export type TagKind = 'real' | 'testnet' | 'local' | 'sim' | 'advisory';

const WORD: { readonly [K in TagKind]: string } = {
  real: 'REAL',
  testnet: 'TESTNET',
  local: 'LOCAL',
  sim: 'SIM',
  advisory: 'ADVISORY',
};

const MEANS: { readonly [K in TagKind]: string } = {
  real: 'A PayPal Sandbox call did this, on the tested saved-wallet flow.',
  testnet: 'Read from a public testnet when the agent was enrolled. Not consulted when a payment is ruled on.',
  local: 'Checked by AgentTrust.',
  sim: 'Simulated locally. No PayPal call.',
  advisory: 'Evidence only. It grants nothing and refuses nothing.',
};

export function Tag({ kind }: { readonly kind: TagKind }) {
  return (
    <span className={`vp-tag vp-tag-${kind}`} title={MEANS[kind]}>
      {WORD[kind]}
    </span>
  );
}
