/**
 * The gate. Plain code, no model, no network, no clock, no crypto.
 *
 * This is the whole of "the AI talks, the code decides". Claude reads prose on
 * the email lane and writes explanations; it never holds a cap, approves a
 * payment, or changes a trust tier. Every request arrives here as an
 * `Envelope` and leaves as a `Ruling`, and nothing calls PayPal without one.
 *
 * `gate` is a pure function of its two arguments. Every fact it needs has
 * already been established by a collector — signatures verified, registry
 * read, nonce table checked, clock sampled — and arrives in `GateContext`.
 * `gate` only compares. That is why `src/rules.test.ts` can cover the entire
 * authorisation surface of the app, including every attack in Raven's book,
 * without a key or a database in sight.
 *
 * Read `LAMPS` in `src/types.ts` for the order. It is the order on the vault.
 */

import {
  addCents,
  cents,
  fmtMoney,
  LAMPS,
  maxZero,
  subCents,
  usd,
  type ApprovalOrigin,
  type Cents,
  type CheckId,
  type CheckResult,
  type Decision,
  type Envelope,
  type GateContext,
  type LampId,
  type Level,
  type Origin,
  type Policy,
  type Ruling,
  type VendorRecord,
} from './types.ts';

/* ---------- The owner's policy ---------- */

/**
 * The seed policy: the one place a limit is written down.
 *
 * Exported without a signature because signing needs a key, and this file is
 * pure and shipped to the browser. The server signs it at seed time, and from
 * then on the live `Policy` row is what the gate compares against and what the
 * crew sheet renders. Nothing copies a number out of either.
 */
export const DEFAULT_POLICY: Omit<Policy, 'signature'> = {
  expiresDay: 30,
  dailyTotal: usd(6_000),
  // The README's trust rule: a Telegram tap approves small, and never an address.
  telegramCap: usd(1_000),
  perPayment: { 1: usd(250), 2: usd(600), 3: usd(1_200), 4: usd(2_500), 5: usd(4_000) },
  // Graded by how far authentication actually got. These must stay ordered —
  // a weaker origin can never clear more than a stronger one, and
  // `rules.test.ts` asserts it.
  originCeiling: { agent: usd(4_000), portal: usd(1_200), email: usd(300) },
};

/**
 * The band an amount has to stay inside to clear without the owner.
 *
 * Twice the most we have ever paid this vendor, with a floor so a vendor we
 * have paid once for a trivial amount does not escalate every invoice after
 * it. A new vendor never reaches this check: with no record at all, the
 * counterparty lamp has already failed.
 */
export function anomalyBand(vendor: VendorRecord): Cents {
  const double = (vendor.maxPaid * 2) as Cents;
  return double > usd(500) ? double : usd(500);
}

/* ---------- Building results ---------- */

const pass = (check: CheckId, note: string): CheckResult => ({ check, outcome: 'pass', note });
const ask = (check: CheckId, note: string): CheckResult => ({ check, outcome: 'ask', note });
const fail = (check: CheckId, note: string): CheckResult => ({ check, outcome: 'fail', note });
const skip = (check: CheckId, note: string): CheckResult => ({ check, outcome: 'skip', note });

/* ---------- Which lamps an origin can even answer ---------- */

/**
 * What each origin brings to the gate.
 *
 * A signed agent envelope answers all five lamps. A vendor portal is
 * session-authenticated but presents no grant, so the mandate lamp has nothing
 * to read. Email brings nothing signed at all: the first three lamps are
 * skipped and the request leans entirely on our own records and the origin
 * ceiling, which is why that ceiling is the smallest of the three.
 *
 * A skipped lamp is drawn differently and never counts toward a verdict. The
 * safety of skipping rests wholly on `originCeiling` being ordered.
 */
