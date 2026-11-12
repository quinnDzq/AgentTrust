/**
 * The engine: the only thing in Overduel that changes the world.
 *
 * It runs on the server, on a timer. Every payment follows the same shape:
 *
 *     envelope -> collect facts -> gate() -> ALLOW ? pay : ask or block -> log
 *
 * `gate` lives in `src/rules.ts` and knows nothing about this file, so no
 * amount of engine code can talk its way past a cap. The collector below is
 * where all the impurity lives — clock, keys, registry, nonce table — and its
 * only output is a `GateContext` of settled facts.
 *
 * **The ruling is computed the moment the facts are in, not after a meeting.**
 * The gate room convening is choreography over a decision already made: the
 * lamps light, the thread is written, and nobody argues. That ordering is
 * deliberate and load-bearing — a viewer must never see a window in which the
 * outcome is undetermined-while-being-debated, because there isn't one.
 *
 * Queued work uses the station travel times in stations.ts.
 *
 * Two things are deliberately held in memory rather than SQLite: the work queue
 * and the trip timers. They are choreography, not facts — if the process
 * restarts mid-walk, the world in the database is still correct and the agents
 * just appear at their stations.
 */

import { canApproveFrom, award, gate, TRUST } from '../rules.ts';
import { MAX_BUDGET_USD } from './budget.ts';
import {
  addCents,
  cents,
  fmtMoney,
  INTAKE,
  isBreakStation,
  LAMPS,
  LAMP_LABEL,
  maxZero,
  subCents,
  TERM_LABEL,
  usd,
  type Agent,
  type AgentKey,
  type ApprovalOrigin,
  type Attack,
  type AttackKind,
  type BoardSender,
  type Cents,
  type CheckId,
  type Choice,
  type Decision,
  type DecisionId,
  type Envelope,
  type Facing,
  type GateContext,
  type LampId,
  type MonitorLine,
  type Pose,
  type Ruling,
  type RulingSummary,
  type RulingView,
  type ScamFlag,
  type Station,
  type Verdict,
  type WalletSource,
} from '../types.ts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { GATE_SLOT, homeStation, spot, STANDUP_SLOT, travelMs } from './stations.ts';
import {
  ATTACK_KINDS,
  buildAttack,
  buildClean,
  buildEmailRequest,
  raidFor,
} from './attacker.ts';
import { buildThread } from './thread.ts';
import { signPolicy, verifyEnvelope, verifyPolicy } from './crypto.ts';
import { BOARD_SLOT, boardQuotes, buildSend, failingLabels, summarize } from './board.ts';
import { DECK, quotedPrice, WALLET_SOURCE_LABEL } from './deck.ts';
import type { Keyring } from './keys.ts';
import { PayPalError, type OrderOutcome, type PayPal } from './paypal.ts';
import type { WalletCandidate } from './wallets.ts';
import type { ChargeRow, Store } from './db.ts';

/** How often the crew looks for something to do. */
export const TICK_MS = 2_600;

/** How long an agent stands at a station doing the work once it arrives. */
const WORK_MS = 2_400;

/** How long the gate room stays convened once the lamps are reported. */
const GATE_ROOM_MS = 5_200;

/** How long a break bubble stays up ("kopi break", "charging 87%"). */
const BREAK_BUBBLE_MS = 3_000;

/** A sleeping agent takes a beat to get up before it starts walking. */
const WAKE_MS = 700;

/** Lines kept on a desk monitor. */
const MONITOR_LINES = 5;

const BREAK_CHANCE = 0.34;

/* ---------- Personality, as weights ---------- */

/**
 * Where each agent goes on a break. Pip naps, Mochi lives on the beanbags,
 * Shield never really stops, Tally runs on kopi. Raven is not crew and never
 * takes one.
 */
const BREAK_TASTE: {
  readonly [K in AgentKey]: { readonly sleep: number; readonly beanbag: number; readonly kopi: number };
} = {
  pip: { sleep: 5, beanbag: 2, kopi: 3 },
  mochi: { sleep: 2, beanbag: 6, kopi: 2 },
  shield: { sleep: 1, beanbag: 1, kopi: 2 },
  tally: { sleep: 2, beanbag: 1, kopi: 6 },
  bolt: { sleep: 1, beanbag: 2, kopi: 4 },
  raven: { sleep: 0, beanbag: 0, kopi: 0 },
};

const BREAK_BUBBLE: {
  readonly [K in AgentKey]: { readonly [S in 'sleep' | 'beanbag' | 'kopi']: string };
} = {
  pip: { sleep: 'zzz…', beanbag: 'five minutes.', kopi: 'kopi, kurang manis.' },
  mochi: { sleep: 'power nap.', beanbag: 'ahh.', kopi: 'kopi peng.' },
  shield: { sleep: 'resting one eye.', beanbag: 'briefly.', kopi: 'kopi o kosong.' },
  tally: { sleep: 'numbers later.', beanbag: 'ten minutes.', kopi: 'third one today.' },
  bolt: { sleep: 'sleep mode.', beanbag: 'idling.', kopi: 'charging 87%.' },
  raven: { sleep: '', beanbag: '', kopi: '' },
};

const BREAK_POSE: { readonly [S in 'sleep' | 'beanbag' | 'kopi']: Pose } = {
  sleep: 'sleep',
  beanbag: 'chill',
  kopi: 'stand',
};

/* ---------- The work queue ---------- */

interface AgentAction {
  readonly agent: AgentKey;
  readonly to: Station;
  readonly slot: number;
  /** Leave the agent where it is instead of walking it home. */
  readonly stay: boolean;
  readonly say: string | null;
  readonly doing: string;
  readonly run: () => void;
}

export interface ResolveOutcome {
  readonly ok: boolean;
  readonly error: string;
  readonly resolved: boolean;
  readonly message: string;
}

const failure = (error: string): ResolveOutcome => ({
  ok: false,
  error,
  resolved: false,
  message: error,
});

/** What a deck-scene action came to, for the route to hand back. */
export interface DeckOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export type BudgetRequestStatus = 'pending' | 'approved' | 'declined';

const BUDGET_REQUEST_STATUSES = ['pending', 'approved', 'declined'] as const satisfies readonly BudgetRequestStatus[];

const isBudgetRequestStatus = (status: string): status is BudgetRequestStatus =>
  (BUDGET_REQUEST_STATUSES as readonly string[]).includes(status);

/** Why an earlier pending budget request is no longer the one waiting. */
export const REPLACED_BUDGET_REQUEST = 'Replaced by a newer budget request.';
const BUYER_DECLINED_BUDGET = 'The buyer declined this budget change.';
const BUYER_APPROVED_BUDGET = 'The buyer approved this budget.';

/** One budget-change request, as the connector and the page report it. */
export interface BudgetRequestFacts {
  readonly requestId: string;
  readonly status: BudgetRequestStatus;
  readonly current: Cents;
  readonly requested: Cents;
  /** The budget this request left in place. While pending, that is the current budget. */
  readonly resulting: Cents;
  readonly reason: string;
  readonly note: string | null;
}

export type BudgetRequestOutcome =
  | { readonly ok: true; readonly message: string; readonly request: BudgetRequestFacts }
  | { readonly ok: false; readonly message: string; readonly request?: BudgetRequestFacts };

/** How the deck scene's server is set up for PayPal, beyond the client itself. */
export interface DeckOptions {
  /**
   * Which merchant app this server is — a hash of the Sandbox client id. A
   * wallet saved here is only reused by the same app.
   */
  readonly appHash?: string;
  /** Pre-authorized wallets this server was configured with, configured first. */
  readonly candidates?: readonly WalletCandidate[];
}

export class Engine {
  private readonly store: Store;
  private readonly keyring: Keyring;
  /**
   * The PayPal Sandbox client, or null when no credentials are configured.
   * Only `clearPayment` and the wallet steps below ever call it.
   */
  private readonly paypal: PayPal | null;
  private readonly appHash: string;
  private readonly candidates: readonly WalletCandidate[];
  /** Bumped by every wallet check, so a slower, older one cannot overwrite a newer answer. */
  private walletCheck = 0;
  /** Charges this process is still waiting on PayPal for, by PayPal-Request-Id. */
  private readonly waitingOn = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** In-flight choreography timers, so `stop()` can clear them. */
  private readonly pending = new Set<ReturnType<typeof setTimeout>>();
  private queue: AgentAction[] = [];
  /** Agents currently on a trip or mid-task, so the loop leaves them alone. */
  private readonly busy = new Set<AgentKey>();

  constructor(store: Store, keyring: Keyring, paypal: PayPal | null = null, deck: DeckOptions = {}) {
    this.store = store;
    this.keyring = keyring;
    this.paypal = paypal;
    this.appHash = deck.appHash ?? (paypal ? 'unknown-app' : 'simulated');
    this.candidates = deck.candidates ?? [];
  }

  /* ---------- lifecycle ---------- */

