/**
 * What the live view says about a run, as pure functions of the server's
 * snapshot. No React here, so every rule about wording can be tested on its
 * own — above all that a check is only marked passed when the server
 * recorded that proof, and that PAID is only a capture PayPal confirmed.
 *
 * The page decides nothing. Each function below reads an outcome the server
 * already reached and chooses the words and the mark for it.
 */

import {
  addCents,
  fmtMoney,
  fmtUsd,
  type Cents,
  type ConnectorView,
  type EnrollmentView,
  type GrantView,
  type LiveRunView,
  type LiveStage,
  type ModelCandidateView,
  type VerificationSnapshot,
  type WalletView,
} from '@app/types.ts';
export type Mark = 'pass' | 'fail' | 'ask' | 'wait' | 'off';

export const MARK_GLYPH: Record<Mark, string> = {
  pass: '✓',
  fail: '✗',
  ask: '?',
  wait: '·',
  off: '–',
};

/* ---------- Preflight: what has to be in place before a recording ---------- */

export type PreflightState = 'ok' | 'todo' | 'problem';

export interface PreflightItem {
  readonly key: 'wallet' | 'grant' | 'enrollment' | 'signer' | 'reference' | 'connector';
  readonly label: string;
  readonly state: PreflightState;
  /** One line: what is in place, or what is missing. */
  readonly detail: string;
}

export interface Preflight {
  readonly items: readonly PreflightItem[];
  /** Everything a live run needs is in place. */
  readonly ready: boolean;
}

