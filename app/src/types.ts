/**
 * The Overduel domain, as types.
 *
 * The work is agentic payment authentication: other people's AI agents send us
 * payment requests, and nothing is paid until the request proves three separate
 * things. Five ideas carry most of the weight here:
 *
 *   1. Money is `Cents`, a branded integer. A plain `number` will not typecheck
 *      where an amount is wanted, so dollars can never be passed to something
 *      expecting cents.
 *
 *   2. An `Envelope` is a payment request as it arrived — two signatures by two
 *      different parties. The `Mandate` inside it is signed by the *principal*
 *      (the vendor), granting its agent a scope and a cap; the envelope itself
 *      is signed by that *agent*, over the exact intent. Neither key can forge
 *      the other's half, and that gap is where most attacks live.
 *
 *   3. `gate()` answers with a `Ruling`. `ALLOW` carries no reason and the two
 *      other verdicts cannot be constructed without one, so the audit log can
 *      never show an unexplained block.
 *
 *   4. A `Decision` is data, never a closure, so it can live in a database and
 *      survive a restart. Resolving one is a pure switch on its kind.
 *
 *   5. An agent's whereabouts is `(Station, slot)` — a named place in the
 *      studio, not a pair of pixels. The server moves agents between places;
 *      The engine calculates station timing separately from the data model, and both
 *      sides import it.
 */

/* ---------- Money ---------- */

/**
 * An integer number of cents. Branded so it cannot be confused with dollars,
 * a count, or an index.
 */
export type Cents = number & { readonly __brand: 'Cents' };

/** Build `Cents` from a whole-cent integer (e.g. a database column). */
export const cents = (n: number): Cents => Math.round(n) as Cents;

/** Build `Cents` from dollars (e.g. `usd(2480)` for $2,480). */
export const usd = (d: number): Cents => Math.round(d * 100) as Cents;

export const addCents = (a: Cents, b: Cents): Cents => (a + b) as Cents;
export const subCents = (a: Cents, b: Cents): Cents => (a - b) as Cents;
export const absCents = (a: Cents): Cents => Math.abs(a) as Cents;
export const maxZero = (a: Cents): Cents => Math.max(0, a) as Cents;

/** `USD 8.00`: the amount as a receipt writes it, always with two decimals. */
export function fmtUsd(c: Cents): string {
  const whole = Math.trunc(Math.abs(c) / 100);
  const rest = Math.abs(c % 100);
  return `${c < 0 ? '-' : ''}USD ${whole.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`;
}

/** `$2,480` for whole dollars, `$1,180.50` when there are cents to show. */
export function fmtMoney(c: Cents): string {
  const whole = Math.trunc(c / 100);
  const rest = Math.abs(c % 100);
  const body = whole.toLocaleString('en-US');
  return rest === 0 ? `$${body}` : `$${body}.${String(rest).padStart(2, '0')}`;
}

/* ---------- The crew ---------- */

/**
 * Bolt relays and Raven attacks. Neither can reach a ruling: see `IntakeAgent`
 * below and `registry: 'internal'` in `src/rules.ts`.
 */
export type AgentKey = 'pip' | 'mochi' | 'shield' | 'tally' | 'bolt' | 'raven';

/**
 * The only agent that may hand an envelope to the gate.
 *
 * Typed as a one-member extraction rather than a convention: `GateContext`
 * requires an `IntakeAgent`, so there is no way to compile a call to `gate()`
 * on Bolt's or Raven's behalf. Together with `registry: 'internal'` — which
 * denies anything signed by one of our own keys — the red team has no route to
 * an `ALLOW` at all.
 */
export type IntakeAgent = Extract<AgentKey, 'pip'>;

export const INTAKE: IntakeAgent = 'pip';

/** The two agents that read untrusted text. Neither owns a lamp. */
export type ReadingAgent = Extract<AgentKey, 'pip' | 'mochi'>;

export const AGENT_ORDER = [
  'pip',
  'mochi',
  'shield',
  'tally',
  'bolt',
  'raven',
] as const satisfies readonly AgentKey[];

/**
 * Trust tiers 1-5. A tier only selects which cap applies; code enforces the
 * cap. A tier never approves anything and is never spendable.
 */
export type Level = 1 | 2 | 3 | 4 | 5;

export const LEVELS = [1, 2, 3, 4, 5] as const satisfies readonly Level[];

export const isLevel = (n: number): n is Level => n >= 1 && n <= 5 && Number.isInteger(n);

/** A value that varies by trust tier. Indexed by `Level`, so all five exist. */
export type ByLevel<T> = { readonly [L in Level]: T };

/**
 * A named place in the studio. Several have more than one spot, picked by the
 * agent's `slot`: four desks, five meeting places, three sleeping bags, two
 * beanbags.
 */
export type Station =
  | 'desk'
  | 'comms'
  | 'podium'
  | 'booth'
  | 'inbox'
  | 'meeting'
  | 'sleep'
  | 'beanbag'
  | 'kopi';

export const STATIONS = [
  'desk',
  'comms',
  'podium',
  'booth',
  'inbox',
  'meeting',
  'sleep',
  'beanbag',
  'kopi',
] as const satisfies readonly Station[];

export const isStation = (s: string): s is Station => (STATIONS as readonly string[]).includes(s);

/** The stations an agent goes to in order to rest rather than to work. */
export const BREAK_STATIONS = ['sleep', 'beanbag', 'kopi'] as const;

export const isBreakStation = (s: Station): boolean =>
  (BREAK_STATIONS as readonly Station[]).includes(s);

/**
 * What the agent's body is doing, as opposed to where it is.
 *
 * `walk` is set by the server while a trip is in progress; the browser does the
 * actual travelling, because only it has a frame clock.
 */
export type Pose = 'stand' | 'walk' | 'sleep' | 'chill';

export const isPose = (s: string): s is Pose =>
  s === 'stand' || s === 'walk' || s === 'sleep' || s === 'chill';

/** Which way the sprite faces. Mirrored when walking left. */
export type Facing = 'left' | 'right';

/**
 * The six states the desk lamp and the roster chip both show. Derived from the
 * agent rather than stored, so the lamp and the chip cannot disagree.
 */
export type AgentState = 'working' | 'waiting' | 'break' | 'holding' | 'paused' | 'redteam';

export type AgentStatus = 'work' | 'wait';

