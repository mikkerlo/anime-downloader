// `tracker:get-related` (#710): the chronology from the resolved `chronology`
// source. AniList runs end to end: the real provider, client, limiter and id
// map against a fixture route serving T7's `related-batch.json`, and the real
// AniList sync instance behind the primary's status map. MyAnimeList's walk
// runs over `mal/related-walk.json`. Shikimori's branch (and the public
// fallback) is `shikimori:get-related`'s body over the mocked franchise read,
// characterized against `main`. The walks' own rules are
// `test/trackers/chronology.test.ts`'s.
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '../../src/shared/ipc/channels'

const getFranchise = vi.fn()

vi.mock('../../src/main/shikimori', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/shikimori')>(
    '../../src/main/shikimori'
  )
  return { ...actual, getFranchise: (...a: unknown[]) => getFranchise(...a) }
})

import {
  anilistFixture,
  createAniListServer,
  createTestAniList,
  type AniListReply,
  type AniListServer
} from '../helpers/anilist-server'
import {
  capturedChronology,
  franchiseFixture,
  PLAIN_SMOTRET,
  RICH_FRANCHISE,
  RICH_SMOTRET,
  RICH_STORE
} from '../helpers/chronology-fixtures'
import { shikimoriOnlyTrackers } from '../helpers/tracker-fan-out'
import { register as registerTrackers } from '../../src/main/ipc/trackers.ipc'
import { register as registerShikimori } from '../../src/main/ipc/shikimori.ipc'
import type { AppDeps } from '../../src/main/ipc/index'
import { createShikimoriSyncService } from '../../src/main/services/shikimori-sync'
import { createTrackerFanOut } from '../../src/main/services/trackers/fan-out'
import { createTrackerRates } from '../../src/main/services/trackers/rates'
import type { TrackerSyncService } from '../../src/main/services/trackers/sync'
import { createAniListSyncService } from '../../src/main/trackers/anilist/sync'
import { createAniListRelated } from '../../src/main/trackers/anilist/related'
import { classifyAnilistError } from '../../src/main/trackers/anilist/classify'
import { createMalRelated } from '../../src/main/trackers/mal/related'
import type { MalRelatedRead } from '../../src/main/trackers/mal/provider'

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000

const SHIKI_SIGNED_IN = {
  shikimoriCredentials: { access_token: 'a', refresh_token: 'r' },
  shikimoriUser: { id: 7, nickname: 'me' }
}
const MAL_SIGNED_IN = { myanimelistUser: { id: 9, nickname: 'mal-me', avatar: null } }

const MAL_READS: Record<string, MalRelatedRead> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'mal', 'related-walk.json'), 'utf8')
)

/** An AniList list row: `media` on the list with `status`. */
function listRow(mediaId: number, idMal: number, status: string) {
  return {
    entry: {
      id: 80_000 + mediaId,
      mediaId,
      status,
      score: 0,
      progress: 1,
      repeat: 1,
      updatedAt: 1,
      media: { id: mediaId, idMal, title: { romaji: `#${idMal}`, english: null }, format: 'TV' }
    },
    smotretAnime: null
  }
}

interface Rig {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  related: (malId: number) => Promise<ShikiRelatedEntry[]>
  server: AniListServer
  storeReads: string[]
  malReads: number[]
}

