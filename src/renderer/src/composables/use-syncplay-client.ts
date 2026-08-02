// Syncplay (Watch Together) client for PlayerView (Phase 5 slice 5d.2.d,
// #118).
//
// Owns the player-scoped syncplay surface — the IPC subscriptions for
// remote-state, room-event, trace, and remote-episode-change, the 1s
// snapshot heartbeat timer, the local-ready gate (`syncplayLocalReady` +
// `applyReadyGate`), the remote-state apply pipeline, the file-push helper,
// and the toast + pausedBy UI hooks. Connection status and room users are
// read from the cross-view syncplay store (#213) and reacted to via
// watchers.
//
// Does NOT own: the `onSyncplayRemoteEpisodeChange` follow-through (calling
// `goToEpisode` across the episode-index delta lives in PlayerView because
// it crosses navigation state) — the composable delivers a typed callback
// `onRemoteEpisodeChange(ep)` and PlayerView wires the navigation.
//
// Lifecycle: `onMounted` loads the saved room from settings + re-seeds the
// store + installs the player-scoped IPC subs + starts the 1s snapshot
// timer. If the session is already 'ready' at mount (joined from
// WatchTogetherView before the player opened), the current file is pushed
// immediately — the transition-into-ready watcher never fires in that case.
// `onBeforeUnmount` removes all subs + clears all timers.

import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useSyncplayStore } from '../stores/syncplay'

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
  /** Flag a pause/play this app performs itself (buffer refill), so the
   *  resulting element event is never mistaken for the user's intent. */
  markProgrammaticPlayback: (paused: boolean | null) => void
  applySyncplayReadyGate: () => void
  toggleSyncplayConnection: () => Promise<void>
  /** Wire into <video @seeked>. */
  onVideoSeeked: () => void
  /** Wire into <video @waiting>. */
  onVideoWaiting: () => void
  /** Wire into <video @timeupdate>: keeps snapshots flowing when a background
   *  window's timers are throttled. */
  onVideoTimeUpdate: () => void
  /** PlayerView's `onPlay` should call this after its own bookkeeping. */
  onLocalPlay: () => void
  /** PlayerView's `onPause` should call this after its own bookkeeping. */
  onLocalPause: () => void
  /** PlayerView's `onCanPlay` should call this so the waiting gate clears. */
  onLocalCanPlay: () => void
}

