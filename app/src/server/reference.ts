/**
 * The reference bank: the recorded replies a live reply is compared with.
 *
 * One JSON file, so a team can read it, diff it and commit it. It starts empty
 * and stays honest by construction: the only way a sample gets in is a real
 * reply being recorded — through calibration mode on the connector, or
 * `bun run calibrate add`. Nothing in the repository writes a reply by hand.
 *
 * `expected` names the model the enrolled agent is declared to run. A live
 * reply only counts as a match when it matches *that* reference.
 *
 * The arithmetic is in `fingerprint.ts`. This file only reads and writes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  calibrate,
  MIN_SAMPLES,
  PROBE,
  UNIFORM_LABEL,
  type Calibration,
  type ReferenceModel,
} from './fingerprint.ts';

export const DEFAULT_REFERENCE_PATH = 'reference/numeric-294-355.json';

export interface BankSample {
  readonly recordedAt: string;
  /** Where it came from: a live run's id, or a file somebody added. */
  readonly source: string;
  readonly numbers: readonly number[];
}

export interface BankModel {
  readonly label: string;
  readonly samples: readonly BankSample[];
}

export interface ReferenceBank {
  /** The probe these replies answered. Samples for another probe are not comparable. */
  readonly probe: string;
  readonly expected: string | null;
  readonly models: readonly BankModel[];
}

export const EMPTY_BANK: ReferenceBank = { probe: PROBE.id, expected: null, models: [] };

/** How far calibration has got for the model the agent is declared to run. */
export interface ReferenceStatus {
  readonly expected: string | null;
  readonly samples: number;
  readonly needed: number;
  readonly calibrated: boolean;
}

export interface ReferenceStore {
  bank(): ReferenceBank;
  calibration(): Calibration;
  status(): ReferenceStatus;
  /** Keep one more recorded reply under a label. The first label recorded becomes the expected one. */
  record(label: string, numbers: readonly number[], source: string): void;
  /** Name the model the enrolled agent is declared to run. */
  expect(label: string | null): void;
}

/* ---------- Reading a bank ---------- */

const isIntegerList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every((n) => Number.isInteger(n) && (n as number) >= PROBE.min && (n as number) <= PROBE.max);

/**
 * Read a bank from parsed JSON, keeping only what is well formed.
 *
 * A bank written for a different probe is refused outright rather than read as
 * if it were comparable: its samples answer a different question.
 */
export function parseBank(raw: unknown): ReferenceBank {
  if (typeof raw !== 'object' || raw === null) throw new Error('the reference bank is not a JSON object');
  const { probe, expected, models } = raw as { probe?: unknown; expected?: unknown; models?: unknown };
  if (probe !== PROBE.id) {
    throw new Error(`the reference bank is for probe "${String(probe)}", not "${PROBE.id}"`);
  }
  if (!Array.isArray(models)) throw new Error('the reference bank has no list of models');

  const read: BankModel[] = [];
  for (const model of models as { label?: unknown; samples?: unknown }[]) {
    if (typeof model?.label !== 'string' || model.label.trim() === '' || model.label === UNIFORM_LABEL) continue;
    const samples = (Array.isArray(model.samples) ? model.samples : []).flatMap(
      (sample: { recordedAt?: unknown; source?: unknown; numbers?: unknown }): BankSample[] =>
        isIntegerList(sample?.numbers)
          ? [
              {
                recordedAt: typeof sample.recordedAt === 'string' ? sample.recordedAt : '',
                source: typeof sample.source === 'string' ? sample.source : 'unknown',
                numbers: sample.numbers,
              },
            ]
          : [],
    );
    read.push({ label: model.label, samples });
  }

  return { probe: PROBE.id, expected: typeof expected === 'string' && expected !== '' ? expected : null, models: read };
}

const asModels = (bank: ReferenceBank): ReferenceModel[] =>
  bank.models.map((model) => ({ label: model.label, samples: model.samples.map((sample) => sample.numbers) }));

/** A bank with one more sample. Pure: the caller decides whether to save it. */
export function withSample(
  bank: ReferenceBank,
  label: string,
  numbers: readonly number[],
  source: string,
  recordedAt: string,
): ReferenceBank {
  const name = label.trim();
  if (name === '' || name === UNIFORM_LABEL) throw new Error(`"${label}" cannot be used as a reference label`);
  if (!isIntegerList(numbers)) throw new Error('a reference sample must be integers inside the probe’s range');

  const sample: BankSample = { recordedAt, source, numbers: [...numbers] };
  const known = bank.models.some((model) => model.label === name);
  return {
    probe: bank.probe,
    expected: bank.expected ?? name,
    models: known
      ? bank.models.map((model) => (model.label === name ? { ...model, samples: [...model.samples, sample] } : model))
      : [...bank.models, { label: name, samples: [sample] }],
  };
}

/* ---------- Stores ---------- */

function storeOver(initial: ReferenceBank, save: (bank: ReferenceBank) => void): ReferenceStore {
  let bank = initial;
  let cached: Calibration | null = null;

  const set = (next: ReferenceBank): void => {
    bank = next;
    cached = null;
    save(next);
  };
  const calibration = (): Calibration => (cached ??= calibrate(asModels(bank), bank.expected));

  return {
    bank: () => bank,
    calibration,
    status() {
      const { expected, references } = calibration();
      const ref = expected === null ? undefined : references.find((r) => r.label === expected);
      return {
        expected,
        samples: ref?.samples ?? 0,
        needed: MIN_SAMPLES,
        calibrated: ref !== undefined && ref.threshold !== null,
      };
    },
    record(label, numbers, source) {
      set(withSample(bank, label, numbers, source, new Date().toISOString()));
    },
    expect(label) {
      if (label !== null && !bank.models.some((model) => model.label === label)) {
        throw new Error(`there is no reference labelled "${label}"`);
      }
      set({ ...bank, expected: label });
    },
  };
}

/** A bank held in memory. For tests, and for a server told not to keep one. */
export function memoryReference(bank: ReferenceBank = EMPTY_BANK): ReferenceStore {
  return storeOver(bank, () => {});
}

/** The bank as text: indented, with each reply's integers on one line so a diff shows one sample per line. */
export function formatBank(bank: ReferenceBank): string {
  const indented = JSON.stringify(bank, null, 2);
  return `${indented.replace(/\[\s*\d[\d,\s]*\]/g, (list) => list.replace(/\s+/g, '').replace(/,/g, ', '))}\n`;
}

/** The bank on disk. A file that does not exist yet is an empty bank; one that is malformed is an error. */
export function fileReference(path: string = DEFAULT_REFERENCE_PATH): ReferenceStore {
  const initial = existsSync(path) ? parseBank(JSON.parse(readFileSync(path, 'utf8'))) : EMPTY_BANK;
  return storeOver(initial, (bank) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, formatBank(bank), 'utf8');
  });
}
