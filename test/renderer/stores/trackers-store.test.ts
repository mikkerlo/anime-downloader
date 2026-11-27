import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'
import { useTrackersStore } from '../../../src/renderer/src/stores/trackers'

type Listener<T> = (data: T) => void

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let listeners: {
  rateUpdated: Listener<TrackerRateUpdatedEvent>[]
  ratesRefreshed: Listener<TrackerRatesRefreshedEvent>[]
  syncStatus: Listener<TrackerSyncStatusEvent>[]
  queueChanged: Listener<TrackerOfflineQueueChangedEvent>[]
  accountsChanged: Listener<TrackerAccountsState>[]
  detailsUpdated: Listener<TrackerDetailsUpdatedEvent>[]
}

let api: {
  trackerListAccounts: ReturnType<typeof vi.fn>
  trackerGetRates: ReturnType<typeof vi.fn>
  trackerGetSyncStatus: ReturnType<typeof vi.fn>
  trackerGetRate: ReturnType<typeof vi.fn>
}

function values(episodes: number, status: ShikiUserRateStatus = 'watching'): TrackerRateValues {
  return { episodes, status, score: 0, rewatches: 0 }
}

function entry(trackerId: TrackerId, malId: number, episodes: number): TrackerRateEntry {
  return {
    trackerId,
    malId,
    remoteId: malId + 1000,
    values: values(episodes),
    updatedAt: 1,
    anime: {
      title: `Title ${malId}`,
      poster: null,
      kind: 'tv',
      episodes: 12,
      episodesAired: 12,
      status: 'released'
    },
    smotretAnime: null
  }
}

function account(
  trackerId: TrackerId,
  userId: number | null,
  opts: { hasCredentials?: boolean; sessionExpired?: boolean; needsSetup?: boolean } = {}
): TrackerAccount {
  const hasCredentials = opts.hasCredentials ?? userId !== null
  return {
    trackerId,
    user: userId === null ? null : { id: userId, nickname: `u${userId}`, avatar: null },
    hasCredentials,
    sessionExpired: opts.sessionExpired ?? (userId !== null && !hasCredentials),
    needsSetup: opts.needsSetup ?? false,
    credentialState: hasCredentials ? 'ok' : 'none'
  }
}

function accountsState(
  accounts: TrackerAccount[],
  primary: TrackerId | null = accounts.find((a) => a.user !== null)?.trackerId ?? null
): TrackerAccountsState {
  const ids: TrackerId[] = ['shikimori', 'anilist', 'mal']
  const byId = new Map(accounts.map((a) => [a.trackerId, a]))
  return {
    accounts: ids.map((id) => byId.get(id) ?? account(id, null)),
    primary,
    mirror: {},
    featureSources: {},
    newTrackerCardsEnabled: false
  }
}

function status(over: Partial<TrackerSyncStatus> = {}): TrackerSyncStatus {
  return {
    state: 'idle',
    queueLength: 0,
    lastSyncAt: 0,
    lastSyncError: null,
    sessionExpired: false,
    needsSetup: false,
    ...over
  }
}

function snapshot(
  trackerId: TrackerId,
  entries: TrackerRateEntry[] = [],
  queuedAfter: Record<number, TrackerRateValues> = {}
): TrackerRatesSnapshot {
  return { trackerId, entries, queuedAfter }
}

function installApi(opts: {
  accounts?: TrackerAccountsState | Promise<TrackerAccountsState>
  rates?: Partial<Record<TrackerId, TrackerRatesSnapshot>>
  statuses?: Partial<Record<TrackerId, TrackerSyncStatus>>
}): void {
  listeners = {
    rateUpdated: [],
    ratesRefreshed: [],
    syncStatus: [],
    queueChanged: [],
    accountsChanged: [],
    detailsUpdated: []
  }
  api = {
    trackerListAccounts: vi.fn(async () => opts.accounts ?? accountsState([])),
    trackerGetRates: vi.fn(async (id: TrackerId) => opts.rates?.[id] ?? snapshot(id)),
    trackerGetSyncStatus: vi.fn(async (id: TrackerId) => opts.statuses?.[id] ?? status()),
    trackerGetRate: vi.fn(async (id: TrackerId, malId: number) => ({
      values: values(malId % 100),
      stale: false,
      tag: `${id}:${malId}`
    }))
  }
  const sub =
    <T>(list: Listener<T>[]) =>
    (cb: Listener<T>) => {
      list.push(cb)
      return () => {}
    }
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      ...api,
      onTrackerRateUpdated: sub(listeners.rateUpdated),
      onTrackerRatesRefreshed: sub(listeners.ratesRefreshed),
      onTrackerSyncStatus: sub(listeners.syncStatus),
      onTrackerOfflineQueueChanged: sub(listeners.queueChanged),
      onTrackerAccountsChanged: sub(listeners.accountsChanged),
      onTrackerDetailsUpdated: sub(listeners.detailsUpdated)
    }
  }
}