/**
 * One line of an agent's desk monitor.
 *
 * These are facts with citations, never opinions: a checker prints
 * `mandate sig ok · scope supplies · exp day 19`, never "this looks wrong to
 * me". The gate states the verdict; agents only report what they read.
 */
export interface MonitorLine {
  readonly text: string;
  readonly tone: 'plain' | 'pass' | 'fail';
}

export interface Agent {
  readonly key: AgentKey;
  readonly name: string;
  readonly role: string;
  readonly level: Level;
  readonly xp: number;
  /** Which desk is this agent's own, 0-3. Bolt and Raven have none. */
  readonly desk: number;
  readonly status: AgentStatus;
  readonly at: Station;
  /** Which spot within `at`. Always 0 for single-spot stations. */
  readonly slot: number;
  readonly pose: Pose;
  readonly facing: Facing;
  /** Speech bubble, or null when the agent is quiet. */
  readonly say: string | null;
  /** One sentence for the zoom card: what it is doing right now. */
  readonly doing: string;
  readonly lines: readonly MonitorLine[];
}

/* ---------- Counterparties: agents, principals, mandates ---------- */

/**
 * How well authenticated a request is, which sets how far it can go.
 *
 * `agent` is a full envelope with a mandate chain. `portal` is an
 * authenticated vendor with no mandate to present. `email` is prose a model
 * read, with nothing signed at all — the weakest rung, and the only one Pip
 * can be fooled on. Origin is a field, not a separate code path: one `gate()`
 * handles all three and the ceiling does the grading.
 */
export type Origin = 'agent' | 'portal' | 'email';

export const ORIGINS = ['agent', 'portal', 'email'] as const satisfies readonly Origin[];

export const isOrigin = (s: string): s is Origin => (ORIGINS as readonly string[]).includes(s);

export const ORIGIN_LABEL: { readonly [O in Origin]: string } = {
  agent: 'SIGNED AGENT',
  portal: 'VENDOR PORTAL',
  email: 'EMAIL',
};

/**
 * What a mandate may be spent on. An intent outside its grant's scope is denied.
 *
 * `stock_images` is the AgentTrust deck scene's: the buyer's grant to its own
 * agent covers licensing images from one shop and nothing else.
 */
export type MandateScope =
  | 'supplies'
  | 'hosting'
  | 'logistics'
  | 'payout'
  | 'subscription'
  | 'stock_images';

export const MANDATE_SCOPES = [
  'supplies',
  'hosting',
  'logistics',
  'payout',
  'subscription',
  'stock_images',
] as const satisfies readonly MandateScope[];

export const isMandateScope = (s: string): s is MandateScope =>
  (MANDATE_SCOPES as readonly string[]).includes(s);

/**
 * What our registry says about a key that signed a request.
 *
 * `internal` is the important one: it means the signer is one of *our* agents.
 * Our own keys can never authorise a payment to anyone, which closes
 * self-dealing and means anything Raven signs with its own key dies on the
 * first lamp.
 */
export type RegistryStatus = 'active' | 'revoked' | 'unknown' | 'internal';

/** One row of the agent registry: a counterparty's agent, and who it acts for. */
export interface RegistryEntry {
  readonly registryId: string;
  /** Ed25519 public key, base64url. */
  readonly key: string;
  readonly principal: string;
  readonly status: RegistryStatus;
  /** Demo-clock day the key was revoked, or null while it is live. */
  readonly revokedDay: number | null;
}

/**
 * A principal's grant to one of its agents, signed by the principal.
 *
 * This is the half of the chain a compromised agent key cannot forge: raising
 * `maxPerPayment` or widening `scope` breaks the principal's signature.
 */
export interface Mandate {
  readonly principal: string;
  /** The agent key this grant empowers. */
  readonly agentKey: string;
  readonly scope: MandateScope;
  readonly maxPerPayment: Cents;
  /** Demo-clock day the grant lapses, inclusive. */
  readonly expiresDay: number;
  /** Ed25519 signature over `mandateBytes`, base64url. */
  readonly signature: string;
}

/** The actual ask. Every field of it is inside the agent's signature. */
export interface Intent {
  readonly amount: Cents;
  /** Where the money would go — a PayPal receiver address. */
  readonly receiver: string;
  /** The counterparty's invoice number. Our duplicate check keys on it. */
  readonly reference: string;
  readonly scope: MandateScope;
}

/**
 * A payment request as it arrived.
 *
 * Both signatures are carried verbatim. Nothing in here is trusted: `gate()`
 * reads these fields as *claims*, and whether the signatures verified arrives
 * separately, in `GateContext`.
 */
export interface Envelope {
  readonly id: string;
  readonly origin: Origin;
  readonly agent: { readonly key: string; readonly registryId: string };
  /**
   * The grant being presented.
   *
   * `mandate.principal` is the claimed principal on *every* lane, because the
   * counterparty lamp needs something to look up whatever the origin is. On
   * the email lane the engine fills a stub — the principal a model read out of
   * the prose, an empty signature, everything else zeroed — and the mandate
   * lamp is skipped rather than fed a lie. See `ANSWERS` in `src/rules.ts`.
   */
  readonly mandate: Mandate;
  readonly intent: Intent;
  readonly nonce: string;
  readonly expiresAtMs: number;
  /** Ed25519 signature over `intentBytes`, base64url. Empty on the email lane. */
  readonly signature: string;
}

/** What we know about a principal we have paid before. */
export interface VendorRecord {
  readonly principal: string;
  /** The receiver we have on file. An intent that disagrees is denied. */
  readonly receiver: string;
  /**
   * The principal's own Ed25519 public key, base64url, taken at onboarding.
   *
   * This is what a mandate signature is checked against, and it is why the
   * counterparty lamp has to run before the mandate lamp: without a record we
   * hold no key, and there is nothing to verify a grant with.
   */
  readonly principalKey: string;
  readonly paidCount: number;
  readonly maxPaid: Cents;
  readonly meanPaid: Cents;
}

/* ---------- The owner's policy ---------- */

/**
 * The owner's own mandate to the crew: the only place a limit is written down.
 *
 * Signed with the owner's key so a tampered row is detectable. The crew sheet
 * renders this record; nothing copies a number out of it.
 */
