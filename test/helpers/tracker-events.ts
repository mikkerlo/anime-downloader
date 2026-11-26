// The double-emit table's assertions (#694): every Shikimori rate, queue and
// status broadcast is followed at once by its `tracker:*` twin, exactly once.
import { expect } from 'vitest'
import { EVENT_CHANNELS } from '../../src/shared/ipc/channels'
import { shikimoriRateCache } from '../../src/main/trackers/shikimori.provider'
import type { CachedRateEntry } from '../../src/main/lib/shikimori-rate-cache'

export const TRACKER_EVENTS = {
  rateUpdated: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
  ratesRefreshed: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
  syncStatus: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
  offlineQueueChanged: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED
}

export const TWIN_OF: Record<string, string> = {
  [EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED]: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
  [EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED]: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
  [EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS]: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
  [EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED]: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED
}

export interface Twin {
  legacy: unknown
  twin: Record<string, unknown>
}

/**
 * Every `legacy` event in `calls` with the event right after it, which must be
 * its twin; and no twin anywhere else. `calls` is a broadcast mock's calls.
 */
export function twinsOf(calls: readonly unknown[][], legacy: string): Twin[] {
  const twinChannel = TWIN_OF[legacy]
  const out: Twin[] = []
  calls.forEach(([channel, payload], i) => {
    if (channel !== legacy) return
    expect(calls[i + 1]?.[0], `the event after ${legacy} #${out.length}`).toBe(twinChannel)
    out.push({ legacy: payload, twin: calls[i + 1][1] as Record<string, unknown> })
  })
  expect(calls.filter(([c]) => c === twinChannel)).toHaveLength(out.length)
  return out
}

/** The one `legacy` event and its twin; fails unless there is exactly one of each. */
export function onlyTwin(calls: readonly unknown[][], legacy: string): Twin {
  const twins = twinsOf(calls, legacy)
  expect(twins, `${legacy} emits`).toHaveLength(1)
  return twins[0]
}

/** A `shikimori:rate-updated` twin: the row's normalized entry, and the row itself as `raw`. */
export function expectRateTwin({ legacy, twin }: Twin): void {
  expect(twin).toEqual({
    trackerId: 'shikimori',
    entry: shikimoriRateCache.entryOf(legacy as CachedRateEntry),
    raw: legacy
  })
  expect(twin.raw).toBe(legacy)
}

/** A `shikimori:offline-queue-changed` twin: the same length, and the overlay from `queue`. */
export function expectQueueTwin(
  { legacy, twin }: Twin,
  queuedAfter: Record<number, unknown>
): void {
  expect(twin).toEqual({
    trackerId: 'shikimori',
    length: (legacy as { length: number }).length,
    queuedAfter
  })
}
