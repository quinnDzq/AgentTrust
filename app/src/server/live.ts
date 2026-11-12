/**
 * The live flow: one run from a chat instruction to a PayPal Sandbox receipt.
 *
 * An agent platform drives this through the connector's four tools, and each
 * tool is one method here:
 *
 *   begin          resolve a quote from the catalog, start a run, issue the
 *                  numeric challenge                              (Layer 1 asks)
 *   submitReply    read the model's integers and score them against the
 *                  reference bank; on a match, issue a one-time signing
 *                  challenge for the same run and quote         (Layer 1 answers)
 *   signAndSubmit  have the signer service sign that challenge, and hand the
 *                  signed envelope to the gate                  (Layers 2 and 3)
 *   status         where the run is, and the receipt once PayPal confirms
 *
 * One run id correlates all of it: the chat's calls, the verification page and
 * the payment attempt read the same row.
 *
 * **Nothing here rules on a payment.** This file decides which *challenge* a
 * run is offered next. Whether money moves is still `gate()`'s answer to a
 * signed envelope, reached through `Engine.submitSigned` exactly as a board
 * request reaches it: the enrolled key's signature, the nonce, the buyer's
 * grant and the budget. The model signal never gets there — `GateContext` has
 * no field for it.
 *
 * Calling a tool twice is safe. A second `begin` for the same quote returns the
 * run already open, or the receipt already issued. A repeated reply returns the
 * recorded result. A repeated `signAndSubmit` returns the same payment attempt:
 * a challenge is signed and submitted at most once.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  addCents,
  cents,
  fmtMoney,
  fmtUsd,
  isFinalLiveStage,
  usd,
  type Cents,
  type CheckId,
  type ConnectorView,
  type EnrollmentStatus,
  type EnrollmentView,
  type IdentityMode,
  type GrantView,
  type KeyBinding,
  type LiveRunView,
  type Mandate,
  type PayPalView,
  type Verdict,
} from '../types.ts';
import { parseBudget } from './budget.ts';
import { identityProofBytes } from '../canon.ts';
import { fingerprint, newNonce, signMandate, verify } from './crypto.ts';
import { REPLACED_BUDGET_REQUEST, type BudgetRequestFacts } from './engine.ts';
import type { EnrollmentRow, LiveRunRow, Store } from './db.ts';
import { DECK, DECK_QUOTES, type Quote } from './deck.ts';
import type { Engine } from './engine.ts';
import type { Erc8004Config, RegistrationRead } from './erc8004.ts';
import { assess, MAX_REPLY_CHARS, PROBE, PROBE_PROMPT, recordedView } from './fingerprint.ts';
import type { Keyring } from './keys.ts';
import type { ReferenceStore } from './reference.ts';
import { CHALLENGE_KIND, PROOF_KIND, SignerUnavailable, type SignerClient, type SigningChallenge } from './signer.ts';

/** How long the model has to answer the numeric challenge. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1_000;

/** How long a signing challenge stays open. Short, because a signature over it is good until then. */
export const SIGN_TTL_MS = 5 * 60 * 1_000;

/** Replies that could not be read as a batch before a run gives up on Layer 1. */
export const MAX_UNREAD_REPLIES = 3;

/** How long `signAndSubmit` waits for PayPal before answering "pending". */
const SETTLE_WAIT_MS = 12_000;

/** What a tool call came to: words for the chat, and the same facts as data. */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly data: { readonly [key: string]: unknown };
}

export interface BeginInput {
  readonly reference?: string | undefined;
  readonly merchant?: string | undefined;
  readonly item?: string | undefined;
  /** The price being looked for, in US dollars. */
  readonly amount?: number | undefined;
  /**
   * The buyer's spending cap for this run, in major units of `currency`.
   * Set when the user says their budget. Omitted, the grant's current cap stays.
   */
  readonly budget?: number | undefined;
  /** Currency of `budget`. Defaults to USD. Only USD is accepted. */
  readonly currency?: string | undefined;
}

export interface LiveOptions {
  readonly store: Store;
  readonly engine: Engine;
  readonly keyring: Keyring;
  /** The signer service, or null when this server has none to ask. */
  readonly signer: SignerClient | null;
  /** The ERC-8004 registration to check at enrollment, or null when none is configured. */
  readonly erc8004: Erc8004Config | null;
  /**
   * Which proof counts as enrollment. `local` (the default) is the signer's
   * Ed25519 key alone. `erc8004` requires the on-chain registration.
   * The request signature is checked the same way in both.
   */
  readonly identityMode?: IdentityMode;
  readonly readRegistration: (config: Erc8004Config) => Promise<RegistrationRead>;
  readonly reference: ReferenceStore;
  /** Where the connector listens, for the page, or null when it is not being served. Never the token. */
  readonly endpoint?: string | null;
  /** Calibration mode: record every readable reply under this label instead of scoring it. */
  readonly calibrateAs?: string | null;
  readonly now?: () => number;
  readonly settleWaitMs?: number;
  /**
   * Origin of the verify page, with no path and no trailing slash.
   * Budget-change requests point the buyer here. Default `http://localhost:8787`.
   */
  readonly verifyBase?: string | null;
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

const iso = (ms: number): string => new Date(ms).toISOString();

/** PayPal's side of a run, as one word a receipt can carry. */
function paymentStatus(paypal: PayPalView | null): string {
  if (!paypal) return 'NOT_CALLED';
  switch (paypal.outcome) {
    case 'not_called':
      return 'NOT_CALLED';
    case 'calling':
      return 'PENDING';
    case 'captured':
      // COMPLETED is PayPal's word for a confirmed capture, so only a live one may carry it.
      return paypal.mode === 'live' ? 'COMPLETED' : 'SIMULATED';
    case 'simulated':
      return 'SIMULATED';
    case 'needs_buyer':
      return 'BUYER_ACTION_REQUIRED';
    case 'refused':
      return 'FAILED';
    case 'unknown':
      return 'UNCONFIRMED';
    default: {
      const unreachable: never = paypal.outcome;
      throw new Error(`no payment status for ${String(unreachable)}`);
    }
  }
}

/**
 * What the agent must relay when a purchase is waiting on the buyer.
 *
 * Null once the run is not asking. PayPal has not been called, and the same
 * run id is how the agent hears the decision.
 */
function buyerMessage(view: LiveRunView, grant: GrantView | null): string | null {
  if (view.stage !== 'needs_buyer') return null;
  const line = view.authorizationLine ?? 'This purchase needs the buyer.';
  const spent = grant ? fmtMoney(addCents(grant.spent, grant.reserved)) : 'unknown';
  const left = grant ? fmtMoney(grant.left) : 'unknown';
  const budget = grant ? fmtMoney(grant.budget) : 'unknown';
  const threshold = grant ? `${grant.askThresholdPct}%` : 'the ask threshold';
  return (
    `${line} ${spent} spent, ${left} left of ${budget}. The ask threshold is ${threshold} of the approved budget. ` +
    'Stop and tell the user these figures, and that the buyer must approve or decline this purchase on the AgentTrust verify page. ' +
    `PayPal was not called. Do not start a new run. After the buyer decides, call get_purchase_status with run_id ${view.runId}.`
  );
}

export class LiveVerifier {
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly keyring: Keyring;
  private readonly signer: SignerClient | null;
  private readonly erc8004: Erc8004Config | null;
  private readonly identityMode: IdentityMode;
  private readonly readRegistration: (config: Erc8004Config) => Promise<RegistrationRead>;
  private readonly reference: ReferenceStore;
  private endpoint: string | null;
  private readonly calibrateAs: string | null;
  private readonly now: () => number;
  private readonly settleWaitMs: number;
  private readonly verifyBase: string;

