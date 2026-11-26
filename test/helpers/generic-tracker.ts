// A generic sync instance (#691) for AniList or MyAnimeList over
// `fake-tracker.ts`, with a plain rate cache: T6/T7 bring the real codecs. For
// the tests that need a non-Shikimori tracker next to Shikimori's real one
// (#693's boot drain, online edge and Prepare rows).
import {
  createTrackerSyncService,
  type TrackerSyncService
} from '../../src/main/services/trackers/sync'
import { ANILIST_KEYS, MYANIMELIST_KEYS } from '../../src/main/trackers/keys'
import type { TrackerRateCacheCodec } from '../../src/main/trackers/types'
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import type { StorageService } from '../../src/main/store/types'
import { createFakeTracker, type FakeTracker } from './fake-tracker'

export interface PlainRow {
  malId: number
  remoteId: number | null
  values: RateValues
}

export const plainCodec: TrackerRateCacheCodec<unknown, PlainRow> = {
  fromEntries: (entries) =>
    entries.map((e) => ({ malId: e.malId, remoteId: e.remoteId, values: { ...e.values } })),
  malIdOf: (row) => row.malId,
  indexOf: (rows, malId) => rows.findIndex((r) => r.malId === malId),
  read: (row) => ({ remoteId: row.remoteId, values: { ...row.values } }),
  patch: (row, values, remoteId) => ({
    ...row,
    ...(remoteId !== undefined ? { remoteId } : {}),
    values: { ...values }
  })
}

export const GENERIC_KEYS = { anilist: ANILIST_KEYS, mal: MYANIMELIST_KEYS } as const

export function createGenericTracker<P extends 'anilist' | 'mal'>(
  id: P,
  store: StorageService,
  opts: { isOffline?: () => boolean; fake?: FakeTracker<P> } = {}
): { fake: FakeTracker<P>; sync: TrackerSyncService<unknown, unknown> } {
  const fake = opts.fake ?? createFakeTracker(id)
  const sync = createTrackerSyncService(
    {
      ...fake.provider,
      rateCache: plainCodec,
      isSessionGone: () => false
    } as never,
    GENERIC_KEYS[id],
    {
      store,
      broadcast: () => {},
      syncStatusChannel: `${id}:status`,
      offlineQueueChangedChannel: `${id}:queue`,
      rateUpdatedChannel: `${id}:rate`,
      ratesRefreshedChannel: `${id}:refreshed`,
      isOffline: opts.isOffline
    }
  ) as TrackerSyncService<unknown, unknown>
  return { fake, sync }
}
