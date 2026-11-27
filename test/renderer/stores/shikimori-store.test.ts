import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'

type Listener<T> = (data: T) => void

// The facade takes rates, the queue length and the sync status from the
// `tracker:*` twins (#697). `rateUpdated` and its three siblings send the
// legacy payload the way main's bridge does, as the twin with
// `trackerId: 'shikimori'` and `raw`, so the cases below read as before.
type Captured = {
  rateUpdated: Listener<ShikiAnimeRateEntry>[]
  ratesRefreshed: Listener<ShikiAnimeRateEntry[]>[]
  detailsUpdated: Listener<{ malId: number; details: ShikiAnimeDetails }>[]
  offlineQueue: Listener<{ length: number }>[]
  syncStatus: Listener<unknown>[]
  trackerRateUpdated: Listener<TrackerRateUpdatedEvent>[]
  trackerRatesRefreshed: Listener<TrackerRatesRefreshedEvent>[]
  trackerOfflineQueue: Listener<TrackerOfflineQueueChangedEvent>[]
  trackerSyncStatus: Listener<TrackerSyncStatusEvent>[]
  legacyRateUpdated: Listener<ShikiAnimeRateEntry>[]
  legacyRatesRefreshed: Listener<ShikiAnimeRateEntry[]>[]
  legacyOfflineQueue: Listener<{ length: number }>[]
  legacySyncStatus: Listener<unknown>[]
  profileRefreshed: Listener<ShikimoriProfile>[]
  friendsRefreshed: Listener<ShikiFriendCard[]>[]
  recommendationsRefreshed: Listener<RecommendationEntry[]>[]
  getUser: ReturnType<typeof vi.fn>
  getProfile: ReturnType<typeof vi.fn>
  getFriends: ReturnType<typeof vi.fn>
  getRecommendations: ReturnType<typeof vi.fn>
  getRates: ReturnType<typeof vi.fn>
  getSyncStatus: ReturnType<typeof vi.fn>
  getOfflineQueueLength: ReturnType<typeof vi.fn>
  triggerSync: ReturnType<typeof vi.fn>
}

let captured: Captured

function entryOf(raw: ShikiAnimeRateEntry): TrackerRateEntry {
  const malId = (raw.rate.target_id ?? raw.shikiAnime?.id) as number
  return {
    trackerId: 'shikimori',
    malId,
    remoteId: raw.rate.id,
    values: {
      episodes: raw.rate.episodes,
      status: raw.rate.status,
      score: raw.rate.score,
      rewatches: 0
    },
    updatedAt: null,
    anime: {
      title: '',
      poster: null,
      kind: null,
      episodes: null,
      episodesAired: null,
      status: null
    },
    smotretAnime: null
  }
}

function asTrackerStatus(status: unknown): TrackerSyncStatus {
  return { ...(status as TrackerSyncStatus), needsSetup: false }
}

