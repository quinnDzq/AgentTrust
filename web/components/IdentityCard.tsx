'use client';

import { useState } from 'react';
import type { EnrollmentView } from '@app/types.ts';

export interface IdentityProofView {
  readonly nonce: string;
  readonly signature: string;
  readonly verified: boolean;
  readonly result: string;
  readonly fingerprint: string;
}

/** Show the middle of a long key or signature, and keep the ends. */
export function truncateMiddle(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function enrolledWhen(ms: number | null): string {
  if (ms === null) return 'Not recorded';
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function modeLabel(enrollment: EnrollmentView): string {
  return enrollment.identityMode === 'local' ? 'Local Ed25519' : 'ERC-8004';
}

/**
 * The enrollment row, opened up so Layer 2 can be shown on a phone:
 * which proof, the key, and a live signature.
 */
export function IdentityCard({
  enrollment,
  busy,
  onEnroll,
  onProve,
  proof,
}: {
  readonly enrollment: EnrollmentView;
  readonly busy: boolean;
  readonly onEnroll: () => void;
  readonly onProve: () => void;
  readonly proof: IdentityProofView | null;
}) {
  const [copied, setCopied] = useState(false);
  const enrolled = enrollment.status === 'verified' || enrollment.status === 'local';
  const key = enrollment.publicKey;

  async function copyKey(): Promise<void> {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <details className="lv-identity" aria-label="Layer 2 identity" open>
      <summary className="lv-identity-head">
        <span className="vp-label">Layer 2 · {enrollment.agentName} enrollment</span>
        <span className="lv-identity-mode">{modeLabel(enrollment)}</span>
      </summary>

      <div className="lv-identity-body">
        <dl className="lv-facts">
          <div>
            <dt>Identity mode</dt>
            <dd>{modeLabel(enrollment)}</dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd>{enrollment.keyPrint ?? '—'}</dd>
          </div>
          <div>
            <dt>Enrolled</dt>
            <dd>{enrolled ? enrolledWhen(enrollment.checkedAt) : 'Not enrolled'}</dd>
          </div>
          <div>
            <dt>Public key</dt>
            <dd className="lv-identity-key">
              <code>{key ? truncateMiddle(key) : '—'}</code>
              {key ? (
                <button type="button" className="vp-btn vp-btn-ghost vp-btn-small" onClick={() => void copyKey()}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              ) : null}
            </dd>
          </div>
        </dl>

        <div className="vp-step-row">
          <button type="button" className="vp-btn vp-btn-ghost" onClick={onEnroll} disabled={busy}>
            {enrolled ? 'Refresh enrollment' : `Enroll ${enrollment.agentName}`}
          </button>
          <button type="button" className="vp-btn vp-btn-gold" onClick={onProve} disabled={busy || !enrolled}>
            Prove identity
          </button>
        </div>

        {proof ? (
          <div className="lv-proof" data-verified={proof.verified ? 'yes' : 'no'}>
            <p className="lv-proof-result">{proof.verified ? '✓ Verified' : '✗ Not verified'}</p>
            <dl className="lv-facts">
              <div>
                <dt>Nonce</dt>
                <dd>
                  <code>{proof.nonce}</code>
                </dd>
              </div>
              <div>
                <dt>Signature</dt>
                <dd>
                  <code>{truncateMiddle(proof.signature, 12, 8)}</code>
                </dd>
              </div>
              <div>
                <dt>Checked against</dt>
                <dd>fingerprint {proof.fingerprint}</dd>
              </div>
            </dl>
          </div>
        ) : null}
      </div>
    </details>
  );
}