export interface Policy {
  /** Demo-clock day the owner's authority lapses. Past it, nothing clears. */
  readonly expiresDay: number;
  /** Most that may leave in one day without the owner, across all requests. */
  readonly dailyTotal: Cents;
  /** Most a Telegram tap may approve. A tap can never change a receiver. */
  readonly telegramCap: Cents;
  /** Largest single payment that clears on its own, by the intake agent's tier. */
  readonly perPayment: ByLevel<Cents>;
  /** Hard ceiling per origin, applied before the tier cap. */
  readonly originCeiling: { readonly [O in Origin]: Cents };
  /** Ed25519 signature over `policyBytes`, base64url. */
  readonly signature: string;
}

/* ---------- Requests, as the studio shows them ---------- */

/**
 * Where a request is in its life.
 *
 * `charging` sits between an `ALLOW` and `paid` in the deck scene: the gate has
 * ruled, the budget is reserved, and the saved-wallet charge is with PayPal.
 * A request only becomes `paid` once PayPal confirms a completed capture.
 */
export type RequestStatus =
  | 'queued'
  | 'intake'
  | 'gated'
  | 'waiting'
  | 'charging'
  | 'paid'
  | 'blocked';

export const REQUEST_STATUSES = [
  'queued',
  'intake',
  'gated',
  'waiting',
  'charging',
  'paid',
  'blocked',
] as const satisfies readonly RequestStatus[];

export const STATUS_LABEL: { readonly [S in RequestStatus]: string } = {
  queued: 'QUEUED',
  intake: 'IN INTAKE',
  gated: 'AT THE GATE',
  waiting: 'NEEDS YOU',
  charging: 'WITH PAYPAL',
  paid: 'PAID',
  blocked: 'BLOCKED',
};

/**
 * One row of the request board: an envelope plus how far it got.
 *
 * Deliberately not the `Envelope` itself — the board never needs a signature,
 * and a view that cannot see one cannot accidentally imply it checked one.
 */
export interface Request {
  readonly id: string;
  readonly origin: Origin;
  readonly principal: string;
  readonly registryId: string;
  readonly amount: Cents;
  readonly reference: string;
  readonly scope: MandateScope;
  readonly status: RequestStatus;
  readonly day: number;
  readonly verdict: Verdict | null;
  /** The lamp that settled it, once one has. */
  readonly lamp: CheckId | null;
  /** Set when Raven built this request, so the duel lane can pair them up. */
  readonly attackId: string | null;
}

/** An item in the studio inbox. `suspicious` tints it pink. */
export interface InboxItem {
  readonly id: string;
  readonly origin: Origin;
  readonly label: string;
  readonly suspicious: boolean;
}

/* ---------- The gate ---------- */

export type Verdict = 'ALLOW' | 'ASK_OWNER' | 'DENY';

/**
 * The five lamps on the vault, in the order the gate runs them.
 *
 * The order is a dependency chain, not a preference: we cannot check whether a
 * principal signed a grant until we have confirmed we hold that principal's
 * key, which is the counterparty lamp's job. So it reads as identify the
 * party, confirm we know them, confirm the grant, confirm the binding, then
 * confirm our own caps.
 */
export type LampId =
  | 'AGENT_IDENTITY'
  | 'COUNTERPARTY'
  | 'MANDATE'
  | 'INTENT_BINDING'
  | 'OUR_POLICY';

export const LAMPS = [
  'AGENT_IDENTITY',
  'COUNTERPARTY',
  'MANDATE',
  'INTENT_BINDING',
  'OUR_POLICY',
] as const satisfies readonly LampId[];

export const LAMP_LABEL: { readonly [L in LampId]: string } = {
  AGENT_IDENTITY: 'Agent identity',
  MANDATE: 'Mandate chain',
  INTENT_BINDING: 'Intent binding',
  COUNTERPARTY: 'Counterparty',
  OUR_POLICY: 'Owner policy',
};

/** What each lamp is actually asking, for the crew sheet and the zoom card. */
export const LAMP_QUESTION: { readonly [L in LampId]: string } = {
  AGENT_IDENTITY: 'Is this key in our registry, live, and not one of ours?',
  MANDATE: 'Did the principal really grant this agent this scope and cap?',
  INTENT_BINDING: 'Does the signature cover this exact ask, once, before it expired?',
  COUNTERPARTY: 'Is the principal a vendor we know, paid at the address we hold?',
  OUR_POLICY: 'Is it inside the owner’s caps, and not a reference we have paid?',
};

/** Which agent reports each lamp. Nobody votes; they read and print. */
export const LAMP_OWNER: { readonly [L in LampId]: AgentKey } = {
  AGENT_IDENTITY: 'shield',
  MANDATE: 'shield',
  INTENT_BINDING: 'tally',
  COUNTERPARTY: 'shield',
  OUR_POLICY: 'tally',
};

/**
 * Everything that can settle a request, plus the outcome markers the event log
 * uses. Keeping these in one union means a log row can never cite a check that
 * does not exist.
 */
export type CheckId =
  // The five lamps.
  | LampId
  // Gate-level refusals that are not lamps.
  | 'PAUSED'
  // Applies when the owner approves, not when the gate runs.
  | 'ORIGIN_CAP'
  // Outcome markers, written to the log once something has happened.
  | 'OWNER_APPROVED'
  | 'OWNER_HELD'
  | 'OWNER_DECLINED'
  | 'OWNER_OVERRULED'
  | 'PAYOUT_SENT'
  | 'PAYOUT_FAILED'
  | 'BREACH'
  | 'ATTACK'
  | 'TIER_UP'
  | 'TIER_DOWN'
  | 'RULE_ADOPTED'
  | 'CLOCK'
  | 'STANDUP'
  // The deck scene: the buyer's grant, its saved wallet, and revoking the agent.
  | 'GRANT'
  | 'WALLET'
  | 'REVOKE'
  // A charge from an earlier run of the demo, settled by reconciliation.
  | 'RECONCILED'
  // The live connector: the numeric model signal, and the Demo Agent's enrollment.
  | 'MODEL_SIGNAL'
  | 'ENROLLMENT';

/** How one check came out. `skip` is for checks a later lamp made moot. */
export type CheckOutcome = 'pass' | 'ask' | 'fail' | 'skip';

export interface CheckResult {
  readonly check: CheckId;
  readonly outcome: CheckOutcome;
  /** The fact, with its source. Printed on a monitor verbatim. */
  readonly note: string;
}

/**
 * The gate's answer.
 *
 * `ALLOW` has no `reason` field at all, and the two other verdicts cannot be
 * constructed without one. `checks` carries every lamp's result so the vault
 * can light all five without a second evaluation path, while `check` names the
 * *first* failure in lamp order — the one the Case tab prints.
 */
