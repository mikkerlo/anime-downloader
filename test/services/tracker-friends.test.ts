// The merged Friends service (#712): the merge, the AniList normalization and
// the per-source isolation, over fake providers. The AniList rows are the real
// provider's over the fixture server where the provider's own rule is the
// point (the adult filter, the rates' POINT_100 read).
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  anilistActivityDescription,
  anilistActivityEntry,
  anilistFriendRate,
  createTrackerFriends,
  mergeActivity,
  mergedStamp,
  type AniListActivity,
  type TrackerFriendsDeps
} from '../../src/main/services/trackers/friends'
import { createDisplaySnapshots } from '../../src/main/trackers/display-snapshots'
import type { AniListCachedFriendsActivity } from '../../src/main/trackers/anilist/calendar'
import { STORE_DEFAULTS } from '../../src/main/store/defaults'
import { InMemoryStorage } from '../helpers/in-memory-storage'
import {
  ALICE,
  anilistFixture,
  createAniListServer,
  createTestAniList,
  type AniListServer
} from '../helpers/anilist-server'

const SHIKI_USER = { id: 7, nickname: 'me', avatar: '' }

let server: AniListServer | null = null
afterEach(() => {
  server?.restore()
  server = null
})

function shikiActivity(friendId: number, createdAt: string, malId = 100 + friendId) {
  return {
    friendId,
    friendNickname: `shiki${friendId}`,
    friendAvatar: '',
    malId,
    animeName: `Anime ${malId}`,
    animeImage: 'i.jpg',
    description: 'Watched episode 1',
    createdAt
  }
}

function alActivity(id: number, createdAt: number, over: Partial<AniListActivity> = {}) {
  return {
    id,
    status: 'watched episode',
    progress: '2',
    createdAt,
    user: { id: 6000 + id, name: `al${id}`, avatar: { medium: null } },
    media: {
      id: 500 + id,
      idMal: 900 + id,
      isAdult: false,
      title: { romaji: `Romaji ${id}`, english: null },
      coverImage: { large: 'c.jpg' }
    },
    ...over
  } as AniListActivity
}

interface Rig {
  store: InMemoryStorage
  shikimori: {
    auth: ReturnType<typeof vi.fn>
    getFriends: ReturnType<typeof vi.fn>
    getFriendsActivity: ReturnType<typeof vi.fn>
    getFriendsRates: ReturnType<typeof vi.fn>
  }
  anilist: Rig['shikimori']
  lookupByMalIds: ReturnType<typeof vi.fn>
  broadcast: ReturnType<typeof vi.fn>
  shikiSnapshot: () => unknown
  friends: ReturnType<typeof createTrackerFriends>
}

function rig(
  opts: {
    shikimori?: boolean
    anilist?: boolean
    offline?: boolean
    seed?: Record<string, unknown>
  } = {}
): Rig {
  const store = new InMemoryStorage({
    ...(structuredClone(STORE_DEFAULTS) as Record<string, unknown>),
    ...(opts.shikimori === false ? {} : { shikimoriUser: SHIKI_USER }),
    ...(opts.anilist === false ? {} : { anilistUser: ALICE }),
    ...opts.seed
  })
  const shikimori = {
    auth: vi.fn(async () => ({ token: 's', userId: SHIKI_USER.id })),
    getFriends: vi.fn(async () => []),
    getFriendsActivity: vi.fn(async () => []),
    getFriendsRates: vi.fn(async () => [])
  }
  const anilist = {
    auth: vi.fn(async () => ({ token: 'a', userId: ALICE.id })),
    getFriends: vi.fn(async () => []),
    getFriendsActivity: vi.fn(async () => []),
    getFriendsRates: vi.fn(async () => [])
  }
  let snap: { data: ShikiFriendActivityEntry[]; fetchedAt: number; userId: number } | null = null
  const sync = {
    getCachedFriendsActivity: () => snap,
    setCachedFriendsActivity: (userId: number, data: ShikiFriendActivityEntry[]) =>
      (snap = { data, fetchedAt: Date.now(), userId })
  }
  const snapshots = createDisplaySnapshots<{ friendsActivity: AniListCachedFriendsActivity }>({
    sections: ['friendsActivity'],
    currentUserId: () => (store.get('anilistUser') as { id: number } | null)?.id,
    label: '[anilist]',
    revive: { friendsActivity: (s, userId) => ({ ...s, userId }) }
  })
  const lookupByMalIds = vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { id: id * 10 } as unknown as AnimeSearchResult]))
  )
  const broadcast = vi.fn()
  const friends = createTrackerFriends({
    store: store as never,
    shikimori: { provider: shikimori as never, sync: sync as never },
    anilist: { provider: anilist as never, snapshots },
    lookupByMalIds,
    isOffline: () => opts.offline === true,
    broadcast,
    channels: {
      shikimoriFriendsRefreshed: 'shiki:refreshed',
      friendsRefreshed: 'tracker:refreshed'
    },
    log: { warn: () => {} }
  } satisfies TrackerFriendsDeps)
  return {
    store,
    shikimori,
    anilist,
    lookupByMalIds,
    broadcast,
    shikiSnapshot: () => snap,
    friends
  }
}

