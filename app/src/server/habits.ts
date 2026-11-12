/**
 * Stand-in "models" for tests and rehearsals. **Not measurements.**
 *
 * Each function writes a reply with a habit a real model might have, from a
 * seed, so a test can ask for "another reply with the same habit". None of them
 * was recorded from any model, and nothing here is ever written into the
 * reference bank the live flow reads: tests build banks in memory, and the
 * rehearsal script keeps its bank in a scratch folder and says so.
 *
 * They exist to show that the arithmetic separates replies that spread
 * differently, and to let the whole flow be driven end to end without an agent
 * platform. What a real model does is for calibration with real replies to say.
 */

import { PROBE } from './fingerprint.ts';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** Spreads across the whole range, alternates low and high, likes a final 3 or 7, and avoids repeats. */
export function habitA(seed: number): number[] {
  const r = random(seed);
  const out: number[] = [];
  const used = new Set<number>();
  while (out.length < PROBE.count) {
    let value = (out.length % 2 === 0 ? 178 : 1) + Math.floor(r() * 177);
    if (r() < 0.6) value = value - (value % 10) + (r() < 0.5 ? 3 : 7);
    value = Math.min(PROBE.max, Math.max(PROBE.min, value));
    if (used.has(value) && r() < 0.9) continue;
    used.add(value);
    out.push(value);
  }
  return out;
}

/** Stays low, wanders in small steps, rounds to fives, and repeats freely. */
export function habitB(seed: number): number[] {
  const r = random(seed);
  const out: number[] = [];
  let value = 40;
  while (out.length < PROBE.count) {
    value += Math.floor((r() - 0.5) * 40);
    value = Math.min(200, Math.max(PROBE.min, value));
    out.push(r() < 0.5 ? Math.max(5, Math.round(value / 5) * 5) : value);
  }
  return out;
}

/** `count` replies with one habit, from consecutive seeds. */
export const many = (make: (seed: number) => number[], count: number, from = 1): number[][] =>
  Array.from({ length: count }, (_, i) => make(from + i));
