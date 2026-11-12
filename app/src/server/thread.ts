/**
 * The crew's conversation about a case.
 *
 * **This runs after the ruling and can never change it.** `buildThread` takes
 * a `Ruling` that has already been reached and written down, and produces
 * commentary on it. `GateContext` has no field for a thread, exactly as it has
 * none for untrusted prose, so there is nowhere for an argument to enter the
 * decision — however persuasive a pet is, a lamp is arithmetic.
 *
 * What they argue about instead is worth having:
 *
 *   - what the request actually means (interpretation)
 *   - how it ought to be checked (method)
 *   - what the owner should do about it (advice)
 *
 * The third is the valuable one. When the gate asks the owner, two pets
 * recommending opposite things is the point: it is what makes the tap a
 * judgment rather than a rubber stamp.
 *
 * Pure, so the voices are testable without a database. It is also the seam for
 * milestone 4: swap this for a Claude call and nothing else moves, because the
 * signature already takes a settled ruling and returns lines.
 */

import {
  fmtMoney,
  LAMP_LABEL,
  ORIGIN_LABEL,
  type AgentKey,
  type CaseBeat,
  type CheckId,
  type CheckResult,
  type Envelope,
  type LampId,
  type Level,
  type Policy,
  type Ruling,
  type ScamFlag,
  type VendorRecord,
} from '../types.ts';

/** A line before the store gives it an id. */
export interface CaseLine {
  readonly from: AgentKey | 'gate';
  readonly beat: CaseBeat;
  readonly text: string;
  readonly cites: CheckId | null;
}

export interface ThreadInput {
  readonly envelope: Envelope;
  readonly ruling: Ruling;
  readonly vendor: VendorRecord | null;
  readonly flags: readonly ScamFlag[];
  readonly day: number;
  readonly tier: Level;
  readonly policy: Policy;
}

const line = (
  from: AgentKey | 'gate',
  beat: CaseBeat,
  text: string,
  cites: CheckId | null = null,
): CaseLine => ({ from, beat, text, cites });

const noteFor = (ruling: Ruling, check: CheckId): string =>
  ruling.checks.find((c) => c.check === check)?.note ?? '';

const lampName = (check: CheckId): string =>
  check in LAMP_LABEL ? LAMP_LABEL[check as LampId] : check;

/* ---------- The beats ---------- */

/** Pip opens every case the same way: what arrived, and on which lane. */
function open(input: ThreadInput): CaseLine {
  const { envelope } = input;
  return line(
    'pip',
    'open',
    `${ORIGIN_LABEL[envelope.origin]} from ${envelope.mandate.principal}. ` +
      `${fmtMoney(envelope.intent.amount)} for ${envelope.intent.reference}.`,
  );
}

/**
 * Mochi, and only on the lanes where there is prose to be sceptical about or a
 * fact worth being uneasy over. It never cites a lamp, because it owns none.
 */
function concern(input: ThreadInput): CaseLine | null {
  const { envelope, vendor, flags } = input;

  if (vendor && vendor.receiver !== envelope.intent.receiver) {
    return line(
      'mochi',
      'concern',
      `Hold on — this one wants a different address. That is the oldest trick there is.`,
    );
  }

  const injection = flags.find((f) => f.kind === 'injection');
  if (injection) {
    return line('mochi', 'concern', `There are instructions buried in this one: ${injection.note}.`);
  }

  if (envelope.origin === 'email') {
    return line(
      'mochi',
      'concern',
      `Nothing is signed on this lane. We are taking its word for all of it.`,
    );
  }

  if (flags.length > 0) {
    const first = flags[0];
    return first ? line('mochi', 'concern', `Worth a look: ${first.note}.`) : null;
  }

  return null;
}

/** The two checkers read out the lamps they own. Facts, with their sources. */
function reports(input: ThreadInput): CaseLine[] {
  const { ruling } = input;
  const out: CaseLine[] = [];

  const say = (who: AgentKey, checks: readonly CheckId[]): void => {
    const mine = ruling.checks.filter((c) => checks.includes(c.check) && c.outcome !== 'skip');
    if (mine.length === 0) return;

    const mark = (c: CheckResult): string =>
      c.outcome === 'fail' ? '✗' : c.outcome === 'ask' ? '!' : '✓';

    out.push(
      line(
        who,
        'report',
        mine.map((c) => `${mark(c)} ${c.note}`).join('  ·  '),
        mine.find((c) => c.outcome === 'fail')?.check ?? mine[0]?.check ?? null,
      ),
    );
  };

  say('shield', ['AGENT_IDENTITY', 'COUNTERPARTY', 'MANDATE']);
  say('tally', ['INTENT_BINDING', 'OUR_POLICY']);

  return out;
}

/**
 * Where they actually differ.
 *
 * Keyed on the lamp that settled it, because what is worth saying about a
 * blocked payment depends entirely on *which* thing was wrong. The shape is
 * always the same: one pet points out what was fine, another points out why
 * that is exactly what the attacker was relying on.
 */