export type Ruling =
  | { readonly verdict: 'ALLOW'; readonly check: CheckId; readonly checks: readonly CheckResult[] }
  | {
      readonly verdict: 'ASK_OWNER';
      readonly check: CheckId;
      readonly reason: string;
      readonly checks: readonly CheckResult[];
    }
  | {
      readonly verdict: 'DENY';
      readonly check: CheckId;
      readonly reason: string;
      readonly checks: readonly CheckResult[];
    };

/** A scam signal Mochi raised on the email lane. Advisory: never a verdict. */
export interface ScamFlag {
  readonly kind: 'urgency' | 'impersonation' | 'injection' | 'new_receiver' | 'odd_hours';
  readonly note: string;
}

/**
 * Everything the gate needs to know about the world, and nothing more.
 *
 * Every field is a fact already established by an impure collector: signatures
 * verified, registry read, nonce table checked, records loaded, clock sampled.
 * `gate()` only compares.
 *
 * There is deliberately **no field for untrusted text** — no body, no subject,
 * no prose. That is what makes "the checkers never read the email" a property
 * of the program rather than a promise: there is nowhere to put it.
 */
export interface GateContext {
  readonly paused: boolean;
  /** The clock, passed in. `gate()` never reads one. */
  readonly nowMs: number;
  readonly day: number;
  /** Which agent handed this to the gate. Only the intake agent can. */
  readonly intake: IntakeAgent;
  /** The intake agent's trust tier, which selects the per-payment cap. */
  readonly tier: Level;

  /* Authentication facts. */
  readonly registry: RegistryStatus;
  /**
   * Who our registry says this key acts for, or null when it is not listed.
   *
   * Separate from the mandate's own `principal` claim on purpose: a real agent
   * presenting a real grant from the *wrong* principal is the confused-deputy
   * attack, and it is only visible by comparing the two.
   */
  readonly registryPrincipal: string | null;
  readonly agentSigValid: boolean;
  readonly mandateSigValid: boolean;
  /** The agent's signature covers exactly this intent, nonce and expiry. */
  readonly intentBound: boolean;
  readonly nonceSeen: boolean;

  /* Our own records. */
  readonly counterparty: VendorRecord | null;
  /** The request id this reference was already paid under, if it was. */
  readonly duplicateOf: string | null;
  readonly paidToday: Cents;
  readonly policy: Policy;
  readonly policySigValid: boolean;

  /** Mochi's flags, on the email lane only. Cannot change the verdict. */
  readonly flags: readonly ScamFlag[];

  /**
   * The merchant's quoted price for this reference, in the deck scene only.
   *
   * Absent everywhere else, where nothing is quoted. `null` when the merchant
   * has no open quote for the reference — none exists, or another request is
   * already paying it. A collector fact like the rest: `gate()` only compares.
   */
  readonly quote?: Cents | null;

  /**
   * Percent of the approved budget above which the deck asks the buyer.
   *
   * Set only in the deck scene, beside the quote. Absent, a purchase inside
   * the budget passes. `gate()` compares this number and does not read it
   * from the environment.
   */
  readonly askThresholdPct?: number;
}

/* ---------- Decisions ---------- */

export type DecisionId = `D${number}`;

export type Choice = 'approve' | 'hold' | 'decline';

export const CHOICES = ['approve', 'hold', 'decline'] as const satisfies readonly Choice[];

export const isChoice = (s: string): s is Choice => (CHOICES as readonly string[]).includes(s);

/** Where an approval came from. A Telegram tap is trusted less than the phone. */
export type ApprovalOrigin = 'phone' | 'telegram';

export const isApprovalOrigin = (s: string): s is ApprovalOrigin =>
  s === 'phone' || s === 'telegram';

interface DecisionBase {
  readonly id: DecisionId;
  readonly check: CheckId;
  /** Why the owner is seeing this, in the gate's words. */
  readonly reason: string;
  /** One line for the Telegram message and the sidebar. */
  readonly short: string;
  /** What the agent says at the podium. */
  readonly text: string;
}

/**
 * A pending owner decision. Discriminated on `kind`, so resolving one is an
 * exhaustive switch rather than a stored callback.
 */
export type Decision =
  /** A sound request that exceeds what the crew may clear alone. */
  | (DecisionBase & {
      readonly kind: 'payment';
      readonly agent: 'shield';
      readonly requestId: string;
      readonly principal: string;
      readonly registryId: string;
      readonly origin: Origin;
      readonly amount: Cents;
      readonly reference: string;
      readonly scope: MandateScope;
      /** One line of payment history, shown on the approval sheet. */
      readonly history: string;
    })
  /** A request asked us to pay a different address than the one we hold. */
  | (DecisionBase & {
      readonly kind: 'receiver';
      readonly agent: 'shield';
      readonly requestId: string;
      readonly principal: string;
      readonly heldReceiver: string;
      readonly claimedReceiver: string;
      readonly amount: Cents;
    })
  /** A breach got through, and Tally drafted a tightening of one lamp. */
  | (DecisionBase & {
      readonly kind: 'tighten';
      readonly agent: 'tally';
      readonly lamp: LampId;
      /** What the tightening would change, in the owner's words. */
      readonly change: string;
      /** The attack that motivated it. */
      readonly attackId: string;
    });

export type DecisionKind = Decision['kind'];

/* ---------- The duel ---------- */

export type AttackKind =
  | 'revoked_agent'
  | 'internal_key'
  | 'mandate_edited'
  | 'scope_confusion'
  | 'over_mandate'
  | 'receiver_swap'
  | 'replay'
  | 'expired'
  | 'confused_deputy'
  | 'lookalike'
  | 'duplicate_reference'
  | 'injection';

export const ATTACK_LABEL: { readonly [K in AttackKind]: string } = {
  revoked_agent: 'Revoked agent, old signature',
  internal_key: 'Signed with one of our keys',
  mandate_edited: 'Mandate edited after signing',
  scope_confusion: 'Grant used outside its scope',
  over_mandate: 'Over the principal’s own cap',
  receiver_swap: 'Receiver swapped after signing',
  replay: 'Replayed envelope',
  expired: 'Expired envelope',
  confused_deputy: 'Real agent, wrong principal',
  lookalike: 'Lookalike registry id',
  duplicate_reference: 'Reference already paid',
  injection: 'Instructions hidden in prose',
};

export type AttackOutcome = 'pending' | 'blocked' | 'breach';