async function rig(
  opts: {
    anilist?: boolean
    shikimori?: boolean
    mal?: boolean
    seed?: Record<string, unknown>
    /** `IdMap`'s reply; defaults to MAL 1 → AniList 101 and MAL 11 → 111. */
    idMap?: AniListReply
    smotret?: Record<number, unknown>
  } = {}
): Promise<Rig> {
  const server = createAniListServer((call) => {
    if (call.operation === 'IdMap') {
      return (
        opts.idMap ?? {
          body: {
            data: {
              Page: {
                media: [
                  { id: 101, idMal: 1 },
                  { id: 111, idMal: 11 }
                ].filter((m) => (call.variables.ids as number[]).includes(m.idMal))
              }
            }
          }
        }
      )
    }
    if (call.operation === 'RelatedBatch') {
      const ids = call.variables.ids as number[]
      const body = anilistFixture<{ data: { Page: { media: { id: number }[] } } }>('related-batch')
      body.data.Page.media = body.data.Page.media.filter((m) => ids.includes(m.id))
      return { body }
    }
    return { status: 400, body: { errors: [{ message: `unrouted ${call.operation}` }] } }
  })
  servers.push(server)
  const t = await createTestAniList({
    user: opts.anilist ? undefined : null,
    token: opts.anilist ? undefined : null,
    seed: {
      ...(opts.shikimori ? SHIKI_SIGNED_IN : {}),
      ...(opts.mal ? MAL_SIGNED_IN : {}),
      ...opts.seed
    }
  })
  const { store, provider } = t
  const storeReads: string[] = []
  const get = store.get.bind(store)
  store.get = ((key: string) => {
    storeReads.push(key)
    return get(key)
  }) as typeof store.get
  const shiki = createShikimoriSyncService({
    store: store as never,
    broadcast: () => {},
    syncStatusChannel: EVENT_CHANNELS.SHIKIMORI_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    animeDetailsUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED,
    isOffline: () => false
  } as never)
  const anilistSync = createAniListSyncService(provider, {
    store: store as never,
    broadcast: () => {},
    syncStatusChannel: EVENT_CHANNELS.TRACKER_SYNC_STATUS,
    offlineQueueChangedChannel: EVENT_CHANNELS.TRACKER_OFFLINE_QUEUE_CHANGED,
    rateUpdatedChannel: EVENT_CHANNELS.TRACKER_RATE_UPDATED,
    ratesRefreshedChannel: EVENT_CHANNELS.TRACKER_RATES_REFRESHED,
    isOffline: () => false
  })
  const fan = createTrackerFanOut({
    store: store as never,
    trackers: [
      { sync: shiki.tracker as TrackerSyncService<unknown, unknown> },
      { sync: anilistSync as unknown as TrackerSyncService<unknown, unknown> }
    ],
    log: { warn: () => {} }
  })
  const trackerRates = createTrackerRates({ store: store as never, trackers: fan })
  const smotret = opts.smotret ?? {}
  const lookupByMalIds = async (ids: number[]) =>
    Object.fromEntries(ids.filter((id) => smotret[id]).map((id) => [id, smotret[id]])) as never
  const malReads: number[] = []
  const anilistRelated = createAniListRelated({
    store: store as never,
    resolveRef: (m, o) => provider.resolveRef(m, o),
    getRelatedBatch: (ids, o) => provider.getRelatedBatch(ids, o)
  })
  const malRelated = createMalRelated({
    getRelated: async (ref) => {
      malReads.push(ref.malId)
      return structuredClone(MAL_READS[String(ref.malId)])
    }
  })

  ;(ipcMain.handle as unknown as Mock).mockClear()
  registerTrackers({
    store,
    trackerRates,
    trackerLifecycle: {},
    trackerAuth: {},
    trackerChoices: {},
    shikimoriSyncService: shiki,
    lookupByMalIds,
    anilistRelated,
    malRelated
  } as unknown as AppDeps)
  registerShikimori({
    store,
    shikimoriSyncService: shiki,
    ...shikimoriOnlyTrackers(store as never, shiki),
    lookupByMalIds,
    maybeBroadcastCleanupPrompt: async () => {},
    runAutoDownloadTick: async () => ({}),
    broadcast: () => {}
  } as unknown as AppDeps)
  const handlers = new Map<string, (...args: unknown[]) => unknown>(
    (ipcMain.handle as unknown as Mock).mock.calls.map(([c, h]) => [c, h])
  )
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> =>
    handlers.get(channel)!({}, ...args)
  storeReads.length = 0
  return {
    invoke,
    related: (malId) => invoke(CHANNELS.TRACKER_GET_RELATED, malId) as Promise<ShikiRelatedEntry[]>,
    server,
    storeReads,
    malReads
  }
}

let servers: AniListServer[] = []

beforeEach(() => {
  getFranchise.mockReset()
  getFranchise.mockImplementation(async () => franchiseFixture())
})

afterEach(() => {
  for (const s of servers.reverse()) s.restore()
  servers = []
})