  /** `signAndSubmit` calls still waiting on the signer, by run: a second call joins the first. */
  private readonly signing = new Map<string, Promise<ToolOutcome>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCall: { readonly at: number; readonly tool: string } | null = null;
  private signerState: { readonly state: ConnectorView['signer']; readonly note: string | null } = {
    state: 'not_checked',
    note: null,
  };

  constructor(options: LiveOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.keyring = options.keyring;
    this.signer = options.signer;
    this.erc8004 = options.erc8004;
    this.identityMode = options.identityMode ?? 'local';
    this.store.setIdentityMode(this.identityMode);
    this.readRegistration = options.readRegistration;
    this.reference = options.reference;
    this.endpoint = options.endpoint ?? null;
    this.calibrateAs = options.calibrateAs?.trim() || null;
    this.now = options.now ?? Date.now;
    this.settleWaitMs = options.settleWaitMs ?? SETTLE_WAIT_MS;
    this.verifyBase = (options.verifyBase ?? 'http://localhost:8787').replace(/\/+$/, '');

    if (!this.signer) this.signerState = { state: 'not_checked', note: 'No signer service is configured.' };
  }

  /* ---------- lifecycle ---------- */

  /**
   * Bring the stored enrollment and the registry into line, and start closing
   * challenges as they lapse. Called when the server starts and after every
   * demo reset, which re-seeds the registry with the scripted practice key.
   */
  start(): void {
    this.syncEnrollment();
    this.publish();
    void this.probeSigner();
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.store.expireLiveRuns(this.now());
      } catch (err) {
        console.error('[live] expiry sweep failed:', err);
      }
    }, 2_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether the signer answers right now. What the page shows; nothing is decided by it. */
  private async probeSigner(): Promise<void> {
    if (!this.signer) return;
    try {
      await this.signer.identity();
      this.signerState = { state: 'reachable', note: null };
    } catch (err) {
      this.signerState = {
        state: 'unreachable',
        note: err instanceof SignerUnavailable ? err.message : 'The signer service did not answer.',
      };
    }
    this.publish();
  }

  /* ---------- the connector's own state ---------- */

  /** The connector started listening, or stopped. Without one there is no connector state to show. */
  serving(endpoint: string | null): void {
    this.endpoint = endpoint;
    this.publish();
  }

  private publish(): void {
    if (this.endpoint === null) {
      this.store.setConnector(null);
      return;
    }
    const reference = this.reference.status();
    this.store.setConnector({
      endpoint: this.endpoint,
      lastCallAt: this.lastCall?.at ?? null,
      lastTool: this.lastCall?.tool ?? null,
      signer: this.signerState.state,
      signerNote: this.signerState.note,
      expectedModel: reference.expected,
      referenceSamples: reference.samples,
      referenceNeeded: reference.needed,
      calibrated: reference.calibrated,
      calibratingAs: this.calibrateAs,
    });
  }

  /** A connector client called a tool. What the page shows as "last heard from". */
  heard(tool: string): void {
    this.lastCall = { at: this.now(), tool };
    this.publish();
  }

  private log(text: string, verdict: Verdict, check: CheckId): void {
    this.engine.note(text, verdict, check);
  }

  /* ---------- enrollment: the signer's key, and its ERC-8004 registration ---------- */

  private enrollmentRow(): EnrollmentRow {
    return (
      this.store.enrollment(DECK.registryId) ?? {
        registry_id: DECK.registryId,
        pubkey: null,
        status: 'none',
        identity_mode: this.identityMode,
        network: null,
        chain_id: null,
        registry: null,
        agent_id: null,
        owner: null,
        expected_owner: null,
        key_binding: null,
        block_number: null,
        checked_at: null,
        explorer_url: null,
        note: null,
      }
    );
  }

  /** The key this process can sign the agent's practice requests with. */
  private scriptedKey(): string | null {
    return this.keyring.counterparties.find((c) => c.registryId === DECK.registryId)?.agentKey.publicKey ?? null;
  }

  /**
   * Make the registry agree with the stored enrollment.
   *
   * An enrollment that is `verified` or `local` puts the signer's key in the
   * registry. Anything else takes it out again, back to the scripted practice
   * key, so the registry never keeps a key whose enrollment no longer stands.
   * The buyer's revocation is left exactly as it is.
   */
  private applyToRegistry(row: EnrollmentRow): void {
    const entry = this.store.registryEntry(DECK.registryId);
    if (!entry) return;

    const enrolled = (row.status === 'verified' || row.status === 'local') && row.pubkey !== null;
    if (enrolled && row.pubkey !== null) {
      if (entry.key !== row.pubkey) this.store.setRegistryKey(DECK.registryId, row.pubkey);
      return;
    }
    const scripted = this.scriptedKey();
    if (scripted !== null && row.pubkey !== null && entry.key === row.pubkey && entry.key !== scripted) {
      this.store.setRegistryKey(DECK.registryId, scripted);
    }
  }

  /**
   * Which identity mode a stored row was made under.
   * A row from before the column existed is inferred: chain fields mean erc8004.
   */
  private rowMode(stored: EnrollmentRow): IdentityMode {
    if (stored.identity_mode === 'local' || stored.identity_mode === 'erc8004') return stored.identity_mode;
    return stored.registry && stored.agent_id ? 'erc8004' : 'local';
  }

  /** The registration to consult. Local mode never does, even when one is configured. */
  private chainConfig(): Erc8004Config | null {
    return this.identityMode === 'erc8004' ? this.erc8004 : null;
  }

  /**
   * Startup and reset: an enrollment is about one identity mode, and in erc8004
   * mode about one registration. When either changes, an enrollment made under
   * the old one no longer says anything and has to be done again.
   */
  private syncEnrollment(): void {
    if (!this.store.deckGrant()) return;
    const stored = this.store.enrollment(DECK.registryId);
    const config = this.chainConfig();

    const sameConfig =
      stored !== null &&
      this.rowMode(stored) === this.identityMode &&
      (stored.registry ?? null) === (config?.registry ?? null) &&
      (stored.agent_id ?? null) === (config?.agentId ?? null) &&
      (stored.chain_id ?? null) === (config?.chainId ?? null) &&
      (stored.expected_owner ?? null) === (config?.expectedOwner ?? null);

    if (stored && sameConfig) {
      this.applyToRegistry(stored);
      return;
    }
    if (!stored && !config) return;

    const wasEnrolled = stored !== null && stored.status !== 'none';
    const modeChanged = stored !== null && this.rowMode(stored) !== this.identityMode;
    const next = this.blankRow(
      stored?.pubkey ?? null,
      wasEnrolled
        ? modeChanged
          ? 'The identity check changed. Enroll again.'
          : 'The ERC-8004 configuration changed. Enroll again.'
        : null,
    );
    this.store.putEnrollment(next);
    this.applyToRegistry(next);
  }