/**
 * One of Raven's attempts, as the duel lane draws it.
 *
 * `lampsCleared` fills the HP notches: an attack that gets past more lamps is
 * drawn as stronger, and five means it breached. The lamp that stopped it is
 * the card's epitaph.
 */
export interface Attack {
  readonly id: string;
  readonly day: number;
  readonly kind: AttackKind;
  readonly principal: string;
  readonly amount: Cents;
  readonly requestId: string | null;
  readonly lampsCleared: number;
  readonly blockedBy: CheckId | null;
  readonly outcome: AttackOutcome;
}

/* ---------- The case thread ---------- */

/**
 * Which part of the conversation a line belongs to.
 *
 * The order here is the order a case is discussed in: somebody opens it, the
 * sceptic raises a concern, the two checkers report what they read, they argue
 * where they differ, the gate states the verdict, and — only on an escalation
 * — each of them tells the owner what they would do.
 */
export type CaseBeat = 'open' | 'concern' | 'report' | 'argue' | 'verdict' | 'recommend';

export const BEAT_LABEL: { readonly [B in CaseBeat]: string } = {
  open: 'Intake',
  concern: 'Concern',
  report: 'Report',
  argue: 'Disagreement',
  verdict: 'Verdict',
  recommend: 'Recommendation',
};

/**
 * One line of the crew's conversation about a case.
 *
 * **A thread is written after the ruling and can never be an input to it.**
 * `GateContext` has no field for one, exactly as it has none for untrusted
 * prose, so a pet cannot argue a lamp into changing colour however persuasive
 * it is. What they *can* argue about is what the request means, how to check
 * it, and — when the gate asks the owner — what the owner should do. That last
 * one is advice, not authority, and two pets recommending opposite things is
 * the point rather than a bug.
 *
 * `from` is `'gate'` for the verdict line, which is drawn apart from the
 * conversation and stamped with the lamp that settled it.
 */
export interface CaseMessage {
  readonly id: number;
  readonly requestId: string;
  readonly from: AgentKey | 'gate';
  readonly beat: CaseBeat;
  readonly text: string;
  /** The lamp this line is citing, when it cites one. */
  readonly cites: CheckId | null;
}

/* ---------- Telegram ---------- */

/** Who sent a message in the Overduel HQ group. */
export type Sender = AgentKey | 'you' | 'system';

/** An inline button under a decision message. */
export interface TelegramButton {
  readonly label: string;
  readonly choice: Choice;
  readonly decisionId: DecisionId;
}

export interface TelegramMessage {
  readonly id: number;
  readonly from: Sender;
  /** Display name, e.g. "Bolt (bot)". */
  readonly name: string;
  /** `HH:MM` on the demo clock. */
  readonly time: string;
  readonly text: string;
  readonly buttons: readonly TelegramButton[];
  /** Set once the owner used one of the buttons; they then grey out. */
  readonly decided: Choice | null;
}

/* ---------- The event log ---------- */

export interface LogEvent {
  readonly seq: number;
  readonly day: number;
  /** `HH:MM` on the demo clock. */
  readonly time: string;
  readonly text: string;
  readonly verdict: Verdict;
  readonly check: CheckId;
  /**
   * Who did it, when it was one of the crew.
   *
   * Null for the lines that belong to nobody — the clock turning over, a
   * ruling the gate reached, the owner's own taps. The activity panel puts a
   * portrait against the rest.
   */
  readonly agent: AgentKey | null;
}

/* ---------- The snapshot: the whole contract between server and browser ---------- */

/** The last ruling, as the vault lamps draw it. */
export interface RulingView {
  readonly requestId: string;
  readonly principal: string;
  readonly amount: Cents;
  readonly origin: Origin;
  readonly verdict: Verdict;
  readonly check: CheckId;
  readonly checks: readonly CheckResult[];
  /** The deck scene's two questions. Absent in Overduel's scene and on older rows. */
  readonly summary?: RulingSummary;
}

/* ---------- The deck scene's two questions ---------- */

/**
 * The gate's five lamps, read as the two questions a buyer would ask before a
 * payment: WHO sent this, and MAY it spend?
 *
 * Display only. The gate still runs every lamp in `LAMPS` order and the
 * verdict is unchanged; this only regroups the results. WHO is the enrolled
 * key and a signature over this exact request. MAY is the merchant, the
 * buyer's grant and the budget — which a valid signature alone never answers.
 */
export type Question = 'WHO' | 'MAY';

export const WHO_LAMPS = ['AGENT_IDENTITY', 'INTENT_BINDING'] as const satisfies readonly LampId[];
export const MAY_LAMPS = ['COUNTERPARTY', 'MANDATE', 'OUR_POLICY'] as const satisfies readonly LampId[];

export const QUESTION_OF: { readonly [L in LampId]: Question } = {
  AGENT_IDENTITY: 'WHO',
  INTENT_BINDING: 'WHO',
  COUNTERPARTY: 'MAY',
  MANDATE: 'MAY',
  OUR_POLICY: 'MAY',
};

/** Each lamp's one-word name in the deck scene. */
export const TERM_LABEL: { readonly [L in LampId]: string } = {
  AGENT_IDENTITY: 'key',
  INTENT_BINDING: 'signature',
  COUNTERPARTY: 'merchant',
  MANDATE: 'grant',
  OUR_POLICY: 'budget',
};

/** One lamp's result, in the deck's words. */
export interface TermView {
  readonly lamp: LampId;
  readonly outcome: CheckOutcome;
  readonly text: string;
}

/**
 * How one question came out.
 *
 * `not_reached` is MAY's answer when WHO failed: a gateway has no business
 * asking what an unidentified sender may spend. The gate still evaluated those
 * lamps — it always runs all five — and `RulingSummary.footnote` says what it
 * found, so nothing is hidden.
 */
export type AnswerState = 'yes' | 'no' | 'ask' | 'not_reached';

export interface Answer {
  readonly state: AnswerState;
  readonly terms: readonly TermView[];
}

export interface RulingSummary {
  readonly who: Answer;
  readonly may: Answer;
  /** When MAY was not reached: what the gate found on that side anyway. */
  readonly footnote: string | null;
}

/* ---------- The AgentTrust deck scene ---------- */

/**
 * Whether a charge was really made in the PayPal Sandbox.
 *
 * `live` is a capture PayPal confirmed. `simulated` is what the scene records
 * when no Sandbox credentials are configured — the budget still moves, and
 * every screen labels it SIM rather than REAL.
 */
