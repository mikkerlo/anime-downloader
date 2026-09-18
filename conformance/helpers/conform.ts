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