const emit = {
  rateUpdated: (e: TrackerRateUpdatedEvent) => listeners.rateUpdated.forEach((l) => l(e)),
  ratesRefreshed: (e: TrackerRatesRefreshedEvent) => listeners.ratesRefreshed.forEach((l) => l(e)),
  syncStatus: (e: TrackerSyncStatusEvent) => listeners.syncStatus.forEach((l) => l(e)),
  queueChanged: (e: TrackerOfflineQueueChangedEvent) => listeners.queueChanged.forEach((l) => l(e)),
  accountsChanged: (e: TrackerAccountsState) => listeners.accountsChanged.forEach((l) => l(e)),
  detailsUpdated: (e: TrackerDetailsUpdatedEvent) => listeners.detailsUpdated.forEach((l) => l(e))
}

async function makeStore(): Promise<ReturnType<typeof useTrackersStore>> {
  setActivePinia(createPinia())
  const store = useTrackersStore()
  await flush()
  return store
}

const getRateCalls = (): [TrackerId, number][] =>
  api.trackerGetRate.mock.calls.map((c) => [c[0] as TrackerId, c[1] as number])

const getRatesCalls = (): unknown[][] => api.trackerGetRates.mock.calls

beforeEach(() => {
  installApi({})
})

describe('useTrackersStore — queued overlay', () => {
  it('a primary switch with a pending queue shows the queued values', async () => {
    const both = [account('shikimori', 1), account('anilist', 2)]
    installApi({
      accounts: accountsState(both, 'shikimori'),
      rates: { anilist: snapshot('anilist', [entry('anilist', 100, 7)], { 100: values(8) }) }
    })
    const store = await makeStore()
    expect(store.primary).toBe('shikimori')
    expect(store.primaryRates).toEqual([])

    emit.accountsChanged(accountsState(both, 'anilist'))

    expect(store.primary).toBe('anilist')
    expect(store.primaryRates.map((e) => e.values.episodes)).toEqual([8])
    expect(store.rateFor('anilist', 100)?.episodes).toBe(8)
    // The cache row itself is untouched; only the read is overlaid.
    expect(store.ratesByTracker.anilist?.[0].values.episodes).toBe(7)
  })

  // #707: the list page reads any connected tracker's rows this way.
  it('ratesFor overlays a non-primary tracker’s own queue, and is [] for one with no rows', async () => {
    const both = [account('shikimori', 1), account('anilist', 2)]
    installApi({
      accounts: accountsState(both, 'shikimori'),
      rates: {
        anilist: snapshot('anilist', [entry('anilist', 100, 7), entry('anilist', 200, 1)], {
          100: values(8)
        })
      }
    })
    const store = await makeStore()
    expect(store.ratesFor('anilist').map((e) => [e.malId, e.values.episodes])).toEqual([
      [100, 8],
      [200, 1]
    ])
    expect(store.ratesFor('mal')).toEqual([])
    expect(store.ratesByTracker.anilist?.[0].values.episodes).toBe(7)
  })

  it('the drain, in main emit order (rate first, then queue), never reads the cache-only value', async () => {
    installApi({
      accounts: accountsState([account('anilist', 2)]),
      rates: { anilist: snapshot('anilist', [entry('anilist', 100, 7)], { 100: values(8) }) }
    })
    const store = await makeStore()
    const seen: (number | undefined)[] = []
    const seenPrimary: (number | undefined)[] = []
    watch(
      () => store.rateFor('anilist', 100)?.episodes,
      (v) => seen.push(v),
      { flush: 'sync' }
    )
    watch(
      () => store.primaryRates.find((e) => e.malId === 100)?.values.episodes,
      (v) => seenPrimary.push(v),
      { flush: 'sync' }
    )
    expect(store.rateFor('anilist', 100)?.episodes).toBe(8)

    emit.rateUpdated({ trackerId: 'anilist', entry: entry('anilist', 100, 8) })
    expect(store.rateFor('anilist', 100)?.episodes).toBe(8)
    expect(store.primaryRates[0].values.episodes).toBe(8)

    emit.queueChanged({ trackerId: 'anilist', length: 0, queuedAfter: {} })
    expect(store.rateFor('anilist', 100)?.episodes).toBe(8)
    expect(store.primaryRates[0].values.episodes).toBe(8)

    expect(seen).not.toContain(7)
    expect(seenPrimary).not.toContain(7)
  })

  it('a queue-only title reads its queued values, then null once its create settles, until a wholesale refresh', async () => {
    installApi({
      accounts: accountsState([account('anilist', 2)]),
      rates: { anilist: snapshot('anilist', [entry('anilist', 100, 1)], { 200: values(3) }) }
    })
    const store = await makeStore()
    expect(store.rateFor('anilist', 200)).toEqual(values(3))
    expect(store.primaryRates.map((e) => e.malId)).toEqual([100])

    // The create branch emits no rate update, only the queue change.
    emit.queueChanged({ trackerId: 'anilist', length: 0, queuedAfter: {} })
    expect(store.rateFor('anilist', 200)).toBeNull()
    emit.rateUpdated({ trackerId: 'anilist', entry: entry('anilist', 100, 2) })
    expect(store.rateFor('anilist', 200)).toBeNull()
    expect(store.primaryRates.map((e) => e.malId)).toEqual([100])

    emit.ratesRefreshed({
      trackerId: 'anilist',
      entries: [entry('anilist', 100, 2), entry('anilist', 200, 3)]
    })
    expect(store.rateFor('anilist', 200)?.episodes).toBe(3)
    expect(store.primaryRates.map((e) => e.malId)).toEqual([100, 200])
  })
})

