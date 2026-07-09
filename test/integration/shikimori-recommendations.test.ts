/**
 * Recommendations read-path integration tests (#193, PR #194 review).
 *
 * Drives the real `SHIKIMORI_GET_RECOMMENDATIONS` handler (registered via the
 * shikimori IPC router against the in-memory store + stubbed HTTP client) to
 * pin the two review fixes at the seam where they live:
 *
 *  1. a cache whose entries have ALL since been rated falls through to a
 *     synchronous rebuild instead of returning `[]` (empty-state flash), and
 *  2. concurrent reads dedupe onto a single in-flight rebuild instead of
 *     stacking franchise + /similar fan-outs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const ensureFreshToken = vi.fn()
const getSimilar = vi.fn()
const getFranchise = vi.fn()
const getAnimeDetails = vi.fn()
const getOngoingRanked = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return {
    ...actual,
    ensureFreshToken: (...a: unknown[]) => ensureFreshToken(...a),
    getSimilar: (...a: unknown[]) => getSimilar(...a),
    getFranchise: (...a: unknown[]) => getFranchise(...a),
    getAnimeDetails: (...a: unknown[]) => getAnimeDetails(...a),
    getOngoingRanked: (...a: unknown[]) => getOngoingRanked(...a)
  }
})

import { register } from '../../src/main/ipc/shikimori.ipc'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function ratedEntry(malId: number, score = 8, status = 'completed') {
  return {
    rate: { id: malId, target_id: malId, status, score, episodes: 12, rewatches: 0 },
    shikiAnime: { id: malId, name: `Anime ${malId}`, russian: `Аниме ${malId}` },
    smotretAnime: null
  }
}

function similarAnime(id: number) {
  return {
    id,
    name: `Similar ${id}`,
    russian: `Похожее ${id}`,
    image: { original: `/o/${id}.jpg`, preview: `/p/${id}.jpg`, x96: '', x48: '' },
    url: `/animes/${id}`,
    kind: 'tv',
    score: '7.5',
    status: 'released',
    episodes: 12,
    episodes_aired: 12,
    aired_on: null,
    released_on: null
  }
}

function ongoingAnime(id: number) {
  return { ...similarAnime(id), name: `Ongoing ${id}`, russian: '', status: 'ongoing' }
}

function recEntry(malId: number) {
  return {
    malId,
    animeId: null,
    title: `Rec ${malId}`,
    posterUrl: `/p/${malId}.jpg`,
    kind: 'tv',
    communityScore: 7.5,
    reason: 'Because you liked «Аниме 1»'
  }
}

/** Genre details cache entry so enrichment is satisfied from cache (no delays). */
function detailsEntry(genres: string[]) {
  return {
    details: { genres: genres.map((n, i) => ({ id: i + 1, name: n, russian: n })) },
    fetchedAt: Date.now()
  }
}

function boot(initial: Record<string, unknown>) {
  const store = new InMemoryStorage({
    shikimoriUser: { id: 1, nickname: 'a' },
    shikimoriCredentials: { access_token: 't', refresh_token: 'r' },
    shikimoriUserRates: [],
    shikimoriAnimeDetails: {},
    shikimoriRecommendations: [],
    shikimoriUpdateQueue: [],
    ...initial
  })
  const broadcast = vi.fn()
  const sync = {
    setOnDetailsPrefetched: vi.fn(),
    invalidateCalendarCache: vi.fn(),
    syncShikimoriQueue: vi.fn(async () => undefined),
    prefetchShikimoriDetails: vi.fn(async () => undefined),
    abortPrefetch: vi.fn(),
    stopSyncTimer: vi.fn(),
    startSyncTimer: vi.fn(),
    broadcastSyncStatus: vi.fn(),
    getSyncStatus: vi.fn(),
    getCachedCalendar: vi.fn(() => null),
    setCachedCalendar: vi.fn()
  }
  register({
    store,
    shikimoriSyncService: sync,
    lookupByMalIds: vi.fn(async () => ({})),
    maybeBroadcastCleanupPrompt: vi.fn(),
    runAutoDownloadTick: vi.fn(async () => undefined),
    broadcast
  } as unknown as Parameters<typeof register>[0])

  // The router registers many handlers and `beforeEach` doesn't reset the
  // global ipcMain spy between `register` calls — grab the LAST registration
  // for the channel so each test drives its own store.
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([channel]) => channel === CHANNELS.SHIKIMORI_GET_RECOMMENDATIONS
  )
  const handler = calls[calls.length - 1][1] as Handler
  return { store, broadcast, handler }
}

beforeEach(() => {
  ensureFreshToken.mockReset().mockResolvedValue('access-token')
  getFranchise.mockReset().mockResolvedValue({ links: [], nodes: [], current_id: 0 })
  getSimilar.mockReset().mockResolvedValue([])
  getAnimeDetails.mockReset().mockResolvedValue({ genres: [] })
  getOngoingRanked.mockReset().mockResolvedValue([])
})

