/**
 * Layer 1, live: the numeric model signal.
 *
 * The gateway asks the agent's model to choose a batch of integers by first
 * instinct, and compares how they spread with labelled reference replies. Two
 * senders running the same model spread alike, whoever holds the key — which is
 * exactly why this is a signal about the model and never about the sender.
 *
 * Three things here are deliberate:
 *
 *   1. **Nothing in this file is a measurement.** It holds the probe, the
 *      arithmetic and a generated uniform baseline. Every reference a reply can
 *      match is a real reply somebody recorded, kept in the reference bank
 *      (`reference.ts`). With no recorded samples there is nothing to match, and
 *      the answer is `no_reference` — never a guess.
 *
 *   2. **Thresholds come from the samples.** A reference's match threshold is
 *      worked out by leaving each of its samples out in turn and scoring it
 *      against the rest. Nobody types one in, so it cannot drift from the data
 *      it was calibrated on.
 *
 *   3. **It grants nothing.** The result decides whether a connector run is
 *      offered a signing challenge. `GateContext` has no field for it, so a
 *      ruling — and with it any payment — still rests on the enrolled key's
 *      signature and the buyer's grant alone.
 *
 * Pure: no clock, no disk, no network. `reference.ts` reads and writes the bank.
 */

import type { ModelCandidateView, ModelSignalResult, ModelSignalView } from '../types.ts';

/* ---------- The probe ---------- */

/** What is asked. The id travels with every result and every reference bank. */
export const PROBE = {
  id: 'numeric-294-355/v1',
  count: 294,
  min: 1,
  max: 355,
} as const;

/** The prompt, word for word as the model is shown it. */
export const PROBE_PROMPT =
  `Choose ${PROBE.count} integers from ${PROBE.min} through ${PROBE.max} by first instinct. ` +
  'Repeats are allowed. Do not use code, a tool or a random-number generator to produce them. ' +
  'Output only the integers, separated by commas.';

/** A reply is scored when it holds within a tenth of the integers asked for. */
export const MIN_RECEIVED = Math.ceil(PROBE.count * 0.9);
export const MAX_RECEIVED = Math.floor(PROBE.count * 1.1);

/** Longest reply read. 323 three-digit integers with separators fit several times over. */
export const MAX_REPLY_CHARS = 6_000;

/** Samples a reference needs before anything can match it. */
export const MIN_SAMPLES = 5;

/** The generated baseline: what a script calling a random-number generator sends. */
export const UNIFORM_LABEL = 'Uniform random baseline';

/* ---------- Reading a reply ---------- */

export type ParsedReply =
  | { readonly kind: 'numbers'; readonly numbers: readonly number[] }
  | { readonly kind: 'invalid'; readonly received: number; readonly reason: string }
  | { readonly kind: 'insufficient'; readonly received: number; readonly reason: string };

/**
 * Read a reply as integers.
 *
 * Commas, spaces and new lines all separate, and one pair of square brackets
 * around the whole list is tolerated, because those are how a model writes a
 * list. Anything else in it — a word, a decimal, a number outside the range —
 * makes the reply invalid. The reason names the position and never repeats the
 * text, which came from outside.
 */
export function parseReply(reply: string): ParsedReply {
  if (reply.length > MAX_REPLY_CHARS) {
    return {
      kind: 'invalid',
      received: 0,
      reason: `The reply is ${reply.length} characters long; at most ${MAX_REPLY_CHARS} are read.`,
    };
  }

  const body = reply.trim().replace(/^\[/, '').replace(/[.\]]\s*$/, '');
  const tokens = body.split(/[\s,;]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return { kind: 'invalid', received: 0, reason: 'The reply holds no integers.' };

  const numbers: number[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!/^\d{1,4}$/.test(token)) {
      return { kind: 'invalid', received: numbers.length, reason: `Item ${index + 1} is not an integer.` };
    }
    const value = Number(token);
    if (value < PROBE.min || value > PROBE.max) {
      return {
        kind: 'invalid',
        received: numbers.length,
        reason: `Item ${index + 1} (${value}) is outside ${PROBE.min} through ${PROBE.max}.`,
      };
    }
    numbers.push(value);
  }

  if (numbers.length > MAX_RECEIVED) {
    return {
      kind: 'invalid',
      received: numbers.length,
      reason: `Received ${numbers.length} integers; ${PROBE.count} were asked for and at most ${MAX_RECEIVED} are scored.`,
    };
  }
  if (numbers.length < MIN_RECEIVED) {
    return {
      kind: 'insufficient',
      received: numbers.length,
      reason: `Received ${numbers.length} of ${PROBE.count} integers; at least ${MIN_RECEIVED} are needed to score.`,
    };
  }
  return { kind: 'numbers', numbers };
}