const ANSWERS: { readonly [O in Origin]: { readonly [L in LampId]: boolean } } = {
  agent: {
    AGENT_IDENTITY: true,
    COUNTERPARTY: true,
    MANDATE: true,
    INTENT_BINDING: true,
    OUR_POLICY: true,
  },
  portal: {
    AGENT_IDENTITY: true,
    COUNTERPARTY: true,
    MANDATE: false,
    INTENT_BINDING: true,
    OUR_POLICY: true,
  },
  email: {
    AGENT_IDENTITY: false,
    COUNTERPARTY: true,
    MANDATE: false,
    INTENT_BINDING: false,
    OUR_POLICY: true,
  },
};

/* ---------- The five lamps ---------- */

/** Lamp 1. Is this key in our registry, live, and not one of ours? */
function agentIdentity(env: Envelope, ctx: GateContext): CheckResult {
  const id = env.agent.registryId;

  switch (ctx.registry) {
    case 'internal':
      // Our own keys never authorise a payment. This is what makes Raven's own
      // signature worthless and closes self-dealing in one line.
      return fail('AGENT_IDENTITY', `${id} is one of our own keys — internal keys never pay`);
    case 'unknown':
      return fail('AGENT_IDENTITY', `${id} is not in the agent registry`);
    case 'revoked':
      return fail('AGENT_IDENTITY', `${id} was revoked`);
    case 'active':
      break;
    default: {
      const unreachable: never = ctx.registry;
      return fail('AGENT_IDENTITY', `unknown registry status ${String(unreachable)}`);
    }
  }

  if (!ctx.agentSigValid) {
    return fail('AGENT_IDENTITY', `${id}'s signature does not verify`);
  }

  return pass('AGENT_IDENTITY', `${id} active, signature verifies`);
}

/** Lamp 3. Did the principal really grant this agent this scope and cap? */
function mandate(env: Envelope, ctx: GateContext): CheckResult {
  const m = env.mandate;

  if (!ctx.mandateSigValid) {
    return fail('MANDATE', `${m.principal}'s signature over the grant does not verify`);
  }

  if (m.agentKey !== env.agent.key) {
    return fail('MANDATE', 'the grant was issued to a different key');
  }

  // The confused deputy: a real agent with a real grant, but our registry says
  // that key acts for somebody else. Only visible by comparing the two.
  if (ctx.registryPrincipal !== null && ctx.registryPrincipal !== m.principal) {
    return fail(
      'MANDATE',
      `registry says ${env.agent.registryId} acts for ${ctx.registryPrincipal}, the grant claims ${m.principal}`,
    );
  }

  if (m.expiresDay < ctx.day) {
    return fail('MANDATE', `the grant lapsed on day ${m.expiresDay}`);
  }

  if (env.intent.scope !== m.scope) {
    return fail('MANDATE', `the grant covers ${m.scope}, the ask is ${env.intent.scope}`);
  }

  if (env.intent.amount > m.maxPerPayment) {
    return fail(
      'MANDATE',
      `${fmtMoney(env.intent.amount)} is over the ${fmtMoney(m.maxPerPayment)} ${m.principal} granted`,
    );
  }

  return pass(
    'MANDATE',
    `${m.scope} up to ${fmtMoney(m.maxPerPayment)}, expires day ${m.expiresDay}`,
  );
}

/** Lamp 4. Does the signature cover this exact ask, once, before it expired? */
function intentBinding(env: Envelope, ctx: GateContext): CheckResult {
  if (!ctx.intentBound) {
    return fail('INTENT_BINDING', 'the signature does not cover this amount, receiver and reference');
  }

  if (ctx.nonceSeen) {
    return fail('INTENT_BINDING', `nonce ${env.nonce} has been used before`);
  }

  if (ctx.nowMs > env.expiresAtMs) {
    return fail('INTENT_BINDING', 'the envelope expired before it reached the gate');
  }

  return pass('INTENT_BINDING', `bound to ${env.intent.reference}, nonce fresh`);
}