describe('SHIKIMORI_GET_RECOMMENDATIONS read path', () => {
  it('falls through to a synchronous rebuild when the read-time filter empties the cache', async () => {
    // Cached feed contains only malId 100 — which the user has since rated.
    // Old behavior: return [] and kick a background refresh (empty-state
    // flash). New behavior: rebuild synchronously and return fresh entries.
    getSimilar.mockResolvedValue([similarAnime(200)])
    const { store, handler } = boot({
      shikimoriRecommendations: [recEntry(100)],
      shikimoriUserRates: [ratedEntry(1), ratedEntry(100)],
      shikimoriAnimeDetails: { '200': detailsEntry(['Драма']) }
    })

    const result = (await handler({})) as Array<{ malId: number }>

    expect(result).not.toEqual([])
    expect(result.map((r) => r.malId)).toEqual([200])
    // The rebuilt feed replaced the fully-stale cache.
    expect(
      (store.get('shikimoriRecommendations') as Array<{ malId: number }>).map((r) => r.malId)
    ).toEqual([200])
  })

  it('still serves the filtered cache (and persists it) when entries survive the filter', async () => {
    const { store, handler } = boot({
      shikimoriRecommendations: [recEntry(100), recEntry(200)],
      shikimoriUserRates: [ratedEntry(1), ratedEntry(100)]
    })

    const result = (await handler({})) as Array<{ malId: number }>

    expect(result.map((r) => r.malId)).toEqual([200])
    expect(
      (store.get('shikimoriRecommendations') as Array<{ malId: number }>).map((r) => r.malId)
    ).toEqual([200])
  })

  // "Airing now for you" (#206): the ongoing pool is a second candidate source
  // merged into the same rebuild, so its seams are pinned here too.
  describe('airing pool', () => {
    it('recommends a title present only in the ongoing pool (behavior difference vs similar-only sourcing)', async () => {
      // 999 appears in NO seed's /similar list — the old sourcing could never
      // surface it. With genre affinity (Драма rated 8 → positive) it must
      // land in the airing row, flagged and reason-prefixed.
      getOngoingRanked.mockResolvedValue([ongoingAnime(999)])
      const { handler } = boot({
        shikimoriUserRates: [ratedEntry(1)],
        shikimoriAnimeDetails: { '1': detailsEntry(['Драма']), '999': detailsEntry(['Драма']) }
      })

      const result = (await handler({})) as Array<{
        malId: number
        airing?: boolean
        reason: string
      }>

      expect(result.map((r) => r.malId)).toEqual([999])
      expect(result[0].airing).toBe(true)
      expect(result[0].reason).toMatch(/^Airing now · /)
    })

    it('degrades to the similar-only feed when the ongoing fetch fails', async () => {
      getOngoingRanked.mockRejectedValue(new Error('boom'))
      getSimilar.mockResolvedValue([similarAnime(200)])
      const { handler } = boot({
        shikimoriUserRates: [ratedEntry(1)],
        shikimoriAnimeDetails: { '200': detailsEntry(['Драма']) }
      })

      const result = (await handler({})) as Array<{ malId: number; airing?: boolean }>

      expect(result.map((r) => r.malId)).toEqual([200])
      expect(result[0].airing).toBeUndefined()
    })

    it('enriches an airing candidate even when the seeded pool fills the prelim enrich cut', async () => {
      // 26 seeded candidates (all with cached genres) outrank the seedless
      // airing one, so the prelim top-25 contains no airing entry. The old
      // prelim-only enrichment would leave 999 genre-less → gated out of the
      // row; unconditional airing enrichment must fetch its details.
      const seededIds = Array.from({ length: 26 }, (_, i) => 200 + i)
      getSimilar.mockResolvedValue(seededIds.map(similarAnime))
      getOngoingRanked.mockResolvedValue([ongoingAnime(999)])
      getAnimeDetails.mockResolvedValue({
        genres: [{ id: 1, name: 'Drama', russian: 'Драма' }]
      })
      const details = Object.fromEntries(
        seededIds.map((id) => [String(id), detailsEntry(['Драма'])])
      )
      const { handler } = boot({
        shikimoriUserRates: [ratedEntry(1)],
        shikimoriAnimeDetails: { ...details, '1': detailsEntry(['Драма']) }
      })

      const result = (await handler({})) as Array<{ malId: number; airing?: boolean }>

      expect(getAnimeDetails).toHaveBeenCalledWith('access-token', 999)
      expect(result.filter((r) => r.airing).map((r) => r.malId)).toEqual([999])
    })

    it('excludes an airing franchise-sibling of a seed', async () => {
      // The excludedIds guard lives inline in the /similar merge loop; the
      // ongoing merge must apply it too or airing sequels of watched shows
      // leak into the top row.
      getFranchise.mockResolvedValue({ links: [], nodes: [{ id: 999 }], current_id: 1 })
      getOngoingRanked.mockResolvedValue([ongoingAnime(999), ongoingAnime(500)])
      const { handler } = boot({
        shikimoriUserRates: [ratedEntry(1)],
        shikimoriAnimeDetails: {
          '1': detailsEntry(['Драма']),
          '500': detailsEntry(['Драма']),
          '999': detailsEntry(['Драма'])
        }
      })

      const result = (await handler({})) as Array<{ malId: number }>

      expect(result.map((r) => r.malId)).toEqual([500])
    })
  })

  it('dedupes concurrent reads onto a single in-flight rebuild', async () => {
    // Gate /similar so both invocations overlap while the first build is
    // mid-flight. Old behavior: each read starts its own fan-out (2 calls).
    let releaseSimilar: (v: ReturnType<typeof similarAnime>[]) => void
    getSimilar.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSimilar = resolve
        })
    )
    const { handler } = boot({
      shikimoriUserRates: [ratedEntry(1)],
      shikimoriAnimeDetails: { '200': detailsEntry(['Драма']) }
    })

    const first = handler({})
    const second = handler({})
    await vi.waitFor(() => expect(getSimilar).toHaveBeenCalled())
    releaseSimilar!([similarAnime(200)])

    const [a, b] = (await Promise.all([first, second])) as Array<Array<{ malId: number }>>

    expect(getSimilar).toHaveBeenCalledTimes(1)
    expect(a.map((r) => r.malId)).toEqual([200])
    expect(b).toEqual(a)
  })
})