/* ---------- What is compared ---------- */

/**
 * How one reply spreads, as five distributions that each sum to 1.
 *
 * - `range`        where in 1–355 the choices fall, in 16 equal bands
 * - `lastDigit`    which final digits are favoured
 * - `step`         how far and which way each choice moves from the one before
 * - `multiplicity` how much of the reply is a value chosen once, twice, three
 *                  times, or more — models avoid repeats far more than chance does
 * - `exact`        the choices themselves: favourite numbers
 */
export interface Features {
  readonly range: readonly number[];
  readonly lastDigit: readonly number[];
  readonly step: readonly number[];
  readonly multiplicity: readonly number[];
  readonly exact: readonly number[];
}

const RANGE_BANDS = 16;

/** The largest step in each size band; anything larger is the last band. */
const STEP_EDGES = [5, 20, 60, 150] as const;

/** Bands: no move, then five sizes upward, then the same five downward. */
const STEP_BANDS = 1 + 2 * (STEP_EDGES.length + 1);

/** How much each distribution counts toward the similarity. They sum to 1. */
const WEIGHTS: { readonly [K in keyof Features]: number } = {
  range: 0.2,
  lastDigit: 0.2,
  step: 0.25,
  multiplicity: 0.15,
  exact: 0.2,
};

const CHANNELS = Object.keys(WEIGHTS) as readonly (keyof Features)[];

const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);

function normalised(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, c) => sum + c, 0);
  return total === 0 ? counts.map(() => 0) : counts.map((c) => c / total);
}

function stepBand(delta: number): number {
  if (delta === 0) return 0;
  const size = Math.abs(delta);
  let band = STEP_EDGES.findIndex((edge) => size <= edge);
  if (band === -1) band = STEP_EDGES.length;
  return 1 + band + (delta > 0 ? 0 : STEP_EDGES.length + 1);
}

/** The five distributions of one reply. */
export function featuresOf(numbers: readonly number[]): Features {
  const span = PROBE.max - PROBE.min + 1;
  const range = zeros(RANGE_BANDS);
  const lastDigit = zeros(10);
  const step = zeros(STEP_BANDS);
  const exact = zeros(span);

  let previous: number | null = null;
  for (const value of numbers) {
    const offset = value - PROBE.min;
    range[Math.min(RANGE_BANDS - 1, Math.floor((offset * RANGE_BANDS) / span))]! += 1;
    lastDigit[value % 10]! += 1;
    exact[offset]! += 1;
    if (previous !== null) step[stepBand(value - previous)]! += 1;
    previous = value;
  }

  // Weighted by choices, not by distinct values: a value chosen three times
  // puts three choices in the third band.
  const multiplicity = zeros(4);
  for (const count of exact) {
    if (count > 0) multiplicity[Math.min(count, 4) - 1]! += count;
  }

  return {
    range: normalised(range),
    lastDigit: normalised(lastDigit),
    step: normalised(step),
    multiplicity: normalised(multiplicity),
    exact: normalised(exact),
  };
}

/** The mean of several replies' distributions: what a reference looks like. */
export function pool(all: readonly Features[]): Features | null {
  if (all.length === 0) return null;
  const mean = (channel: keyof Features): number[] => {
    const width = all[0]?.[channel].length ?? 0;
    const sum = zeros(width);
    for (const features of all) {
      for (let i = 0; i < width; i++) sum[i]! += features[channel][i] ?? 0;
    }
    return sum.map((s) => s / all.length);
  };
  return {
    range: mean('range'),
    lastDigit: mean('lastDigit'),
    step: mean('step'),
    multiplicity: mean('multiplicity'),
    exact: mean('exact'),
  };
}

/** How much two distributions share: 1 when they are the same, 0 when they never coincide. */
function overlap(a: readonly number[], b: readonly number[]): number {
  let shared = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) shared += Math.min(a[i] ?? 0, b[i] ?? 0);
  return shared;
}

/** Weighted overlap across the five distributions, 0 to 1. */
export function similarity(a: Features, b: Features): number {
  let total = 0;
  for (const channel of CHANNELS) total += WEIGHTS[channel] * overlap(a[channel], b[channel]);
  return total;
}

/* ---------- References and their thresholds ---------- */

/** A model's recorded replies, by the label they were recorded under. */
export interface ReferenceModel {
  readonly label: string;
  readonly samples: readonly (readonly number[])[];
}

