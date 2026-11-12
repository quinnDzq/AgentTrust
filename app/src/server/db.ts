/**
 * The world, on disk.
 *
 * SQLite is the only source of truth. The engine reads a `Snapshot`, decides,
 * writes rows, and bumps `seq`; the browser polls and draws. There is no second
 * in-memory copy to drift from, which is what lets a verified PayPal webhook
 * land in the same world the studio is drawing.
 *
 * `bun:sqlite` is synchronous, so a whole-world read is a handful of
 * microseconds and we can afford to do it on every tick and every request.
 *
 * Money is stored as integer cents in `INTEGER` columns. Nothing here is a
 * float.
 *
 * Two tables are append-only and never updated or deleted from: `events`, the
 * audit log, and `nonces`, which is what makes a replay detectable. A third,
 * `payouts`, is unique on the PayPal event id, which is what makes a webhook
 * arriving twice harmless.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BOARD_SLOT, boardQuotes, captionFor, paypalView, SENDERS } from './board.ts';
import { fingerprint } from './crypto.ts';
import { DECK } from './deck.ts';
import { evidenceFor } from './evidence.ts';
import { buildLiveView } from './liveview.ts';
import {
  BOARD_SENDERS,
  cents,
  maxZero,
  subCents,
  type BoardSender,
  type ConnectorView,
  type EnrollmentStatus,
  type EnrollmentView,
  type IdentityMode,
  type KeyBinding,
  type LiveRunView,
  type RulingSummary,
  type SendView,
  type ChargeMode,
  type DeckSlot,
  type GrantStatus,
  type GrantView,
  type UnresolvedView,
  type WalletSource,
  type WalletView,
  isLevel,
  isOrigin,
  isPose,
  isStation,
  type Agent,
  type AgentKey,
  type Attack,
  type AttackKind,
  type AttackOutcome,
  type CaseBeat,
  type CaseMessage,
  type Cents,
  type CheckId,
  type CheckOutcome,
  type CheckResult,
  type Decision,
  type DecisionId,
  type Envelope,
  type Facing,
  type InboxItem,
  type LampId,
  type Level,
  type LogEvent,
  type MandateScope,
  type MonitorLine,
  type Origin,
  type Policy,
  type Pose,
  type RegistryEntry,
  type RegistryStatus,
  type Request,
  type RequestStatus,
  type Ruling,
  type RulingView,
  type Sender,
  type Snapshot,
  type Station,
  type TelegramButton,
  type TelegramMessage,
  type VendorRecord,
  type Verdict,
} from '../types.ts';

/** How many log rows ride along in a snapshot. The audit view pages the rest. */
export const SNAPSHOT_EVENT_LIMIT = 80;

/** How much of the Telegram history the panel keeps on screen. */
export const TELEGRAM_LIMIT = 60;

/** How many requests the board shows. Older ones stay in the log. */
export const REQUEST_LIMIT = 40;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  seq            INTEGER NOT NULL,
  day            INTEGER NOT NULL,
  minute         INTEGER NOT NULL,
  paused         INTEGER NOT NULL,
  balance        INTEGER NOT NULL,
  cleared_today  INTEGER NOT NULL,
  cleared_count  INTEGER NOT NULL,
  blocked_today  INTEGER NOT NULL,
  attempts_week  INTEGER NOT NULL,
  blocked_week   INTEGER NOT NULL,
  decision_seq   INTEGER NOT NULL,
  request_seq    INTEGER NOT NULL,
  attack_seq     INTEGER NOT NULL,
  podium         TEXT,
  last_ruling    TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  key      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  role     TEXT NOT NULL,
  level    INTEGER NOT NULL,
  xp       INTEGER NOT NULL,
  desk     INTEGER NOT NULL,
  status   TEXT NOT NULL,
  station  TEXT NOT NULL,
  slot     INTEGER NOT NULL,
  pose     TEXT NOT NULL,
  facing   TEXT NOT NULL,
  say      TEXT,
  doing    TEXT NOT NULL,
  lines    TEXT NOT NULL,
  ord      INTEGER NOT NULL
);

-- The agent registry: whose key is whose, and whether it is still live.
CREATE TABLE IF NOT EXISTS registry (
  registry_id TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  principal   TEXT NOT NULL,
  status      TEXT NOT NULL,
  revoked_day INTEGER
);

-- Who we pay, where, and the key their grants are signed with.
CREATE TABLE IF NOT EXISTS vendors (
  principal     TEXT PRIMARY KEY,
  receiver      TEXT NOT NULL,
  principal_key TEXT NOT NULL,
  paid_count    INTEGER NOT NULL,
  max_paid      INTEGER NOT NULL,
  mean_paid     INTEGER NOT NULL
);

-- The owner's own mandate to the crew. One row, signed.
CREATE TABLE IF NOT EXISTS policy (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  expires_day    INTEGER NOT NULL,
  daily_total    INTEGER NOT NULL,
  telegram_cap   INTEGER NOT NULL,
  per_payment    TEXT NOT NULL,
  origin_ceiling TEXT NOT NULL,
  signature      TEXT NOT NULL
);

-- One row per payment request. \`envelope\` is the request exactly as it
-- arrived, kept verbatim so a ruling can always be re-derived from it.
CREATE TABLE IF NOT EXISTS requests (
  id          TEXT PRIMARY KEY,
  origin      TEXT NOT NULL,
  principal   TEXT NOT NULL,
  registry_id TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  reference   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  status      TEXT NOT NULL,
  day         INTEGER NOT NULL,
  verdict     TEXT,
  lamp        TEXT,
  attack_id   TEXT,
  envelope    TEXT NOT NULL,
  sort        INTEGER NOT NULL
);

-- Every lamp's result for every request. Append-only, like the log.
CREATE TABLE IF NOT EXISTS gate_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  check_id   TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  note       TEXT NOT NULL,
  ord        INTEGER NOT NULL
);

-- Every nonce ever seen. Append-only: this table *is* the replay defence.
CREATE TABLE IF NOT EXISTS nonces (
  nonce   TEXT PRIMARY KEY,
  day     INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);

-- What actually left. Unique on the PayPal event id, so a webhook delivered
-- twice pays once.
CREATE TABLE IF NOT EXISTS payouts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  batch_id   TEXT,
  event_id   TEXT UNIQUE,
  status     TEXT NOT NULL,
  day        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attacks (
  id            TEXT PRIMARY KEY,
  day           INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  principal     TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  request_id    TEXT,
  lamps_cleared INTEGER NOT NULL,
  blocked_by    TEXT,
  outcome       TEXT NOT NULL,
  sort          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,
  agent   TEXT NOT NULL,
  check_id TEXT NOT NULL,
  reason  TEXT NOT NULL,
  short   TEXT NOT NULL,
  body    TEXT NOT NULL,
  payload TEXT NOT NULL,
  sort    INTEGER NOT NULL
);

-- Tightenings the owner has adopted. Parameters for existing lamps only;
-- there is no row here that can introduce new logic.
CREATE TABLE IF NOT EXISTS adopted_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lamp        TEXT NOT NULL,
  change      TEXT NOT NULL,
  attack_id   TEXT NOT NULL,
  adopted_day INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  id         TEXT PRIMARY KEY,
  origin     TEXT NOT NULL,
  label      TEXT NOT NULL,
  suspicious INTEGER NOT NULL,
  sort       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sender  TEXT NOT NULL,
  name    TEXT NOT NULL,
  time    TEXT NOT NULL,
  text    TEXT NOT NULL,
  buttons TEXT NOT NULL,
  decided TEXT
);

CREATE TABLE IF NOT EXISTS events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  day      INTEGER NOT NULL,
  time     TEXT NOT NULL,
  text     TEXT NOT NULL,
  verdict  TEXT NOT NULL,
  check_id TEXT NOT NULL,
  agent    TEXT
);

-- The crew's conversation about a case. Written after the ruling, never read
-- by the gate: see the note at the top of src/server/thread.ts.
CREATE TABLE IF NOT EXISTS case_thread (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  sender     TEXT NOT NULL,
  beat       TEXT NOT NULL,
  text       TEXT NOT NULL,
  cites      TEXT,
  ord        INTEGER NOT NULL
);

-- The deck scene's run: the budget the buyer is asked to approve, and whether
-- they did. Wiped by a demo reset, so every run asks for approval again.
CREATE TABLE IF NOT EXISTS deck_grant (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  run_id      TEXT NOT NULL,
  registry_id TEXT NOT NULL,
  merchant    TEXT NOT NULL,
  budget      INTEGER NOT NULL,
  mode        TEXT NOT NULL,
  approved    INTEGER NOT NULL,
  -- Percent of the budget above which a purchase asks the buyer. Null on a
  -- database created before the column existed; that is read as 50.
  ask_pct     INTEGER
);

-- A budget change the agent asked for. The grant row is unchanged until the
-- buyer approves it on the verify page. One pending row per run; a newer
-- request marks the earlier one declined.
CREATE TABLE IF NOT EXISTS budget_requests (
  request_id  TEXT PRIMARY KEY,
  deck_run_id TEXT NOT NULL,
  amount      INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL,
  note        TEXT,
  resulting   INTEGER,
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);

-- The current attempt to save a PayPal wallet. PayPal's return must carry its
-- attempt id. Wiped by a reset, so a return for an abandoned attempt is refused.
-- Server-only: the setup token and approval link never go into a snapshot.
CREATE TABLE IF NOT EXISTS wallet_setup (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  attempt_id       TEXT NOT NULL,
  status           TEXT NOT NULL,
  setup_request_id TEXT NOT NULL,
  setup_id         TEXT,
  approval_url     TEXT,
  vault_request_id TEXT,
  note             TEXT,
  created_at       INTEGER NOT NULL
);

-- The PayPal Sandbox wallet. NOT wiped by a demo reset, so a replay needs no
-- new login. Server-only: no snapshot is built from either token column.
CREATE TABLE IF NOT EXISTS paypal_wallet (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  app_hash        TEXT,
  saved_vault_id  TEXT,
  mode            TEXT NOT NULL,
  status          TEXT NOT NULL,
  source          TEXT,
  active_vault_id TEXT,
  note            TEXT,
  recheck         INTEGER NOT NULL,
  verified_at     INTEGER
);

-- The deck scene's board: which request each of the four senders sent, this
-- run. One row per sender, so each is sent once; a reset replays the board.
CREATE TABLE IF NOT EXISTS deck_sends (
  sender     TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  sent_at    INTEGER NOT NULL
);

-- Each deck ruling as the two questions, WHO and MAY. Written once, with the
-- ruling, from the facts the gate was given; display only.
CREATE TABLE IF NOT EXISTS deck_rulings (
  request_id TEXT PRIMARY KEY,
  summary    TEXT NOT NULL
);

-- The deck's images, and the request that is buying each one.
CREATE TABLE IF NOT EXISTS deck_slots (
  id         TEXT PRIMARY KEY,
  ord        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  price      INTEGER NOT NULL,
  reference  TEXT NOT NULL,
  request_id TEXT
);

-- Saved-wallet charges, written *before* PayPal is called, as the tested
-- script does: an attempt that dies mid-call still has its invoice id and
-- PayPal-Request-Id on disk, so it can be reconciled and never repeated blind.
-- NOT wiped by a demo reset, so an unresolved charge outlives its run. Keyed by
-- the PayPal-Request-Id because request ids start again at R-0001 each run.
CREATE TABLE IF NOT EXISTS paypal_charges (
  paypal_request_id TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  request_id        TEXT NOT NULL,
  reference         TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  invoice_id        TEXT NOT NULL,
  mode              TEXT NOT NULL,
  status            TEXT NOT NULL,
  order_id          TEXT,
  capture_id        TEXT,
  note              TEXT,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS paypal_charges_run ON paypal_charges (run_id, request_id);

-- One run through the live connector: the quote, the numeric challenge and the
-- reply exactly as it arrived, the one-time signing challenge, and the request
-- it became. One row correlates the chat's tool calls, the verification page
-- and the payment attempt. Wiped by a demo reset, like the rest of a night.
CREATE TABLE IF NOT EXISTS live_runs (
  run_id               TEXT PRIMARY KEY,
  deck_run_id          TEXT NOT NULL,
  merchant             TEXT NOT NULL,
  reference            TEXT NOT NULL,
  title                TEXT NOT NULL,
  amount               INTEGER NOT NULL,
  stage                TEXT NOT NULL,
  prompt               TEXT NOT NULL,
  challenge_expires_at INTEGER NOT NULL,
  reply                TEXT,
  reply_attempts       INTEGER NOT NULL,
  signal               TEXT,
  nonce                TEXT,
  sign_expires_at      INTEGER,
  request_id           TEXT,
  note                 TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS live_runs_created ON live_runs (created_at);

-- The Demo Agent's enrollment: the signer's public key, and — when identity
-- mode is erc8004 — what the chain said about its registration when it was
-- last read. NOT wiped by a demo reset, so the payment-time check runs on the
-- local record and a replay needs no new chain read. Holds no private key and
-- no wallet secret. identity_mode is local or erc8004.
CREATE TABLE IF NOT EXISTS agent_enrollment (
  registry_id    TEXT PRIMARY KEY,
  pubkey         TEXT,
  status         TEXT NOT NULL,
  identity_mode  TEXT,
  network        TEXT,
  chain_id       INTEGER,
  registry       TEXT,
  agent_id       TEXT,
  owner          TEXT,
  expected_owner TEXT,
  key_binding    TEXT,
  block_number   INTEGER,
  checked_at     INTEGER,
  explorer_url   TEXT,
  note           TEXT
);

-- What the connector's own process knows: who called last, whether the signer
-- answers, how far calibration is. One row of JSON, rewritten as it changes,
-- so a snapshot is still built from the database and nothing else.
CREATE TABLE IF NOT EXISTS connector_state (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  view TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_seq_desc ON events (seq DESC);
CREATE INDEX IF NOT EXISTS requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS requests_reference ON requests (reference);
CREATE INDEX IF NOT EXISTS gate_runs_request ON gate_runs (request_id, ord);
CREATE INDEX IF NOT EXISTS case_thread_request ON case_thread (request_id, ord);
`;

