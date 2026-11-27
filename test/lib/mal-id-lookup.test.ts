// The shared MAL → smotret join (#744), moved out of `index.ts`: cache hits are
// served from `malIdMap`, only the uncached ids go to smotret, and a smotret
// failure degrades those ids instead of rejecting the lookup. Red on main: the
// same body without the guard (`index.ts`'s, verbatim) rejects with smotret's
// error, so every tracker's list read failed with it.
import { describe, it, expect, vi } from 'vitest'
import { createMalIdLookup } from '../../src/main/lib/mal-id-lookup'
import type { AnimeDetail, AnimeSearchResult } from '../../src/main/smotret-api'
import { InMemoryStorage } from '../helpers/in-memory-storage'

type Found = AnimeSearchResult & { myAnimeListId?: number }

const anime = (id: number, malId: number, poster = `https://smotret.test/${id}.jpg`): Found => ({
  id,
  title: `#${id}`,
  titles: {},
  posterUrlSmall: poster,
  numberOfEpisodes: 12,
  type: 'tv',
  typeTitle: 'TV',
  year: 2024,
  season: 'fall',
  myAnimeListId: malId
})

const CACHED = { '1': anime(101, 1), '2': anime(102, 2) }
const NOT_FOUND = () => new Error('API error: 404 Not Found')

/** Reads are copies, as electron-store's are: a skipped `store.set` stays visible. */
class CopyingStorage extends InMemoryStorage {
  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    const v = super.get<T>(key, defaultValue)
    return v === undefined ? v : structuredClone(v)
  }
}

function rig(seed: Record<string, unknown> = {}) {
  const store = new CopyingStorage({
    malIdMap: structuredClone(CACHED),
    recentAnimeMeta: {},
    ...seed
  })
  const smotretApi = {
    lookupByMalIds: vi.fn(async (_ids: number[]): Promise<Found[]> => {
      throw NOT_FOUND()
    }),
    getAnime: vi.fn(async (_id: number): Promise<{ data: AnimeDetail }> => {
      throw new Error('no detail')
    })
  }
  const rememberAnimeMeta = vi.fn()
  const log = { warn: vi.fn() }
  const lookup = createMalIdLookup({ store: store as never, smotretApi, rememberAnimeMeta, log })
  const malIdMap = () => store.get('malIdMap') as Record<string, AnimeSearchResult>
  return { store, smotretApi, rememberAnimeMeta, log, lookup, malIdMap }
}

describe('createMalIdLookup', () => {
  it('cache hits are served without smotret; only the uncached ids are looked up', async () => {
    const r = rig()
    r.smotretApi.lookupByMalIds.mockResolvedValueOnce([anime(103, 3)])
    expect(await r.lookup([1, 3])).toEqual({ 1: CACHED['1'], 3: anime(103, 3) })
    expect(r.smotretApi.lookupByMalIds).toHaveBeenCalledExactlyOnceWith([3])
    expect(r.malIdMap()['3']).toEqual(anime(103, 3))
  })

  it('a poster-less fetched entry is enriched from the detail read and remembered', async () => {
    const r = rig()
    r.smotretApi.lookupByMalIds.mockResolvedValueOnce([anime(103, 3, '')])
    const detail = { ...anime(103, 3, ''), posterUrl: 'https://smotret.test/full.jpg' }
    r.smotretApi.getAnime.mockResolvedValueOnce({ data: detail as AnimeDetail })
    expect((await r.lookup([3]))[3].posterUrlSmall).toBe('https://smotret.test/full.jpg')
    expect(r.rememberAnimeMeta).toHaveBeenCalledWith(detail)
  })

  it('smotret rejecting: resolves with exactly the cache hits, and warns once', async () => {
    const r = rig()
    const result = await r.lookup([1, 2, 3, 4])
    expect(result).toEqual({ 1: CACHED['1'], 2: CACHED['2'] })
    expect(r.smotretApi.lookupByMalIds).toHaveBeenCalledExactlyOnceWith([3, 4])
    expect(r.log.warn).toHaveBeenCalledTimes(1)
    expect(String(r.log.warn.mock.calls[0][0])).toContain('2 uncached ids')
  })

  it('smotret rejecting: nothing is cached for the failed ids, and the hits are unchanged', async () => {
    const r = rig()
    const before = JSON.stringify(CACHED)
    await r.lookup([1, 2, 3, 4])
    expect(Object.keys(r.malIdMap()).sort()).toEqual(['1', '2'])
    expect(JSON.stringify(r.malIdMap())).toBe(before)
  })

  it('the next successful lookup fills the failed ids in and caches them', async () => {
    const r = rig()
    await r.lookup([1, 2, 3, 4])
    r.smotretApi.lookupByMalIds.mockResolvedValueOnce([anime(103, 3), anime(104, 4)])
    expect(await r.lookup([1, 2, 3, 4])).toEqual({
      1: CACHED['1'],
      2: CACHED['2'],
      3: anime(103, 3),
      4: anime(104, 4)
    })
    expect(r.smotretApi.lookupByMalIds).toHaveBeenLastCalledWith([3, 4])
    expect(r.malIdMap()['3']).toEqual(anime(103, 3))
    expect(r.malIdMap()['4']).toEqual(anime(104, 4))
  })

  it('a poster-less cache hit is healed from recentAnimeMeta and written, while smotret rejects', async () => {
    const r = rig({
      malIdMap: { '1': anime(101, 1, '') },
      recentAnimeMeta: { '101': anime(101, 1, 'https://smotret.test/healed.jpg') }
    })
    const result = await r.lookup([1, 3])
    expect(Object.keys(result)).toEqual(['1'])
    expect(result[1].posterUrlSmall).toBe('https://smotret.test/healed.jpg')
    expect(r.malIdMap()['1'].posterUrlSmall).toBe('https://smotret.test/healed.jpg')
    expect(r.malIdMap()['3']).toBeUndefined()
  })
})
