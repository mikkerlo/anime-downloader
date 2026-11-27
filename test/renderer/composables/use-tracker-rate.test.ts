import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useShikimoriStore } from '../../../src/renderer/src/stores/shikimori'
import { useTrackersStore } from '../../../src/renderer/src/stores/trackers'
import { useTrackerRate } from '../../../src/renderer/src/composables/use-tracker-rate'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

type Listener<T> = (data: T) => void

let listeners: {
  accountsChanged: Listener<TrackerAccountsState>[]
  queueChanged: Listener<TrackerOfflineQueueChangedEvent>[]
}

const emit = {
  accountsChanged: (e: TrackerAccountsState) => listeners.accountsChanged.forEach((l) => l(e)),
  queueChanged: (e: TrackerOfflineQueueChangedEvent) => listeners.queueChanged.forEach((l) => l(e))
}

function account(trackerId: TrackerId, userId: number | null): TrackerAccount {
  return {
    trackerId,
    user: userId === null ? null : { id: userId, nickname: `u${userId}`, avatar: null },
    hasCredentials: userId !== null,
    sessionExpired: false,
    needsSetup: false,
    credentialState: userId !== null ? 'ok' : 'none'
  }
}

function accountsState(connected: TrackerId[], primary: TrackerId | null = connected[0] ?? null) {
  const ids: TrackerId[] = ['shikimori', 'anilist', 'mal']
  return {
    accounts: ids.map((id, i) => account(id, connected.includes(id) ? i + 1 : null)),
    primary,
    mirror: {},
    featureSources: {},
    newTrackerCardsEnabled: false
  } satisfies TrackerAccountsState
}

function values(
  episodes: number,
  status: ShikiUserRateStatus = 'watching',
  score = 0,
  rewatches = 0
): TrackerRateValues {
  return { episodes, status, score, rewatches }
}

function status(): TrackerSyncStatus {
  return {
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false,
    needsSetup: false
  }
}

type ApiFns = Record<string, ReturnType<typeof vi.fn>>

let api: ApiFns

function installApi(
  opts: {
    accounts?: TrackerAccountsState | Promise<TrackerAccountsState>
    overrides?: ApiFns
  } = {}
): void {
  listeners = { accountsChanged: [], queueChanged: [] }
  const noop = (): Unsubscribe => () => {}
  api = {
    trackerListAccounts: vi.fn(async () => opts.accounts ?? accountsState(['shikimori'])),
    trackerGetRates: vi.fn(async (trackerId: TrackerId) => ({
      trackerId,
      entries: [],
      queuedAfter: {}
    })),
    trackerGetSyncStatus: vi.fn(async () => status()),
    trackerGetOfflineQueueLength: vi.fn(async () => 0),
    trackerGetRate: vi.fn(async () => ({ values: null, stale: false })),
    trackerUpdateRate: vi.fn(async (_malId: number, change: TrackerRateValues) => change),
    trackerTriggerSync: vi.fn(async () => {}),
    shikimoriGetUser: vi.fn(async () => null),
    shikimoriGetFriendsRates: vi.fn(async () => []),
    shikimoriGetAnimeDetails: vi.fn(async () => null),
    shikimoriGetSyncStatus: vi.fn(async () => status()),
    ...opts.overrides
  }
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      ...api,
      onTrackerAccountsChanged: (cb: Listener<TrackerAccountsState>) => {
        listeners.accountsChanged.push(cb)
        return noop()
      },
      onTrackerOfflineQueueChanged: (cb: Listener<TrackerOfflineQueueChangedEvent>) => {
        listeners.queueChanged.push(cb)
        return noop()
      },
      onTrackerRateUpdated: noop,
      onTrackerRatesRefreshed: noop,
      onTrackerSyncStatus: noop,
      onShikimoriProfileRefreshed: noop,
      onShikimoriFriendsRefreshed: noop,
      onShikimoriRecommendationsRefreshed: noop,
      onShikimoriAnimeDetailsUpdated: noop
    }
  }
}

function mkAnime(
  opts: { id?: number; malId?: number; numberOfEpisodes?: number } = {}
): AnimeDetail {
  return {
    id: opts.id ?? 1,
    myAnimeListId: opts.malId ?? 99,
    numberOfEpisodes: opts.numberOfEpisodes ?? 12
  } as unknown as AnimeDetail
}

