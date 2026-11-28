// The rate cache the AniList and MAL personalities use in the service tests;
// T6/T7 bring the real ones. A row is the listed entry's values under its ids.
import type { RateValues } from '../../src/main/lib/shikimori-rate'
import type { TrackerRateCacheCodec } from '../../src/main/trackers/types'

export interface TestRow {
  malId: number
  remoteId: number | null
  values: RateValues
  updated_at: string
}

/** `entryOf` names `trackerId`, which a row doesn't carry. */
export function testRateCodec(
  trackerId: TrackerId = 'anilist'
): TrackerRateCacheCodec<unknown, TestRow> {
  return {
    fromEntries: (entries) =>
      entries.map((e) => ({
        malId: e.malId,
        remoteId: e.remoteId,
        values: { ...e.values },
        updated_at: 'listed'
      })),
    malIdOf: (row) => row.malId,
    indexOf: (rows, malId) => rows.findIndex((r) => r.malId === malId),
    read: (row) => ({ remoteId: row.remoteId, values: { ...row.values } }),
    patch: (row, values, remoteId) => ({
      ...row,
      ...(remoteId !== undefined ? { remoteId } : {}),
      values: { ...values },
      updated_at: new Date().toISOString()
    }),
    // A row keeps no native, so the read's values stand in for it.
    patchFromRead: (row, entry) => ({
      ...row,
      remoteId: entry.remoteId,
      values: { ...entry.values },
      updated_at: 'read'
    }),
    entryOf: (row) => ({
      trackerId,
      malId: row.malId,
      remoteId: row.remoteId,
      values: { ...row.values },
      updatedAt: Number.isNaN(Date.parse(row.updated_at)) ? null : Date.parse(row.updated_at),
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