export type ChargeMode = 'live' | 'simulated';

/**
 * Where the buyer's PayPal Sandbox wallet stands. The wallet token itself never
 * leaves the server: this is all the browser is told.
 *
 * - `none`      nothing connected yet, or PayPal did not confirm what was saved
 * - `checking`  PayPal is being asked whether a saved or configured wallet is valid
 * - `waiting`   a setup was started and PayPal is waiting for the buyer to agree
 * - `cancelled` the buyer backed out on PayPal's page; nothing was saved
 * - `expired`   PayPal no longer has that setup; a retry starts a fresh one
 * - `connected` a wallet PayPal has confirmed for this merchant app
 */
export type WalletState = 'none' | 'checking' | 'waiting' | 'cancelled' | 'expired' | 'connected';

/**
 * Where a connected wallet came from.
 *
 * `consent` was saved through PayPal's consent page in this app. `configured` is
 * a pre-authorized Sandbox wallet set on the server, so a judge needs no login.
 * `tested_run` is the wallet `sandbox/paypal.mjs` saved for the same merchant
 * app. `simulated` is what a server without Sandbox credentials records.
 */
export type WalletSource = 'consent' | 'configured' | 'tested_run' | 'simulated';

export interface WalletView {
  readonly state: WalletState;
  /** `live` when this server holds PayPal Sandbox credentials. */
  readonly mode: ChargeMode;
  readonly source: WalletSource | null;
  /** Why it is not connected, in plain words, when there is a reason to show. */
  readonly note: string | null;
  /** The server knows a saved or configured wallet it can ask PayPal about again. */
  readonly canRecheck: boolean;
}

/**
 * Step two, the Deck Agent's budget, in the order the buyer meets it:
 * connect the wallet, then approve the budget. Purchases need both.
 */
export type GrantStatus = 'needs_wallet' | 'needs_approval' | 'active' | 'revoked';

/**
 * The buyer's grant to its agent, as the deck scene shows it.
 *
 * Local prototype behaviour standing in for a proposed PayPal service: the
 * agent registry, the budget and revocation. The wallet is separate — see
 * `WalletView` — because it is the one part PayPal itself confirms.
 *
 * The enforced limit is still the signed `Policy` row — this view reads it and
 * never holds a number of its own.
 */
export interface GrantView {
  readonly principal: string;
  readonly merchant: string;
  readonly registryId: string;
  /** Short fingerprint of the enrolled agent key. */
  readonly keyPrint: string;
  readonly budget: Cents;
  /** Captured by PayPal, or recorded when simulated. */
  readonly spent: Cents;
  /** Held for charges still with PayPal, so a second request cannot spend it. */
  readonly reserved: Cents;
  readonly left: Cents;
  /**
   * A purchase above this percent of `budget` asks the buyer before PayPal
   * is called. So does the purchase that first takes cumulative spend past it.
   */
  readonly askThresholdPct: number;
  /** When the grant ends, in words — `end of tonight`. */
  readonly until: string;
  readonly status: GrantStatus;
  /** The buyer approved this run's budget. Every run asks again. */
  readonly approved: boolean;
  /**
   * A budget change the agent asked for and the buyer has not answered.
   * Approving it is a page action. The grant itself is unchanged while this is set.
   */
  readonly pendingBudgetRequest: {
    readonly requestId: string;
    readonly current: Cents;
    readonly requested: Cents;
    readonly reason: string;
  } | null;
}

/** Saved-wallet charges PayPal has not settled, kept across demo resets. */
export interface UnresolvedView {
  readonly count: number;
  /** How many belong to an earlier run of the demo. */
  readonly fromEarlierRuns: number;
  /** How many have no PayPal order id, so can only be checked by hand. */
  readonly withoutOrder: number;
}

export type SlotState = 'locked' | 'charging' | 'unlocked' | 'needs_you' | 'blocked';

/** One image in the deck, and the purchase that unlocks it. */
export interface DeckSlot {
  readonly id: string;
  readonly title: string;
  readonly price: Cents;
  readonly reference: string;
  readonly state: SlotState;
  readonly requestId: string | null;
  /** Why it is not unlocked, in the gate's or PayPal's words. */
  readonly note: string | null;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly mode: ChargeMode | null;
}

/* ---------- The deck scene's three test requests ---------- */

/**
 * The demo senders that can submit a merchant quote.
 *
 * - `impostor`   relays to the Deck Agent's own model and copies its grant,
 *                but signs with a key nobody enrolled — identity fails
 * - `other_shop` the real Deck Agent and its enrolled key, at a shop the
 *                buyer's grant does not cover — authorization fails
 * - `agent`      the real Deck Agent at the grant's shop — PayPal is called
 */
export type BoardSender = 'impostor' | 'other_shop' | 'agent';

export const BOARD_SENDERS = ['impostor', 'other_shop', 'agent'] as const satisfies readonly BoardSender[];

/**
 * Model evidence about a sender: which reference model its answers to numeric
 * probes resemble. Always simulated in this demo — hand-written answers, not a
 * measurement — and always advisory: the gate has no input for it.
 */
export interface EvidenceView {
  /** The reference model it resembles, or null when none is close enough. */
  readonly resembles: string | null;
  /** The best similarity found, 0 to 1. */
  readonly score: number;
  /** The closest reference, even when it is not close enough to name. */
  readonly closest: string;
  readonly probes: number;
  readonly samples: number;
}

/**
 * What PayPal did for one request.
 *
 * `not_called` is a fact about this server: no PayPal call was made. The rest
 * follow the charge PayPal answered — or, in a server without credentials, the
 * one recorded as simulated.
 */
export type PayPalOutcome =
  | 'not_called'
  | 'calling'
  | 'captured'
  | 'simulated'
  | 'needs_buyer'
  | 'refused'
  | 'unknown';

export interface PayPalView {
  readonly outcome: PayPalOutcome;
  readonly mode: ChargeMode | null;
  readonly amount: Cents;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly note: string | null;
}

/**
 * Whether a test request can go now. `locked` until the wallet is connected and
 * the budget approved, while the agents are paused or a charge is with PayPal,
 * and — for the paying request — once its image is bought. Each goes once a run.
 */
export type SendState = 'locked' | 'ready' | 'sent';

export interface RequestQuote {
  readonly reference: string;
  readonly item: string;
  readonly amount: Cents;
}