describe('useTrackersStore — account predicates', () => {
  it('session expired: anyAccount stays true, anyActiveSession turns false', async () => {
    installApi({ accounts: accountsState([account('shikimori', 1, { hasCredentials: false })]) })
    let store = await makeStore()
    expect(store.anyAccount).toBe(true)
    expect(store.anyActiveSession).toBe(false)

    installApi({ accounts: accountsState([account('anilist', 2, { hasCredentials: false })]) })
    store = await makeStore()
    expect(store.anyAccount).toBe(true)
    expect(store.anyActiveSession).toBe(false)

    installApi({ accounts: accountsState([]) })
    store = await makeStore()
    expect(store.anyAccount).toBe(false)
    expect(store.anyActiveSession).toBe(false)

    installApi({
      accounts: accountsState([
        account('shikimori', 1),
        account('anilist', 2, { hasCredentials: false })
      ])
    })
    store = await makeStore()
    expect(store.anyAccount).toBe(true)
    expect(store.anyActiveSession).toBe(true)
  })

  it('"connected" is user !== null: a null-user row loads nothing and is not aggregated; an expired one is', async () => {
    installApi({
      accounts: accountsState([
        account('shikimori', 1, { hasCredentials: false }),
        account('anilist', null)
      ]),
      statuses: { shikimori: status({ sessionExpired: true }) }
    })
    const store = await makeStore()
    expect(store.accounts).toHaveLength(3)
    expect(store.connected).toEqual(['shikimori'])
    expect(getRatesCalls()).toEqual([['shikimori']])
    expect(api.trackerGetSyncStatus).toHaveBeenCalledTimes(1)
    expect(api.trackerGetSyncStatus).toHaveBeenCalledWith('shikimori')
    expect(store.aggregateSyncState.trackers.map((r) => r.trackerId)).toEqual(['shikimori'])
    expect(store.aggregateSyncState.state).toBe('session-expired')
  })
})

describe('useTrackersStore — aggregateSyncState', () => {
  it('one tracker reproduces the four sidebar labels', async () => {
    installApi({ accounts: accountsState([account('shikimori', 1)]) })
    const store = await makeStore()
    expect(store.aggregateSyncState.label).toBe('Synced')
    expect(store.aggregateSyncState.state).toBe('synced')

    emit.syncStatus({ trackerId: 'shikimori', status: status({ queueLength: 3 }) })
    expect(store.aggregateSyncState.label).toBe('3 pending')
    expect(store.aggregateSyncState.state).toBe('pending')

    // The queue-changed length moves the count, as offlineQueueLength does today.
    emit.queueChanged({ trackerId: 'shikimori', length: 4, queuedAfter: {} })
    expect(store.aggregateSyncState.label).toBe('4 pending')

    emit.syncStatus({
      trackerId: 'shikimori',
      status: status({ state: 'syncing', queueLength: 4 })
    })
    expect(store.aggregateSyncState.label).toBe('Syncing…')

    emit.syncStatus({
      trackerId: 'shikimori',
      status: status({ state: 'syncing', queueLength: 4, sessionExpired: true })
    })
    expect(store.aggregateSyncState.label).toBe('Session expired')

    emit.syncStatus({ trackerId: 'shikimori', status: status() })
    expect(store.aggregateSyncState.label).toBe('Synced')
  })

  it('two trackers: expired wins, pending counts are summed, needs setup ranks between', async () => {
    installApi({
      accounts: accountsState([account('shikimori', 1), account('anilist', 2)]),
      statuses: {
        shikimori: status({ queueLength: 2 }),
        anilist: status({ queueLength: 3 })
      }
    })
    const store = await makeStore()
    expect(store.aggregateSyncState).toMatchObject({
      state: 'pending',
      label: '5 pending',
      queueLength: 5
    })

    emit.syncStatus({ trackerId: 'shikimori', status: status({ state: 'syncing' }) })
    expect(store.aggregateSyncState.state).toBe('syncing')

    emit.syncStatus({ trackerId: 'anilist', status: status({ needsSetup: true }) })
    expect(store.aggregateSyncState.state).toBe('needs-setup')
    expect(store.aggregateSyncState.label).toBe('Needs setup')

    emit.syncStatus({ trackerId: 'shikimori', status: status({ sessionExpired: true }) })
    expect(store.aggregateSyncState.state).toBe('session-expired')
    expect(store.aggregateSyncState.label).toBe('Session expired')
    expect(store.aggregateSyncState.trackers).toEqual([
      {
        trackerId: 'shikimori',
        state: 'session-expired',
        queueLength: 0,
        sessionExpired: true,
        needsSetup: false
      },
      {
        trackerId: 'anilist',
        state: 'needs-setup',
        queueLength: 0,
        sessionExpired: false,
        needsSetup: true
      }
    ])
  })

  it('the breakdown follows syncByTracker, not the account row', async () => {
    installApi({
      accounts: accountsState([account('anilist', 2, { sessionExpired: false, needsSetup: true })]),
      statuses: { anilist: status({ sessionExpired: true, needsSetup: false }) }
    })
    const store = await makeStore()
    expect(store.aggregateSyncState.trackers[0]).toMatchObject({
      trackerId: 'anilist',
      state: 'session-expired',
      sessionExpired: true,
      needsSetup: false
    })
  })
})

