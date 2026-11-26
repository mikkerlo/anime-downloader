// Trackers store (#697, epic #688): every connected tracker's account, rates
// and sync state, from the `tracker:*` channels. `docs/renderer.md` and
// `docs/trackers.md` § The renderer store describe it.
//
// - "Connected" means the account's `user` is set. An expired session keeps
//   its user (credentials cleared), so it stays connected and aggregated.
// - Reads overlay each tracker's cache with its last queued `after`, like
//   main's `projectRate`, so a pending change shows before its queue drains.
// - Feature sources resolve through `src/shared/trackers/feature-source.ts`,
//   the resolver main uses too (#706).
// - Subscriptions are eager and lifetime-scoped (Pinia singleton); the
//   disposers are discarded.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { resolveFeatureSource, type FeatureKey } from '@shared/trackers/feature-source'

export type TrackerSyncSummaryState =
  | 'session-expired'
  | 'needs-setup'
  | 'syncing'
  | 'pending'
  | 'synced'

export interface TrackerSyncBreakdownRow {
  trackerId: TrackerId
  state: TrackerSyncSummaryState
  queueLength: number
  sessionExpired: boolean
  needsSetup: boolean
}

export interface AggregateSyncState {
  state: TrackerSyncSummaryState
  label: string
  queueLength: number
  trackers: TrackerSyncBreakdownRow[]
}

// Worst first.
const SEVERITY: TrackerSyncSummaryState[] = [
  'session-expired',
  'needs-setup',
  'syncing',
  'pending',
  'synced'
]

const EMPTY_SYNC_STATUS: TrackerSyncStatus = {
  state: 'idle',
  queueLength: 0,
  lastSyncAt: 0,
  lastSyncError: null,
  sessionExpired: false,
  needsSetup: false
}

type PerTracker<T> = Partial<Record<TrackerId, T>>

/** The Auto-download hint when an account is connected but nothing can be the `airing` source (#706). */
export const AIRING_UNAVAILABLE_HINT =
  'MyAnimeList has no airing data — connect AniList or Shikimori to auto-download'

function sameValues(a: TrackerRateValues | undefined, b: TrackerRateValues | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.episodes === b.episodes &&
    a.status === b.status &&
    a.score === b.score &&
    a.rewatches === b.rewatches
  )
}

function without<T>(map: PerTracker<T>, id: TrackerId): PerTracker<T> {
  const next = { ...map }
  delete next[id]
  return next
}

function summaryOf(status: TrackerSyncStatus, queueLength: number): TrackerSyncSummaryState {
  if (status.sessionExpired) return 'session-expired'
  if (status.needsSetup) return 'needs-setup'
  if (status.state === 'syncing') return 'syncing'
  if (queueLength > 0) return 'pending'
  return 'synced'
}

function labelOf(state: TrackerSyncSummaryState, queueLength: number): string {
  switch (state) {
    case 'session-expired':
      return 'Session expired'
    case 'needs-setup':
      return 'Needs setup'
    case 'syncing':
      return 'Syncing…'
    case 'pending':
      return `${queueLength} pending`
    case 'synced':
      return 'Synced'
  }
}