/** Lamp 2. Is the principal a vendor we know, paid at the address we hold? */
function counterparty(env: Envelope, ctx: GateContext): CheckResult {
  const claimed = env.mandate.principal;
  const vendor = ctx.counterparty;

  if (vendor === null) {
    return fail('COUNTERPARTY', `${claimed} is not a vendor we hold a record for`);
  }

  if (vendor.receiver !== env.intent.receiver) {
    // The oldest scam in the book, and the one the gate is proudest of: a
    // changed payout address is never a question of size.
    return fail(
      'COUNTERPARTY',
      `the ask pays ${env.intent.receiver}; we hold ${vendor.receiver} for ${vendor.principal}`,
    );
  }

  return pass('COUNTERPARTY', `${vendor.principal} at ${vendor.receiver}, paid ${vendor.paidCount}x`);
}

/**
 * The deck's ask, or null when this purchase stays under the threshold.
 *
 * A single purchase over the percent asks. So does the purchase that takes
 * cumulative spend past that percent for the first time. Exactly on the
 * percent does not. An amount past the budget is refused earlier.
 */
function thresholdAsk(amount: Cents, paidToday: Cents, budget: Cents, pct: number): string | null {
  if (budget <= 0) return null;
  const threshold = cents(Math.round((budget * pct) / 100));
  const after = addCents(paidToday, amount);
  const single = amount > threshold;
  const crosses = paidToday <= threshold && after > threshold;
  if (!single && !crosses) return null;
  if (single) {
    const share = Math.round((amount * 100) / budget);
    return `${fmtMoney(amount)} is ${share}% of your ${fmtMoney(budget)} budget, over your ${pct}% ask threshold, buyer confirmation needed`;
  }
  const share = Math.round((after * 100) / budget);
  return `${fmtMoney(amount)} would take spending to ${fmtMoney(after)}, ${share}% of your ${fmtMoney(budget)} budget, over your ${pct}% ask threshold, buyer confirmation needed`;
}

/** Lamp 5. Is it inside the owner's caps, and not a reference we have paid? */
function ourPolicy(env: Envelope, ctx: GateContext): CheckResult {
  const { policy } = ctx;
  const amount = env.intent.amount;

  if (!ctx.policySigValid) {
    return fail('OUR_POLICY', 'the owner policy on file does not verify — nothing clears');
  }

  if (policy.expiresDay < ctx.day) {
    return fail('OUR_POLICY', `the owner's authority lapsed on day ${policy.expiresDay}`);
  }

  if (ctx.duplicateOf !== null) {
    return fail('OUR_POLICY', `${env.intent.reference} was already paid as ${ctx.duplicateOf}`);
  }

  // The deck scene keeps the shop's quotes. Over the approved budget is
  // refused. A purchase over the ask threshold, or the one that first takes
  // cumulative spend past it, asks the buyer. Vendor history does not.
  if (ctx.quote !== undefined) {
    if (ctx.quote === null) {
      return fail('OUR_POLICY', `${env.intent.reference} is not an open quote from the merchant`);
    }
    if (amount !== ctx.quote) {
      return fail(
        'OUR_POLICY',
        `${fmtMoney(amount)} is not the merchant's ${fmtMoney(ctx.quote)} quote for ${env.intent.reference}`,
      );
    }
    const left = maxZero(subCents(policy.dailyTotal, ctx.paidToday));
    if (addCents(ctx.paidToday, amount) > policy.dailyTotal) {
      return fail(
        'OUR_POLICY',
        `would exceed budget: ${fmtMoney(ctx.paidToday)} spent, ${fmtMoney(left)} left`,
      );
    }
    if (ctx.askThresholdPct !== undefined) {
      const line = thresholdAsk(amount, ctx.paidToday, policy.dailyTotal, ctx.askThresholdPct);
      if (line) return ask('OUR_POLICY', line);
    }
    return pass(
      'OUR_POLICY',
      `within the approved ${fmtMoney(policy.dailyTotal)} budget (${fmtMoney(left)} left)`,
    );
  }

  const ceiling = policy.originCeiling[env.origin];
  if (amount > ceiling) {
    return ask(
      'OUR_POLICY',
      // "on the email lane" rather than "for a email request": the article
      // would be wrong for two of the three origins.
      `${fmtMoney(amount)} is over the ${fmtMoney(ceiling)} ceiling on the ${env.origin} lane`,
    );
  }

  const tierCap = policy.perPayment[ctx.tier];
  if (amount > tierCap) {
    return ask(
      'OUR_POLICY',
      `${fmtMoney(amount)} is over the ${fmtMoney(tierCap)} that tier ${ctx.tier} clears alone`,
    );
  }

  // `paidToday` counts what is still reserved with PayPal as well as what has
  // settled, so two requests in flight can never both fit the last few dollars.
  const dayTotal = addCents(ctx.paidToday, amount);
  if (dayTotal > policy.dailyTotal) {
    const left = maxZero(subCents(policy.dailyTotal, ctx.paidToday));
    return ask(
      'OUR_POLICY',
      `${fmtMoney(dayTotal)} would pass today's ${fmtMoney(policy.dailyTotal)} limit (${fmtMoney(left)} left)`,
    );
  }

  // Unusual for this vendor is a judgment, not a contradiction, so it asks.
  if (ctx.counterparty !== null) {
    const band = anomalyBand(ctx.counterparty);
    if (amount > band) {
      return ask(
        'OUR_POLICY',
        `${fmtMoney(amount)} is unusual for ${ctx.counterparty.principal} — most we have paid is ${fmtMoney(ctx.counterparty.maxPaid)}`,
      );
    }
  }

  return pass('OUR_POLICY', `inside tier ${ctx.tier} (${fmtMoney(tierCap)}) and today's limit`);
}