/**
 * Every table a reset wipes, newest-dependency last. `wipe` walks this in order.
 *
 * `paypal_wallet` and `paypal_charges` are deliberately not here: `wipe` starts
 * a new run without dropping a charge PayPal has not settled. The live view's
 * Reset button forgets the consent-saved wallet itself, so the next run asks
 * for PayPal login again unless `PAYPAL_SANDBOX_VAULT_ID` is set.
 * `agent_enrollment` and `connector_state` stay too: the Demo Agent's key and
 * its checked registration are set up once, before any run.
 */
const TABLES = [
  'live_runs',
  'deck_sends',
  'deck_rulings',
  'deck_slots',
  'wallet_setup',
  'budget_requests',
  'deck_grant',
  'case_thread',
  'events',
  'telegram',
  'inbox',
  'adopted_rules',
  'decisions',
  'attacks',
  'payouts',
  'nonces',
  'gate_runs',
  'requests',
  'policy',
  'vendors',
  'registry',
  'agents',
  'world',
] as const;

/* ---------- Row shapes, as SQLite hands them back ---------- */

interface WorldRow {
  seq: number;
  day: number;
  minute: number;
  paused: number;
  balance: number;
  cleared_today: number;
  cleared_count: number;
  blocked_today: number;
  attempts_week: number;
  blocked_week: number;
  decision_seq: number;
  request_seq: number;
  attack_seq: number;
  podium: string | null;
  last_ruling: string | null;
}

interface AgentRow {
  key: string;
  name: string;
  role: string;
  level: number;
  xp: number;
  desk: number;
  status: string;
  station: string;
  slot: number;
  pose: string;
  facing: string;
  say: string | null;
  doing: string;
  lines: string;
}

interface RegistryRow {
  registry_id: string;
  pubkey: string;
  principal: string;
  status: string;
  revoked_day: number | null;
}

interface VendorRow {
  principal: string;
  receiver: string;
  principal_key: string;
  paid_count: number;
  max_paid: number;
  mean_paid: number;
}

interface PolicyRow {
  expires_day: number;
  daily_total: number;
  telegram_cap: number;
  per_payment: string;
  origin_ceiling: string;
  signature: string;
}

interface RequestRow {
  id: string;
  origin: string;
  principal: string;
  registry_id: string;
  amount: number;
  reference: string;
  scope: string;
  status: string;
  day: number;
  verdict: string | null;
  lamp: string | null;
  attack_id: string | null;
  envelope: string;
}

interface GateRunRow {
  check_id: string;
  outcome: string;
  note: string;
}

interface AttackRow {
  id: string;
  day: number;
  kind: string;
  principal: string;
  amount: number;
  request_id: string | null;
  lamps_cleared: number;
  blocked_by: string | null;
  outcome: string;
}

interface DecisionRow {
  id: string;
  kind: string;
  agent: string;
  check_id: string;
  reason: string;
  short: string;
  body: string;
  payload: string;
}

interface InboxRow {
  id: string;
  origin: string;
  label: string;
  suspicious: number;
}

interface TelegramRow {
  id: number;
  sender: string;
  name: string;
  time: string;
  text: string;
  buttons: string;
  decided: string | null;
}

interface EventRow {
  seq: number;
  day: number;
  time: string;
  text: string;
  verdict: string;
  check_id: string;
  agent: string | null;
}

interface CaseRow {
  id: number;
  request_id: string;
  sender: string;
  beat: string;
  text: string;
  cites: string | null;
}

/** The deck scene's run: what the buyer is asked to approve this time. */
export interface DeckGrantRow {
  run_id: string;
  registry_id: string;
  merchant: string;
  budget: number;
  /** `live` when the server that seeded this run held Sandbox credentials. */
  mode: string;
  approved: number;
  /** Percent of the budget above which a purchase asks the buyer. Null until set. */
  ask_pct: number | null;
}

/** One agent request to change the approved budget. The buyer answers it. */
export interface BudgetRequestRow {
  request_id: string;
  deck_run_id: string;
  amount: number;
  reason: string;
  status: string;
  note: string | null;
  resulting: number | null;
  created_at: number;
  decided_at: number | null;
}

/**
 * Where one attempt to save a wallet got to.
 *
 * `waiting` until the buyer agrees on PayPal's page and the token is
 * exchanged (`done`). `cancelled` when they back out. `expired` when PayPal no
 * longer has the setup token — nothing can revive it, so a retry is a new attempt.
 */
export type SetupStatus = 'waiting' | 'cancelled' | 'expired' | 'done';

/**
 * The current setup attempt, as stored.
 *
 * Server-only. The setup token and approval link would let someone else act on
 * the attempt, so no snapshot field is ever built from them — only `status` is.
 */
export interface SetupRow {
  attempt_id: string;
  status: string;
  setup_request_id: string;
  setup_id: string | null;
  approval_url: string | null;
  vault_request_id: string | null;
  note: string | null;
  created_at: number;
}

/**
 * The PayPal Sandbox wallet, as stored. Survives demo resets.
 *
 * Two tokens, both server-only. `saved_vault_id` is one this app saved through
 * PayPal's consent page, bound to the merchant app by `app_hash`. It is kept
 * until PayPal says it no longer exists. `active_vault_id` is whichever wallet
 * PayPal last confirmed — saved, configured or from the tested run — and is the
 * only one a charge may use. It is cleared while a check is in progress.
 */
export interface PaypalWalletRow {
  app_hash: string | null;
  saved_vault_id: string | null;
  mode: string;
  status: string;
  source: string | null;
  active_vault_id: string | null;
  note: string | null;
  recheck: number;
  verified_at: number | null;
}

interface SlotRow {
  id: string;
  ord: number;
  title: string;
  price: number;
  reference: string;
  request_id: string | null;
}

/**
 * Where a saved-wallet charge is.
 *
 * `reserved` is written before PayPal is called and `submitted` just before
 * the call goes out. `unknown` means the call failed without an answer, so the
 * order may exist: the budget stays reserved until someone reconciles it.
 */
export type ChargeStatus =
  | 'reserved'
  | 'submitted'
  | 'completed'
  | 'buyer_action'
  | 'failed'
  | 'unknown'
  | 'simulated';

export interface ChargeRow {
  paypal_request_id: string;
  run_id: string;
  request_id: string;
  reference: string;
  amount: number;
  invoice_id: string;
  mode: string;
  status: string;
  order_id: string | null;
  capture_id: string | null;
  note: string | null;
  created_at: number;
}

/**
 * Where a live run is before its signed request reaches the gate.
 *
 * - `challenge`   the numeric prompt is out; a reply is awaited
 * - `not_matched` the reply was scored and did not match; the run stays at Layer 1
 * - `signing`     the reply matched; a one-time signing challenge is out
 * - `expired`     a challenge lapsed before it was answered
 * - `stopped`     Layer 2 could not go ahead: the enrollment or the signer, with the reason in `note`
 * - `submitted`   the signed envelope went to the gate; `request_id` carries the rest
 */
export type LiveRunStage = 'challenge' | 'not_matched' | 'signing' | 'expired' | 'stopped' | 'submitted';

