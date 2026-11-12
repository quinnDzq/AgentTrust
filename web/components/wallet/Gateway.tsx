import type { AgentKey } from '@app/types.ts';
import type { CSSProperties, RefObject } from 'react';
import {
  LAYER_SHORT,
  LAYER_TITLE,
  layerLine,
  layerMark,
  money,
  type Layer,
  type LayerMark,
  type Outcome,
  type TemplateRequest,
  type WalletRound,
} from '@/lib/wallet-template';
import { Sprite } from '../Sprite';
import { Glyph, type GlyphName } from './PixelArt';

const LAYERS: readonly Layer[] = [1, 2, 3];

/** Which of the Studio's crew stands at each layer. */
const KEEPER: { readonly [L in Layer]: { readonly who: AgentKey; readonly name: string } } = {
  1: { who: 'mochi', name: 'Mochi' },
  2: { who: 'shield', name: 'Shield' },
  3: { who: 'tally', name: 'Tally' },
};

/* ---------- The step lamps ---------- */

/** A lamp before its layer has run, while it runs, and after. */
export type LampState = 'idle' | 'active' | LayerMark;

const LAMP_WORD: { readonly [S in LampState]: string } = {
  idle: 'waiting',
  active: 'checking now',
  noted: 'noted',
  pass: 'passed',
  fail: 'failed',
  skipped: 'skipped',
};

/**
 * Where the request is: the gate's three lamps, the same ones on the Studio's
 * back wall. One lights amber while its layer runs, then holds what the layer
 * found. A layer the request never reached is hatched, not dark, so "skipped"
 * cannot be mistaken for "not yet".
 */