describe('useTrackersStore — accounts lifecycle', () => {
  it('the creation-time pull fills accounts and primary, then loads each connected tracker with no status', async () => {
    installApi({
      accounts: accountsState([account('shikimori', 1), account('mal', 3)], 'mal'),
      rates: { mal: snapshot('mal', [entry('mal', 5, 2)]) }
    })
    const store = await makeStore()
    expect(store.primary).toBe('mal')
    expect(store.connected).toEqual(['shikimori', 'mal'])
    expect(getRatesCalls()).toEqual([['shikimori'], ['mal']])
    expect(store.primaryRates.map((e) => e.malId)).toEqual([5])
  })

  it('loads a newly connected tracker, drops a disconnected one, ignores an unconnected tracker', async () => {
    installApi({
      accounts: accountsState([account('shikimori', 1)]),
      rates: {
        shikimori: snapshot('shikimori', [entry('shikimori', 1, 1)], { 1: values(2) }),
        anilist: snapshot('anilist', [entry('anilist', 9, 4)], { 9: values(5) })
      }
    })
    const store = await makeStore()
    expect(getRatesCalls()).toEqual([['shikimori']])

    emit.rateUpdated({ trackerId: 'mal', entry: entry('mal', 77, 1) })
    emit.queueChanged({ trackerId: 'mal', length: 1, queuedAfter: { 77: values(2) } })
    emit.syncStatus({ trackerId: 'mal', status: status({ queueLength: 1 }) })
    expect(store.ratesByTracker.mal).toBeUndefined()
    expect(store.rateFor('mal', 77)).toBeNull()
    expect(store.syncByTracker.mal).toBeUndefined()

    emit.accountsChanged(
      accountsState([account('shikimori', 1), account('anilist', 2)], 'shikimori')
    )
    await flush()
    expect(getRatesCalls()).toEqual([['shikimori'], ['anilist']])
    expect(api.trackerGetSyncStatus).toHaveBeenCalledWith('anilist')
    expect(store.rateFor('anilist', 9)?.episodes).toBe(5)

    emit.accountsChanged(accountsState([account('anilist', 2)], 'anilist'))
    expect(store.ratesByTracker.shikimori).toBeUndefined()
    expect(store.queuedAfterByTracker.shikimori).toBeUndefined()
    expect(store.rateFor('shikimori', 1)).toBeNull()
    expect(store.primaryRates.map((e) => e.malId)).toEqual([9])
  })

  it('an account switch on a tracker that stays connected drops at once, then reloads', async () => {
    const second = deferred<TrackerRatesSnapshot>()
    installApi({
      accounts: accountsState([account('shikimori', 1)]),
      rates: { shikimori: snapshot('shikimori', [entry('shikimori', 50, 3)], { 50: values(4) }) }
    })
    const store = await makeStore()
    store.holdTitle(50)
    await flush()
    expect(store.rateFor('shikimori', 50)?.episodes).toBe(4)
    expect(store.rateStateFor('shikimori', 50)).not.toBeNull()
    expect(getRateCalls()).toEqual([['shikimori', 50]])

    api.trackerGetRates.mockReturnValueOnce(second.promise)
    emit.accountsChanged(accountsState([account('shikimori', 7)]))

    // Before B's snapshot arrives, A's state is gone.
    expect(store.ratesByTracker.shikimori).toBeUndefined()
    expect(store.rateFor('shikimori', 50)).toBeNull()
    expect(store.rateStateFor('shikimori', 50)).toBeNull()
    expect(getRatesCalls()).toEqual([['shikimori'], ['shikimori']])
    await flush()
    expect(getRateCalls()).toEqual([
      ['shikimori', 50],
      ['shikimori', 50]
    ])

    second.resolve(snapshot('shikimori', [entry('shikimori', 60, 1)]))
    await flush()
    expect(store.primaryRates.map((e) => e.malId)).toEqual([60])
  })

  it('an ACCOUNTS_CHANGED that lands before the first list read wins over the older read', async () => {
    const first = deferred<TrackerAccountsState>()
    installApi({ accounts: first.promise })
    const store = await makeStore()
    emit.accountsChanged(accountsState([account('anilist', 2)]))
    first.resolve(accountsState([]))
    await flush()
    expect(store.primary).toBe('anilist')
    expect(store.anyAccount).toBe(true)
  })

  it('tolerates failing init pulls', async () => {
    installApi({ accounts: accountsState([account('anilist', 2)]) })
    api.trackerGetRates.mockRejectedValue(new Error('no instance'))
    api.trackerGetSyncStatus.mockRejectedValue(new Error('no instance'))
    const store = await makeStore()
    expect(store.anyAccount).toBe(true)
    expect(store.ratesByTracker.anilist).toBeUndefined()

    installApi({})
    api.trackerListAccounts.mockRejectedValue(new Error('not ready'))
    const empty = await makeStore()
    expect(empty.accounts).toEqual([])
    expect(empty.primary).toBeNull()
  })
})

