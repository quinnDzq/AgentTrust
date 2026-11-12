/**
 * bun run calibrate — read and build the reference bank for the numeric model signal.
 *
 *   bun run calibrate                       what is recorded, each reference's threshold, and the held-out check
 *   bun run calibrate add "<label>" [file]  record one real reply under a label (from a file, or pasted on stdin)
 *   bun run calibrate expect "<label>"      name the model the enrolled agent is declared to run
 *   bun run calibrate score [file]          score a reply against the bank without recording it
 *
 * The bank only ever holds replies somebody actually got from a model. The
 * quickest way to record the agent's own is calibration mode: start the server
 * with AGENTTRUST_CALIBRATE_AS="<label>" and ask the agent platform to run the
 * challenge; each readable reply is kept as a sample and nothing is scored or
 * signed. Other models' replies go in with `add`.
 *
 * The held-out check is the honest read of a bank: every recorded reply is
 * left out in turn, the rest are calibrated without it, and it is scored. It
 * needs one more sample than the minimum, because holding one out of exactly
 * the minimum leaves too few to calibrate.
 */

import { readFileSync } from 'node:fs';
import {
  assess,
  heldOut,
  MIN_SAMPLES,
  parseReply,
  PROBE,
  PROBE_PROMPT,
  UNIFORM_LABEL,
  type ReferenceModel,
} from '../src/server/fingerprint.ts';
import { DEFAULT_REFERENCE_PATH, fileReference } from '../src/server/reference.ts';

const path = process.env.AGENTTRUST_REFERENCE_PATH?.trim() || DEFAULT_REFERENCE_PATH;
const [command = 'status', ...args] = process.argv.slice(2);

const two = (n: number): string => n.toFixed(2);

async function replyFrom(file: string | undefined): Promise<string> {
  if (file) return readFileSync(file, 'utf8');
  if (process.stdin.isTTY) console.error('Paste the reply, then press Ctrl-D:');
  return await Bun.stdin.text();
}

function status(): void {
  const store = fileReference(path);
  const bank = store.bank();
  const calibration = store.calibration();

  console.log(`Reference bank: ${path}`);
  console.log(`Probe: ${PROBE.id}\n  "${PROBE_PROMPT}"`);
  console.log(`Expected model (what the enrolled agent is declared to run): ${calibration.expected ?? 'not set'}\n`);

  if (bank.models.length === 0) {
    console.log('No replies recorded yet. Until there are, no live reply can match: every run stays at Layer 1.');
    console.log('Record the agent’s own with AGENTTRUST_CALIBRATE_AS="<label>" on the server, or `bun run calibrate add`.');
    return;
  }

  console.log('Reference                         samples  threshold  self-similarity (each sample against the rest)');
  for (const ref of calibration.references) {
    const self =
      ref.selfScores.length > 0
        ? `${two(Math.min(...ref.selfScores))}–${two(Math.max(...ref.selfScores))}`
        : ref.synthetic
          ? 'generated baseline, never matched'
          : `needs ${MIN_SAMPLES - ref.samples} more`;
    console.log(
      `${ref.label.padEnd(33)} ${String(ref.samples).padStart(7)}  ${(ref.threshold === null ? '—' : two(ref.threshold)).padStart(9)}  ${self}`,
    );
  }

  const models: ReferenceModel[] = bank.models.map((m) => ({ label: m.label, samples: m.samples.map((s) => s.numbers) }));
  console.log('\nHeld-out check (each recorded reply scored against a bank calibrated without it):');
  for (const row of heldOut(models, bank.expected)) {
    const parts = Object.entries(row.results)
      .map(([result, count]) => `${count} ${result}`)
      .join(', ');
    const meaning =
      row.label === UNIFORM_LABEL
        ? 'fresh uniform random replies; a match here would be a false accept'
        : 'match = recognised as itself, other_model = taken for another, unknown = missed';
    console.log(`  ${row.label.padEnd(31)} ${parts || 'no samples'}   (${meaning})`);
  }
  console.log(
    '\nA reference that is no_reference when held out has exactly the minimum: record one more to see how it holds.',
  );
}

async function add(): Promise<void> {
  const [label, file] = args;
  if (!label) throw new Error('usage: bun run calibrate add "<label>" [file]');
  const parsed = parseReply(await replyFrom(file));
  if (parsed.kind !== 'numbers') throw new Error(`Not recorded. ${parsed.reason}`);

  const store = fileReference(path);
  store.record(label, parsed.numbers, file ? `file:${file}` : 'stdin');
  const held = store.bank().models.find((m) => m.label === label)?.samples.length ?? 0;
  console.log(`Recorded ${parsed.numbers.length} integers as a sample for "${label}": ${held} of ${MIN_SAMPLES} needed.`);
  console.log(`Expected model: ${store.status().expected ?? 'not set'}. Run \`bun run calibrate\` to see the thresholds.`);
}

function expectModel(): void {
  const [label] = args;
  if (!label) throw new Error('usage: bun run calibrate expect "<label>"');
  const store = fileReference(path);
  store.expect(label);
  console.log(`The enrolled agent is now declared to run "${label}". Only a match to that reference passes Layer 1.`);
}

async function score(): Promise<void> {
  const assessed = assess(await replyFrom(args[0]), fileReference(path).calibration());
  const { view } = assessed;
  console.log(`${view.result.toUpperCase()} · ${view.received} of ${view.asked} integers received`);
  console.log(view.note);
  for (const candidate of view.candidates) {
    console.log(
      `  ${candidate.label.padEnd(31)} similarity ${two(candidate.score)}` +
        (candidate.threshold === null ? '' : ` · threshold ${two(candidate.threshold)}`),
    );
  }
}

try {
  switch (command) {
    case 'status':
      status();
      break;
    case 'add':
      await add();
      break;
    case 'expect':
      expectModel();
      break;
    case 'score':
      await score();
      break;
    default:
      throw new Error(`unknown command "${command}". Try: status, add, expect, score`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
