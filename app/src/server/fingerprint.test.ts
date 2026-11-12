/**
 * The numeric model signal's arithmetic.
 *
 * The "models" here are the generators in `habits.ts`: each has a habit a real
 * model might have, and none was measured from one. They exist to show that the
 * arithmetic separates replies that spread differently, that a threshold only
 * ever comes from recorded samples, and that every way of having too little
 * evidence says so instead of matching.
 */

import { describe, expect, test } from 'bun:test';
import {
  assess,
  calibrate,
  classify,
  featuresOf,
  heldOut,
  MAX_RECEIVED,
  MIN_RECEIVED,
  MIN_SAMPLES,
  parseReply,
  PROBE,
  recordedView,
  similarity,
  UNIFORM_LABEL,
  uniformSamples,
  type ReferenceModel,
} from './fingerprint.ts';
import { habitA, habitB, many } from './habits.ts';

const A: ReferenceModel = { label: 'Habit A', samples: many(habitA, 8) };
const B: ReferenceModel = { label: 'Habit B', samples: many(habitB, 8) };
const csv = (numbers: readonly number[]): string => numbers.join(', ');

/* ---------- Reading a reply ---------- */

describe('reading a reply', () => {
  test('commas, spaces, new lines and one pair of brackets all read as a list', () => {
    const numbers = habitA(99);
    for (const text of [csv(numbers), numbers.join(','), numbers.join('\n'), `[${csv(numbers)}]`, `${csv(numbers)}.`]) {
      const parsed = parseReply(text);
      expect(parsed.kind).toBe('numbers');
      if (parsed.kind === 'numbers') expect(parsed.numbers).toEqual(numbers);
    }
  });

  test('a word, a decimal or a number outside the range makes it invalid, without repeating the text', () => {
    const numbers = habitA(99);
    const withWord = parseReply(`${csv(numbers.slice(0, 10))}, <script>alert(1)</script>, 12`);
    expect(withWord.kind).toBe('invalid');
    if (withWord.kind === 'invalid') {
      expect(withWord.reason).toBe('Item 11 is not an integer.');
      expect(withWord.received).toBe(10);
    }

    expect(parseReply(`${csv(numbers.slice(0, 5))}, 3.5`).kind).toBe('invalid');
    expect(parseReply(`${csv(numbers.slice(0, 5))}, -4`).kind).toBe('invalid');

    const outside = parseReply(csv([...numbers.slice(0, 293), PROBE.max + 1]));
    expect(outside).toEqual({
      kind: 'invalid',
      received: 293,
      reason: `Item 294 (${PROBE.max + 1}) is outside 1 through 355.`,
    });
    expect(parseReply(csv([0, ...numbers.slice(1)])).kind).toBe('invalid');
    expect(parseReply('   ').kind).toBe('invalid');
  });

  test('within a tenth of what was asked is scored; fewer is insufficient, more is invalid', () => {
    const numbers = habitA(99);
    expect(MIN_RECEIVED).toBe(265);
    expect(MAX_RECEIVED).toBe(323);

    expect(parseReply(csv(numbers.slice(0, MIN_RECEIVED))).kind).toBe('numbers');
    const short = parseReply(csv(numbers.slice(0, MIN_RECEIVED - 1)));
    expect(short.kind).toBe('insufficient');
    if (short.kind === 'insufficient') expect(short.received).toBe(264);

    const long = [...numbers, ...numbers.slice(0, MAX_RECEIVED - PROBE.count)];
    expect(parseReply(csv(long)).kind).toBe('numbers');
    expect(parseReply(csv([...long, 7])).kind).toBe('invalid');
  });

  test('a reply too long to be a list of integers is not read at all', () => {
    const parsed = parseReply('1,'.repeat(4_000));
    expect(parsed.kind).toBe('invalid');
    if (parsed.kind === 'invalid') expect(parsed.received).toBe(0);
  });
});

/* ---------- The arithmetic ---------- */

describe('the five distributions', () => {
  test('each sums to 1, and a reply is fully similar to itself', () => {
    const features = featuresOf(habitA(3));
    for (const channel of Object.values(features)) {
      expect(channel.reduce((sum: number, p: number) => sum + p, 0)).toBeCloseTo(1, 9);
    }
    expect(similarity(features, features)).toBeCloseTo(1, 9);
  });

  test('replies with the same habit are more alike than replies with different ones', () => {
    const a1 = featuresOf(habitA(1));
    const a2 = featuresOf(habitA(2));
    const b1 = featuresOf(habitB(1));
    expect(similarity(a1, a2)).toBeGreaterThan(similarity(a1, b1) + 0.1);
  });
});

/* ---------- Thresholds come from samples ---------- */

