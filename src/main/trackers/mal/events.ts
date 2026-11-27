// The MAL instance's broadcasts (#702). The generic sync service emits its four
// rate, queue and status broadcasts with the cache row and the bare status;
// MAL emits `tracker:*` only (no legacy twin), so this wraps the instance's
// `broadcast` and reshapes each payload to its `tracker:*` form with
// `trackerId: 'mal'`, as the Shikimori bridge does for the twins. `index.ts`
// passes the `tracker:*` channels, which is where the emitter scan finds them.

import type { RateValues } from '../../lib/shikimori-rate'
import type { TrackerDrainStatus } from '../../services/trackers/sync'
import type { TrackerEventChannels } from '../events'
import { malRateCache, type MalCachedRow } from './provider'

type Broadcast = (channel: string, ...args: unknown[]) => void

export interface MalEventBroadcastDeps {
  broadcast: Broadcast
  channels: TrackerEventChannels
  needsSetup: () => boolean
  /** Read at emit time from the live queue. */
  queuedAfter: () => Record<number, RateValues>
  log?: Pick<Console, 'warn'>
}

export function createMalEventBroadcast(deps: MalEventBroadcastDeps): Broadcast {
  const { channels } = deps
  const log = deps.log ?? console
  const trackerId = 'mal' as const
  const shapes = new Map<string, (payload: unknown) => unknown>([
    [
      channels.rateUpdated,
      (row) => ({ trackerId, entry: malRateCache.entryOf(row as MalCachedRow) })
    ],
    [
      channels.ratesRefreshed,
      (rows) => ({ trackerId, entries: (rows as MalCachedRow[]).map(malRateCache.entryOf) })
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
    if (!shape) {
      deps.broadcast(channel, ...args)
      return
    }
    let payload: unknown
    try {
      payload = shape(args[0])
    } catch (err) {
      // The emitter is mid-write: a payload this can't read must not throw into it.
      log.warn(`[trackers] could not shape the MyAnimeList ${channel} broadcast:`, err)
      return
    }
    deps.broadcast(channel, payload)
  }
}