describe('merging the activity', () => {
  it('interleaved timestamps from both sources sort newest first, each source keeping its own cap', async () => {
    const r = rig()
    // Each source's own cap: 50 each, so the union is 100 (no shared cap).
    const shiki = Array.from({ length: 50 }, (_, i) =>
      shikiActivity(i + 1, new Date(Date.UTC(2026, 5, 1, 0, i * 2)).toISOString())
    )
    const al = Array.from({ length: 50 }, (_, i) =>
      alActivity(i + 1, Date.UTC(2026, 5, 1, 0, i * 2 + 1) / 1000)
    )
    r.shikimori.getFriendsActivity.mockResolvedValue(shiki)
    r.anilist.getFriendsActivity.mockResolvedValue(al)
    const res = await r.friends.getActivity()
    expect(res.data).toHaveLength(100)
    const times = res.data.map((e) => Date.parse(e.createdAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(res.data.slice(0, 4).map((e) => e.source)).toEqual([
      'anilist',
      'shikimori',
      'anilist',
      'shikimori'
    ])
    expect(res.sources.shikimori?.data).toHaveLength(50)
    expect(res.sources.anilist?.data).toHaveLength(50)
  })

  it('mergeActivity orders by time alone, whatever the source', () => {
    const a = (source: TrackerId, at: string) =>
      ({ source, createdAt: at }) as TrackerFriendActivityEntry
    const out = mergeActivity([
      // Shikimori's offset times are compared as instants, not as strings.
      [a('shikimori', '2026-01-01T00:00:00Z'), a('shikimori', '2026-01-02T02:00:00+03:00')],
      [a('anilist', '2026-01-02T00:00:00.000Z')]
    ])
    expect(out.map((e) => e.createdAt)).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-01-02T02:00:00+03:00',
      '2026-01-01T00:00:00Z'
    ])
  })

  it('the stamp: stale when any source is, at the oldest stale snapshot; null without one', () => {
    expect(
      mergedStamp([
        { data: [], fetchedAt: 500, stale: false },
        { data: [], fetchedAt: 300, stale: true },
        { data: [], fetchedAt: 100, stale: true }
      ])
    ).toEqual({ fetchedAt: 100, stale: true })
    expect(
      mergedStamp([
        { data: [], fetchedAt: 50, stale: false },
        { data: [], fetchedAt: 300, stale: true }
      ])
    ).toEqual({ fetchedAt: 300, stale: true })
    expect(mergedStamp([{ data: [], fetchedAt: null, stale: true }])).toEqual({
      fetchedAt: null,
      stale: true
    })
    expect(mergedStamp([])).toEqual({ fetchedAt: null, stale: false })
  })
})