/** One run through the live connector, as stored. */
export interface LiveRunRow {
  run_id: string;
  /** The deck run it belongs to, so a reset never leaves a run pointing at the wrong night. */
  deck_run_id: string;
  merchant: string;
  reference: string;
  title: string;
  amount: number;
  stage: string;
  prompt: string;
  challenge_expires_at: number;
  /** The reply exactly as it arrived. Untrusted text: shown, never interpreted. */
  reply: string | null;
  reply_attempts: number;
  /** The model signal for that reply, as JSON. */
  signal: string | null;
  nonce: string | null;
  sign_expires_at: number | null;
  request_id: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

/** The Demo Agent's enrollment, as stored. Survives demo resets. */
export interface EnrollmentRow {
  registry_id: string;
  /** The signer's public key, or null before one was read. */
  pubkey: string | null;
  status: string;
  /** `local` or `erc8004`, or null on a row written before identity mode was stored. */
  identity_mode: string | null;
  network: string | null;
  chain_id: number | null;
  registry: string | null;
  /** The ERC-8004 agent id, as a decimal string: it is a uint256. */
  agent_id: string | null;
  owner: string | null;
  expected_owner: string | null;
  key_binding: string | null;
  block_number: number | null;
  checked_at: number | null;
  explorer_url: string | null;
  note: string | null;
}

const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = ['none', 'verified', 'local', 'failed', 'unresolved'];
const KEY_BINDINGS: readonly KeyBinding[] = ['matches', 'differs', 'not_stated', 'unreadable'];

/** A charge PayPal has not settled: still in flight, or answered without a confirmed capture. */
const UNSETTLED = "('reserved', 'submitted', 'unknown')";

const asMode = (s: string): ChargeMode => (s === 'live' ? 'live' : 'simulated');

const WALLET_SOURCES: readonly WalletSource[] = ['consent', 'configured', 'tested_run', 'simulated'];

const asSource = (s: string | null): WalletSource | null =>
  s !== null && (WALLET_SOURCES as readonly string[]).includes(s) ? (s as WalletSource) : null;

/** A blank wallet row, for the first write. */
const NO_WALLET: PaypalWalletRow = {
  app_hash: null,
  saved_vault_id: null,
  mode: 'simulated',
  status: 'none',
  source: null,
  active_vault_id: null,
  note: null,
  recheck: 0,
  verified_at: null,
};

/* ---------- Row mapping ---------- */

const bool = (n: number): boolean => n !== 0;
const flag = (b: boolean): number => (b ? 1 : 0);

function asLevel(n: number): Level {
  if (!isLevel(n)) throw new Error(`stored tier ${n} is not 1-5`);
  return n;
}

function asStation(s: string): Station {
  if (!isStation(s)) throw new Error(`stored station "${s}" is not a known place`);
  return s;
}

function asPose(s: string): Pose {
  if (!isPose(s)) throw new Error(`stored pose "${s}" is not a known pose`);
  return s;
}

function asOrigin(s: string): Origin {
  if (!isOrigin(s)) throw new Error(`stored origin "${s}" is not a known lane`);
  return s;
}

function toAgent(row: AgentRow): Agent {
  return {
    key: row.key as AgentKey,
    name: row.name,
    role: row.role,
    level: asLevel(row.level),
    xp: row.xp,
    desk: row.desk,
    status: row.status === 'wait' ? 'wait' : 'work',
    at: asStation(row.station),
    slot: row.slot,
    pose: asPose(row.pose),
    facing: (row.facing === 'left' ? 'left' : 'right') satisfies Facing,
    say: row.say,
    doing: row.doing,
    lines: JSON.parse(row.lines) as MonitorLine[],
  };
}

const toRegistryEntry = (row: RegistryRow): RegistryEntry => ({
  registryId: row.registry_id,
  key: row.pubkey,
  principal: row.principal,
  status: row.status as RegistryStatus,
  revokedDay: row.revoked_day,
});

const toVendor = (row: VendorRow): VendorRecord => ({
  principal: row.principal,
  receiver: row.receiver,
  principalKey: row.principal_key,
  paidCount: row.paid_count,
  maxPaid: cents(row.max_paid),
  meanPaid: cents(row.mean_paid),
});

const toPolicy = (row: PolicyRow): Policy => ({
  expiresDay: row.expires_day,
  dailyTotal: cents(row.daily_total),
  telegramCap: cents(row.telegram_cap),
  perPayment: JSON.parse(row.per_payment) as Policy['perPayment'],
  originCeiling: JSON.parse(row.origin_ceiling) as Policy['originCeiling'],
  signature: row.signature,
});

const toRequest = (row: RequestRow): Request => ({
  id: row.id,
  origin: asOrigin(row.origin),
  principal: row.principal,
  registryId: row.registry_id,
  amount: cents(row.amount),
  reference: row.reference,
  scope: row.scope as MandateScope,
  status: row.status as RequestStatus,
  day: row.day,
  verdict: row.verdict as Verdict | null,
  lamp: row.lamp as CheckId | null,
  attackId: row.attack_id,
});

const toAttack = (row: AttackRow): Attack => ({
  id: row.id,
  day: row.day,
  kind: row.kind as AttackKind,
  principal: row.principal,
  amount: cents(row.amount),
  requestId: row.request_id,
  lampsCleared: row.lamps_cleared,
  blockedBy: row.blocked_by as CheckId | null,
  outcome: row.outcome as AttackOutcome,
});

function toDecision(row: DecisionRow): Decision {
  const base = {
    id: row.id as DecisionId,
    check: row.check_id as CheckId,
    reason: row.reason,
    short: row.short,
    text: row.body,
  };

  switch (row.kind) {
    case 'payment': {
      const p = JSON.parse(row.payload) as {
        requestId: string;
        principal: string;
        registryId: string;
        origin: Origin;
        amount: number;
        reference: string;
        scope: MandateScope;
        history: string;
      };
      return {
        ...base,
        kind: 'payment',
        agent: 'shield',
        requestId: p.requestId,
        principal: p.principal,
        registryId: p.registryId,
        origin: p.origin,
        amount: cents(p.amount),
        reference: p.reference,
        scope: p.scope,
        history: p.history,
      };
    }

    case 'receiver': {
      const p = JSON.parse(row.payload) as {
        requestId: string;
        principal: string;
        heldReceiver: string;
        claimedReceiver: string;
        amount: number;
      };
      return {
        ...base,
        kind: 'receiver',
        agent: 'shield',
        requestId: p.requestId,
        principal: p.principal,
        heldReceiver: p.heldReceiver,
        claimedReceiver: p.claimedReceiver,
        amount: cents(p.amount),
      };
    }

    case 'tighten': {
      const p = JSON.parse(row.payload) as {
        lamp: LampId;
        change: string;
        attackId: string;
      };
      return { ...base, kind: 'tighten', agent: 'tally', lamp: p.lamp, change: p.change, attackId: p.attackId };
    }

    default:
      throw new Error(`stored decision kind "${row.kind}" is not a known kind`);
  }
}

const toInbox = (row: InboxRow): InboxItem => ({
  id: row.id,
  origin: asOrigin(row.origin),
  label: row.label,
  suspicious: bool(row.suspicious),
});

const toTelegram = (row: TelegramRow): TelegramMessage => ({
  id: row.id,
  from: row.sender as Sender,
  name: row.name,
  time: row.time,
  text: row.text,
  buttons: JSON.parse(row.buttons) as TelegramButton[],
  decided: row.decided as TelegramMessage['decided'],
});

const toEvent = (row: EventRow): LogEvent => ({
  seq: row.seq,
  day: row.day,
  time: row.time,
  text: row.text,
  verdict: row.verdict as Verdict,
  check: row.check_id as CheckId,
  agent: row.agent as AgentKey | null,
});

const toCaseMessage = (row: CaseRow): CaseMessage => ({
  id: row.id,
  requestId: row.request_id,
  from: row.sender as CaseMessage['from'],
  beat: row.beat as CaseBeat,
  text: row.text,
  cites: row.cites as CheckId | null,
});

/* ---------- The store ---------- */

export interface NewEvent {
  readonly day: number;
  readonly time: string;
  readonly text: string;
  readonly verdict: Verdict;
  readonly check: CheckId;
  /** Who did it. Null for the clock, a ruling, or the owner's own taps. */
  readonly agent?: AgentKey | null;
}

export interface NewMessage {
  readonly from: Sender;
  readonly name: string;
  readonly time: string;
  readonly text: string;
  readonly buttons?: readonly TelegramButton[];
}

export interface NewRequest {
  readonly envelope: Envelope;
  readonly day: number;
  readonly attackId: string | null;
}

/**
 * Typed access to the world. Every method that changes something bumps `seq`,
 * which is how the browser learns to redraw.
 */
export class Store {
  readonly db: Database;
  /** Which identity proof this process is configured to accept. The page reads it with the enrollment. */
  private configuredIdentity: IdentityMode = 'local';

  constructor(db: Database) {
    this.db = db;
  }

  /** Set from the live flow at startup, before any snapshot is served. */
  setIdentityMode(mode: IdentityMode): void {
    this.configuredIdentity = mode;
  }

  /* --- reads --- */

  /** Is the world seeded? A fresh file has no `world` row. */
  isSeeded(): boolean {
    return this.db.query('SELECT 1 FROM world WHERE id = 1').get() !== null;
  }

  world(): WorldRow {
    const row = this.db.query<WorldRow, []>('SELECT * FROM world WHERE id = 1').get();
    if (!row) throw new Error('payment session is not initialized');
    return row;
  }

  /** Everything the studio needs for one frame. */
  snapshot(): Snapshot {
    const w = this.world();

    return {
      seq: w.seq,
      day: w.day,
      minute: w.minute,
      paused: bool(w.paused),
      balance: cents(w.balance),
      clearedToday: cents(w.cleared_today),
      clearedCount: w.cleared_count,
      blockedToday: w.blocked_today,
      attemptsWeek: w.attempts_week,
      blockedWeek: w.blocked_week,
      agents: this.agents(),
      requests: this.requests(),
      vendors: this.vendors(),
      registry: this.registry(),
      policy: this.policy(),
      decisions: this.decisions(),
      inbox: this.inbox(),
      attacks: this.attacks(),
      thread: this.thread(),
      lastRuling: w.last_ruling ? (JSON.parse(w.last_ruling) as RulingView) : null,
      podium: w.podium as DecisionId | null,
      telegram: this.telegram(),
      events: this.events(SNAPSHOT_EVENT_LIMIT),
      grant: this.grantView(),
      wallet: this.walletView(),
      deck: this.deckView(),
      sends: this.sendsView(),
      buyerPrompts: this.buyerPrompts(),
      unresolved: this.unresolvedView(),
      live: this.liveView(),
      enrollment: this.enrollmentView(),
      connector: this.connectorView(),
    };
  }

  agents(): Agent[] {
    return this.db.query<AgentRow, []>('SELECT * FROM agents ORDER BY ord').all().map(toAgent);
  }

  agent(key: AgentKey): Agent {
    const row = this.db.query<AgentRow, [string]>('SELECT * FROM agents WHERE key = ?').get(key);
    if (!row) throw new Error(`no agent "${key}"`);
    return toAgent(row);
  }

  registry(): RegistryEntry[] {
    return this.db
      .query<RegistryRow, []>('SELECT * FROM registry ORDER BY registry_id')
      .all()
      .map(toRegistryEntry);
  }

  /** Look a key up by the registry id an envelope claims. */
  registryEntry(registryId: string): RegistryEntry | null {
    const row = this.db
      .query<RegistryRow, [string]>('SELECT * FROM registry WHERE registry_id = ?')
      .get(registryId);
    return row ? toRegistryEntry(row) : null;
  }