/** A fresh pinia; with `settle`, the trackers store's first accounts read lands first. */
async function makeRate(opts: { anime?: AnimeDetail | null; settle?: boolean } = {}): Promise<{
  s: ReturnType<typeof useTrackerRate>
  trackers: ReturnType<typeof useTrackersStore>
}> {
  setActivePinia(createPinia())
  const trackers = useTrackersStore()
  const shikimoriStore = useShikimoriStore()
  if (opts.settle !== false) await flush()
  const s = useTrackerRate({
    anime: ref<AnimeDetail | null>(opts.anime === undefined ? null : opts.anime),
    shikimoriStore,
    trackersStore: trackers
  })
  return { s, trackers }
}

const loadRelated = (): ReturnType<typeof vi.fn> => vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  installApi()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useTrackerRate — initial state', () => {
  it('starts with idle defaults, and loading', async () => {
    const { s } = await makeRate()
    expect(s.shikiUser.value).toBeNull()
    expect(s.rate.value).toBeNull()
    expect(s.rateStatus.value).toBe('planned')
    expect(s.rateEpisodes.value).toBe(0)
    expect(s.rateScore.value).toBe(0)
    expect(s.rateRewatches.value).toBe(0)
    expect(s.loading.value).toBe(true)
    expect(s.saving.value).toBe(false)
    expect(s.saveError.value).toBe('')
    expect(s.shikiUserChecked.value).toBe(false)
    expect(s.friendsRates.value).toEqual([])
    expect(s.descExpanded.value).toBe(false)
  })

  it('shikiDetailsDescription strips BBCode tags', async () => {
    const { s } = await makeRate()
    s.shikiDetails.value = {
      description: '[b]Bold[/b] world [url=foo]link[/url]'
    } as unknown as ShikiAnimeDetails
    expect(s.shikiDetailsDescription.value).toBe('Bold world link')
  })

  it('shikiDetailsDescription strips HTML when description_html is the source', async () => {
    const { s } = await makeRate()
    s.shikiDetails.value = {
      description: '',
      description_html: '<p>Hello <b>world</b></p>'
    } as unknown as ShikiAnimeDetails
    expect(s.shikiDetailsDescription.value).toBe('Hello world')
  })
})

describe('useTrackerRate — auto-status from rateEpisodes', () => {
  it('flips to completed when reaching numberOfEpisodes', async () => {
    const { s } = await makeRate({ anime: mkAnime({ numberOfEpisodes: 12 }) })
    s.rateStatus.value = 'watching'
    s.rateEpisodes.value = 12
    await nextTick()
    expect(s.rateStatus.value).toBe('completed')
  })

  it('flips planned → watching on first episode', async () => {
    const { s } = await makeRate({ anime: mkAnime() })
    s.rateStatus.value = 'planned'
    s.rateEpisodes.value = 1
    await nextTick()
    expect(s.rateStatus.value).toBe('watching')
  })

  it('flips completed → rewatching when episodes change again', async () => {
    const { s } = await makeRate({ anime: mkAnime() })
    s.rateStatus.value = 'completed'
    s.rateEpisodes.value = 5
    await nextTick()
    expect(s.rateStatus.value).toBe('rewatching')
  })

  it('does not nudge when status is dropped or on_hold', async () => {
    const { s } = await makeRate({ anime: mkAnime() })
    s.rateStatus.value = 'on_hold'
    s.rateEpisodes.value = 3
    await nextTick()
    expect(s.rateStatus.value).toBe('on_hold')
  })
})

