// The Shikimori broadcast bridge (#694, epic #688). `index.ts` hands the
// Shikimori emitters (the sync service, the sync-runner, the routers'
// `AppDeps.broadcast` and the runner's wholesale refresh) this wrapped
// `broadcast` instead of the bare one. Each of the four Shikimori rate, queue
// and status broadcasts is double-emitted: the `shikimori:*` event with
// today's payload first, then its `tracker:*` twin with `trackerId:
// 'shikimori'`. Every other channel passes through untouched, Shikimori's
// details broadcast included. One choke point covers every emitter, so none of
// them names a `tracker:*` channel. The double-emit goes away with the
// aliases (#717). `docs/trackers.md` § The IPC surface describes the payloads.

import { EVENT_CHANNELS } from '@shared/ipc/channels'
import type { RateValues } from '../lib/shikimori-rate'
import type { CachedRateEntry } from '../lib/shikimori-rate-cache'
import type { TrackerDrainStatus } from '../services/trackers/sync'
import { shikimoriRateCache } from './shikimori.provider'

type Broadcast = (channel: string, ...args: unknown[]) => void

/** The four `tracker:*` broadcasts, passed in by `index.ts` (the emitter scan reads it there). */
export interface TrackerEventChannels {
  rateUpdated: string
  ratesRefreshed: string
  syncStatus: string
  offlineQueueChanged: string
}

export interface ShikimoriEventBridgeDeps {
  broadcast: Broadcast
  channels: TrackerEventChannels
  /** The Shikimori instance's "Needs setup", which `ShikiSyncStatus` doesn't carry. */
  needsSetup: () => boolean
  /** Read at emit time from the live queue, so a caller can't send a stale overlay. */
  queuedAfter: () => Record<number, RateValues>
  log?: Pick<Console, 'warn'>
}

export function createShikimoriEventBridge(deps: ShikimoriEventBridgeDeps): Broadcast {
  const { channels } = deps
  const log = deps.log ?? console
  const trackerId = 'shikimori' as const
  const entryOf = (row: CachedRateEntry) => shikimoriRateCache.entryOf(row)

  const twins = new Map<string, [string, (payload: unknown) => unknown]>([
    [
      EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
      [
        channels.rateUpdated,
        (row) => ({ trackerId, entry: entryOf(row as CachedRateEntry), raw: row })
      ]
    ],
    [
      EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED,
      [
        channels.ratesRefreshed,
        (rows) => ({ trackerId, entries: (rows as CachedRateEntry[]).map(entryOf), raw: rows })
      ]
    ],
    [
      EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
      [
        channels.syncStatus,
        (status) => ({
          trackerId,
          status: { ...(status as TrackerDrainStatus), needsSetup: deps.needsSetup() }
        })
      ]
    ],
    [
      EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
      [
        channels.offlineQueueChanged,
        (payload) => ({
          trackerId,
          length: (payload as { length: number }).length,
          queuedAfter: deps.queuedAfter()
        })
      ]
    ]
  ])

  return (channel, ...args) => {
    deps.broadcast(channel, ...args)
    const twin = twins.get(channel)
    if (!twin) return
    let payload: unknown
    try {
      payload = twin[1](args[0])
    } catch (err) {
      // The legacy event is out; a payload the mapping can't read must not
      // throw into the emitter, which is mid-write.
      log.warn(`[trackers] could not mirror ${channel}:`, err)
      return
    }
    deps.broadcast(twin[0], payload)
  }
}