// The detail panel's `!accountsLoaded` gate half (#704): the flag, `accounts`
// and `primary` must settle in one step, or the panel pops in late.
describe('useTrackersStore — accountsLoaded', () => {
  it('is false until the first list read resolves, then true in the same step that fills accounts and primary', async () => {
    const first = deferred<TrackerAccountsState>()
    installApi({ accounts: first.promise })
    setActivePinia(createPinia())
    const store = useTrackersStore()
    const seen: { primary: TrackerId | null; anyAccount: boolean }[] = []
    watch(
      () => store.accountsLoaded,
      (loaded) => {
        if (loaded) seen.push({ primary: store.primary, anyAccount: store.anyAccount })
      },
      { flush: 'sync' }
    )
    await flush()
    expect(store.accountsLoaded).toBe(false)
    expect(store.primary).toBeNull()

    first.resolve(accountsState([account('anilist', 2)]))
    await flush()
    expect(store.accountsLoaded).toBe(true)
    expect(seen).toEqual([{ primary: 'anilist', anyAccount: true }])
  })

  it('flips on an ACCOUNTS_CHANGED that lands before the first read, and stays true when the accounts empty', async () => {
    const first = deferred<TrackerAccountsState>()
    installApi({ accounts: first.promise })
    const store = await makeStore()
    expect(store.accountsLoaded).toBe(false)
    emit.accountsChanged(accountsState([account('shikimori', 1)]))
    expect(store.accountsLoaded).toBe(true)
    expect(store.primary).toBe('shikimori')

    emit.accountsChanged(accountsState([]))
    expect(store.accountsLoaded).toBe(true)
    expect(store.anyAccount).toBe(false)
  })

  it('flips with no accounts when the first read fails', async () => {
    installApi({})
    api.trackerListAccounts.mockRejectedValue(new Error('not ready'))
    const store = await makeStore()
    expect(store.accountsLoaded).toBe(true)
    expect(store.anyAccount).toBe(false)
    expect(store.primary).toBeNull()
  })
})

describe('useTrackersStore — per-tracker sync accessors', () => {
  it('syncStatusFor / queueLengthFor read one tracker, and the refreshes and triggerSync name it', async () => {
    installApi({
      accounts: accountsState([account('shikimori', 1), account('anilist', 2)], 'anilist'),
      statuses: { anilist: status({ queueLength: 3, sessionExpired: true }) }
    })
    const queueLength = vi.fn(async (id: TrackerId) => (id === 'anilist' ? 5 : 0))
    const triggerSync = vi.fn(async () => {})
    Object.assign((window as unknown as { api: object }).api, {
      trackerGetOfflineQueueLength: queueLength,
      trackerTriggerSync: triggerSync
    })
    const store = await makeStore()
    expect(store.syncStatusFor('anilist').sessionExpired).toBe(true)
    expect(store.queueLengthFor('anilist')).toBe(3)
    expect(store.syncStatusFor('shikimori').sessionExpired).toBe(false)
    expect(store.syncStatusFor(null).state).toBe('idle')
    expect(store.queueLengthFor(null)).toBe(0)

    await store.refreshOfflineQueueLength('anilist')
    expect(queueLength).toHaveBeenCalledWith('anilist')
    expect(store.queueLengthFor('anilist')).toBe(5)

    // A tracker that isn't connected keeps nothing.
    await store.refreshOfflineQueueLength('mal')
    expect(store.queueLengthFor('mal')).toBe(0)

    api.trackerGetSyncStatus.mockResolvedValueOnce(status({ queueLength: 1 }))
    await store.refreshSyncStatus('anilist')
    expect(store.syncStatusFor('anilist').sessionExpired).toBe(false)
    expect(store.queueLengthFor('anilist')).toBe(1)

    await store.triggerSync('anilist')
    expect(triggerSync).toHaveBeenCalledWith('anilist')
  })
})