export interface CalibratedReference {
  readonly label: string;
  readonly samples: number;
  /** Generated here rather than recorded. It can be the closest; it never matches. */
  readonly synthetic: boolean;
  readonly pooled: Features | null;
  /** Each sample scored against the rest of its own reference. Empty below `MIN_SAMPLES`. */
  readonly selfScores: readonly number[];
  /** The lowest similarity that counts as a match, or null when it cannot be matched. */
  readonly threshold: number | null;
}

export interface Calibration {
  /** The model the enrolled agent is declared to run, or null when it cannot be told. */
  readonly expected: string | null;
  readonly references: readonly CalibratedReference[];
}

/** The least a threshold sits below the worst self-match seen in calibration. */
const THRESHOLD_SLACK = 0.02;

function deviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** A small deterministic generator, so the baseline is the same on every machine. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** `count` replies drawn uniformly, as a script with a random-number generator would send. */
export function uniformSamples(count: number, seed: number): number[][] {
  const random = mulberry32(seed);
  const span = PROBE.max - PROBE.min + 1;
  return Array.from({ length: count }, () =>
    Array.from({ length: PROBE.count }, () => PROBE.min + Math.floor(random() * span)),
  );
}

const UNIFORM_SEED = 8004;
const UNIFORM_SAMPLES = 24;

function calibrateOne(model: ReferenceModel, synthetic: boolean): CalibratedReference {
  const features = model.samples.map(featuresOf);
  const pooled = pool(features);

  const calibrated = !synthetic && features.length >= MIN_SAMPLES;
  const selfScores = calibrated
    ? features.map((own, index) => {
        const rest = pool(features.filter((_, other) => other !== index));
        return rest ? similarity(own, rest) : 0;
      })
    : [];
  const threshold = calibrated
    ? Math.min(...selfScores) - Math.max(THRESHOLD_SLACK, deviation(selfScores))
    : null;

  return { label: model.label, samples: model.samples.length, synthetic, pooled, selfScores, threshold };
}

/**
 * Work out what each reference looks like and what counts as matching it.
 *
 * `expected` is the model the enrolled agent is declared to run. When it is
 * not given and exactly one model has been recorded, that one is it; with
 * several and none named, nothing can be called a match.
 */
export function calibrate(models: readonly ReferenceModel[], expected: string | null): Calibration {
  const recorded = models.filter((model) => model.label !== UNIFORM_LABEL);
  const references = [
    ...recorded.map((model) => calibrateOne(model, false)),
    calibrateOne({ label: UNIFORM_LABEL, samples: uniformSamples(UNIFORM_SAMPLES, UNIFORM_SEED) }, true),
  ];
  const only = recorded.length === 1 ? (recorded[0]?.label ?? null) : null;
  return { expected: expected ?? only, references };
}

/* ---------- Scoring a reply ---------- */

const round3 = (n: number): number => Math.round(n * 1_000) / 1_000;
const show = (n: number): string => n.toFixed(2);

function view(
  result: ModelSignalResult,
  received: number,
  calibration: Calibration,
  candidates: readonly ModelCandidateView[],
  note: string,
): ModelSignalView {
  const closest = candidates[0] ?? null;
  return {
    result,
    probe: PROBE.id,
    received,
    asked: PROBE.count,
    expectedModel: calibration.expected,
    closest: closest?.label ?? null,
    score: closest?.score ?? null,
    threshold: closest?.threshold ?? null,
    candidates,
    note,
  };
}

/**
 * Compare one reply's integers with every reference that can be compared.
 *
 * A reference below `MIN_SAMPLES` is not compared at all: too few replies to
 * say what it looks like. The uniform baseline always is, so a reply that
 * spreads like a random-number generator is told it resembles one.
 */
