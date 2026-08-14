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

// How long a user pause made before adoption outranks the room (#228).
//
// Budget: <= 3 s to adopt + <= 1 s for the heartbeat that first asserts the
// pause + one RTT + <= 1 s for the server's own periodic State + one
// detector/IPC hop — about 5 s plus RTT worst case, so this leaves ~2.5 s of
// slack. The timer is the backstop, not the normal terminator: the `roomPaused`
// projection ends the hold as soon as the room actually goes paused.
const PENDING_PAUSE_MAX_MS = 8000
const PENDING_PAUSE_TOAST = 'Pausing once synced with the room…'
const PENDING_PAUSE_FAILED_TOAST = "The room kept playing — your pause didn't stick"

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
  /** The `"{animeName} - {ep}"` the `setFile()` push announces, so a caller can
   *  scope a room read to the file it is opening (#262). Exposed rather than
   *  rebuilt at the call site: two spellings of the canonical name would fail
   *  main's comparison on a difference nothing tests for. */
  buildCanonicalName: () => string
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
  // - `anyValue: false` — matched by value within APPLIED_SEEK_EPSILON.
  //   Deliberately strict: for a remote apply it is the only renderer-side echo
  //   guard the apply gets, and a value-agnostic one would swallow the user's
  //   first real seek after every apply. `markProgrammaticSeek` also arms this
  //   kind for its post-metadata same-value write (#258), where the target is
  //   by construction the position the element already holds — see there.
  // - `anyValue: true` — the ordinary write this app made on the user's behalf
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
  // A user pause made *before* main's adoption latch flipped (#228). It
  // outranks the room until it has had its chance to reach the room, and
  // nothing else in this file may resume the element while it is set.
  //
  // Why it has to exist at all: pre-adoption `sendLocalState()` sends nothing
  // and bumps no ignore counter (deliberately — a bump starves the very
  // convergence we are waiting for), so the pause inherits none of main's
  // `pendingClientAck` protection, and the next inbound playing state resumes
  // the element on two independent paths (the apply's `v.play()` and the ready
  // gate's). Adoption flipping true is *not* a clear path: the pause never
  // armed that counter and never will — post-adoption it is asserted only by
  // the heartbeat, which reads the counter but never writes it — so a playing
  // state already on the wire replays the same undo one RTT later.
  let pendingUserPause = false
  let pendingPauseTimer: ReturnType<typeof setTimeout> | null = null
  // Whether at least one *playing* remote state was actually held. Only a hold
  // that held something can have failed visibly, so this gates the expiry
  // toast — an expiry that held nothing is silent.
  let pendingPauseHeldAny = false
  let pendingPauseArmedAt = 0

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

  // The pending toast is the only one this composable ever retracts, because it
  // describes a state of affairs rather than an event: once the hold is over,
  // "Pausing once synced…" is a false statement on screen.
  function clearPendingPauseToast(): void {
    if (syncplayToast.value !== PENDING_PAUSE_TOAST) return
    syncplayToast.value = ''
    if (syncplayToastTimer) {
      clearTimeout(syncplayToastTimer)
      syncplayToastTimer = null
    }
  }

  // Arming (re)starts the window from scratch — a second press is a second
  // pause, with its own budget — and with it the "held something" record, so
  // the expiry toast can only ever describe the window it fires for.
  function armPendingUserPause(): void {
    pendingUserPause = true
    pendingPauseHeldAny = false
    pendingPauseArmedAt = Date.now()
    if (pendingPauseTimer) clearTimeout(pendingPauseTimer)
    pendingPauseTimer = setTimeout(expirePendingUserPause, PENDING_PAUSE_MAX_MS)
  }

  // Every ordinary end of the hold: the user changed their mind, the room went
  // paused (either observed directly through an inbound state or through the
  // `roomPaused` projection), the episode changed, or the session ended. Flag,
  // timer and pending toast go together — a surviving timer would toast a
  // failure for a hold that succeeded.
  function clearPendingUserPause(): void {
    if (!pendingUserPause && !pendingPauseTimer) return
    pendingUserPause = false
    pendingPauseHeldAny = false
    if (pendingPauseTimer) {
      clearTimeout(pendingPauseTimer)
      pendingPauseTimer = null
    }
    clearPendingPauseToast()
  }

  // The backstop. Reaching it with `roomPaused` in place means the room
  // genuinely never went paused inside the window, so the pause did not stick —
  // say so, and hand the badge back, since "Paused by you" is no longer true of
  // a room that kept playing. Silent — and the badge stands — when nothing was
  // held: no remote state ever contradicted the pause, so there is nothing to
  // report and nothing to correct.
  function expirePendingUserPause(): void {
    pendingPauseTimer = null
    const held = pendingPauseHeldAny
    pendingUserPause = false
    pendingPauseHeldAny = false
    if (held) {
      // Only a hold that held something can have failed visibly — and only then
      // is "Paused by you" no longer true. An expiry that held nothing may well
      // be sitting on a correct badge (a room already reported paused never
      // produces the `roomPaused` edge, so that hold runs to the backstop).
      syncplayPausedBy.value = null
      showSyncplayToast(PENDING_PAUSE_FAILED_TOAST)
    } else {
      clearPendingPauseToast()
    }
  }

  // Called from the element half, below its no-op early-out: a state that
  // early-outs moved nothing and so held nothing. The toast rides the remaining
  // window rather than the 3500 ms default, so it cannot outlive the hold it
  // describes.
  function notePendingPauseHeldState(): void {
    if (pendingPauseHeldAny) return
    pendingPauseHeldAny = true
    const remaining = Math.max(0, pendingPauseArmedAt + PENDING_PAUSE_MAX_MS - Date.now())
    showSyncplayToast(PENDING_PAUSE_TOAST, remaining)
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
  // TTL-bounded, and value-agnostic for the ordinary write — see the
  // AppliedSeek comment above.
  //
  // A mark is only worth arming the way its write can actually be observed, the
  // same rule markProgrammaticPlayback states for an already-paused element.
  // Writing the position the element *already reports* is the case that forks,
  // and which way depends entirely on `readyState`. Decided here rather than at
  // the seven call sites so an eighth cannot forget it.
  //
  // At `readyState 0` that write fires nothing: it only sets the *default
  // playback start position*, which — being zero — is not seeked to when
  // metadata arrives either. That is the normal case for the two episode-nav
  // rewinds, which run in a `nextTick` *after* the `src` rebind, so the element
  // has already reloaded to `readyState 0` at 0. A mark armed there has no
  // event to consume it, latches for the whole 15 s TTL and swallows the user's
  // *next* real seek — next episode → OP → Skip OP, which is #239's own defect
  // at a new site. So: arm nothing. Five of the seven current callers sit here,
  // the restores/rewinds behind the `src` rebind. The sites that do move the
  // element still arm normally, including the same rewind on the MSE/remux
  // path, where `mseSrcUrl` has not been rebound yet so the element still holds
  // the old source at a non-zero position.
  //
  // At `readyState >= HAVE_METADATA` the same write is *not* silent: the HTML
  // seek algorithm has no same-position early-out, so it queues
  // `seeking`/`seeked` like any other seek. Arming nothing there would let that
  // echo go out as intent at the position we are already at, and
  // `forcePositionUpdate` would push it to every watcher. So: arm, but key the
  // mark on the value (#258). Both engine behaviours are then bounded — a
  // spec-compliant engine lands its `seeked` at exactly `target`, well inside
  // APPLIED_SEEK_EPSILON, and the mark is consumed; an engine that
  // short-circuits the seek without firing anything leaves the mark latched for
  // the TTL, but a *value-keyed* mark can only swallow a later seek landing
  // within 0.5 s of where we already are, rather than the user's next real seek
  // anywhere on the timeline. That is strictly cheaper than either alternative
  // weighed in #254: a bare `return` leaks intent on a spec-compliant engine,
  // and an `anyValue: true` mark re-opens the wide latch on a short-circuiting
  // one.
  //
  // Value-keying is safe *here specifically*, against the standing reason
  // programmatic marks are value-agnostic — a `readyState 0` write is clamped
  // into `seekable` once metadata arrives, so a keyed mark would mismatch
  // exactly when the new release is shorter than `savedTime`. That objection
  // cannot reach this branch: it only fires when `target === v.currentTime`, so
  // the target is by construction already inside `seekable` and cannot be
  // clamped.
  //
  // The cost, paid knowingly: this used to be the one arming site that never
  // touched the slot, and it is now a writer, so it widens the set of paths
  // that can hit the single-marker residual (`docs/syncplay.md`). Deliberately
  // *not* guarded by "skip when a live mark already occupies the slot" — that
  // guard is strictly worse, because the un-armed same-value `seeked` then
  // either consumes the other mark (and the real echo it was holding escapes)
  // or goes out as intent itself, which is the hole this branch closes.
  //
  // Neither post-metadata caller can reach the branch today: the MSE land's
  // strict `t < resumeLandTarget` makes a same-value write unreachable at any
  // `readyState`, and `resumeFromSavedPosition` runs behind `readyState >= 1`
  // (else on `loadedmetadata`) gated on `saved.position > 5` while the element
  // sits at 0. This is for caller number eight.
  //
  // The residual latch is a write that does move the element but whose `seeked`
  // never arrives (an aborted load); the TTL is the backstop for that, and a
  // retraction path must not be added without a test for it.
  function markProgrammaticSeek(target: number): void {
    const v = deps.getVideoEl()
    if (v && v.currentTime === target) {
      if (v.readyState < 1) return
      appliedSeekPosition = {
        value: target,
        expiresAt: Date.now() + APPLIED_SEEK_TTL_MS,
        anyValue: false
      }
      return
    }
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
    // The pending pause is honored *at the action*, not by suppressing the
    // mirror write that feeds this (#228). Falsifying `syncplayLastRemotePlaying`
    // instead would flip the *pause* branch below against the user's own later
    // resume: the room really is playing, and the mirror's other consumers need
    // that truth.
    const shouldPlay = syncplayLastRemotePlaying && syncplayAllUsersReady() && !pendingUserPause
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
    // The room went paused: whatever the pending pause was waiting for has
    // happened (ours landed, or a peer's did), so the hold ends here and the
    // rest of this function runs normally — that fall-through is what hands the
    // badge over through the ordinary `pausedChanged` path below.
    //
    // Keyed on `state.paused`, never on the element half's `effectivePaused`: a
    // playing room we happen to be gating locally is still a playing room. And
    // placed here rather than in the element half because #240 guarantees *this*
    // function runs for every inbound state, parked or not, and re-runs at
    // unpark — the element half's early-outs can swallow a state entirely.
    if (state.paused) clearPendingUserPause()
    syncplayLastRemotePlaying = !state.paused
    const pausedChanged = syncplayLastAppliedPaused !== state.paused
    syncplayLastAppliedPaused = state.paused
    // The badge body is held while a pause is pending — the mirror writes above
    // are not, because their consumers need the room's truth. Otherwise the
    // first held playing state would clear "Paused by you" off a pause the user
    // can still see the element honoring.
    if (pausedChanged && !pendingUserPause) {
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

    // A playing state arriving while the user's pre-adoption pause is still
    // pending (#228). The seek half is applied anyway — withholding it would
    // stall the very adoption the hold is waiting for, since main's drift test
    // latches on the position the element reports — while the intent clobber,
    // the play/pause block and the seek toast are all skipped.
    //
    // The *whole* play/pause block, not just the `v.play()`: skipping only the
    // call would latch `appliedPaused = false` with no event left to consume
    // it, and the user's next real play would then be read as that echo and
    // never reach the room (the latch family `docs/syncplay.md` documents).
    //
    // The seek toast goes with it because during a hold the element is
    // deliberately behind, so `needsSeek` is true on essentially every apply and
    // "X seeked to …" would describe a seek nobody made, over the message that
    // matters.
    const holding = pendingUserPause && !state.paused
    if (holding) notePendingPauseHeldState()

    // Adopting the room's intent as our own — a later heartbeat must report
    // this, not whatever the buffer machinery has done to the element since.
    if (!holding) intendedPaused = state.paused
    if (needsSeek) {
      const target = Math.max(0, state.position)
      appliedSeekPosition = {
        value: target,
        expiresAt: Date.now() + APPLIED_SEEK_TTL_MS,
        anyValue: false
      }
      v.currentTime = target
    }
    if (needsPlayPause && !holding) {
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
    if (state.setBy && needsSeek && !holding) {
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
    // A new episode deliberately auto-resumes the binge through the gate (see
    // above), and a hold surviving the switch would sit on that resume until it
    // expired into a failure toast for a pause the user made an episode ago.
    clearPendingUserPause()
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
    // The user changed their mind — clear before the gate call below, or it
    // would pause the element they just resumed.
    clearPendingUserPause()
    // Unconditional since #228, like the pause half below: anything reaching
    // here is past the `appliedPaused` echo check, and by #224's classification
    // rule that makes it the user. The wall-clock window that used to gate this
    // is re-armed by *every* apply for 1500 ms, at ~1 Hz through the whole
    // convergence window, so it was shut for exactly the presses this issue is
    // about. It still gates sending (`sendSyncplayLocalState`), which is all it
    // was ever able to say something true about.
    //
    // This half ships with the pause half or not at all: relaxing the pause
    // side alone leaves a stale `false` here that the gate call below reads,
    // and "press play right after pausing" re-pauses itself.
    syncplayLastRemotePlaying = true
    syncplayLastAppliedPaused = false
    syncplayPausedBy.value = null
    sendSyncplayLocalState('play')
    applySyncplayReadyGate()
  }

  function onLocalPause(): void {
    if (appliedPaused === true) {
      appliedPaused = null
      return
    }
    intendedPaused = true
    // See onLocalPlay: the wall-clock gate that used to sit here was shut for
    // the whole convergence window, so the room mirror kept saying "playing"
    // through the user's own pause and the ready gate resumed the element a
    // beat later. Past the echo check this is the user, so the mirror follows
    // them — which also makes "Paused by you" appear on the press.
    syncplayLastRemotePlaying = false
    syncplayLastAppliedPaused = true
    if (syncplayStatus.value.state === 'ready' && syncplayStatus.value.username) {
      syncplayPausedBy.value = syncplayStatus.value.username
    }
    // Arm the hold: inside a session only, pre-adoption only, and only for an
    // element that has at least metadata (#228).
    //
    // `state === 'ready'` matches the `syncplayPausedBy` write above. Without
    // it every pause outside a session arms the flag and an 8 s timer; nothing
    // observable follows while there is no session (the gate early-outs, no
    // remote states arrive), but a join inside that window would start the new
    // session already mid-hold, holding the room's first states against a pause
    // that predates the room.
    //
    // `playbackAdopted !== true` scopes it to the window where main's ack
    // protection is off. Post-adoption the flag is redundant for anything that
    // reaches the wire, and alone in a room — where the roster test adopts
    // instantly — it would guarantee a failure toast nobody earned.
    //
    // `readyState > 0` is what excludes every reload-shaped implicit pause
    // without any PlayerView plumbing: the media load algorithm resets
    // `readyState` synchronously, and the `pause` event it (or the teardown
    // pause before a `src` swap) queues is delivered after that reset. The
    // residual is a real user pause on an element reporting HAVE_NOTHING, where
    // inbound states are parked anyway and pre-#228 behavior holds.
    if (
      syncplayStatus.value.state === 'ready' &&
      syncplayStatus.value.playbackAdopted !== true &&
      (deps.getVideoEl()?.readyState ?? 0) > 0
    ) {
      armPendingUserPause()
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
    // The room went paused (#228) — the pending pause has reached the room, or a
    // peer paused it, either of which ends the hold. This is the *normal*
    // terminator; the 8 s timer is only the backstop.
    //
    // An **edge**, not a level: a hold armed while the room is already paused
    // (we are locally gated, say) would be cleared on its very first status
    // emit by a level test, and the whole point is to wait for a *transition*.
    //
    // It carries the mirror repair, atomically. `syncplayLastRemotePlaying` is
    // whatever the last inbound playing state left behind — the hold masked it,
    // it did not undo it — so a bare clear hands the very next ready-gate entry
    // a `true` and it resumes the pause we just confirmed had landed.
    if (status.roomPaused === true && prev?.roomPaused !== true && pendingUserPause) {
      syncplayLastRemotePlaying = false
      syncplayLastAppliedPaused = true
      clearPendingUserPause()
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
      // Room B must not inherit room A's pending pause — nor its 8 s timer,
      // which would toast a failure into a session that never held anything.
      clearPendingUserPause()
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
    if (pendingPauseTimer) {
      clearTimeout(pendingPauseTimer)
      pendingPauseTimer = null
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
    // Exposed so `prepareMkvForPlayback` can scope its room-position read to the
    // file it is opening (#272 review). Deliberately the *same* function the
    // `setFile()` push uses rather than a second construction of the string in
    // PlayerView: two spellings of the canonical name would fail the comparison
    // in main on a difference nothing tests for.
    buildCanonicalName,
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