describe('the AniList activity entry', () => {
  it('createdAt (unix seconds) becomes ISO; the friend and title link to AniList', () => {
    const e = anilistActivityEntry(alActivity(1, 1_764_100_000))!
    expect(e).toEqual({
      source: 'anilist',
      friendId: 6001,
      friendNickname: 'al1',
      friendAvatar: '',
      malId: 901,
      animeName: 'Romaji 1',
      animeImage: 'c.jpg',
      description: 'watched episode 2',
      createdAt: '2025-11-25T19:46:40.000Z',
      smotretAnime: null,
      friendUrl: 'https://anilist.co/user/al1',
      titleUrl: 'https://anilist.co/anime/501'
    })
  })

  it('an entry without idMal keeps malId null and joins nothing', async () => {
    const r = rig({ shikimori: false })
    r.anilist.getFriendsActivity.mockResolvedValue([
      alActivity(1, 1_764_100_000, {
        media: { id: 77, idMal: null, title: { romaji: 'CN', english: null } } as never
      }),
      alActivity(2, 1_764_000_000)
    ])
    const res = await r.friends.getActivity()
    expect(res.data.map((e) => [e.malId, e.smotretAnime])).toEqual([
      [null, null],
      [902, { id: 9020 }]
    ])
    expect(r.lookupByMalIds.mock.calls).toEqual([[[902]]])
  })

  it('a range progress builds "watched episode 1 - 3"; no AniList-provided text reaches description', () => {
    expect(anilistActivityDescription('watched episode', '1 - 3')).toBe('watched episode 1 - 3')
    expect(anilistActivityDescription('completed', null)).toBe('completed')
    expect(anilistActivityDescription('watched episode', '<img src=x onerror=alert(1)>')).toBe(
      'watched an episode'
    )
    expect(anilistActivityDescription('<b>wrote</b> something', '3')).toBe('updated their list')
    const e = anilistActivityEntry(
      alActivity(3, 1, { status: 'watched episode', progress: '1 - 3' })
    )!
    expect(e.description).toBe('watched episode 1 - 3')
  })
})

