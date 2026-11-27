// Shikimori store (Phase 4 slice 4d, #111).
//
// Centralizes the Shikimori-related cross-view state that App.vue and three
// components used to mirror independently: login status, the rates list,
// per-anime details cache, sync-state, and offline-queue length.
//
// Five broadcasts move from ad-hoc per-component subscriptions to the store:
//   onTrackerRateUpdated           — upserts an entry into `rates`
//   onTrackerRatesRefreshed        — replaces `rates` wholesale
//   onShikimoriAnimeDetailsUpdated — upserts into `animeDetails`
//   onTrackerOfflineQueueChanged   — updates `offlineQueueLength`
//   onTrackerSyncStatus            — replaces `syncStatus`
//
// Since #697 it is a facade beside `useTrackersStore`: rates, the queue length
// and the sync status come from the `tracker:*` twins filtered to
// `trackerId: 'shikimori'` (rates from their `raw` rows), never also from the
// `shikimori:*` events main double-emits, so nothing is applied twice. The
// requests stay on the `shikimori:*` aliases until #717.
//
// Subscriptions are eager, lifetime-scoped (Pinia singleton). Disposers are
// intentionally discarded — the listeners die with the renderer process.

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type ShikimoriSyncStatusSnapshot = {
  state: 'idle' | 'syncing'
  queueLength: number
  lastSyncAt: number
  lastSyncError: string | null
  /** The stored refresh token was rejected; the user must sign in again. */
  sessionExpired: boolean
}

const EMPTY_SYNC_STATUS: ShikimoriSyncStatusSnapshot = {
  state: 'idle',
  queueLength: 0,
  lastSyncAt: 0,
  lastSyncError: null,
  sessionExpired: false
}

export const useShikimoriStore = defineStore('shikimori', () => {
  const user = ref<ShikiUser | null>(null)
  const profile = ref<ShikimoriProfile | null>(null)
  const friends = ref<ShikiFriendCard[]>([])
  const recommendations = ref<RecommendationEntry[]>([])
  const rates = ref<ShikiAnimeRateEntry[]>([])
  const animeDetails = ref<Record<number, ShikiAnimeDetails>>({})
  const syncStatus = ref<ShikimoriSyncStatusSnapshot>({ ...EMPTY_SYNC_STATUS })
  const offlineQueueLength = ref(0)

  const loggedIn = computed(() => user.value !== null)

  // Persisted in the main process, so it is already true at launch for a user
  // whose refresh token died weeks ago — see the init fetch below.
  const sessionExpired = computed(() => syncStatus.value.sessionExpired)

  function rateByMalId(malId: number): ShikiAnimeRateEntry | null {
    if (!malId) return null
    // `rate.target_id` only: the renderer reads no `shikiAnime.*` since #707.
    // A legacy row with a null `target_id` is reached through
    // `useTrackersStore`, whose `malId` the codec derives main-side.
    return rates.value.find((r) => r.rate.target_id === malId) ?? null
  }

  function animeDetailsByMalId(malId: number): ShikiAnimeDetails | null {
    if (!malId) return null
    return animeDetails.value[malId] ?? null
  }

  async function refreshUser(): Promise<void> {
    user.value = await window.api.shikimoriGetUser()
  }

  async function refreshRates(status?: string): Promise<void> {
    rates.value = await window.api.shikimoriGetAnimeRates(status)
  }

  async function refreshProfile(): Promise<void> {
    profile.value = await window.api.shikimoriGetProfile()
  }

  async function refreshFriends(): Promise<void> {
    friends.value = (await window.api.shikimoriGetFriends()) ?? []
  }

  async function refreshRecommendations(): Promise<void> {
    recommendations.value = (await window.api.shikimoriGetRecommendations()) ?? []
  }

  async function refreshSyncStatus(): Promise<void> {
    const next = await window.api.shikimoriGetSyncStatus()
    syncStatus.value = next
    offlineQueueLength.value = next.queueLength
  }

  async function refreshOfflineQueueLength(): Promise<void> {
    offlineQueueLength.value = await window.api.shikimoriGetOfflineQueueLength()
  }

  async function triggerSync(): Promise<void> {
    await window.api.shikimoriTriggerSync()
  }

  // Eager subscriptions; live for the renderer's lifetime. See module header.
  void window.api.onTrackerRateUpdated(({ trackerId, raw: entry }) => {
    if (trackerId !== 'shikimori' || !entry) return
    const idx = rates.value.findIndex((r) => r.rate.target_id === entry.rate.target_id)
    if (idx >= 0) {
      const next = rates.value.slice()
      next[idx] = entry
      rates.value = next
    } else {
      rates.value = [...rates.value, entry]
    }
  })
  void window.api.onTrackerRatesRefreshed(({ trackerId, raw: entries }) => {
    if (trackerId !== 'shikimori' || !entries) return
    rates.value = entries
  })
  void window.api.onShikimoriProfileRefreshed((next) => {
    profile.value = next
  })
  void window.api.onShikimoriFriendsRefreshed((next) => {
    friends.value = next
  })
  void window.api.onShikimoriRecommendationsRefreshed((next) => {
    recommendations.value = next
  })
  void window.api.onShikimoriAnimeDetailsUpdated(({ malId, details }) => {
    animeDetails.value = { ...animeDetails.value, [malId]: details }
  })
  void window.api.onTrackerOfflineQueueChanged(({ trackerId, length }) => {
    if (trackerId !== 'shikimori') return
    offlineQueueLength.value = length
  })
  void window.api.onTrackerSyncStatus(({ trackerId, status }) => {
    if (trackerId !== 'shikimori') return
    const { state, queueLength, lastSyncAt, lastSyncError, sessionExpired } = status
    syncStatus.value = { state, queueLength, lastSyncAt, lastSyncError, sessionExpired }
    offlineQueueLength.value = queueLength
  })

  // Pull once on init. `sessionExpired` is persisted state, and a freshly
  // launched app makes no Shikimori request until the user acts — without this
  // the broadcast side alone would leave the expiry banner invisible until the
  // next failure, which is exactly the reported "restart and it looks fine"
  // symptom (#244 §6c). Failure is non-fatal: the mirror stays at its default.
  void refreshSyncStatus().catch(() => {})

  return {
    user,
    profile,
    friends,
    recommendations,
    rates,
    animeDetails,
    syncStatus,
    offlineQueueLength,
    loggedIn,
    sessionExpired,
    rateByMalId,
    animeDetailsByMalId,
    refreshUser,
    refreshRates,
    refreshProfile,
    refreshFriends,
    refreshRecommendations,
    refreshSyncStatus,
    refreshOfflineQueueLength,
    triggerSync
  }
})
