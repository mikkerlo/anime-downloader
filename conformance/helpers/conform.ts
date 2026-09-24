// Run one scenario against both backends and report the difference.
//
// The real server runs first and the model second, in the same process, one
// after the other rather than concurrently: both are wall-clock-driven, and
// interleaving them would make each one's scheduling jitter the other's.

import { runAgainstModel, runAgainstReal, type Scenario } from './scenario'
import {
  POSITION_TOLERANCE_PAUSED_S,
  POSITION_TOLERANCE_PLAYING_S,
  diffTraces,
  formatDivergences,
  maxPositionDelta,
  type Divergence
} from './trace-diff'

export interface ConformanceRun {
  divergences: Divergence[]
  tolerance: number
  /**
   * The largest sampled |real − model| position this scenario produced, or
   * `null` if it sampled no positions. The tolerance constants are justified by
   * these numbers, so every run prints its own.
   */
  maxPositionDelta: number | null
  /** Every frame the real server sent, for the field-coverage guard. */
  realFrames: string[]
  /** Every frame the model sent, for the same guard in the other direction. */
  modelFrames: string[]
  /** The real server's frames split by the peer that received them. */
  realByPeer: Record<string, string[]>
  /** The model's frames split by the peer that received them. */
  modelByPeer: Record<string, string[]>
  report: string
}

const inboundFrames = (transcripts: readonly string[]): string[] =>
  transcripts.filter((l) => l.includes(' << ')).map((l) => l.slice(l.indexOf(' << ') + 4))

export async function runConformance(scenario: Scenario, port: number): Promise<ConformanceRun> {
  const real = await runAgainstReal(scenario, port)
  const model = await runAgainstModel(scenario)
  const tolerance = scenario.playing ? POSITION_TOLERANCE_PLAYING_S : POSITION_TOLERANCE_PAUSED_S
  const divergences = diffTraces(real.trace, model.trace, tolerance)
  const delta = maxPositionDelta(real.trace, model.trace)
  // Printed on every run, pass or fail: this is the measurement the tolerance
  // constants in `trace-diff.ts` cite, and a nightly that only ever prints on
  // failure would let those numbers rot unnoticed.
  console.log(
    `[conformance] ${scenario.name}: max |real-model| position = ` +
      `${delta === null ? 'n/a' : delta.toFixed(3) + 's'} (tolerance ±${tolerance}s)`
  )
  const report =
    `scenario "${scenario.name}" — ${divergences.length} divergence(s) at ±${tolerance}s\n` +
    (divergences.length > 0 ? formatDivergences(divergences) + '\n' : '') +
    `--- real server ---\n${real.transcripts.join('\n')}\n` +
    `--- model ---\n${model.transcripts.join('\n')}`
  return {
    divergences,
    tolerance,
    maxPositionDelta: delta,
    realFrames: inboundFrames(real.transcripts),
    modelFrames: inboundFrames(model.transcripts),
    realByPeer: real.inboundByPeer,
    modelByPeer: model.inboundByPeer,
    report
  }
}

/**
 * Asserts the two backends agree, and prints both transcripts when they do not.
 * Throwing rather than `expect` keeps the whole transcript in the message: a
 * divergence here is a claim about the reference, and the frames are the
 * evidence for it.
 */
export function assertConforms(run: ConformanceRun): void {
  if (run.divergences.length > 0) throw new Error(run.report)
}

/** The one divergence a scenario is allowed to produce, spelled out in full. */
export interface PinnedDivergence {
  /** The `sample` label every divergence must carry — no other sample diverges. */
  label: string
  /** The exact set of diverging `field`s, no more and no fewer. */
  fields: readonly string[]
  /** The `real`/`model` pair every `playstate.setBy` divergence must carry. */
  setBy: { real: unknown; model: unknown }
  /**
   * Upper bound on the position gap. The tolerance is the floor — below it the
   * pinned cause has gone away — and this is the ceiling: a gap wider than the
   * pinned cause can account for is something else that opened up, which a
   * floor-only assertion would wave through however far it grew.
   */
  positionDeltaCeiling: number
}

/**
 * Asserts a scenario diverges in exactly the one way it is expected to, and
 * prints both transcripts when it does not. The counterpart to
 * `assertConforms`, for a scenario whose divergence is a pinned expectation
 * rather than a bug to repair.
 *
 * Why a pin rather than a skip or a known red: a skipped scenario stops running
 * the reference half, which is the half the claim under test rests on, and a
 * known red on `main` makes every nightly post the same comment until a real
 * divergence elsewhere arrives as one more copy of it. A pin keeps both
 * backends running every night and still fails on news — in *both* directions.
 * It fails when the pinned divergence disappears (the model caught up, so the
 * pin is stale and the caller should go back to `assertConforms`) and when
 * anything else joins it — a second, unpinned divergence, a stray sample, or a
 * position gap grown past what the pinned cause can account for. That last one
 * is why the delta is bounded on both sides rather than only from below: a
 * floor-only assertion passes just as happily on a gap ten times too wide.
 * `it.fails` cannot do any of this: it passes on any throw, the caller's own
 * premise assertions included.
 *
 * Every failure carries `run.report`, exactly as `assertConforms` does, so a
 * red still ships the transcripts that are the evidence for it.
 */
export function assertPinnedDivergence(run: ConformanceRun, pin: PinnedDivergence): void {
  const fail = (why: string): never => {
    throw new Error(`pinned divergence broke: ${why}\n\n${run.report}`)
  }
  if (run.divergences.length === 0) {
    fail('the run conforms — the pin is stale, switch back to assertConforms(run)')
  }
  const strayLabels = [...new Set(run.divergences.map((d) => d.label))].filter(
    (l) => l !== pin.label
  )
  if (strayLabels.length > 0) {
    fail(`samples other than ${JSON.stringify(pin.label)} diverged: ${JSON.stringify(strayLabels)}`)
  }
  const fields = [...new Set(run.divergences.map((d) => d.field))].sort()
  const expected = [...pin.fields].sort()
  if (fields.join('|') !== expected.join('|')) {
    fail(`diverging fields are ${JSON.stringify(fields)}, pinned as ${JSON.stringify(expected)}`)
  }
  for (const d of run.divergences) {
    if (d.field !== 'playstate.setBy') continue
    if (d.real !== pin.setBy.real || d.model !== pin.setBy.model) {
      fail(
        `${d.field} is real=${JSON.stringify(d.real)} model=${JSON.stringify(d.model)}, ` +
          `pinned as real=${JSON.stringify(pin.setBy.real)} model=${JSON.stringify(pin.setBy.model)}`
      )
    }
  }
  // A null delta is a failure, not a pass: it means the run sampled no position
  // at all, which is the "green that measures nothing" shape this scenario's
  // step list exists to rule out.
  const delta = run.maxPositionDelta
  if (delta === null) {
    fail('the run sampled no positions, so the position collapse was never measured')
  } else if (delta <= run.tolerance) {
    fail(
      `max |real-model| position ${delta.toFixed(3)}s is inside the ±${run.tolerance}s ` +
        'tolerance — the collapse is gone, switch back to assertConforms(run)'
    )
  } else if (delta >= pin.positionDeltaCeiling) {
    fail(
      `max |real-model| position ${delta.toFixed(3)}s is at or above the pinned ceiling ` +
        `of ${pin.positionDeltaCeiling}s — the gap is wider than the pinned cause accounts ` +
        'for, so something else has opened up alongside it'
    )
  }
}