export const useTrackersStore = defineStore('trackers', () => {
  const accounts = ref<TrackerAccount[]>([])
  const primary = ref<TrackerId | null>(null)
  const mirror = ref<TrackerAccountsState['mirror']>({})
  // The stored overrides only; `featureSource` resolves them.
  const featureSources = ref<TrackerAccountsState['featureSources']>({})
  // `tracker:details-updated` entries per tracker, by MAL id (#706).
  const detailsByTracker = ref<PerTracker<Record<number, TrackerDetails>>>({})
  const ratesByTracker = ref<PerTracker<TrackerRateEntry[]>>({})
  const queuedAfterByTracker = ref<PerTracker<Record<number, TrackerRateValues>>>({})
  const syncByTracker = ref<PerTracker<TrackerSyncStatus>>({})
  // Moved by the status and by the queue-changed `length`, as the Shikimori
  // store's `offlineQueueLength` is.
  const queueLengthByTracker = ref<PerTracker<number>>({})
  // `tracker:get-rate` results per held title, per connected tracker.
  const rateStates = ref<Record<number, PerTracker<TrackerRateResult | null>>>({})

  const connected = computed<TrackerId[]>(() =>
    accounts.value.filter((a) => a.user !== null).map((a) => a.trackerId)
  )
  const isConnected = (id: TrackerId): boolean => connected.value.includes(id)

  // A user is present on any tracker: the UI gates.
  const anyAccount = computed(() => accounts.value.some((a) => a.user !== null))
  // Credentials are present on any tracker: the tick's gate. Never merged with
  // `anyAccount`, which an expired session keeps true.
  const anyActiveSession = computed(() => accounts.value.some((a) => a.hasCredentials))

  // ---- Feature sources (#706) -----------------------------------------------
  // The shared resolver over this store's state, with the default matrix, so
  // it answers what main's `storedFeatureSource` answers.
  function featureSource(feature: FeatureKey): TrackerId | null {
    return resolveFeatureSource(feature, {
      connected: connected.value,
      primary: primary.value,
      overrides: featureSources.value
    })
  }

  // The account half of the Auto-download gate: the `airing` source resolves,
  // and it resolves only to a tracker with a user. The per-title half (a MAL
  // id, a show not finished) stays in the view.
  const canAutoDl = computed(() => featureSource('airing') !== null)

  function detailsFor(id: TrackerId, malId: number): TrackerDetails | null {
    return detailsByTracker.value[id]?.[malId] ?? null
  }

  function overlaid(id: TrackerId, e: TrackerRateEntry): TrackerRateEntry {
    const queued = queuedAfterByTracker.value[id]?.[e.malId]
    return queued ? { ...e, values: { ...queued } } : e
  }

  function rateFor(id: TrackerId, malId: number): TrackerRateValues | null {
    const queued = queuedAfterByTracker.value[id]?.[malId]
    if (queued) return { ...queued }
    const cached = ratesByTracker.value[id]?.find((e) => e.malId === malId)
    return cached ? cached.values : null
  }

  // The primary's cache rows, overlaid. A title only in the queue has no
  // `anime` block to render, so it isn't a row here; `rateFor` reaches it.
  const primaryRates = computed<TrackerRateEntry[]>(() => {
    const id = primary.value
    if (!id) return []
    return (ratesByTracker.value[id] ?? []).map((e) => overlaid(id, e))
  })

  const aggregateSyncState = computed<AggregateSyncState>(() => {
    const trackers = connected.value.map((id): TrackerSyncBreakdownRow => {
      const status = syncByTracker.value[id] ?? EMPTY_SYNC_STATUS
      const queueLength = queueLengthByTracker.value[id] ?? status.queueLength
      return {
        trackerId: id,
        state: summaryOf(status, queueLength),
        queueLength,
        sessionExpired: status.sessionExpired,
        needsSetup: status.needsSetup
      }
    })
    const queueLength = trackers.reduce((n, r) => n + r.queueLength, 0)
    const state = trackers.reduce<TrackerSyncSummaryState>(
      (worst, r) => (SEVERITY.indexOf(r.state) < SEVERITY.indexOf(worst) ? r.state : worst),
      'synced'
    )
    return { state, label: labelOf(state, queueLength), queueLength, trackers }
  })

  // ---- Per-tracker loads -----------------------------------------------------
  // `epoch` moves when a tracker's state is dropped (disconnect, account
  // switch): a reply sent before it is discarded whole. `queueGen` also moves
  // on every queue event: a snapshot sent before one keeps its entries but not
  // its older `queuedAfter`.
  const epoch = new Map<TrackerId, number>()
  const queueGen = new Map<TrackerId, number>()
  const inflight = new Map<TrackerId, Promise<void>>()
  const bump = (m: Map<TrackerId, number>, id: TrackerId): void => {
    m.set(id, (m.get(id) ?? 0) + 1)
  }

  function refreshRates(id: TrackerId): Promise<void> {
    const pending = inflight.get(id)
    if (pending) return pending
    const e = epoch.get(id) ?? 0
    const q = queueGen.get(id) ?? 0
    // No `status`: a filtered snapshot would leave the tracker's rates partial.
    const load: Promise<void> = window.api
      .trackerGetRates(id)
      .then((snap) => {
        if ((epoch.get(id) ?? 0) !== e || !isConnected(id)) return
        ratesByTracker.value = { ...ratesByTracker.value, [id]: snap.entries }
        if ((queueGen.get(id) ?? 0) === q) {
          queuedAfterByTracker.value = { ...queuedAfterByTracker.value, [id]: snap.queuedAfter }
        }
      })
      .finally(() => {
        if (inflight.get(id) === load) inflight.delete(id)
      })
    inflight.set(id, load)
    return load
  }

  async function refreshSyncStatus(id: TrackerId): Promise<void> {
    const e = epoch.get(id) ?? 0
    const status = await window.api.trackerGetSyncStatus(id)
    if ((epoch.get(id) ?? 0) !== e || !isConnected(id)) return
    applySyncStatus(id, status)
  }

  function applySyncStatus(id: TrackerId, status: TrackerSyncStatus): void {
    syncByTracker.value = { ...syncByTracker.value, [id]: status }
    queueLengthByTracker.value = { ...queueLengthByTracker.value, [id]: status.queueLength }
  }

  function load(id: TrackerId): void {
    void refreshRates(id).catch(() => {})
    // Eager: a persisted `sessionExpired` must reach the UI at launch.
    void refreshSyncStatus(id).catch(() => {})
  }

  function drop(id: TrackerId): void {
    bump(epoch, id)
    bump(queueGen, id)
    inflight.delete(id)
    ratesByTracker.value = without(ratesByTracker.value, id)
    queuedAfterByTracker.value = without(queuedAfterByTracker.value, id)
    syncByTracker.value = without(syncByTracker.value, id)
    queueLengthByTracker.value = without(queueLengthByTracker.value, id)
    const states: typeof rateStates.value = {}
    for (const [malId, byTracker] of Object.entries(rateStates.value)) {
      states[Number(malId)] = without(byTracker, id)
    }
    rateStates.value = states
  }

  // ---- Held titles ----------------------------------------------------------
  // Only titles a view holds keep a `tracker:get-rate` result, so a long drain
  // never turns into one live read per item per tracker. `differs` is measured
  // against the primary, so any event for a held title refetches every
  // connected tracker. Refetches are coalesced per title, and the latest round
  // wins.
  const holds = new Map<number, number>()
  const titleGen = new Map<number, number>()
  const scheduled = new Set<number>()

  function scheduleRefetch(malId: number): void {
    if (!holds.has(malId) || scheduled.has(malId)) return
    scheduled.add(malId)
    queueMicrotask(() => {
      scheduled.delete(malId)
      void refetchTitle(malId)
    })
  }

  function refetchHeld(): void {
    for (const malId of holds.keys()) scheduleRefetch(malId)
  }

  async function refetchTitle(malId: number): Promise<void> {
    if (!holds.has(malId)) return
    const gen = (titleGen.get(malId) ?? 0) + 1
    titleGen.set(malId, gen)
    const reads = connected.value.map(async (id) => {
      const e = epoch.get(id) ?? 0
      try {
        return { id, e, ok: true as const, result: await window.api.trackerGetRate(id, malId) }
      } catch {
        return { id, e, ok: false as const, result: null }
      }
    })
    const results = await Promise.all(reads)
    if (titleGen.get(malId) !== gen || !holds.has(malId)) return
    const next = { ...(rateStates.value[malId] ?? {}) }
    for (const r of results) {
      if (!r.ok || (epoch.get(r.id) ?? 0) !== r.e || !isConnected(r.id)) continue
      next[r.id] = r.result
    }
    rateStates.value = { ...rateStates.value, [malId]: next }
  }

  /** Keep `malId`'s per-tracker rate state live; call the returned function on unmount. */
  function holdTitle(malId: number): () => void {
    holds.set(malId, (holds.get(malId) ?? 0) + 1)
    if (holds.get(malId) === 1) scheduleRefetch(malId)
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (holds.get(malId) ?? 1) - 1
      if (n > 0) {
        holds.set(malId, n)
        return
      }
      holds.delete(malId)
      titleGen.set(malId, (titleGen.get(malId) ?? 0) + 1)
      const states = { ...rateStates.value }
      delete states[malId]
      rateStates.value = states
    }
  }

  function rateStateFor(id: TrackerId, malId: number): TrackerRateResult | null {
    return rateStates.value[malId]?.[id] ?? null
  }

  // ---- Accounts --------------------------------------------------------------
  // The one payload → state step for both `tracker:list-accounts` and
  // `tracker:accounts-changed`. Fields that ride on the same payload join it.
  function applyAccountsPayload(next: TrackerAccountsState): void {
    accounts.value = next.accounts
    primary.value = next.primary
    mirror.value = next.mirror
    featureSources.value = next.featureSources
  }

  function applyAccounts(next: TrackerAccountsState): void {
    const before = new Map(
      accounts.value.flatMap((a) => (a.user ? [[a.trackerId, a.user.id] as const] : []))
    )
    const prevPrimary = primary.value
    applyAccountsPayload(next)

    let changed = false
    for (const id of before.keys()) {
      if (!isConnected(id)) {
        drop(id)
        changed = true
      }
    }
    for (const a of next.accounts) {
      if (a.user === null) continue
      const prevUser = before.get(a.trackerId)
      if (prevUser === a.user.id) continue
      // A switch on a tracker that stays connected is a drop, then a reload.
      if (prevUser !== undefined) drop(a.trackerId)
      load(a.trackerId)
      changed = true
    }
    if (changed || primary.value !== prevPrimary) refetchHeld()
  }

  // ---- Broadcasts ------------------------------------------------------------
  void window.api.onTrackerRateUpdated(({ trackerId, entry }) => {
    if (!isConnected(trackerId)) return
    const list = ratesByTracker.value[trackerId] ?? []
    const idx = list.findIndex((e) => e.malId === entry.malId)
    const nextList = idx >= 0 ? list.map((e, i) => (i === idx ? entry : e)) : [...list, entry]
    ratesByTracker.value = { ...ratesByTracker.value, [trackerId]: nextList }
    scheduleRefetch(entry.malId)
  })
  void window.api.onTrackerRatesRefreshed(({ trackerId, entries }) => {
    if (!isConnected(trackerId)) return
    ratesByTracker.value = { ...ratesByTracker.value, [trackerId]: entries }
    // A wholesale refresh can move a held title's values, and so its
    // `differs`, with no rate update.
    refetchHeld()
  })
  void window.api.onTrackerOfflineQueueChanged(({ trackerId, length, queuedAfter }) => {
    if (!isConnected(trackerId)) return
    bump(queueGen, trackerId)
    const prev = queuedAfterByTracker.value[trackerId] ?? {}
    queuedAfterByTracker.value = { ...queuedAfterByTracker.value, [trackerId]: queuedAfter }
    queueLengthByTracker.value = { ...queueLengthByTracker.value, [trackerId]: length }
    // A queued-only change (a drain settling an item, a discard, a copy) emits
    // no rate update, so the held result would never refresh otherwise.
    for (const malId of holds.keys()) {
      if (!sameValues(prev[malId], queuedAfter[malId])) scheduleRefetch(malId)
    }
  })
  void window.api.onTrackerSyncStatus(({ trackerId, status }) => {
    if (!isConnected(trackerId)) return
    applySyncStatus(trackerId, status)
  })
  // Details aren't the account's, so they land whether or not it is connected.
  void window.api.onTrackerDetailsUpdated(({ trackerId, malId, details }) => {
    detailsByTracker.value = {
      ...detailsByTracker.value,
      [trackerId]: { ...detailsByTracker.value[trackerId], [malId]: details }
    }
  })

  // A broadcast that lands while the first read is pending is newer than it.
  let accountsSeq = 0
  void window.api.onTrackerAccountsChanged((next) => {
    accountsSeq++
    applyAccounts(next)
  })

  const initSeq = accountsSeq
  void window.api
    .trackerListAccounts()
    .then((next) => {
      if (accountsSeq === initSeq) applyAccounts(next)
    })
    .catch(() => {})

  return {
    accounts,
    primary,
    mirror,
    featureSources,
    detailsByTracker,
    ratesByTracker,
    queuedAfterByTracker,
    syncByTracker,
    connected,
    anyAccount,
    anyActiveSession,
    primaryRates,
    aggregateSyncState,
    featureSource,
    canAutoDl,
    detailsFor,
    rateFor,
    rateStateFor,
    holdTitle,
    refreshRates
  }
})