function argument(input: ThreadInput): CaseLine[] {
  const { ruling, envelope, vendor } = input;
  if (ruling.verdict === 'ALLOW') return [];

  switch (ruling.check) {
    case 'COUNTERPARTY':
      if (vendor && vendor.receiver !== envelope.intent.receiver) {
        return [
          line(
            'tally',
            'argue',
            `Everything else on it is clean. If the address matched I would have paid it without asking anyone.`,
            'COUNTERPARTY',
          ),
          line(
            'mochi',
            'argue',
            `Which is what they were counting on. The whole request was built to be clean apart from the one field that moves the money.`,
          ),
        ];
      }
      return [
        line(
          'shield',
          'argue',
          `We hold no record for them at all. I am not paying a stranger on their say-so.`,
          'COUNTERPARTY',
        ),
      ];

    case 'AGENT_IDENTITY':
      return [
        line(
          'shield',
          'argue',
          `The signature is real — that is the part people get wrong. A good signature proves who wrote it, never that they are still allowed to.`,
          'AGENT_IDENTITY',
        ),
        line('tally', 'argue', `So we would have paid this yesterday and been right to.`),
      ];

    case 'MANDATE':
      return [
        line(
          'shield',
          'argue',
          `Their own principal set that limit, not us. There is nobody on our side who can agree to more on their behalf.`,
          'MANDATE',
        ),
        line('mochi', 'argue', `Worth asking who benefits from us reading the grant loosely.`),
      ];

    case 'INTENT_BINDING':
      return [
        line('tally', 'argue', `I have seen this one before — same nonce, same bytes.`, 'INTENT_BINDING'),
        line(
          'pip',
          'argue',
          `Then I opened it twice and only noticed the second time. That is what the table is for.`,
        ),
      ];

    case 'OUR_POLICY':
      return [
        line(
          'tally',
          'argue',
          `Nothing is wrong with it. It is only bigger than what we were told we could clear on our own.`,
          'OUR_POLICY',
        ),
      ];

    case 'PAUSED':
      return [line('pip', 'argue', `We are paused. It waits.`, 'PAUSED')];

    default:
      return [];
  }
}

/** The verdict. Drawn apart from the conversation, and not by any of them. */
function verdict(input: ThreadInput): CaseLine {
  const { ruling } = input;
  const label =
    ruling.verdict === 'ALLOW' ? 'PAID' : ruling.verdict === 'DENY' ? 'BLOCKED' : 'NEEDS YOU';
  const why = ruling.verdict === 'ALLOW' ? 'all five lamps green' : ruling.reason;

  return line('gate', 'verdict', `${label} — ${lampName(ruling.check)}: ${why}`, ruling.check);
}

/**
 * What each of them would do, when the gate has asked the owner.
 *
 * Only on an escalation, and only ever advice. They are allowed to disagree
 * here and often should: the owner is being asked precisely because code has
 * run out of things it can settle.
 */
function recommendations(input: ThreadInput): CaseLine[] {
  const { ruling, envelope, vendor, flags, policy, tier } = input;
  if (ruling.verdict !== 'ASK_OWNER') return [];

  const out: CaseLine[] = [];
  const history = vendor
    ? `We have paid them ${vendor.paidCount} times, most ever ${fmtMoney(vendor.maxPaid)}`
    : 'We have no history with them';

  // Tally argues from the books.
  const routine = vendor !== null && envelope.intent.amount <= vendor.maxPaid;
  out.push(
    line(
      'tally',
      'recommend',
      routine
        ? `Pay it. ${history}, and this is not the largest. The only thing stopping me is the tier ${tier} cap of ${fmtMoney(policy.perPayment[tier])}.`
        : `Your call. ${history}, so this one is above their usual shape.`,
      'OUR_POLICY',
    ),
  );

  // Mochi argues from the smell of it, and is allowed to land the other way.
  out.push(
    line(
      'mochi',
      'recommend',
      flags.length > 0
        ? `I would hold it. Nothing failed, but ${flags[0]?.note ?? 'it reads wrong to me'} — and Tally is reading the books, not the letter.`
        : envelope.origin === 'agent'
          ? `No objection from me. Signed, in scope, and the address is the one we hold.`
          : `I would want this signed before I paid it. Nothing on this lane proves anything.`,
    ),
  );

  // Shield states what approving would actually do, without recommending.
  out.push(
    line(
      'shield',
      'recommend',
      `Approving pays ${fmtMoney(envelope.intent.amount)} to ${envelope.intent.receiver}. ` +
        `I have not changed anything and will not without you.`,
      'ORIGIN_CAP',
    ),
  );

  return out;
}

/* ---------- The whole thread ---------- */

/**
 * Build the conversation for one settled case.
 *
 * A clean pass gets two lines: there is nothing to discuss, and the quiet is
 * the signal. Anything else gets the full thread. That is deliberate — the
 * volume of chat is itself a read-out of whether something is wrong, and it is
 * the same reason the gate room only convenes on trouble.
 */
export function buildThread(input: ThreadInput): CaseLine[] {
  const { ruling } = input;

  if (ruling.verdict === 'ALLOW') {
    return [
      open(input),
      line(
        'tally',
        'report',
        noteFor(ruling, 'OUR_POLICY') || 'inside every cap',
        'OUR_POLICY',
      ),
      verdict(input),
    ];
  }

  const worry = concern(input);

  return [
    open(input),
    ...(worry ? [worry] : []),
    ...reports(input),
    ...argument(input),
    verdict(input),
    ...recommendations(input),
  ];
}