const LAMP_FN: { readonly [L in LampId]: (env: Envelope, ctx: GateContext) => CheckResult } = {
  AGENT_IDENTITY: agentIdentity,
  COUNTERPARTY: counterparty,
  MANDATE: mandate,
  INTENT_BINDING: intentBinding,
  OUR_POLICY: ourPolicy,
};

const SKIP_NOTE: { readonly [L in LampId]: string } = {
  AGENT_IDENTITY: 'no agent to authenticate on this lane',
  COUNTERPARTY: 'not applicable',
  MANDATE: 'no grant presented on this lane',
  INTENT_BINDING: 'nothing signed to bind on this lane',
  OUR_POLICY: 'not applicable',
};

/* ---------- The one decision point ---------- */

/**
 * Decide whether a payment request may be paid.
 *
 * Every lamp runs — they are pure and cheap — so the vault can light all five
 * from one evaluation. The verdict is the worst outcome among them, and the
 * `check` names the *first* failure in lamp order: the one the Case tab
 * prints and the audit log cites.
 *
 * Pause wins over everything: while the owner has paused the crew, nothing
 * new clears, and a hold stays a hold.
 */
export function gate(env: Envelope, ctx: GateContext): Ruling {
  if (ctx.paused) {
    return {
      verdict: 'DENY',
      check: 'PAUSED',
      reason: 'the owner paused all agents',
      checks: LAMPS.map((lamp) => skip(lamp, 'paused')),
    };
  }

  const answers = ANSWERS[env.origin];
  const checks = LAMPS.map((lamp) =>
    answers[lamp] ? LAMP_FN[lamp](env, ctx) : skip(lamp, SKIP_NOTE[lamp]),
  );

  const failed = checks.find((c) => c.outcome === 'fail');
  if (failed) {
    return { verdict: 'DENY', check: failed.check, reason: failed.note, checks };
  }

  const asked = checks.find((c) => c.outcome === 'ask');
  if (asked) {
    return { verdict: 'ASK_OWNER', check: asked.check, reason: asked.note, checks };
  }

  return { verdict: 'ALLOW', check: 'OUR_POLICY', checks };
}

/* ---------- Approving: where the tap came from matters ---------- */

/**
 * Decide whether `origin` is trusted enough to resolve `decision`.
 *
 * The README's trust rule, as a rule rather than a route handler: a Telegram
 * tap can approve a small payment but never a large one, and never a change of
 * payout address. The phone sheet carries the owner's full authority.
 *
 * A `hold` or a `decline` is always allowed from anywhere — refusing to pay is
 * never the dangerous direction. Likewise a `tighten`: adopting it only ever
 * narrows a lamp.
 */