  vendors(): VendorRecord[] {
    return this.db
      .query<VendorRow, []>('SELECT * FROM vendors ORDER BY principal')
      .all()
      .map(toVendor);
  }

  vendor(principal: string): VendorRecord | null {
    const row = this.db
      .query<VendorRow, [string]>('SELECT * FROM vendors WHERE principal = ?')
      .get(principal);
    return row ? toVendor(row) : null;
  }

  policy(): Policy {
    const row = this.db.query<PolicyRow, []>('SELECT * FROM policy WHERE id = 1').get();
    if (!row) throw new Error('no buyer policy on file');
    return toPolicy(row);
  }

  requests(): Request[] {
    return this.db
      .query<RequestRow, [number]>('SELECT * FROM requests ORDER BY sort DESC LIMIT ?')
      .all(REQUEST_LIMIT)
      .map(toRequest);
  }

  request(id: string): Request | null {
    const row = this.db.query<RequestRow, [string]>('SELECT * FROM requests WHERE id = ?').get(id);
    return row ? toRequest(row) : null;
  }

  /** The envelope exactly as it arrived, so a ruling can be re-derived. */
  envelope(id: string): Envelope | null {
    const row = this.db
      .query<{ envelope: string }, [string]>('SELECT envelope FROM requests WHERE id = ?')
      .get(id);
    return row ? (JSON.parse(row.envelope) as Envelope) : null;
  }

  gateRun(requestId: string): CheckResult[] {
    return this.db
      .query<GateRunRow, [string]>(
        'SELECT check_id, outcome, note FROM gate_runs WHERE request_id = ? ORDER BY ord',
      )
      .all(requestId)
      .map((r) => ({
        check: r.check_id as CheckId,
        outcome: r.outcome as CheckOutcome,
        note: r.note,
      }));
  }

  attacks(): Attack[] {
    return this.db
      .query<AttackRow, []>('SELECT * FROM attacks ORDER BY sort DESC LIMIT 12')
      .all()
      .map(toAttack);
  }

  attack(id: string): Attack | null {
    const row = this.db.query<AttackRow, [string]>('SELECT * FROM attacks WHERE id = ?').get(id);
    return row ? toAttack(row) : null;
  }

  decision(id: string): Decision | null {
    const row = this.db
      .query<DecisionRow, [string]>('SELECT * FROM decisions WHERE id = ?')
      .get(id);
    return row ? toDecision(row) : null;
  }

  decisions(): Decision[] {
    return this.db
      .query<DecisionRow, []>('SELECT * FROM decisions ORDER BY sort')
      .all()
      .map(toDecision);
  }

  inbox(): InboxItem[] {
    return this.db
      .query<InboxRow, []>('SELECT * FROM inbox ORDER BY sort DESC LIMIT 6')
      .all()
      .map(toInbox);
  }

  /**
   * The crew's conversation about one case, in order.
   *
   * With no id, the newest case that has one. The studio only ever shows the
   * current thread; older ones stay addressable by request id.
   */
  thread(requestId?: string): CaseMessage[] {
    const id = requestId ?? this.latestThreadRequest();
    if (!id) return [];

    return this.db
      .query<CaseRow, [string]>('SELECT * FROM case_thread WHERE request_id = ? ORDER BY ord')
      .all(id)
      .map(toCaseMessage);
  }

  /** Which case the studio is currently showing the conversation for. */
  latestThreadRequest(): string | null {
    const row = this.db
      .query<{ request_id: string }, []>(
        'SELECT request_id FROM case_thread ORDER BY id DESC LIMIT 1',
      )
      .get();
    return row?.request_id ?? null;
  }

  /**
   * Record the crew's conversation about a case.
   *
   * Called only after the ruling has been written. Nothing in the gate reads
   * this table — `GateContext` has no field for it — so an argument can never
   * become an input to the decision it is about.
   */
  addCaseLines(
    requestId: string,
    lines: readonly {
      readonly from: string;
      readonly beat: string;
      readonly text: string;
      readonly cites: string | null;
    }[],
  ): void {
    const insert = this.db.query(
      `INSERT INTO case_thread (request_id, sender, beat, text, cites, ord)
       VALUES ($r, $s, $b, $t, $c, $o)`,
    );
    lines.forEach((l, i) => {
      insert.run({ $r: requestId, $s: l.from, $b: l.beat, $t: l.text, $c: l.cites, $o: i });
    });
    this.bump();
  }

  /** The Telegram group, oldest first, so the panel reads top to bottom. */
  telegram(): TelegramMessage[] {
    return this.db
      .query<TelegramRow, [number]>(
        'SELECT * FROM (SELECT * FROM telegram ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
      )
      .all(TELEGRAM_LIMIT)
      .map(toTelegram);
  }

  /** A page of the audit log, newest first. */
  events(limit: number, before?: number): LogEvent[] {
    const rows = before
      ? this.db
          .query<EventRow, [number, number]>(
            'SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?',
          )
          .all(before, limit)
      : this.db
          .query<EventRow, [number]>('SELECT * FROM events ORDER BY seq DESC LIMIT ?')
          .all(limit);

    return rows.map(toEvent);
  }

  /* --- the gate's collectors --- */

  /**
   * Has this nonce been presented before?
   *
   * The `nonces` table is append-only and never pruned, which is the whole
   * replay defence: an envelope is good exactly once, forever.
   */
  nonceSeen(nonce: string): boolean {
    return this.db.query('SELECT 1 FROM nonces WHERE nonce = ?').get(nonce) !== null;
  }

  rememberNonce(nonce: string, day: number): void {
    this.db
      .query('INSERT OR IGNORE INTO nonces (nonce, day, seen_at) VALUES ($n, $d, $t)')
      .run({ $n: nonce, $d: day, $t: Date.now() });
  }

  /** The request a reference was already paid under, if it was. */
  duplicateOf(reference: string, exceptRequestId: string): string | null {
    const row = this.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM requests WHERE reference = ? AND status = 'paid' AND id <> ? LIMIT 1",
      )
      .get(reference, exceptRequestId);
    return row?.id ?? null;
  }

  /** What has actually left today, for the daily cap. */
  paidToday(day: number): Cents {
    const row = this.db
      .query<{ total: number | null }, [number]>(
        "SELECT SUM(amount) AS total FROM payouts WHERE day = ? AND status <> 'failed'",
      )
      .get(day);
    return cents(row?.total ?? 0);
  }

  /* --- writes --- */

  /** Mark the world changed. Every mutator calls this. */
  bump(): number {
    const row = this.db
      .query<{ seq: number }, []>('UPDATE world SET seq = seq + 1 WHERE id = 1 RETURNING seq')
      .get();
    return row?.seq ?? 0;
  }