export function StepLamps({ states }: { readonly states: { readonly [L in Layer]: LampState } }) {
  return (
    <ol className="wt-steps" aria-label="Verification layers">
      {LAYERS.map((layer) => {
        const state = states[layer];
        return (
          <li key={layer} className="wt-step" data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
            <i className="wt-lamp" data-state={state} aria-hidden="true" />
            <span className="wt-step-text">
              <span className="wt-step-n">Layer {layer}</span>
              <span className="wt-step-name">
                <span className="wt-step-long">{LAYER_TITLE[layer]}</span>
                <span className="wt-step-short">{LAYER_SHORT[layer]}</span>
              </span>
            </span>
            <span className="sr-only">{LAMP_WORD[state]}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The lamps for a request that is at `active`, has finished, or has not been sent. */
export function lampStates(
  outcome: Outcome | null,
  at: { readonly layer: Layer; readonly beat: 'working' | 'verdict' } | 'decided' | 'ready',
): { readonly [L in Layer]: LampState } {
  const state = (layer: Layer): LampState => {
    if (!outcome || at === 'ready') return 'idle';
    if (at === 'decided') return layerMark(outcome, layer);
    if (layer < at.layer) return layerMark(outcome, layer);
    if (layer > at.layer) return 'idle';
    return at.beat === 'working' ? 'active' : layerMark(outcome, layer);
  };
  return { 1: state(1), 2: state(2), 3: state(3) };
}

/* ---------- The gateway window ---------- */

export type Scene =
  | { readonly kind: 'idle' }
  | { readonly kind: 'layer'; readonly layer: Layer; readonly beat: 'working' | 'verdict' }
  | { readonly kind: 'decision' };

const WORKING_LINE: { readonly [L in Layer]: string } = {
  1: 'Reading the model signal…',
  2: 'Checking the signature against the registered key…',
  3: 'Comparing the amount with what is left…',
};

const MARK_GLYPH: { readonly [M in LayerMark]: GlyphName } = {
  noted: 'check',
  pass: 'check',
  fail: 'cross',
  skipped: 'dash',
};

/** A two- or three-word verdict for under a keeper in the line-up. */
function verdictWord(outcome: Outcome, layer: Layer): string {
  switch (layer) {
    case 1:
      return `${outcome.modelProfile} profile`;
    case 2:
      return outcome.key.matches ? 'Key matches' : 'Key mismatch';
    case 3:
      return outcome.authorization === null ? 'Skipped' : outcome.authorization.fits ? 'Fits the budget' : 'Over budget';
    default: {
      const unreachable: never = layer;
      throw new Error(`no layer ${String(unreachable)}`);
    }
  }
}

/** The simulated Layer 1 profile, as a fixed shape on the scope. Decoration for a simulated signal, and labelled so. */
const PROFILE_SHAPE = [5, 9, 13, 8, 15, 11, 7, 14, 10, 6, 12, 9, 13, 7] as const;

function SignalScope({ settled, profile }: { readonly settled: boolean; readonly profile: string }) {
  return (
    <div className="wt-instrument wt-scope" data-settled={settled ? 'yes' : 'no'}>
      <div className="wt-scope-bars" aria-hidden="true">
        {PROFILE_SHAPE.map((height, i) => (
          <i key={i} style={{ '--h': height, '--i': i } as CSSProperties} />
        ))}
      </div>
      <p className="wt-scope-name">
        {settled ? (
          <>
            <strong>{profile} profile</strong>
            <span className="wt-chip wt-chip-sim">Simulated</span>
            <span className="wt-chip wt-chip-advisory">Advisory</span>
          </>
        ) : (
          <span className="wt-quiet">Listening</span>
        )}
      </p>
    </div>
  );
}

/** One key's fingerprint as sixteen teeth, a tooth per hex digit, so two keys can be compared at a glance. */
function KeyTeeth({
  label,
  print,
  against,
  settled,
}: {
  readonly label: string;
  readonly print: string;
  /** The fingerprint to compare with; a tooth is marked by whether its digit is the same. */
  readonly against: string;
  readonly settled: boolean;
}) {
  const digits = [...print];
  return (
    <div className="wt-key">
      <span className="wt-key-label">{label}</span>
      <span className="wt-teeth" aria-hidden="true">
        {digits.map((digit, i) => (
          <i
            key={i}
            data-same={settled ? (digit === against[i] ? 'yes' : 'no') : undefined}
            style={{ '--h': Number.parseInt(digit, 16), '--i': i } as CSSProperties}
          />
        ))}
      </span>
      <code className="wt-key-print">
        {print.slice(0, 4)} {print.slice(4, 8)} {print.slice(8, 12)} {print.slice(12, 16)}
      </code>
    </div>
  );
}

function KeyBench({ outcome, settled }: { readonly outcome: Outcome; readonly settled: boolean }) {
  return (
    <div className="wt-instrument wt-bench" data-settled={settled ? 'yes' : 'no'}>
      <KeyTeeth label="Registered" print={outcome.key.registered} against={outcome.key.presented} settled={settled} />
      <KeyTeeth label="Signed with" print={outcome.key.presented} against={outcome.key.registered} settled={settled} />
    </div>
  );
}

function BudgetScale({
  outcome,
  request,
  round,
  settled,
}: {
  readonly outcome: Outcome;
  readonly request: TemplateRequest;
  readonly round: WalletRound;
  readonly settled: boolean;
}) {
  const auth = outcome.authorization;
  if (!auth) return null;
  // Both bars share one scale: the round's starting budget. A draw is always
  // under half of it, so neither bar can run off the end.
  const share = (units: number): string => `${Math.max(0, Math.min(100, (units / round.startingAmount) * 100)).toFixed(2)}%`;
  return (
    <div
      className="wt-instrument wt-scale"
      data-settled={settled ? 'yes' : 'no'}
      data-fits={auth.fits ? 'yes' : 'no'}
      style={{ '--left': share(auth.remainingBefore), '--ask': share(request.amount) } as CSSProperties}
    >
      <div className="wt-scale-row">
        <span className="wt-scale-label">Left</span>
        <span className="wt-scale-track">
          <i className="wt-scale-bar wt-scale-left" />
        </span>
        <span className="wt-scale-value">{money(auth.remainingBefore, round.currency)}</span>
      </div>
      <div className="wt-scale-row">
        <span className="wt-scale-label">Request</span>
        <span className="wt-scale-track">
          <i className="wt-scale-bar wt-scale-ask" />
          <i className="wt-scale-limit" aria-hidden="true" />
        </span>
        <span className="wt-scale-value">{money(request.amount, round.currency)}</span>
      </div>
      <p className="wt-scale-after">
        {settled
          ? auth.fits
            ? `Leaves ${money(auth.remainingAfter, round.currency)}.`
            : `Over by ${money(auth.overBy, round.currency)}.`
          : ' '}
      </p>
    </div>
  );
}

/** The three keepers at their posts: lamps dark before a request, lit with what each found after one. */
function LineUp({ outcome }: { readonly outcome: Outcome | null }) {
  return (
    <ol className="wt-lineup">
      {LAYERS.map((layer) => {
        const mark = outcome ? layerMark(outcome, layer) : null;
        return (
          <li key={layer} data-mark={mark ?? 'idle'}>
            <i className="wt-lamp" data-state={mark ?? 'idle'} aria-hidden="true" />
            <Sprite who={KEEPER[layer].who} size={48} decorative />
            <span className="wt-lineup-title">{LAYER_TITLE[layer]}</span>
            <span className="wt-lineup-word">{outcome ? verdictWord(outcome, layer) : `Layer ${layer}`}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Inside the gateway. A dark screen in a page of paper: the one place the
 * crew works, and it only ever shows one thing.
 *
 * Before a request it is the line-up, three keepers under dark lamps. While a
 * request is checked, the layer it is at takes the whole window — its keeper,
 * its instrument, and one line saying what it is doing and then what it
 * found. After the decision it is the line-up again, lamps lit.
 *
 * Every scene replays the `outcome` already computed for the request. Nothing
 * here decides, and nothing is drawn that the checks did not find — except
 * Layer 1's signal, which is simulated and says so.
 */
export function GatewayWindow({
  scene,
  outcome,
  request,
  round,
  windowRef,
}: {
  readonly scene: Scene;
  readonly windowRef?: RefObject<HTMLElement | null>;
  readonly outcome: Outcome | null;
  readonly request: TemplateRequest | null;
  readonly round: WalletRound | null;
}) {
  if (scene.kind === 'layer' && outcome && request && round) {
    const { layer, beat } = scene;
    const settled = beat === 'verdict';
    const mark = layerMark(outcome, layer);
    const keeper = KEEPER[layer];
    return (
      <section
        ref={windowRef}
        tabIndex={-1}
        className="wt-window"
        data-scene="layer"
        data-layer={layer}
        aria-labelledby="wt-layer-title"
      >
        <div className="wt-scene" key={`layer-${layer}`}>
          <header className="wt-scene-head">
            <span className="wt-scene-n">Layer {layer} of 3</span>
            <h2 id="wt-layer-title">{LAYER_TITLE[layer]}</h2>
            {settled ? (
              <span className="wt-badge" data-mark={mark}>
                <Glyph name={MARK_GLYPH[mark]} size={16} />
              </span>
            ) : (
              <span className="wt-badge wt-badge-working" aria-hidden="true" />
            )}
          </header>

          <div className="wt-scene-stage">
            <Sprite who={keeper.who} size={80} decorative className="wt-keeper" />
            {layer === 1 ? <SignalScope settled={settled} profile={outcome.modelProfile} /> : null}
            {layer === 2 ? <KeyBench outcome={outcome} settled={settled} /> : null}
            {layer === 3 ? <BudgetScale outcome={outcome} request={request} round={round} settled={settled} /> : null}
          </div>

          <p className="wt-say" data-mark={settled ? mark : 'working'}>
            <span className="wt-say-who">{keeper.name}</span>
            <span className="wt-say-line" key={beat}>
              {settled ? layerLine(outcome, layer, request, round.currency) : WORKING_LINE[layer]}
              {settled && layer === 1 ? ' The profile is simulated and advisory.' : ''}
            </span>
          </p>
        </div>
      </section>
    );
  }

  const decided = scene.kind === 'decision' && outcome !== null;
  return (
    <section
      className="wt-window"
      data-scene={decided ? 'decision' : 'idle'}
      data-approved={decided ? (outcome.approved ? 'yes' : 'no') : undefined}
      aria-label="Inside the gateway"
    >
      <div className="wt-scene" key={decided ? 'decision' : 'idle'}>
        <header className="wt-scene-head">
          <span className="wt-scene-n">{decided ? 'Decision' : 'Inside the gateway'}</span>
          <h2>{decided ? (outcome.approved ? 'Gate open' : 'Gate shut') : 'Three checks, in order'}</h2>
        </header>
        <LineUp outcome={decided ? outcome : null} />
        <p className="wt-say" data-mark={decided ? (outcome.approved ? 'pass' : 'fail') : 'idle'}>
          <span className="wt-say-line">
            {decided
              ? outcome.approved
                ? 'The key matched and the amount fit the budget.'
                : outcome.stoppedAt === 2
                  ? 'Stopped at Layer 2. Layer 3 was skipped.'
                  : 'Stopped at Layer 3.'
              : 'A request stops at the first check that refuses it.'}
          </span>
        </p>
      </div>
    </section>
  );
}