describe('useTrackersStore — refreshRates(trackerId)', () => {
  it('applies the reply itself (cold cache, no broadcast) and reuses an in-flight load', async () => {
    installApi({ accounts: accountsState([account('anilist', 2)]) })
    const pending = deferred<TrackerRatesSnapshot>()
    api.trackerGetRates.mockReturnValueOnce(pending.promise)
    setActivePinia(createPinia())
    const store = useTrackersStore()
    await flush()
    expect(getRatesCalls()).toEqual([['anilist']])

    // Pinia wraps actions, so the two promises aren't identical; both settle on
    // the one pending request.
    const a = store.refreshRates('anilist')
    const b = store.refreshRates('anilist')
    expect(getRatesCalls()).toEqual([['anilist']])

    pending.resolve(snapshot('anilist', [entry('anilist', 10, 1), entry('anilist', 11, 2)]))
    await Promise.all([a, b])
    expect(store.ratesByTracker.anilist?.map((e) => e.malId)).toEqual([10, 11])
    expect(store.primaryRates.map((e) => e.malId)).toEqual([10, 11])

    await store.refreshRates('anilist')
    expect(getRatesCalls()).toEqual([['anilist'], ['anilist']])
  })

  it('a queue event during the creation-time pull survives the snapshot', async () => {
    installApi({ accounts: accountsState([account('anilist', 2)]) })
    const pending = deferred<TrackerRatesSnapshot>()
    api.trackerGetRates.mockReturnValueOnce(pending.promise)
    setActivePinia(createPinia())
    const store = useTrackersStore()
    await flush()

    emit.queueChanged({ trackerId: 'anilist', length: 1, queuedAfter: { 10: values(9) } })
    pending.resolve(snapshot('anilist', [entry('anilist', 10, 1)], { 10: values(5) }))
    await flush()
    expect(store.ratesByTracker.anilist?.map((e) => e.malId)).toEqual([10])
    expect(store.rateFor('anilist', 10)?.episodes).toBe(9)
  })

  it('a queue event during a newly connected tracker load survives the snapshot', async () => {
    installApi({ accounts: accountsState([account('shikimori', 1)]) })
    const store = await makeStore()
    const pending = deferred<TrackerRatesSnapshot>()
    api.trackerGetRates.mockReturnValueOnce(pending.promise)
    emit.accountsChanged(accountsState([account('shikimori', 1), account('anilist', 2)]))
    expect(getRatesCalls()).toEqual([['shikimori'], ['anilist']])

    emit.queueChanged({ trackerId: 'anilist', length: 0, queuedAfter: {} })
    pending.resolve(snapshot('anilist', [entry('anilist', 10, 1)], { 10: values(5) }))
    await flush()
    expect(store.rateFor('anilist', 10)?.episodes).toBe(1)
  })

  it('a switch or a disconnect while the pull is pending sends a fresh request; the stale reply changes nothing', async () => {
    installApi({ accounts: accountsState([account('shikimori', 1), account('anilist', 2)]) })
    const stale = deferred<TrackerRatesSnapshot>()
    const fresh = deferred<TrackerRatesSnapshot>()
    api.trackerGetRates.mockReturnValueOnce(stale.promise)
    setActivePinia(createPinia())
    const store = useTrackersStore()
    await flush()
    expect(getRatesCalls()).toEqual([['shikimori'], ['anilist']])

    // Switch: Shikimori A → B while A's pull is pending.
    api.trackerGetRates.mockReturnValueOnce(fresh.promise)
    emit.accountsChanged(accountsState([account('shikimori', 9), account('anilist', 2)]))
    expect(getRatesCalls()).toEqual([['shikimori'], ['anilist'], ['shikimori']])
    stale.resolve(snapshot('shikimori', [entry('shikimori', 1, 1)], { 1: values(2) }))
    await flush()
    expect(store.ratesByTracker.shikimori).toBeUndefined()
    expect(store.rateFor('shikimori', 1)).toBeNull()
    fresh.resolve(snapshot('shikimori', [entry('shikimori', 2, 1)]))
    await flush()
    expect(store.ratesByTracker.shikimori?.map((e) => e.malId)).toEqual([2])

    // Disconnect: AniList leaves while a refresh is pending.
    const pendingAnilist = deferred<TrackerRatesSnapshot>()
    api.trackerGetRates.mockReturnValueOnce(pendingAnilist.promise)
    const inflight = store.refreshRates('anilist')
    emit.accountsChanged(accountsState([account('shikimori', 9)]))
    pendingAnilist.resolve(snapshot('anilist', [entry('anilist', 3, 1)], { 3: values(2) }))
    await inflight
    expect(store.ratesByTracker.anilist).toBeUndefined()
    expect(store.queuedAfterByTracker.anilist).toBeUndefined()

    // Reconnecting sends a fresh request rather than reusing the dropped one.
    emit.accountsChanged(accountsState([account('shikimori', 9), account('anilist', 2)]))
    expect(getRatesCalls().filter((c) => c[0] === 'anilist')).toHaveLength(3)
  })
})

