// AniList's broadcast bridge (#703). The AniList instance emits `tracker:*`
// only, with no legacy twin, but the generic sync service broadcasts its raw
// payloads: a cache row, the refreshed rows, the drain status, `{ length }`.
// This wraps the `broadcast` `index.ts` hands the instance and shapes those
// four into the `tracker:*` payloads (`TrackerRateUpdatedEvent` and its
// siblings), as `createShikimoriEventBridge`'s twins do. The channels come from
// `index.ts`, which is where the emitter scan finds them.

import type { RateValues } from '../../lib/shikimori-rate'
import type { TrackerDrainStatus } from '../../services/trackers/sync'
import type { TrackerEventChannels } from '../events'
import type { TrackerRateCacheCodec } from '../types'
import type { AniListCachedRow } from './provider'

type Broadcast = (channel: string, ...args: unknown[]) => void

export interface AniListEventBridgeDeps {
  broadcast: Broadcast
  channels: TrackerEventChannels
  rateCache: Pick<TrackerRateCacheCodec<unknown, AniListCachedRow>, 'entryOf'>
  /** The instance's "Needs setup", which the drain status doesn't carry. */
  needsSetup: () => boolean
  /** Read at emit time from the live queue, so a caller can't send a stale overlay. */
  queuedAfter: () => Record<number, RateValues>
  log?: Pick<Console, 'warn'>
}

export function createAniListEventBridge(deps: AniListEventBridgeDeps): Broadcast {
  const { channels } = deps
  const log = deps.log ?? console
  const trackerId = 'anilist' as const
  const entryOf = (row: AniListCachedRow) => deps.rateCache.entryOf(row)

  const shapes = new Map<string, (payload: unknown) => unknown>([
    [channels.rateUpdated, (row) => ({ trackerId, entry: entryOf(row as AniListCachedRow) })],
    [
      channels.ratesRefreshed,
      (rows) => ({ trackerId, entries: (rows as AniListCachedRow[]).map(entryOf) })
    ],
    [
      channels.syncStatus,
      (status) => ({
        trackerId,
        status: { ...(status as TrackerDrainStatus), needsSetup: deps.needsSetup() }
      })
    ],
    [
      channels.offlineQueueChanged,
      (payload) => ({
        trackerId,
        length: (payload as { length: number }).length,
        queuedAfter: deps.queuedAfter()
      })
    ]
  ])

  return (channel, ...args) => {
    const shape = shapes.get(channel)
    if (!shape) return deps.broadcast(channel, ...args)
    let payload: unknown
    try {
      payload = shape(args[0])
    } catch (err) {
      log.warn(`[anilist] could not shape ${channel}:`, err)
      return
    }
    deps.broadcast(channel, payload)
  }
}
