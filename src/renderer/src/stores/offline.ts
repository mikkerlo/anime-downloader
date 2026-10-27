// Offline state (#567), mirrored from main's OfflineService.
//
// One subscription for the app's lifetime (Pinia singleton, disposer
// discarded), seeded from `offline:get-state` so a store created after a
// transition still reads the live mode.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useOfflineStore = defineStore('offline', () => {
  const state = ref<OfflineState>({ mode: 'online', since: 0, lastProbeAt: null })
  const retrying = ref(false)

  const isOffline = computed(() => state.value.mode !== 'online')
  const isManual = computed(() => state.value.mode === 'offline-manual')

  async function refresh(): Promise<void> {
    state.value = await window.api.offlineGetState()
  }

  async function setManual(on: boolean): Promise<void> {
    state.value = await window.api.offlineSetManual(on)
  }

  async function retry(): Promise<void> {
    if (retrying.value) return
    retrying.value = true
    try {
      state.value = await window.api.offlineRetry()
    } finally {
      retrying.value = false
    }
  }

  void window.api.onOfflineStateChanged((next) => {
    state.value = next
  })
  void refresh().catch(() => {})

  return { state, retrying, isOffline, isManual, refresh, setManual, retry }
})
