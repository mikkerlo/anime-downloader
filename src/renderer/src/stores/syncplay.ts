// Syncplay (Watch Together) connection store (#213).
//
// Owns the two cross-view Syncplay broadcasts — connection-status and
// room-users — that WatchTogetherView and the player's Syncplay client both
// consume. Seeded from main via get-status/get-room-users so a consumer
// mounting mid-session (or after a renderer reload) sees the live state
// instead of an empty default.
//
// Player-scoped concerns (remote-state apply, room-event toasts, trace,
// remote-episode-change) stay in use-syncplay-client.ts.
//
// Lifetime-scoped subscriptions (Pinia singleton). Disposers discarded.

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useSyncplayStore = defineStore('syncplay', () => {
  const status = ref<SyncplayStatus>({ state: 'idle' })
  const roomUsers = ref<SyncplayRoomUser[]>([])

  const isActive = computed(() =>
    ['connecting', 'tls-probing', 'tls-handshake', 'hello-sent', 'ready', 'reconnecting'].includes(
      status.value.state
    )
  )

  async function refresh(): Promise<void> {
    status.value = await window.api.syncplayGetStatus()
    roomUsers.value = await window.api.syncplayGetRoomUsers()
  }

  void window.api.onSyncplayConnectionStatus((s) => {
    status.value = s
  })
  void window.api.onSyncplayRoomUsers((users) => {
    roomUsers.value = users
  })
  void refresh().catch(() => {})

  return {
    status,
    roomUsers,
    isActive,
    refresh
  }
})
