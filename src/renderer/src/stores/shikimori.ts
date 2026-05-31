// Shikimori store (Phase 4 slice 4d, #111).
//
// Centralizes the Shikimori-related cross-view state that App.vue and three
// components used to mirror independently: login status, the rates list,
// per-anime details cache, sync-state, and offline-queue length.
//
// Five broadcasts move from ad-hoc per-component subscriptions to the store:
//   onShikimoriRateUpdated         — upserts an entry into `rates`
//   onShikimoriRatesRefreshed      — replaces `rates` wholesale
//   onShikimoriAnimeDetailsUpdated — upserts into `animeDetails`
//   onShikimoriOfflineQueueChanged — updates `offlineQueueLength`
//   onShikimoriSyncStatus          — replaces `syncStatus`
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
}

const EMPTY_SYNC_STATUS: ShikimoriSyncStatusSnapshot = {
  state: 'idle',
  queueLength: 0,
  lastSyncAt: 0,
  lastSyncError: null
}

export const useShikimoriStore = defineStore('shikimori', () => {
  const user = ref<ShikiUser | null>(null)
  const profile = ref<ShikimoriProfile | null>(null)
  const rates = ref<ShikiAnimeRateEntry[]>([])
  const animeDetails = ref<Record<number, ShikiAnimeDetails>>({})
  const syncStatus = ref<ShikimoriSyncStatusSnapshot>({ ...EMPTY_SYNC_STATUS })
  const offlineQueueLength = ref(0)

  const loggedIn = computed(() => user.value !== null)

  function rateByMalId(malId: number): ShikiAnimeRateEntry | null {
    if (!malId) return null
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
  void window.api.onShikimoriRateUpdated((entry) => {
    const idx = rates.value.findIndex((r) => r.rate.target_id === entry.rate.target_id)
    if (idx >= 0) {
      const next = rates.value.slice()
      next[idx] = entry
      rates.value = next
    } else {
      rates.value = [...rates.value, entry]
    }
  })
  void window.api.onShikimoriRatesRefreshed((entries) => {
    rates.value = entries
  })
  void window.api.onShikimoriProfileRefreshed((next) => {
    profile.value = next
  })
  void window.api.onShikimoriAnimeDetailsUpdated(({ malId, details }) => {
    animeDetails.value = { ...animeDetails.value, [malId]: details }
  })
  void window.api.onShikimoriOfflineQueueChanged((data) => {
    offlineQueueLength.value = data.length
  })
  void window.api.onShikimoriSyncStatus((data) => {
    syncStatus.value = data
    offlineQueueLength.value = data.queueLength
  })

  return {
    user,
    profile,
    rates,
    animeDetails,
    syncStatus,
    offlineQueueLength,
    loggedIn,
    rateByMalId,
    animeDetailsByMalId,
    refreshUser,
    refreshRates,
    refreshProfile,
    refreshSyncStatus,
    refreshOfflineQueueLength,
    triggerSync
  }
})