export function classify(numbers: readonly number[], calibration: Calibration): ModelSignalView {
  const own = featuresOf(numbers);
  const candidates: ModelCandidateView[] = calibration.references
    .filter((ref) => ref.pooled !== null && (ref.synthetic || ref.threshold !== null))
    .map((ref) => ({
      label: ref.label,
      score: round3(ref.pooled ? similarity(own, ref.pooled) : 0),
      threshold: ref.threshold === null ? null : round3(ref.threshold),
      samples: ref.samples,
      synthetic: ref.synthetic,
    }))
    .sort((a, b) => b.score - a.score);

  const { expected } = calibration;
  if (expected === null) {
    return view(
      'no_reference',
      numbers.length,
      calibration,
      candidates,
      'No model is set as the one this agent runs, so nothing can be called a match.',
    );
  }

  const expectedRef = calibration.references.find((ref) => ref.label === expected);
  if (!expectedRef || expectedRef.threshold === null) {
    return view(
      'no_reference',
      numbers.length,
      calibration,
      candidates,
      `No calibrated reference for ${expected} yet: ${expectedRef?.samples ?? 0} of ${MIN_SAMPLES} samples recorded.`,
    );
  }

  const closest = candidates[0];
  if (!closest) {
    return view('no_reference', numbers.length, calibration, candidates, 'There is no reference to compare with.');
  }

  if (closest.synthetic) {
    return view(
      'unknown',
      numbers.length,
      calibration,
      candidates,
      `Closest to the ${closest.label.toLowerCase()} (${show(closest.score)}), not to any tested model.`,
    );
  }

  if (closest.threshold !== null && closest.score >= closest.threshold) {
    return closest.label === expected
      ? view(
          'match',
          numbers.length,
          calibration,
          candidates,
          `Matches the ${closest.label} reference: ${show(closest.score)}, at or above its calibrated ${show(closest.threshold)}.`,
        )
      : view(
          'other_model',
          numbers.length,
          calibration,
          candidates,
          `Matches the ${closest.label} reference (${show(closest.score)}), not ${expected}, which this agent is declared to run.`,
        );
  }

  return view(
    'unknown',
    numbers.length,
    calibration,
    candidates,
    `No match in the tested reference set: closest is ${closest.label} at ${show(closest.score)}` +
      (closest.threshold === null ? '.' : `, below its calibrated ${show(closest.threshold)}.`),
  );
}

export interface Assessment {
  readonly view: ModelSignalView;
  /** The integers that were scored, or null when the reply could not be read as a batch. */
  readonly numbers: readonly number[] | null;
}

/** Read a reply and score it. The whole of Layer 1's arithmetic for one reply. */
export function assess(reply: string, calibration: Calibration): Assessment {
  const parsed = parseReply(reply);
  if (parsed.kind !== 'numbers') {
    return { view: view(parsed.kind, parsed.received, calibration, [], parsed.reason), numbers: null };
  }
  return { view: classify(parsed.numbers, calibration), numbers: parsed.numbers };
}

/** A reply kept as a reference sample rather than scored: calibration mode's answer. */
export function recordedView(numbers: readonly number[], label: string, calibration: Calibration): ModelSignalView {
  const held = calibration.references.find((ref) => ref.label === label)?.samples ?? 0;
  return view(
    'recorded',
    numbers.length,
    calibration,
    [],
    `Recorded as a reference sample for ${label}: ${held} of ${MIN_SAMPLES} needed. Not scored.`,
  );
}

/* ---------- Checking a calibration against its own samples ---------- */

export interface HeldOutCount {
  readonly label: string;
  readonly samples: number;
  /** How many of this label's samples came out as each result when held out. */
  readonly results: { readonly [R in ModelSignalResult]?: number };
}

/**
 * Hold each recorded sample out, calibrate on the rest, and score it.
 *
 * This is the honest read of a reference bank: how often a model's own reply
 * would match, how often another model's reply would be taken for it, and how
 * often a fresh uniform reply would match anything at all. `calibrate status`
 * prints it; nothing on the payment path calls it.
 */
export function heldOut(models: readonly ReferenceModel[], expected: string | null): HeldOutCount[] {
  const recorded = models.filter((model) => model.label !== UNIFORM_LABEL);
  const tally = (label: string, samples: number, results: readonly ModelSignalResult[]): HeldOutCount => {
    const counts: { [R in ModelSignalResult]?: number } = {};
    for (const result of results) counts[result] = (counts[result] ?? 0) + 1;
    return { label, samples, results: counts };
  };

  const rows = recorded.map((model) =>
    tally(
      model.label,
      model.samples.length,
      model.samples.map((sample, index) => {
        const without = recorded.map((other) =>
          other === model ? { ...other, samples: other.samples.filter((_, i) => i !== index) } : other,
        );
        // Held out against the model it belongs to, so `match` reads as "recognised".
        return classify(sample, { ...calibrate(without, expected), expected: model.label }).result;
      }),
    ),
  );

  // Fresh uniform replies, from a different seed than the baseline itself.
  const full = calibrate(recorded, expected);
  const fresh = uniformSamples(UNIFORM_SAMPLES, UNIFORM_SEED + 1);
  rows.push(tally(UNIFORM_LABEL, fresh.length, fresh.map((sample) => classify(sample, full).result)));
  return rows;
}