describe('per-source failure isolation', () => {
  it('Shikimori’s activity throw (no snapshot) still returns AniList’s feed, and an error for Shikimori', async () => {
    const r = rig()
    r.shikimori.getFriendsActivity.mockRejectedValue(new Error('shiki down'))
    r.anilist.getFriendsActivity.mockResolvedValue([alActivity(1, 1_764_100_000)])
    const res = await r.friends.getActivity()
    expect(res.data.map((e) => e.source)).toEqual(['anilist'])
    expect(res.sources.shikimori).toEqual({
      data: [],
      fetchedAt: null,
      stale: true,
      status: 'error',
      error: 'shiki down'
    })
    expect(res.sources.anilist?.status).toBe('ok')
    // The alias keeps its throw.
    await expect(r.friends.shikimoriActivity()).rejects.toThrow('shiki down')
  })

  it('Shikimori’s logged-out rates throw still returns AniList’s rates', async () => {
    const r = rig()
    r.shikimori.auth.mockRejectedValue(new Error('Not logged in to Shikimori'))
    r.anilist.getFriendsRates.mockResolvedValue([
      {
        user: { name: 'bob', avatar: { medium: 'b.png' } },
        status: 'CURRENT',
        score: 70,
        progress: 4
      }
    ])
    expect(await r.friends.getRates(1)).toEqual([
      { source: 'shikimori', status: 'error', error: 'Not logged in to Shikimori', rates: [] },
      {
        source: 'anilist',
        status: 'ok',
        rates: [
          {
            source: 'anilist',
            nickname: 'bob',
            avatar: 'b.png',
            status: 'watching',
            score: 7,
            episodes: 4
          }
        ]
      }
    ])
    await expect(r.friends.shikimoriRates(1)).rejects.toThrow('Not logged in to Shikimori')
  })

  it('AniList’s cards failing cold still returns Shikimori’s', async () => {
    const r = rig()
    r.shikimori.getFriends.mockResolvedValue([{ id: 1, nickname: 'x', watching: null }])
    r.anilist.getFriends.mockRejectedValue(new Error('429'))
    const res = await r.friends.getFriends()
    expect(res.cards.map((c) => [c.source, c.nickname])).toEqual([['shikimori', 'x']])
    expect(res.sources).toEqual({
      shikimori: { status: 'ok' },
      anilist: { status: 'error', error: '429' }
    })
  })

  it('an expired AniList session serves the cached cards and the snapshot, stale, with sessionExpired', async () => {
    const r = rig({
      seed: {
        anilistSessionExpired: true,
        anilistFriends: [{ id: 3, nickname: 'ann', avatar: '', titles: 1, mean: 7 }]
      }
    })
    r.anilist.getFriendsActivity.mockResolvedValueOnce([alActivity(1, 1_764_100_000)])
    r.store.set('anilistSessionExpired', false)
    await r.friends.getActivity()
    r.store.set('anilistSessionExpired', true)
    r.anilist.auth.mockRejectedValue(new Error('Your AniList session expired'))

    const cards = await r.friends.getFriends()
    expect(cards.cards.map((c) => c.nickname)).toEqual(['ann'])
    expect(cards.sources.anilist).toEqual({
      status: 'error',
      error: 'Session expired',
      sessionExpired: true
    })
    const feed = await r.friends.getActivity()
    expect(feed.sources.anilist).toMatchObject({
      stale: true,
      status: 'error',
      sessionExpired: true
    })
    expect(feed.sources.anilist?.data.map((e) => e.friendNickname)).toEqual(['al1'])
    expect(feed.stale).toBe(true)
  })

  it('the smotret join failing: both feeds still return, that batch with smotretAnime null', async () => {
    const r = rig()
    r.shikimori.getFriendsActivity.mockResolvedValue([shikiActivity(1, '2026-06-01T00:00:00Z')])
    r.anilist.getFriendsActivity.mockResolvedValue([alActivity(1, 1_764_100_000)])
    r.lookupByMalIds.mockRejectedValue(new Error('smotret down'))
    const res = await r.friends.getActivity()
    expect(res.data.map((e) => [e.source, e.smotretAnime])).toEqual([
      ['shikimori', null],
      ['anilist', null]
    ])
    expect(res.sources.shikimori?.status).toBe('ok')
    expect(res.sources.anilist?.status).toBe('ok')
    // The alias keeps today's fall-back: its failed lookup serves the snapshot,
    // which the merged read stored, stale.
    r.shikimori.getFriendsActivity.mockResolvedValue([shikiActivity(1, '2026-06-01T00:00:00Z')])
    await expect(r.friends.shikimoriActivity()).resolves.toMatchObject({ stale: true })
  })

  it('MyAnimeList is never a friends source; neither is a tracker without an account', () => {
    expect(rig({ anilist: false }).friends.sources()).toEqual(['shikimori'])
    expect(
      rig({
        shikimori: false,
        anilist: false,
        seed: { myanimelistUser: { id: 1 } }
      }).friends.sources()
    ).toEqual([])
  })
})

describe('the AniList cards', () => {
  it('are cache-first on anilistFriends; the background refresh goes out on tracker:friends-refreshed only', async () => {
    const r = rig({
      shikimori: false,
      seed: { anilistFriends: [{ id: 3, nickname: 'old', avatar: '', titles: 1, mean: 7 }] }
    })
    r.anilist.getFriends.mockResolvedValue([
      { id: 3, nickname: 'new', avatar: '', titles: 2, mean: 8 }
    ])
    const res = await r.friends.getFriends()
    expect(res.cards.map((c) => c.nickname)).toEqual(['old'])
    await vi.waitFor(() => expect(r.broadcast).toHaveBeenCalled())
    expect(r.broadcast.mock.calls).toEqual([
      [
        'tracker:refreshed',
        {
          trackerId: 'anilist',
          cards: [
            {
              source: 'anilist',
              id: 3,
              nickname: 'new',
              avatar: '',
              presence: false,
              lastOnlineAt: null,
              online: false,
              titles: 2,
              mean: 8,
              mutual: null,
              watching: null
            }
          ]
        }
      ]
    ])
    expect(r.store.get('anilistFriends')).toEqual([
      { id: 3, nickname: 'new', avatar: '', titles: 2, mean: 8 }
    ])
  })
})