/** `14:32:10`, in the viewer's own time zone. For "last heard at" and expiries. */
export function clock(ms: number | null): string {
  if (ms === null) return '—';
  const date = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** `0x8004…BD9e`: enough of an address to recognise it at reading distance. */
export function shortAddress(address: string | null): string {
  if (!address) return '—';
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function walletItem(wallet: WalletView): PreflightItem {
  const label = 'PayPal Sandbox wallet';
  if (wallet.state === 'connected') {
    return wallet.mode === 'live'
      ? { key: 'wallet', label, state: 'ok', detail: 'Connected. PayPal confirmed the saved wallet.' }
      : {
          key: 'wallet',
          label,
          // Enough to rehearse every check; a recording needs a real Sandbox capture.
          state: 'todo',
          detail: 'Simulated: no PayPal credentials on this server, so nothing is charged.',
        };
  }
  return { key: 'wallet', label, state: 'todo', detail: wallet.note ?? 'Not connected yet.' };
}

function grantItem(grant: GrantView): PreflightItem {
  const label = 'Buyer’s spending grant';
  switch (grant.status) {
    case 'active':
      return {
        key: 'grant',
        label,
        state: 'ok',
        detail: `${fmtUsd(grant.left)} of ${fmtUsd(grant.budget)} left at ${grant.merchant}, ${grant.until}.`,
      };
    case 'revoked':
      return { key: 'grant', label, state: 'problem', detail: `The buyer revoked ${grant.registryId}.` };
    case 'needs_wallet':
      return { key: 'grant', label, state: 'todo', detail: 'Waits for the wallet.' };
    case 'needs_approval':
      return { key: 'grant', label, state: 'todo', detail: `Not approved for this run: ${fmtUsd(grant.budget)} at ${grant.merchant}.` };
    default: {
      const unreachable: never = grant.status;
      throw new Error(`no grant status ${String(unreachable)}`);
    }
  }
}

function localKeyLine(enrollment: EnrollmentView): string {
  return `Local key enrolled (Ed25519, fingerprint ${enrollment.keyPrint ?? '—'})`;
}

/** Local identity mode: the enrolled Ed25519 key is the whole proof. */
function localEnrollmentItem(enrollment: EnrollmentView, label: string): PreflightItem {
  switch (enrollment.status) {
    case 'local':
    case 'verified':
      return {
        key: 'enrollment',
        label,
        state: enrollment.active ? 'ok' : 'problem',
        detail: enrollment.active
          ? `${localKeyLine(enrollment)}.`
          : 'The registry is not using the enrolled key. Enroll again.',
      };
    case 'failed':
      return { key: 'enrollment', label, state: 'problem', detail: enrollment.note ?? 'The key could not be enrolled.' };
    case 'unresolved':
      return { key: 'enrollment', label, state: 'problem', detail: enrollment.note ?? 'The signer could not be read.' };
    case 'none':
      return {
        key: 'enrollment',
        label,
        state: 'todo',
        detail: enrollment.note ?? 'Not enrolled yet. Enroll the signer’s Ed25519 key.',
      };
    default: {
      const unreachable: never = enrollment.status;
      throw new Error(`no enrollment status ${String(unreachable)}`);
    }
  }
}

function enrollmentItem(enrollment: EnrollmentView): PreflightItem {
  const label = `${enrollment.agentName} enrollment`;
  if (enrollment.identityMode === 'local') return localEnrollmentItem(enrollment, label);
  const where = `${enrollment.network ?? 'testnet'} · agent ${enrollment.agentId ?? '?'}`;
  switch (enrollment.status) {
    case 'verified':
      return {
        key: 'enrollment',
        label,
        state: enrollment.active ? 'ok' : 'problem',
        detail: enrollment.active
          ? `ERC-8004 registration verified · ${where} · block ${enrollment.blockNumber ?? '?'}.`
          : 'Verified, but the registry is not using this key. Enroll again.',
      };
    case 'local':
      return {
        key: 'enrollment',
        label,
        // Enough to run, never enough to call verified: the recording needs the registration.
        state: 'todo',
        detail: 'Signer key enrolled. No ERC-8004 registration is configured to check.',
      };
    case 'failed':
      return { key: 'enrollment', label, state: 'problem', detail: enrollment.note ?? 'The registration check failed.' };
    case 'unresolved':
      return { key: 'enrollment', label, state: 'problem', detail: enrollment.note ?? 'The registration could not be read.' };
    case 'none':
      return {
        key: 'enrollment',
        label,
        state: 'todo',
        detail: enrollment.note ?? (enrollment.configured ? `Not enrolled yet. Will check ${where}.` : 'Not enrolled yet.'),
      };
    default: {
      const unreachable: never = enrollment.status;
      throw new Error(`no enrollment status ${String(unreachable)}`);
    }
  }
}

function signerItem(connector: ConnectorView | null): PreflightItem {
  const label = 'Signer service';
  if (!connector) return { key: 'signer', label, state: 'todo', detail: 'Not checked.' };
  switch (connector.signer) {
    case 'reachable':
      return { key: 'signer', label, state: 'ok', detail: 'Answering on this machine.' };
    case 'unreachable':
      return { key: 'signer', label, state: 'problem', detail: connector.signerNote ?? 'Not answering.' };
    case 'not_checked':
      return { key: 'signer', label, state: 'todo', detail: connector.signerNote ?? 'Not checked yet. Enroll to check it.' };
    default: {
      const unreachable: never = connector.signer;
      throw new Error(`no signer state ${String(unreachable)}`);
    }
  }
}

function referenceItem(connector: ConnectorView | null): PreflightItem {
  const label = 'Model reference';
  if (!connector) return { key: 'reference', label, state: 'todo', detail: 'Not loaded.' };
  if (connector.calibratingAs !== null) {
    return {
      key: 'reference',
      label,
      state: 'problem',
      detail: `Calibration mode: replies are recorded as ${connector.calibratingAs} (${connector.referenceSamples} of ${connector.referenceNeeded}) and not scored.`,
    };
  }
  if (connector.expectedModel === null) {
    return { key: 'reference', label, state: 'todo', detail: 'No reference replies recorded yet. Nothing can match.' };
  }
  return connector.calibrated
    ? { key: 'reference', label, state: 'ok', detail: `${connector.expectedModel} · ${connector.referenceSamples} recorded replies · calibrated.` }
    : {
        key: 'reference',
        label,
        state: 'todo',
        detail: `${connector.expectedModel} · ${connector.referenceSamples} of ${connector.referenceNeeded} recorded replies. Nothing can match yet.`,
      };
}

function connectorItem(connector: ConnectorView | null): PreflightItem {
  const label = 'MCP connector';
  if (!connector) return { key: 'connector', label, state: 'problem', detail: 'Not being served by this server.' };
  return connector.lastCallAt === null
    ? { key: 'connector', label, state: 'todo', detail: `Listening at ${connector.endpoint}. No client has called yet.` }
    : { key: 'connector', label, state: 'ok', detail: `Last call ${connector.lastTool ?? ''} at ${clock(connector.lastCallAt)}.` };
}

/** Everything a live run depends on, in the order an operator sets it up. */
export function preflightOf(snap: VerificationSnapshot): Preflight | null {
  const { wallet, grant, enrollment, connector } = snap;
  if (!wallet || !grant || !enrollment) return null;
  const items = [
    walletItem(wallet),
    grantItem(grant),
    enrollmentItem(enrollment),
    signerItem(connector),
    referenceItem(connector),
    connectorItem(connector),
  ];
  return { items, ready: items.every((item) => item.state === 'ok') };
}

/* ---------- The run's stamp ---------- */

export interface StageStamp {
  readonly word: string;
  readonly tone: 'ok' | 'error' | 'pending' | 'sim';
}

/**
 * The stamp on a run. PAID only for a capture PayPal confirmed in live Sandbox
 * mode — the server's `paid` stage means exactly that, and nothing else maps to it.
 */
export function stampOf(stage: LiveStage): StageStamp {
  switch (stage) {
    case 'awaiting_reply':
      return { word: 'LAYER 1', tone: 'pending' };
    case 'awaiting_signature':
      return { word: 'LAYER 2', tone: 'pending' };
    case 'verifying':
      return { word: 'AT THE GATE', tone: 'pending' };
    case 'charging':
      return { word: 'WITH PAYPAL', tone: 'pending' };
    case 'payment_unconfirmed':
      return { word: 'NOT CONFIRMED', tone: 'pending' };
    case 'paid':
      return { word: 'PAID', tone: 'ok' };
    case 'simulated':
      return { word: 'SIMULATED', tone: 'sim' };
    case 'needs_buyer':
      return { word: 'ASKS THE BUYER', tone: 'pending' };
    case 'model_not_matched':
      return { word: 'STOPPED AT LAYER 1', tone: 'error' };
    case 'identity_failed':
      return { word: 'REFUSED AT LAYER 2', tone: 'error' };
    case 'authorization_failed':
      return { word: 'REFUSED AT LAYER 3', tone: 'error' };
    case 'payment_failed':
      return { word: 'NOT PAID', tone: 'error' };
    case 'expired':
      return { word: 'EXPIRED', tone: 'error' };
    default: {
      const unreachable: never = stage;
      throw new Error(`no stamp for ${String(unreachable)}`);
    }
  }
}

/** Which layer the run is at or stopped at, so the page can bring it into view. */
export function activeLayer(stage: LiveStage): 1 | 2 | 3 | 4 {
  switch (stage) {
    case 'awaiting_reply':
    case 'model_not_matched':
    case 'expired':
      return 1;
    case 'awaiting_signature':
    case 'verifying':
    case 'identity_failed':
      return 2;
    case 'authorization_failed':
    case 'needs_buyer':
      return 3;
    case 'charging':
    case 'payment_unconfirmed':
    case 'payment_failed':
    case 'paid':
    case 'simulated':
      return 4;
    default: {
      const unreachable: never = stage;
      throw new Error(`no layer for ${String(unreachable)}`);
    }
  }
}

/* ---------- Layer 1: the model signal ---------- */

export interface ModelLine {
  readonly mark: Mark;
  readonly headline: string;
  /** `294 of 294 integers received`, once a reply arrived. */
  readonly count: string | null;
  /** The closest reference from this run, even when it did not match. */
  readonly closest: ModelCandidateView | null;
}

export function modelLine(run: LiveRunView): ModelLine {
  const signal = run.signal;
  if (!signal) {
    return {
      mark: run.stage === 'expired' ? 'fail' : 'wait',
      headline: run.stage === 'expired' ? (run.note ?? 'The challenge expired.') : 'Waiting for the model’s reply.',
      count: null,
      closest: null,
    };
  }

  const count = `${signal.received} of ${signal.asked} integers received`;
  const closest = signal.candidates[0] ?? null;
  switch (signal.result) {
    case 'match':
      return { mark: 'pass', headline: signal.note, count, closest };
    case 'recorded':
      return { mark: 'ask', headline: signal.note, count, closest };
    case 'insufficient':
    case 'invalid':
      // Not scored. While the challenge is open another reply may still arrive.
      return { mark: run.stage === 'awaiting_reply' ? 'wait' : 'fail', headline: `Not scored. ${signal.note}`, count, closest };
    case 'other_model':
    case 'unknown':
    case 'no_reference':
      return { mark: 'fail', headline: signal.note, count, closest };
    default: {
      const unreachable: never = signal.result;
      throw new Error(`no model line for ${String(unreachable)}`);
    }
  }
}

/* ---------- Layer 2: the certificate's two rows ---------- */

export interface CertificateFact {
  readonly label: string;
  readonly value: string;
  /** A public page to open, for the facts that have one. */
  readonly href?: string;
}

export interface CertificateRow {
  readonly mark: Mark;
  /** Reads "… verified" only when the server recorded it as verified. */
  readonly title: string;
  readonly detail: string | null;
  readonly facts: readonly CertificateFact[];
}

function chainFacts(enrollment: EnrollmentView): CertificateFact[] {
  if (!enrollment.configured) return [];
  return [
    { label: 'Testnet', value: `${enrollment.network ?? '—'}${enrollment.chainId === null ? '' : ` · chain ${enrollment.chainId}`}` },
    { label: 'Registry contract', value: enrollment.registry ?? '—' },
    {
      label: 'Agent ID',
      value: enrollment.agentId ?? '—',
      ...(enrollment.explorerUrl ? { href: enrollment.explorerUrl } : {}),
    },
    ...(enrollment.owner ? [{ label: 'Owner', value: enrollment.owner }] : []),
    ...(enrollment.blockNumber === null
      ? []
      : [{ label: 'Checked at', value: `block ${enrollment.blockNumber} · ${clock(enrollment.checkedAt)}` }]),
  ];
}

/** Local identity mode: the certificate names the key, not a chain registration. */
function localKeyRow(enrollment: EnrollmentView): CertificateRow {
  const print = enrollment.keyPrint ?? '—';
  const facts: CertificateFact[] =
    enrollment.keyPrint === null
      ? []
      : [
          { label: 'Key', value: `Ed25519 · ${print}` },
          { label: 'Agent', value: enrollment.registryId },
        ];
  switch (enrollment.status) {
    case 'local':
    case 'verified':
      return enrollment.active
        ? {
            mark: 'pass',
            title: localKeyLine(enrollment),
            detail: 'The server holds this public key and checks request signatures against it.',
            facts,
          }
        : { mark: 'fail', title: 'Local key not in use', detail: 'The registry is not using the enrolled key. Enroll again.', facts };
    case 'failed':
      return { mark: 'fail', title: 'Local key not enrolled', detail: enrollment.note, facts };
    case 'unresolved':
      return { mark: 'ask', title: 'Local key not confirmed', detail: enrollment.note, facts };
    case 'none':
      return { mark: 'wait', title: 'Local key not enrolled', detail: enrollment.note ?? 'The agent is not enrolled yet.', facts: [] };
    default: {
      const unreachable: never = enrollment.status;
      throw new Error(`no local key row for ${String(unreachable)}`);
    }
  }
}

/** The agent's identity proof: the enrolled Ed25519 key, or its ERC-8004 registration. */
export function registrationRow(enrollment: EnrollmentView): CertificateRow {
  if (enrollment.identityMode === 'local') return localKeyRow(enrollment);
  const facts = chainFacts(enrollment);

  switch (enrollment.status) {
    case 'verified':
      return enrollment.active
        ? {
            mark: 'pass',
            title: 'ERC-8004 registration verified',
            detail:
              enrollment.keyBinding === 'matches'
                ? 'Owned by the expected team wallet, and the registration names this signing key.'
                : enrollment.note ?? 'Owned by the expected team wallet.',
            facts,
          }
        : { mark: 'fail', title: 'ERC-8004 registration not in use', detail: 'The registry is not using the enrolled key.', facts };
    case 'local':
      return {
        mark: 'off',
        title: 'ERC-8004 registration not configured',
        detail: 'The signer’s key is enrolled on this server only. No on-chain registration was checked.',
        facts,
      };
    case 'failed':
      return { mark: 'fail', title: 'ERC-8004 registration failed', detail: enrollment.note, facts };
    case 'unresolved':
      return { mark: 'ask', title: 'ERC-8004 registration unresolved', detail: enrollment.note, facts };
    case 'none':
      return { mark: 'wait', title: 'ERC-8004 registration not checked', detail: enrollment.note ?? 'The agent is not enrolled yet.', facts };
    default: {
      const unreachable: never = enrollment.status;
      throw new Error(`no registration row for ${String(unreachable)}`);
    }
  }
}

/** Whether the request's signature verified against the enrolled key. */
export function signatureRow(run: LiveRunView, enrollment: EnrollmentView): CertificateRow {
  const facts: CertificateFact[] = [
    { label: 'Registered key', value: `${enrollment.registryId}${enrollment.keyPrint ? ` · ${enrollment.keyPrint}` : ''}` },
    ...(run.nonce ? [{ label: 'One-time nonce', value: run.nonce }] : []),
    ...(run.requestId ? [{ label: 'Request', value: `${run.requestId} · quote ${run.quote.reference}` }] : []),
  ];

  switch (run.signature) {
    case 'passed':
      return { mark: 'pass', title: 'Request signature verified', detail: run.signatureNote, facts };
    case 'failed':
      // With a request on record the gate looked at a signature and refused it.
      // Without one the run stopped before anything was signed — and when that
      // is because the enrollment is not in place, the row above already says why.
      if (run.requestId !== null) {
        return { mark: 'fail', title: 'Request signature not accepted', detail: run.signatureNote, facts };
      }
      return {
        mark: 'fail',
        title: 'Request not signed',
        detail: enrollment.active ? run.signatureNote : 'No signature was asked for: the agent’s enrollment is not in place.',
        facts,
      };
    case 'pending':
      return run.stage === 'awaiting_signature'
        ? {
            mark: 'wait',
            title: 'Signing challenge issued',
            detail: `Waiting for the agent’s signature. The challenge expires at ${clock(run.signExpiresAt)}.`,
            facts,
          }
        : { mark: 'wait', title: 'Request signature', detail: 'Asked for once the model signal passes.', facts: [] };
    case 'ask':
    case 'skipped':
      return { mark: 'off', title: 'Request signature not checked', detail: 'The run stopped before a signature was asked for.', facts: [] };
    default: {
      const unreachable: never = run.signature;
      throw new Error(`no signature row for ${String(unreachable)}`);
    }
  }
}

/* ---------- Layer 3: one line ---------- */

export interface AuthorizationLine {
  readonly mark: Mark;
  readonly line: string;
}

/**
 * The budget sentence, only when this amount would pass the cap.
 * Other refusals keep their own reason and do not borrow this line.
 */
export function budgetRefusal(grant: GrantView, amount: Cents): string | null {
  if (amount <= grant.left) return null;
  return `would exceed budget: ${fmtMoney(addCents(grant.spent, grant.reserved))} spent, ${fmtMoney(grant.left)} left`;
}

export function authorizationOf(run: LiveRunView): AuthorizationLine {
  switch (run.authorization) {
    case 'passed':
      return { mark: 'pass', line: run.authorizationLine ?? 'Buyer authorization passed' };
    case 'failed':
      return { mark: 'fail', line: run.authorizationLine ?? 'Buyer authorization failed' };
    case 'ask':
      return { mark: 'ask', line: run.authorizationLine ?? 'Buyer authorization needed' };
    case 'pending':
      return { mark: 'wait', line: 'Buyer authorization · checked once the request is verified' };
    case 'skipped':
      return { mark: 'off', line: 'Buyer authorization · not checked' };
    default: {
      const unreachable: never = run.authorization;
      throw new Error(`no authorization line for ${String(unreachable)}`);
    }
  }
}

/* ---------- The receipt ---------- */

export interface LiveReceipt {
  /** `PayPal Sandbox`, or what stood in for it. */
  readonly provider: string;
  /** PayPal's own word for the outcome. COMPLETED only for a confirmed live capture. */
  readonly status: string;
  readonly tone: 'ok' | 'error' | 'pending' | 'sim';
  readonly amount: string;
  readonly orderId: string | null;
  readonly captureId: string | null;
  /** What the confirmed purchase leaves of the authorized budget. */
  readonly budgetLine: string | null;
  readonly note: string | null;
  /** REAL for an answer from PayPal Sandbox, SIM for one recorded here. */
  readonly tag: 'real' | 'sim';
}

/** The receipt, once the request was sent to PayPal — or recorded in its place. Null before that. */
export function receiptOf(run: LiveRunView, grant: GrantView | null): LiveReceipt | null {
  const paypal = run.paypal;
  if (!paypal || paypal.outcome === 'not_called') return null;

  const base = {
    amount: fmtUsd(paypal.amount),
    orderId: paypal.orderId,
    captureId: paypal.captureId,
    budgetLine: null,
    note: paypal.note,
  };
  const live = paypal.mode === 'live';
  const left = grant ? `${fmtUsd(grant.left)} of ${fmtUsd(grant.budget)} authorized budget left` : null;

  switch (paypal.outcome) {
    case 'captured':
      return live
        ? { ...base, provider: 'PayPal Sandbox', status: 'COMPLETED', tone: 'ok', budgetLine: left, note: null, tag: 'real' }
        : { ...base, provider: 'No PayPal call', status: 'SIMULATED', tone: 'sim', budgetLine: left, tag: 'sim' };
    case 'simulated':
      return { ...base, provider: 'No PayPal call', status: 'SIMULATED', tone: 'sim', budgetLine: left, tag: 'sim' };
    case 'calling':
      return { ...base, provider: 'PayPal Sandbox', status: 'PENDING', tone: 'pending', tag: 'real' };
    case 'unknown':
      return {
        ...base,
        provider: 'PayPal Sandbox',
        status: 'NOT CONFIRMED',
        tone: 'pending',
        note: 'PayPal has not confirmed this charge. The budget stays held until it is reconciled.',
        tag: 'real',
      };
    case 'needs_buyer':
      return { ...base, provider: 'PayPal Sandbox', status: 'BUYER ACTION REQUIRED', tone: 'error', tag: 'real' };
    case 'refused':
      return { ...base, provider: 'PayPal Sandbox', status: 'FAILED', tone: 'error', tag: 'real' };
    default: {
      const unreachable: never = paypal.outcome;
      throw new Error(`no receipt for ${String(unreachable)}`);
    }
  }
}