  /** An enrollment not yet made, carrying what would be checked. */
  private blankRow(pubkey: string | null, note: string | null): EnrollmentRow {
    const config = this.chainConfig();
    return {
      registry_id: DECK.registryId,
      pubkey,
      status: 'none',
      identity_mode: this.identityMode,
      network: config?.network ?? null,
      chain_id: config?.chainId ?? null,
      registry: config?.registry ?? null,
      agent_id: config?.agentId ?? null,
      owner: null,
      expected_owner: config?.expectedOwner ?? null,
      key_binding: null,
      block_number: null,
      checked_at: null,
      explorer_url: config?.explorerUrl ?? null,
      note,
    };
  }

  /**
   * Enroll the Demo Agent, or refresh its enrollment.
   *
   * Always reads the signer's public key. What happens next depends on the
   * identity mode. In `local` mode that key is the whole proof: the server
   * holds it and later checks request signatures against it. In `erc8004` mode
   * the chain is read too — the chain id, the block, and who owns the
   * registration. Only an owner that is the expected wallet makes it
   * `verified`. A chain that answers with anything else is `failed`, with what
   * it actually said; one that cannot be read is `unresolved`. Neither puts
   * the signer's key in the registry.
   *
   * A refresh that cannot reach the chain leaves an earlier verified check
   * standing — it is still what the chain said at that block — and notes that
   * the refresh failed. The payment-time check never reads the chain: it runs
   * on this local record. The request signature is checked the same way in
   * both modes.
   */
  async enroll(): Promise<{ readonly ok: boolean; readonly message: string }> {
    if (!this.store.deckGrant()) return { ok: false, message: 'There is no deck in this scene.' };
    const before = this.enrollmentRow();

    const settle = (row: EnrollmentRow, ok: boolean, message: string): { ok: boolean; message: string } => {
      this.store.putEnrollment(row);
      this.applyToRegistry(row);
      this.log(`${DECK.agentName} enrollment: ${message}`, ok ? 'ALLOW' : 'DENY', 'ENROLLMENT');
      this.publish();
      return { ok, message };
    };
    const blank = (status: EnrollmentStatus, pubkey: string | null, note: string): EnrollmentRow => ({
      ...this.blankRow(pubkey, note),
      status,
    });

    if (!this.signer) {
      return settle(blank('unresolved', before.pubkey, 'No signer service is configured on this server.'), false, 'No signer service is configured on this server.');
    }

    let identity: { registryId: string; publicKey: string };
    try {
      identity = await this.signer.identity();
      this.signerState = { state: 'reachable', note: null };
    } catch (err) {
      const why = err instanceof SignerUnavailable ? err.message : 'The signer service did not answer.';
      this.signerState = { state: 'unreachable', note: why };
      // An enrollment already standing is not undone by a signer that is briefly away.
      if (before.status === 'verified' || before.status === 'local') {
        this.publish();
        return { ok: false, message: `${why} The earlier enrollment stands.` };
      }
      return settle(blank('unresolved', before.pubkey, why), false, why);
    }

    if (identity.registryId !== DECK.registryId) {
      const why = `The signer service is ${identity.registryId}, not ${DECK.registryId}.`;
      return settle(blank('failed', identity.publicKey, why), false, why);
    }

    if (this.identityMode === 'local') {
      const print = fingerprint(identity.publicKey);
      return settle(
        { ...this.blankRow(identity.publicKey, null), status: 'local', checked_at: this.now() },
        true,
        `Local key enrolled (Ed25519, fingerprint ${print}).`,
      );
    }

    const config = this.erc8004;
    if (!config) {
      return settle(
        { ...this.blankRow(identity.publicKey, null), status: 'local', checked_at: this.now() },
        true,
        'Signer key enrolled locally. No ERC-8004 registration is configured to check.',
      );
    }

    const read = await this.readRegistration(config);
    const checkedAt = this.now();

    switch (read.kind) {
      case 'unreachable': {
        const why = `Could not read ${config.network}: ${read.reason}`;
        const standing =
          before.status === 'verified' && before.pubkey === identity.publicKey && before.agent_id === config.agentId;
        if (standing) {
          this.store.putEnrollment({
            ...before,
            note: `Refresh failed at ${iso(checkedAt)}: ${read.reason} Showing the check from block ${before.block_number ?? '?'}.`,
          });
          this.publish();
          return { ok: false, message: `${why} The earlier verified check stands.` };
        }
        return settle(blank('unresolved', identity.publicKey, why), false, why);
      }

      case 'wrong_chain': {
        const why = `The RPC endpoint is chain ${read.chainId}, not ${config.network} (${config.chainId}).`;
        return settle(blank('failed', identity.publicKey, why), false, why);
      }

      case 'absent': {
        const why = `Agent ${config.agentId} is not registered in ${shortAddress(config.registry)} on ${config.network}: ${read.reason}`;
        return settle(
          { ...blank('failed', identity.publicKey, why), block_number: read.blockNumber, checked_at: checkedAt },
          false,
          why,
        );
      }

      case 'found': {
        const binding: KeyBinding =
          read.statedKey === undefined
            ? 'unreadable'
            : read.statedKey === null
              ? 'not_stated'
              : read.statedKey === identity.publicKey
                ? 'matches'
                : 'differs';
        const facts: EnrollmentRow = {
          ...this.blankRow(identity.publicKey, null),
          owner: read.owner,
          key_binding: binding,
          block_number: read.blockNumber,
          checked_at: checkedAt,
        };

        if (!sameAddress(read.owner, config.expectedOwner)) {
          const why = `Registration owner is ${read.owner}; expected the team wallet ${config.expectedOwner}.`;
          return settle({ ...facts, status: 'failed', note: why }, false, why);
        }
        if (binding === 'differs') {
          const why = 'The registration names a different signing key than the signer service holds.';
          return settle({ ...facts, status: 'failed', note: why }, false, why);
        }
        return settle(
          { ...facts, status: 'verified' },
          true,
          `ERC-8004 registration verified on ${config.network}: agent ${config.agentId}, owner ${shortAddress(read.owner)}, block ${read.blockNumber}.`,
        );
      }

      default: {
        const unreachable: never = read;
        throw new Error(`unhandled registration read ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /* ---------- reading the world ---------- */

  private sweep(): void {
    this.store.expireLiveRuns(this.now());
  }

  private runOf(runId: string): LiveRunRow | null {
    const run = this.store.liveRun(runId);
    // A run from a night that was reset is not this night's.
    return run && run.deck_run_id === this.store.deckGrant()?.run_id ? run : null;
  }

  private viewOf(run: LiveRunRow): LiveRunView {
    const view = this.store.liveView(run);
    if (!view) throw new Error(`run ${run.run_id} has no view`);
    return view;
  }

  /** The buyer's grant to the enrolled key: what the agent presents with every request. Local prototype. */
  private grantFor(agentKey: string): Mandate | null {
    const buyer = this.keyring.counterparties.find((c) => c.principal === DECK.principal);
    if (!buyer) return null;
    const cap = this.store.grantView()?.budget ?? cents(this.store.deckGrant()?.budget ?? DECK.budget);
    return signMandate(
      {
        principal: DECK.principal,
        agentKey,
        scope: 'stock_images',
        maxPerPayment: cap,
        expiresDay: DECK.day,
      },
      buyer.principalKey.secret,
    );
  }

  /** Where the buyer approves a budget change. The agent is told this and cannot approve it. */
  private verifyPage(): string {
    return `${this.verifyBase}/verify/paypal/`;
  }

  private budgetRequestData(request: BudgetRequestFacts): { readonly [key: string]: unknown } {
    const url = this.verifyPage();
    return {
      request_id: request.requestId,
      status: request.status,
      current_budget: fmtUsd(request.current),
      requested_budget: fmtUsd(request.requested),
      resulting_budget: fmtUsd(request.resulting),
      reason: request.reason,
      note: request.note,
      needs_buyer_approval: request.status === 'pending',
      approval_url: url,
      message_for_user: this.budgetRequestMessage(request, url),
    };
  }

  /**
   * Have the signer sign a fresh nonce and check it against the enrolled key.
   *
   * This is not a purchase. Nothing is submitted to the gate and PayPal is not called.
   */
  async proveIdentity(): Promise<
    | {
        readonly ok: true;
        readonly nonce: string;
        readonly signature: string;
        readonly verified: boolean;
        readonly result: 'verified' | 'not verified';
        readonly publicKey: string;
        readonly fingerprint: string;
      }
    | { readonly ok: false; readonly message: string }
  > {
    if (!this.signer) return { ok: false, message: 'No signer service is configured on this server.' };
    const row = this.store.enrollment(DECK.registryId);
    const enrolled = row?.pubkey;
    if (!enrolled || (row.status !== 'local' && row.status !== 'verified')) {
      return { ok: false, message: 'Enroll the agent before asking it to prove the key.' };
    }

    const nonce = newNonce();
    const expiresAtMs = this.now() + 60_000;
    let signed;
    try {
      signed = await this.signer.prove({ kind: PROOF_KIND, nonce, registryId: DECK.registryId, expiresAtMs });
      this.signerState = { state: 'reachable', note: null };
    } catch (err) {
      const why = err instanceof SignerUnavailable ? err.message : 'The signer service did not answer.';
      this.signerState = { state: 'unreachable', note: why };
      this.publish();
      return { ok: false, message: why };
    }
    this.publish();
    if (!signed.ok) return { ok: false, message: signed.error };

    const bytes = identityProofBytes({ nonce, registryId: DECK.registryId, expiresAtMs });
    const verified = signed.publicKey === enrolled && verify(enrolled, bytes, signed.signature);
    return {
      ok: true,
      nonce,
      signature: signed.signature,
      verified,
      result: verified ? 'verified' : 'not verified',
      publicKey: enrolled,
      fingerprint: fingerprint(enrolled),
    };
  }

  private budgetRequestMessage(request: BudgetRequestFacts, url: string): string {
    if (request.status === 'pending') {
      return (
        `The agent asked to change the budget from ${fmtUsd(request.current)} to ${fmtUsd(request.requested)}. ` +
        `Reason: ${request.reason}. Stop and tell the user. The buyer must approve or decline on the AgentTrust verify page: ${url}. ` +
        `The budget is unchanged until they do. Do not approve it yourself. There is no tool for that. ` +
        `After they decide, call get_budget_request_status with request_id ${request.requestId}.`
      );
    }
    if (request.status === 'approved') {
      return `The buyer approved the budget change. The budget is now ${fmtUsd(request.resulting)}.`;
    }
    if (request.note === REPLACED_BUDGET_REQUEST) {
      return `This budget request was replaced by a newer one. It did not change the budget, which is ${fmtUsd(request.resulting)}.`;
    }
    return `The buyer declined this budget change. The budget stays ${fmtUsd(request.resulting)}.`;
  }

  /**
   * Ask the buyer to change the approved budget. The grant is not changed here.
   */
  requestBudgetChange(amountUsd: number, reason: string): ToolOutcome {
    const parsed = parseBudget(amountUsd, 'USD', 'budget');
    if (!parsed.ok) return this.refusal(parsed.message);
    const outcome = this.engine.requestBudgetChange(parsed.cents, reason);
    if (!outcome.ok || !outcome.request) return this.refusal(outcome.message);
    const data = this.budgetRequestData(outcome.request);
    return { ok: true, text: String(data.message_for_user), data };
  }

  /** Read one budget-change request. Does not decide it. */
  budgetRequestStatus(requestId: string): ToolOutcome {
    const outcome = this.engine.budgetRequestStatus(requestId);
    if (!outcome.ok || !outcome.request) return this.refusal(outcome.message);
    const data = this.budgetRequestData(outcome.request);
    return { ok: true, text: String(data.message_for_user), data };
  }

  /* ---------- words and data for a run ---------- */

  private describe(view: LiveRunView): { readonly data: { readonly [key: string]: unknown }; readonly lines: string[] } {
    const grant = this.store.grantView();
    const enrollment = this.store.enrollmentView();
    const quote = `${view.quote.item} (${view.quote.reference}) from ${view.quote.merchant}`;
    const payment = paymentStatus(view.paypal);
    const signal = view.signal;

    const messageForUser = buyerMessage(view, grant);
    const data = {
      run_id: view.runId,
      stage: view.stage,
      final: isFinalLiveStage(view.stage),
      needs_buyer_approval: messageForUser !== null,
      message_for_user: messageForUser,
      quote: {
        merchant: view.quote.merchant,
        item: view.quote.item,
        reference: view.quote.reference,
        amount: fmtUsd(view.quote.amount),
      },
      layer1_model_signal: signal
        ? {
            result: signal.result,
            received: signal.received,
            asked: signal.asked,
            closest_reference: signal.closest,
            similarity: signal.score,
            threshold: signal.threshold,
            expected_model: signal.expectedModel,
            note: signal.note,
          }
        : null,
      layer2_identity: {
        identity: enrollment ? this.enrollmentWords(enrollment) : 'not available',
        // Null in local mode: the key is the proof, and a missing registration is not reported.
        erc8004_registration:
          this.identityMode === 'erc8004' ? (enrollment ? this.enrollmentWords(enrollment) : 'not available') : null,
        network: this.identityMode === 'erc8004' ? (enrollment?.network ?? null) : null,
        registry_contract: this.identityMode === 'erc8004' ? (enrollment?.registry ?? null) : null,
        agent_id: this.identityMode === 'erc8004' ? (enrollment?.agentId ?? null) : null,
        request_signature: view.signature,
        note: view.signatureNote,
      },
      layer3_authorization: { result: view.authorization, line: view.authorizationLine },
      payment: {
        provider: view.paypal?.mode === 'simulated' ? 'Simulated (no PayPal credentials)' : 'PayPal Sandbox',
        status: payment,
        amount: fmtUsd(view.quote.amount),
        order_id: view.paypal?.orderId ?? null,
        capture_id: view.paypal?.captureId ?? null,
        request_id: view.requestId,
      },
      budget: grant
        ? {
            authorized: fmtUsd(grant.budget),
            left: fmtUsd(grant.left),
            ask_threshold_pct: grant.askThresholdPct,
          }
        : null,
    };

    const lines: string[] = [];
    switch (view.stage) {
      case 'paid':
        lines.push(
          `PayPal Sandbox · COMPLETED · ${fmtUsd(view.quote.amount)}`,
          `Order ID: ${view.paypal?.orderId ?? 'unknown'} · Capture ID: ${view.paypal?.captureId ?? 'unknown'}`,
          `${quote} · request ${view.requestId ?? ''}`,
        );
        break;
      case 'simulated':
        lines.push(
          `SIMULATED · ${fmtUsd(view.quote.amount)} · ${quote}`,
          'This server has no PayPal credentials: every check ran, but no PayPal call was made and nothing was charged. Do not report this as paid.',
        );
        break;
      case 'charging':
      case 'verifying':
        lines.push(
          `The ${fmtUsd(view.quote.amount)} charge for ${quote} is with PayPal.`,
          `Call get_purchase_status with run_id ${view.runId} until it reports a final status.`,
        );
        break;
      case 'payment_unconfirmed':
        lines.push(
          `PayPal has not confirmed the ${fmtUsd(view.quote.amount)} charge for ${quote}. It is not paid until PayPal says so.`,
          `The budget stays held. Call get_purchase_status with run_id ${view.runId} again later.`,
        );
        break;
      case 'payment_failed':
        lines.push(`Not paid. ${view.paypal?.note ?? 'PayPal did not complete the charge.'}`);
        break;
      case 'needs_buyer':
        lines.push(
          messageForUser ??
            `Not paid: ${view.authorizationLine ?? 'the request needs the buyer.'} PayPal was not called.`,
        );
        // Only when this amount would pass the cap. An owner ask for another
        // reason keeps that reason and does not borrow the budget sentence.
        if (grant && view.quote.amount > grant.left && !messageForUser?.includes('would exceed budget')) {
          lines.push(
            `would exceed budget: ${fmtMoney(addCents(grant.spent, grant.reserved))} spent, ${fmtMoney(grant.left)} left`,
          );
        }
        break;
      case 'authorization_failed':
        lines.push(`Refused at Layer 3: ${view.authorizationLine ?? 'the buyer’s grant does not cover this.'} PayPal was not called.`);
        break;
      case 'identity_failed':
        lines.push(`Refused at Layer 2: ${view.signatureNote ?? 'the request could not be attributed to the enrolled key.'} PayPal was not called.`);
        break;
      case 'awaiting_signature':
        lines.push(
          `Layer 1 passed. A one-time signing challenge is open for ${quote} until ${iso(view.signExpiresAt ?? 0)}.`,
          `Call sign_and_submit with run_id ${view.runId}.`,
        );
        break;
      case 'awaiting_reply':
        lines.push(
          `Run ${view.runId} is waiting for the numeric challenge reply for ${quote}, until ${iso(view.challengeExpiresAt)}.`,
          'Answer it yourself, by first instinct, without code, tools or a random-number generator:',
          view.prompt,
          'Then call submit_model_reply with this run_id and your integers as `reply`.',
        );
        break;
      case 'model_not_matched':
        lines.push(
          `The run stays at Layer 1: ${signal?.note ?? view.note ?? 'the reply did not match.'}`,
          'No signing challenge was issued and PayPal was not called.',
        );
        break;
      case 'expired':
        lines.push(`${view.note ?? 'The challenge expired.'} Nothing was charged. Start again with begin_verification.`);
        break;
      default: {
        const unreachable: never = view.stage;
        throw new Error(`no words for stage ${String(unreachable)}`);
      }
    }

    if (signal && view.stage !== 'model_not_matched' && view.stage !== 'awaiting_reply') {
      lines.push(`Layer 1 model signal: ${signal.note}`);
    }
    if (view.requestId) {
      const proof = enrollment ? this.enrollmentWords(enrollment) : 'not available';
      lines.push(
        this.identityMode === 'local'
          ? `Layer 2: ${proof} · request signature ${view.signature}.`
          : `Layer 2: ERC-8004 registration ${proof} · request signature ${view.signature}.`,
      );
      if (view.authorizationLine) lines.push(`Layer 3: ${view.authorizationLine}.`);
    }
    if ((view.stage === 'paid' || view.stage === 'simulated') && grant) {
      lines.push(`${fmtUsd(grant.left)} of the ${fmtUsd(grant.budget)} authorized budget is left.`);
    }

    return { data, lines };
  }

  private enrollmentWords(enrollment: EnrollmentView): string {
    switch (enrollment.status) {
      case 'verified':
        return `verified (${enrollment.network ?? 'testnet'}, agent ${enrollment.agentId ?? '?'}, block ${enrollment.blockNumber ?? '?'})`;
      case 'local':
        if (this.identityMode === 'local') {
          return enrollment.active
            ? `Local key enrolled (Ed25519, fingerprint ${enrollment.keyPrint ?? '—'})`
            : 'local key enrolled, but the registry is not using it';
        }
        return 'not configured (key enrolled locally)';
      case 'failed':
        return `failed (${enrollment.note ?? 'no reason recorded'})`;
      case 'unresolved':
        return `unresolved (${enrollment.note ?? 'no reason recorded'})`;
      case 'none':
        return 'not enrolled';
      default: {
        const unreachable: never = enrollment.status;
        throw new Error(`no words for enrollment ${String(unreachable)}`);
      }
    }
  }

  private outcome(run: LiveRunRow, ok: boolean, lead: string | null = null): ToolOutcome {
    const { data, lines } = this.describe(this.viewOf(run));
    return { ok, text: [...(lead ? [lead] : []), ...lines].join('\n'), data };
  }

  private refusal(message: string, data: { readonly [key: string]: unknown } = {}): ToolOutcome {
    return { ok: false, text: message, data: { error: message, ...data } };
  }

  /* ---------- begin_verification ---------- */

  /** The quotes a caller could mean, in the catalog's own order. */
  private resolveQuote(input: BeginInput, grant: GrantView): Quote | null {
    const wanted = (s: string | undefined): string | null => {
      const trimmed = s?.trim().toLowerCase();
      return trimmed ? trimmed : null;
    };
    const reference = wanted(input.reference);
    const merchant = wanted(input.merchant) ?? grant.merchant.toLowerCase();
    const item = wanted(input.item);
    const amount: Cents | null =
      typeof input.amount === 'number' && Number.isFinite(input.amount) ? usd(input.amount) : null;

    return (
      DECK_QUOTES.find(
        (quote) =>
          quote.merchant.toLowerCase() === merchant &&
          (reference === null || quote.reference.toLowerCase() === reference) &&
          (item === null || quote.title.toLowerCase().includes(item)) &&
          (amount === null || quote.price === amount),
      ) ?? null
    );
  }

  /**
   * Resolve a quote from the test catalog and open a run for it.
   *
   * Which quote a description means never depends on what has been bought:
   * "the USD 8.00 item at the test merchant" is the same quote every time, so
   * asking twice finds the same run — still open, or already paid — instead of
   * quietly buying the next item at that price.
   */
  begin(input: BeginInput): ToolOutcome {
    this.sweep();
    if (input.budget !== undefined || (input.currency !== undefined && input.currency.trim() !== '')) {
      if (input.budget === undefined) return this.refusal('Pass `budget` as a number of US dollars, or leave `currency` out.');
      const parsed = parseBudget(input.budget, input.currency);
      if (!parsed.ok) return this.refusal(parsed.message);
      const offered = this.engine.offerBudget(parsed.cents);
      if (!offered.ok) return this.refusal(offered.message);
    }

    const grant = this.store.grantView();
    if (!grant) return this.refusal('This server is not running the AgentTrust deck scene.');
    if (grant.status === 'needs_wallet') {
      return this.refusal(
        `The buyer has not connected a PayPal Sandbox wallet yet. The spending grant is ${fmtUsd(grant.budget)}. Finish the preflight on the AgentTrust page.`,
      );
    }
    if (grant.status === 'needs_approval') {
      return this.refusal(
        `The buyer has not approved the spending grant for this run yet (${fmtUsd(grant.budget)} at ${grant.merchant}). Finish the preflight on the AgentTrust page.`,
      );
    }

    const catalog = this.resolveQuote(input, grant);
    const custom = catalog ? null : this.customQuote(input, grant);
    if (custom && 'error' in custom) return this.refusal(custom.error);
    const quote = catalog ?? (custom && 'quote' in custom ? custom.quote : null);
    if (!quote) {
      // Say what there is to choose from, so a caller that described the shop
      // rather than naming it can ask again without guessing.
      const merchant = input.merchant?.trim() || grant.merchant;
      const offered = DECK_QUOTES.filter((q) => q.merchant.toLowerCase() === merchant.toLowerCase());
      if (offered.length > 0) {
        const list = offered.map((q) => `${q.title} (${q.reference}) ${fmtUsd(q.price)}`).join('; ');
        return this.refusal(`No quote at ${offered[0]?.merchant ?? merchant} matches. Its quotes: ${list}.`);
      }
      const others = [...new Set(DECK_QUOTES.map((q) => q.merchant))].filter((name) => name !== grant.merchant);
      return this.refusal(
        `There is no merchant "${merchant}" in the test catalog. The buyer’s authorized merchant is ${grant.merchant}` +
          `${others.length > 0 ? `; the catalog also lists ${others.join(', ')}` : ''}. ` +
          'Leave `merchant` out to search the authorized one.',
      );
    }

    if (custom && 'quote' in custom) {
      const open = this.store.livePurchase(quote.merchant, quote.title, quote.price);
      if (open && !isFinalLiveStage(this.viewOf(open).stage)) {
        return this.outcome(open, true, 'This quote already has an open run.');
      }
    }

    const priced = custom && 'quote' in custom ? { ...quote, reference: this.freshReference() } : quote;

    const existing = this.store.liveRunFor(priced.merchant, priced.reference);
    if (existing) {
      const view = this.viewOf(existing);
      if (!isFinalLiveStage(view.stage)) return this.outcome(existing, true, 'This quote already has an open run.');
      if (view.stage === 'paid' || view.stage === 'simulated') {
        return this.outcome(existing, true, 'This quote was already bought in this session. To buy another item, name its reference.');
      }
    } else if (priced.merchant === grant.merchant) {
      // Bought another way this night — from the Studio — so there is no run to return.
      const slot = this.store.deckView().find((s) => s.reference === priced.reference);
      if (slot && slot.state !== 'locked' && slot.state !== 'blocked') {
        return this.refusal(`“${priced.title}” (${priced.reference}) was already bought in this session.`);
      }
    }

    const deck = this.store.deckGrant();
    if (!deck) return this.refusal('This server is not running the AgentTrust deck scene.');

    const run = this.store.addLiveRun({
      run_id: randomUUID(),
      deck_run_id: deck.run_id,
      merchant: priced.merchant,
      reference: priced.reference,
      title: priced.title,
      amount: priced.price,
      stage: 'challenge',
      prompt: PROBE_PROMPT,
      challenge_expires_at: this.now() + CHALLENGE_TTL_MS,
      reply: null,
      reply_attempts: 0,
      signal: null,
      nonce: null,
      sign_expires_at: null,
      request_id: null,
      note: null,
    });
    this.log(
      `Live run started: ${DECK.agentName} asks for “${priced.title}” (${fmtUsd(priced.price)}) at ${priced.merchant}. ` +
        `Numeric challenge issued: ${PROBE.count} integers`,
      'ASK_OWNER',
      'MODEL_SIGNAL',
    );
    return this.outcome(run, true, `Found ${priced.title} at ${priced.merchant}: ${fmtUsd(priced.price)} (quote ${priced.reference}).`);
  }

  /**
   * An item the catalog does not quote, priced by the caller, at the authorized merchant.
   *
   * Null when this call should keep the catalog's "no quote matches" answer:
   * a named reference, or a merchant the grant does not cover. An error when
   * the caller asked for a custom item but the price is missing or not USD.
   */
  private customQuote(input: BeginInput, grant: GrantView): { readonly quote: Quote } | { readonly error: string } | null {
    if (input.reference?.trim()) return null;
    const named = input.merchant?.trim();
    if (named && named.toLowerCase() !== grant.merchant.toLowerCase()) return null;
    const item = input.item?.trim() ?? '';
    const hasAmount = typeof input.amount === 'number';
    if (!item && !hasAmount) return null;
    if (!hasAmount) {
      return { error: 'Pass amount_usd to buy an item that is not in the catalog. It must be a positive USD amount up to 10000.' };
    }
    const parsed = parseBudget(input.amount ?? 0, 'USD', 'amount');
    if (!parsed.ok) return { error: parsed.message };
    const title = (item || `Purchase ${fmtUsd(parsed.cents)}`).slice(0, 80);
    return { quote: { merchant: grant.merchant, reference: '', title, price: parsed.cents } };
  }

  /** A reference that is not one of the shop's fixed quotes and not already in use. */
  private freshReference(): string {
    const taken = new Set(DECK_QUOTES.map((quote) => quote.reference));
    for (let i = 0; i < 8; i++) {
      const reference = `KS-${randomBytes(3).toString('hex').toUpperCase()}`;
      if (taken.has(reference)) continue;
      if (this.store.liveRunFor(DECK.merchant, reference)) continue;
      return reference;
    }
    return `KS-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }

  /* ---------- submit_model_reply ---------- */

  /**
   * Read the model's reply and score it.
   *
   * A reply that cannot be read as a batch — malformed, or too few integers —
   * was never scored, so another may be sent for the same challenge, a few
   * times. A reply that *was* scored is the run's one answer: whatever it
   * resembled, there is no second try against the same challenge, because a
   * sender allowed to try again until it matched would always match.
   */
  submitReply(runId: string, reply: string): ToolOutcome {
    this.sweep();
    const run = this.runOf(runId);
    if (!run) return this.refusal(`There is no run "${runId}" in this session. Start one with begin_verification.`);

    if (run.stage !== 'challenge') {
      // The challenge is closed. The same reply again is a repeat of a call
      // already answered, and gets the same answer; anything else is not read.
      if (run.reply === null) return this.outcome(run, false);
      const same = run.reply.trim() === reply.trim();
      const passed = run.stage === 'signing' || run.stage === 'submitted';
      return this.outcome(
        run,
        same && passed,
        same ? null : 'This run’s reply was already recorded; a different one is not read.',
      );
    }

    const calibration = this.reference.calibration();
    const assessed = assess(reply, calibration);
    const kept = reply.length > MAX_REPLY_CHARS ? `${reply.slice(0, MAX_REPLY_CHARS)}…` : reply;

    if (assessed.numbers === null) {
      const attempts = run.reply_attempts + 1;
      const closed = attempts >= MAX_UNREAD_REPLIES;
      this.store.patchLiveRun(run.run_id, {
        reply: kept,
        reply_attempts: attempts,
        signal: JSON.stringify(assessed.view),
        ...(closed ? { stage: 'not_matched', note: `${assessed.view.note} No readable reply after ${attempts} tries.` } : {}),
      });
      this.log(
        `Numeric reply not scored: ${assessed.view.note} The run stays at Layer 1`,
        'DENY',
        'MODEL_SIGNAL',
      );
      const now = this.runOf(run.run_id) ?? run;
      return this.outcome(
        now,
        false,
        closed
          ? null
          : `Not scored: ${assessed.view.note} Send all ${PROBE.count} integers again with submit_model_reply (${MAX_UNREAD_REPLIES - attempts} more ${MAX_UNREAD_REPLIES - attempts === 1 ? 'try' : 'tries'}).`,
      );
    }

    if (this.calibrateAs !== null) {
      this.reference.record(this.calibrateAs, assessed.numbers, `run:${run.run_id}`);
      const recorded = recordedView(assessed.numbers, this.calibrateAs, this.reference.calibration());
      this.store.patchLiveRun(run.run_id, {
        reply: kept,
        reply_attempts: run.reply_attempts + 1,
        signal: JSON.stringify(recorded),
        stage: 'not_matched',
        note: 'Calibration mode: the reply was recorded as a reference sample. Nothing was scored or signed.',
      });
      this.log(`Calibration: ${recorded.note}`, 'ASK_OWNER', 'MODEL_SIGNAL');
      this.publish();
      return this.outcome(this.runOf(run.run_id) ?? run, true);
    }

    const matched = assessed.view.result === 'match';
    this.store.patchLiveRun(run.run_id, {
      reply: kept,
      reply_attempts: run.reply_attempts + 1,
      signal: JSON.stringify(assessed.view),
      ...(matched
        ? { stage: 'signing', nonce: newNonce(), sign_expires_at: this.now() + SIGN_TTL_MS }
        : { stage: 'not_matched', note: assessed.view.note }),
    });
    this.log(
      matched
        ? `Model signal: ${assessed.view.received} of ${assessed.view.asked} integers received. ${assessed.view.note} Signing challenge issued`
        : `Model signal: ${assessed.view.received} of ${assessed.view.asked} integers received. ${assessed.view.note} The run stays at Layer 1`,
      matched ? 'ALLOW' : 'DENY',
      'MODEL_SIGNAL',
    );
    return this.outcome(this.runOf(run.run_id) ?? run, matched);
  }

  /* ---------- sign_and_submit ---------- */

  /**
   * Have the signer sign this run's challenge, and hand the result to the gate.
   *
   * Concurrent calls for one run share one attempt, and a run that already
   * became a request only reports it: the challenge is signed and submitted at
   * most once, so one instruction can produce at most one charge.
   */
  signAndSubmit(runId: string): Promise<ToolOutcome> {
    const inFlight = this.signing.get(runId);
    if (inFlight) return inFlight;

    const attempt = this.signOnce(runId).finally(() => this.signing.delete(runId));
    this.signing.set(runId, attempt);
    return attempt;
  }

  private async signOnce(runId: string): Promise<ToolOutcome> {
    this.sweep();
    const run = this.runOf(runId);
    if (!run) return this.refusal(`There is no run "${runId}" in this session. Start one with begin_verification.`);
    if (run.request_id) return this.settled(run);
    if (run.stage !== 'signing' || run.nonce === null || run.sign_expires_at === null) {
      return this.outcome(run, false, run.stage === 'challenge' ? 'Layer 1 has not passed yet: there is no signing challenge to sign.' : null);
    }

    // A challenge whose nonce the gate has already seen was submitted — by a
    // call that was cut off before it could say so. Find that request rather
    // than sign again.
    const earlier = this.store.requestByNonce(run.nonce);
    if (earlier) {
      this.store.patchLiveRun(run.run_id, { stage: 'submitted', request_id: earlier });
      return this.settled(this.runOf(run.run_id) ?? run);
    }

    const stop = (note: string): ToolOutcome => {
      this.store.patchLiveRun(run.run_id, { stage: 'stopped', note });
      this.log(`Live run stopped at Layer 2: ${note} PayPal was not called`, 'DENY', 'ENROLLMENT');
      return this.outcome(this.runOf(run.run_id) ?? run, false);
    };

    // Layer 2 starts with who the agent is. No enrolled signer key, no signature to ask for.
    const enrollment = this.store.enrollmentView();
    const row = this.store.enrollment(DECK.registryId);
    const entry = this.store.registryEntry(DECK.registryId);
    const enrolled =
      (enrollment?.status === 'verified' || enrollment?.status === 'local') &&
      !!row?.pubkey &&
      entry?.key === row.pubkey;
    if (!enrolled || !row?.pubkey) {
      switch (enrollment?.status) {
        case 'failed':
        case 'unresolved':
          if (this.identityMode === 'erc8004') {
            const word = enrollment.status === 'failed' ? 'failed' : 'unresolved';
            return stop(`ERC-8004 registration check ${word}. ${enrollment.note ?? ''}`.trim());
          }
          return stop(enrollment.note ?? `${DECK.agentName} is not enrolled: no signer key is in the registry.`);
        default:
          return stop(`${DECK.agentName} is not enrolled: no signer key is in the registry.`);
      }
    }
    if (!this.signer) return stop('No signer service is configured on this server.');

    // Things the buyer or time can still change leave the challenge open.
    const grant = this.store.grantView();
    if (!grant) return this.refusal('This server is not running the AgentTrust deck scene.');
    if (grant.status === 'needs_wallet') return this.outcome(run, false, 'The PayPal Sandbox wallet is not connected, so nothing was signed.');
    if (grant.status === 'needs_approval') return this.outcome(run, false, 'The buyer’s grant is not approved for this run, so nothing was signed.');

    const mandate = this.grantFor(row.pubkey);
    if (!mandate) return stop('The buyer record is missing. Reset the demo.');

    const challenge: SigningChallenge = {
      kind: CHALLENGE_KIND,
      runId: run.run_id,
      registryId: DECK.registryId,
      mandate,
      intent: { amount: run.amount as Cents, receiver: run.merchant, reference: run.reference, scope: 'stock_images' },
      nonce: run.nonce,
      expiresAtMs: run.sign_expires_at,
    };

    let signed;
    try {
      signed = await this.signer.sign(challenge);
      this.signerState = { state: 'reachable', note: null };
    } catch (err) {
      const why = err instanceof SignerUnavailable ? err.message : 'The signer service did not answer.';
      this.signerState = { state: 'unreachable', note: why };
      this.publish();
      return this.outcome(this.runOf(run.run_id) ?? run, false, `${why} Nothing was signed; the challenge is still open.`);
    }
    this.publish();
    if (!signed.ok) return stop(`The signer refused: ${signed.error}.`);

    // The world may have moved while the signer answered.
    const current = this.runOf(run.run_id);
    if (!current) return this.refusal('The demo was reset while the signer answered. Start again with begin_verification.');
    if (current.request_id) return this.settled(current);
    if (current.stage !== 'signing') return this.outcome(current, false);

    // Built from the challenge this server issued, never from what came back:
    // only the signature and the key it claims are the signer's to supply.
    const submitted = this.engine.submitSigned(
      {
        origin: 'agent',
        agent: { key: signed.publicKey, registryId: DECK.registryId },
        mandate: challenge.mandate,
        intent: challenge.intent,
        nonce: challenge.nonce,
        expiresAtMs: challenge.expiresAtMs,
        signature: signed.signature,
      },
      `${DECK.agentName} (live) · ${current.title} ${fmtUsd(current.amount as Cents)}`,
    );
    if (!submitted.ok || submitted.requestId === null) {
      return this.outcome(current, false, `${submitted.message} Nothing was submitted; the challenge is still open.`);
    }

    this.store.patchLiveRun(current.run_id, { stage: 'submitted', request_id: submitted.requestId });
    return this.settled(this.runOf(current.run_id) ?? current);
  }

  /** Report a run that reached the gate, giving PayPal a moment to answer first. */
  private async settled(run: LiveRunRow): Promise<ToolOutcome> {
    const deadline = Date.now() + this.settleWaitMs;
    let view = this.viewOf(run);
    while ((view.stage === 'charging' || view.stage === 'verifying') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const again = this.runOf(run.run_id);
      if (!again) break;
      view = this.viewOf(again);
    }
    const now = this.runOf(run.run_id) ?? run;
    const stage = this.viewOf(now).stage;
    return this.outcome(now, stage === 'paid' || stage === 'simulated' || stage === 'charging' || stage === 'verifying');
  }

  /* ---------- get_purchase_status ---------- */

  status(runId: string): ToolOutcome {
    this.sweep();
    const run = this.runOf(runId);
    if (!run) return this.refusal(`There is no run "${runId}" in this session.`);
    return this.outcome(run, true);
  }

  /* ---------- get_connector_status ---------- */

  /**
   * Whether everything a live run needs is in place. Read-only, and says only
   * what the verification page already shows: no token, no key, no wallet id.
   *
   * Two lists, because they are different questions. `missing` stops any run.
   * `caveats` do not: a rehearsal goes through with a simulated wallet. In
   * erc8004 mode an enrolled key whose registration was never checked is a
   * caveat too — the run is ready and the recording is not. In local mode the
   * enrolled key is the identity proof, so it is not a caveat.
   */
  async readiness(): Promise<ToolOutcome> {
    this.sweep();
    await this.probeSigner();

    const grant = this.store.grantView();
    const wallet = this.store.walletView();
    const enrollment = this.store.enrollmentView();
    const reference = this.reference.status();
    const latest = this.store.liveView();
    if (!grant || !wallet || !enrollment) return this.refusal('This server is not running the AgentTrust deck scene.');

    const missing: string[] = [];
    if (wallet.state !== 'connected') missing.push('the PayPal Sandbox wallet is not connected');
    if (grant.status === 'needs_approval') missing.push('the buyer’s grant is not approved for this run');
    if (grant.status === 'revoked') missing.push('the buyer revoked the agent');
    if (!enrollment.active) missing.push(`the agent’s enrollment is ${this.enrollmentWords(enrollment)}`);
    if (this.signerState.state !== 'reachable') missing.push(this.signerState.note ?? 'the signer service was not reached');
    if (this.calibrateAs !== null) missing.push(`calibration mode is on: replies are recorded as ${this.calibrateAs}, not scored`);
    else if (!reference.calibrated) {
      missing.push(
        reference.expected === null
          ? 'no model reference has been recorded yet'
          : `the ${reference.expected} reference has ${reference.samples} of ${reference.needed} samples`,
      );
    }

    const caveats: string[] = [];
    if (wallet.state === 'connected' && wallet.mode !== 'live') {
      caveats.push('no PayPal credentials on this server, so a charge is simulated and never a Sandbox capture');
    }
    if (this.identityMode === 'erc8004' && enrollment.active && enrollment.status !== 'verified') {
      caveats.push('no ERC-8004 registration is configured, so the agent’s registration cannot be shown as verified');
    }

    const ready = missing.length === 0;
    const data = {
      ready,
      ready_to_record: ready && caveats.length === 0,
      missing,
      caveats,
      wallet: { state: wallet.state, mode: wallet.mode === 'live' ? 'PayPal Sandbox' : 'simulated' },
      grant: {
        status: grant.status,
        agent: grant.registryId,
        merchant: grant.merchant,
        authorized: fmtUsd(grant.budget),
        left: fmtUsd(grant.left),
        ask_threshold_pct: grant.askThresholdPct,
        pending_budget_request: grant.pendingBudgetRequest
          ? {
              request_id: grant.pendingBudgetRequest.requestId,
              status: 'pending',
              current_budget: fmtUsd(grant.pendingBudgetRequest.current),
              requested_budget: fmtUsd(grant.pendingBudgetRequest.requested),
              reason: grant.pendingBudgetRequest.reason,
              needs_buyer_approval: true,
              approval_url: this.verifyPage(),
            }
          : null,
      },
      enrollment: {
        status: enrollment.status,
        identity_mode: this.identityMode,
        active: enrollment.active,
        network: this.identityMode === 'erc8004' ? enrollment.network : null,
        registry_contract: this.identityMode === 'erc8004' ? enrollment.registry : null,
        agent_id: this.identityMode === 'erc8004' ? enrollment.agentId : null,
        checked_block: this.identityMode === 'erc8004' ? enrollment.blockNumber : null,
      },
      signer: this.signerState.state,
      model_reference: {
        expected_model: reference.expected,
        samples: reference.samples,
        needed: reference.needed,
        calibrated: reference.calibrated,
        calibrating_as: this.calibrateAs,
      },
      latest_run: latest ? { run_id: latest.runId, stage: latest.stage } : null,
    };

    const text = [
      !ready
        ? `AgentTrust connector is reachable. Not ready: ${missing.join('; ')}.`
        : caveats.length === 0
          ? 'AgentTrust connector is ready for a live run.'
          : `AgentTrust connector is ready for a rehearsal run. Not ready to record: ${caveats.join('; ')}.`,
      `Wallet: ${wallet.state} (${data.wallet.mode}). Grant: ${grant.status}, ${fmtUsd(grant.left)} of ${fmtUsd(grant.budget)} left at ${grant.merchant}. Ask above ${grant.askThresholdPct}% of the budget.` +
        (grant.pendingBudgetRequest
          ? ` Budget change waiting: ${fmtUsd(grant.pendingBudgetRequest.current)} → ${fmtUsd(grant.pendingBudgetRequest.requested)}. The buyer approves it on the verify page.`
          : ''),
      this.identityMode === 'local' && enrollment.status === 'local' && enrollment.active
        ? `Agent ${grant.registryId}: ${this.enrollmentWords(enrollment)}. Signer: ${this.signerState.state}.`
        : `Agent ${grant.registryId}: enrollment ${this.enrollmentWords(enrollment)}. Signer: ${this.signerState.state}.`,
      `Model reference: ${reference.expected ?? 'none'} · ${reference.samples} of ${reference.needed} samples${reference.calibrated ? ' · calibrated' : ''}.`,
      latest ? `Latest run: ${latest.runId} · ${latest.stage}.` : 'No run has started in this session.',
    ].join('\n');

    return { ok: true, text, data };
  }
}