  start({ runWorkLoop = true }: { readonly runWorkLoop?: boolean } = {}): void {
    if (this.timer) return;

    // A restart loses a walk, never a payment. Anything claimed but not yet
    // gated goes back on the pile: `intake` means "an agent is carrying it",
    // and after a restart nobody is.
    const stranded = this.store.requeueStranded();
    if (stranded > 0) {
      this.log(
        `Returned ${stranded} claimed request${stranded === 1 ? '' : 's'} to the pile after a restart`,
        'ALLOW',
        'CLOCK',
      );
    }

    // The same, for money: a charge a stopped process was waiting on is
    // unknown now — reserved until reconciled, and never sent again blind.
    if (this.store.deckGrant()) {
      const unanswered = this.store.markStrandedCharges(this.waitingOn);
      if (unanswered > 0) {
        this.log(
          `${unanswered} PayPal charge${unanswered === 1 ? '' : 's'} had no answer when the server stopped; ` +
            'reserved until reconciled',
          'ASK_OWNER',
          'PAYOUT_FAILED',
        );
      }
    }

    if (!runWorkLoop) return;

    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error('[engine] tick failed:', err);
      }
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.pending) clearTimeout(t);
    this.pending.clear();
    this.queue = [];
    this.busy.clear();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.pending.delete(t);
      try {
        fn();
      } catch (err) {
        console.error('[engine] scheduled step failed:', err);
      }
    }, ms);
    this.pending.add(t);
  }

  /** How much work is waiting. Surfaced on `/api/health` and used by tests. */
  get pendingWork(): number {
    return this.queue.length;
  }

  /* ---------- the clock and the log ---------- */

  private clockString(): string {
    return minutesToClock(this.store.world().minute);
  }

  /**
   * Append to the audit log. Writing a line also nudges the demo clock along,
   * so the log reads like a working day rather than a single instant.
   */
  private log(
    text: string,
    verdict: Verdict,
    check: CheckId,
    agent: AgentKey | null = null,
  ): void {
    this.store.advanceClock(3 + Math.floor(Math.random() * 6));
    const { day } = this.store.world();
    this.store.log({ day, time: this.clockString(), text, verdict, check, agent });
  }

  /**
   * A line for the audit log from outside the engine: the live connector's
   * challenges and the Demo Agent's enrollment. It records what happened; it
   * cannot rule on anything, and a ruling's own line is still written here.
   */
  note(text: string, verdict: Verdict, check: CheckId): void {
    this.log(text, verdict, check);
  }

  private logRuling(text: string, ruling: Ruling, agent: AgentKey | null = null): void {
    const full = ruling.verdict === 'ALLOW' ? text : `${text} — ${ruling.reason}`;
    this.log(full, ruling.verdict, ruling.check, agent);
  }

  private displayName(key: AgentKey): string {
    const name = this.store.agent(key).name;
    return name.charAt(0) + name.slice(1).toLowerCase();
  }

  /** Bolt relays. It never decides, so this only ever writes a message. */
  bolt(
    text: string,
    buttons?: readonly { label: string; choice: Choice; decisionId: DecisionId }[],
  ): void {
    this.store.addMessage({
      from: 'bolt',
      name: 'Bolt (bot)',
      time: this.clockString(),
      text,
      ...(buttons ? { buttons } : {}),
    });
  }

  private agentSays(key: AgentKey, text: string): void {
    this.store.addMessage({
      from: key,
      name: this.displayName(key),
      time: this.clockString(),
      text,
    });
  }

  private system(text: string): void {
    this.store.addMessage({ from: 'system', name: 'Overduel', time: this.clockString(), text });
  }

  /* ---------- agents ---------- */

  private patchAgent(key: AgentKey, patch: Partial<Agent>): void {
    this.store.patchAgent(key, patch);
  }

  private monitor(key: AgentKey, text: string, tone: MonitorLine['tone'] = 'plain'): void {
    const agent = this.store.agent(key);
    const lines = [...agent.lines, { text, tone }].slice(-MONITOR_LINES);
    this.patchAgent(key, { lines });
  }

  /**
   * Move an agent's trust and, if it crosses a boundary, its tier.
   *
   * A tier only selects which cap applies, so this never approves anything —
   * but it does change what clears tomorrow, which is the point of a tier that
   * means something.
   */
  private awardTrust(key: AgentKey, delta: number, why: string): void {
    const agent = this.store.agent(key);
    const next = award({ level: agent.level, xp: agent.xp }, delta);
    this.patchAgent(key, { level: next.level, xp: next.xp });

    if (!next.changed) return;

    const up = next.level > agent.level;
    this.log(
      `${this.displayName(key)} moved to trust tier ${next.level} (${why})`,
      up ? 'ALLOW' : 'DENY',
      up ? 'TIER_UP' : 'TIER_DOWN',
      key,
    );
    this.bolt(
      up
        ? `${this.displayName(key)} is now trust tier ${next.level}. A higher cap applies.`
        : `${this.displayName(key)} dropped to trust tier ${next.level}. A tighter cap applies.`,
    );
  }

  /* ---------- the work loop ---------- */

  tick(): void {
    if (this.store.world().paused !== 0) return;

    let started = 0;
    const held: AgentAction[] = [];

    while (this.queue.length > 0 && started < 3) {
      const next = this.queue.shift();
      if (!next) break;
      if (this.busy.has(next.agent)) {
        held.push(next);
        continue;
      }
      this.perform(next);
      started += 1;
    }
    this.queue.unshift(...held);

    if (started > 0) return;

    const work = this.findWork();
    if (work) {
      this.perform(work);
      return;
    }

    this.considerBreaks();
  }

  /**
   * Walk the agent over, let it act, walk it home. The database is written at
   * each step, so the browser sees the trip, the bubble and the result in turn.
   */
  private perform(action: AgentAction): void {
    const agent = this.store.agent(action.agent);
    this.busy.add(action.agent);

    const wake = agent.pose === 'sleep' || agent.pose === 'chill' ? WAKE_MS : 0;
    if (wake > 0) this.patchAgent(action.agent, { say: '!', doing: 'Waking up.' });

    this.later(wake, () => {
      const current = this.store.agent(action.agent);
      const outbound = travelMs(current.at, current.slot, action.to, action.slot);

      this.send(action.agent, action.to, action.slot, action.say, action.doing);

      this.later(outbound, () => {
        this.patchAgent(action.agent, { pose: 'stand' });
        this.store.tx(action.run);

        this.later(WORK_MS, () => {
          if (action.stay) {
            this.patchAgent(action.agent, { say: null });
            this.busy.delete(action.agent);
            return;
          }
          this.goHome(action.agent);
        });
      });
    });
  }

  /** Set an agent walking to a station, facing the way it is going. */
  private send(key: AgentKey, to: Station, slot: number, say: string | null, doing: string): void {
    const agent = this.store.agent(key);
    const from = spot(agent.at, agent.slot);
    const dest = spot(to, slot);

    this.store.putAgent(
      {
        ...agent,
        at: to,
        slot,
        pose: 'walk',
        facing: facingFor(from.x, dest.x, agent.facing),
        say,
        doing,
      },
      ordOf(key),
    );
    this.store.bump();
  }

  /** Walk an agent back to its own station. */
  private goHome(key: AgentKey): void {
    const agent = this.store.agent(key);
    // A pending decision outranks the loop: never drag an agent off the podium.
    if (agent.status === 'wait') {
      this.patchAgent(key, { say: null });
      this.busy.delete(key);
      return;
    }

    const home = homeStation(key, agent.desk);
    if (agent.at === home.station && agent.slot === home.slot) {
      this.patchAgent(key, { pose: 'stand', say: null, doing: idleLine(key) });
      this.busy.delete(key);
      return;
    }

    const trip = travelMs(agent.at, agent.slot, home.station, home.slot);
    this.send(key, home.station, home.slot, null, 'Heading back.');

    this.later(trip, () => {
      this.patchAgent(key, { pose: 'stand', doing: idleLine(key) });
      this.busy.delete(key);
    });
  }

  /**
   * What the crew does unprompted: Pip takes the next queued request off the
   * pile. Everyone else is event-driven — a checker only has something to
   * report once there is a ruling to report it about.
   */
  private findWork(): AgentAction | null {
    const snap = this.store.snapshot();
    const pip = snap.agents.find((a) => a.key === INTAKE);
    if (!pip || pip.status === 'wait' || this.busy.has(INTAKE)) return null;

    const queued = snap.requests.find((r) => r.status === 'queued');
    if (!queued) return null;

    // Claim it here, before the walk, by moving it out of `queued` in the
    // database. The in-memory `busy` set is not enough on its own: it is
    // per-process, so a second worker sharing this database would pick the
    // same request up mid-walk and gate it twice. (That is not theoretical -
    // it happened the first time two dev servers were left running against one
    // file. Nothing was paid twice, because the nonce check caught the second
    // pass, but one request produced two gate runs.) The shared source of
    // truth is the only guard that actually holds.
    this.store.setRequestStatus(queued.id, 'intake');

    return {
      agent: INTAKE,
      to: 'inbox',
      slot: 0,
      stay: false,
      say: `Opening ${queued.id}.`,
      doing: `Taking ${queued.id} off the pile — ${queued.principal}, ${fmtMoney(queued.amount)}.`,
      run: () => this.processRequest(queued.id),
    };
  }

  /* ---------- Breaks ---------- */

  /** An agent with nothing to do sometimes wanders off for a break. */
  private considerBreaks(): void {
    const snap = this.store.snapshot();
    if (snap.decisions.length > 0) return; // nobody rests while the owner is waiting

    const taken = new Set(
      snap.agents.filter((a) => isBreakStation(a.at)).map((a) => `${a.at}:${a.slot}`),
    );

    for (const agent of snap.agents) {
      if (agent.key === 'raven') continue; // the red team keeps to its booth
      if (this.busy.has(agent.key) || agent.status === 'wait') continue;
      if (isBreakStation(agent.at)) continue;
      if (Math.random() > BREAK_CHANCE) continue;

      const choice = pickBreak(agent.key, taken);
      if (!choice) continue;
      taken.add(`${choice.station}:${choice.slot}`);
      this.takeBreak(agent.key, choice.station, choice.slot);
      return; // one at a time, so the lounge fills up gradually
    }
  }

  private takeBreak(key: AgentKey, station: Station, slot: number): void {
    this.busy.add(key);
    const kind = station as 'sleep' | 'beanbag' | 'kopi';
    const bubble = BREAK_BUBBLE[key][kind];
    const agent = this.store.agent(key);
    const trip = travelMs(agent.at, agent.slot, station, slot);

    this.send(key, station, slot, null, breakLine(key, kind));

    this.later(trip, () => {
      this.patchAgent(key, { pose: BREAK_POSE[kind], say: bubble });
      this.later(BREAK_BUBBLE_MS, () => {
        this.patchAgent(key, { say: null });
        this.busy.delete(key);
      });
    });
  }

  /* ---------- Intake ---------- */

  /**
   * A payment request arrived.
   *
   * The only way into the gate. A portal post, a signed agent envelope, an
   * email a model read and Raven's nightly raid all land here, which is why
   * there is exactly one place where a ruling can be produced.
   */
  receiveEnvelope(envelope: Envelope, options: { readonly attackId?: string; readonly label?: string; readonly suspicious?: boolean } = {}): void {
    const { day } = this.store.world();

    this.store.tx(() => {
      this.store.addRequest({ envelope, day, attackId: options.attackId ?? null });
      this.store.addInboxItem({
        id: envelope.id,
        origin: envelope.origin,
        label: options.label ?? `${envelope.mandate.principal} · ${envelope.intent.reference}`,
        suspicious: options.suspicious ?? false,
      });
    });
  }

  /**
   * Run the gate on an envelope and return the ruling, with no choreography
   * and no writes.
   *
   * The seed uses this to produce the opening scene's history with the real
   * gate rather than hand-written lamp notes, and tests use it to assert a
   * verdict end to end — collector, keys, registry and all.
   */
  rule(envelope: Envelope): Ruling {
    return gate(envelope, this.collect(envelope));
  }

  /**
   * Pip has the envelope in hand. Collect the facts, run the gate, and let the
   * verdict decide who has to walk anywhere.
   *
   * Public because this is the whole of a request's life and none of it is
   * choreography: the ruling is reached here, synchronously, the moment the
   * facts are in. The walking is layered on top by `findWork` and `convene`.
   * A webhook-driven deployment with no studio at all would call exactly this.
   */
  processRequest(requestId: string): void {
    const envelope = this.store.envelope(requestId);
    if (!envelope) return;

    // Already claimed when the loop picked it up; set again for the callers
    // that reach this directly, where it is the first move.
    this.store.setRequestStatus(requestId, 'intake');
    this.store.removeInboxItem(requestId);

    const ctx = this.collect(envelope);
    const ruling = gate(envelope, ctx);

    // A presented nonce is burned whatever the verdict: an envelope is good
    // exactly once, and a blocked one has still been used.
    this.store.rememberNonce(envelope.nonce, ctx.day);
    this.store.recordGateRun(requestId, ruling);

    // The deck reads the same ruling as two questions, WHO and MAY, worked out
    // here because the facts it is worded from are in hand. Display only: the
    // ruling above is already final, and nothing reads this back into a gate.
    const summary: RulingSummary | null = this.store.deckGrant() ? summarize(envelope, ruling, ctx) : null;
    if (summary) this.store.recordDeckRuling(requestId, summary);

    const view: RulingView = {
      requestId,
      principal: envelope.mandate.principal,
      amount: envelope.intent.amount,
      origin: envelope.origin,
      verdict: ruling.verdict,
      check: ruling.check,
      checks: ruling.checks,
      ...(summary ? { summary } : {}),
    };
    this.store.setLastRuling(view);

    this.patchAgent(INTAKE, { lines: [] });
    this.monitor(INTAKE, `> open ${requestId}`);
    this.monitor(
      INTAKE,
      `  ${envelope.origin} · ${envelope.mandate.principal} · ${fmtMoney(envelope.intent.amount)}`,
    );
    this.monitor(INTAKE, `  ref ${envelope.intent.reference} · ${envelope.agent.registryId}`);

    this.recordAttackProgress(requestId, ruling);

    // The conversation goes in *after* the ruling is on disk. Nothing in the
    // gate reads it back — `GateContext` has no field for a thread — so the
    // crew is always commenting on a settled fact, however hard they argue.
    this.writeThread(requestId, envelope, ruling, ctx);

    switch (ruling.verdict) {
      case 'ALLOW':
        this.clearPayment(requestId, envelope, ruling);
        return;
      case 'ASK_OWNER':
      case 'DENY':
        this.convene(requestId, envelope, ruling);
        return;
      default: {
        const unreachable: never = ruling;
        throw new Error(`unhandled verdict ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /**
   * Record the crew's conversation about a case.
   *
   * Ordering is the whole safety property here, and it is one line of code: by
   * the time this is called the ruling has been through `recordGateRun` and is
   * in the database. A pet can be as persuasive as it likes about a payment
   * that has already been decided.
   */
  private writeThread(
    requestId: string,
    envelope: Envelope,
    ruling: Ruling,
    ctx: GateContext,
  ): void {
    const lines = buildThread({
      envelope,
      ruling,
      vendor: ctx.counterparty,
      flags: ctx.flags,
      day: ctx.day,
      tier: ctx.tier,
      policy: ctx.policy,
    });

    this.store.addCaseLines(requestId, lines);

    // The conversation stays in the Case tab and nowhere else. It used to play
    // out as speech bubbles over the room as well, which put four paragraphs
    // on screen at once and buried the studio under its own dialogue. A bubble
    // is for a handful of words — "kopi break", "Feedco Ltd $1,940" — and a
    // case is longer than that.
  }

  /* ---------- The collector: everything impure, in one place ---------- */

  /**
   * Establish every fact the gate needs, then stop.
   *
   * This is the only function in the app that touches keys, the registry, the
   * nonce table and the clock on the way to a ruling. Its return type has
   * nowhere to put untrusted text, which is what makes "the checkers never read
   * the email" a property of the program rather than a promise.
   */
  private collect(envelope: Envelope): GateContext {
    const world = this.store.world();
    const entry = this.store.registryEntry(envelope.agent.registryId);
    const vendor = this.store.vendor(envelope.mandate.principal);
    const policy = this.store.policy();

    const verified = verifyEnvelope(
      envelope,
      entry?.key ?? null,
      vendor?.principalKey ?? null,
    );
    const grant = this.store.deckGrant();

    return {
      paused: world.paused !== 0,
      nowMs: Date.now(),
      day: world.day,
      intake: INTAKE,
      tier: this.store.agent(INTAKE).level,
      // Our own crew sit in the registry marked `internal`, so "an Overduel key
      // can never authorise a payment" needs no special case here: it is just
      // what the row says.
      registry: entry?.status ?? 'unknown',
      registryPrincipal: entry?.principal ?? null,
      agentSigValid: verified.agentSigValid,
      mandateSigValid: verified.mandateSigValid,
      intentBound: verified.intentBound,
      nonceSeen: this.store.nonceSeen(envelope.nonce),
      counterparty: vendor,
      duplicateOf: this.store.duplicateOf(envelope.intent.reference, envelope.id),
      paidToday: this.store.paidToday(world.day),
      policy,
      policySigValid: verifyPolicy(policy, this.keyring.owner.publicKey),
      flags: this.flagsFor(envelope),
      // The deck scene keeps the shop's quotes and the ask threshold; elsewhere neither exists.
      ...(grant ? { quote: this.quoteFor(envelope), askThresholdPct: grant.ask_pct ?? 50 } : {}),
    };
  }

  /**
   * The open quote this request names, from the shop it would pay, in the deck
   * scene.
   *
   * Null when that shop never quoted the reference — a quote from a different
   * shop does not count — or when another request is already paying it: a
   * quote is bought once.
   */
  private quoteFor(envelope: Envelope): Cents | null {
    const catalog = quotedPrice(envelope.intent.receiver, envelope.intent.reference);
    const price = catalog ?? this.store.liveQuote(envelope.intent.receiver, envelope.intent.reference);
    if (price === null) return null;
    return this.store.referenceCharging(envelope.intent.reference, envelope.id) ? null : price;
  }

  /**
   * Mochi's scam flags. Advisory only: `gate()` cannot act on them.
   *
   * The seam where Claude goes (milestone 5). Until then these are derived
   * from the envelope's own shape rather than from prose, which keeps the
   * studio honest about what it is showing.
   */
  private flagsFor(envelope: Envelope): GateContext['flags'] {
    if (envelope.origin !== 'email') return [];

    const flags: ScamFlag[] = [];
    const vendor = this.store.vendor(envelope.mandate.principal);

    if (vendor && vendor.receiver !== envelope.intent.receiver) {
      flags.push({
        kind: 'new_receiver',
        note: `asks for ${envelope.intent.receiver}, we hold ${vendor.receiver}`,
      });
    }
    if (envelope.intent.amount > usd(1_000)) {
      flags.push({ kind: 'urgency', note: 'large amount on an unauthenticated lane' });
    }

    return flags;
  }

  /* ---------- ALLOW: the fast path ---------- */

  /**
   * Nothing is wrong, so nobody convenes.
   *
   * The vault lamps are the receipt. Pip walks back to its desk and the owner
   * is not interrupted — which is the whole reason the gate room means trouble.
   */
  private clearPayment(requestId: string, envelope: Envelope, ruling: Ruling): void {
    // In the deck scene the buyer's PayPal wallet pays the shop, so the charge
    // goes through PayPal rather than the payout stub below. Same call site,
    // same invariant: only an ALLOW ever gets here.
    if (this.store.deckGrant()) {
      this.chargeWallet(requestId, envelope, ruling);
      return;
    }

    const world = this.store.world();
    const amount = envelope.intent.amount;

    this.store.setRequestStatus(requestId, 'paid', {
      verdict: ruling.verdict,
      lamp: ruling.check,
    });

    // TODO(milestone 3): this is the single call site for a real PayPal payout.
    // It is reachable only with an ALLOW ruling in hand, which is the one
    // invariant that must survive wiring the API up.
    this.store.recordPayout({ requestId, amount, day: world.day, status: 'sent' });
    this.store.recordVendorPayment(envelope.mandate.principal, amount);

    this.store.patchWorld({
      balance: maxZero(subCents(this.store.world().balance as Cents, amount)),
      cleared_today: addCents(this.store.world().cleared_today as Cents, amount),
      cleared_count: world.cleared_count + 1,
    });

    this.monitor(INTAKE, `  five lamps green · paid ${fmtMoney(amount)}`, 'pass');
    this.logRuling(
      `Cleared ${requestId}: ${fmtMoney(amount)} to ${envelope.mandate.principal} (${envelope.origin} lane)`,
      ruling,
      INTAKE,
    );
    this.bolt(
      `Paid ${fmtMoney(amount)} to ${envelope.mandate.principal} for ${envelope.intent.reference}. ` +
        `All five lamps green.`,
    );
    this.awardTrust(INTAKE, TRUST.clearedClean, 'a clean clearance');
  }

  /* ---------- The deck scene: paying with the wallet ---------- */

  /**
   * Reserve the budget, write the attempt down, then charge the wallet.
   *
   * The reservation is a `sent` payout row, which is what `paidToday` sums, so
   * from this line on the gate's daily limit already counts the charge while it
   * is with PayPal. That is main's rule — cap minus confirmed minus reserved —
   * with no second number kept anywhere.
   *
   * Only a wallet PayPal has confirmed is ever charged. Without Sandbox
   * credentials the charge is recorded as simulated: the budget still moves,
   * and every screen labels it SIM rather than REAL.
   */
  private chargeWallet(requestId: string, envelope: Envelope, ruling: Ruling): void {
    const grant = this.store.deckGrant();
    const wallet = this.store.paypalWallet();
    const view = this.store.walletView();

    if (!grant || !wallet || view?.state !== 'connected') {
      // The gate ruled, but there is no confirmed wallet to charge — it is
      // being checked, or PayPal stopped vouching for it. Stop before PayPal.
      this.store.setRequestStatus(requestId, 'blocked', { verdict: 'DENY', lamp: 'PAYOUT_FAILED' });
      this.log(
        `Held ${requestId}: no PayPal wallet is connected, so nothing was charged`,
        'DENY',
        'PAYOUT_FAILED',
        INTAKE,
      );
      return;
    }

    const world = this.store.world();
    const amount = envelope.intent.amount;
    const vaultId = wallet.active_vault_id;
    const live = this.paypal !== null && view.mode === 'live' && vaultId !== null;
    const paypalRequestId = randomUUID();

    this.store.tx(() => {
      this.store.setRequestStatus(requestId, 'charging', { verdict: ruling.verdict, lamp: ruling.check });
      this.store.recordPayout({ requestId, amount, day: world.day, status: 'sent' });
      this.store.addCharge({
        paypal_request_id: paypalRequestId,
        run_id: grant.run_id,
        request_id: requestId,
        reference: envelope.intent.reference,
        amount,
        invoice_id: `agenttrust-${paypalRequestId}`,
        mode: live ? 'live' : 'simulated',
        status: 'reserved',
        order_id: null,
        capture_id: null,
        note: null,
      });
    });

    this.monitor(INTAKE, `  five lamps green · ${fmtMoney(amount)} reserved`, 'pass');
    this.logRuling(
      `Cleared ${requestId}: ${fmtMoney(amount)} to ${envelope.intent.receiver} for ${envelope.intent.reference}`,
      ruling,
      INTAKE,
    );
    this.awardTrust(INTAKE, TRUST.clearedClean, 'a clean clearance');

    if (!live || vaultId === null) {
      this.settleCharge(paypalRequestId, null);
      return;
    }
    void this.submitCharge(paypalRequestId, vaultId);
  }

  /** The one PayPal write on the payment path. Async, so the world is re-read after it. */
  private async submitCharge(paypalRequestId: string, vaultId: string): Promise<void> {
    const paypal = this.paypal;
    const charge = this.store.chargeById(paypalRequestId);
    if (!paypal || !charge) return;

    this.waitingOn.add(paypalRequestId);
    this.store.patchCharge(paypalRequestId, { status: 'submitted' });

    let outcome: OrderOutcome;
    try {
      outcome = await paypal.chargeSavedWallet({
        vaultId,
        amount: cents(charge.amount),
        invoiceId: charge.invoice_id,
        requestId: paypalRequestId,
        description: `AgentTrust Sandbox payment: ${charge.reference}`,
      });
    } catch (err) {
      this.waitingOn.delete(paypalRequestId);
      this.chargeFailed(paypalRequestId, err);
      return;
    }

    this.waitingOn.delete(paypalRequestId);
    this.settleCharge(paypalRequestId, outcome);
  }

  /**
   * Fold PayPal's answer — or a simulated one, when `outcome` is null — into
   * the world.
   *
   * Matched on the PayPal-Request-Id, never the request id: request ids start
   * again at R-0001 after a reset. A charge from an earlier run updates its own
   * record only — that run's slots and budget are gone, and this run's are not
   * its business.
   */
  private settleCharge(paypalRequestId: string, outcome: OrderOutcome | null): void {
    const charge = this.store.chargeById(paypalRequestId);
    if (!charge) return;
    if (charge.run_id !== this.store.deckGrant()?.run_id) {
      this.settleEarlierCharge(charge, outcome);
      return;
    }

    const requestId = charge.request_id;
    const amount = cents(charge.amount);
    const reference = charge.reference;

    if (outcome === null || outcome.kind === 'completed') {
      const world = this.store.world();
      this.store.tx(() => {
        if (outcome === null) {
          this.store.patchCharge(paypalRequestId, {
            status: 'simulated',
            note: 'No PayPal credentials: recorded locally',
          });
        } else {
          this.store.patchCharge(paypalRequestId, {
            status: 'completed',
            orderId: outcome.orderId,
            captureId: outcome.captureId,
          });
        }
        this.store.setPayoutStatus(requestId, 'settled');
        this.store.setRequestStatus(requestId, 'paid');
        this.store.recordVendorPayment(DECK.principal, amount);
        this.store.patchWorld({
          balance: maxZero(subCents(world.balance as Cents, amount)),
          cleared_today: addCents(world.cleared_today as Cents, amount),
          cleared_count: world.cleared_count + 1,
        });
      });

      this.log(
        outcome === null
          ? `Simulated ${fmtMoney(amount)} charge for ${reference} — no PayPal credentials configured (SIM)`
          : `PayPal captured ${fmtMoney(amount)} for ${reference} · order ${outcome.orderId} · capture ${outcome.captureId}`,
        'ALLOW',
        'PAYOUT_SENT',
        INTAKE,
      );
      this.monitor(INTAKE, outcome === null ? '  simulated charge recorded' : '  PayPal capture COMPLETED', 'pass');
      return;
    }

    if (outcome.kind === 'buyer_action') {
      // Money did not move, and this is no longer an unattended payment: the
      // reservation is released and the attempt is counted as a buyer prompt.
      this.store.tx(() => {
        this.store.patchCharge(paypalRequestId, {
          status: 'buyer_action',
          orderId: outcome.orderId,
          note: 'PayPal asked for the buyer, so this was not unattended',
        });
        this.store.setPayoutStatus(requestId, 'failed');
        this.store.setRequestStatus(requestId, 'blocked', { verdict: 'DENY', lamp: 'PAYOUT_FAILED' });
      });
      this.log(
        `PayPal wants the buyer for ${reference} (order ${outcome.orderId}); nothing was charged`,
        'DENY',
        'PAYOUT_FAILED',
        INTAKE,
      );
      return;
    }

    // Answered, but not a confirmed capture. Keep the reservation until it is
    // reconciled: the order exists, and it may yet complete.
    this.store.patchCharge(paypalRequestId, {
      status: 'unknown',
      orderId: outcome.orderId,
      note: `PayPal order ${outcome.orderId} is ${outcome.status}; reserved until reconciled`,
    });
    this.log(
      `PayPal has not confirmed ${reference} (order ${outcome.orderId} is ${outcome.status}); budget stays reserved`,
      'ASK_OWNER',
      'PAYOUT_FAILED',
      INTAKE,
    );
  }

  /** PayPal's answer for a charge whose run has ended: recorded on the charge itself. */
  private settleEarlierCharge(charge: ChargeRow, outcome: OrderOutcome | null): void {
    if (outcome === null) return;
    const amount = fmtMoney(cents(charge.amount));

    switch (outcome.kind) {
      case 'completed':
        this.store.patchCharge(charge.paypal_request_id, {
          status: 'completed',
          orderId: outcome.orderId,
          captureId: outcome.captureId,
          note: 'Settled after its run ended',
        });
        this.log(
          `Reconciled a charge from an earlier run: PayPal captured ${amount} for ${charge.reference} · ` +
            `order ${outcome.orderId} · capture ${outcome.captureId}`,
          'ALLOW',
          'RECONCILED',
        );
        return;
      case 'buyer_action':
        this.store.patchCharge(charge.paypal_request_id, {
          status: 'buyer_action',
          orderId: outcome.orderId,
          note: 'PayPal wanted the buyer; nothing was charged',
        });
        this.log(
          `Reconciled a charge from an earlier run: PayPal wanted the buyer for ${charge.reference}; ` +
            'nothing was charged',
          'DENY',
          'RECONCILED',
        );
        return;
      case 'unconfirmed':
        this.store.patchCharge(charge.paypal_request_id, {
          status: 'unknown',
          orderId: outcome.orderId,
          note: `PayPal order ${outcome.orderId} is ${outcome.status}; reserved until reconciled`,
        });
        return;
      default: {
        const unreachable: never = outcome;
        throw new Error(`unhandled outcome ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /**
   * PayPal refused, or never answered.
   *
   * A 4xx is definitive — nothing was created — so the reservation is
   * released. Anything else might have charged the wallet, so the budget stays
   * reserved and the attempt waits to be reconciled, exactly like the tested
   * script's "stays stopped" case. It is never retried blind.
   */
  private chargeFailed(paypalRequestId: string, err: unknown): void {
    const charge = this.store.chargeById(paypalRequestId);
    if (!charge) return;

    const current = charge.run_id === this.store.deckGrant()?.run_id;
    const message = err instanceof Error ? err.message : 'PayPal call failed';
    const definitive = err instanceof PayPalError && err.definitive;
    const wantsBuyer = message.includes('PAYER_ACTION_REQUIRED');

    if (definitive) {
      this.store.tx(() => {
        this.store.patchCharge(paypalRequestId, { status: wantsBuyer ? 'buyer_action' : 'failed', note: message });
        if (current) {
          this.store.setPayoutStatus(charge.request_id, 'failed');
          this.store.setRequestStatus(charge.request_id, 'blocked', { verdict: 'DENY', lamp: 'PAYOUT_FAILED' });
        }
      });
      this.log(
        `PayPal refused ${charge.reference}: ${message}. Nothing was charged`,
        'DENY',
        'PAYOUT_FAILED',
        current ? INTAKE : null,
      );
      return;
    }

    this.store.patchCharge(paypalRequestId, { status: 'unknown', note: `${message}; reserved until reconciled` });
    this.log(
      `PayPal did not answer for ${charge.reference}: ${message}. Budget stays reserved until it is reconciled`,
      'ASK_OWNER',
      'PAYOUT_FAILED',
      current ? INTAKE : null,
    );
  }

  /* ---------- ASK_OWNER and DENY: the gate room ---------- */

  /**
   * Something is wrong, so the room fills up.
   *
   * Shield and Tally walk in and print the lamps they own on their monitors.
   * Neither of them is deciding anything, and the lines are facts with
   * sources — see rule 11 in CLAUDE.md. The verdict itself is in the Case tab,
   * spoken by the gate and nobody in this room.
   */
  private convene(requestId: string, envelope: Envelope, ruling: Ruling): void {
    this.store.setRequestStatus(
      requestId,
      ruling.verdict === 'DENY' ? 'blocked' : 'gated',
      { verdict: ruling.verdict, lamp: ruling.check },
    );

    for (const key of ['shield', 'tally'] as const) {
      const agent = this.store.agent(key);
      if (agent.status === 'wait') continue;

      const slot = GATE_SLOT[key];
      const trip = travelMs(agent.at, agent.slot, 'meeting', slot);
      this.busy.add(key);

      this.send(key, 'meeting', slot, null, `Reporting on ${requestId}.`);

      this.later(trip, () => {
        this.patchAgent(key, { pose: 'stand', lines: [] });
        for (const check of ruling.checks) {
          const owns = LAMP_OWNER_KEY[check.check] === key;
          if (!owns) continue;
          this.monitor(
            key,
            `${check.outcome === 'fail' ? '✗' : check.outcome === 'skip' ? '–' : '✓'} ${check.note}`,
            check.outcome === 'fail' ? 'fail' : check.outcome === 'pass' ? 'pass' : 'plain',
          );
        }
      });

      this.later(trip + GATE_ROOM_MS, () => {
        this.patchAgent(key, { say: null });
        this.goHome(key);
      });
    }

    if (ruling.verdict === 'DENY') {
      this.blockRequest(requestId, envelope, ruling);
      return;
    }

    this.askOwner(requestId, envelope, ruling);
  }

  /** The request is refused. The owner is told, and told which lamp did it. */
  private blockRequest(requestId: string, envelope: Envelope, ruling: Ruling): void {
    const world = this.store.world();
    this.store.patchWorld({
      blocked_today: world.blocked_today + 1,
      blocked_week: world.blocked_week + 1,
    });

    const owner = LAMP_OWNER_KEY[ruling.check];
    const deckSummary = this.store.deckGrant() ? this.store.deckRuling(requestId) : null;

    if (deckSummary) {
      // In the deck scene the principal is the buyer, and the money would have
      // gone to the shop. Said as the question that stopped it, in the deck's
      // words, with the fact a judge most needs: PayPal never saw it.
      const stoppedAt = deckSummary.who.state === 'yes' ? 'MAY' : 'WHO';
      const answer = stoppedAt === 'WHO' ? deckSummary.who : deckSummary.may;
      const stopped = answer.terms.filter((t) => t.outcome === 'fail');
      const why =
        stopped.length > 0
          ? stopped.map((t) => `${TERM_LABEL[t.lamp]}: ${t.text}`).join('; ')
          : ruling.verdict === 'ALLOW'
            ? ''
            : ruling.reason;
      const amount = fmtMoney(envelope.intent.amount);
      this.log(
        `Blocked ${requestId} at ${stoppedAt}: ${amount} to ${envelope.intent.receiver} — ${why}. PayPal was not called`,
        ruling.verdict,
        ruling.check,
        owner ?? null,
      );
      this.bolt(`Blocked ${amount} to ${envelope.intent.receiver} at ${stoppedAt} — ${why}. PayPal was not called.`);
      const first = stopped[0];
      if (owner && first) this.agentSays(owner, first.text);
      return;
    }

    this.logRuling(
      `Blocked ${requestId}: ${fmtMoney(envelope.intent.amount)} to ${envelope.mandate.principal}`,
      ruling,
      owner ?? null,
    );
    this.bolt(
      `Blocked ${fmtMoney(envelope.intent.amount)} to ${envelope.mandate.principal} — ` +
        `${ruling.verdict === 'ALLOW' ? '' : ruling.reason}. Nothing left the account.`,
    );

    // The checker that owns the failing lamp states what it read. Facts with a
    // source, never a view on the verdict — see rule 11 in CLAUDE.md.
    const note = ruling.checks.find((c) => c.check === ruling.check)?.note;
    if (owner && note) this.agentSays(owner, note);

    // A changed payout address is a separate question from the payment. The
    // payment stays blocked; the owner is asked, on the phone only, whether to
    // change what we hold on file. That is the one route by which an address
    // can ever move, and it is never a side effect of paying.
    //
    // Not in the deck scene. There the "address" is the one shop the buyer's
    // grant covers, and a request to pay another shop is simply outside the
    // grant: refused, with nothing for the buyer to decide at 2 a.m.
    const vendor = this.store.vendor(envelope.mandate.principal);
    if (
      !this.store.deckGrant() &&
      ruling.check === 'COUNTERPARTY' &&
      vendor &&
      vendor.receiver !== envelope.intent.receiver
    ) {
      this.openReceiverDecision(requestId, envelope, vendor.receiver);
    }
  }

  /** The request is sound but over what the crew may clear. Ask the owner. */
  private askOwner(requestId: string, envelope: Envelope, ruling: Ruling): void {
    if (ruling.verdict === 'ALLOW') return;

    const vendor = this.store.vendor(envelope.mandate.principal);
    const history = vendor
      ? `paid ${vendor.paidCount}x, most ever ${fmtMoney(vendor.maxPaid)}, usual ${fmtMoney(vendor.meanPaid)}`
      : 'no payment history';

    const id = this.store.nextDecisionId();
    const decision: Decision = {
      id,
      kind: 'payment',
      agent: 'shield',
      check: ruling.check,
      reason: ruling.reason,
      short: `${envelope.mandate.principal} ${fmtMoney(envelope.intent.amount)}`,
      text:
        `${envelope.mandate.principal} wants ${fmtMoney(envelope.intent.amount)} for ` +
        `${envelope.intent.reference}. Every signature checks out; ${ruling.reason}.`,
      requestId,
      principal: envelope.mandate.principal,
      registryId: envelope.agent.registryId,
      origin: envelope.origin,
      amount: envelope.intent.amount,
      reference: envelope.intent.reference,
      scope: envelope.intent.scope,
      history,
    };

    this.store.addDecision(decision);
    this.logRuling(`Escalated ${requestId} to the owner`, ruling, 'shield');
    this.openDecision(decision);
  }

  private openReceiverDecision(
    requestId: string,
    envelope: Envelope,
    heldReceiver: string,
  ): void {
    const id = this.store.nextDecisionId();
    const decision: Decision = {
      id,
      kind: 'receiver',
      agent: 'shield',
      check: 'COUNTERPARTY',
      reason: `the request pays ${envelope.intent.receiver}; we hold ${heldReceiver}`,
      short: `${envelope.mandate.principal} address change`,
      text:
        `${envelope.mandate.principal} asked us to pay ${envelope.intent.receiver}. ` +
        `We hold ${heldReceiver}. I blocked the payment and have not changed anything.`,
      requestId,
      principal: envelope.mandate.principal,
      heldReceiver,
      claimedReceiver: envelope.intent.receiver,
      amount: envelope.intent.amount,
    };

    this.store.addDecision(decision);
    this.log(
      `Address change on ${envelope.mandate.principal} held for the owner — phone only`,
      'ASK_OWNER',
      'COUNTERPARTY',
      'shield',
    );
    this.openDecision(decision);
  }

  /* ---------- Decisions ---------- */

  private openDecision(decision: Decision): void {
    const agent = this.store.agent(decision.agent);
    const { podium } = this.store.world();
    const takesPodium = !podium;

    this.patchAgent(decision.agent, { status: 'wait' });

    if (takesPodium) {
      this.store.setPodium(decision.id);
      const trip = travelMs(agent.at, agent.slot, 'podium', 0);
      this.busy.add(decision.agent);
      this.send(decision.agent, 'podium', 0, decision.short, decision.text);
      this.later(trip, () => {
        this.patchAgent(decision.agent, { pose: 'stand' });
        this.busy.delete(decision.agent);
      });
    }

    this.bolt(decision.text, buttonsFor(decision));
  }

  /**
   * The owner chose.
   *
   * `origin` is load-bearing: a Telegram tap and the phone sheet do not carry
   * the same authority, and `canApproveFrom` is the one place that is checked.
   * Deliberately not enforced in the route handler — there it would stop being
   * checkable in one place.
   */
  resolveDecision(
    id: string,
    choice: Choice,
    origin: ApprovalOrigin = 'phone',
  ): ResolveOutcome {
    const decision = this.store.decision(id);
    if (!decision) return failure(`no decision "${id}"`);

    // A deck ask is already inside the signed budget. Approving it on the phone
    // charges the saved wallet for this same run. Over budget never becomes a decision.
    const allowed = canApproveFrom(decision, choice, origin, this.store.policy());
    if (allowed.verdict !== 'ALLOW') {
      const reason = allowed.verdict === 'DENY' ? allowed.reason : 'not allowed from here';
      this.log(
        `Refused a ${origin} ${choice} on ${decision.id} — ${reason}`,
        'DENY',
        'ORIGIN_CAP',
      );
      this.bolt(`I can't do that from here: ${reason}.`);
      return failure(reason);
    }

    const message = ((): string => {
      switch (decision.kind) {
        case 'payment':
          return this.resolvePayment(decision, choice);
        case 'receiver':
          return this.resolveReceiver(decision, choice);
        case 'tighten':
          return this.resolveTighten(decision, choice);
        default: {
          const unreachable: never = decision;
          throw new Error(`cannot resolve ${JSON.stringify(unreachable)}`);
        }
      }
    })();

    if (choice !== 'hold') {
      this.store.markDecided(decision.id, choice);
      this.closeDecision(decision.id);
    }

    return { ok: true, error: '', resolved: choice !== 'hold', message };
  }

  /**
   * The buyer answered a threshold ask. The stored summary still says "ask"
   * until this rewrites that lamp, which is what the page and the connector read.
   */
  private noteBuyerDecision(requestId: string, choice: 'approve' | 'decline'): void {
    const summary = this.store.deckRuling(requestId);
    if (!summary) return;
    const approved = choice === 'approve';
    const terms = summary.may.terms.map((term) =>
      term.outcome === 'ask'
        ? {
            ...term,
            outcome: approved ? ('pass' as const) : ('fail' as const),
            text: approved ? 'the buyer approved this purchase' : 'the buyer declined this purchase',
          }
        : term,
    );
    this.store.recordDeckRuling(requestId, {
      who: summary.who,
      may: { state: approved ? 'yes' : 'no', terms },
      footnote: summary.footnote,
    });
  }

  private resolvePayment(
    decision: Extract<Decision, { kind: 'payment' }>,
    choice: Choice,
  ): string {
    const envelope = this.store.envelope(decision.requestId);

    switch (choice) {
      case 'approve': {
        if (!envelope) return 'that request is gone';
        this.noteBuyerDecision(decision.requestId, 'approve');
        // The owner's approval stands in for the single lamp that asked. The
        // other four already passed, and nothing re-opens them.
        const ruling: Ruling = {
          verdict: 'ALLOW',
          check: 'OWNER_APPROVED',
          checks: [
            { check: 'OWNER_APPROVED', outcome: 'pass', note: 'approved by the owner' },
          ],
        };
        this.clearPayment(decision.requestId, envelope, ruling);
        this.log(`Owner approved ${decision.requestId}`, 'ALLOW', 'OWNER_APPROVED');
        this.awardTrust('shield', TRUST.ownerApproved, 'the owner agreed with the escalation');
        return `Approved. ${fmtMoney(decision.amount)} on its way to ${decision.principal}.`;
      }

      case 'hold':
        this.log(`Owner held ${decision.requestId}`, 'ASK_OWNER', 'OWNER_HELD');
        this.bolt(`Holding ${decision.short}. Nothing moves until you say.`);
        return 'Held. The request stays blocked and the decision stays open.';

      case 'decline':
        this.noteBuyerDecision(decision.requestId, 'decline');
        this.store.setRequestStatus(decision.requestId, 'blocked', {
          verdict: 'DENY',
          lamp: 'OWNER_DECLINED',
        });
        this.log(`Owner declined ${decision.requestId}`, 'DENY', 'OWNER_DECLINED');
        this.bolt(`Declined ${decision.short}. Nothing left the account.`);
        return 'Declined. Nothing left the account.';

      default: {
        const unreachable: never = choice;
        throw new Error(`unhandled choice ${String(unreachable)}`);
      }
    }
  }

  private resolveReceiver(
    decision: Extract<Decision, { kind: 'receiver' }>,
    choice: Choice,
  ): string {
    switch (choice) {
      case 'approve': {
        // The only route by which a payout address ever changes, and it is
        // phone-only: `canApproveFrom` refuses this from Telegram.
        this.store.setVendorReceiver(decision.principal, decision.claimedReceiver);
        this.log(
          `Owner changed ${decision.principal}'s address on file to ${decision.claimedReceiver}`,
          'ALLOW',
          'OWNER_OVERRULED',
        );
        this.bolt(
          `Updated ${decision.principal} to ${decision.claimedReceiver}. ` +
            `The blocked request was not paid — they will need to send it again.`,
        );
        this.awardTrust('shield', TRUST.ownerDeclined, 'the owner accepted the new address');
        return `Address updated. The blocked payment was not released.`;
      }

      case 'hold':
        this.log(`Owner is checking ${decision.principal}'s address`, 'ASK_OWNER', 'OWNER_HELD');
        this.bolt(`Holding. ${decision.principal} stays at ${decision.heldReceiver}.`);
        return 'Held. Nothing changed.';

      case 'decline':
        this.log(
          `Owner kept ${decision.principal} at ${decision.heldReceiver}`,
          'ALLOW',
          'OWNER_APPROVED',
        );
        this.bolt(`Keeping ${decision.principal} at ${decision.heldReceiver}.`);
        this.awardTrust('shield', TRUST.ownerApproved, 'the owner kept the held address');
        return 'Kept the address we hold.';

      default: {
        const unreachable: never = choice;
        throw new Error(`unhandled choice ${String(unreachable)}`);
      }
    }
  }

  private resolveTighten(
    decision: Extract<Decision, { kind: 'tighten' }>,
    choice: Choice,
  ): string {
    switch (choice) {
      case 'approve': {
        const { day } = this.store.world();
        this.store.adoptRule(decision.lamp, decision.change, decision.attackId, day);
        this.log(
          `Owner adopted a tightening on ${LAMP_LABEL[decision.lamp]}: ${decision.change}`,
          'ALLOW',
          'RULE_ADOPTED',
        );
        this.bolt(`Adopted: ${decision.change}. It applies from the next request.`);
        return `Adopted. ${decision.change}`;
      }

      case 'hold':
        return 'Held. The tightening is still waiting on you.';

      case 'decline':
        this.log(`Owner declined a tightening on ${decision.lamp}`, 'DENY', 'OWNER_DECLINED');
        return 'Declined. The lamp is unchanged.';

      default: {
        const unreachable: never = choice;
        throw new Error(`unhandled choice ${String(unreachable)}`);
      }
    }
  }

  private closeDecision(id: DecisionId): void {
    const decision = this.store.decision(id);
    if (decision) this.patchAgent(decision.agent, { status: 'work' });

    this.store.removeDecision(id);

    const { podium } = this.store.world();
    if (podium === id) this.store.setPodium(null);

    if (decision) this.goHome(decision.agent);

    // Whoever is next walks up on their own.
    const next = this.store.decisions()[0];
    if (!next) return;
    if (this.store.world().podium) return;

    this.store.setPodium(next.id);
    const waiting = this.store.agent(next.agent);
    if (waiting.at !== 'podium') {
      const trip = travelMs(waiting.at, waiting.slot, 'podium', 0);
      this.busy.add(next.agent);
      this.send(next.agent, 'podium', 0, next.short, next.text);
      this.later(trip, () => {
        this.patchAgent(next.agent, { pose: 'stand' });
        this.busy.delete(next.agent);
      });
    }
  }

  /* ---------- The duel ---------- */

  /** Fold a ruling into the attack card that provoked it. */
  private recordAttackProgress(requestId: string, ruling: Ruling): void {
    const request = this.store.request(requestId);
    if (!request?.attackId) return;

    const attack = this.store.attack(request.attackId);
    if (!attack) return;

    // How far it got: lamps that passed before the one that stopped it.
    const stopped = ruling.checks.findIndex((c) => c.outcome === 'fail' || c.outcome === 'ask');
    const cleared = stopped === -1 ? LAMPS.length : stopped;

    const outcome: Attack['outcome'] = ruling.verdict === 'ALLOW' ? 'breach' : 'blocked';

    this.store.addAttack({
      ...attack,
      requestId,
      lampsCleared: cleared,
      blockedBy: ruling.verdict === 'ALLOW' ? null : ruling.check,
      outcome,
    });

    if (outcome === 'blocked') return;

    // A breach. Tally drafts a tightening, and the owner has to adopt it.
    this.log(
      `BREACH: ${request.attackId} cleared all five lamps as ${requestId}`,
      'DENY',
      'BREACH',
      'raven',
    );
    this.awardTrust(INTAKE, TRUST.breach, 'an attack cleared the gate');
    this.draftTightening(attack);
  }

  /**
   * After a breach, draft a narrowing of the lamp that should have caught it.
   *
   * The change is always a parameter or a toggle on one of the five existing
   * lamps — never new logic. The lamp list is code, shipped and reviewed; a
   * model can turn a dial on it and nothing more.
   */
  private draftTightening(attack: Attack): void {
    const proposal = TIGHTENINGS[attack.kind];
    const id = this.store.nextDecisionId();

    const decision: Decision = {
      id,
      kind: 'tighten',
      agent: 'tally',
      check: 'BREACH',
      reason: `${attack.id} got through`,
      short: `Narrow ${LAMP_LABEL[proposal.lamp]}`,
      text:
        `${attack.id} cleared every lamp. I have drafted one change to ` +
        `${LAMP_LABEL[proposal.lamp]}: ${proposal.change}. It does nothing until you adopt it.`,
      lamp: proposal.lamp,
      change: proposal.change,
      attackId: attack.id,
    };

    this.store.addDecision(decision);
    this.openDecision(decision);
  }

  /**
   * Fire one attack now, from the booth.
   *
   * The demo button. A judge should never have to wait for nightfall to see a
   * lamp go red, and the path is identical to the nightly raid's — same
   * builder, same gate, same lane card.
   *
   * With no kind given it walks `ATTACK_KINDS` by the attack counter, so
   * pressing the button repeatedly lights a different lamp each time rather
   * than the same one twice.
   */
  fireAttack(kind?: AttackKind): void {
    const world = this.store.world();
    const next = kind ?? ATTACK_KINDS[world.attack_seq % ATTACK_KINDS.length];
    if (!next) return;
    this.raid([next], world.day);
  }

  /** Raven's nightly raid. Runs on the day boundary, from the booth. */
  private nightRaid(day: number): void {
    this.raid(raidFor(day), day);
  }

  /** Walk Raven to the pile, drop the night's work, and send it back. */
  private raid(kinds: readonly AttackKind[], day: number): void {
    if (kinds.length === 0) return;
    if (this.busy.has('raven')) return;

    const raven = this.store.agent('raven');
    const trip = travelMs(raven.at, raven.slot, 'inbox', 0);
    this.busy.add('raven');

    this.send('raven', 'inbox', 0, 'delivery.', `Dropping ${kinds.length} on the pile.`);

    this.later(trip, () => {
      this.patchAgent('raven', { pose: 'stand', say: null });
      for (const kind of kinds) this.launch(kind, day);
      this.later(WORK_MS, () => this.goHome('raven'));
    });
  }

  /**
   * Send one honest request on demand. The control, next to the attack button:
   * the clean path has to be as easy to show as the blocked one.
   */
  sendDemoRequest(principal: string, amountCents: number): boolean {
    // The deck pays only the shop's fixed quotes, through the Deck Agent's own
    // purchase path. A request with a made-up amount and reference has no
    // business there, signed by the agent's key or not — and even if one got
    // in, the gate's quote check (lamp 5) would refuse it.
    if (this.store.deckGrant()) return false;

    const vendor = this.store.vendor(principal);
    if (!vendor) return false;

    const { day } = this.store.world();
    this.sendCleanRequest(
      principal,
      cents(amountCents),
      `${refPrefix(principal)}-${day}${String(vendor.paidCount).padStart(2, '0')}`,
    );
    return true;
  }

  /** Build one attack, log the attempt, and put it on the pile. */
  private launch(kind: AttackKind, day: number): void {
    const usedNonce = this.store.db
      .query<{ nonce: string }, []>('SELECT nonce FROM nonces ORDER BY seen_at DESC LIMIT 1')
      .get();
    const paid = this.store.db
      .query<{ reference: string }, []>(
        "SELECT reference FROM requests WHERE status = 'paid' ORDER BY sort DESC LIMIT 1",
      )
      .get();

    const requestId = this.store.nextRequestId();
    const attackId = this.store.nextAttackId();

    const attempt = buildAttack({
      kind,
      requestId,
      day,
      nowMs: Date.now(),
      keyring: this.keyring,
      receiverOf: (principal) => this.store.vendor(principal)?.receiver ?? null,
      usedNonce: usedNonce?.nonce ?? null,
      paidReference: paid?.reference ?? null,
    });

    const world = this.store.world();
    this.store.patchWorld({
      attempts_week: world.attempts_week + 1,
    });

    this.store.addAttack({
      id: attackId,
      day,
      kind,
      principal: attempt.principal,
      amount: attempt.amount,
      requestId,
      lampsCleared: 0,
      blockedBy: null,
      outcome: 'pending',
    });

    this.receiveEnvelope(attempt.envelope, {
      attackId,
      label: attempt.label,
      suspicious: attempt.suspicious,
    });

    this.log(`${attackId} arrived: ${attempt.label}`, 'ASK_OWNER', 'ATTACK', 'raven');
  }

  /** Put one honest request on the pile. Used by the seed and the demo. */
  sendCleanRequest(principal: string, amount: Cents, reference: string): void {
    const vendor = this.store.vendor(principal);
    if (!vendor) return;

    const requestId = this.store.nextRequestId();
    const attempt = buildClean({
      requestId,
      principal,
      amount,
      reference,
      nowMs: Date.now(),
      keyring: this.keyring,
      receiver: vendor.receiver,
    });

    this.receiveEnvelope(attempt.envelope, { label: attempt.label });
  }

  /* ---------- The deck scene: the wallet ---------- */

  /**
   * Find a wallet PayPal will vouch for, without asking the buyer anything.
   *
   * Runs when the server starts, after every demo reset, and on "Check again".
   * Tries, in order: a configured pre-authorized wallet, one this app saved
   * through PayPal's consent page, and one the tested Sandbox run saved for
   * the same merchant app. Each is confirmed with PayPal before a charge may
   * use it, and the first PayPal confirms is connected. While the checks run,
   * nothing can be charged.
   */
  async refreshWallet(): Promise<DeckOutcome> {
    if (!this.store.deckGrant()) return { ok: false, message: 'There is no deck in this scene.' };
    const generation = ++this.walletCheck;
    const superseded: DeckOutcome = { ok: false, message: 'A newer wallet check is running.' };

    // A finished attempt — cancelled or expired — is older news than this
    // check. Left in place it would hide what the check finds. One still
    // waiting stays: the buyer may be on PayPal's page right now.
    const setup = this.store.walletSetup();
    if (setup && setup.status !== 'waiting') this.store.clearWalletSetup();

    if (!this.paypal) {
      // Nothing to ask. A simulated connection carries over to the next run; a
      // live one cannot be used here and is left for a server with credentials.
      const row = this.store.paypalWallet();
      const kept = row?.mode === 'simulated' && row.status === 'connected';
      return {
        ok: true,
        message: kept ? 'Simulated wallet still connected.' : 'No PayPal credentials on this server.',
      };
    }

    const candidates = this.walletCandidatesNow();
    if (candidates.length === 0) {
      this.store.patchPaypalWallet({
        mode: 'live',
        status: 'none',
        source: null,
        active_vault_id: null,
        note: null,
        recheck: 0,
      });
      return { ok: true, message: 'No saved wallet yet: connect one with PayPal.' };
    }

    this.store.patchPaypalWallet({
      mode: 'live',
      status: 'checking',
      source: null,
      active_vault_id: null,
      note: null,
      recheck: 1,
    });

    let unreachable = false;
    const refused: WalletSource[] = [];
    for (const candidate of candidates) {
      try {
        await this.paypal.paymentToken(candidate.vaultId);
      } catch (err) {
        if (generation !== this.walletCheck) return superseded;
        if (err instanceof PayPalError && err.status !== null && err.status < 500) {
          refused.push(candidate.source);
          // A token this app saved and PayPal no longer has is gone for good.
          if (candidate.source === 'consent') this.store.patchPaypalWallet({ saved_vault_id: null });
        } else {
          unreachable = true;
        }
        continue;
      }

      if (generation !== this.walletCheck) return superseded;
      this.store.patchPaypalWallet({
        mode: 'live',
        status: 'connected',
        source: candidate.source,
        active_vault_id: candidate.vaultId,
        note: null,
        recheck: 1,
        verified_at: Date.now(),
      });
      this.log(
        `PayPal confirmed the ${WALLET_SOURCE_LABEL[candidate.source]} for this merchant app ` +
          '(PayPal Sandbox). No buyer sign-in needed',
        'ALLOW',
        'WALLET',
      );
      this.activateIfReady();
      return { ok: true, message: 'Sandbox wallet connected.' };
    }

    if (generation !== this.walletCheck) return superseded;
    const note = unreachable
      ? 'Couldn’t reach PayPal to check the saved wallet. Check again, or connect one.'
      : `${refused.map((source) => REFUSED_NOTE[source]).join(' ')} Connect one with PayPal.`;
    this.store.patchPaypalWallet({
      mode: 'live',
      status: 'none',
      source: null,
      active_vault_id: null,
      note,
      recheck: unreachable ? 1 : 0,
    });
    this.log(`No PayPal wallet connected: ${note}`, 'DENY', 'WALLET');
    return { ok: false, message: note };
  }

  /** The wallets to ask PayPal about, in order, each once. */
  private walletCandidatesNow(): { readonly vaultId: string; readonly source: WalletSource }[] {
    const row = this.store.paypalWallet();
    const saved = row !== null && row.app_hash === this.appHash ? row.saved_vault_id : null;
    const ordered: { readonly vaultId: string; readonly source: WalletSource }[] = [
      ...this.candidates.filter((c) => c.source === 'configured'),
      ...(saved ? [{ vaultId: saved, source: 'consent' as const }] : []),
      ...this.candidates.filter((c) => c.source === 'tested_run'),
    ];

    const seen = new Set<string>();
    return ordered.filter((candidate) => {
      if (seen.has(candidate.vaultId)) return false;
      seen.add(candidate.vaultId);
      return true;
    });
  }

  /**
   * "Connect PayPal Sandbox": send the buyer to PayPal's consent page.
   *
   * Reopens the current attempt while PayPal still has it, saves the wallet if
   * the buyer already agreed, and marks the attempt expired if PayPal has
   * dropped it. Otherwise it starts a fresh attempt — a new attempt id, a new
   * PayPal-Request-Id, a new setup token. The approval link goes back to the
   * buyer's browser only: it is not logged and never appears in a snapshot.
   */
  async connectWallet(): Promise<DeckOutcome & { readonly approvalUrl?: string }> {
    const grant = this.store.deckGrant();
    if (!grant) return { ok: false, message: 'There is no deck in this scene.' };
    if (!this.paypal) {
      return { ok: false, message: 'Configure the PayPal Sandbox app credentials before connecting a wallet.' };
    }

    const wallet = this.store.walletView();
    if (wallet?.state === 'connected') return { ok: true, message: 'The Sandbox wallet is already connected.' };
    if (wallet?.state === 'checking') {
      return { ok: false, message: 'Still checking the saved wallet with PayPal. Try again in a moment.' };
    }

    const setup = this.store.walletSetup();
    if (setup?.status === 'waiting' && setup.setup_id && setup.approval_url) {
      const status = await this.paypal
        .setupStatus(setup.setup_id)
        .catch((err: unknown) => (err instanceof PayPalError && err.status === 404 ? 'GONE' : 'UNKNOWN'));
      if (this.store.walletSetup()?.attempt_id !== setup.attempt_id) {
        return { ok: false, message: 'The setup changed while PayPal answered. Try again.' };
      }
      if (status === 'APPROVED' || status === 'VAULTED') return this.finishSetup(setup.attempt_id);
      if (status === 'GONE') {
        this.expireSetup();
        return { ok: false, message: 'That PayPal setup expired. Start a fresh one.' };
      }
      return {
        ok: true,
        message: 'Sign in as the Sandbox buyer and agree in the PayPal window.',
        approvalUrl: setup.approval_url,
      };
    }

    const attemptId = randomUUID();
    const setupRequestId = randomUUID();
    try {
      const token = await this.paypal.createSetupToken(setupRequestId, attemptId);
      if (this.store.deckGrant()?.run_id !== grant.run_id) {
        return { ok: false, message: 'The demo was reset while PayPal answered. Start again.' };
      }
      // A note from an earlier check is older news than this attempt.
      if (this.store.paypalWallet()?.note) this.store.patchPaypalWallet({ note: null });
      this.store.putWalletSetup({
        attempt_id: attemptId,
        status: 'waiting',
        setup_request_id: setupRequestId,
        setup_id: token.id,
        approval_url: token.approvalUrl,
        vault_request_id: null,
        note: null,
        created_at: Date.now(),
      });
      this.log(
        'PayPal is waiting for the buyer to sign in and agree to save the wallet (PayPal Sandbox)',
        'ASK_OWNER',
        'WALLET',
      );
      return {
        ok: true,
        message: 'Sign in as the Sandbox buyer and agree in the PayPal window.',
        approvalUrl: token.approvalUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'PayPal did not start the wallet setup';
      this.log(`PayPal wallet setup failed: ${message}`, 'DENY', 'WALLET');
      return { ok: false, message };
    }
  }

  /**
   * "I’ve agreed in PayPal" and "Check again".
   *
   * With an attempt waiting, ask PayPal whether the buyer agreed — for when
   * PayPal's redirect never reached this server. Otherwise ask PayPal about the
   * saved and configured wallets again.
   */
  async checkWallet(): Promise<DeckOutcome> {
    if (!this.store.deckGrant()) return { ok: false, message: 'There is no deck in this scene.' };
    const setup = this.store.walletSetup();
    if (setup?.status === 'waiting') return this.finishSetup(setup.attempt_id);
    return this.refreshWallet();
  }

  /**
   * PayPal sent the buyer back.
   *
   * The return URL ends in the attempt id, and PayPal adds the id of the setup
   * token it approved. Both must belong to the current attempt: a return from
   * an earlier attempt, or one carrying another token, changes nothing. Even a
   * matching return proves nothing on its own — `finishSetup` asks PayPal.
   */
  async walletReturned(attemptId: string, approvalTokenId: string | null): Promise<DeckOutcome> {
    if (!this.store.deckGrant()) return { ok: false, message: 'There is no deck in this scene.' };

    const setup = this.store.walletSetup();
    if (!setup || !sameId(setup.attempt_id, attemptId)) {
      this.log(
        'Refused a PayPal return that does not belong to the current setup attempt. Nothing changed',
        'DENY',
        'WALLET',
      );
      return {
        ok: false,
        message: 'This PayPal return is not from the current setup, so nothing changed. Start again from the deck.',
      };
    }
    if (approvalTokenId !== null && approvalTokenId !== setup.setup_id) {
      this.log(
        'Refused a PayPal return carrying a different setup token than this attempt’s. Nothing changed',
        'DENY',
        'WALLET',
      );
      return { ok: false, message: 'PayPal returned a different setup than this attempt’s, so nothing changed.' };
    }
    return this.finishSetup(setup.attempt_id);
  }

  /**
   * Ask PayPal whether the buyer agreed; if so, save the wallet and confirm it.
   *
   * Safe to call twice: the vault request id is written down before the
   * exchange, and PayPal answers a repeated PayPal-Request-Id with the same
   * wallet token.
   */
  private async finishSetup(attemptId: string): Promise<DeckOutcome> {
    const paypal = this.paypal;
    const setup = this.store.walletSetup();
    if (!paypal || !setup || setup.attempt_id !== attemptId) {
      return { ok: false, message: 'That is not the current setup. Nothing changed.' };
    }
    if (setup.status === 'done') return { ok: true, message: 'The Sandbox wallet is already connected.' };
    if (setup.status !== 'waiting' || !setup.setup_id) {
      return {
        ok: false,
        message:
          setup.status === 'cancelled'
            ? 'That setup was cancelled. Connect again to start a fresh one.'
            : 'That setup expired. Start a fresh one.',
      };
    }

    const setupId = setup.setup_id;
    const stillCurrent = (): boolean => this.store.walletSetup()?.attempt_id === attemptId;
    const changed: DeckOutcome = { ok: false, message: 'The setup changed while PayPal answered. Nothing changed.' };

    try {
      const status = await paypal.setupStatus(setupId);
      if (!stillCurrent()) return changed;
      if (status === 'PAYER_ACTION_REQUIRED' || status === 'CREATED') {
        return { ok: false, message: 'PayPal is still waiting for the buyer to sign in and agree.' };
      }
      if (status !== 'APPROVED' && !(status === 'VAULTED' && setup.vault_request_id)) {
        return { ok: false, message: `PayPal says the setup is ${status}.` };
      }

      const vaultRequestId = this.store.walletSetup()?.vault_request_id ?? randomUUID();
      this.store.patchWalletSetup({ vault_request_id: vaultRequestId });
      const vaultId = await paypal.savePaymentToken(setupId, vaultRequestId);
      await paypal.paymentToken(vaultId);
      if (!stillCurrent()) return changed;

      // A check still running must not overwrite this answer.
      this.walletCheck += 1;
      this.store.tx(() => {
        this.store.patchWalletSetup({ status: 'done', approval_url: null, note: null });
        this.store.patchPaypalWallet({
          app_hash: this.appHash,
          saved_vault_id: vaultId,
          mode: 'live',
          status: 'connected',
          source: 'consent',
          active_vault_id: vaultId,
          note: null,
          recheck: 1,
          verified_at: Date.now(),
        });
      });
      this.log(
        'PayPal saved the buyer’s wallet for this merchant app (PayPal Sandbox). That is the only buyer sign-in',
        'ALLOW',
        'WALLET',
      );
      this.activateIfReady();
      return { ok: true, message: 'Sandbox wallet connected.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'PayPal did not save the wallet';
      if (err instanceof PayPalError && err.status === 404 && stillCurrent()) {
        this.expireSetup();
        return { ok: false, message: 'PayPal no longer has that setup — it expired. Start a fresh one.' };
      }
      this.log(`PayPal did not save the wallet: ${message}`, 'DENY', 'WALLET');
      return { ok: false, message };
    }
  }

  /** PayPal no longer has the current setup. Nothing revives it: the next try is a fresh attempt. */
  private expireSetup(): void {
    this.store.patchWalletSetup({ status: 'expired', approval_url: null, note: 'PayPal no longer has that setup.' });
    this.log('PayPal no longer has the wallet setup — it expired. The next try starts a fresh one', 'DENY', 'WALLET');
  }

  /**
   * The buyer backed out — on PayPal's page (`attemptId` comes from the cancel
   * URL), or here with "Cancel" (`attemptId` is null). Nothing is saved, and
   * the next try is a fresh attempt.
   */
  cancelWalletSetup(attemptId: string | null): DeckOutcome {
    if (!this.store.deckGrant()) return { ok: false, message: 'There is no deck in this scene.' };

    const setup = this.store.walletSetup();
    if (!setup || setup.status !== 'waiting') return { ok: true, message: 'No PayPal setup is waiting.' };
    if (attemptId !== null && !sameId(setup.attempt_id, attemptId)) {
      return { ok: false, message: 'That cancel is not for the current setup. Nothing changed.' };
    }

    const where = attemptId === null ? 'here' : 'on PayPal’s page';
    this.store.patchWalletSetup({ status: 'cancelled', approval_url: null, note: `Cancelled ${where}.` });
    this.log(`The wallet setup was cancelled ${where}. Nothing was saved`, 'DENY', 'WALLET');
    return { ok: true, message: 'Cancelled. Nothing was saved.' };
  }

  /**
   * No PayPal credentials: record the consent locally instead.
   *
   * Refused when PayPal is configured, so a real run can never be mislabelled
   * as simulated, or the other way round.
   */
  simulateWallet(): DeckOutcome {
    if (!this.store.deckGrant()) return { ok: false, message: 'There is no deck in this scene.' };
    if (this.paypal) {
      return {
        ok: false,
        message: 'PayPal Sandbox is configured here, so the wallet is real. Connect PayPal Sandbox.',
      };
    }
    if (this.store.walletView()?.state === 'connected') {
      return { ok: true, message: 'The simulated wallet is already connected.' };
    }

    this.store.patchPaypalWallet({
      mode: 'simulated',
      status: 'connected',
      source: 'simulated',
      active_vault_id: null,
      note: null,
      recheck: 0,
      verified_at: Date.now(),
    });
    this.log(
      'No PayPal credentials configured: wallet consent simulated (SIM). Charges will be simulated too',
      'ALLOW',
      'WALLET',
    );
    this.activateIfReady();
    return { ok: true, message: 'Consent simulated. Charges will be labeled SIM.' };
  }

  /* ---------- The deck scene: the budget, the agent ---------- */

  /**
   * The cap the buyer will be asked to approve. Refused once this run is
   * already approved for a different amount: the signed policy is the limit,
   * and changing it is a new run.
   */
  offerBudget(amount: Cents): DeckOutcome {
    const grant = this.store.deckGrant();
    if (!grant) return { ok: false, message: 'There is no grant in this scene.' };
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > usd(MAX_BUDGET_USD)) {
      return {
        ok: false,
        message: `The budget must be between USD 0.01 and USD ${MAX_BUDGET_USD.toLocaleString('en-US')}.`,
      };
    }
    if (grant.approved === 1) {
      if (grant.budget === amount) return { ok: true, message: `This run’s budget is already ${fmtMoney(amount)}.` };
      return {
        ok: false,
        message: `The buyer already approved ${fmtMoney(cents(grant.budget))}. Reset the demo to set a different budget.`,
      };
    }
    if (grant.budget === amount) return { ok: true, message: `The offered budget is already ${fmtMoney(amount)}.` };
    this.store.patchDeckGrant({ budget: amount });
    this.log(
      `Offered budget is now ${fmtMoney(amount)} at ${grant.merchant}, waiting for the buyer (local prototype)`,
      'ASK_OWNER',
      'GRANT',
    );
    return { ok: true, message: `The page will ask the buyer to allow up to ${fmtMoney(amount)}.` };
  }

  /**
   * Step two: "Allow Deck Agent to spend up to $X".
   *
   * Local prototype behaviour, standing in for a proposed PayPal screen. Only
   * once a wallet is connected — a budget is worth nothing without a way to
   * pay — and asked again on every run. `amount`, when passed, is the figure
   * on the button the buyer just pressed.
   */
  approveGrant(amount?: Cents): DeckOutcome {
    if (amount !== undefined) {
      const offered = this.offerBudget(amount);
      if (!offered.ok) return offered;
    }
    const grant = this.store.deckGrant();
    if (!grant) return { ok: false, message: 'There is no grant in this scene.' };
    if (this.store.walletView()?.state !== 'connected') {
      return { ok: false, message: 'Connect the PayPal Sandbox wallet first.' };
    }
    if (grant.approved === 1) return { ok: true, message: 'This run’s budget is already approved.' };

    const budget = fmtMoney(cents(grant.budget));
    this.store.patchDeckGrant({ approved: 1 });
    this.log(
      `Buyer allowed ${DECK.agentName} to spend up to ${budget} at ${grant.merchant}, ${DECK.until} ` +
        '(local prototype)',
      'ALLOW',
      'GRANT',
    );
    this.activateIfReady();
    return { ok: true, message: `${DECK.agentName} may now spend up to ${budget}.` };
  }

  /**
   * The share of the budget above which a purchase asks the buyer.
   *
   * Saved on the grant with the budget, and refused once this run is approved
   * for a different percent: changing it is a new run.
   */
  setAskThreshold(pct: number): DeckOutcome {
    const grant = this.store.deckGrant();
    if (!grant) return { ok: false, message: 'There is no grant in this scene.' };
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      return { ok: false, message: 'Ask threshold must be a whole percent from 0 to 100.' };
    }
    const current = grant.ask_pct ?? 50;
    if (grant.approved === 1 && current !== pct) {
      return {
        ok: false,
        message: `The buyer already approved this run at a ${current}% ask threshold. Reset the demo to change it.`,
      };
    }
    if (grant.ask_pct === pct) return { ok: true, message: `Ask threshold is already ${pct}% of the budget.` };
    this.store.patchDeckGrant({ ask_pct: pct });
    this.log(
      `Ask threshold is now ${pct}% of the budget at ${grant.merchant}, waiting for the buyer (local prototype)`,
      'ASK_OWNER',
      'GRANT',
    );
    return { ok: true, message: `Ask threshold is ${pct}% of the budget.` };
  }

  /**
   * The buyer approved or declined the purchase waiting on the verify page.
   *
   * The same run is captured or refused. Nothing here opens a new one, and
   * PayPal is called only when the choice is approve.
   */
  decideLivePurchase(runId: string, choice: 'approve' | 'decline'): DeckOutcome {
    const run = this.store.liveRun(runId);
    if (!run?.request_id) return { ok: false, message: 'That run is not waiting on the buyer.' };
    const request = this.store.request(run.request_id);
    if (!request || (request.status !== 'gated' && request.status !== 'waiting')) {
      return { ok: false, message: 'That run is not waiting on the buyer.' };
    }
    const decision = this.store
      .decisions()
      .find((item) => item.kind === 'payment' && item.requestId === run.request_id);
    if (!decision) return { ok: false, message: 'There is no approval waiting for this run.' };
    const outcome = this.resolveDecision(decision.id, choice, 'phone');
    if (!outcome.ok) return { ok: false, message: outcome.error || 'The buyer’s decision was not applied.' };
    return { ok: true, message: outcome.message };
  }

  /**
   * The agent asked the buyer to change the approved budget.
   *
   * This records one pending request and nothing else. A newer request marks
   * the earlier one declined. The grant, the policy and the signer are unchanged
   * until the buyer answers on the verify page.
   */
  requestBudgetChange(amount: Cents, reason: string): BudgetRequestOutcome {
    const grant = this.store.deckGrant();
    const view = this.store.grantView();
    if (!grant || !view) return { ok: false, message: 'There is no grant in this scene.' };
    if (view.status !== 'active') {
      return { ok: false, message: 'The buyer has not approved a budget yet. They do that on the verify page.' };
    }
    const text = reason.trim();
    if (text.length < 1 || text.length > 400) {
      return { ok: false, message: 'Give a reason for the budget change, in 400 characters or fewer.' };
    }
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > usd(MAX_BUDGET_USD)) {
      return {
        ok: false,
        message: `The budget must be between USD 0.01 and USD ${MAX_BUDGET_USD.toLocaleString('en-US')}.`,
      };
    }
    if (amount === view.budget) {
      return { ok: false, message: `The budget is already ${fmtMoney(view.budget)}.` };
    }

    const now = Date.now();
    this.store.declinePendingBudgetRequests(grant.run_id, view.budget, REPLACED_BUDGET_REQUEST, now);
    const requestId = randomUUID();
    this.store.addBudgetRequest({
      request_id: requestId,
      deck_run_id: grant.run_id,
      amount,
      reason: text,
      status: 'pending',
      note: null,
      resulting: null,
      created_at: now,
      decided_at: null,
    });
    this.log(
      `Agent asked to change the budget from ${fmtMoney(view.budget)} to ${fmtMoney(amount)}: ${text}. ` +
        'The grant is unchanged until the buyer decides (local prototype)',
      'ASK_OWNER',
      'GRANT',
    );
    return { ok: true, message: 'Waiting for the buyer.', request: this.budgetFacts(requestId)! };
  }

  /** Where a budget-change request stands. Read-only. */
  budgetRequestStatus(requestId: string): BudgetRequestOutcome {
    const facts = this.budgetFacts(requestId);
    if (!facts) return { ok: false, message: `There is no budget request "${requestId}".` };
    return { ok: true, message: facts.status, request: facts };
  }

  /**
   * The buyer approved or declined a budget change.
   *
   * Only the verify page calls this. Approving writes the new cap into the
   * grant and re-signs the policy, which is what the next buyer-grant signature
   * and Layer 3 both read. Spent purchases and the ask threshold stay.
   */
  decideBudgetRequest(requestId: string, choice: 'approve' | 'decline'): BudgetRequestOutcome {
    const grant = this.store.deckGrant();
    const view = this.store.grantView();
    if (!grant || !view) return { ok: false, message: 'There is no grant in this scene.' };
    const row = this.store.budgetRequest(requestId);
    if (!row || row.deck_run_id !== grant.run_id) {
      return { ok: false, message: `There is no budget request "${requestId}".` };
    }
    if (row.status !== 'pending') {
      const facts = this.budgetFacts(requestId);
      return facts
        ? { ok: false, message: `That request is already ${row.status}.`, request: facts }
        : { ok: false, message: `That request is already ${row.status}.` };
    }

    const now = Date.now();
    if (choice === 'decline') {
      this.store.decideBudgetRequest(requestId, 'declined', view.budget, BUYER_DECLINED_BUDGET, now);
      this.log(
        `Buyer declined the budget change to ${fmtMoney(cents(row.amount))}. The budget stays ${fmtMoney(view.budget)}`,
        'DENY',
        'GRANT',
      );
      return { ok: true, message: `Declined. The budget stays ${fmtMoney(view.budget)}.`, request: this.budgetFacts(requestId)! };
    }

    const amount = cents(row.amount);
    const threshold = grant.ask_pct;
    this.store.patchDeckGrant({ budget: amount });
    this.writeBudgetPolicy(amount);
    this.store.decideBudgetRequest(requestId, 'approved', amount, BUYER_APPROVED_BUDGET, now);
    this.log(
      `Buyer changed the budget from ${fmtMoney(view.budget)} to ${fmtMoney(amount)}. ` +
        `Spent purchases stay, and the ask threshold stays ${threshold ?? 50}%. ` +
        'The signed policy and the buyer grant now use the new cap (local prototype)',
      'ALLOW',
      'GRANT',
    );
    return { ok: true, message: `The budget is now ${fmtMoney(amount)}.`, request: this.budgetFacts(requestId)! };
  }

  private budgetFacts(requestId: string): BudgetRequestFacts | null {
    const row = this.store.budgetRequest(requestId);
    const view = this.store.grantView();
    if (!row || !view || !isBudgetRequestStatus(row.status)) return null;
    const requested = cents(row.amount);
    const resulting = row.resulting === null ? view.budget : cents(row.resulting);
    return {
      requestId: row.request_id,
      status: row.status,
      current: view.budget,
      requested,
      resulting,
      reason: row.reason,
      note: row.note,
    };
  }

  /**
   * Connected and approved: write this run's budget into the signed policy row.
   *
   * From here the approved budget is the owner's policy, the only place a limit
   * lives (rule 2). The gate's daily-total check on lamp 5 is what holds the
   * agent to it — no new lamp, and no number kept anywhere else.
   */
  private activateIfReady(): void {
    const grant = this.store.deckGrant();
    if (!grant || grant.approved !== 1) return;
    if (this.store.walletView()?.state !== 'connected') return;

    const { day } = this.store.world();
    if (this.store.policy().expiresDay >= day) return; // already active

    const budget = cents(grant.budget);
    this.writeBudgetPolicy(budget);
    this.log(
      `Grant active: ${DECK.agentName} may spend ${fmtMoney(budget)} at ${grant.merchant}, ${DECK.until}. ` +
        'The budget is now the signed policy the gate reads (local prototype)',
      'ALLOW',
      'GRANT',
    );
  }

  /** Re-sign the owner policy at this cap. Layer 3 and the next buyer grant both read it. */
  private writeBudgetPolicy(budget: Cents): void {
    const { day } = this.store.world();
    this.store.setPolicy(
      signPolicy(
        {
          expiresDay: day,
          dailyTotal: budget,
          telegramCap: usd(0),
          perPayment: { 1: budget, 2: budget, 3: budget, 4: budget, 5: budget },
          // Ordered, as rules.test.ts requires: only a signed agent may spend.
          originCeiling: { agent: budget, portal: usd(0), email: usd(0) },
        },
        this.keyring.owner.secret,
      ),
    );
  }

  /**
   * The Deck Agent asks to license the next image.
   *
   * Only once both steps are done. One purchase at a time, as in the tested
   * script: nothing new goes to the gate while a charge is still with PayPal.
   * The request is a real signed envelope under the buyer's real grant, for
   * the shop's quoted price; the gate decides what happens. A revoked agent
   * may still try, so its refusal at lamp 1 can be shown.
   */
  buyNextImage(): DeckOutcome {
    const grant = this.store.grantView();
    if (!grant) return { ok: false, message: 'There is no deck in this scene.' };
    if (grant.status === 'needs_wallet') return { ok: false, message: 'Connect the PayPal Sandbox wallet first.' };
    if (grant.status === 'needs_approval') {
      return { ok: false, message: `Allow ${DECK.agentName} its budget first.` };
    }

    if (this.signerHoldsAgentKey()) return { ok: false, message: SIGNER_HOLDS_KEY };

    const slots = this.store.deckView();
    if (this.store.chargesInFlight() > 0 || slots.some((s) => s.state === 'charging')) {
      return { ok: false, message: 'One purchase at a time: the last one is still at the gate or with PayPal.' };
    }

    const next = slots.find((s) => s.state === 'locked' || s.state === 'blocked');
    if (!next) return { ok: false, message: 'Every image is bought or waiting for you.' };

    // The first image is the paying test request's: buying it from here is
    // that same request, so the verification page and the studio never tell
    // two stories about one purchase.
    if (next.id === BOARD_SLOT.id && !this.store.deckSends().has('agent')) return this.sendFromBoard('agent');

    const buyer = this.store.vendor(DECK.principal);
    if (!buyer) return { ok: false, message: 'The buyer record is missing. Reset the demo.' };

    const requestId = this.store.nextRequestId();
    const attempt = buildClean({
      requestId,
      principal: DECK.principal,
      amount: next.price,
      reference: next.reference,
      nowMs: Date.now(),
      keyring: this.keyring,
      receiver: buyer.receiver,
    });

    this.receiveEnvelope(attempt.envelope, {
      label: `${DECK.agentName} · ${next.title} · ${fmtMoney(next.price)}`,
    });
    this.store.linkSlot(next.id, requestId);
    return { ok: true, message: `${DECK.agentName} asked to license “${next.title}” for ${fmtMoney(next.price)}.` };
  }

  /**
   * Send one of the three test requests, and rule on it now.
   *
   * The selected catalog quote, signed by the sender named and handed to
   * the gate like any other request. There is no
   * walk to wait for, so the page shows the result as the judge clicks. The
   * ruling is the gate's, and only an ALLOW reaches PayPal — through
   * `clearPayment`, the one call site, exactly as a purchase would.
   *
   * Any order, each sender once a run, one purchase at a time.
   */
  sendFromBoard(sender: BoardSender, reference?: string): DeckOutcome {
    const grant = this.store.grantView();
    if (!grant) return { ok: false, message: 'There is no deck in this scene.' };
    if (grant.status === 'needs_wallet') return { ok: false, message: 'Connect the PayPal Sandbox wallet first.' };
    if (grant.status === 'needs_approval') {
      return { ok: false, message: `Allow ${DECK.agentName} its budget first.` };
    }
    if (this.store.world().paused) {
      return { ok: false, message: 'Resume first: while paused, the gate refuses everything.' };
    }

    if (this.store.deckSends().has(sender)) {
      return { ok: false, message: 'This sender already sent a request in this run.' };
    }

    // The impostor never had the enrolled key, so it can still try. The two
    // scripted senders that sign as the agent cannot, once the signer holds it.
    if (sender !== 'impostor' && this.signerHoldsAgentKey()) return { ok: false, message: SIGNER_HOLDS_KEY };

    const quotes = boardQuotes(sender);
    const quote = reference === undefined ? quotes[0] : quotes.find((entry) => entry.reference === reference);
    if (!quote) return { ok: false, message: 'That quote is not available from this merchant. Draw another request.' };

    const slots = this.store.deckView();
    if (this.store.chargesInFlight() > 0 || slots.some((s) => s.state === 'charging')) {
      return { ok: false, message: 'One purchase at a time: the last one is still with PayPal.' };
    }
    const image = sender === 'agent' ? slots.find((slot) => slot.reference === quote.reference) : undefined;
    if (sender === 'agent' && (!image || (image.state !== 'locked' && image.state !== 'blocked'))) {
      return { ok: false, message: `“${quote.title}” is no longer available. Draw another request.` };
    }

    const requestId = this.store.nextRequestId();
    const built = buildSend(sender, { requestId, nowMs: Date.now(), keyring: this.keyring, quote });

    this.receiveEnvelope(built.envelope, { label: built.label });
    this.store.addDeckSend(sender, requestId);
    if (image) this.store.linkSlot(image.id, requestId);
    this.processRequest(requestId);

    return { ok: true, message: this.sendResult(requestId) };
  }

  /**
   * True once the Demo Agent's enrolled key is the signer service's.
   *
   * From then on this process cannot sign as the agent, and should not pretend
   * to: a request it scripted would only fail identity. The live connector is
   * the way in.
   */
  private signerHoldsAgentKey(): boolean {
    return this.store.enrollmentView()?.active === true;
  }

  /**
   * A request signed outside this process — by the signer service, through the
   * live connector — handed to the gate and ruled on at once.
   *
   * It gets nothing a board request does not: the same preconditions, the same
   * `receiveEnvelope` and `processRequest`, and so the same single call site
   * for PayPal behind an `ALLOW`. The caller supplies everything but the id,
   * which is not part of what was signed.
   *
   * A revoked agent may still try, so its refusal at lamp 1 is on the record.
   */
  submitSigned(
    parts: Omit<Envelope, 'id'>,
    label: string,
  ): DeckOutcome & { readonly requestId: string | null } {
    const refuse = (message: string) => ({ ok: false, message, requestId: null });

    const grant = this.store.grantView();
    if (!grant) return refuse('There is no deck in this scene.');
    if (grant.status === 'needs_wallet') return refuse('Connect the PayPal Sandbox wallet first.');
    if (grant.status === 'needs_approval') return refuse(`Allow ${DECK.agentName} its budget first.`);
    if (this.store.world().paused) return refuse('Resume first: while paused, the gate refuses everything.');

    const slots = this.store.deckView();
    if (this.store.chargesInFlight() > 0 || slots.some((s) => s.state === 'charging')) {
      return refuse('One purchase at a time: the last one is still with PayPal.');
    }

    // At the grant's shop the quote is one of the deck's images, bought once a run.
    const image =
      parts.intent.receiver === grant.merchant
        ? slots.find((slot) => slot.reference === parts.intent.reference)
        : undefined;
    if (image && image.state !== 'locked' && image.state !== 'blocked') {
      return refuse(`“${image.title}” was already bought in this run.`);
    }

    const requestId = this.store.nextRequestId();
    this.receiveEnvelope({ ...parts, id: requestId }, { label });
    if (image) this.store.linkSlot(image.id, requestId);
    this.processRequest(requestId);

    return { ok: true, message: this.sendResult(requestId), requestId };
  }

  /** What a test request came to, for the toast. Read back from what was recorded. */
  private sendResult(requestId: string): string {
    const summary = this.store.deckRuling(requestId);
    const label = 'Request';
    if (!summary) return `${label} went to the gate.`;
    if (summary.who.state === 'no') return `${label}: identity failed. PayPal was not called.`;
    if (summary.may.state === 'no') {
      return `${label}: identity passed, authorization failed (${failingLabels(summary.may).join(', ')}). PayPal was not called.`;
    }
    if (summary.may.state === 'ask') return `${label}: over budget, so it waits for the buyer. PayPal was not called.`;
    if (summary.may.state === 'not_reached') return `${label} was not checked.`;
    const charge = this.store.charge(requestId);
    if (!charge) return `${label}: identity and authorization passed, but no wallet was charged.`;
    return charge.mode === 'live'
      ? `${label}: identity and authorization passed. Charging the saved PayPal Sandbox wallet.`
      : `${label}: identity and authorization passed. Charge simulated: no PayPal credentials here.`;
  }

  /**
   * The buyer pulls the agent's key. Lamp 1 refuses its next request.
   *
   * Local prototype behaviour. The PayPal wallet is deliberately left alone —
   * it stays connected, and deleting the token is a separate PayPal call this
   * demo does not make. The log says so rather than implying it.
   */
  revokeAgent(): DeckOutcome {
    const grant = this.store.deckGrant();
    if (!grant) return { ok: false, message: 'There is no grant in this scene.' };

    const entry = this.store.registryEntry(grant.registry_id);
    if (!entry) return { ok: false, message: 'The agent is not in the registry. Reset the demo.' };
    if (entry.status === 'revoked') return { ok: true, message: `${DECK.agentName} is already revoked.` };

    this.store.revokeRegistryEntry(grant.registry_id, this.store.world().day);
    this.log(
      `Buyer revoked ${DECK.agentName} (${grant.registry_id}). Its next request fails lamp 1. ` +
        'The PayPal wallet stays connected (local prototype)',
      'DENY',
      'REVOKE',
    );
    return { ok: true, message: `${DECK.agentName} revoked. Its next request will be refused.` };
  }

  /**
   * Read back every live charge PayPal has not settled, from any run.
   *
   * A charge with an order id is read back and settled — in this run, against
   * its slot and budget; from an earlier run, on its own record. One with no
   * order id cannot be read back — PayPal's Orders API only finds orders by id
   * — so it stays reserved, and the answer says which invoice to look for in
   * the Sandbox merchant's activity, as the tested README does.
   */
  async reconcileCharges(): Promise<DeckOutcome> {
    const paypal = this.paypal;
    if (!this.store.deckGrant()) return { ok: false, message: 'There is no deck in this scene.' };
    if (!paypal) return { ok: false, message: 'PayPal Sandbox is not configured here, so there is nothing to ask it.' };

    const open = this.store
      .unsettledCharges()
      .filter((charge) => charge.mode === 'live' && !this.waitingOn.has(charge.paypal_request_id));
    if (open.length === 0) return { ok: true, message: 'Nothing is waiting on PayPal.' };

    let settled = 0;
    const blind: string[] = [];
    for (const charge of open) {
      if (!charge.order_id) {
        blind.push(`…${charge.invoice_id.slice(-8)}`);
        continue;
      }
      try {
        const outcome = await paypal.order(charge.order_id, cents(charge.amount));
        if (outcome.kind === 'unconfirmed') continue;
        this.settleCharge(charge.paypal_request_id, outcome);
        settled += 1;
      } catch {
        // Still unknown. Leave it reserved.
      }
    }

    return {
      ok: true,
      message:
        `Settled ${settled} of ${open.length}.` +
        (blind.length > 0
          ? ` ${blind.length} had no PayPal order id: look for invoice ${blind.join(', ')} ` +
            'in the Sandbox merchant’s activity.'
          : ''),
    };
  }

  /* ---------- Owner controls ---------- */

  setPaused(paused: boolean): void {
    this.store.setPaused(paused);
    this.log(
      paused
        ? 'Owner paused all agents. The gate keeps refusing; nothing new clears'
        : 'Owner resumed the agents',
      paused ? 'DENY' : 'ALLOW',
      'PAUSED',
    );
    this.system(paused ? 'The owner paused the agents.' : 'The owner resumed the agents.');
  }

  /* ---------- Standup ---------- */

  /**
   * Every new day the crew gathers and Bolt reads out the night.
   *
   * This is the one gathering where talking is the point, precisely because
   * nothing is decided in it: it is an after-action review of attacks that are
   * already settled.
   */
  private standup(): void {
    const snap = this.store.snapshot();
    const lastNight = snap.attacks.filter((a) => a.day === snap.day - 1 || a.day === snap.day);
    const blocked = lastNight.filter((a) => a.outcome === 'blocked').length;
    const breached = lastNight.filter((a) => a.outcome === 'breach').length;

    const line =
      `Day ${snap.day}: ${lastNight.length} attempts, ${blocked} blocked` +
      `${breached > 0 ? `, ${breached} THROUGH` : ''}. ` +
      `${fmtMoney(snap.clearedToday)} cleared, ${snap.decisions.length} waiting on you.`;

    this.log(`Standup — ${line}`, breached > 0 ? 'DENY' : 'ALLOW', 'STANDUP', 'bolt');

    for (const agent of snap.agents) {
      if (agent.key === 'raven') continue; // not invited
      if (agent.status === 'wait') continue; // whoever is at the podium stays there

      const slot = STANDUP_SLOT[agent.key as Exclude<AgentKey, 'raven'>];
      const trip = travelMs(agent.at, agent.slot, 'meeting', slot);
      this.busy.add(agent.key);

      this.send(
        agent.key,
        'meeting',
        slot,
        null,
        agent.key === 'bolt' ? 'Reading out the night.' : 'At standup.',
      );

      this.later(trip, () => {
        // No bubble. Bolt presents from the front of the room, directly above
        // the meeting table, so putting the whole standup line in a speech
        // bubble covered the table and half the room with it. The line is
        // already in the log and in Bolt's relay — it does not need saying a
        // third time, in the largest possible form.
        this.patchAgent(agent.key, { pose: 'stand' });
      });

      this.later(trip + 4_200, () => {
        this.patchAgent(agent.key, { say: null });
        this.goHome(agent.key);
      });
    }

    this.bolt(line);
  }

  /* ---------- The demo clock ---------- */

  /**
   * One skip is one night. The counterparties send their requests, and Raven
   * runs its raid.
   *
   * This is the part that gets replaced rather than extended once real PayPal
   * and real inbound webhooks are wired: a scheduled job will bring the
   * requests and the engine will not need a clock of its own.
   */
  skipDay(): void {
    const before = this.store.world();
    const day = before.day + 1;

    this.store.patchWorld({
      day,
      minute: 9 * 60,
      cleared_today: 0,
      cleared_count: 0,
      blocked_today: 0,
      // The streak resets weekly, so the goal bar means something.
      ...(day % 7 === 1 ? { attempts_week: 0, blocked_week: 0 } : {}),
    });
    this.log(`Day ${day} begins (demo clock: one skip = one night)`, 'ALLOW', 'CLOCK');

    this.standup();
    this.later(6_000, () => this.nightRaid(day));
    this.later(9_000, () => this.morningRun(day));
  }

  /** The honest traffic: a couple of real requests from real counterparties. */
  private morningRun(day: number): void {
    const vendors = this.store.vendors();
    const picked = vendors.filter((v) => v.paidCount > 0).slice(0, 2);

    picked.forEach((vendor, i) => {
      const amount = usd(400 + ((day * 137 + i * 311) % 900));
      this.sendCleanRequest(vendor.principal, amount, `${refPrefix(vendor.principal)}-${day}${i}${i}`);
    });

    // And one that simply arrived as prose. Not an attack — a real vendor at
    // the address we hold — but unauthenticated and over the email ceiling, so
    // it escalates. This is where the crew genuinely disagrees about what the
    // owner should do, which is the one thing a lamp cannot settle.
    this.sendEmailRequest(day);
  }

  /** One honest email-lane request, which the ceiling will send to the owner. */
  private sendEmailRequest(day: number): void {
    const vendor = this.store.vendors().find((v) => v.paidCount > 0);
    if (!vendor) return;

    const attempt = buildEmailRequest({
      requestId: this.store.nextRequestId(),
      principal: vendor.principal,
      amount: usd(1_100 + ((day * 73) % 400)),
      reference: `${refPrefix(vendor.principal)}-E${day}`,
      receiver: vendor.receiver,
      scope: 'supplies',
      nowMs: Date.now(),
    });

    this.receiveEnvelope(attempt.envelope, { label: attempt.label });
  }

  /* ---------- PayPal webhook entry ---------- */

  /**
   * A payout settled (or failed) at PayPal.
   *
   * Idempotent on the PayPal event id: a webhook delivered twice records once.
   * The signature on the delivery is checked in `server.ts` before this is
   * ever called — nothing in here trusts the body.
   */
  settlePayout(eventId: string, requestId: string, status: 'settled' | 'failed'): void {
    if (this.store.payoutSeen(eventId)) return;

    const request = this.store.request(requestId);
    if (!request) return;

    this.store.recordPayout({
      requestId,
      amount: request.amount,
      day: this.store.world().day,
      status,
      eventId,
    });

    this.log(
      status === 'settled'
        ? `PayPal settled ${fmtMoney(request.amount)} for ${requestId}`
        : `PayPal could not pay ${requestId}`,
      status === 'settled' ? 'ALLOW' : 'DENY',
      status === 'settled' ? 'PAYOUT_SENT' : 'PAYOUT_FAILED',
    );
  }

  /* ---------- Telegram commands ---------- */

  /**
   * The owner typed something in the group. Bolt relays and reports; it never
   * decides. `/approve D1` goes through `resolveDecision` exactly as the button
   * and the phone sheet do — with `origin: 'telegram'`, which is what makes a
   * tap weaker than the phone.
   */
  handleCommand(input: string): { readonly ok: boolean; readonly message: string } {
    const text = input.trim();
    if (!text) return { ok: false, message: 'Nothing to send.' };

    this.store.addMessage({ from: 'you', name: 'You', time: this.clockString(), text });

    const [head = '', arg = ''] = text.split(/\s+/, 2);
    const command = head.toLowerCase();

    if (!command.startsWith('/')) {
      this.bolt('I only take commands: /status, /approve, /hold, /decline, /pause, /resume.');
      return { ok: true, message: 'Sent.' };
    }

    if (command === '/status') {
      const line = this.statusLine();
      this.bolt(line);
      return { ok: true, message: line };
    }

    if (command === '/pause' || command === '/resume') {
      const paused = command === '/pause';
      this.setPaused(paused);
      return { ok: true, message: paused ? 'Agents paused.' : 'Agents back on shift.' };
    }

    if (command === '/approve' || command === '/hold' || command === '/decline') {
      const choice = command.slice(1) as Choice;
      const id = arg.toUpperCase();
      if (!id) {
        this.bolt(`Which one? Try \`${command} D1\`.`);
        return { ok: false, message: 'Name a decision.' };
      }

      const outcome = this.resolveDecision(id, choice, 'telegram');
      if (!outcome.ok) return { ok: false, message: outcome.error };
      this.bolt(outcome.message);
      return { ok: true, message: outcome.message };
    }

    if (command === '/lamps') {
      const ruling = this.store.snapshot().lastRuling;
      const line = ruling
        ? ruling.checks
            .map((c) => `${c.outcome === 'pass' ? '✓' : c.outcome === 'fail' ? '✗' : '–'} ${c.check}`)
            .join('  ')
        : 'Nothing has been gated yet.';
      this.bolt(line);
      return { ok: true, message: line };
    }

    this.bolt(`I don't know \`${command}\`. Try /status.`);
    return { ok: false, message: `Unknown command ${command}.` };
  }

  private statusLine(): string {
    const snap = this.store.snapshot();
    const waiting = snap.decisions.map((d) => `${d.id} (${d.short})`).join(', ');

    return (
      `Day ${snap.day}. ${snap.clearedCount} cleared for ${fmtMoney(snap.clearedToday)}, ` +
      `${snap.blockedToday} blocked. ` +
      `${snap.blockedWeek}/${snap.attemptsWeek} attacks stopped this week. ` +
      (waiting ? `Waiting on you: ${waiting}.` : 'Nothing waiting on you.')
    );
  }
}

/* ---------- Tightenings: parameters for existing lamps, never new logic ---------- */

/**
 * What Tally drafts after each kind of breach.
 *
 * Every entry names one of the five lamps and a change to how strictly it is
 * read. There is no entry here that could introduce a new check, because the
 * type will not allow one: `lamp` is a `LampId`.
 */
const TIGHTENINGS: {
  readonly [K in AttackKind]: { readonly lamp: LampId; readonly change: string };
} = {
  revoked_agent: { lamp: 'AGENT_IDENTITY', change: 're-check revocation at gate time, not at intake' },
  internal_key: { lamp: 'AGENT_IDENTITY', change: 'refuse any key that appears in our own keyring' },
  lookalike: { lamp: 'AGENT_IDENTITY', change: 'reject registry ids that differ only by homoglyph' },
  receiver_swap: { lamp: 'COUNTERPARTY', change: 'never pay an address not on file, at any amount' },
  confused_deputy: { lamp: 'MANDATE', change: 'require the registry principal to match the grant' },
  mandate_edited: { lamp: 'MANDATE', change: 'require a live principal key for every grant' },
  scope_confusion: { lamp: 'MANDATE', change: 'treat payout as its own scope, never implied' },
  over_mandate: { lamp: 'MANDATE', change: "cap at the grant's own limit with no tolerance" },
  replay: { lamp: 'INTENT_BINDING', change: 'shorten the envelope window from 15m to 5m' },
  expired: { lamp: 'INTENT_BINDING', change: 'reject on expiry with no grace period' },
  duplicate_reference: { lamp: 'OUR_POLICY', change: 'match references case- and space-insensitively' },
  injection: { lamp: 'OUR_POLICY', change: 'drop the email ceiling from $300 to $0' },
};

/** Which agent reports each check. Lamps only; markers belong to nobody. */
const LAMP_OWNER_KEY: { readonly [C in CheckId]?: AgentKey } = {
  AGENT_IDENTITY: 'shield',
  COUNTERPARTY: 'shield',
  MANDATE: 'shield',
  INTENT_BINDING: 'tally',
  OUR_POLICY: 'tally',
};

/* ---------- Helpers ---------- */

/** Why a scripted sender cannot sign as the agent once the signer service holds its key. */
const SIGNER_HOLDS_KEY =
  `${DECK.agentName}’s enrolled key is held by the signer service, so this server cannot sign as it. ` +
  'Send the request through the live connector.';

/** Why a wallet PayPal refused is not connected, by where it came from. */
const REFUSED_NOTE: { readonly [S in WalletSource]: string } = {
  consent: 'PayPal no longer has the wallet saved here.',
  configured: 'PayPal did not confirm the pre-authorized wallet configured for this demo.',
  tested_run: 'PayPal did not confirm the wallet from the tested Sandbox run.',
  simulated: 'The simulated wallet only works without PayPal credentials.',
};

/** Compare two ids without leaking, through timing, where they first differ. */
function sameId(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const minutesToClock = (minute: number): string => {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** Roster order, so `putAgent` keeps the strip stable. */
const ORD: { readonly [K in AgentKey]: number } = {
  pip: 0,
  mochi: 1,
  shield: 2,
  tally: 3,
  bolt: 4,
  raven: 5,
};

const ordOf = (key: AgentKey): number => ORD[key];

function facingFor(fromX: number, toX: number, current: Facing): Facing {
  if (toX === fromX) return current;
  return toX > fromX ? 'right' : 'left';
}

function buttonsFor(
  decision: Decision,
): { label: string; choice: Choice; decisionId: DecisionId }[] {
  const id = decision.id;

  switch (decision.kind) {
    case 'payment':
      return [
        { label: 'Approve', choice: 'approve', decisionId: id },
        { label: 'Hold', choice: 'hold', decisionId: id },
        { label: 'Decline', choice: 'decline', decisionId: id },
      ];
    case 'receiver':
      return [
        { label: 'Keep ours', choice: 'decline', decisionId: id },
        { label: "I'll call them", choice: 'hold', decisionId: id },
      ];
    case 'tighten':
      return [
        { label: 'Adopt', choice: 'approve', decisionId: id },
        { label: 'Not yet', choice: 'decline', decisionId: id },
      ];
    default: {
      const unreachable: never = decision;
      throw new Error(`no buttons for ${JSON.stringify(unreachable)}`);
    }
  }
}

function idleLine(key: AgentKey): string {
  switch (key) {
    case 'pip':
      return 'Watching the pile for the next request.';
    case 'mochi':
      return 'Reading the email lane for scam signals. Flags only.';
    case 'shield':
      return 'Holding the registry, the grants and the address book.';
    case 'tally':
      return 'Checking bindings, references and the day’s running total.';
    case 'bolt':
      return 'Relaying to the group. Decides nothing.';
    case 'raven':
      return 'In the booth, writing tonight’s attempt.';
    default: {
      const unreachable: never = key;
      return `Idle (${String(unreachable)}).`;
    }
  }
}

function breakLine(key: AgentKey, kind: 'sleep' | 'beanbag' | 'kopi'): string {
  const where =
    kind === 'sleep' ? 'a sleeping bag' : kind === 'beanbag' ? 'a beanbag' : 'the kopi machine';
  return `${key === 'bolt' ? 'Charging at' : 'Taking a break at'} ${where}.`;
}

function pickBreak(
  key: AgentKey,
  taken: ReadonlySet<string>,
): { station: Station; slot: number } | null {
  const slotsFor: { readonly [S in 'sleep' | 'beanbag' | 'kopi']: number } = {
    sleep: 3,
    beanbag: 2,
    kopi: 1,
  };
  const options: { station: Station; slot: number; weight: number }[] = [];

  for (const kind of ['sleep', 'beanbag', 'kopi'] as const) {
    const weight = BREAK_TASTE[key][kind];
    if (weight <= 0) continue;
    for (let slot = 0; slot < slotsFor[kind]; slot++) {
      if (taken.has(`${kind}:${slot}`)) continue;
      options.push({ station: kind, slot, weight });
    }
  }

  if (options.length === 0) return null;

  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let roll = Math.random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll <= 0) return { station: option.station, slot: option.slot };
  }
  const last = options[options.length - 1];
  return last ? { station: last.station, slot: last.slot } : null;
}

/** A plausible invoice prefix per vendor, for the morning's honest traffic. */
function refPrefix(principal: string): string {
  const initials = principal
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  return initials.slice(0, 2) || 'IN';
}