describe('calibration', () => {
  test('below the minimum there is no threshold, and nothing matches', () => {
    const thin = calibrate([{ label: 'Habit A', samples: many(habitA, MIN_SAMPLES - 1) }], null);
    const ref = thin.references.find((r) => r.label === 'Habit A');
    expect(ref?.threshold).toBeNull();
    expect(ref?.selfScores).toEqual([]);

    const signal = classify(habitA(500), thin);
    expect(signal.result).toBe('no_reference');
    expect(signal.note).toBe(`No calibrated reference for Habit A yet: ${MIN_SAMPLES - 1} of ${MIN_SAMPLES} samples recorded.`);
  });

  test('an empty bank matches nothing: there is only the uniform baseline', () => {
    const empty = calibrate([], null);
    expect(empty.expected).toBeNull();
    expect(empty.references.map((r) => r.label)).toEqual([UNIFORM_LABEL]);
    expect(classify(habitA(500), empty).result).toBe('no_reference');
  });

  test('the threshold sits below every sample’s own score against the rest', () => {
    const { references } = calibrate([A], null);
    const ref = references.find((r) => r.label === 'Habit A');
    expect(ref?.selfScores).toHaveLength(8);
    expect(ref?.threshold).not.toBeNull();
    expect(ref?.threshold ?? 1).toBeLessThan(Math.min(...(ref?.selfScores ?? [])));
  });

  test('the uniform baseline is generated, always compared, and can never be matched', () => {
    const { references } = calibrate([A], null);
    const baseline = references.find((r) => r.label === UNIFORM_LABEL);
    expect(baseline?.synthetic).toBe(true);
    expect(baseline?.threshold).toBeNull();
    // A recorded model cannot take the baseline's place by borrowing its name.
    const spoofed = calibrate([{ label: UNIFORM_LABEL, samples: many(habitA, 8) }], null);
    expect(spoofed.references).toHaveLength(1);
    expect(spoofed.references[0]?.synthetic).toBe(true);
  });

  test('with one recorded model it is the expected one; with several, one has to be named', () => {
    expect(calibrate([A], null).expected).toBe('Habit A');
    expect(calibrate([A, B], null).expected).toBeNull();
    expect(calibrate([A, B], 'Habit B').expected).toBe('Habit B');
    expect(classify(habitA(500), calibrate([A, B], null)).result).toBe('no_reference');
  });
});

/* ---------- The results ---------- */

describe('scoring a reply', () => {
  const calibration = calibrate([A, B], 'Habit A');

  test('a fresh reply with the expected habit matches, and says against what', () => {
    for (const seed of [500, 501, 502, 503]) {
      const signal = classify(habitA(seed), calibration);
      expect(signal.result).toBe('match');
      expect(signal.closest).toBe('Habit A');
      expect(signal.score ?? 0).toBeGreaterThanOrEqual(signal.threshold ?? 1);
      expect(signal.received).toBe(PROBE.count);
      expect(signal.asked).toBe(PROBE.count);
      expect(signal.probe).toBe(PROBE.id);
    }
  });

  test('a reply that matches a different tested model is named as that model, and is not a match', () => {
    const signal = classify(habitB(500), calibration);
    expect(signal.result).toBe('other_model');
    expect(signal.closest).toBe('Habit B');
    expect(signal.note).toContain('not Habit A');
  });

  test('uniform random integers resemble the baseline and match nothing', () => {
    for (const reply of uniformSamples(6, 4242)) {
      const signal = classify(reply, calibration);
      expect(signal.result).toBe('unknown');
      expect(signal.closest).toBe(UNIFORM_LABEL);
    }
  });

  test('every candidate compared is listed, closest first', () => {
    const signal = classify(habitA(500), calibration);
    expect(signal.candidates.map((c) => c.label).sort()).toEqual(['Habit A', 'Habit B', UNIFORM_LABEL].sort());
    const scores = signal.candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test('a reference with too few samples is not compared at all', () => {
    const thinB = calibrate([A, { label: 'Habit B', samples: many(habitB, 2) }], 'Habit A');
    const signal = classify(habitB(500), thinB);
    expect(signal.candidates.map((c) => c.label)).not.toContain('Habit B');
    expect(signal.result).not.toBe('match');
  });

  test('a short or malformed reply is not scored: it stays without a candidate', () => {
    const short = assess(csv(habitA(500).slice(0, 100)), calibration);
    expect(short.numbers).toBeNull();
    expect(short.view.result).toBe('insufficient');
    expect(short.view.received).toBe(100);
    expect(short.view.closest).toBeNull();
    expect(short.view.candidates).toEqual([]);

    const malformed = assess('seven, eight, nine', calibration);
    expect(malformed.view.result).toBe('invalid');
    expect(malformed.numbers).toBeNull();
  });

  test('a reply kept for calibration is recorded, not scored', () => {
    const signal = recordedView(habitA(500), 'Habit A', calibration);
    expect(signal.result).toBe('recorded');
    expect(signal.candidates).toEqual([]);
    expect(signal.note).toContain('8 of 5');
  });
});

/* ---------- Reading a bank honestly ---------- */

describe('holding samples out', () => {
  test('each habit’s own samples are recognised, and fresh uniform replies match nothing', () => {
    const rows = heldOut([A, B], 'Habit A');
    const row = (label: string) => rows.find((r) => r.label === label);

    expect(row('Habit A')?.results.match).toBe(8);
    // The looser habit shows what the report is for: a sample held out can fall
    // just under a threshold the other seven set. It is then unknown — never
    // taken for the other habit.
    expect(row('Habit B')?.results.match ?? 0).toBeGreaterThanOrEqual(7);
    expect(row('Habit B')?.results.other_model ?? 0).toBe(0);
    const uniform = row(UNIFORM_LABEL);
    expect(uniform?.results.match ?? 0).toBe(0);
    expect(uniform?.results.other_model ?? 0).toBe(0);
  });

  test('a reference at exactly the minimum cannot be held out: one fewer is uncalibrated', () => {
    const rows = heldOut([{ label: 'Habit A', samples: many(habitA, MIN_SAMPLES) }], null);
    expect(rows.find((r) => r.label === 'Habit A')?.results.no_reference).toBe(MIN_SAMPLES);
  });
});