export function canApproveFrom(
  decision: Decision,
  choice: 'approve' | 'hold' | 'decline',
  origin: ApprovalOrigin,
  policy: Policy,
): Ruling {
  const allowed = (note: string): Ruling => ({
    verdict: 'ALLOW',
    check: 'ORIGIN_CAP',
    checks: [pass('ORIGIN_CAP', note)],
  });

  const refused = (note: string): Ruling => ({
    verdict: 'DENY',
    check: 'ORIGIN_CAP',
    reason: note,
    checks: [fail('ORIGIN_CAP', note)],
  });

  if (choice !== 'approve') return allowed(`${choice} needs no extra authority`);
  if (origin === 'phone') return allowed('approved on the phone sheet');

  switch (decision.kind) {
    case 'receiver':
      return refused('a Telegram tap can never change a payout address — use the phone sheet');

    case 'payment':
      return decision.amount > policy.telegramCap
        ? refused(
            `${fmtMoney(decision.amount)} is over the ${fmtMoney(policy.telegramCap)} a Telegram tap may approve`,
          )
        : allowed(`inside the ${fmtMoney(policy.telegramCap)} Telegram cap`);

    case 'tighten':
      return allowed('adopting a tightening only narrows a lamp');

    default: {
      // Exhaustive: a new decision kind must be given an origin rule before it
      // compiles.
      const unreachable: never = decision;
      return refused(`no origin rule covers ${JSON.stringify(unreachable)}`);
    }
  }
}

/* ---------- Trust tiers ---------- */

/** XP needed to leave each tier. Tier 5 is the cap, so there is no 5 here. */
export const TIER_NEXT: { readonly [L in Exclude<Level, 5>]: number } = {
  1: 120,
  2: 200,
  3: 300,
  4: 420,
};

export const MAX_TIER = 5 satisfies Level;

/**
 * Trust moves for each outcome.
 *
 * Being fooled costs far more than clearing a payment earns, and a breach
 * costs most of all. Only Pip can be fooled — the email lane is the only place
 * a model's reading enters a request — so this is the one agent whose tier has
 * a real causal story behind it.
 */
export const TRUST = {
  clearedClean: 4,
  ownerApproved: 6,
  ownerDeclined: -20,
  fooled: -40,
  breach: -60,
} as const;

export interface Progress {
  readonly level: Level;
  readonly xp: number;
}

export interface Tiered extends Progress {
  /** True when this move pushed the agent across a tier boundary. */
  readonly changed: boolean;
}

/**
 * Apply a trust change, carrying the agent across a tier when it crosses the
 * threshold. XP never goes below zero and a tier is never lost on a single
 * mistake unless the change is big enough to empty it, so a bad call costs
 * progress honestly. Tier 5 keeps banking.
 */
export function award(progress: Progress, delta: number): Tiered {
  let { level } = progress;
  let xp = progress.xp + delta;
  let changed = false;

  // Gaining: carry up through as many tiers as the trust covers.
  while (level < MAX_TIER) {
    const next = TIER_NEXT[level as Exclude<Level, 5>];
    if (xp < next) break;
    xp -= next;
    level = (level + 1) as Level;
    changed = true;
  }

  // Losing: a deficit drops a tier and lands part-way down it, so the cap that
  // applies tomorrow reflects today's mistake. Tier 1 simply floors at zero —
  // an agent can lose every privilege it earned but never go below the floor.
  while (xp < 0 && level > 1) {
    level = (level - 1) as Level;
    xp += Math.round(TIER_NEXT[level as Exclude<Level, 5>] / 2);
    changed = true;
  }

  return { level, xp: Math.max(0, xp), changed };
}

/** XP needed to leave the current tier, or null at the cap. */
export function tierToNext(level: Level): number | null {
  return level === MAX_TIER ? null : TIER_NEXT[level];
}

/** The caps a tier selects, for the crew sheet. Reads the live policy. */
export function capsFor(policy: Policy, level: Level): {
  readonly perPayment: Cents;
  readonly daily: Cents;
} {
  return { perPayment: policy.perPayment[level], daily: policy.dailyTotal };
}