describe('useTrackersStore — held-title rate state', () => {
  async function heldSetup(): Promise<ReturnType<typeof useTrackersStore>> {
    installApi({
      accounts: accountsState([account('shikimori', 1), account('anilist', 2)]),
      rates: { anilist: snapshot('anilist', [entry('anilist', 42, 3)], { 42: values(4) }) }
    })
    const store = await makeStore()
    store.holdTitle(42)
    await flush()
    expect(getRateCalls()).toEqual([
      ['shikimori', 42],
      ['anilist', 42]
    ])
    api.trackerGetRate.mockClear()
    return store
  }

  it('refreshes every connected tracker on a queue-only change', async () => {
    const store = await heldSetup()
    api.trackerGetRate.mockImplementation(async (id: TrackerId) => ({
      values: values(id === 'anilist' ? 4 : 0),
      stale: false,
      round: 2
    }))
    emit.queueChanged({ trackerId: 'anilist', length: 0, queuedAfter: {} })
    await flush()
    expect(getRateCalls()).toEqual([
      ['shikimori', 42],
      ['anilist', 42]
    ])
    expect(store.rateStateFor('anilist', 42)).toMatchObject({ round: 2 })
    expect(store.rateStateFor('shikimori', 42)).toMatchObject({ round: 2 })
  })

  it('refreshes on a RATE_UPDATED for the held title', async () => {
    const store = await heldSetup()
    emit.rateUpdated({ trackerId: 'shikimori', entry: entry('shikimori', 42, 9) })
    await flush()
    expect(getRateCalls()).toEqual([
      ['shikimori', 42],
      ['anilist', 42]
    ])
    expect(store.rateStateFor('anilist', 42)).not.toBeNull()
  })

  it('refreshes on a RATES_REFRESHED on any connected tracker', async () => {
    await heldSetup()
    emit.ratesRefreshed({ trackerId: 'shikimori', entries: [] })
    await flush()
    expect(getRateCalls()).toEqual([
      ['shikimori', 42],
      ['anilist', 42]
    ])
  })

  it('refreshes on a primary change', async () => {
    await heldSetup()
    emit.accountsChanged(accountsState([account('shikimori', 1), account('anilist', 2)], 'anilist'))
    await flush()
    expect(getRateCalls()).toEqual([
      ['shikimori', 42],
      ['anilist', 42]
    ])
  })

  it('coalesces a burst of events into one refetch per tracker', async () => {
    await heldSetup()
    emit.rateUpdated({ trackerId: 'anilist', entry: entry('anilist', 42, 4) })
    emit.queueChanged({ trackerId: 'anilist', length: 0, queuedAfter: {} })
    emit.ratesRefreshed({ trackerId: 'shikimori', entries: [] })
    await flush()
    expect(getRateCalls()).toHaveLength(2)
  })

  it('events for a title nobody holds trigger no trackerGetRate', async () => {
    const store = await heldSetup()
    emit.rateUpdated({ trackerId: 'anilist', entry: entry('anilist', 99, 1) })
    emit.queueChanged({
      trackerId: 'anilist',
      length: 2,
      queuedAfter: { 42: values(4), 99: values(2) }
    })
    emit.rateUpdated({ trackerId: 'mal', entry: entry('mal', 42, 1) })
    await flush()
    expect(getRateCalls()).toEqual([])

    const release = store.holdTitle(7)
    await flush()
    api.trackerGetRate.mockClear()
    release()
    release()
    expect(store.rateStateFor('anilist', 7)).toBeNull()
    emit.rateUpdated({ trackerId: 'anilist', entry: entry('anilist', 7, 1) })
    await flush()
    expect(getRateCalls()).toEqual([])
    // 42 is still held.
    expect(store.rateStateFor('anilist', 42)).not.toBeNull()
  })

  it('the latest round wins: an older round that resolves after a newer one is dropped', async () => {
    installApi({ accounts: accountsState([account('shikimori', 1)]) })
    const store = await makeStore()
    const round1 = deferred<TrackerRateResult | null>()
    api.trackerGetRate.mockReturnValueOnce(round1.promise)
    store.holdTitle(42)
    await flush()
    expect(getRateCalls()).toEqual([['shikimori', 42]])

    api.trackerGetRate.mockResolvedValueOnce({ values: values(2), stale: false, round: 2 })
    emit.rateUpdated({ trackerId: 'shikimori', entry: entry('shikimori', 42, 2) })
    await flush()
    expect(getRateCalls()).toHaveLength(2)
    expect(store.rateStateFor('shikimori', 42)).toMatchObject({ round: 2 })

    round1.resolve({ values: values(1), stale: true, round: 1 } as TrackerRateResult)
    await flush()
    expect(store.rateStateFor('shikimori', 42)).toMatchObject({ round: 2 })
  })

  it('holds are counted, and each release counts once', async () => {
    installApi({ accounts: accountsState([account('shikimori', 1)]) })
    const store = await makeStore()
    const first = store.holdTitle(42)
    const second = store.holdTitle(42)
    await flush()
    expect(getRateCalls()).toEqual([['shikimori', 42]])

    // One of two holders leaves: the title stays held and live.
    first()
    expect(store.rateStateFor('shikimori', 42)).not.toBeNull()
    api.trackerGetRate.mockClear()
    emit.rateUpdated({ trackerId: 'shikimori', entry: entry('shikimori', 42, 5) })
    await flush()
    expect(getRateCalls()).toEqual([['shikimori', 42]])
    expect(store.rateStateFor('shikimori', 42)).not.toBeNull()

    // A repeated release from the holder that already left changes nothing.
    first()
    expect(store.rateStateFor('shikimori', 42)).not.toBeNull()

    second()
    expect(store.rateStateFor('shikimori', 42)).toBeNull()

    // A stale release can't drop a later holder either.
    store.holdTitle(42)
    await flush()
    first()
    second()
    expect(store.rateStateFor('shikimori', 42)).not.toBeNull()
    api.trackerGetRate.mockClear()
    emit.rateUpdated({ trackerId: 'shikimori', entry: entry('shikimori', 42, 6) })
    await flush()
    expect(getRateCalls()).toEqual([['shikimori', 42]])
  })
})