export function useSyncplayClient(deps: SyncplayDeps): SyncplayClient {
  const syncplayStore = useSyncplayStore()
  const { status: syncplayStatus, roomUsers: syncplayRoomUsers } = storeToRefs(syncplayStore)
  const syncplayRoomInput = ref('')
  const syncplayMenuOpen = ref(false)
  const syncplayToast = ref('')
  const syncplayPausedBy = ref<string | null>(null)

  let syncplayToastTimer: ReturnType<typeof setTimeout> | null = null
  let syncplaySnapshotTimer: ReturnType<typeof setInterval> | null = null
  let syncplayWaitingTimer: ReturnType<typeof setTimeout> | null = null
  let suppressNextLocalEventUntil = 0
  // What we last *applied* from a remote state. The 1500 ms window above is a
  // wall-clock guess, and a seek on a network stream regularly completes later
  // than that — the element's `seeked` then escapes as our own seek and we
  // hand the peer their own position back with doSeek, dragging the room to a
  // stale point and bumping the ignore counter (which makes main drop the
  // inbound states we need). Keying on what we asked for is exact, however
  // long the element takes to get there.
  let appliedSeekPosition: number | null = null
  let appliedPaused: boolean | null = null
  const APPLIED_SEEK_EPSILON = 0.5
  // What *this user* wants the room to be doing. `v.paused` is not that: the
  // readiness gate and the MSE buffer machinery pause and resume the element
  // on their own, and reporting those as intent pauses the room on every
  // stall — and fights the user's own pause, which then "doesn't work".
  // null until something establishes it (a remote state we adopt, or the user
  // pressing play/pause); until then the element itself is the best answer.
  let intendedPaused: boolean | null = null
  let lastSnapshotPushAt = 0
  const SNAPSHOT_MIN_INTERVAL_MS = 900

  function intentOr(v: HTMLVideoElement): boolean {
    return intendedPaused ?? v.paused
  }
  let syncplayLocalReady = true
  let syncplayLastRemotePlaying = false
  let syncplayLastAppliedPaused: boolean | null = null

  let unsubRemoteState: Unsubscribe | null = null
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
      paused: intentOr(v),
      position: v.currentTime,
      cause
    })
  }

  // Main reads the gap between pushes as "no player is driving playback" and
  // demotes us to a spectator that mirrors the room. A plain setInterval can't
  // carry that alone: backgroundThrottling is on, and Chromium stretches timers
  // in a muted or occluded window toward 1/min, which would silently demote an
  // active viewer. `timeupdate` is a media event — not timer-throttled while
  // playing — so it keeps the pushes alive; the 1 s floor keeps its ~4 Hz rate
  // from becoming IPC spam, and the interval still covers a paused player,
  // where timeupdate doesn't fire and a stale snapshot is harmless anyway.
  function pushSyncplaySnapshot(): void {
    if (syncplayStatus.value.state !== 'ready') return
    const v = deps.getVideoEl()
    if (!v) return
    lastSnapshotPushAt = Date.now()
    window.api.syncplaySendLocalSnapshot({
      position: v.currentTime,
      paused: intentOr(v)
    })
  }

  function onVideoTimeUpdate(): void {
    if (Date.now() - lastSnapshotPushAt < SNAPSHOT_MIN_INTERVAL_MS) return
    pushSyncplaySnapshot()
  }

  function syncplayAllUsersReady(): boolean {
    if (!syncplayLocalReady) return false
    for (const u of syncplayRoomUsers.value) {
      if (u.isReady === false) return false
    }
    return true
  }

  // The MSE buffer machinery pauses and resumes the element to refill; those
  // moves are no more the user's intent than the readiness gate's are, and
  // each leaked one stalls or resumes the whole room.
  // `null` retracts a mark whose call turned out not to fire an event (a
  // rejected play()), which would otherwise latch and swallow the user's next
  // real one — the same latch family as the already-paused case. Only a resume
  // mark is retracted: a play() rejecting *because* a later pause() aborted it
  // must not clear that pause's own mark, and the slot is single.
  function markProgrammaticPlayback(paused: boolean | null): void {
    if (paused === null) {
      if (appliedPaused === false) appliedPaused = null
      return
    }
    appliedPaused = paused
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
    // The gate moves the element on the room's behalf, never the user's — mark
    // it like a remote apply so the resulting event isn't mistaken for intent
    // however late the element gets around to firing it.
    if (!shouldPlay && !v.paused) {
      suppressNextLocalEventUntil = Date.now() + 1500
      appliedPaused = true
      v.pause()
    } else if (shouldPlay && v.paused) {
      suppressNextLocalEventUntil = Date.now() + 1500
      appliedPaused = false
      v.play().catch(() => {
        // The call failed, so no 'play' event will ever consume the marker —
        // retract it, or the user's next real play is swallowed as this echo.
        // Through the same function as useMsePlayer's retraction, so hardening
        // the semantics can't apply to one call site and not the other.
        markProgrammaticPlayback(null)
      })
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

    // Adopting the room's intent as our own — a later heartbeat must report
    // this, not whatever the buffer machinery has done to the element since.
    intendedPaused = state.paused
    if (needsSeek) {
      const target = Math.max(0, state.position)
      appliedSeekPosition = target
      v.currentTime = target
    }
    if (needsPlayPause) {
      appliedPaused = effectivePaused
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
    const v = deps.getVideoEl()
    if (
      v &&
      appliedSeekPosition !== null &&
      Math.abs(v.currentTime - appliedSeekPosition) < APPLIED_SEEK_EPSILON
    ) {
      // This is the peer's own seek arriving back at us, not a user seek.
      appliedSeekPosition = null
      return
    }
    appliedSeekPosition = null
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
    if (appliedPaused === false) {
      // The element realizing a remote resume — not a local one.
      appliedPaused = null
      applySyncplayReadyGate()
      return
    }
    // Intent is recorded whatever the wall-clock window says. A genuine echo
    // is already caught by the marker above; anything reaching here is the
    // user. Gating this on the window meant a pause inside it left intent at
    // "playing" while the element sat paused — the heartbeat then asserted
    // play and the next remote apply resumed it, so the pause "didn't work".
    intendedPaused = false
    if (Date.now() >= suppressNextLocalEventUntil) {
      syncplayLastRemotePlaying = true
      syncplayLastAppliedPaused = false
      syncplayPausedBy.value = null
    }
    sendSyncplayLocalState('play')
    applySyncplayReadyGate()
  }

  function onLocalPause(): void {
    if (appliedPaused === true) {
      appliedPaused = null
      return
    }
    intendedPaused = true
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

  watch(syncplayStatus, (status, prev) => {
    const wasReady = prev?.state === 'ready'
    console.log('[syncplay] status:', status.state, status.error ? `error=${status.error}` : '')
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

  watch(syncplayRoomUsers, () => {
    applySyncplayReadyGate()
  })

  onMounted(async () => {
    try {
      // Re-seed from main so a player mounting into an already-connected
      // session (join flow) starts from live state, then announce our file —
      // the transition-into-ready watcher will never fire in that case.
      await syncplayStore.refresh()
      if (syncplayStatus.value.state === 'ready') pushSyncplayFile()
    } catch {
      /* ignore */
    }
    const cfg = (await window.api.getSetting('syncplay')) as { lastRoom?: string } | null
    if (cfg?.lastRoom) syncplayRoomInput.value = cfg.lastRoom

    unsubRemoteState = window.api.onSyncplayRemoteState((state) => {
      applyRemoteState(state)
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

    // 1-second snapshot push so main's heartbeat has fresh position. The
    // timer is only half of it — see pushSyncplaySnapshot / onVideoTimeUpdate.
    syncplaySnapshotTimer = setInterval(pushSyncplaySnapshot, 1000)
  })

  onBeforeUnmount(() => {
    unsubRemoteState?.()
    unsubRemoteState = null
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
    markProgrammaticPlayback,
    applySyncplayReadyGate,
    toggleSyncplayConnection,
    onVideoSeeked,
    onVideoTimeUpdate,
    onVideoWaiting,
    onLocalPlay,
    onLocalPause,
    onLocalCanPlay
  }
}
