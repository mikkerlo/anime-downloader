// The rates step of every tracker but Shikimori (#693): the same phases as
// `shikimori-rates.ts` (drain, then the `keepQueued` refresh, then the details
// prefetch when the deps supply one). It joins a run only when its tracker is
// connected as the run starts, so a Shikimori-only run keeps its six rows.

import type { TrackerRatesResult } from '../../trackers/sync'
import { TRACKER_LABELS } from '../../../trackers/types'
import { errorText, type PrepareStep, type PrepareStepResult } from '../index'
import { waitingText } from './shikimori-rates'

export type RatesTrackerId = Exclude<TrackerId, 'shikimori'>

export interface TrackerRatesStepDeps {
  /** Read when a run starts (`joinsRun`) and again when the step runs. */
  isConnected(): boolean
  /** The instance's `drainNow()`: waits for a drain in flight, then drains. */
  drain(): Promise<void>
  refreshRates(opts: { keepQueued: boolean }): Promise<TrackerRatesResult<unknown> | null>
  /** The details prefetch, abortable through `abortPrefetch`; none until T7. */
  prefetch?(): Promise<void>
  abortPrefetch?(): void
}

const STEP_IDS = { anilist: 'anilist-rates', mal: 'mal-rates' } as const satisfies Record<
  RatesTrackerId,
  PrepareOfflineStepId
>

export function createTrackerRatesStep(
  trackerId: RatesTrackerId,
  deps: TrackerRatesStepDeps
): PrepareStep {
  const name = TRACKER_LABELS[trackerId]
  return {
    id: STEP_IDS[trackerId],
    label: `${name} rates`,
    requiresNetwork: true,
    isAvailable: () => ({ available: true }),
    joinsRun: () => deps.isConnected(),
    async run(ctx): Promise<PrepareStepResult> {
      // Disconnected since the run started: the row has joined, so it says why.
      if (!deps.isConnected()) {
        return { status: 'skipped', details: [{ text: 'Not logged in', status: 'skipped' }] }
      }
      const prefetch = deps.prefetch
      const total = prefetch ? 3 : 2
      ctx.progress({ done: 0, total, message: 'Sending queued changes' })
      await deps.drain()
      if (ctx.signal.aborted) return { status: 'skipped', details: [] }

      ctx.progress({ done: 1, total, message: 'Refreshing your list' })
      const details: PrepareStepResult['details'] = []
      let status: PrepareStepResult['status'] = 'ok'
      try {
        const result = await deps.refreshRates({ keepQueued: true })
        if (!result) {
          return {
            status: 'warning',
            details: [{ text: 'The account changed during the refresh', status: 'warning' }]
          }
        }
        details.push({ text: `${result.entries.length} rates refreshed`, status: 'ok' })
        if (result.waitingMalIds.length > 0) {
          status = 'warning'
          details.push({ text: waitingText(result.waitingMalIds.length), status: 'warning' })
        }
      } catch (err) {
        return { status: 'failed', details: [{ text: errorText(err), status: 'failed' }] }
      }
      if (!prefetch) {
        ctx.progress({ done: 2, total })
        return { status, details }
      }
      if (ctx.signal.aborted) return { status, details }

      ctx.progress({ done: 2, total, message: `Caching ${name} details` })
      const onAbort = (): void => deps.abortPrefetch?.()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await prefetch()
      } catch (err) {
        status = status === 'ok' ? 'warning' : status
        details.push({ text: `${name} details: ${errorText(err)}`, status: 'warning' })
      } finally {
        ctx.signal.removeEventListener('abort', onAbort)
      }
      ctx.progress({ done: 3, total })
      return { status, details }
    }
  }
}