describe('tracker:get-related — AniList', () => {
  it('resolves chronology → anilist and returns the AniList-normalized entries', async () => {
    const r = await rig({ anilist: true })
    const out = await r.related(1)
    expect(out).toEqual([
      {
        relation: null,
        shikiAnime: {
          id: 1,
          name: 'Demon Slayer',
          image_url: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx101.jpg',
          url: 'https://anilist.co/anime/101',
          year: 2019,
          kind: 'tv',
          date: utc(2019, 4, 6)
        },
        smotretAnime: null,
        isCurrent: true,
        watchStatus: null
      },
      {
        relation: 'sequel',
        shikiAnime: {
          id: 11,
          name: 'Yuukaku-hen',
          image_url: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx111.jpg',
          url: 'https://anilist.co/anime/111',
          year: 2021,
          kind: 'tv',
          date: utc(2021, 10, 10)
        },
        smotretAnime: null,
        isCurrent: false,
        watchStatus: null
      }
    ])
    expect(getFranchise).not.toHaveBeenCalled()
    // Level 0 through the id map, then one request per level, token-less.
    expect(r.server.of('IdMap')).toHaveLength(1)
    expect(r.server.of('RelatedBatch').map((c) => c.variables.ids)).toEqual([[101], [111], [777]])
    expect(r.server.calls.every((c) => c.token === null)).toBe(true)
  })

  it('an unmapped title falls back to the public Shikimori franchise', async () => {
    const r = await rig({
      anilist: true,
      idMap: { body: { data: { Page: { media: [] } } } },
      smotret: PLAIN_SMOTRET
    })
    expect(await r.related(5114)).toEqual(capturedChronology().plain)
    expect(getFranchise).toHaveBeenCalledWith(5114)
    expect(r.server.of('RelatedBatch')).toHaveLength(0)
  })

  it('an id-map lookup that fails with a network error throws, with no fallback', async () => {
    const r = await rig({ anilist: true, idMap: { throws: new TypeError('fetch failed') } })
    const err = await r.related(1).then(
      () => null,
      (e: unknown) => e
    )
    expect(classifyAnilistError(err)).toBe('network')
    expect(r.server.of('IdMap').length).toBeGreaterThan(0)
    expect(getFranchise).not.toHaveBeenCalled()
  })

  it('with Shikimori connected, the adapter’s kind wins over shikimoriAnimeDetails', async () => {
    const r = await rig({
      anilist: true,
      shikimori: true,
      seed: {
        trackerFeatureSource: { chronology: 'anilist' },
        shikimoriAnimeDetails: { '11': { details: { kind: 'movie' }, fetchedAt: 1 } },
        shikimoriUserRates: [
          {
            rate: { id: 1, target_id: 11, status: 'watching', episodes: 1, score: 0 },
            shikiAnime: { id: 11, kind: 'ova' },
            smotretAnime: null
          }
        ]
      }
    })
    const out = await r.related(1)
    expect(out.find((e) => e.shikiAnime.id === 11)?.shikiAnime.kind).toBe('tv')
  })

  it('watchStatus is the AniList primary’s: REPEATING shows rewatching, and shikimoriUserRates is never read', async () => {
    const r = await rig({
      anilist: true,
      seed: { anilistUserRates: [listRow(111, 11, 'REPEATING')] }
    })
    const out = await r.related(1)
    expect(out.find((e) => e.shikiAnime.id === 11)?.watchStatus).toBe('rewatching')
    expect(out.find((e) => e.shikiAnime.id === 1)?.watchStatus).toBeNull()
    expect(r.storeReads).not.toContain('shikimoriUserRates')
    expect(r.storeReads).not.toContain('shikimoriAnimeDetails')
  })
})

describe('tracker:get-related — the other sources', () => {
  it('shikimori: today’s output, and the same as the shikimori:get-related alias', async () => {
    getFranchise.mockImplementation(async () => structuredClone(RICH_FRANCHISE))
    const r = await rig({
      shikimori: true,
      seed: structuredClone(RICH_STORE),
      smotret: RICH_SMOTRET
    })
    const captured = capturedChronology().rich
    expect(await r.related(5114)).toEqual(captured)
    expect(await r.invoke(CHANNELS.SHIKIMORI_GET_RELATED, 5114)).toEqual(captured)
    expect(r.server.calls).toHaveLength(0)
  })

  it('mal: the MAL walk, one read at a time; a second call is served from memory', async () => {
    const r = await rig({ mal: true })
    const out = await r.related(5114)
    expect(out.map((e) => [e.shikiAnime.id, e.relation, e.isCurrent])).toEqual([
      [121, 'alternative_version', false],
      [430, null, false],
      [5114, null, true],
      [9135, 'side_story', false]
    ])
    expect(r.malReads).toEqual([5114, 121, 9135, 430])
    await r.related(5114)
    expect(r.malReads).toHaveLength(4)
    expect(getFranchise).not.toHaveBeenCalled()
    expect(r.server.calls).toHaveLength(0)
  })

  it('null (no tracker): the public Shikimori franchise, with no status chips', async () => {
    const r = await rig({ smotret: PLAIN_SMOTRET })
    expect(await r.related(5114)).toEqual(capturedChronology().plain)
    expect(getFranchise).toHaveBeenCalledWith(5114)
    expect(r.server.calls).toHaveLength(0)
  })

  it('rejects an invalid MAL id', async () => {
    const r = await rig()
    await expect(r.related(0)).rejects.toThrow('Invalid MAL id')
  })
})