function installApi(): void {
  captured = {
    rateUpdated: [],
    ratesRefreshed: [],
    detailsUpdated: [],
    offlineQueue: [],
    syncStatus: [],
    trackerRateUpdated: [],
    trackerRatesRefreshed: [],
    trackerOfflineQueue: [],
    trackerSyncStatus: [],
    legacyRateUpdated: [],
    legacyRatesRefreshed: [],
    legacyOfflineQueue: [],
    legacySyncStatus: [],
    profileRefreshed: [],
    friendsRefreshed: [],
    recommendationsRefreshed: [],
    getUser: vi.fn(async () => null),
    getProfile: vi.fn(async () => null),
    getFriends: vi.fn(async () => []),
    getRecommendations: vi.fn(async () => []),
    getRates: vi.fn(async () => []),
    getSyncStatus: vi.fn(async () => ({
      state: 'idle',
      queueLength: 4,
      lastSyncAt: 1234,
      lastSyncError: null,
      sessionExpired: false
    })),
    getOfflineQueueLength: vi.fn(async () => 7),
    triggerSync: vi.fn(async () => undefined)
  }
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      onShikimoriRateUpdated: (cb: Listener<ShikiAnimeRateEntry>) => {
        captured.legacyRateUpdated.push(cb)
        return () => {}
      },
      onShikimoriRatesRefreshed: (cb: Listener<ShikiAnimeRateEntry[]>) => {
        captured.legacyRatesRefreshed.push(cb)
        return () => {}
      },
      onTrackerRateUpdated: (cb: Listener<TrackerRateUpdatedEvent>) => {
        captured.trackerRateUpdated.push(cb)
        captured.rateUpdated.push((raw) => cb({ trackerId: 'shikimori', entry: entryOf(raw), raw }))
        return () => {}
      },
      onTrackerRatesRefreshed: (cb: Listener<TrackerRatesRefreshedEvent>) => {
        captured.trackerRatesRefreshed.push(cb)
        captured.ratesRefreshed.push((raw) =>
          cb({ trackerId: 'shikimori', entries: raw.map(entryOf), raw })
        )
        return () => {}
      },
      onTrackerOfflineQueueChanged: (cb: Listener<TrackerOfflineQueueChangedEvent>) => {
        captured.trackerOfflineQueue.push(cb)
        captured.offlineQueue.push(({ length }) =>
          cb({ trackerId: 'shikimori', length, queuedAfter: {} })
        )
        return () => {}
      },
      onTrackerSyncStatus: (cb: Listener<TrackerSyncStatusEvent>) => {
        captured.trackerSyncStatus.push(cb)
        captured.syncStatus.push((status) =>
          cb({ trackerId: 'shikimori', status: asTrackerStatus(status) })
        )
        return () => {}
      },
      onShikimoriAnimeDetailsUpdated: (
        cb: Listener<{ malId: number; details: ShikiAnimeDetails }>
      ) => {
        captured.detailsUpdated.push(cb)
        return () => {}
      },
      onShikimoriOfflineQueueChanged: (cb: Listener<{ length: number }>) => {
        captured.legacyOfflineQueue.push(cb)
        return () => {}
      },
      onShikimoriSyncStatus: (cb: Listener<unknown>) => {
        captured.legacySyncStatus.push(cb)
        return () => {}
      },
      onShikimoriProfileRefreshed: (cb: Listener<ShikimoriProfile>) => {
        captured.profileRefreshed.push(cb)
        return () => {}
      },
      onShikimoriFriendsRefreshed: (cb: Listener<ShikiFriendCard[]>) => {
        captured.friendsRefreshed.push(cb)
        return () => {}
      },
      onShikimoriRecommendationsRefreshed: (cb: Listener<RecommendationEntry[]>) => {
        captured.recommendationsRefreshed.push(cb)
        return () => {}
      },
      shikimoriGetUser: captured.getUser,
      shikimoriGetProfile: captured.getProfile,
      shikimoriGetFriends: captured.getFriends,
      shikimoriGetRecommendations: captured.getRecommendations,
      shikimoriGetAnimeRates: captured.getRates,
      shikimoriGetSyncStatus: captured.getSyncStatus,
      shikimoriGetOfflineQueueLength: captured.getOfflineQueueLength,
      shikimoriTriggerSync: captured.triggerSync
    }
  }
}

function mkRate(malId: number, episodes: number): ShikiAnimeRateEntry {
  return {
    rate: { id: 1, target_id: malId, episodes, status: 'watching', score: 0 },
    shikiAnime: { id: malId },
    smotretAnime: null
  } as unknown as ShikiAnimeRateEntry
}

beforeEach(() => {
  installApi()
  setActivePinia(createPinia())
  vi.resetModules()
})

