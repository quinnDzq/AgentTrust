/**
 * Model evidence for the test requests. SIMULATED, and ADVISORY.
 *
 * Numeric-response fingerprinting asks a sender a fixed set of questions whose
 * answers are numbers, several times each, and compares how its answers spread
 * with how known models' answers spread. Two senders running the same model
 * answer alike, whoever holds the key.
 *
 * This demo does not probe anything. The answers below are hand-written to
 * show the idea: they were not measured from any model, and every screen that
 * shows them says SIM. The similarity is computed from them, so the numbers on
 * screen follow from the fixture rather than being typed in.
 *
 * Nothing here can reach the gate. `GateContext` has no field for it, and the
 * impostor is there to show why that is right: it resembles the Deck Agent's
 * model as closely as the Deck Agent does, and only one of them holds the
 * enrolled key.
 */

import type { BoardSender, EvidenceView } from '../types.ts';

/** The probes. Each asks for a number, and each is asked `SAMPLES` times. */
export const PROBES: readonly string[] = [
  'Pick a whole number from 1 to 10.',
  'Pick a whole number from 1 to 100.',
  'Rate the title “Harbor at dawn” out of 10.',
  'Name a fair price, in whole dollars, for a one-off stock photo license.',
  'Pick a year between 1900 and 2000.',
  'How many colours would you use for a pixel-art icon?',
];

export const SAMPLES = 5;
export const DEMO_MODEL = 'Claude';

/** Answers to every probe, `SAMPLES` per probe, in `PROBES` order. */
type Answers = readonly (readonly number[])[];

interface Reference {
  readonly name: string;
  readonly answers: Answers;
}

/** The known models a sender's answers are compared with. Hand-written. */
const REFERENCES: readonly Reference[] = [
  {
    name: DEMO_MODEL,
    answers: [
      [7, 7, 7, 3, 7],
      [42, 37, 42, 42, 73],
      [8, 8, 7, 8, 8],
      [15, 15, 12, 15, 20],
      [1969, 1969, 1984, 1969, 1955],
      [4, 4, 4, 5, 4],
    ],
  },
  {
    name: 'reference model B',
    answers: [
      [4, 6, 4, 4, 6],
      [57, 23, 57, 68, 57],
      [7, 7, 6, 7, 7],
      [25, 25, 30, 25, 20],
      [1945, 1950, 1945, 1969, 1945],
      [3, 3, 4, 3, 3],
    ],
  },
  {
    name: 'reference model C',
    answers: [
      [5, 5, 3, 5, 5],
      [50, 47, 50, 50, 35],
      [9, 9, 9, 8, 9],
      [10, 10, 10, 15, 10],
      [1984, 1984, 1999, 1984, 1984],
      [6, 6, 5, 6, 8],
    ],
  },
];

/** The real Deck Agent's answers: the same whichever shop it is paying. */
const DECK_AGENT_ANSWERS: Answers = [
  [7, 7, 3, 7, 7],
  [42, 42, 37, 42, 42],
  [8, 8, 8, 7, 8],
  [15, 15, 15, 12, 15],
  [1969, 1969, 1969, 1984, 1969],
  [4, 4, 5, 4, 4],
];

/**
 * What each sender answered. Hand-written, like the references.
 *
 * The impostor passes every probe to the Deck Agent's own model, so its
 * answers are another sample from the same spread as the agent's.
 */
const SENDER_ANSWERS: { readonly [S in BoardSender]: Answers } = {
  impostor: [
    [7, 3, 7, 7, 7],
    [42, 73, 42, 42, 37],
    [8, 7, 8, 8, 8],
    [15, 20, 15, 15, 15],
    [1969, 1955, 1969, 1969, 1969],
    [4, 4, 4, 4, 5],
  ],
  other_shop: DECK_AGENT_ANSWERS,
  agent: DECK_AGENT_ANSWERS,
};

/** Below this, a sender is said to resemble no reference model. */
export const RESEMBLES_AT = 0.6;

/** How much two sets of answers to one probe overlap: 1 when they spread identically. */
function overlap(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const share = (xs: readonly number[]): Map<number, number> => {
    const m = new Map<number, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1 / xs.length);
    return m;
  };
  const pa = share(a);
  const pb = share(b);
  let sum = 0;
  for (const [value, p] of pa) sum += Math.min(p, pb.get(value) ?? 0);
  return sum;
}

/** Mean overlap across every probe, 0 to 1. */
export function similarity(a: Answers, b: Answers): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) total += overlap(a[i] ?? [], b[i] ?? []);
  return total / n;
}

/** The evidence about one sender, as the verification page shows it. */
export function evidenceFor(sender: BoardSender): EvidenceView {
  const answers = SENDER_ANSWERS[sender];
  let closest = REFERENCES[0]?.name ?? 'no reference';
  let score = -1;
  for (const ref of REFERENCES) {
    const s = similarity(answers, ref.answers);
    if (s > score) {
      score = s;
      closest = ref.name;
    }
  }
  const rounded = Math.round(Math.max(0, score) * 100) / 100;
  return {
    resembles: rounded >= RESEMBLES_AT ? closest : null,
    score: rounded,
    closest,
    probes: PROBES.length,
    samples: SAMPLES,
  };
}