describe('useTrackerRate — loadTrackerData', () => {
  it('loads user then short-circuits without MAL id, clearing loading with no rate call', async () => {
    installApi({ overrides: { shikimoriGetUser: vi.fn(async () => ({ id: 1 })) } })
    const related = loadRelated()
    const { s } = await makeRate({ anime: { id: 1 } as unknown as AnimeDetail })
    expect(s.loading.value).toBe(true)
    await s.loadTrackerData(related)
    expect(s.shikiUserChecked.value).toBe(true)
    expect(s.shikiUser.value?.id).toBe(1)
    expect(related).not.toHaveBeenCalled()
    expect(api.trackerGetRate).not.toHaveBeenCalled()
    expect(s.loading.value).toBe(false)
    expect(s.resumeProgress.value.loading).toBe(false)
  })

  it('a Shikimori primary: loads rate + friends + details + related when the user is signed in', async () => {
    const friends: ShikiFriendRate[] = [{ nickname: 'F' } as unknown as ShikiFriendRate]
    const details = { description: 'd' } as unknown as ShikiAnimeDetails
    installApi({
      overrides: {
        shikimoriGetUser: vi.fn(async () => ({ id: 1 })),
        trackerGetRate: vi.fn(async () => ({ values: values(3, 'watching', 7), stale: false })),
        shikimoriGetFriendsRates: vi.fn(async () => friends),
        shikimoriGetAnimeDetails: vi.fn(async () => details)
      }
    })
    const related = loadRelated()
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    await s.loadTrackerData(related)
    expect(related).toHaveBeenCalledWith(99)
    expect(api.trackerGetRate).toHaveBeenCalledWith('shikimori', 99)
    expect(s.rate.value).toEqual({ values: values(3, 'watching', 7), stale: false })
    expect(s.rateStatus.value).toBe('watching')
    expect(s.rateEpisodes.value).toBe(3)
    expect(s.rateScore.value).toBe(7)
    expect(s.friendsRates.value).toEqual(friends)
    expect(s.shikiDetails.value).toEqual(details)
    expect(s.loading.value).toBe(false)
    expect(s.friendsLoading.value).toBe(false)
    expect(s.rateStale.value).toBe(false)
    expect(s.resumeProgress.value).toEqual({
      checked: true,
      hasAccount: true,
      loading: false,
      status: 'watching',
      episodes: 3
    })
  })

  // #570: main answers get-rate from its cached list offline, flagged stale.
  it('fills the form from a cached rate and reports it stale; a save clears it', async () => {
    installApi({
      overrides: {
        shikimoriGetUser: vi.fn(async () => ({ id: 1 })),
        trackerGetRate: vi.fn(async () => ({ values: values(12, 'completed', 8, 1), stale: true }))
      }
    })
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    await s.loadTrackerData(loadRelated())
    expect(s.rateStale.value).toBe(true)
    expect(s.rateStatus.value).toBe('completed')
    expect(s.rateEpisodes.value).toBe(12)

    await s.save()
    expect(s.rateStale.value).toBe(false)
  })

  it('clears shikiUserChecked even when getUser throws', async () => {
    installApi({ overrides: { shikimoriGetUser: vi.fn().mockRejectedValue(new Error('boom')) } })
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { s } = await makeRate({ anime: { id: 1 } as unknown as AnimeDetail })
    await s.loadTrackerData(loadRelated())
    expect(s.shikiUserChecked.value).toBe(true)
    expect(s.shikiUser.value).toBeNull()
    expect(consoleErr).toHaveBeenCalled()
  })

  it('an AniList primary loads through trackerGetRate("anilist", …), with no Shikimori friends or details', async () => {
    installApi({
      accounts: accountsState(['anilist']),
      overrides: {
        trackerGetRate: vi.fn(async () => ({
          values: values(7, 'watching', 8),
          stale: false,
          mediaId: 21
        }))
      }
    })
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    await s.loadTrackerData(loadRelated())
    expect(api.trackerGetRate).toHaveBeenCalledTimes(1)
    expect(api.trackerGetRate).toHaveBeenCalledWith('anilist', 99)
    expect(s.rateEpisodes.value).toBe(7)
    expect(s.rateScore.value).toBe(8)
    expect(s.mediaId.value).toBe(21)
    expect(s.shikiUser.value).toBeNull()
    expect(s.shikiUserChecked.value).toBe(true)
    expect(api.shikimoriGetFriendsRates).not.toHaveBeenCalled()
    expect(api.shikimoriGetAnimeDetails).not.toHaveBeenCalled()
    expect(s.resumeProgress.value).toMatchObject({ hasAccount: true, loading: false, episodes: 7 })
  })

  // Step 8: friends and details stay on the Shikimori user, not on the primary.
  it('a Shikimori user beside an AniList primary still loads the friends and details', async () => {
    installApi({
      accounts: accountsState(['shikimori', 'anilist'], 'anilist'),
      overrides: { shikimoriGetUser: vi.fn(async () => ({ id: 1 })) }
    })
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    await s.loadTrackerData(loadRelated())
    expect(api.trackerGetRate).toHaveBeenCalledWith('anilist', 99)
    expect(api.shikimoriGetFriendsRates).toHaveBeenCalledWith(99)
    expect(api.shikimoriGetAnimeDetails).toHaveBeenCalledWith(99)
    expect(s.shikiUser.value?.id).toBe(1)
  })

  it('the rate load waits for accountsLoaded, then reads the primary it settled on', async () => {
    const first = deferred<TrackerAccountsState>()
    installApi({ accounts: first.promise })
    const { s, trackers } = await makeRate({ anime: mkAnime({ malId: 99 }), settle: false })
    const done = s.loadTrackerData(loadRelated())
    await flush()
    expect(trackers.accountsLoaded).toBe(false)
    expect(s.shikiUserChecked.value).toBe(true)
    expect(api.trackerGetRate).not.toHaveBeenCalled()
    expect(s.loading.value).toBe(true)

    first.resolve(accountsState(['mal']))
    await done
    expect(api.trackerGetRate).toHaveBeenCalledTimes(1)
    expect(api.trackerGetRate).toHaveBeenCalledWith('mal', 99)
    expect(s.loading.value).toBe(false)
  })

  // PR #728 review: the wait for `accountsLoaded` dies with the page.
  it('an unmount before the accounts load leaves no later rate load', async () => {
    const first = deferred<TrackerAccountsState>()
    installApi({ accounts: first.promise })
    setActivePinia(createPinia())
    const trackers = useTrackersStore()
    const scope = effectScope()
    const s = scope.run(() =>
      useTrackerRate({
        anime: ref<AnimeDetail | null>(mkAnime({ malId: 99 })),
        shikimoriStore: useShikimoriStore(),
        trackersStore: trackers
      })
    )!
    void s.loadTrackerData(loadRelated())
    await flush()
    expect(s.shikiUserChecked.value).toBe(true)
    expect(api.trackerGetRate).not.toHaveBeenCalled()

    scope.stop()
    first.resolve(accountsState(['shikimori']))
    await flush()
    expect(trackers.accountsLoaded).toBe(true)
    expect(api.trackerGetRate).not.toHaveBeenCalled()
  })

  it('values: null leaves the form empty, logs nothing, and still takes stale from the result', async () => {
    installApi({
      overrides: { trackerGetRate: vi.fn(async () => ({ values: null, stale: true })) }
    })
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    await s.loadTrackerData(loadRelated())
    expect(s.rateStatus.value).toBe('planned')
    expect(s.rateEpisodes.value).toBe(0)
    expect(s.rateScore.value).toBe(0)
    expect(s.rateRewatches.value).toBe(0)
    expect(consoleErr).not.toHaveBeenCalled()
    expect(s.rateStale.value).toBe(true)
    expect(s.resumeProgress.value.status).toBeNull()
    expect(s.loading.value).toBe(false)
  })

  it('loading is true straight after creation with accountsLoaded already true, and clears with no rate call when there is no primary', async () => {
    installApi({ accounts: accountsState([]) })
    const { s, trackers } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    expect(trackers.accountsLoaded).toBe(true)
    expect(s.loading.value).toBe(true)
    expect(s.resumeProgress.value.loading).toBe(true)
    await s.loadTrackerData(loadRelated())
    expect(api.trackerGetRate).not.toHaveBeenCalled()
    expect(s.loading.value).toBe(false)
    expect(s.resumeProgress.value).toMatchObject({ checked: true, hasAccount: false })
  })

  it('a title with no MAL id never reports loading to Continue', async () => {
    const { s } = await makeRate({ anime: { id: 1 } as unknown as AnimeDetail })
    expect(s.loading.value).toBe(true)
    expect(s.resumeProgress.value.loading).toBe(false)
  })
})