/** One of the three test requests, and what happened to it this run. */
export interface SendView extends RequestQuote {
  readonly sender: BoardSender;
  /** 1 to 3, as the page lists them. */
  readonly n: number;
  readonly title: string;
  /** The title in a few words, for a tab. */
  readonly short: string;
  /** What the request is meant to show: "Identity fails", "Authorization fails", "PayPal pays". */
  readonly shows: string;
  /** What this sender presents, before it is sent. */
  readonly blurb: string;
  /**
   * True for the impostor. Every test sender is scripted by this demo — the
   * Deck Agent too — so this marks whose key it is, not what is real.
   */
  readonly impostor: boolean;
  /** The agent the request claims to come from, and its name. */
  readonly registryId: string;
  readonly agentName: string;
  readonly merchant: string;
  /** Quotes the UI can offer for this sender. The server validates the choice again at send time. */
  readonly availableQuotes: readonly RequestQuote[];
  readonly state: SendState;
  readonly requestId: string | null;
  /** Shown once sent. */
  readonly evidence: EvidenceView | null;
  readonly verdict: Verdict | null;
  readonly summary: RulingSummary | null;
  readonly paypal: PayPalView | null;
  /** One line on what happened, once sent. */
  readonly caption: string | null;
}

/* ---------- The live connector: one run from chat to receipt ---------- */

/**
 * What the numeric model signal said about one reply.
 *
 * - `match`        the closest calibrated reference is the model the enrolled
 *                  agent is declared to run, at or above its calibrated threshold
 * - `other_model`  it matched a calibrated reference for a different model
 * - `unknown`      nothing in the tested reference set is close enough
 * - `insufficient` too few integers to score
 * - `invalid`      not a list of integers in the asked range
 * - `no_reference` the expected model has no calibrated reference yet
 * - `recorded`     calibration mode: kept as a reference sample, not scored
 *
 * A statement about the tested reference set and nothing more. It decides
 * whether this run is offered a signing challenge; `GateContext` has no field
 * for it, so it never reaches a ruling.
 */
export type ModelSignalResult =
  | 'match'
  | 'other_model'
  | 'unknown'
  | 'insufficient'
  | 'invalid'
  | 'no_reference'
  | 'recorded';

/** One reference the reply was compared with. */
export interface ModelCandidateView {
  readonly label: string;
  /** Similarity to this reference, 0 to 1. */
  readonly score: number;
  /** The calibrated match threshold, or null while this reference has too few samples. */
  readonly threshold: number | null;
  readonly samples: number;
  /** A generated baseline rather than a measured model. It can be closest; it never matches. */
  readonly synthetic: boolean;
}

export interface ModelSignalView {
  readonly result: ModelSignalResult;
  /** Which probe was asked, so a result is never read against another probe's references. */
  readonly probe: string;
  /** Integers received, and how many the prompt asked for. */
  readonly received: number;
  readonly asked: number;
  /** The model the enrolled agent is declared to run, or null when none is set. */
  readonly expectedModel: string | null;
  /** The closest reference from this run, even when it is not a match. */
  readonly closest: string | null;
  readonly score: number | null;
  readonly threshold: number | null;
  /** Every reference compared, closest first. */
  readonly candidates: readonly ModelCandidateView[];
  /** One line saying what was found, in plain words. */
  readonly note: string;
}

/**
 * Which proof counts as the Demo Agent's identity. Either one is enough.
 *
 * - `local`   the signer's Ed25519 key, enrolled on this server
 * - `erc8004` the on-chain registration
 */
export type IdentityMode = 'local' | 'erc8004';

/**
 * Where the Demo Agent's enrollment stands.
 *
 * - `none`       no signer key has been enrolled; the scripted practice key is in the registry
 * - `verified`   the ERC-8004 registration was read on-chain and its owner is the expected wallet
 * - `local`      the signer's key is enrolled on this server. In `local` identity mode that is a
 *                complete pass. In `erc8004` mode it means no registration was configured, which is not.
 * - `failed`     a check answered, and the identity is not the expected one
 * - `unresolved` the chain or the signer could not be read, so nothing was established
 *
 * Only `verified` and `local` put the signer's key in the registry as active.
 * The request signature is checked the same way in both identity modes.
 */
export type EnrollmentStatus = 'none' | 'verified' | 'local' | 'failed' | 'unresolved';

/** Whether the on-chain registration names the key that was enrolled here. */
export type KeyBinding = 'matches' | 'differs' | 'not_stated' | 'unreadable';

export interface EnrollmentView {
  readonly status: EnrollmentStatus;
  /** Which proof this enrollment is judged by. */
  readonly identityMode: IdentityMode;
  readonly registryId: string;
  readonly agentName: string;
  /** Short fingerprint of the signer key this enrollment is about, or null when there is none. */
  readonly keyPrint: string | null;
  /** The enrolled Ed25519 public key, base64url, or null before one was read. */
  readonly publicKey: string | null;
  /** That key is the one the registry verifies requests against right now. */
  readonly active: boolean;
  /** An ERC-8004 registration is configured to be checked. */
  readonly configured: boolean;
  readonly network: string | null;
  readonly chainId: number | null;
  /** The Identity Registry contract. */
  readonly registry: string | null;
  readonly agentId: string | null;
  /** The registration's owner as the chain reported it. */
  readonly owner: string | null;
  readonly expectedOwner: string | null;
  readonly keyBinding: KeyBinding | null;
  /** The block the registration was read at. */
  readonly blockNumber: number | null;
  /** When it was read, in epoch milliseconds. */
  readonly checkedAt: number | null;
  /** A public explorer page for the registration, when the network has one. */
  readonly explorerUrl: string | null;
  /** The actual result when it is not verified, or the latest refresh that failed. */
  readonly note: string | null;
}

/**
 * How far one live run got. Persisted on the server and derived from what was
 * recorded, so the chat, the page and the payment attempt always agree.
 */
export type LiveStage =
  | 'awaiting_reply'
  | 'model_not_matched'
  | 'awaiting_signature'
  | 'expired'
  | 'verifying'
  | 'identity_failed'
  | 'authorization_failed'
  | 'needs_buyer'
  | 'charging'
  | 'paid'
  | 'simulated'
  | 'payment_failed'
  | 'payment_unconfirmed';

/** Stages after which a run does nothing more. */
export const LIVE_FINAL_STAGES = [
  'model_not_matched',
  'expired',
  'identity_failed',
  'authorization_failed',
  'needs_buyer',
  'paid',
  'simulated',
  'payment_failed',
] as const satisfies readonly LiveStage[];

