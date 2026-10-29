// Step 2 (#592): drain the offline queue, then refresh `shikimoriUserRates`
// keeping every title that still has a queued edit (a partial drain must not
// lose it to the server's older value), then the Shikimori details prefetch.

import type { RefreshRatesResult } from '../../shikimori-sync'
import { errorText, type PrepareStep, type PrepareStepResult } from '../index'

export interface ShikimoriRatesStepDeps {
  isLoggedIn(): boolean
  /** `shikimoriSyncService.drainNow()`: waits for a drain in flight, then drains. */
  drain(): Promise<void>
  refreshRates(opts: { keepQueued: boolean }): Promise<RefreshRatesResult | null>
  prefetchShikimoriDetails(): Promise<void>
  abortPrefetch(): void
}

export function waitingText(n: number): string {
  return `${n} ${n === 1 ? 'edit' : 'edits'} still waiting to sync`
}

export function createShikimoriRatesStep(deps: ShikimoriRatesStepDeps): PrepareStep {
  return {
    id: 'shikimori-rates',
    label: 'Shikimori rates',
    requiresNetwork: true,
    isAvailable: () => ({ available: true }),
    async run(ctx): Promise<PrepareStepResult> {
      if (!deps.isLoggedIn()) {
        return { status: 'skipped', details: [{ text: 'Not logged in', status: 'skipped' }] }
      }
      ctx.progress({ done: 0, total: 3, message: 'Sending queued changes' })
      await deps.drain()
      if (ctx.signal.aborted) return { status: 'skipped', details: [] }

      ctx.progress({ done: 1, total: 3, message: 'Refreshing your list' })
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
      if (ctx.signal.aborted) return { status, details }

      ctx.progress({ done: 2, total: 3, message: 'Caching Shikimori details' })
      const onAbort = (): void => deps.abortPrefetch()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      try {
        await deps.prefetchShikimoriDetails()
      } catch (err) {
        status = status === 'ok' ? 'warning' : status
        details.push({ text: `Shikimori details: ${errorText(err)}`, status: 'warning' })
      } finally {
        ctx.signal.removeEventListener('abort', onAbort)
      }
      ctx.progress({ done: 3, total: 3 })
      return { status, details }
    }
  }
}
