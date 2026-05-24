// Syncplay (Watch Together) client for PlayerView (Phase 5 slice 5d.2.d,
// #118).
//
// Owns the entire syncplay surface — connection state, room users, IPC
// subscriptions (6 channels: connection-status, remote-state, room-users,
// room-event, trace, remote-episode-change), the 1s snapshot heartbeat
// timer, the local-ready gate (`syncplayLocalReady` + `applyReadyGate`),
// the remote-state apply pipeline, the file-push helper, and the toast +
// pausedBy UI hooks.
//
// Does NOT own: the `onSyncplayRemoteEpisodeChange` follow-through (calling
// `goToEpisode` across the episode-index delta lives in PlayerView because
// it crosses navigation state) — the composable delivers a typed callback
// `onRemoteEpisodeChange(ep)` and PlayerView wires the navigation.
//
// Lifecycle: `onMounted` loads the saved room from settings + status from
// main + installs all 6 IPC subs + starts the 1s snapshot timer.
// `onBeforeUnmount` removes all subs + clears all timers.

import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

const WAITING_DEBOUNCE_MS = 600

export type SyncplayDeps = {
  /** Live <video> element getter. */
  getVideoEl: () => HTMLVideoElement | null
  /** Live duration value (the player progress ref). */
  getDuration: () => number
  /** Props passthroughs needed for the file-push payload. */
  getAnimeId: () => number
  getMalId: () => number | null
  getAnimeName: () => string
  /** Live current-episode int (computed in PlayerView). */
  getCurrentEpisodeInt: () => string
  /** Live active-episode label (separate ref in PlayerView). */
  getActiveEpisodeLabel: () => string
  /** Reactive active-translation id (re-pushed on change). */
  activeTranslationId: Ref<number | null | undefined>
  /** Reactive active-episode index (re-pushed on change). */
  activeEpisodeIndex: Ref<number>
  /** Format helper for toasts (e.g. "1:23:45"). */
  formatTime: (seconds: number) => string
  /** Callback the consumer wires to PlayerView's episode navigator. The
   *  composable invokes it when a peer signals a remote episode change. */
  onRemoteEpisodeChange: (ep: SyncplayRemoteEpisode) => void
}

export type SyncplayClient = {
  syncplayStatus: Ref<SyncplayStatus>
  syncplayRoomUsers: Ref<SyncplayRoomUser[]>
  syncplayRoomInput: Ref<string>
  syncplayMenuOpen: Ref<boolean>
  syncplayToast: Ref<string>
  syncplayPausedBy: Ref<string | null>
  showSyncplayToast: (text: string, ms?: number) => void
  pushSyncplayFile: () => void
  setSyncplayLocalReady: (ready: boolean) => void
  applySyncplayReadyGate: () => void
  toggleSyncplayConnection: () => Promise<void>
  /** Wire into <video @seeked>. */
  onVideoSeeked: () => void
  /** Wire into <video @waiting>. */
  onVideoWaiting: () => void
  /** PlayerView's `onPlay` should call this after its own bookkeeping. */
  onLocalPlay: () => void
  /** PlayerView's `onPause` should call this after its own bookkeeping. */
  onLocalPause: () => void
  /** PlayerView's `onCanPlay` should call this so the waiting gate clears. */
  onLocalCanPlay: () => void
}