export const isFinalLiveStage = (stage: LiveStage): boolean =>
  (LIVE_FINAL_STAGES as readonly LiveStage[]).includes(stage);

/** How one of a run's later checks came out. `pending` is not yet asked; `skipped` was never reached. */
export type LiveCheck = 'pending' | 'passed' | 'failed' | 'ask' | 'skipped';

/** One run through the live connector, as the verification page draws it. */
export interface LiveRunView {
  readonly runId: string;
  readonly stage: LiveStage;
  readonly quote: RequestQuote & { readonly merchant: string };
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Layer 1: the numeric challenge, the reply exactly as it arrived, and what it resembled. */
  readonly prompt: string;
  readonly challengeExpiresAt: number;
  readonly reply: string | null;
  readonly signal: ModelSignalView | null;
  /** Layer 2: the one-time signing challenge, and whether the signed request verified. */
  readonly nonce: string | null;
  readonly signExpiresAt: number | null;
  readonly requestId: string | null;
  readonly signature: LiveCheck;
  readonly signatureNote: string | null;
  /** Layer 3: the buyer's grant, as one line. */
  readonly authorization: LiveCheck;
  readonly authorizationLine: string | null;
  readonly verdict: Verdict | null;
  readonly summary: RulingSummary | null;
  readonly paypal: PayPalView | null;
  /** Why the run stopped, when it stopped before the gate. */
  readonly note: string | null;
  /**
   * What the agent actually signed for this run, once a signature exists.
   * Null when the signer refused before signing.
   */
  readonly signed: SignedPayloadView | null;
}

/** The purchase bytes a live run's signature covers, and whether that signature verified. */
export interface SignedPayloadView {
  readonly amount: Cents;
  readonly merchant: string;
  readonly item: string;
  readonly runId: string;
  readonly grantCap: Cents;
  readonly signature: string;
  readonly verified: boolean;
  /** Why verification failed, when it did. */
  readonly reason: string | null;
}

/** What the connector's own process knows: who called last, and whether its parts are in place. */
export interface ConnectorView {
  /** Where the MCP route listens on this machine. Never the token. */
  readonly endpoint: string;
  /** When a connector client last called a tool, in epoch milliseconds. */
  readonly lastCallAt: number | null;
  readonly lastTool: string | null;
  readonly signer: 'reachable' | 'unreachable' | 'not_checked';
  readonly signerNote: string | null;
  /** The model the enrolled agent is declared to run. */
  readonly expectedModel: string | null;
  /** Reference samples held for that model, and how many calibration needs. */
  readonly referenceSamples: number;
  readonly referenceNeeded: number;
  readonly calibrated: boolean;
  /** Set while replies are being recorded as reference samples under this label. */
  readonly calibratingAs: string | null;
}

/**
 * Everything the studio needs to draw a frame. The server owns the world and
 * sends one of these; the browser renders it and decides nothing. This is the
 * only shape that crosses the wire, so a field the client reads is a field the
 * server has promised.
 */
export interface Snapshot {
  /** Bumped on every change. The client re-renders only when this moves. */
  readonly seq: number;
  readonly day: number;
  /** Minutes since midnight on the demo clock. */
  readonly minute: number;
  readonly paused: boolean;
  readonly balance: Cents;
  /** Paid out today, the vault's receipt for everything that cleared. */
  readonly clearedToday: Cents;
  readonly clearedCount: number;
  readonly blockedToday: number;
  /** The defence streak: attempts and blocks this week. */
  readonly attemptsWeek: number;
  readonly blockedWeek: number;
  readonly agents: readonly Agent[];
  readonly requests: readonly Request[];
  readonly vendors: readonly VendorRecord[];
  readonly registry: readonly RegistryEntry[];
  readonly policy: Policy;
  readonly decisions: readonly Decision[];
  readonly inbox: readonly InboxItem[];
  readonly attacks: readonly Attack[];
  /** The crew's conversation about the most recent case. */
  readonly thread: readonly CaseMessage[];
  /** What the vault is showing, if anything has been gated yet. */
  readonly lastRuling: RulingView | null;
  /** Which decision is at the podium right now, if any. */
  readonly podium: DecisionId | null;
  readonly telegram: readonly TelegramMessage[];
  readonly events: readonly LogEvent[];
  /** The deck scene's grant, or null in the Overduel scene. */
  readonly grant: GrantView | null;
  /** The PayPal Sandbox wallet's connection status, or null in the Overduel scene. Never a token. */
  readonly wallet: WalletView | null;
  /** The deck's images, in order. Empty in the Overduel scene. */
  readonly deck: readonly DeckSlot[];
  /** The three test requests, in order. Empty in the Overduel scene. */
  readonly sends: readonly SendView[];
  /** How many times PayPal asked the buyer to act after setup, this run. Zero is the point. */
  readonly buyerPrompts: number;
  /** Charges still waiting on PayPal, this run and earlier ones. */
  readonly unresolved: UnresolvedView;
  /** The latest run through the live connector, or null when none has started this run. */
  readonly live: LiveRunView | null;
  /** The Demo Agent's enrollment, or null in the Overduel scene. */
  readonly enrollment: EnrollmentView | null;
  /** The live connector's own state, or null when this server is not serving it. */
  readonly connector: ConnectorView | null;
}

export type VerificationSnapshot = Pick<Snapshot, 'seq' | 'grant' | 'wallet' | 'live' | 'enrollment' | 'connector'>;

/* ---------- Derived read-outs, shared by every view ---------- */

/**
 * Which state an agent is in. The desk lamp, the roster chip and the name
 * plate all call this, so they always agree.
 */
export function agentState(agent: Agent, snap: Snapshot): AgentState {
  if (agent.key === 'raven') return 'redteam';
  if (snap.paused) return 'paused';
  if (agent.status === 'wait') return 'waiting';
  // An agent holds amber while a decision of its own is pending, even once it
  // is back at its desk, because the hold outlives the walk.
  if (snap.decisions.some((d) => d.agent === agent.key)) return 'holding';
  if (agent.pose === 'sleep' || agent.pose === 'chill' || isBreakStation(agent.at)) return 'break';
  return 'working';
}

export const STATE_LABEL: { readonly [S in AgentState]: string } = {
  working: 'WORKING',
  waiting: 'WAITING',
  break: 'ON A BREAK',
  holding: 'HOLDING',
  paused: 'PAUSED',
  redteam: 'RED TEAM',
};