describe('useTrackersStore — feature sources and details (#706)', () => {
  const D = (description: string): TrackerDetails => ({
    description,
    genres: [],
    status: 'ongoing',
    episodes: 12,
    episodesAired: 6,
    kind: 'tv'
  })

  it('a tracker:details-updated event upserts detailsFor(trackerId, malId) without touching other trackers', async () => {
    const store = await makeStore()
    emit.detailsUpdated({ trackerId: 'mal', malId: 1, details: D('mal 1') })
    emit.detailsUpdated({ trackerId: 'anilist', malId: 1, details: D('anilist 1') })
    emit.detailsUpdated({ trackerId: 'anilist', malId: 2, details: D('anilist 2') })
    emit.detailsUpdated({ trackerId: 'anilist', malId: 1, details: D('anilist 1 again') })
    expect(store.detailsFor('anilist', 1)?.description).toBe('anilist 1 again')
    expect(store.detailsFor('anilist', 2)?.description).toBe('anilist 2')
    expect(store.detailsFor('mal', 1)?.description).toBe('mal 1')
    expect(store.detailsFor('shikimori', 1)).toBeNull()
    expect(store.detailsFor('mal', 2)).toBeNull()
  })

  it('featureSource resolves over the store state: override, primary, then the fixed order', async () => {
    const all = [account('shikimori', 1), account('anilist', 2), account('mal', 3)]
    installApi({
      accounts: { ...accountsState(all, 'mal'), featureSources: { details: 'anilist' } }
    })
    const store = await makeStore()
    expect(store.featureSource('details')).toBe('anilist')
    expect(store.featureSource('chronology')).toBe('mal')
    expect(store.featureSource('airing')).toBe('shikimori')
    expect(store.canAutoDl).toBe(true)
  })

  it('canAutoDl: an expired session keeps its source; MAL-only and no account resolve null', async () => {
    installApi({ accounts: accountsState([account('shikimori', 1, { hasCredentials: false })]) })
    const expired = await makeStore()
    expect(expired.featureSource('airing')).toBe('shikimori')
    expect(expired.canAutoDl).toBe(true)

    installApi({ accounts: accountsState([account('mal', 3)]) })
    const malOnly = await makeStore()
    expect(malOnly.anyAccount).toBe(true)
    expect(malOnly.featureSource('airing')).toBeNull()
    expect(malOnly.canAutoDl).toBe(false)

    installApi({})
    const none = await makeStore()
    expect(none.canAutoDl).toBe(false)
  })
})