export function useSyncplayClient(deps: SyncplayDeps): SyncplayClient {
  const syncplayStatus = ref<SyncplayStatus>({ state: 'idle' })
  const syncplayRoomUsers = ref<SyncplayRoomUser[]>([])
  const syncplayRoomInput = ref('')
  const syncplayMenuOpen = ref(false)
  const syncplayToast = ref('')
  const syncplayPausedBy = ref<string | null>(null)

  let syncplayToastTimer: ReturnType<typeof setTimeout> | null = null
  let syncplaySnapshotTimer: ReturnType<typeof setInterval> | null = null
  let syncplayWaitingTimer: ReturnType<typeof setTimeout> | null = null
  let suppressNextLocalEventUntil = 0
  let syncplayLocalReady = true
  let syncplayLastRemotePlaying = false
  let syncplayLastAppliedPaused: boolean | null = null

  let unsubConnectionStatus: Unsubscribe | null = null
  let unsubRemoteState: Unsubscribe | null = null
  let unsubRoomUsers: Unsubscribe | null = null
  let unsubRoomEvent: Unsubscribe | null = null
  let unsubTrace: Unsubscribe | null = null
  let unsubRemoteEpisodeChange: Unsubscribe | null = null

  function showSyncplayToast(text: string, ms = 3500): void {
    syncplayToast.value = text
    if (syncplayToastTimer) clearTimeout(syncplayToastTimer)
    syncplayToastTimer = setTimeout(() => {
      syncplayToast.value = ''
    }, ms)
  }

  function buildCanonicalName(): string {
    const ep = deps.getCurrentEpisodeInt() || deps.getActiveEpisodeLabel() || ''
    return ep ? `${deps.getAnimeName()} - ${ep}` : deps.getAnimeName()
  }

  function pushSyncplayFile(): void {
    if (syncplayStatus.value.state !== 'ready') return
    const dur = deps.getVideoEl()?.duration || deps.getDuration() || 0
    window.api.syncplaySetFile({
      animeId: deps.getAnimeId(),
      malId: deps.getMalId(),
      episodeInt: deps.getCurrentEpisodeInt() || deps.getActiveEpisodeLabel() || '',
      translationId: deps.activeTranslationId.value ?? null,
      canonicalName: buildCanonicalName(),
      duration: dur
    })
  }

  function sendSyncplayLocalState(cause: 'play' | 'pause' | 'seek'): void {
    if (syncplayStatus.value.state !== 'ready') return
    if (Date.now() < suppressNextLocalEventUntil) return
    const v = deps.getVideoEl()
    if (!v) return
    window.api.syncplaySendLocalState({
      paused: v.paused,
      position: v.currentTime,
      cause
    })
  }

  function syncplayAllUsersReady(): boolean {
    if (!syncplayLocalReady) return false
    for (const u of syncplayRoomUsers.value) {
      if (u.isReady === false) return false
    }
    return true
  }

  function setSyncplayLocalReady(ready: boolean): void {
    if (syncplayLocalReady === ready) return
    syncplayLocalReady = ready
    if (syncplayStatus.value.state === 'ready') {
      window.api.syncplaySetReady(ready).catch(() => {})
    }
    applySyncplayReadyGate()
  }

  function applySyncplayReadyGate(): void {
    if (syncplayStatus.value.state !== 'ready') return
    const v = deps.getVideoEl()
    if (!v) return
    const shouldPlay = syncplayLastRemotePlaying && syncplayAllUsersReady()
    if (!shouldPlay && !v.paused) {
      suppressNextLocalEventUntil = Date.now() + 1500
      v.pause()
    } else if (shouldPlay && v.paused) {
      suppressNextLocalEventUntil = Date.now() + 1500
      v.play().catch(() => {})
    }
  }

  function applyRemoteState(state: SyncplayRemoteState): void {
    const v = deps.getVideoEl()
    if (!v) return
    syncplayLastRemotePlaying = !state.paused
    const pausedChanged = syncplayLastAppliedPaused !== state.paused
    syncplayLastAppliedPaused = state.paused
    if (pausedChanged) {
      if (state.paused && state.setBy) syncplayPausedBy.value = state.setBy
      else if (!state.paused) syncplayPausedBy.value = null
    }
    const diff = Math.abs(v.currentTime - state.position)
    const needsSeek = state.doSeek || diff > 3.0
    const effectivePaused = state.paused || !syncplayAllUsersReady()
    const needsPlayPause = effectivePaused !== v.paused

    if (!needsSeek && !needsPlayPause) return
    suppressNextLocalEventUntil = Date.now() + 1500

    if (needsSeek) {
      v.currentTime = Math.max(0, state.position)
    }
    if (needsPlayPause) {
      if (effectivePaused) v.pause()
      else v.play().catch(() => {})
    }
    if (state.setBy && needsSeek) {
      showSyncplayToast(`${state.setBy} seeked to ${deps.formatTime(state.position)}`)
    }
  }

  // Episode/translation switch: re-announce the file to peers but DO NOT
  // reset syncplayLastRemotePlaying. If a peer is currently playing,
  // applySyncplayReadyGate will start the new episode as soon as the buffer
  // fills — by design, so a remote "next episode" or local prev/next
  // auto-resumes the binge instead of pausing.
  watch([deps.activeEpisodeIndex, deps.activeTranslationId], () => {
    pushSyncplayFile()
  })

  async function toggleSyncplayConnection(): Promise<void> {
    const isActive =
      syncplayStatus.value.state === 'ready' ||
      syncplayStatus.value.state === 'connecting' ||
      syncplayStatus.value.state === 'tls-probing' ||
      syncplayStatus.value.state === 'tls-handshake' ||
      syncplayStatus.value.state === 'hello-sent' ||
      syncplayStatus.value.state === 'reconnecting'
    if (isActive) {
      await window.api.syncplayDisconnect()
      return
    }
    const cfg = (await window.api.getSetting('syncplay')) as {
      lastHost?: string
      lastPort?: number
      lastRoom?: string
      username?: string
      autoReconnect?: boolean
    } | null
    const host = cfg?.lastHost || 'syncplay.pl'
    const port = cfg?.lastPort || 8999
    const room = syncplayRoomInput.value.trim() || cfg?.lastRoom || ''
    let username = cfg?.username?.trim() || ''
    if (!username) {
      const shiki = await window.api.shikimoriGetUser()
      if (shiki?.nickname) {
        username = shiki.nickname
        await window.api.setSetting('syncplay', { ...(cfg || {}), username })
      }
    }
    if (!room) {
      showSyncplayToast('Enter a room name first')
      return
    }
    if (!username) {
      showSyncplayToast('Set a username in Settings → Watch Together')
      return
    }
    await window.api.syncplayConnect({
      host,
      port,
      room,
      username,
      autoReconnect: cfg?.autoReconnect ?? true
    })
  }

  function onVideoSeeked(): void {
    sendSyncplayLocalState('seek')
  }

  function onVideoWaiting(): void {
    if (syncplayWaitingTimer) clearTimeout(syncplayWaitingTimer)
    syncplayWaitingTimer = setTimeout(() => {
      syncplayWaitingTimer = null
      setSyncplayLocalReady(false)
    }, WAITING_DEBOUNCE_MS)
  }

  function onLocalPlay(): void {
    if (Date.now() >= suppressNextLocalEventUntil) {
      syncplayLastRemotePlaying = true
      syncplayLastAppliedPaused = false
      syncplayPausedBy.value = null
    }
    sendSyncplayLocalState('play')
    applySyncplayReadyGate()
  }

  function onLocalPause(): void {
    if (Date.now() >= suppressNextLocalEventUntil) {
      syncplayLastRemotePlaying = false
      syncplayLastAppliedPaused = true
      if (syncplayStatus.value.state === 'ready' && syncplayStatus.value.username) {
        syncplayPausedBy.value = syncplayStatus.value.username
      }
    }
    sendSyncplayLocalState('pause')
  }

  function onLocalCanPlay(): void {
    if (syncplayWaitingTimer) {
      clearTimeout(syncplayWaitingTimer)
      syncplayWaitingTimer = null
    }
    setSyncplayLocalReady(true)
  }

  onMounted(async () => {
    try {
      syncplayStatus.value = await window.api.syncplayGetStatus()
    } catch {
      /* ignore */
    }
    const cfg = (await window.api.getSetting('syncplay')) as { lastRoom?: string } | null
    if (cfg?.lastRoom) syncplayRoomInput.value = cfg.lastRoom

    unsubConnectionStatus = window.api.onSyncplayConnectionStatus((status) => {
      const wasReady = syncplayStatus.value.state === 'ready'
      console.log('[syncplay] status:', status.state, status.error ? `error=${status.error}` : '')
      syncplayStatus.value = status
      if (status.state === 'ready' && !wasReady) {
        pushSyncplayFile()
      }
      if (status.state === 'idle' || status.state === 'disconnected') {
        syncplayLocalReady = true
        syncplayLastRemotePlaying = false
        syncplayLastAppliedPaused = null
        syncplayPausedBy.value = null
        if (syncplayWaitingTimer) {
          clearTimeout(syncplayWaitingTimer)
          syncplayWaitingTimer = null
        }
      }
      if (status.state === 'reconnecting') {
        showSyncplayToast('Reconnecting to Syncplay server…', 8000)
      } else if (status.state === 'disconnected') {
        showSyncplayToast(
          status.error ? `Disconnected: ${status.error}` : 'Disconnected from Syncplay',
          8000
        )
      }
    })
    unsubRemoteState = window.api.onSyncplayRemoteState((state) => {
      applyRemoteState(state)
    })
    unsubRoomUsers = window.api.onSyncplayRoomUsers((users) => {
      syncplayRoomUsers.value = users
      applySyncplayReadyGate()
    })
    unsubRoomEvent = window.api.onSyncplayRoomEvent((ev) => {
      if (ev.level === 'warn' || ev.level === 'error') {
        console.warn('[syncplay]', ev.text)
      } else {
        console.log('[syncplay]', ev.text)
      }
      const ms = ev.level === 'warn' || ev.level === 'error' ? 8000 : 3500
      showSyncplayToast(ev.text, ms)
    })
    unsubTrace = window.api.onSyncplayTrace((entry) => {
      const arrow = entry.dir === 'in' ? '<<' : '>>'
      let flat: string
      try {
        flat = JSON.stringify(entry.msg)
      } catch {
        flat = String(entry.msg)
      }
      console.log(`[syncplay] ${arrow} ${entry.keys} ${flat}`)
    })
    unsubRemoteEpisodeChange = window.api.onSyncplayRemoteEpisodeChange((ep) => {
      deps.onRemoteEpisodeChange(ep)
    })

    // 1-second snapshot push so main's heartbeat has fresh position.
    syncplaySnapshotTimer = setInterval(() => {
      if (syncplayStatus.value.state !== 'ready') return
      const v = deps.getVideoEl()
      if (!v) return
      window.api.syncplaySendLocalSnapshot({
        position: v.currentTime,
        paused: v.paused
      })
    }, 1000)
  })

  onBeforeUnmount(() => {
    unsubConnectionStatus?.()
    unsubConnectionStatus = null
    unsubRemoteState?.()
    unsubRemoteState = null
    unsubRoomUsers?.()
    unsubRoomUsers = null
    unsubRoomEvent?.()
    unsubRoomEvent = null
    unsubTrace?.()
    unsubTrace = null
    unsubRemoteEpisodeChange?.()
    unsubRemoteEpisodeChange = null
    if (syncplaySnapshotTimer) {
      clearInterval(syncplaySnapshotTimer)
      syncplaySnapshotTimer = null
    }
    if (syncplayToastTimer) {
      clearTimeout(syncplayToastTimer)
      syncplayToastTimer = null
    }
    if (syncplayWaitingTimer) {
      clearTimeout(syncplayWaitingTimer)
      syncplayWaitingTimer = null
    }
  })

  return {
    syncplayStatus,
    syncplayRoomUsers,
    syncplayRoomInput,
    syncplayMenuOpen,
    syncplayToast,
    syncplayPausedBy,
    showSyncplayToast,
    pushSyncplayFile,
    setSyncplayLocalReady,
    applySyncplayReadyGate,
    toggleSyncplayConnection,
    onVideoSeeked,
    onVideoWaiting,
    onLocalPlay,
    onLocalPause,
    onLocalCanPlay
  }
}