describe('useTrackerRate — primary switch (#704 §9)', () => {
  it('a rateFor change after a primary switch with a queued after refills the form with the queued values', async () => {
    installApi({
      accounts: accountsState(['shikimori', 'anilist'], 'shikimori'),
      overrides: {
        trackerGetRate: vi.fn(async (id: TrackerId) => ({
          values: id === 'shikimori' ? values(3) : values(5),
          stale: false
        }))
      }
    })
    const { s, trackers } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    await s.loadTrackerData(loadRelated())
    expect(s.rateEpisodes.value).toBe(3)

    s.rateEpisodes.value = 9 // an unsaved edit, dropped by the switch
    emit.accountsChanged(accountsState(['shikimori', 'anilist'], 'anilist'))
    await flush()
    expect(trackers.primary).toBe('anilist')
    expect(api.trackerGetRate).toHaveBeenLastCalledWith('anilist', 99)
    expect(s.rateEpisodes.value).toBe(5)
    expect(api.trackerGetSyncStatus).toHaveBeenCalledWith('anilist')
    expect(api.trackerGetOfflineQueueLength).toHaveBeenCalledWith('anilist')

    emit.queueChanged({
      trackerId: 'anilist',
      length: 1,
      queuedAfter: { 99: values(6, 'watching', 4) }
    })
    await flush()
    expect(trackers.rateFor('anilist', 99)?.episodes).toBe(6)
    expect(s.rateEpisodes.value).toBe(6)
    expect(s.rateScore.value).toBe(4)
    expect(s.resumeProgress.value.episodes).toBe(6)
  })

  // PR #728 review: `tracker:get-rate` answers the remote or cached row with no
  // queued `after` on top. Switching to a primary whose queue already holds a
  // change, its reply must not overwrite the projection, or a Save would write
  // the remote value back over the user's own queued change.
  it('a switch to a primary with a queued after keeps the queued values once its get-rate reply lands', async () => {
    const anilist = deferred<TrackerRateResult>()
    installApi({
      accounts: accountsState(['shikimori', 'anilist'], 'shikimori'),
      overrides: {
        trackerGetRate: vi.fn((id: TrackerId) =>
          id === 'shikimori'
            ? Promise.resolve({ values: values(3), stale: false })
            : anilist.promise
        )
      }
    })
    const { s, trackers } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    await s.loadTrackerData(loadRelated())
    expect(s.rateEpisodes.value).toBe(3)

    emit.queueChanged({
      trackerId: 'anilist',
      length: 1,
      queuedAfter: { 99: values(6, 'on_hold', 4) }
    })
    await flush()
    emit.accountsChanged(accountsState(['shikimori', 'anilist'], 'anilist'))
    await flush()
    expect(s.rateEpisodes.value).toBe(6)

    anilist.resolve({ values: values(5, 'watching', 7), stale: true, mediaId: 21 })
    await flush()
    expect(trackers.rateFor('anilist', 99)?.episodes).toBe(6)
    expect(s.rateEpisodes.value).toBe(6)
    expect(s.rateStatus.value).toBe('on_hold')
    expect(s.rateScore.value).toBe(4)
    expect(s.resumeProgress.value.status).toBe('on_hold')
    expect(s.resumeProgress.value.episodes).toBe(6)
    expect(s.resumeProgress.value.loading).toBe(false)
    // The reply's own fields still apply.
    expect(s.rateStale.value).toBe(true)
    expect(s.mediaId.value).toBe(21)
  })

  // The same projection on mount: a title whose change is still queued opens
  // with the queued values, not the remote ones a live read returns.
  it('a mount with a queued after for the title shows the queued values, not the remote reply', async () => {
    installApi({
      accounts: accountsState(['shikimori']),
      overrides: {
        trackerGetRate: vi.fn(async () => ({ values: values(5, 'watching', 7), stale: false }))
      }
    })
    setActivePinia(createPinia())
    const trackers = useTrackersStore()
    await flush()
    emit.queueChanged({
      trackerId: 'shikimori',
      length: 1,
      queuedAfter: { 99: values(6, 'on_hold', 4) }
    })
    const s = useTrackerRate({
      anime: ref<AnimeDetail | null>(mkAnime({ malId: 99 })),
      shikimoriStore: useShikimoriStore(),
      trackersStore: trackers
    })
    await s.loadTrackerData(loadRelated())
    expect(s.rateEpisodes.value).toBe(6)
    expect(s.rateStatus.value).toBe('on_hold')
    expect(s.resumeProgress.value.status).toBe('on_hold')
  })

  it('a late response from the old primary never overwrites the new primary form', async () => {
    const shiki = deferred<TrackerRateResult>()
    const anilist = deferred<TrackerRateResult>()
    installApi({
      accounts: accountsState(['shikimori', 'anilist'], 'shikimori'),
      overrides: {
        trackerGetRate: vi.fn((id: TrackerId) =>
          id === 'shikimori' ? shiki.promise : anilist.promise
        )
      }
    })
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    const done = s.loadTrackerData(loadRelated())
    await flush()
    expect(api.trackerGetRate).toHaveBeenCalledWith('shikimori', 99)

    emit.accountsChanged(accountsState(['shikimori', 'anilist'], 'anilist'))
    await flush()
    expect(api.trackerGetRate).toHaveBeenLastCalledWith('anilist', 99)

    anilist.resolve({ values: values(5, 'watching', 6), stale: false })
    await flush()
    shiki.resolve({ values: values(2, 'on_hold', 3), stale: true })
    await done
    await flush()
    expect(s.rateEpisodes.value).toBe(5)
    expect(s.rateStatus.value).toBe('watching')
    expect(s.rateScore.value).toBe(6)
    expect(s.rateStale.value).toBe(false)
  })

  it('a dropped old-primary response never clears loading: it stays true until the new primary lands', async () => {
    const shiki = deferred<TrackerRateResult>()
    const anilist = deferred<TrackerRateResult>()
    installApi({
      accounts: accountsState(['shikimori', 'anilist'], 'shikimori'),
      overrides: {
        trackerGetRate: vi.fn((id: TrackerId) =>
          id === 'shikimori' ? shiki.promise : anilist.promise
        )
      }
    })
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    void s.loadTrackerData(loadRelated())
    await flush()
    emit.accountsChanged(accountsState(['shikimori', 'anilist'], 'anilist'))
    await flush()

    shiki.resolve({ values: values(2), stale: false })
    await flush()
    expect(s.resumeProgress.value.loading).toBe(true)
    expect(s.rateEpisodes.value).toBe(0)

    anilist.resolve({ values: values(5), stale: false })
    await flush()
    expect(s.resumeProgress.value.loading).toBe(false)
    expect(s.rateEpisodes.value).toBe(5)
  })
})