describe('the AniList provider’s rules, through the service', () => {
  it('displayAdultContent off drops adult titles from the activity, not from the rates', async () => {
    server = createAniListServer((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 950, idMal: 950 }] } } } }
        : call.operation === 'FriendsRates'
          ? { body: anilistFixture('friends-rates') }
          : { body: anilistFixture('activities') }
    )
    const t = await createTestAniList()
    const r = rig({ shikimori: false })
    const friends = createTrackerFriends({
      store: t.store as never,
      shikimori: { provider: r.shikimori as never, sync: {} as never },
      anilist: {
        provider: t.provider,
        snapshots: { get: () => null, put: () => {} }
      },
      lookupByMalIds: async () => ({}),
      isOffline: () => false,
      broadcast: () => {},
      channels: { shikimoriFriendsRefreshed: 'x' },
      log: { warn: () => {} }
    })
    const feed = await friends.getActivity()
    expect(feed.data.map((e) => e.animeName)).toEqual(['Demon Slayer', 'Donghua Title'])
    expect(feed.data.some((e) => e.malId === 950)).toBe(false)
    // The adult title (950) is the rated one here, and it stays.
    const rates = await friends.getRates(950)
    expect(rates[0].rates.map((x) => x.nickname)).toEqual(['bob', 'carol'])
  })

  it('a friend’s POINT_100 85 is 8.5 whatever the viewer’s scoreFormat; a 0 stays 0', async () => {
    server = createAniListServer((call) =>
      call.operation === 'IdMap'
        ? { body: { data: { Page: { media: [{ id: 101, idMal: 1 }] } } } }
        : { body: anilistFixture('friends-rates') }
    )
    const t = await createTestAniList({ user: { ...ALICE, scoreFormat: 'POINT_5' } })
    const friends = createTrackerFriends({
      store: t.store as never,
      shikimori: { provider: {} as never, sync: {} as never },
      anilist: { provider: t.provider, snapshots: { get: () => null, put: () => {} } },
      lookupByMalIds: async () => ({}),
      isOffline: () => false,
      broadcast: () => {},
      channels: { shikimoriFriendsRefreshed: 'x' },
      log: { warn: () => {} }
    })
    const [al] = await friends.getRates(1)
    expect(al.rates.map((x) => [x.nickname, x.status, x.score, x.episodes])).toEqual([
      ['bob', 'completed', 8.5, 26],
      ['carol', 'watching', 0, 3]
    ])
    expect(anilistFriendRate({ user: { name: 'z' }, status: 'PAUSED', score: 33 })).toMatchObject({
      status: 'on_hold',
      score: 3.3
    })
  })

  it('meanScore reaches TrackerFriendCard.mean on the 0–10 scale', async () => {
    server = createAniListServer((call) =>
      call.variables.page === 1
        ? { body: anilistFixture('following-1') }
        : { body: anilistFixture('following-2') }
    )
    const t = await createTestAniList()
    const friends = createTrackerFriends({
      store: t.store as never,
      shikimori: { provider: {} as never, sync: {} as never },
      anilist: { provider: t.provider, snapshots: { get: () => null, put: () => {} } },
      lookupByMalIds: async () => ({}),
      isOffline: () => false,
      broadcast: () => {},
      channels: { shikimoriFriendsRefreshed: 'x' },
      log: { warn: () => {} }
    })
    const res = await friends.getFriends()
    expect(res.cards.map((c) => [c.nickname, c.mean, c.titles])).toEqual([
      ['bob', 7.84, 312],
      ['carol', 0, 0],
      ['dave', 8.5, 45]
    ])
  })
})
