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
  /** Flag a `currentTime` this app writes on the user's behalf (resume land,
   *  quality/translation restore, episode-nav rewind), so the resulting
   *  `seeked` is never broadcast to the room as the user's own seek. */
  markProgrammaticSeek: (target: number) => void
  applySyncplayReadyGate: () => void
  toggleSyncplayConnection: () => Promise<void>
  /** Wire into <video @seeked>. */
  onVideoSeeked: () => void
  /** Wire into <video @waiting>. */
  onVideoWaiting: () => void
  /** Wire into <video @loadedmetadata>: applies a state that arrived while the
   *  element could not honor it (#240). */
  onVideoLoadedMetadata: () => void
  /** True while a remote state is parked, or once one has been applied since
   *  the last reset (episode/translation switch, reconnecting,
   *  idle/disconnected). The room's position outranks the local saved position
   *  while this holds — `PlayerView`'s `resumeFromSavedPosition` and the MSE
   *  resume land both defer to it (#240). It means "the room has told us where
   *  it is", not "the element is there": a parked state whose `loadedmetadata`
   *  never arrives keeps it true. */
  hasRemoteStateApplied: () => boolean
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
  // The `currentTime` write we are still waiting for the element to realize.
  // The 1500 ms window above is a wall-clock guess, and a seek on a network
  // stream regularly completes later than that — the element's `seeked` then
  // escapes as our own seek and we hand the peer their own position back with
  // doSeek, dragging the room to a stale point and bumping the ignore counter
  // (which makes main drop the inbound states we need). Keying on the write
  // itself is exact, however long the element takes to get there.
  //
  // Two kinds, differing only in how they are consumed (#239):
  // - `anyValue: false` — a remote apply. Matched by value within
  //   APPLIED_SEEK_EPSILON. Deliberately strict: it is the only renderer-side
  //   echo guard an apply gets, and a value-agnostic one would swallow the
  //   user's first real seek after every apply.
  // - `anyValue: true` — a write this app made on the user's behalf
  //   (`markProgrammaticSeek`). Consumes the next `seeked` whatever position it
  //   reports, because the write often lands on an element at `readyState 0`:
  //   it becomes the *default playback start position*, fires no `seeked` then,
  //   and is clamped into `seekable` once metadata arrives — so the eventual
  //   event can sit arbitrarily far from what we asked for.
  //
  // Bounded by a TTL rather than a wall clock — a short window is the same
  // fragility this keying exists to remove — and cleared on a consume or on
  // expiry, never on a mismatch: between an apply and its echo any of the
  // programmatic sites can fire a `seeked`, and consuming the marker there
  // would let the real echo escape.
  type AppliedSeek = { value: number; expiresAt: number; anyValue: boolean }
  let appliedSeekPosition: AppliedSeek | null = null
  let appliedPaused: boolean | null = null
  const APPLIED_SEEK_EPSILON = 0.5
  // Floored by the MSE respawn path, which waits up to 15 s for buffer-ahead on
  // a transcode (`use-mse-player.ts` waitForBufferAhead) before the seek lands.
  const APPLIED_SEEK_TTL_MS = 15000
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
  // The freshest state the element could not honor yet (#240) — see
  // applyRemoteState. `remoteStateApplied` is the "the room has told us where it
  // is" half of `hasRemoteStateApplied()`; both are cleared by
  // resetRemoteStateTracking.
  let pendingRemoteState: SyncplayRemoteState | null = null
  let remoteStateApplied = false

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

  // "This push comes from a new player" (#236). Main keys both of `setFile()`'s
  // resets — the adoption latch and the stale readiness flag — on it, and the
  // renderer is the only honest source: `buildCanonicalName()` is
  // `"{animeName} - {ep}"` with no translation component, so a same-episode
  // reopen re-pushes a byte-identical name at a brand-new element, and main's
  // other candidate (snapshot staleness) still reads "live" for
  // `PLAYBACK_STALE_MS` after the previous player closed — precisely the window
  // a close-and-reopen lands in.
  //
  // Mount-scoped rather than tied to the `onMounted` push: a player that mounts
  // *before* the session is `ready` skips that push at the guard below, and its
  // first announcement is then the transition-into-ready watcher's. Consumed
  // only by a push that actually goes out, for the same reason.
  //
  // Wrong in either direction is load-bearing: claiming it on a re-push tells
  // peers we are ready mid-buffer, and failing to claim it on a mount lets the
  // previous player's adoption latch yank the room to 0.
  let announcedThisMount = false

  function pushSyncplayFile(): void {
    if (syncplayStatus.value.state !== 'ready') return
    const dur = deps.getVideoEl()?.duration || deps.getDuration() || 0
    const newPlayer = !announcedThisMount
    announcedThisMount = true
    window.api.syncplaySetFile({
      animeId: deps.getAnimeId(),
      malId: deps.getMalId(),
      episodeInt: deps.getCurrentEpisodeInt() || deps.getActiveEpisodeLabel() || '',
      translationId: deps.activeTranslationId.value ?? null,
      canonicalName: buildCanonicalName(),
      duration: dur,
      newPlayer
    })
  }

  function sendSyncplayLocalState(cause: 'play' | 'pause' | 'seek'): void {
    if (syncplayStatus.value.state !== 'ready') return
    // Seeks are keyed on the value applied, not on the clock (#239). The
    // wall-clock window dropped *every* seek inside it — including the user's,
    // to a position nobody applied — so a skip-opening click landing right
    // after a remote apply (or inside the 1500 ms the readiness gate re-arms on
    // every buffer refill) moved only the local player and the room never
    // heard about it. `appliedSeekPosition` is what suppresses echoes now, and
    // every programmatic `currentTime` write arms it via markProgrammaticSeek.
    // play/pause keep the window: they have no equivalent value to key on.
    if (cause !== 'seek' && Date.now() < suppressNextLocalEventUntil) return
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
  // playing — so it keeps the pushes alive, and the 1 s floor keeps its ~4 Hz
  // rate from becoming IPC spam.
  //
  // Known gap, pinned rather than closed (#227): a *paused* player fires no
  // `timeupdate`, so the throttled interval is all it has, and a window hidden
  // for minutes therefore does cross PLAYBACK_STALE_MS (5 s) and get demoted to
  // the spectator mirror. Benign for the room — the mirror makes no pause claim
  // and never reports below the room position — but not free: spectating alone
  // in a paused room the server's own delay compensation walks `lastRoomState`
  // forward, so drift can pass ADOPT_TOLERANCE_S and the first post-unhide
  // action is dropped until a remote apply seeks us back. Fixing it means a
  // snapshot source that survives background throttling while paused; see
  // the "Known consequence" note on `buildPlaystate()` in syncplay.ts for
  // the forward-compensation mechanism (its "nobody is watching in that
  // state" framing predates this issue — a live paused player reaches it
  // too), and test/services/syncplay-room-presence.test.ts,
  // "a paused hidden player goes stale and recovers".
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

  // The seek-side counterpart (#239). Every `currentTime` the app writes on the
  // user's behalf — the MSE resume land, the quality/translation `savedTime`
  // restores, the episode-nav rewind to 0 — must arm this before the write, or
  // the resulting `seeked` reads as intent and the reference server broadcasts
  // it to the whole room (`forcePositionUpdate` sets *every* watcher's
  // position). The user's own paths (`seek()`, the scrubber's `commitSeek`)
  // deliberately do not.
  //
  // Value-agnostic, TTL-bounded — see the AppliedSeek comment above.
  //
  // Only armed when the write can actually move the element, the same rule
  // markProgrammaticPlayback states for an already-paused element: a write that
  // fires no `seeked` has nothing to consume its mark, so it latches for the
  // whole TTL and swallows the user's *next* real seek. Writing the position
  // the element already reports is exactly that case — and it is the normal
  // case for the two episode-nav rewinds, which run in a `nextTick` *after* the
  // `src` rebind, so the element has already reloaded to `readyState 0` at 0:
  // the write there only sets the *default playback start position*, which
  // fires nothing then and, being zero, is not seeked to when metadata arrives
  // either. The sites that do move the element still arm — including the same
  // rewind on the MSE/remux path, where `mseSrcUrl` has not been rebound yet so
  // the element still holds the old source at a non-zero position. Guarded here
  // rather than at the seven call sites so an eighth cannot forget it.
  //
  // The assumption that buys that: a write to the position the element already
  // reports fires no `seeked`. True at `readyState 0`, where five of the seven
  // current callers sit — the restores/rewinds, which run in a `nextTick` after
  // the `src` rebind. It is not true in general: the HTML seek algorithm has no
  // same-position early-out, so at `readyState >= HAVE_METADATA` a same-value
  // write still queues `seeking`/`seeked`. A future caller arming from a loaded
  // element would see that `seeked` arrive unmarked, send it as intent at the
  // position we are already at, and have `forcePositionUpdate` push it to every
  // watcher.
  //
  // The other two current callers are already post-metadata, and are safe for
  // their own reasons rather than this one. The MSE land runs from
  // `onSourceBufferUpdateEnd` under `sb.buffered.length > 0`, by which point
  // MSE's init-segment-received algorithm has taken the element to
  // `HAVE_METADATA`; its strict `t < resumeLandTarget` makes a same-value write
  // unreachable at any `readyState`, which is the stronger property.
  // `resumeFromSavedPosition` runs behind `readyState >= 1` (else on
  // `loadedmetadata`) and is gated on `saved.position > 5` while the element
  // sits at 0, so the two values cannot coincide.
  //
  // Kept broad rather than `&& v.readyState === 0`, which would confine it to
  // the pre-metadata case above: narrowing re-opens the latch on any engine
  // that short-circuits a same-value seek without firing events, and a latch
  // swallowing the user's real seek for 15 s is the defect this exists to fix,
  // while a redundant update at our own position is not.
  //
  // The residual latch is a write that does move the element but whose `seeked`
  // never arrives (an aborted load); the TTL is the backstop for that, and a
  // retraction path must not be added without a test for it.
  function markProgrammaticSeek(target: number): void {
    const v = deps.getVideoEl()
    if (v && v.currentTime === target) return
    appliedSeekPosition = {
      value: target,
      expiresAt: Date.now() + APPLIED_SEEK_TTL_MS,
      anyValue: true
    }
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

  // The element-independent half of an inbound state (#240). It runs on every
  // state, above the `getVideoEl()` lookup: the ready gate reads
  // `syncplayLastRemotePlaying`, so dropping it because no element is mounted
  // yet — or because the element cannot honor the write yet — leaves the gate
  // acting on a stale play intent the moment a player appears or the buffer
  // fills. `syncplayPausedBy` is the same class: it is UI state about the room,
  // not about our element.
  function recordRemoteState(state: SyncplayRemoteState): void {
    syncplayLastRemotePlaying = !state.paused
    const pausedChanged = syncplayLastAppliedPaused !== state.paused
    syncplayLastAppliedPaused = state.paused
    if (pausedChanged) {
      if (state.paused && state.setBy) syncplayPausedBy.value = state.setBy
      else if (!state.paused) syncplayPausedBy.value = null
    }
  }

  // The half whose result must reflect the *moment of the write*, so all of it
  // is deferred with the write and none of it is computed at park time:
  // - `effectivePaused` reads the live roster through `syncplayAllUsersReady()`;
  //   a park-time snapshot goes stale and would resume us over a peer that went
  //   not-ready in the meantime.
  // - the early-out and `suppressNextLocalEventUntil` gate *sending* around the
  //   element writes, so they have to fire when the writes do.
  // - `intendedPaused` is the room intent we assert on the next heartbeat;
  //   adopting it while the element still sits at 0 would report an intent we
  //   have not enacted.
  function applyRemoteStateToElement(state: SyncplayRemoteState, v: HTMLVideoElement): void {
    remoteStateApplied = true
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
      appliedSeekPosition = {
        value: target,
        expiresAt: Date.now() + APPLIED_SEEK_TTL_MS,
        anyValue: false
      }
      v.currentTime = target
    }
    if (needsPlayPause) {
      appliedPaused = effectivePaused
      if (effectivePaused) v.pause()
      // Retracted like every other failed call (#236). Swallowing the rejection
      // here latched `appliedPaused = false` for good: a remote resume refused
      // by autoplay policy fires no `play` event to consume its mark, and
      // `onLocalPlay()` then read the user's next real play as this echo, so it
      // never reached the room. This was the one mark site that structurally
      // could not retract — the same door the ready gate and useMsePlayer's
      // two `v.play()` sites already close, through the same function.
      else v.play().catch(() => markProgrammaticPlayback(null))
    }
    if (state.setBy && needsSeek) {
      showSyncplayToast(`${state.setBy} seeked to ${deps.formatTime(state.position)}`)
    }
  }

  // At `HAVE_NOTHING` the HTML spec routes a `currentTime` write to the
  // *default playback start position* instead of seeking: nothing fires then,
  // and the value is silently re-targeted by whatever writes `currentTime`
  // next — and on every episode open something does (`resumeFromSavedPosition`,
  // the MSE land, the nav rewinds). So an early remote position loses a race to
  // local state rather than moving the playhead. Hold the freshest state and
  // apply it when the element can honor it; no element at all is the same
  // condition, and the park is invalidated on an episode/translation switch and
  // on disconnect so a stale position is never adopted late.
  //
  // The fork, not a bare `loadedmetadata` listener: the common case is joining
  // a room with the element already loaded, where a listener-only apply would
  // never run. `>= 1` (HAVE_METADATA) rather than `>= 3` — duration and
  // seekability are all the apply needs, and waiting for future data would
  // reintroduce the same race on a slow network.
  function applyRemoteState(state: SyncplayRemoteState): void {
    recordRemoteState(state)
    const v = deps.getVideoEl()
    if (!v || v.readyState < 1) {
      // Overwrite, never queue: only the freshest state may be applied late.
      pendingRemoteState = state
      return
    }
    pendingRemoteState = null
    applyRemoteStateToElement(state, v)
  }

  function onVideoLoadedMetadata(): void {
    const state = pendingRemoteState
    if (!state) return
    const v = deps.getVideoEl()
    if (!v) return
    pendingRemoteState = null
    // Re-assert the bookkeeping at write time. It already ran when the state
    // arrived — that is the point of splitting it out, so the ready gate is
    // never stale — but a local play/pause during the wait overwrites it, and
    // the two halves then disagree: the parked state pauses the element and
    // adopts `intendedPaused = true` while `syncplayLastRemotePlaying` still
    // says the room is playing, so the very next `applySyncplayReadyGate()`
    // plays it again with `syncplayPausedBy` naming nobody. Re-running here
    // costs nothing on the immediate path (it just ran, so `pausedChanged` is
    // false) and makes the deferred apply re-assert *this bookkeeping* as of the
    // moment we enact it. The position is not made current the same way: it
    // carries main's one-shot `serverRtt / 2` compensation from emit time
    // (syncplay.ts:1223) and nothing advances the parked copy, so it applies
    // behind the room by the park's duration. Uncompensated on purpose — the
    // 1 Hz overwrite, the 3 s apply tolerance and main's adoption gate bound the
    // error; docs/syncplay.md, "Apply Rule".
    recordRemoteState(state)
    applyRemoteStateToElement(state, v)
  }

  // A remote episode change swaps the <video> source, and a state parked for the
  // previous episode must never be applied at the new one's `loadedmetadata`.
  // The applied flag is reset with it — it must not latch for the session: main
  // stops emitting `remote-state` the moment we are alone in the room, so a
  // latched flag would eat the user's saved position on every later episode
  // open, forever. Resetting inside a live room costs at most a sub-second flash
  // at the saved position before the next 1 Hz state seeks us to the room.
  function resetRemoteStateTracking(): void {
    pendingRemoteState = null
    remoteStateApplied = false
  }

  // Read-only view of the tracking above. Note what it does *not* promise: a
  // parked state that never reaches `loadedmetadata` — a load error, a dead
  // `.part`, a failed MKV prep — leaves this `true` until the next reset, so it
  // means "the room has told us where it is", not "the element is there". Every
  // current consumer runs at or after metadata (`resumeFromSavedPosition` is
  // reachable only from `loadedmetadata`/`readyState >= 1`, and the MSE land
  // only from an append that has already taken the element to HAVE_METADATA),
  // where the two coincide. A consumer that can run before metadata must not
  // read this as "the playhead is at the room's position".
  function hasRemoteStateApplied(): boolean {
    return pendingRemoteState !== null || remoteStateApplied
  }

  // Episode/translation switch: re-announce the file to peers but DO NOT
  // reset syncplayLastRemotePlaying. If a peer is currently playing,
  // applySyncplayReadyGate will start the new episode as soon as the buffer
  // fills — by design, so a remote "next episode" or local prev/next
  // auto-resumes the binge instead of pausing.
  watch([deps.activeEpisodeIndex, deps.activeTranslationId], () => {
    resetRemoteStateTracking()
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
    const mark = appliedSeekPosition
    if (mark) {
      if (Date.now() >= mark.expiresAt) {
        // Stale: whatever write armed it either never fired an event or its
        // event was consumed long ago. Drop it and read this as the user.
        appliedSeekPosition = null
      } else if (
        mark.anyValue ||
        (v && Math.abs(v.currentTime - mark.value) < APPLIED_SEEK_EPSILON)
      ) {
        // The element realizing a move we made — the peer's seek arriving back
        // at us, or one of our own programmatic writes. Not the user.
        appliedSeekPosition = null
        return
      }
      // A value-keyed mismatch leaves the mark armed on purpose: this is some
      // other `seeked` that arrived between the apply and its echo, and
      // consuming the marker here is what let the real echo escape (#224).
    }
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
      // Session-scoped, cleared with the session — the renderer half of main's
      // own split (`tearDown()` in syncplay.ts, which clears `snapshot`,
      // `lastRoomState` and `playbackAdopted` and which the reconnect path
      // deliberately skips). A *reconnect* keeps every ref below: same room,
      // same player, same user, and the element writes those markers stand for
      // may still be in flight. A session end keeps none of them, because room B
      // must not inherit room A's intent (#227).
      //
      // The one exception is the remote-state tracking, which is per-*socket*
      // and so resets here and on `reconnecting` alike — it is a receipt for
      // "the room has told us where it is", not the user's own intent, and its
      // issuer goes away on either. See the `reconnecting` branch below.
      syncplayLocalReady = true
      syncplayLastRemotePlaying = false
      syncplayLastAppliedPaused = null
      syncplayPausedBy.value = null
      // Intent, and the markers that gate it. Left set, a stale `intendedPaused`
      // reports room A's play state into room B, `appliedPaused` swallows
      // exactly one real play/pause of the next session, `appliedSeekPosition`
      // swallows its first real seek for the rest of the 15 s TTL,
      // `suppressNextLocalEventUntil` eats both the send and the `pausedBy`
      // attribution of the first intent recorded inside the dead session's
      // window, and `lastSnapshotPushAt` drops the first `timeupdate` snapshot
      // when the next session starts inside SNAPSHOT_MIN_INTERVAL_MS.
      //
      // Tradeoff, the twin of the widening #227 notes for the suppression
      // window: `appliedPaused` and `appliedSeekPosition` are also armed by
      // machinery that is *not* scoped to the syncplay session — the buffer
      // refill and the resume-from-middle land in `use-mse-player`, and
      // `PlayerView`'s saved-position restores. A session end landing between
      // one of those arms and the element's event un-marks it, so that echo
      // reaches the next room as a user action. One event, and the alternative
      // is the swallowed-event bug above — but it is the room-dragging
      // direction, so it is written down rather than discovered.
      intendedPaused = null
      appliedPaused = null
      appliedSeekPosition = null
      suppressNextLocalEventUntil = 0
      lastSnapshotPushAt = 0
      resetRemoteStateTracking()
      if (syncplayWaitingTimer) {
        clearTimeout(syncplayWaitingTimer)
        syncplayWaitingTimer = null
      }
    }
    if (status.state === 'reconnecting') {
      // A reconnect drops us out of the room: main stops emitting `remote-state`
      // and we may come back alone, so the tracking must unlatch here too or the
      // saved position is eaten on every later episode open — the failure the
      // reset exists to prevent, and what `docs/syncplay.md` already claims.
      // Only this tracking: it is per-socket, and this is the socket ending.
      // The user's intent is not — `intendedPaused`, `appliedPaused`,
      // `appliedSeekPosition`, `suppressNextLocalEventUntil`,
      // `lastSnapshotPushAt`, `syncplayLastRemotePlaying` and the ready flag all
      // deliberately survive a reconnect, unlike the `idle`/`disconnected`
      // branch above, which is a genuine session end. The two rules are not in
      // tension: a reconnect keeps what the *user* wants and drops what the
      // *room* told us, exactly as main keeps `roomUsers`/`ownIsReady` through
      // `resetTransportState()` while `tearDown()` clears them (#227, #240).
      resetRemoteStateTracking()
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
    markProgrammaticSeek,
    applySyncplayReadyGate,
    toggleSyncplayConnection,
    onVideoSeeked,
    onVideoTimeUpdate,
    onVideoWaiting,
    onVideoLoadedMetadata,
    hasRemoteStateApplied,
    onLocalPlay,
    onLocalPause,
    onLocalCanPlay
  }
}