describe('useTrackerRate — save', () => {
  it('persists via tracker:update-rate and updates rate/rewatches', async () => {
    const update = vi.fn(async () => values(5, 'watching', 8, 2))
    installApi({ overrides: { trackerUpdateRate: update } })
    const { s } = await makeRate({ anime: mkAnime({ malId: 99 }) })
    s.rateEpisodes.value = 5
    s.rateStatus.value = 'watching'
    s.rateScore.value = 8
    s.rateRewatches.value = 1
    await s.save()
    expect(update).toHaveBeenCalledWith(99, values(5, 'watching', 8, 1))
    expect(s.rate.value).toEqual({ values: values(5, 'watching', 8, 2), stale: false })
    expect(s.rateRewatches.value).toBe(2)
    expect(s.saveError.value).toBe('')
  })

  it('captures error message on IPC failure', async () => {
    installApi({
      overrides: { trackerUpdateRate: vi.fn().mockRejectedValue(new Error('network')) }
    })
    const { s } = await makeRate({ anime: mkAnime() })
    await s.save()
    expect(s.saveError.value).toMatch(/network/i)
    expect(s.saving.value).toBe(false)
  })

  it('no-ops without a MAL id', async () => {
    const { s } = await makeRate({ anime: { id: 1 } as unknown as AnimeDetail })
    await s.save()
    expect(api.trackerUpdateRate).not.toHaveBeenCalled()
  })
})

describe('useTrackerRate — triggerSyncNow', () => {
  it('triggers the primary', async () => {
    installApi({ accounts: accountsState(['anilist']) })
    const { s } = await makeRate()
    await s.triggerSyncNow()
    expect(api.trackerTriggerSync).toHaveBeenCalledWith('anilist')
  })

  it('a Shikimori primary triggers Shikimori', async () => {
    const { s } = await makeRate()
    await s.triggerSyncNow()
    expect(api.trackerTriggerSync).toHaveBeenCalledWith('shikimori')
  })
})
