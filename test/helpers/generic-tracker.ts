// A generic sync instance (#691) for AniList or MyAnimeList over
// `fake-tracker.ts`, with a plain rate cache: T6/T7 bring the real codecs. For
// the tests that need a non-Shikimori tracker next to Shikimori's real one
// (#693's boot drain, online edge and Prepare rows).
import {
  createTrackerSyncService,
  type TrackerSyncService,
  type TrackerSyncServiceDeps
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

/** `entryOf` (#694) names `trackerId`, which a row doesn't carry. */
export function plainCodec(trackerId: TrackerId): TrackerRateCacheCodec<unknown, PlainRow> {
  return {
    fromEntries: (entries) =>
      entries.map((e) => ({ malId: e.malId, remoteId: e.remoteId, values: { ...e.values } })),
    malIdOf: (row) => row.malId,
    indexOf: (rows, malId) => rows.findIndex((r) => r.malId === malId),
    read: (row) => ({ remoteId: row.remoteId, values: { ...row.values } }),
    patch: (row, values, remoteId) => ({
      ...row,
      ...(remoteId !== undefined ? { remoteId } : {}),
      values: { ...values }
    }),
    entryOf: (row) => ({
      trackerId,
      malId: row.malId,
      remoteId: row.remoteId,
      values: { ...row.values },
      updatedAt: null,
      anime: {
        title: `#${row.malId}`,
        poster: null,
        kind: null,
        episodes: null,
        episodesAired: null,
        status: null
      },
      smotretAnime: null
    })
  }
}

/**
 * A cached row with the server's time and the smotret join, as a real list
 * cache has them (#715's merge leg reads both through `entryOf`).
 */
export interface DatedRow extends PlainRow {
  /** The row's last update in ms (the real AniList codec's `updatedAt`). */
  updatedAt?: number | null
  smotretAnime?: { id: number; title?: string } | null
}

/**
 * `plainCodec` with `updatedAt` and `smotretAnime`: a patch moves the row's
 * time to `now`, as AniList's codec does, so a patched row's time is no
 * longer the server's.
 */
export function datedCodec(
  trackerId: TrackerId,
  now: () => number = Date.now
): TrackerRateCacheCodec<unknown, DatedRow> {
  const plain = plainCodec(trackerId)
  return {
    fromEntries: (entries) =>
      entries.map((e) => ({
        malId: e.malId,
        remoteId: e.remoteId,
        values: { ...e.values },
        updatedAt: e.updatedAt,
        smotretAnime: (e.smotretAnime as DatedRow['smotretAnime']) ?? null
      })),
    malIdOf: (row) => row.malId,
    indexOf: (rows, malId) => rows.findIndex((r) => r.malId === malId),
    read: (row) => ({ remoteId: row.remoteId, values: { ...row.values } }),
    patch: (row, values, remoteId) => ({
      ...row,
      ...(remoteId !== undefined ? { remoteId } : {}),
      values: { ...values },
      updatedAt: now()
    }),
    entryOf: (row) => ({
      ...plain.entryOf(row),
      updatedAt: row.updatedAt ?? null,
      smotretAnime: (row.smotretAnime as never) ?? null,
      anime: { ...plain.entryOf(row).anime, title: row.smotretAnime?.title ?? `#${row.malId}` }
    })
  }
}

export const GENERIC_KEYS = { anilist: ANILIST_KEYS, mal: MYANIMELIST_KEYS } as const

export function createGenericTracker<P extends 'anilist' | 'mal'>(
  id: P,
  store: StorageService,
  opts: {
    isOffline?: () => boolean
    fake?: FakeTracker<P>
    codec?: TrackerRateCacheCodec<unknown, unknown>
    /** Members laid over the fake provider (`hasTitle`, #715). */
    provider?: Record<string, unknown>
    /** Laid over the defaults: a broadcast spy, #706's details channel and prefetch. */
    deps?: Partial<TrackerSyncServiceDeps>
  } = {}
): { fake: FakeTracker<P>; sync: TrackerSyncService<unknown, unknown> } {
  const fake = opts.fake ?? createFakeTracker(id)
  const sync = createTrackerSyncService(
    {
      ...fake.provider,
      ...opts.provider,
      rateCache: opts.codec ?? plainCodec(id),
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
      isOffline: opts.isOffline,
      ...opts.deps
    }
  ) as TrackerSyncService<unknown, unknown>
  return { fake, sync }
}