describe('useShikimoriStore', () => {
  it('subscribes once to each tracker twin it uses and not to the legacy four', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    useShikimoriStore()
    expect(captured.trackerRateUpdated.length).toBe(1)
    expect(captured.trackerRatesRefreshed.length).toBe(1)
    expect(captured.trackerOfflineQueue.length).toBe(1)
    expect(captured.trackerSyncStatus.length).toBe(1)
    expect(captured.detailsUpdated.length).toBe(1)
    expect(captured.legacyRateUpdated.length).toBe(0)
    expect(captured.legacyRatesRefreshed.length).toBe(0)
    expect(captured.legacyOfflineQueue.length).toBe(0)
    expect(captured.legacySyncStatus.length).toBe(0)
  })

  it('an anilist event leaves the facade untouched', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    await vi.waitFor(() => expect(store.offlineQueueLength).toBe(4))
    captured.rateUpdated[0](mkRate(100, 3))
    const rates = store.rates
    const syncStatus = store.syncStatus

    const anilistEntry = { ...entryOf(mkRate(200, 1)), trackerId: 'anilist' as const }
    captured.trackerRateUpdated[0]({ trackerId: 'anilist', entry: anilistEntry })
    captured.trackerRatesRefreshed[0]({ trackerId: 'anilist', entries: [anilistEntry] })
    captured.trackerOfflineQueue[0]({ trackerId: 'anilist', length: 9, queuedAfter: {} })
    captured.trackerSyncStatus[0]({
      trackerId: 'anilist',
      status: asTrackerStatus({
        state: 'syncing',
        queueLength: 9,
        lastSyncAt: 5,
        lastSyncError: 'x',
        sessionExpired: true
      })
    })

    expect(store.rates).toBe(rates)
    expect(store.syncStatus).toBe(syncStatus)
    expect(store.offlineQueueLength).toBe(4)
    expect(store.sessionExpired).toBe(false)
  })

  it('a double-emitted pair (legacy then tracker twin, as main sends it) updates rates once', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    let replacements = 0
    watch(
      () => store.rates,
      () => replacements++,
      { flush: 'sync' }
    )
    const emitPair = (raw: ShikiAnimeRateEntry): void => {
      captured.legacyRateUpdated.forEach((l) => l(raw))
      captured.trackerRateUpdated.forEach((l) =>
        l({ trackerId: 'shikimori', entry: entryOf(raw), raw })
      )
    }
    emitPair(mkRate(100, 3))
    expect(replacements).toBe(1)
    expect(store.rates.length).toBe(1)

    const refreshed = [mkRate(50, 5)]
    captured.legacyRatesRefreshed.forEach((l) => l(refreshed))
    captured.trackerRatesRefreshed.forEach((l) =>
      l({ trackerId: 'shikimori', entries: refreshed.map(entryOf), raw: refreshed })
    )
    expect(replacements).toBe(2)
    expect(store.rateByMalId(50)?.rate.episodes).toBe(5)
  })

  it('takes the sync status without needsSetup', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    captured.trackerSyncStatus[0]({
      trackerId: 'shikimori',
      status: {
        state: 'idle',
        queueLength: 2,
        lastSyncAt: 3,
        lastSyncError: null,
        sessionExpired: false,
        needsSetup: true
      }
    })
    expect(store.syncStatus).toEqual({
      state: 'idle',
      queueLength: 2,
      lastSyncAt: 3,
      lastSyncError: null,
      sessionExpired: false
    })
    expect(store.offlineQueueLength).toBe(2)
  })

  it('loggedIn is false until refreshUser populates user', async () => {
    captured = { ...captured }
    captured.getUser.mockResolvedValueOnce({ id: 42, nickname: 'alice' } as ShikiUser)
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.loggedIn).toBe(false)
    await store.refreshUser()
    expect(store.user).toEqual({ id: 42, nickname: 'alice' })
    expect(store.loggedIn).toBe(true)
  })

  it('upserts a new rate when onShikimoriRateUpdated fires for an unknown malId', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.rates).toEqual([])
    captured.rateUpdated[0](mkRate(100, 3))
    expect(store.rates.length).toBe(1)
    expect(store.rateByMalId(100)?.rate.episodes).toBe(3)
  })

  it('replaces the matching rate when onShikimoriRateUpdated fires for a known malId', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    captured.rateUpdated[0](mkRate(100, 3))
    captured.rateUpdated[0](mkRate(100, 7))
    expect(store.rates.length).toBe(1)
    expect(store.rateByMalId(100)?.rate.episodes).toBe(7)
  })

  it('replaces rates wholesale on onShikimoriRatesRefreshed', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    captured.rateUpdated[0](mkRate(1, 1))
    captured.ratesRefreshed[0]([mkRate(50, 5), mkRate(60, 6)])
    expect(store.rates.length).toBe(2)
    expect(store.rateByMalId(1)).toBeNull()
    expect(store.rateByMalId(50)?.rate.episodes).toBe(5)
  })

  it('upserts into animeDetails on onShikimoriAnimeDetailsUpdated', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.animeDetailsByMalId(99)).toBeNull()
    captured.detailsUpdated[0]({
      malId: 99,
      details: { id: 99, name: 'X' } as unknown as ShikiAnimeDetails
    })
    expect(store.animeDetailsByMalId(99)?.id).toBe(99)
  })

  it('updates offlineQueueLength on onShikimoriOfflineQueueChanged', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.offlineQueueLength).toBe(0)
    captured.offlineQueue[0]({ length: 11 })
    expect(store.offlineQueueLength).toBe(11)
  })

  it('refreshSyncStatus pulls IPC + mirrors queueLength to offlineQueueLength', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    await store.refreshSyncStatus()
    expect(store.syncStatus.queueLength).toBe(4)
    expect(store.offlineQueueLength).toBe(4)
  })

  // #244: the flag is persisted in the main process, so the only thing that
  // reaches a freshly launched app is this init pull — a broadcast-only design
  // leaves the banner invisible until the next failed request.
  it('pulls the sync status on init, so a persisted sessionExpired reaches the UI', async () => {
    captured.getSyncStatus.mockResolvedValue({
      state: 'idle',
      queueLength: 2,
      lastSyncAt: 0,
      lastSyncError: null,
      sessionExpired: true
    })
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()

    expect(captured.getSyncStatus).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(store.sessionExpired).toBe(true))
    expect(store.offlineQueueLength).toBe(2)
  })

  it('sessionExpired mirrors the sync-status broadcast in both directions', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.sessionExpired).toBe(false)

    captured.syncStatus[0]({
      state: 'idle',
      queueLength: 1,
      lastSyncAt: 0,
      lastSyncError: 'Shikimori session expired',
      sessionExpired: true
    })
    expect(store.sessionExpired).toBe(true)

    captured.syncStatus[0]({
      state: 'idle',
      queueLength: 0,
      lastSyncAt: 1,
      lastSyncError: null,
      sessionExpired: false
    })
    expect(store.sessionExpired).toBe(false)
  })

  it('triggerSync forwards to the IPC bridge', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    await store.triggerSync()
    expect(captured.triggerSync).toHaveBeenCalledTimes(1)
  })

  it('refreshProfile pulls the profile from the IPC bridge into state', async () => {
    const profile = {
      id: 1,
      nickname: 'alice',
      avatar: '',
      friendsCount: 3,
      lists: [{ status: 'watching', n: 5 }],
      scores: new Array(10).fill(0),
      genres: [],
      stats: { titles: 5, episodes: 50, mean: 8, daysWatched: 0.8 }
    } as ShikimoriProfile
    captured.getProfile.mockResolvedValueOnce(profile)
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.profile).toBeNull()
    await store.refreshProfile()
    expect(store.profile?.stats.episodes).toBe(50)
  })

  it('replaces profile when onShikimoriProfileRefreshed fires', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(captured.profileRefreshed.length).toBe(1)
    captured.profileRefreshed[0]({
      id: 1,
      nickname: 'bob',
      avatar: '',
      friendsCount: 0,
      lists: [],
      scores: new Array(10).fill(0),
      genres: [{ name: 'Action', n: 9 }],
      stats: { titles: 1, episodes: 1, mean: 0, daysWatched: 0 }
    } as ShikimoriProfile)
    expect(store.profile?.nickname).toBe('bob')
    expect(store.profile?.genres[0].name).toBe('Action')
  })

  it('refreshFriends pulls the friend cards from the IPC bridge', async () => {
    const cards = [{ id: 11, nickname: 'alice', online: true } as unknown as ShikiFriendCard]
    captured.getFriends.mockResolvedValueOnce(cards)
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.friends).toEqual([])
    await store.refreshFriends()
    expect(store.friends).toEqual(cards)
  })

  it('refreshFriends coerces a null IPC result to an empty array', async () => {
    captured.getFriends.mockResolvedValueOnce(null)
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    await store.refreshFriends()
    expect(store.friends).toEqual([])
  })

  it('replaces friends when onShikimoriFriendsRefreshed fires', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(captured.friendsRefreshed.length).toBe(1)
    captured.friendsRefreshed[0]([
      { id: 12, nickname: 'bob', online: false } as unknown as ShikiFriendCard
    ])
    expect(store.friends.map((f) => f.nickname)).toEqual(['bob'])
  })

  it('refreshRecommendations pulls the feed and coerces null to an empty array', async () => {
    const recs = [
      {
        malId: 1,
        animeId: 5,
        title: 'X',
        posterUrl: '',
        kind: 'tv',
        communityScore: 8,
        reason: 'r'
      }
    ] as RecommendationEntry[]
    captured.getRecommendations.mockResolvedValueOnce(recs)
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(store.recommendations).toEqual([])
    await store.refreshRecommendations()
    expect(store.recommendations).toEqual(recs)

    captured.getRecommendations.mockResolvedValueOnce(null)
    await store.refreshRecommendations()
    expect(store.recommendations).toEqual([])
  })

  it('replaces recommendations when onShikimoriRecommendationsRefreshed fires', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    expect(captured.recommendationsRefreshed.length).toBe(1)
    captured.recommendationsRefreshed[0]([
      {
        malId: 9,
        animeId: null,
        title: 'Steins;Gate',
        posterUrl: '',
        kind: 'tv',
        communityScore: 9,
        reason: 'Because you liked «X»'
      }
    ] as RecommendationEntry[])
    expect(store.recommendations.map((r) => r.title)).toEqual(['Steins;Gate'])
  })

  it('rateByMalId returns null for a falsy malId', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    captured.rateUpdated[0](mkRate(100, 1))
    expect(store.rateByMalId(0)).toBeNull()
  })

  // #707: the facade reads no `shikiAnime.*`. A legacy null-`target_id` row's
  // MAL id comes from the codec's normalized `malId` (useTrackersStore).
  it('rateByMalId matches on rate.target_id only, never shikiAnime.id', async () => {
    const { useShikimoriStore } = await import('../../../src/renderer/src/stores/shikimori')
    const store = useShikimoriStore()
    const legacyEntry = {
      rate: { id: 1, target_id: null, episodes: 9, status: 'completed', score: 10 },
      shikiAnime: { id: 54595 },
      smotretAnime: null
    } as unknown as ShikiAnimeRateEntry
    captured.ratesRefreshed[0]([legacyEntry])
    expect(store.rateByMalId(54595)).toBeNull()
  })
})
