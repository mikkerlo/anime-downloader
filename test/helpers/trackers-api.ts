// The `window.api` half of `useTrackersStore` (#697) for renderer component
// tests (#698). Spread `api` into a test's API stub: a permissive stub would
// answer `trackerListAccounts()` with a function, which has no `then`. The
// `emit*` members drive the store's `tracker:*` subscriptions.
import { vi, type Mock } from 'vitest'

export interface TrackersApi {
  api: {
    trackerListAccounts: Mock
    trackerGetRates: Mock
    trackerGetSyncStatus: Mock
    trackerGetRate: Mock
    onTrackerAccountsChanged: (cb: (s: TrackerAccountsState) => void) => () => void
    onTrackerOfflineQueueChanged: (cb: (e: TrackerOfflineQueueChangedEvent) => void) => () => void
    onTrackerRateUpdated: (cb: (e: TrackerRateUpdatedEvent) => void) => () => void
    onTrackerRatesRefreshed: (cb: (e: TrackerRatesRefreshedEvent) => void) => () => void
    onTrackerSyncStatus: (cb: (e: TrackerSyncStatusEvent) => void) => () => void
  }
  emitAccounts(state: TrackerAccountsState): void
  emitQueueChanged(e: TrackerOfflineQueueChangedEvent): void
}

const IDS: TrackerId[] = ['shikimori', 'anilist', 'mal']

function account(trackerId: TrackerId, connected: boolean): TrackerAccount {
  return {
    trackerId,
    user: connected ? { id: IDS.indexOf(trackerId) + 1, nickname: trackerId, avatar: null } : null,
    hasCredentials: connected,
    sessionExpired: false,
    needsSetup: false,
    credentialState: connected ? 'ok' : 'none'
  }
}

/** Every tracker, `connected` ones signed in; `primary` defaults to the first connected. */
export function accountsState(
  connected: TrackerId[],
  primary: TrackerId | null = IDS.find((id) => connected.includes(id)) ?? null
): TrackerAccountsState {
  return {
    accounts: IDS.map((id) => account(id, connected.includes(id))),
    primary,
    mirror: {},
    featureSources: {}
  }
}

/** A listed entry; only what the views read is meaningful. */
export function trackerEntry(
  trackerId: TrackerId,
  malId: number,
  status: ShikiUserRateStatus,
  opts: { updatedAt?: number | null; smotretAnime?: AnimeSearchResult | null } = {}
): TrackerRateEntry {
  return {
    trackerId,
    malId,
    remoteId: malId + 1000,
    values: { episodes: 0, status, score: 0, rewatches: 0 },
    updatedAt: opts.updatedAt === undefined ? null : opts.updatedAt,
    anime: {
      title: `Title ${malId}`,
      poster: null,
      kind: 'tv',
      episodes: 12,
      episodesAired: 12,
      status: 'released'
    },
    smotretAnime: opts.smotretAnime ?? null
  }
}

export function snapshotOf(
  trackerId: TrackerId,
  entries: TrackerRateEntry[]
): TrackerRatesSnapshot {
  return { trackerId, entries, queuedAfter: {} }
}

const IDLE: TrackerSyncStatus = {
  state: 'idle',
  queueLength: 0,
  lastSyncAt: 0,
  lastSyncError: null,
  sessionExpired: false,
  needsSetup: false
}

/**
 * `accounts` answers `trackerListAccounts`; `trackerGetRates(id)` answers
 * `rates[id]` (none connected and no rates by default).
 */
export function trackersApi(
  opts: {
    accounts?: TrackerAccountsState
    rates?: Partial<Record<TrackerId, TrackerRateEntry[]>>
  } = {}
): TrackersApi {
  const accounts = new Set<(s: TrackerAccountsState) => void>()
  const queue = new Set<(e: TrackerOfflineQueueChangedEvent) => void>()
  const subscribe =
    <T>(set: Set<(v: T) => void>) =>
    (cb: (v: T) => void): (() => void) => {
      set.add(cb)
      return () => set.delete(cb)
    }
  return {
    api: {
      trackerListAccounts: vi.fn(async () => opts.accounts ?? accountsState([])),
      trackerGetRates: vi.fn(async (id: TrackerId) => snapshotOf(id, opts.rates?.[id] ?? [])),
      trackerGetSyncStatus: vi.fn(async () => IDLE),
      trackerGetRate: vi.fn(async () => null),
      onTrackerAccountsChanged: subscribe(accounts),
      onTrackerOfflineQueueChanged: subscribe(queue),
      onTrackerRateUpdated: () => () => {},
      onTrackerRatesRefreshed: () => () => {},
      onTrackerSyncStatus: () => () => {}
    },
    emitAccounts: (s) => {
      for (const cb of [...accounts]) cb(s)
    },
    emitQueueChanged: (e) => {
      for (const cb of [...queue]) cb(e)
    }
  }
}