  patchWorld(patch: Partial<Omit<WorldRow, 'seq'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = $${k}`).join(', ');
    const params = Object.fromEntries(keys.map((k) => [`$${k}`, patch[k] ?? null]));
    this.db.query(`UPDATE world SET ${sets} WHERE id = 1`).run(params);
    this.bump();
  }

  setPaused(paused: boolean): void {
    this.patchWorld({ paused: flag(paused) });
  }

  setPodium(id: DecisionId | null): void {
    this.patchWorld({ podium: id });
  }

  setLastRuling(view: RulingView): void {
    this.patchWorld({ last_ruling: JSON.stringify(view) });
  }

  /** Advance the demo clock, capped at 18:00 so a day never runs past closing. */
  advanceClock(minutes: number): void {
    const w = this.world();
    const next = Math.min(18 * 60, w.minute + minutes);
    if (next !== w.minute) this.patchWorld({ minute: next });
  }

  patchAgent(key: AgentKey, patch: Partial<Agent>): void {
    const columns: Record<string, unknown> = {};
    if (patch.name !== undefined) columns.name = patch.name;
    if (patch.role !== undefined) columns.role = patch.role;
    if (patch.level !== undefined) columns.level = patch.level;
    if (patch.xp !== undefined) columns.xp = patch.xp;
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.at !== undefined) columns.station = patch.at;
    if (patch.slot !== undefined) columns.slot = patch.slot;
    if (patch.pose !== undefined) columns.pose = patch.pose;
    if (patch.facing !== undefined) columns.facing = patch.facing;
    if (patch.say !== undefined) columns.say = patch.say;
    if (patch.doing !== undefined) columns.doing = patch.doing;
    if (patch.lines !== undefined) columns.lines = JSON.stringify(patch.lines);

    const keys = Object.keys(columns);
    if (keys.length === 0) return;

    const sets = keys.map((k) => `${k} = $${k}`).join(', ');
    const params = Object.fromEntries(keys.map((k) => [`$${k}`, columns[k] ?? null]));
    this.db.query(`UPDATE agents SET ${sets} WHERE key = $key`).run({ ...params, $key: key });
    this.bump();
  }

  putAgent(agent: Agent, ord: number): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO agents
           (key, name, role, level, xp, desk, status, station, slot, pose, facing, say, doing, lines, ord)
         VALUES ($key, $name, $role, $level, $xp, $desk, $status, $station, $slot, $pose, $facing, $say, $doing, $lines, $ord)`,
      )
      .run({
        $key: agent.key,
        $name: agent.name,
        $role: agent.role,
        $level: agent.level,
        $xp: agent.xp,
        $desk: agent.desk,
        $status: agent.status,
        $station: agent.at,
        $slot: agent.slot,
        $pose: agent.pose,
        $facing: agent.facing,
        $say: agent.say,
        $doing: agent.doing,
        $lines: JSON.stringify(agent.lines),
        $ord: ord,
      });
  }

  putRegistryEntry(entry: RegistryEntry): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO registry (registry_id, pubkey, principal, status, revoked_day)
         VALUES ($id, $key, $principal, $status, $revoked)`,
      )
      .run({
        $id: entry.registryId,
        $key: entry.key,
        $principal: entry.principal,
        $status: entry.status,
        $revoked: entry.revokedDay,
      });
  }

  putVendor(vendor: VendorRecord): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO vendors
           (principal, receiver, principal_key, paid_count, max_paid, mean_paid)
         VALUES ($p, $r, $k, $c, $max, $mean)`,
      )
      .run({
        $p: vendor.principal,
        $r: vendor.receiver,
        $k: vendor.principalKey,
        $c: vendor.paidCount,
        $max: vendor.maxPaid,
        $mean: vendor.meanPaid,
      });
  }

  /** Fold a settled payment into a vendor's history, for the anomaly band. */
  recordVendorPayment(principal: string, amount: Cents): void {
    const vendor = this.vendor(principal);
    if (!vendor) return;

    const count = vendor.paidCount + 1;
    const mean = cents(Math.round((vendor.meanPaid * vendor.paidCount + amount) / count));
    const max = amount > vendor.maxPaid ? amount : vendor.maxPaid;

    this.putVendor({ ...vendor, paidCount: count, meanPaid: mean, maxPaid: max });
    this.bump();
  }

  /** Change a vendor's receiver. Only ever on an owner's explicit approval. */
  setVendorReceiver(principal: string, receiver: string): void {
    const vendor = this.vendor(principal);
    if (!vendor) return;
    this.putVendor({ ...vendor, receiver });
    this.bump();
  }

  revokeRegistryEntry(registryId: string, day: number): void {
    this.db
      .query("UPDATE registry SET status = 'revoked', revoked_day = $d WHERE registry_id = $id")
      .run({ $d: day, $id: registryId });
    this.bump();
  }

  setPolicy(policy: Policy): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO policy
           (id, expires_day, daily_total, telegram_cap, per_payment, origin_ceiling, signature)
         VALUES (1, $exp, $daily, $tg, $per, $ceil, $sig)`,
      )
      .run({
        $exp: policy.expiresDay,
        $daily: policy.dailyTotal,
        $tg: policy.telegramCap,
        $per: JSON.stringify(policy.perPayment),
        $ceil: JSON.stringify(policy.originCeiling),
        $sig: policy.signature,
      });
    this.bump();
  }

  /* --- requests --- */

  nextRequestId(): string {
    const row = this.db
      .query<{ request_seq: number }, []>(
        'UPDATE world SET request_seq = request_seq + 1 WHERE id = 1 RETURNING request_seq',
      )
      .get();
    return `R-${String(row?.request_seq ?? 1).padStart(4, '0')}`;
  }

  addRequest(req: NewRequest): Request {
    const { envelope, day, attackId } = req;
    const sort = this.db
      .query<{ n: number }, []>('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM requests')
      .get();

    this.db
      .query(
        `INSERT INTO requests
           (id, origin, principal, registry_id, amount, reference, scope, status, day,
            verdict, lamp, attack_id, envelope, sort)
         VALUES ($id, $origin, $principal, $registry, $amount, $reference, $scope, 'queued', $day,
            NULL, NULL, $attack, $envelope, $sort)`,
      )
      .run({
        $id: envelope.id,
        $origin: envelope.origin,
        $principal: envelope.mandate.principal,
        $registry: envelope.agent.registryId,
        $amount: envelope.intent.amount,
        $reference: envelope.intent.reference,
        $scope: envelope.intent.scope,
        $day: day,
        $attack: attackId,
        $envelope: JSON.stringify(envelope),
        $sort: sort?.n ?? 1,
      });
    this.bump();

    const stored = this.request(envelope.id);
    if (!stored) throw new Error(`request ${envelope.id} vanished on insert`);
    return stored;
  }

  setRequestStatus(
    id: string,
    status: RequestStatus,
    settled?: { readonly verdict: Verdict; readonly lamp: CheckId },
  ): void {
    if (settled) {
      this.db
        .query('UPDATE requests SET status = $s, verdict = $v, lamp = $l WHERE id = $id')
        .run({ $s: status, $v: settled.verdict, $l: settled.lamp, $id: id });
    } else {
      this.db.query('UPDATE requests SET status = $s WHERE id = $id').run({ $s: status, $id: id });
    }
    this.bump();
  }

  /**
   * Put any claimed-but-ungated request back on the pile.
   *
   * `intake` means an agent is carrying it. The carrying is choreography and
   * lives in memory, so after a restart nobody is — and a request stuck in
   * `intake` would never be gated at all. Called once on `Engine.start`.
   * Returns how many were returned.
   */
  requeueStranded(): number {
    const row = this.db
      .query<{ n: number }, []>(
        "UPDATE requests SET status = 'queued' WHERE status = 'intake' RETURNING 1 AS n",
      )
      .all();
    if (row.length > 0) this.bump();
    return row.length;
  }

  /** Record every lamp's result. Append-only, like the log. */
  recordGateRun(requestId: string, ruling: Ruling): void {
    const insert = this.db.query(
      `INSERT INTO gate_runs (request_id, check_id, outcome, note, ord)
       VALUES ($r, $c, $o, $n, $i)`,
    );
    ruling.checks.forEach((check, i) => {
      insert.run({ $r: requestId, $c: check.check, $o: check.outcome, $n: check.note, $i: i });
    });
    this.bump();
  }

  /* --- payouts --- */

  /** Have we already acted on this PayPal event? Idempotency, in one query. */
  payoutSeen(eventId: string): boolean {
    return this.db.query('SELECT 1 FROM payouts WHERE event_id = ?').get(eventId) !== null;
  }

  recordPayout(p: {
    readonly requestId: string;
    readonly amount: Cents;
    readonly day: number;
    readonly status: 'sent' | 'settled' | 'failed';
    readonly batchId?: string;
    readonly eventId?: string;
  }): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO payouts (request_id, amount, batch_id, event_id, status, day)
         VALUES ($r, $a, $b, $e, $s, $d)`,
      )
      .run({
        $r: p.requestId,
        $a: p.amount,
        $b: p.batchId ?? null,
        $e: p.eventId ?? null,
        $s: p.status,
        $d: p.day,
      });
    this.bump();
  }

  /* --- attacks --- */

  nextAttackId(): string {
    const row = this.db
      .query<{ attack_seq: number }, []>(
        'UPDATE world SET attack_seq = attack_seq + 1 WHERE id = 1 RETURNING attack_seq',
      )
      .get();
    return `A-${row?.attack_seq ?? 1}`;
  }

  addAttack(attack: Attack): void {
    const sort = this.db
      .query<{ n: number }, []>('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM attacks')
      .get();

    this.db
      .query(
        `INSERT OR REPLACE INTO attacks
           (id, day, kind, principal, amount, request_id, lamps_cleared, blocked_by, outcome, sort)
         VALUES ($id, $day, $kind, $p, $a, $r, $lc, $b, $o,
                 COALESCE((SELECT sort FROM attacks WHERE id = $id), $sort))`,
      )
      .run({
        $id: attack.id,
        $day: attack.day,
        $kind: attack.kind,
        $p: attack.principal,
        $a: attack.amount,
        $r: attack.requestId,
        $lc: attack.lampsCleared,
        $b: attack.blockedBy,
        $o: attack.outcome,
        $sort: sort?.n ?? 1,
      });
    this.bump();
  }

  /* --- decisions --- */

  nextDecisionId(): DecisionId {
    const row = this.db
      .query<{ decision_seq: number }, []>(
        'UPDATE world SET decision_seq = decision_seq + 1 WHERE id = 1 RETURNING decision_seq',
      )
      .get();
    return `D${row?.decision_seq ?? 1}`;
  }

  addDecision(decision: Decision): void {
    const sort = this.db
      .query<{ n: number }, []>('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM decisions')
      .get();

    const payload = ((): unknown => {
      switch (decision.kind) {
        case 'payment':
          return {
            requestId: decision.requestId,
            principal: decision.principal,
            registryId: decision.registryId,
            origin: decision.origin,
            amount: decision.amount,
            reference: decision.reference,
            scope: decision.scope,
            history: decision.history,
          };
        case 'receiver':
          return {
            requestId: decision.requestId,
            principal: decision.principal,
            heldReceiver: decision.heldReceiver,
            claimedReceiver: decision.claimedReceiver,
            amount: decision.amount,
          };
        case 'tighten':
          return { lamp: decision.lamp, change: decision.change, attackId: decision.attackId };
        default: {
          const unreachable: never = decision;
          throw new Error(`cannot store ${JSON.stringify(unreachable)}`);
        }
      }
    })();

    this.db
      .query(
        `INSERT OR REPLACE INTO decisions (id, kind, agent, check_id, reason, short, body, payload, sort)
         VALUES ($id, $kind, $agent, $check, $reason, $short, $body, $payload, $sort)`,
      )
      .run({
        $id: decision.id,
        $kind: decision.kind,
        $agent: decision.agent,
        $check: decision.check,
        $reason: decision.reason,
        $short: decision.short,
        $body: decision.text,
        $payload: JSON.stringify(payload),
        $sort: sort?.n ?? 1,
      });
    this.bump();
  }

  removeDecision(id: DecisionId): void {
    this.db.query('DELETE FROM decisions WHERE id = ?').run(id);
    this.bump();
  }

  adoptRule(lamp: LampId, change: string, attackId: string, day: number): void {
    this.db
      .query(
        'INSERT INTO adopted_rules (lamp, change, attack_id, adopted_day) VALUES ($l, $c, $a, $d)',
      )
      .run({ $l: lamp, $c: change, $a: attackId, $d: day });
    this.bump();
  }

  adoptedRules(): { lamp: LampId; change: string; adoptedDay: number }[] {
    return this.db
      .query<{ lamp: string; change: string; adopted_day: number }, []>(
        'SELECT lamp, change, adopted_day FROM adopted_rules ORDER BY id',
      )
      .all()
      .map((r) => ({ lamp: r.lamp as LampId, change: r.change, adoptedDay: r.adopted_day }));
  }

  /* --- inbox --- */

  addInboxItem(item: InboxItem): void {
    const sort = this.db
      .query<{ n: number }, []>('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM inbox')
      .get();
    this.db
      .query(
        'INSERT OR REPLACE INTO inbox (id, origin, label, suspicious, sort) VALUES ($id, $o, $l, $s, $sort)',
      )
      .run({
        $id: item.id,
        $o: item.origin,
        $l: item.label,
        $s: flag(item.suspicious),
        $sort: sort?.n ?? 1,
      });
    this.bump();
  }

  removeInboxItem(id: string): void {
    this.db.query('DELETE FROM inbox WHERE id = ?').run(id);
    this.bump();
  }

  /* --- telegram and the log --- */

  addMessage(message: NewMessage): number {
    const row = this.db
      .query<{ id: number }, [Record<string, string>]>(
        `INSERT INTO telegram (sender, name, time, text, buttons, decided)
         VALUES ($sender, $name, $time, $text, $buttons, NULL) RETURNING id`,
      )
      .get({
        $sender: message.from,
        $name: message.name,
        $time: message.time,
        $text: message.text,
        $buttons: JSON.stringify(message.buttons ?? []),
      });
    this.bump();
    return row?.id ?? 0;
  }

  /** Grey out the buttons under a decision once the owner has used one. */
  markDecided(decisionId: DecisionId, choice: string): void {
    this.db
      .query(
        `UPDATE telegram SET decided = $choice
         WHERE decided IS NULL AND buttons LIKE '%' || $needle || '%'`,
      )
      .run({ $choice: choice, $needle: `"decisionId":"${decisionId}"` });
    this.bump();
  }

  /** Append one line to the audit log. There is no update and no delete. */
  log(event: NewEvent): void {
    this.db
      .query(
        `INSERT INTO events (day, time, text, verdict, check_id, agent)
         VALUES ($day, $time, $text, $verdict, $check, $agent)`,
      )
      .run({
        $day: event.day,
        $time: event.time,
        $text: event.text,
        $verdict: event.verdict,
        $check: event.check,
        $agent: event.agent ?? null,
      });
    this.bump();
  }

  /**
   * Run `fn` in one transaction.
   *
   * The engine wraps each step of a request's life in this, so a tick either
   * writes a whole gate run or none of it. A half-written ruling would show the
   * studio lamps that disagree with the log.
   */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /* --- the deck scene --- */

  /** This run's grant, or null outside the deck scene. */
  deckGrant(): DeckGrantRow | null {
    return this.db.query<DeckGrantRow, []>('SELECT * FROM deck_grant WHERE id = 1').get() ?? null;
  }

  putDeckGrant(row: DeckGrantRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO deck_grant (id, run_id, registry_id, merchant, budget, mode, approved, ask_pct)
         VALUES (1, $run, $registry, $merchant, $budget, $mode, $approved, $ask)`,
      )
      .run({
        $run: row.run_id,
        $registry: row.registry_id,
        $merchant: row.merchant,
        $budget: row.budget,
        $mode: row.mode,
        $approved: row.approved,
        $ask: row.ask_pct,
      });
    this.bump();
  }

  patchDeckGrant(patch: Partial<DeckGrantRow>): void {
    const current = this.deckGrant();
    if (current) this.putDeckGrant({ ...current, ...patch });
  }

  /** The current wallet setup attempt. Server-only: never put in a snapshot. */
  walletSetup(): SetupRow | null {
    return this.db.query<SetupRow, []>('SELECT * FROM wallet_setup WHERE id = 1').get() ?? null;
  }

  putWalletSetup(row: SetupRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO wallet_setup
           (id, attempt_id, status, setup_request_id, setup_id, approval_url, vault_request_id, note, created_at)
         VALUES (1, $attempt, $status, $setupRequest, $setup, $approval, $vaultRequest, $note, $created)`,
      )
      .run({
        $attempt: row.attempt_id,
        $status: row.status,
        $setupRequest: row.setup_request_id,
        $setup: row.setup_id,
        $approval: row.approval_url,
        $vaultRequest: row.vault_request_id,
        $note: row.note,
        $created: row.created_at,
      });
    this.bump();
  }

  patchWalletSetup(patch: Partial<SetupRow>): void {
    const current = this.walletSetup();
    if (current) this.putWalletSetup({ ...current, ...patch });
  }

  /** Drop a finished setup attempt, so an older "cancelled" or "expired" stops speaking for the wallet. */
  clearWalletSetup(): void {
    this.db.query('DELETE FROM wallet_setup').run();
    this.bump();
  }

  /** The PayPal wallet row. Server-only: never put in a snapshot. */
  paypalWallet(): PaypalWalletRow | null {
    return this.db.query<PaypalWalletRow, []>('SELECT * FROM paypal_wallet WHERE id = 1').get() ?? null;
  }

  /** Change the wallet row, creating it on the first write. */
  patchPaypalWallet(patch: Partial<PaypalWalletRow>): void {
    const row: PaypalWalletRow = { ...(this.paypalWallet() ?? NO_WALLET), ...patch };
    this.db
      .query(
        `INSERT OR REPLACE INTO paypal_wallet
           (id, app_hash, saved_vault_id, mode, status, source, active_vault_id, note, recheck, verified_at)
         VALUES (1, $app, $saved, $mode, $status, $source, $active, $note, $recheck, $verified)`,
      )
      .run({
        $app: row.app_hash,
        $saved: row.saved_vault_id,
        $mode: row.mode,
        $status: row.status,
        $source: row.source,
        $active: row.active_vault_id,
        $note: row.note,
        $recheck: row.recheck,
        $verified: row.verified_at,
      });
    this.bump();
  }

  /**
   * Forget the wallet here. PayPal keeps the token; this app just stops using
   * it, so the next run starts at "Connect PayPal Sandbox".
   */
  forgetPaypalWallet(): void {
    this.db.query('DELETE FROM paypal_wallet').run();
    this.bump();
  }

  putDeckSlot(
    slot: { readonly id: string; readonly title: string; readonly price: Cents; readonly reference: string },
    ord: number,
  ): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO deck_slots (id, ord, title, price, reference, request_id)
         VALUES ($id, $ord, $title, $price, $reference, NULL)`,
      )
      .run({ $id: slot.id, $ord: ord, $title: slot.title, $price: slot.price, $reference: slot.reference });
    this.bump();
  }

  /** Point a slot at the request that is buying it. A retry replaces the link. */
  linkSlot(slotId: string, requestId: string): void {
    this.db
      .query('UPDATE deck_slots SET request_id = $r WHERE id = $id')
      .run({ $r: requestId, $id: slotId });
    this.bump();
  }

  slotRows(): SlotRow[] {
    return this.db.query<SlotRow, []>('SELECT * FROM deck_slots ORDER BY ord').all();
  }

  /** This run's charge for a request, if one was made. */
  charge(requestId: string): ChargeRow | null {
    const run = this.deckGrant()?.run_id;
    if (!run) return null;
    return (
      this.db
        .query<ChargeRow, [string, string]>('SELECT * FROM paypal_charges WHERE run_id = ? AND request_id = ?')
        .get(run, requestId) ?? null
    );
  }

  /** Any run's charge, by the PayPal-Request-Id it was sent with. */
  chargeById(paypalRequestId: string): ChargeRow | null {
    return (
      this.db
        .query<ChargeRow, [string]>('SELECT * FROM paypal_charges WHERE paypal_request_id = ?')
        .get(paypalRequestId) ?? null
    );
  }

  /** Write the attempt down before anything is sent. Insert-only: one row per PayPal-Request-Id. */
  addCharge(row: Omit<ChargeRow, 'created_at'>): void {
    this.db
      .query(
        `INSERT INTO paypal_charges
           (paypal_request_id, run_id, request_id, reference, amount, invoice_id, mode, status,
            order_id, capture_id, note, created_at)
         VALUES ($rid, $run, $r, $ref, $a, $inv, $mode, $status, $order, $capture, $note, $t)`,
      )
      .run({
        $rid: row.paypal_request_id,
        $run: row.run_id,
        $r: row.request_id,
        $ref: row.reference,
        $a: row.amount,
        $inv: row.invoice_id,
        $mode: row.mode,
        $status: row.status,
        $order: row.order_id,
        $capture: row.capture_id,
        $note: row.note,
        $t: Date.now(),
      });
    this.bump();
  }

  patchCharge(
    paypalRequestId: string,
    patch: { readonly status: ChargeStatus; readonly orderId?: string; readonly captureId?: string; readonly note?: string },
  ): void {
    this.db
      .query(
        `UPDATE paypal_charges SET status = $s,
           order_id = COALESCE($order, order_id),
           capture_id = COALESCE($capture, capture_id),
           note = COALESCE($note, note)
         WHERE paypal_request_id = $rid`,
      )
      .run({
        $s: patch.status,
        $order: patch.orderId ?? null,
        $capture: patch.captureId ?? null,
        $note: patch.note ?? null,
        $rid: paypalRequestId,
      });
    this.bump();
  }

  /**
   * This run's charges PayPal has not settled. The deck sends one at a time,
   * like the tested script: the next purchase waits until this is zero. An
   * earlier run's charge does not hold this run up — it was made under that
   * run's budget, and stays listed until it is reconciled.
   */
  chargesInFlight(): number {
    const run = this.deckGrant()?.run_id;
    if (!run) return 0;
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM paypal_charges WHERE run_id = ? AND status IN ${UNSETTLED}`,
      )
      .get(run);
    return row?.n ?? 0;
  }

  /** Every charge PayPal has not settled, from any run, oldest first. */
  unsettledCharges(): ChargeRow[] {
    return this.db
      .query<ChargeRow, []>(`SELECT * FROM paypal_charges WHERE status IN ${UNSETTLED} ORDER BY created_at`)
      .all();
  }

  /**
   * Charges a stopped process left without an answer.
   *
   * `reserved` and `submitted` mean a call is in flight, which is only true
   * while the process that made it is still waiting. Called when the engine
   * starts, with the attempts it is still waiting on; the rest become
   * `unknown` — reserved until reconciled, never retried blind.
   */
  markStrandedCharges(waitingOn: ReadonlySet<string>): number {
    const stranded = this.db
      .query<{ paypal_request_id: string }, []>(
        "SELECT paypal_request_id FROM paypal_charges WHERE status IN ('reserved', 'submitted')",
      )
      .all()
      .filter((row) => !waitingOn.has(row.paypal_request_id));

    for (const row of stranded) {
      this.patchCharge(row.paypal_request_id, {
        status: 'unknown',
        note: 'The server stopped while PayPal was answering; reserved until reconciled',
      });
    }
    return stranded.length;
  }

  /** Is another request for this reference being paid right now? */
  referenceCharging(reference: string, exceptRequestId: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM requests WHERE reference = ? AND status = 'charging' AND id <> ?")
        .get(reference, exceptRequestId) !== null
    );
  }

  /**
   * Settle or release a reservation.
   *
   * A deck charge is recorded as a `sent` payout the moment it is reserved, so
   * `paidToday` — and with it the daily limit — already counts it while it is
   * with PayPal. `settled` keeps it counted; `failed` releases it.
   */
  setPayoutStatus(requestId: string, status: 'sent' | 'settled' | 'failed'): void {
    this.db
      .query('UPDATE payouts SET status = $s WHERE request_id = $r AND event_id IS NULL')
      .run({ $s: status, $r: requestId });
    this.bump();
  }

  /** Captured and still-reserved totals for a day, for the grant view. */
  committed(day: number): { readonly spent: Cents; readonly reserved: Cents } {
    const sum = (status: string): Cents =>
      cents(
        this.db
          .query<{ total: number | null }, [number, string]>(
            'SELECT SUM(amount) AS total FROM payouts WHERE day = ? AND status = ?',
          )
          .get(day, status)?.total ?? 0,
      );
    return { spent: sum('settled'), reserved: sum('sent') };
  }

  /** Times PayPal wanted the buyer back after setup, this run. The demo's claim is that this stays 0. */
  buyerPrompts(): number {
    const run = this.deckGrant()?.run_id;
    if (!run) return 0;
    const row = this.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM paypal_charges WHERE run_id = ? AND status = 'buyer_action'",
      )
      .get(run);
    return row?.n ?? 0;
  }

  /** Charges PayPal answered without a confirmed capture, or never answered, from any run. */
  unresolvedView(): UnresolvedView {
    const run = this.deckGrant()?.run_id ?? null;
    const rows = this.db
      .query<{ run_id: string; order_id: string | null }, []>(
        "SELECT run_id, order_id FROM paypal_charges WHERE status = 'unknown'",
      )
      .all();
    return {
      count: rows.length,
      fromEarlierRuns: rows.filter((r) => r.run_id !== run).length,
      withoutOrder: rows.filter((r) => r.order_id === null).length,
    };
  }

  /**
   * The wallet's connection status, as the browser may see it. Never a token.
   *
   * The wallet row only counts when it was reached under this run's PayPal
   * setting: a simulated connection is no wallet on a server with credentials,
   * and the reverse.
   */
  walletView(): WalletView | null {
    const grant = this.deckGrant();
    if (!grant) return null;

    const mode = asMode(grant.mode);
    const row = this.paypalWallet();
    const usable = row !== null && row.mode === mode;
    const canRecheck = usable && row.recheck === 1;
    const setup = this.walletSetup();

    if (usable && row.status === 'connected') {
      return { state: 'connected', mode, source: asSource(row.source), note: null, canRecheck: true };
    }
    if (usable && row.status === 'checking') {
      return { state: 'checking', mode, source: null, note: null, canRecheck: false };
    }
    if (setup && (setup.status === 'waiting' || setup.status === 'cancelled' || setup.status === 'expired')) {
      return { state: setup.status, mode, source: null, note: setup.note, canRecheck };
    }
    return { state: 'none', mode, source: null, note: usable ? row.note : null, canRecheck };
  }

  /**
   * The grant as the deck shows it, or null outside the deck scene.
   *
   * Until the buyer has connected a wallet and approved this run's budget, the
   * budget shown is the one being offered. After that it is read from the
   * signed policy row, which is the number the gate compares against — rule 2.
   */
  grantView(): GrantView | null {
    const grant = this.deckGrant();
    if (!grant) return null;

    const world = this.world();
    const entry = this.registryEntry(grant.registry_id);
    const policy = this.policy();
    const policyLive = policy.expiresDay >= world.day;
    const connected = this.walletView()?.state === 'connected';
    const approved = grant.approved === 1;

    const status: GrantStatus =
      entry?.status === 'revoked'
        ? 'revoked'
        : !connected
          ? 'needs_wallet'
          : approved
            ? 'active'
            : 'needs_approval';

    const budget = approved && policyLive ? policy.dailyTotal : cents(grant.budget);
    const { spent, reserved } = this.committed(world.day);

    return {
      principal: entry?.principal ?? DECK.principal,
      merchant: grant.merchant,
      registryId: grant.registry_id,
      keyPrint: entry ? fingerprint(entry.key) : '—',
      budget,
      spent,
      reserved,
      left: maxZero(subCents(subCents(budget, spent), reserved)),
      askThresholdPct: grant.ask_pct ?? 50,
      until: DECK.until,
      status,
      approved,
      pendingBudgetRequest: this.pendingBudgetRequest(grant.run_id, budget),
    };
  }

  /** The one unanswered budget change for this run, if the agent has asked. */
  private pendingBudgetRequest(runId: string, current: Cents): GrantView['pendingBudgetRequest'] {
    const row = this.db
      .query<BudgetRequestRow, [string]>(
        `SELECT * FROM budget_requests
         WHERE deck_run_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(runId);
    if (!row) return null;
    return {
      requestId: row.request_id,
      current,
      requested: cents(row.amount),
      reason: row.reason,
    };
  }

  budgetRequest(requestId: string): BudgetRequestRow | null {
    return (
      this.db.query<BudgetRequestRow, [string]>('SELECT * FROM budget_requests WHERE request_id = ?').get(requestId) ??
      null
    );
  }

  /**
   * Mark every unanswered budget change for this run declined.
   *
   * A newer request replaces the older one. The grant is not touched.
   */
  declinePendingBudgetRequests(runId: string, resulting: Cents, note: string, now: number): void {
    this.db
      .query(
        `UPDATE budget_requests
         SET status = 'declined', note = $note, resulting = $resulting, decided_at = $now
         WHERE deck_run_id = $run AND status = 'pending'`,
      )
      .run({ $note: note, $resulting: resulting, $now: now, $run: runId });
    this.bump();
  }

  addBudgetRequest(row: BudgetRequestRow): void {
    this.db
      .query(
        `INSERT INTO budget_requests
           (request_id, deck_run_id, amount, reason, status, note, resulting, created_at, decided_at)
         VALUES ($id, $run, $amount, $reason, $status, $note, $resulting, $created, $decided)`,
      )
      .run({
        $id: row.request_id,
        $run: row.deck_run_id,
        $amount: row.amount,
        $reason: row.reason,
        $status: row.status,
        $note: row.note,
        $resulting: row.resulting,
        $created: row.created_at,
        $decided: row.decided_at,
      });
    this.bump();
  }

  /** Record the buyer's answer. Only a pending row changes. */
  decideBudgetRequest(requestId: string, status: 'approved' | 'declined', resulting: Cents, note: string, now: number): boolean {
    const changed = this.db
      .query(
        `UPDATE budget_requests
         SET status = $status, note = $note, resulting = $resulting, decided_at = $now
         WHERE request_id = $id AND status = 'pending'`,
      )
      .run({ $status: status, $note: note, $resulting: resulting, $now: now, $id: requestId });
    this.bump();
    return changed.changes > 0;
  }

  deckView(): DeckSlot[] {
    return this.slotRows().map((row) => this.slotView(row));
  }

  private slotView(row: SlotRow): DeckSlot {
    const base = {
      id: row.id,
      title: row.title,
      price: cents(row.price),
      reference: row.reference,
      requestId: row.request_id,
    };
    const none = { orderId: null, captureId: null, mode: null };

    const request = row.request_id ? this.request(row.request_id) : null;
    if (!request) return { ...base, ...none, state: 'locked', note: null };

    const charge = this.charge(request.id);
    const ids = {
      orderId: charge?.order_id ?? null,
      captureId: charge?.capture_id ?? null,
      mode: charge ? asMode(charge.mode) : null,
    };

    switch (request.status) {
      case 'paid':
        return { ...base, ...ids, state: 'unlocked', note: null };
      case 'queued':
      case 'intake':
        return { ...base, ...none, state: 'charging', note: 'At the gate' };
      case 'charging':
        return { ...base, ...ids, state: 'charging', note: charge?.note ?? 'With PayPal' };
      case 'gated':
      case 'waiting':
        return { ...base, ...none, state: 'needs_you', note: this.lampNote(request.id, request.lamp) };
      case 'blocked':
        return {
          ...base,
          ...ids,
          state: 'blocked',
          note: charge?.note ?? this.lampNote(request.id, request.lamp),
        };
      default: {
        const unreachable: never = request.status;
        throw new Error(`no slot state for ${String(unreachable)}`);
      }
    }
  }

  /** The note the settling lamp printed, or a plain word for an owner's marker. */
  private lampNote(requestId: string, lamp: CheckId | null): string | null {
    if (!lamp) return null;
    if (lamp === 'OWNER_DECLINED') return 'Declined by the buyer';
    return this.gateRun(requestId).find((c) => c.check === lamp)?.note ?? null;
  }

  /* --- the deck scene's three test requests --- */

  /** Record which request a test sender sent. Insert-only: each sends once a run. */
  addDeckSend(sender: BoardSender, requestId: string): void {
    this.db
      .query('INSERT INTO deck_sends (sender, request_id, sent_at) VALUES ($s, $r, $t)')
      .run({ $s: sender, $r: requestId, $t: Date.now() });
    this.bump();
  }

  /** This run's test requests, by sender. */
  deckSends(): ReadonlyMap<BoardSender, string> {
    const rows = this.db
      .query<{ sender: string; request_id: string }, []>('SELECT sender, request_id FROM deck_sends')
      .all();
    const sends = new Map<BoardSender, string>();
    for (const row of rows) {
      if ((BOARD_SENDERS as readonly string[]).includes(row.sender)) {
        sends.set(row.sender as BoardSender, row.request_id);
      }
    }
    return sends;
  }

  /** Keep a deck ruling's WHO and MAY, as worked out when it was ruled. */
  recordDeckRuling(requestId: string, summary: RulingSummary): void {
    this.db
      .query('INSERT OR REPLACE INTO deck_rulings (request_id, summary) VALUES ($r, $s)')
      .run({ $r: requestId, $s: JSON.stringify(summary) });
  }

  deckRuling(requestId: string): RulingSummary | null {
    const row = this.db
      .query<{ summary: string }, [string]>('SELECT summary FROM deck_rulings WHERE request_id = ?')
      .get(requestId);
    return row ? (JSON.parse(row.summary) as RulingSummary) : null;
  }

  /**
   * The three test requests, as the verification page draws them, in order.
   *
   * A request is `ready` once the buyer has connected the wallet and approved
   * the budget, while nothing is with PayPal and the agents are not paused —
   * the same conditions the engine enforces, so a button is never offered that
   * the server would refuse. They go in any order, each once a run; the paying
   * one also needs its image still unbought.
   */
  sendsView(): SendView[] {
    const grant = this.grantView();
    if (!grant) return [];

    const sent = this.deckSends();
    const slots = this.deckView();
    const busy = this.chargesInFlight() > 0 || slots.some((s) => s.state === 'charging');
    const open =
      (grant.status === 'active' || grant.status === 'revoked') && this.world().paused === 0 && !busy;
    const openReferences = new Set(
      slots.filter((slot) => slot.state === 'locked' || slot.state === 'blocked').map((slot) => slot.reference),
    );
    // Once the signer service holds the agent's enrolled key, this server
    // cannot sign as the agent: only the impostor, which never could, still goes.
    const signerHoldsKey = this.enrollmentView()?.active === true;

    return BOARD_SENDERS.map((sender): SendView => {
      const meta = SENDERS[sender];
      const requestId = sent.get(sender) ?? null;
      const request = requestId ? this.request(requestId) : null;
      const quotes = boardQuotes(sender);
      const quote = request ? quotes.find((entry) => entry.reference === request.reference) : quotes[0];
      const amount = request?.amount ?? quote?.price ?? BOARD_SLOT.price;
      const availableQuotes = quotes
        .filter((entry) => sender !== 'agent' || openReferences.has(entry.reference))
        .map(({ reference, title, price }) => ({ reference, item: title, amount: price }));
      const ready =
        requestId === null && open && availableQuotes.length > 0 && (sender === 'impostor' || !signerHoldsKey);

      const base = {
        sender,
        n: meta.n,
        title: meta.title,
        short: meta.short,
        shows: meta.shows,
        blurb: meta.blurb,
        impostor: meta.impostor,
        registryId: DECK.registryId,
        agentName: DECK.agentName,
        merchant: meta.merchant,
        item: quote?.title ?? BOARD_SLOT.title,
        reference: request?.reference ?? quote?.reference ?? BOARD_SLOT.reference,
        amount,
        availableQuotes,
      };

      if (requestId === null) {
        return {
          ...base,
          state: ready ? 'ready' : 'locked',
          requestId: null,
          evidence: null,
          verdict: null,
          summary: null,
          paypal: null,
          caption: null,
        };
      }

      const evidence = evidenceFor(sender);
      const summary = this.deckRuling(requestId);
      const paypal = paypalView(this.charge(requestId), amount);
      return {
        ...base,
        state: 'sent',
        requestId,
        evidence,
        verdict: request?.verdict ?? null,
        summary,
        paypal,
        caption: summary ? captionFor(summary, evidence, paypal) : null,
      };
    });
  }

  /**
   * The request that carried a nonce, if one did.
   *
   * A signing challenge's nonce goes into exactly one envelope, so this finds
   * the request a challenge became even when the caller that submitted it never
   * got to write the link down.
   */
  requestByNonce(nonce: string): string | null {
    const row = this.db
      .query<{ id: string }, [string]>("SELECT id FROM requests WHERE json_extract(envelope, '$.nonce') = ? LIMIT 1")
      .get(nonce);
    return row?.id ?? null;
  }

  /* --- the live connector: runs --- */

  /** Start a run. Insert-only: a run's id is never reused. */
  addLiveRun(row: Omit<LiveRunRow, 'created_at' | 'updated_at'>): LiveRunRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO live_runs
           (run_id, deck_run_id, merchant, reference, title, amount, stage, prompt, challenge_expires_at,
            reply, reply_attempts, signal, nonce, sign_expires_at, request_id, note, created_at, updated_at)
         VALUES ($run, $deck, $merchant, $reference, $title, $amount, $stage, $prompt, $challengeExpires,
            $reply, $attempts, $signal, $nonce, $signExpires, $request, $note, $now, $now)`,
      )
      .run({
        $run: row.run_id,
        $deck: row.deck_run_id,
        $merchant: row.merchant,
        $reference: row.reference,
        $title: row.title,
        $amount: row.amount,
        $stage: row.stage,
        $prompt: row.prompt,
        $challengeExpires: row.challenge_expires_at,
        $reply: row.reply,
        $attempts: row.reply_attempts,
        $signal: row.signal,
        $nonce: row.nonce,
        $signExpires: row.sign_expires_at,
        $request: row.request_id,
        $note: row.note,
        $now: now,
      });
    this.bump();
    return { ...row, created_at: now, updated_at: now };
  }

  liveRun(runId: string): LiveRunRow | null {
    return this.db.query<LiveRunRow, [string]>('SELECT * FROM live_runs WHERE run_id = ?').get(runId) ?? null;
  }

  /** This deck run's most recent live run, whatever came of it. */
  latestLiveRun(): LiveRunRow | null {
    const deck = this.deckGrant()?.run_id;
    if (!deck) return null;
    return (
      this.db
        .query<LiveRunRow, [string]>(
          'SELECT * FROM live_runs WHERE deck_run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        )
        .get(deck) ?? null
    );
  }

  /** The price of an ad-hoc purchase opened on this reference, or null for a catalog quote. */
  liveQuote(merchant: string, reference: string): Cents | null {
    const deck = this.deckGrant()?.run_id;
    if (!deck) return null;
    const row = this.db
      .query<{ amount: number }, [string, string, string]>(
        `SELECT amount FROM live_runs WHERE deck_run_id = ? AND merchant = ? AND reference = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(deck, merchant, reference);
    return row ? cents(row.amount) : null;
  }

  /**
   * The latest live run for one item at one price. Ad-hoc purchases are
   * idempotent on this pair while the run is still open.
   */
  livePurchase(merchant: string, title: string, amount: number): LiveRunRow | null {
    const deck = this.deckGrant()?.run_id;
    if (!deck) return null;
    return (
      this.db
        .query<LiveRunRow, [string, string, string, number]>(
          `SELECT * FROM live_runs
           WHERE deck_run_id = ? AND merchant = ? AND lower(title) = lower(?) AND amount = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(deck, merchant, title, amount) ?? null
    );
  }

  /** This deck run's most recent live run for one merchant's quote. */
  liveRunFor(merchant: string, reference: string): LiveRunRow | null {
    const deck = this.deckGrant()?.run_id;
    if (!deck) return null;
    return (
      this.db
        .query<LiveRunRow, [string, string, string]>(
          `SELECT * FROM live_runs WHERE deck_run_id = ? AND merchant = ? AND reference = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(deck, merchant, reference) ?? null
    );
  }

  patchLiveRun(runId: string, patch: Partial<Omit<LiveRunRow, 'run_id' | 'created_at' | 'updated_at'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const sets = [...keys.map((k) => `${k} = $${k}`), 'updated_at = $updated_at'].join(', ');
    const params = Object.fromEntries(keys.map((k) => [`$${k}`, patch[k] ?? null]));
    this.db
      .query(`UPDATE live_runs SET ${sets} WHERE run_id = $run_id`)
      .run({ ...params, $updated_at: Date.now(), $run_id: runId });
    this.bump();
  }

  /**
   * Close every run whose challenge lapsed unanswered. Returns how many.
   *
   * Stored rather than worked out when a run is read, so a view of a run never
   * depends on the clock and the page redraws when — and only when — something
   * was written.
   */
  expireLiveRuns(nowMs: number): number {
    const due = this.db
      .query<{ run_id: string; stage: string }, { $now: number }>(
        `SELECT run_id, stage FROM live_runs
         WHERE (stage = 'challenge' AND challenge_expires_at < $now)
            OR (stage = 'signing' AND sign_expires_at < $now)`,
      )
      .all({ $now: nowMs });

    for (const run of due) {
      this.patchLiveRun(run.run_id, {
        stage: 'expired',
        note:
          run.stage === 'challenge'
            ? 'The numeric challenge expired before a reply arrived.'
            : 'The signing challenge expired before it was signed.',
      });
    }
    return due.length;
  }

  /** One run as the page and the chat see it. The latest of this deck run when none is named. */
  liveView(row: LiveRunRow | null = this.latestLiveRun()): LiveRunView | null {
    const grant = this.grantView();
    if (!row || !grant) return null;
    const request = row.request_id ? this.request(row.request_id) : null;
    return buildLiveView(row, {
      request,
      summary: request ? this.deckRuling(request.id) : null,
      charge: request ? this.charge(request.id) : null,
      budget: grant.budget,
      envelope: request ? this.envelope(request.id) : null,
    });
  }

  /* --- the live connector: the Demo Agent's enrollment --- */

  enrollment(registryId: string): EnrollmentRow | null {
    return (
      this.db
        .query<EnrollmentRow, [string]>('SELECT * FROM agent_enrollment WHERE registry_id = ?')
        .get(registryId) ?? null
    );
  }

  putEnrollment(row: EnrollmentRow): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO agent_enrollment
           (registry_id, pubkey, status, identity_mode, network, chain_id, registry, agent_id, owner, expected_owner,
            key_binding, block_number, checked_at, explorer_url, note)
         VALUES ($id, $pubkey, $status, $mode, $network, $chain, $registry, $agent, $owner, $expected,
            $binding, $block, $checked, $explorer, $note)`,
      )
      .run({
        $id: row.registry_id,
        $pubkey: row.pubkey,
        $status: row.status,
        $mode: row.identity_mode,
        $network: row.network,
        $chain: row.chain_id,
        $registry: row.registry,
        $agent: row.agent_id,
        $owner: row.owner,
        $expected: row.expected_owner,
        $binding: row.key_binding,
        $block: row.block_number,
        $checked: row.checked_at,
        $explorer: row.explorer_url,
        $note: row.note,
      });
    this.bump();
  }

  /** Point a registry entry at a key. Enrollment's one write to the registry. */
  setRegistryKey(registryId: string, key: string): void {
    this.db.query('UPDATE registry SET pubkey = $k WHERE registry_id = $id').run({ $k: key, $id: registryId });
    this.bump();
  }

  /**
   * The Demo Agent's enrollment as the page shows it, or null outside the deck
   * scene.
   *
   * `active` is read from the registry itself — the row the gate verifies a
   * request against — never assumed from the enrollment's status, so the page
   * cannot show a key as enrolled that the gate would not accept.
   */
  enrollmentView(): EnrollmentView | null {
    const grant = this.deckGrant();
    if (!grant) return null;

    const row = this.enrollment(grant.registry_id);
    const entry = this.registryEntry(grant.registry_id);
    const status =
      row && (ENROLLMENT_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as EnrollmentStatus)
        : 'none';
    const binding =
      row?.key_binding && (KEY_BINDINGS as readonly string[]).includes(row.key_binding)
        ? (row.key_binding as KeyBinding)
        : null;
    const enrolled = status === 'verified' || status === 'local';

    return {
      status,
      identityMode: identityModeOf(row, this.configuredIdentity),
      registryId: grant.registry_id,
      agentName: DECK.agentName,
      keyPrint: row?.pubkey ? fingerprint(row.pubkey) : null,
      publicKey: row?.pubkey ?? null,
      active: enrolled && !!row?.pubkey && entry?.key === row.pubkey && entry.status === 'active',
      configured: !!row?.registry && !!row.agent_id,
      network: row?.network ?? null,
      chainId: row?.chain_id ?? null,
      registry: row?.registry ?? null,
      agentId: row?.agent_id ?? null,
      owner: row?.owner ?? null,
      expectedOwner: row?.expected_owner ?? null,
      keyBinding: binding,
      blockNumber: row?.block_number ?? null,
      checkedAt: row?.checked_at ?? null,
      explorerUrl: row?.explorer_url ?? null,
      note: row?.note ?? null,
    };
  }

  /* --- the live connector: its own state --- */

  connectorView(): ConnectorView | null {
    const row = this.db.query<{ view: string }, []>('SELECT view FROM connector_state WHERE id = 1').get();
    return row ? (JSON.parse(row.view) as ConnectorView) : null;
  }

  /** Rewrite the connector's state. A no-op when nothing changed, so an idle connector moves no `seq`. */
  setConnector(view: ConnectorView | null): void {
    const next = view === null ? null : JSON.stringify(view);
    const current = this.db.query<{ view: string }, []>('SELECT view FROM connector_state WHERE id = 1').get();
    if ((current?.view ?? null) === next) return;
    if (next === null) this.db.query('DELETE FROM connector_state').run();
    else this.db.query('INSERT OR REPLACE INTO connector_state (id, view) VALUES (1, $v)').run({ $v: next });
    this.bump();
  }

  /* --- lifecycle --- */

  /** Drop every row. Used by `bun run reset`. */
  wipe(): void {
    this.db.transaction(() => {
      for (const table of TABLES) this.db.query(`DELETE FROM ${table}`).run();
      // AUTOINCREMENT counters live here; clearing them keeps ids stable
      // between resets so judges see the same scene.
      this.db.query("DELETE FROM sqlite_sequence WHERE name IN ('telegram','events','gate_runs','payouts','adopted_rules')").run();
    })();
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The identity mode a stored row was made under.
 *
 * Rows written before the column existed have it null. A row that names a
 * registry and an agent id was an ERC-8004 check; anything else was a local key.
 */
function identityModeOf(row: EnrollmentRow | null, configured: IdentityMode): IdentityMode {
  if (row?.identity_mode === 'local' || row?.identity_mode === 'erc8004') return row.identity_mode;
  if (row?.registry && row.agent_id) return 'erc8004';
  return configured;
}

/** Add a column to a table created before it existed. New databases already have it. */
function ensureColumn(db: Database, table: string, column: string, type: string): void {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (cols.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Open (and migrate) the database. `:memory:` in tests. */
export function openStore(path = process.env.DATABASE_PATH ?? 'data/overduel.sqlite'): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);
  ensureColumn(db, 'agent_enrollment', 'identity_mode', 'TEXT');
  ensureColumn(db, 'deck_grant', 'ask_pct', 'INTEGER');

  return new Store(db);
}
