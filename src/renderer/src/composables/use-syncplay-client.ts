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

// `HTMLMediaElement.HAVE_FUTURE_DATA` — the transition at which the can-autoplay flag is
// consulted, so `readyState <` it is exactly the window in which an armed element can still
// start itself (#348). Not read off `v`: the constant is absent on a `null` element and on the
// tests' fake video, so both disarm sites have to compare against the same number either way. At
// module scope because `setSyncplayLocalReady` calls a reader above it — TDZ, not a 3 (#349).
const HAVE_FUTURE_DATA = 3

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

// Shown when we refuse a room position that lies past the end of our own file
// (#281). It describes a state of affairs rather than an event, and it is
// emitted on the *transition into* that state only — see `refusedToastShown`.
const OUT_OF_FILE_TOAST = "Can't follow — the room is past the end of your file"

/** Which way a programmatic playback operation moves the element (#306). */
export type SyncplayPlaybackTarget = 'play' | 'pause'

/** What a programmatic playback operation *means*, which decides what its media
 *  echo establishes when it is consumed. See the registry block in
 *  `useSyncplayClient` for the full contract.
 *
 *  - `echo` — the room, the readiness gate, the MSE buffer machinery, the
 *    teardown pause. Consume the event and establish nothing: the caller has
 *    already written whatever intent it owns.
 *  - `restore` — the `if (wasPlaying)` resumes across a quality/translation
 *    source swap. Carry the captured playing intent onto the new source, unless
 *    a newer user action or remote adoption superseded it.
 *  - `episode-start` — `goToEpisode`'s unconditional plays. Establish the new
 *    episode's play intent once, so the previous episode's `intendedPaused` is
 *    not left behind. */
export type SyncplayPlaybackKind = 'echo' | 'restore' | 'episode-start'

/** Handle to one registered programmatic playback operation (#306).
 *
 *  Retraction is exact *by construction*: a caller can only ever retract the
 *  operation it holds, so a late `play()` rejection can no longer clear a newer
 *  operation's expectation the way `markProgrammaticPlayback(null)` could.
 *
 *  Renderer-local. The id never leaves this process — it reaches neither main,
 *  the preload bridge, nor Syncplay's wire protocol, which keeps its own ignore
 *  counters and knows nothing about any of this. */
export type SyncplayPlaybackOp = {
  readonly id: number
  /** Retract *this* operation and nothing else. A no-op once the operation has
   *  been consumed, has expired, or was already retracted. */
  retract: () => void
}

/** How a programmatic seek operation is matched to the element's `seeked`
 *  (#306 Phase B). Two kinds, differing only in how they are consumed (#239) —
 *  the seek registry block in `useSyncplayClient` has the full argument for
 *  each.
 *
 *  - `value` — matched by position, within `APPLIED_SEEK_EPSILON`. What a
 *    remote apply arms, and what the post-metadata same-value write arms.
 *  - `any` — matched by nothing but its own outstanding-ness: consumes the next
 *    `seeked` whatever position it reports, because the write frequently lands
 *    on an element at `readyState 0` and is clamped into `seekable` later. */
export type SyncplaySeekMatch = 'value' | 'any'

/** Handle to one registered programmatic seek operation (#306 Phase B).
 *
 *  The seek twin of `SyncplayPlaybackOp`, exact for the same reason: a caller
 *  can only ever retract the operation it holds, so a `currentTime` write that
 *  throws can no longer clear a newer operation's expectation the way the last
 *  writer of the single `appliedSeekPosition` slot could.
 *
 *  `id === 0` is the inert handle `beginProgrammaticSeek` returns when it
 *  deliberately arms nothing — the `readyState 0` same-position write, which
 *  fires no `seeked` and so has nothing to expect. Its `retract()` is a no-op,
 *  like any spent handle's, so callers need no special case.
 *
 *  Renderer-local. The id reaches neither main, the preload bridge, nor
 *  Syncplay's wire protocol. */
export type SyncplaySeekOp = {
  readonly id: number
  /** Retract *this* operation and nothing else. A no-op once the operation has
   *  been consumed, has expired, or was already retracted. */
  retract: () => void
}

/** The handle for "nothing was armed" — see `SyncplaySeekOp`. */
const NO_SEEK_OP: SyncplaySeekOp = { id: 0, retract: () => {} }

/** The slice of the preload bridge this composable reaches for.
 *
 *  Narrow on purpose, and derived from `Api` rather than hand-written: a
 *  renamed channel wrapper fails typecheck here instead of at the fourteen call
 *  sites. */
export type SyncplayBridgeApi = Pick<
  Api,
  | 'getSetting'
  | 'setSetting'
  | 'shikimoriGetUser'
  | 'syncplayConnect'
  | 'syncplayDisconnect'
  | 'syncplayPlayerClosed'
  | 'syncplaySendLocalSnapshot'
  | 'syncplaySendLocalState'
  | 'syncplaySetFile'
  | 'syncplaySetReady'
  | 'onSyncplayRemoteEpisodeChange'
  | 'onSyncplayRemoteState'
  | 'onSyncplayRoomEvent'
  | 'onSyncplayTrace'
>

export type SyncplayDeps = {
  /** The preload bridge to talk to main over. Defaults to the renderer's own
   *  `window.api`, which is what PlayerView wants and passes nothing for.
   *
   *  It is a dep rather than a global read (#361 step 3) because `window.api`
   *  is one object per renderer and the two-peer interaction harness runs two
   *  complete stacks in one process. Swapping the global around each peer
   *  cannot work: the mount at `onMounted` awaits `getSetting` *before* it
   *  installs its four subscriptions, and the 1 Hz snapshot interval fires on a
   *  clock nobody scopes — so either peer can reach the global while the other
   *  one owns it. Resolved once at setup, so the value a mount starts with is
   *  the value it keeps. */
  api?: SyncplayBridgeApi
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
  /** Register a pause/play this app performs itself — the readiness gate, a
   *  remote apply, an MSE buffer refill, a source-swap restore, an episode
   *  start, the teardown pause — so the resulting element event is never
   *  mistaken for the user's intent (#306).
   *
   *  Call it immediately *before* the `pause()`/`play()`, and only when the call
   *  will actually change the element: registering a `pause()` on an
   *  already-paused element fires no event, so the operation would sit in the
   *  registry until its TTL and swallow the next real press in between.
   *
   *  The returned handle retracts exactly this operation, for a `play()` whose
   *  promise rejects and whose `play` event therefore never arrives. */
  beginProgrammaticPlayback: (
    target: SyncplayPlaybackTarget,
    kind?: SyncplayPlaybackKind
  ) => SyncplayPlaybackOp
  /** The element's media source has been replaced (a quality swap rebinding
   *  `activeStreamUrl` on the same element, say). *Retires* every outstanding
   *  playback **and seek** operation rather than erasing it — one source
   *  generation governs both registries; see the registry blocks. */
  bumpPlaybackSourceGeneration: () => void
  /** Register a `currentTime` this app writes on the user's behalf (resume
   *  land, quality/translation restore, episode-nav rewind), so the resulting
   *  `seeked` is never broadcast to the room as the user's own seek (#306
   *  Phase B).
   *
   *  Call it immediately *before* the write. Whether the operation is matched
   *  by value or consumes the next `seeked` unconditionally is decided in here
   *  from `readyState`, not at the call site, so an eighth caller cannot get it
   *  wrong — including the "arm nothing" answer, which returns an inert handle.
   *
   *  The returned handle retracts exactly this operation, for a `currentTime`
   *  write that throws and whose `seeked` therefore never arrives. */
  beginProgrammaticSeek: (target: number) => SyncplaySeekOp
  /** "Should this element be playing right now?" — the readiness gate's own
   *  decision, exposed so a caller that is about to move the element can ask it
   *  instead of guessing (#347).
   *
   *  It reads the room mirror, roster readiness and the two local pause markers
   *  *live*, so it is only meaningful at the instant of the move. Not
   *  session-gated: `syncplayLastRemotePlaying` initialises `false`, so a caller
   *  outside a live session must decide for itself what that means. */
  shouldElementPlay: () => boolean
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
  // Resolved once, at setup, and never re-read — see `SyncplayDeps.api`.
  const api: SyncplayBridgeApi = deps.api ?? window.api
  const syncplayStore = useSyncplayStore()
  const { status: syncplayStatus, roomUsers: syncplayRoomUsers } = storeToRefs(syncplayStore)
  const syncplayRoomInput = ref('')
  const syncplayMenuOpen = ref(false)
  const syncplayToast = ref('')
  const syncplayPausedBy = ref<string | null>(null)

  let syncplayToastTimer: ReturnType<typeof setTimeout> | null = null
  let syncplaySnapshotTimer: ReturnType<typeof setInterval> | null = null
  let syncplayWaitingTimer: ReturnType<typeof setTimeout> | null = null
  // ── The programmatic seek operation registry (#306, Phase B) ──────────────
  //
  // The `currentTime` writes we are still waiting for the element to realize.
  // What this replaced on the seek side was a 1500 ms wall-clock guess, and a
  // seek on a network stream regularly completes later than that — the
  // element's `seeked` then escapes as our own seek and we hand the peer their
  // own position back with doSeek, dragging the room to a stale point and
  // bumping the ignore counter (which makes main drop the inbound states we
  // need). Keying on the write itself is exact, however long the element takes
  // to get there. That window is gone entirely as of #304; nothing in this
  // composable is bounded by a wall clock any more.
  //
  // Two match kinds, differing only in how they are consumed (#239):
  // - `value` — matched by position within APPLIED_SEEK_EPSILON.
  //   Deliberately strict: for a remote apply it is the only renderer-side echo
  //   guard the apply gets, and a value-agnostic one would swallow the user's
  //   first real seek after every apply. `beginProgrammaticSeek` also arms this
  //   kind for its post-metadata same-value write (#258), where the target is
  //   by construction the position the element already holds — see there.
  // - `any` — the ordinary write this app made on the user's behalf
  //   (`beginProgrammaticSeek`). Consumes the next `seeked` whatever position it
  //   reports, because the write often lands on an element at `readyState 0`:
  //   it becomes the *default playback start position*, fires no `seeked` then,
  //   and is clamped into `seekable` once metadata arrives — so the eventual
  //   event can sit arbitrarily far from what we asked for.
  //
  // Bounded by a TTL rather than a wall clock — a short window is the same
  // fragility this keying exists to remove — and an operation leaves the
  // registry on a consume, on its own retraction or on expiry, never on a
  // mismatch: between an apply and its echo any of the programmatic sites can
  // fire a `seeked`, and consuming an operation that does not match it would
  // let the real echo escape (#224).
  //
  // What Phase B replaced, and why the single slot had to go: one
  // `{ value, expiresAt, anyValue } | null` written by all eight arming sites.
  // Any second arming in flight clobbered the first, and the `seeked` already
  // queued for the clobbered write escaped to the room as the user's own seek —
  // the room-dragging direction, since the reference server's
  // `forcePositionUpdate` sets *every* watcher's position. The slot also had no
  // retraction path at all: a write that threw left its mark latched for the
  // whole TTL, and there was no way to remove one mark without removing
  // whichever mark happened to occupy the slot.
  //
  // Deliberately the mirror of the playback registry below: same identity, same
  // retirement derived from the one source generation, same bounded lifetime,
  // same "expiry releases, never vetoes" direction. The matching *rules* are
  // unchanged from the slot — only the bookkeeping is.
  type SeekOpRecord = {
    id: number
    /** The position written. */
    target: number
    match: SyncplaySeekMatch
    /** The media source generation the write was made against. Retirement is
     *  derived from it exactly as it is for playback operations, so a source
     *  swap has one thing to get right. A retired seek operation may still
     *  consume its own late `seeked` — that is why it is kept rather than
     *  erased — it is simply ordered behind the live ones. */
    generation: number
    expiresAt: number
  }
  const APPLIED_SEEK_EPSILON = 0.5
  // Floored by the MSE respawn path, which waits up to 15 s for buffer-ahead on
  // a transcode (`use-mse-player.ts` waitForBufferAhead) before the seek lands.
  const APPLIED_SEEK_TTL_MS = 15000
  // Hard cap, the twin of PLAYBACK_OP_MAX: a pathological run of writes whose
  // `seeked` never arrives cannot grow the registry without bound between
  // prunes. Oldest first — the same order they are consumed in.
  const SEEK_OP_MAX = 16
  let seekOps: SeekOpRecord[] = []
  let nextSeekOpId = 1

  function pruneSeekOps(now: number): void {
    if (seekOps.length === 0) return
    seekOps = seekOps.filter((op) => now < op.expiresAt)
  }

  // Reads `playbackSourceGeneration`, declared with the playback registry
  // below: one source generation governs both registries, so
  // `bumpPlaybackSourceGeneration()` retires seek and playback operations
  // together — they describe the same element and the same swap. Nothing here
  // runs during setup, so reading it from above is a reading order, not a
  // temporal one.
  function isSeekOpRetired(op: SeekOpRecord): boolean {
    return op.generation !== playbackSourceGeneration
  }

  function registerSeekOp(target: number, match: SyncplaySeekMatch): SyncplaySeekOp {
    const now = Date.now()
    pruneSeekOps(now)
    const rec: SeekOpRecord = {
      id: nextSeekOpId++,
      target,
      match,
      generation: playbackSourceGeneration,
      expiresAt: now + APPLIED_SEEK_TTL_MS
    }
    seekOps.push(rec)
    if (seekOps.length > SEEK_OP_MAX) seekOps.shift()
    return {
      id: rec.id,
      // Identity, not position: the array is spliced from the middle on every
      // consume, so an index captured here would retract a stranger.
      retract: () => {
        const i = seekOps.findIndex((o) => o.id === rec.id)
        if (i !== -1) seekOps.splice(i, 1)
      }
    }
  }

  // Deterministic matching, the twin of `consumePlaybackOp`: an operation is
  // eligible only if it *matches* this event — `any` matches anything, `value`
  // only a landing within APPLIED_SEEK_EPSILON of the position it wrote — and
  // among the eligible ones it is oldest first, current-generation ahead of
  // retired.
  //
  // Non-matching operations are left armed on purpose (#224): this `seeked`
  // belongs to some other write, and consuming an operation that does not match
  // it is exactly what let the real echo escape.
  //
  // The class order carries less weight here than it does for playback, because
  // no seek operation writes intent — consuming one only decides that *this*
  // event is not the user's. It is the same rule anyway, so the file has one
  // ordering to reason about, and it keeps a retired operation available for
  // its own late echo instead of erasing an expectation that is still owed.
  //
  // The residual, stated rather than hidden, and the same shape the playback
  // registry states: a raw `seeked` on a reused element carries no provenance.
  // A genuine user seek landing within APPLIED_SEEK_EPSILON of an outstanding
  // `value` operation — or landing anywhere at all while an `any` one is
  // outstanding — is indistinguishable from that operation's echo, and bounded
  // matching cannot decide it. Ordering also cannot rescue every interleaving:
  // an `any` operation registered before a `value` one will absorb the `value`
  // one's echo, leaving the later event to escape. The TTL is where the
  // ambiguity is cut off, and it always resolves toward "the user" — an expired
  // operation suppresses nothing.
  function consumeSeekOp(v: HTMLVideoElement | null): SeekOpRecord | null {
    const now = Date.now()
    pruneSeekOps(now)
    const matches = (o: SeekOpRecord): boolean =>
      o.match === 'any' || (!!v && Math.abs(v.currentTime - o.target) < APPLIED_SEEK_EPSILON)
    let idx = seekOps.findIndex((o) => matches(o) && !isSeekOpRetired(o))
    if (idx === -1) idx = seekOps.findIndex(matches)
    if (idx === -1) return null
    return seekOps.splice(idx, 1)[0]
  }
  // What *this user* wants the room to be doing. `v.paused` is not that: the
  // readiness gate and the MSE buffer machinery pause and resume the element
  // on their own, and reporting those as intent pauses the room on every
  // stall — and fights the user's own pause, which then "doesn't work".
  // null until something establishes it (a remote state we adopt, or the user
  // pressing play/pause); until then the element itself is the best answer.
  let intendedPaused: boolean | null = null
  // Bumped by every write that *establishes* intent — the user's own press, a
  // remote adoption, a navigation's episode-start (#306). A playback operation
  // records the revision it was registered at and may only write intent while
  // that revision still stands: anything newer has superseded the intent the
  // operation was queued to carry, so a delayed `wasPlaying` restore can never
  // undo the pause the user pressed while the new source was loading.
  let intentRevision = 0
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
  // The badge's edge memory, and only that (#350). It was called
  // `syncplayLastAppliedPaused` and read as a second room mirror, which it never
  // was: `syncplayLastRemotePlaying` above is the mirror — the ready gate reads
  // it — while this one had exactly **one** reader, `pausedChanged` in
  // `recordRemoteState`, and answers the narrower question "the last time the
  // room's paused-ness was *reported to us*, what did it say?". The name mattered
  // because five sites wrote it, and three of them were not reports about the
  // room: a consumed source-swap restore, the user's own play, and (by omission)
  // the hold expiry. Each left a `false` behind, so the next 1 Hz paused periodic
  // looked like a playing->paused edge and painted `setBy` — which on a periodic
  // is the server's `min(watchers)` election (`server.py`, `Room.getPosition()`),
  // not an actor. Renaming rather than adding a second flag is deliberate: a
  // parallel `badgeEdgePaused` beside a `syncplayLastAppliedPaused` nothing reads
  // would have left a write-only mirror behind for the next reader to trust.
  //
  // `null` is "nothing has reported the room yet", and the session-end write
  // restores it. It is deliberately *not* claimed to be observably different
  // from `false` at the badge: a first paused state is an edge either way, and a
  // first playing state either writes `null` over a `null` badge or writes
  // nothing. It is kept because the tri-state is the honest type for a memory of
  // reports, and because `false` would assert the room was playing at join.
  let badgeEdgePaused: boolean | null = null
  // The freshest state the element could not honor yet (#240) — see
  // applyRemoteState. `remoteStateApplied` is the "the room has told us where it
  // is" half of `hasRemoteStateApplied()`; both are cleared by
  // resetRemoteStateTracking.
  let pendingRemoteState: SyncplayRemoteState | null = null
  // The badge as it stood when that state was parked (#350). The unpark
  // re-asserts the room bookkeeping (see `onVideoLoadedMetadata`), and the badge
  // half of that re-assertion may only restate *this* — never `state.setBy` off
  // the parked frame. A park overwrites rather than queues, so at the room's
  // 1 Hz any park outliving a tick is holding a **periodic**, whose `setBy` is
  // the elected laggard; re-reading it at unpark would repaint a correct author
  // with a wrong one. What the room had told us when the frame was parked is the
  // only thing about authorship an unpark can honestly restate, and where the
  // park was unattributable it restates nothing.
  let pendingRemoteStatePausedBy: string | null = null
  let remoteStateApplied = false
  // The out-of-file refusal is emitted on the *transition into* the refusal, not per refused
  // state (#281). `showSyncplayToast` is not a debounce: it assigns the single toast slot and
  // *re-arms* the 3500 ms clear timer on every call, so a refusal emitted per inbound state
  // at 1 Hz would never expire, and last-writer-wins would swallow every other syncplay toast
  // for the whole divergence. Not a universal: a stream sparser than one per 3500 ms does
  // clear. Here it is the room's cadence, because what reaches us survives
  // `src/main/syncplay.ts:2097`/`:2098` — foreign-`setBy`, or room voice, which needs
  // de-adoption *and* a keyed roster with a peer (`:2489-2493`), not de-adoption alone. And
  // what fires this toast is what de-adopted main: `wouldSeek` needs `diff > 3.0` (:1282) on
  // the two positions main tests against `ADOPT_TOLERANCE_S` at `src/main/syncplay.ts:1924`,
  // writing the flag at `:1930`. Cleared where a state applies in range, alongside
  // `remoteStateApplied`, and — by default — in `resetRemoteStateTracking()`, which every file,
  // session and socket change runs. The clear is the default because the flag is a receipt for
  // a refusal already explained, about a file we may no longer have open: a forgetful caller
  // fails towards a redundant toast, not towards an explanation the user never sees. The one
  // opt-out, `resetRemoteStateTracking({ keepRefusalNotice: true })` on *reconnect* — same
  // room, same file, nothing new to say, and clearing it would let the refusal re-fire over
  // the reconnect notice — is counted by a guard test; a second needs the same argument.
  let refusedToastShown = false
  // "The user paused while the room was out of our file" (#281, slice B).
  //
  // Main de-adopts for that divergence (`src/main/syncplay.ts:1930`), so `sendLocalState()` returns
  // at its adoption gate and the room is never told about this pause, not even an ignore-counter
  // bump. The clear also lets the room's periodics survive `src/main/syncplay.ts:2097`:
  // `isForeignState || (setBy !== null && !playbackAdopted && rosterReceived && peers > 0)`, plus
  // `src/main/syncplay.ts:2098`'s `localChangeAcked`. So the room's next 1 Hz *playing* state would
  // resume the user, on a `needsPlayPause` computed independently of `outOfFile` by design (right
  // for pause, wrong for resume). We cannot tell the room anything, so it must not override us.
  //
  // Its own boolean, mirroring `refusedToastShown`: neither existing marker survives that stream
  // — which de-adoption alone need not produce, since with `List` unkeyable `rosterReceived`
  // stays false and `isRoomVoice()` returns there (`src/main/syncplay.ts:2492`), so only a peer's
  // foreign-`setBy` move arrives. `recordRemoteState()` nulls `syncplayPausedBy` on any
  // non-paused state, parked or not — already clobbered when the apply tests it — while
  // `intendedPaused` comes from the apply path and conflates "the room paused us" with "the user
  // paused". `pendingUserPause` is durable but must not arm here (see `onLocalPause`).
  //
  // Set in `onLocalPause()` beside the arming that is now gated off, and
  // cleared everywhere the refusal notice clears: on a state that applies in
  // range (the divergence is over, so ordinary sync resumes and the room wins
  // again), in `resetRemoteStateTracking()`, and on the user's own play — they
  // changed their mind, so there is no pause left to protect. Clearing it on
  // the in-range apply is what stops a stale marker from silently refusing the
  // *next* divergence's resume, which the user never paused for.
  let outOfFileUserPause = false

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
    // Close the badge's edge behind the whole window (#350), above the `held`
    // fork and in both arms. Nothing in this function is a report about the room,
    // so this is not one — it is the repair for the reports the hold swallowed.
    // Every playing state that arrived inside the window ran `recordRemoteState`
    // (the flag write is not held, only the badge body is) and left
    // `badgeEdgePaused = false`, while no *paused* state can have arrived at all:
    // `recordRemoteState` ends the hold on one, so this backstop is only ever
    // reached behind a run of playing frames. Leave the flag there and the very
    // next paused periodic reads as a playing->paused edge and paints the elected
    // watcher's name — over a badge this function has just cleared, or over the
    // "Paused by you" it deliberately leaves standing. Main drops our own pause
    // echo at its self-`setBy` guard (`src/main/syncplay.ts:2097`), so the frame
    // that would honestly have named us never reaches us; only the periodic
    // behind it does.
    //
    // Unconditional rather than paired with the hand-back, because the two arms
    // differ in what the badge shows and not in what the flag must say: `held` is
    // written by the *element* half below its no-op early-out, so a playing state
    // that early-outs — a peer went not-ready, `effectivePaused` stays true, the
    // element is already paused — arms the flag false without ever counting as
    // held, and the silent arm would otherwise carry that `false` out with
    // "Paused by you" still on screen for the next periodic to overwrite.
    //
    // One frame wide on purpose: once the room is observed playing again outside
    // a hold, `recordRemoteState` re-arms and the following transition paints as
    // usual. What that one frame costs in the silent arm is a *wrong* name and
    // not a missing one: a genuine peer forced-update pause landing inside it is
    // not an edge, so it is dropped and "Paused by you" keeps standing over it.
    // Bounded by the room's 1 Hz, and taken deliberately — the alternative is
    // the elected laggard repainted off every periodic behind the expiry.
    badgeEdgePaused = true
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

  // "Which player announced this file" (#307), on the same mount scope as the
  // flag above and for the mirror-image reason. `newPlayer` tells main a *new*
  // player has arrived; this tells it, on the way out, which player has left —
  // so main can clear `currentFile` and retire our room membership for the
  // mount that actually owned it, and decline to do so for a close that belongs
  // to an older one.
  //
  // Constant for the life of the mount rather than per-push, which is what makes
  // every re-announcement from this player — the duration push, the in-player
  // translation switch, the transition-into-ready push after a reconnect — keep
  // the claim rather than each one minting a new identity that the unmount could
  // no longer name.
  //
  // Built from the clock plus a CSPRNG draw rather than `crypto.randomUUID()`,
  // which needs a secure context this renderer does not guarantee under
  // `file://`. `crypto.getRandomValues` carries no such requirement and exists
  // in the renderer and in the Node test environment alike — and unlike
  // `Math.random()` it does not trip CodeQL's `js/insecure-randomness` rule.
  // Uniqueness only has to hold against the IDs main is currently holding, and
  // the clock component keeps it holding across a renderer reload — which
  // resets any module-scoped counter while main keeps the file it was told
  // about.
  const sessionEntropy = crypto.getRandomValues(new Uint32Array(1))[0].toString(36)
  const playerSessionId = `p-${Date.now().toString(36)}-${sessionEntropy}`

  function pushSyncplayFile(): void {
    if (syncplayStatus.value.state !== 'ready') return
    const dur = deps.getVideoEl()?.duration || deps.getDuration() || 0
    const newPlayer = !announcedThisMount
    announcedThisMount = true
    api.syncplaySetFile({
      animeId: deps.getAnimeId(),
      malId: deps.getMalId(),
      episodeInt: deps.getCurrentEpisodeInt() || deps.getActiveEpisodeLabel() || '',
      translationId: deps.activeTranslationId.value ?? null,
      canonicalName: buildCanonicalName(),
      duration: dur,
      newPlayer,
      playerSessionId
    })
  }

  // An element at HAVE_NOTHING carries no position worth putting on the wire
  // (#284). The media load algorithm resets the playhead synchronously and
  // `currentTime` then reads 0 for as long as the load runs — not "briefly":
  // see the note on `use-mse-player.ts`'s resume-from-middle path, where the
  // buffer begins hundreds of seconds in and Chromium stalls the element at 0
  // rather than auto-jumping the leading gap. That stall outlives this gate:
  // such an element is at HAVE_METADATA, not HAVE_NOTHING, so what takes it off
  // 0 is a write — the parked remote state applied from `loadedmetadata`, or,
  // when nothing is parked, the resume land (`use-mse-player.ts:308-324`, which
  // `:309-310` cancels in exactly the case where a state is). The door reopens at
  // metadata; the first honest position rides on that write, not on this test.
  //
  // Nothing upstream covers that window during an in-player translation or
  // quality switch, because adoption is *deliberately* retained across one:
  // `buildCanonicalName()` carries no translation component and `newPlayer` is
  // false on every push after a mount's first, so main's `setFile()` de-adoption
  // never fires — and the zeros themselves keep `hasLivePlayback()` true at 1 Hz,
  // so the stale-gap de-adoption never fires either. An adopted client
  // announcing `position: 0` wins `Room.getPosition()`'s `min()` and every peer
  // crosses its own `diff > 3.0` rule and is seeked to 0 — #220's "yanked
  // everyone back to 0", through the one door the adoption gate leaves open.
  //
  // The test is HAVE_NOTHING and not one notch higher, on purpose. An MSE
  // respawn drops `readyState` to HAVE_METADATA, never below, so this suppresses
  // nothing during a buffer refill; a stricter test would drop real positions
  // there and make PLAYBACK_STALE_MS (5 s) reachable — which costs adoption
  // *and* drops a live `seekIntent` in `maybeReassertSeek()`.
  //
  // Deliberately swallowed with the rest, and not collateral: the auto-resume
  // `v.play()` that PlayerView's restore `nextTick` fires while the element is
  // still at HAVE_NOTHING. `play` is dispatched regardless of `readyState`, so
  // `onLocalPlay` would otherwise send `paused: false, position: 0`. The resumed
  // intent is not lost — `intentOr(v)` carries it to the room on the first
  // post-load snapshot.
  function hasAnnounceablePosition(v: HTMLVideoElement): boolean {
    return (v.readyState ?? 0) >= 1
  }

  function sendSyncplayLocalState(cause: 'play' | 'pause' | 'seek'): void {
    if (syncplayStatus.value.state !== 'ready') return
    // No cause is gated on the clock any more (#304). Every cause this function
    // takes — `play`, `pause`, `seek` — reaches it only past its own operation
    // registry: `onVideoSeeked` returns above the send on `consumeSeekOp`
    // (#306 Phase B) and `onLocalPlay` / `onLocalPause` return above theirs on
    // `consumePlaybackOp` (#306 Phase A). So everything arriving here has
    // already been classified as the user's, and the 1500 ms
    // `suppressNextLocalEventUntil` window that used to sit on this line could
    // only drop presses the registries had already vouched for.
    //
    // Seek lost the window first (#239), for the reason the whole shape was
    // wrong: it dropped *every* seek inside it — including the user's, to a
    // position nobody applied — so a skip-opening click landing right after a
    // remote apply (or inside the 1500 ms the readiness gate re-armed on every
    // buffer refill) moved only the local player and the room never heard about
    // it. Play and pause failed the same way and were only harder to see: a
    // dropped pause never reaches main's discrete `sendLocalState` path, so a
    // stale playing frame resumed the initiator a beat later.
    //
    // The two ways a registry can still miss an echo are both documented in
    // docs/syncplay.md ("TTL direction"), and neither was ever bounded by a
    // 1500 ms window — a TTL expiry releases its event ten window-lengths late,
    // and a cap eviction needs 17 outstanding operations. Do not reintroduce a
    // wall-clock backstop here for either.
    const v = deps.getVideoEl()
    if (!v) return
    if (!hasAnnounceablePosition(v)) return
    api.syncplaySendLocalState({
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
    // See hasAnnounceablePosition: a reloading element's 0 is not a position
    // claim, and this door had no readiness term at all (#284).
    if (!hasAnnounceablePosition(v)) return
    lastSnapshotPushAt = Date.now()
    api.syncplaySendLocalSnapshot({
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

  // ── The programmatic playback operation registry (#306, Phase A) ──────────
  //
  // Replaces `appliedPaused`: one `boolean | null` slot, no TTL, written by six
  // sites and cleared by whichever `play`/`pause` event happened to arrive
  // next. Two defects came out of that shape, both written down in
  // docs/syncplay.md before this:
  //
  // - Retraction was a *heuristic*, not an identity. `markProgrammaticPlayback(
  //   null)` cleared whatever resume mark occupied the slot, so a `play()` that
  //   fired its event (consuming its own mark), was followed by a newer resume
  //   mark, and only then rejected, retracted the *newer* operation's mark — and
  //   the next programmatic resume read as user intent.
  // - The slot had no TTL at all, so a mark whose call fired no event latched
  //   for the life of the session and swallowed the user's next real press.
  //
  // The registry fixes both by giving every operation an identity, a target, a
  // kind, the source generation and intent revision it was made against, and a
  // bounded lifetime. Retraction goes through the handle, so it can only ever
  // remove the operation its caller registered.
  //
  // Renderer-local by construction: no operation id reaches main, the preload
  // bridge or Syncplay's wire protocol, and no IPC channel was added for it.
  // Main's protocol ignore counters are untouched and remain the wire-level
  // defense.
  //
  // Kind is the other half, and it is not decoration. `onLocalPlay`'s echo
  // branch returned *above* the intent and room-mirror writes, so a marked play
  // left `syncplayLastRemotePlaying` false; the nested `applySyncplayReadyGate()`
  // then read that unwritten mirror, computed `shouldPlay` false against an
  // un-paused element and took the down-arm — the stuck pause. Marking the
  // source-replacement plays *without* kinds reproduces it verbatim, which is
  // why the registry and the marking land together. See SyncplayPlaybackKind.
  //
  // Neither `restore` nor `episode-start` sends: they are physical echoes of a
  // navigation, not second copies of a user command, and `intentOr()` carries
  // the intent they establish to the room on the next heartbeat.
  type PlaybackOpRecord = {
    id: number
    target: SyncplayPlaybackTarget
    kind: SyncplayPlaybackKind
    /** The media source generation the call was made against. An operation
     *  whose generation is behind the current one is *retired*: its source has
     *  been replaced, so it may still consume its own late echo — that is the
     *  point of keeping it — but it can no longer write intent. Derived rather
     *  than stamped, so there is exactly one thing to get right on a bump. */
    generation: number
    /** The intent revision current when the operation was registered. */
    intentRevision: number
    expiresAt: number
  }
  // Bounded lifetime, which `appliedPaused` never had. Expiry only ever
  // *releases* an event toward being classified as the user's and sent; it is
  // never a new veto, so this is not — and must never become — the wall-clock
  // send-suppression window #304 deleted.
  //
  // 15 s, matching APPLIED_SEEK_TTL_MS, for the same reason: the MSE respawn
  // path waits up to 15 s for buffer-ahead, and a `play()` issued against an
  // element that is still fetching is the slowest echo we know how to produce.
  const PLAYBACK_OP_TTL_MS = 15000
  // Hard cap, so a pathological run of operations whose events never arrive
  // cannot grow the registry without bound between prunes. Oldest first — the
  // same order they are consumed in.
  const PLAYBACK_OP_MAX = 16
  let playbackOps: PlaybackOpRecord[] = []
  let nextPlaybackOpId = 1
  let playbackSourceGeneration = 0

  function prunePlaybackOps(now: number): void {
    if (playbackOps.length === 0) return
    playbackOps = playbackOps.filter((op) => now < op.expiresAt)
  }

  function isRetired(op: PlaybackOpRecord): boolean {
    return op.generation !== playbackSourceGeneration
  }

  function beginProgrammaticPlayback(
    target: SyncplayPlaybackTarget,
    kind: SyncplayPlaybackKind = 'echo'
  ): SyncplayPlaybackOp {
    const now = Date.now()
    prunePlaybackOps(now)
    const rec: PlaybackOpRecord = {
      id: nextPlaybackOpId++,
      target,
      kind,
      generation: playbackSourceGeneration,
      intentRevision,
      expiresAt: now + PLAYBACK_OP_TTL_MS
    }
    playbackOps.push(rec)
    if (playbackOps.length > PLAYBACK_OP_MAX) playbackOps.shift()
    return {
      id: rec.id,
      // Identity, not position: the array is spliced from the middle on every
      // consume, so an index captured here would retract a stranger.
      retract: () => {
        const i = playbackOps.findIndex((o) => o.id === rec.id)
        if (i !== -1) playbackOps.splice(i, 1)
      }
    }
  }

  // The element's source has been replaced. Outstanding operations are
  // *retired*, never erased: erasing them would hand their delayed raw
  // `play`/`pause`/`seeked` events to the user branch, and the old source's move
  // would go out as a fresh user command. A generation counter that only
  // invalidates is the trap here — retiring keeps the expectation alive,
  // defanged. Neither registry is touched: retirement is the generation moving
  // out from under the operations, not a write to them.
  //
  // One counter for both registries (#306 Phase B). It describes the element's
  // *source*, which is the thing that changed, and a seek expectation is as
  // stale across a swap as a playback one — the difference is only in what
  // retirement costs, since a retired seek operation writes no intent and so
  // only loses its place in the consume order.
  function bumpPlaybackSourceGeneration(): void {
    playbackSourceGeneration++
  }

  // Deterministic matching: same target, oldest first, current-generation
  // operations ahead of retired ones.
  //
  // The class order is the load-bearing half. Both orderings consume the same
  // *number* of events, but only this one guarantees the surviving intent write
  // is the live operation's: a retired operation writes nothing, so letting one
  // absorb the new operation's echo would silently drop the new intent — the
  // stuck pause by another route. Whichever physical event consumes it, what
  // lands is the intent the *live* operation recorded, never the retired one's.
  //
  // The residual, stated rather than hidden. A raw HTML media event on a reused
  // element carries no provenance at all: capturing the current generation
  // inside a handler discovers nothing about where the event came from. So an
  // event delivered after its operation expired, and a genuine user press that
  // is indistinguishable from an outstanding same-direction echo, are both
  // ambiguous, and bounded matching cannot decide them. The TTL is where that
  // ambiguity is cut off, and it always resolves toward "the user" — an expired
  // expectation suppresses nothing.
  function consumePlaybackOp(target: SyncplayPlaybackTarget): PlaybackOpRecord | null {
    const now = Date.now()
    prunePlaybackOps(now)
    let idx = playbackOps.findIndex((o) => o.target === target && !isRetired(o))
    if (idx === -1) idx = playbackOps.findIndex((o) => o.target === target)
    if (idx === -1) return null
    return playbackOps.splice(idx, 1)[0]
  }

  // The kind contract, applied at consume time.
  //
  // `echo` establishes nothing — its caller already did, and for a remote apply
  // that caller is `applyRemoteStateToElement`, which still adopts
  // `intendedPaused = state.paused` on its own line. `restore` and
  // `episode-start` perform exactly the intent and room-mirror updates the user
  // path performs, minus the send. Skipping those updates is what left the
  // mirror stale and let the nested ready-gate call re-pause the element.
  function applyConsumedPlaybackIntent(op: PlaybackOpRecord): void {
    if (op.kind === 'echo') return
    // A retired operation belongs to a source that no longer exists; a
    // superseded one to an intent that has already been overwritten by a newer
    // user press, navigation, or a remote state that reached the element. Both
    // still consume their echo — that is why they are tracked — but neither may
    // write.
    //
    // "Reached the element" is the narrow half, and deliberately so. The
    // revision is bumped in the *enactment block* of `applyRemoteStateToElement`
    // (use-syncplay-client.ts:1659-1662); #240 parks a state above that call whenever the element
    // is missing or below HAVE_METADATA, and `recordRemoteState` updates only the
    // room mirror and the badge. So a room pause landing in exactly the window a
    // `restore` lives in — between the source swap and its `play` echo — does
    // not supersede it, and the restore writes its resume.
    //
    // "The revision is bumped where intent is written" stopped being the way to
    // say that at #331: two sites in `applyRemoteStateToElement` now write
    // intent and only the enactment block's bumps. The narrow adoption above the
    // early-out (use-syncplay-client.ts:1540) deliberately does not, so a room state that reaches
    // the element half by the no-op path writes intent without superseding anything
    // — the argument for that omission is at :1474-1487, and
    // `does not supersede a queued episode-start across a run of no-op applies (#331)`
    // pins it.
    //
    // Bumping in `recordRemoteState` would close that and cost more than it buys — but the ~1 Hz
    // it is priced at is a *pre-adoption* rate. It runs for every inbound state that survives
    // `src/main/syncplay.ts:2097`/`:2098`, parked or not, and the three `restore` registrations
    // are same-episode: `isNewPlayer` is false at `src/main/syncplay.ts:789`, adoption holds, and
    // their own periodics die at that guard. Only `episode-start` clears adoption there, so only
    // it is registered where ~1 Hz holds. A superseded non-echo operation writes nothing, so
    // `intendedPaused` keeps its pre-swap value for the heartbeat to assert: room-dragging.
    //
    // What bounds the residual instead: while the element is parked `hasAnnounceablePosition()`
    // keeps the divergent snapshot off the wire, and `onVideoLoadedMetadata` re-applies the
    // parked state at unpark, adopting the room's `paused` and pausing the element. One thing
    // still moves in the meantime — the room mirror: `syncplayLastRemotePlaying` goes true
    // against a paused room, so a `canplay` or roster change landing inside the window takes the
    // gate's resume arm rather than its pause arm. `recordRemoteState` runs parked or not, so
    // it is back at the next inbound state surviving `src/main/syncplay.ts:2097`/`:2098` —
    // and *that*, not a heartbeat, is the bound: all five writers of `playbackAdopted = false`
    // (`src/main/syncplay.ts:789`, `:903`, `:996`, `:1032`, `:1930`) are events, not schedules,
    // so no timer in the tree caps the run. How often the harmful path is taken is #343.
    //
    // The badge used to move here too, and no longer does (#350). This consume cleared
    // `syncplayPausedBy` and wrote the edge flag `false`, so "Paused by <peer>" blinked off and
    // the next 1 Hz paused periodic read as a playing->paused edge and repainted the badge with
    // `Room.getPosition()`'s elected `min(watchers)`. Both writes are gone: a source swap or an
    // episode start is this app moving its own element, and it says nothing whatever about who
    // paused the room — not that nobody did, and not that somebody else did. Only the intent and
    // the room mirror belong to a consume, because those are what the restore actually performs.
    // Pinned by "a parked remote pause does not supersede a queued restore".
    if (isRetired(op) || op.intentRevision !== intentRevision) return
    // Defence in depth (#347), not the mechanism. What actually stops a stale
    // `restore` is the veto in PlayerView's `playProgrammatically`, which reads
    // `shouldElementPlay()` live at the replay and never registers the operation
    // at all; this is the second line, for a `restore` that reaches the consume
    // anyway.
    //
    // It has to be an early `return` — a sibling of the supersession test above —
    // and not a guard on the `intendedPaused` assignment alone, because the
    // writes below are a coupled set. Guarding one line would leave
    // `syncplayLastRemotePlaying = true`, `syncplayLastAppliedPaused = false`,
    // `clearPendingUserPause()` and `outOfFileUserPause = false` running, which
    // is three of `shouldElementPlay()`'s four terms satisfied — so the next gate
    // entry would resume the element against the very intent this preserved. The
    // un-pause would change doors, not stop.
    //
    // Why the revision test above cannot cover this: the narrow adoption at the
    // top of `applyRemoteStateToElement` writes `intendedPaused` and deliberately
    // does *not* bump the revision (the argument is at that site), so a room pause
    // adopted by a no-op apply leaves a queued `restore` comparing equal. The op
    // is current; the `wasPlaying` it was derived from is not.
    //
    // `consumePlaybackOp` has already spliced the record out, so returning here
    // still consumes the echo and leaves the registry clean. Keyed on `restore`:
    // `episode-start` *establishes* the new episode's intent rather than replaying
    // a stale one, so it is not what this is about.
    if (op.kind === 'restore' && op.target === 'play' && intendedPaused === true) return
    // Both non-echo kinds resume today. The pause direction is spelled out for
    // symmetry so a future `restore` of a paused source does not have to
    // rediscover which writes belong together.
    const paused = op.target === 'pause'
    intendedPaused = paused
    intentRevision++
    syncplayLastRemotePlaying = !paused
    if (!paused) {
      clearPendingUserPause()
      outOfFileUserPause = false
    }
  }

  // The seek-side counterpart (#239). Every `currentTime` the app writes on the
  // user's behalf — the MSE resume land, the quality/translation `savedTime`
  // restores, the episode-nav rewind to 0 — must arm this before the write, or
  // the resulting `seeked` reads as intent and the reference server broadcasts
  // it to the whole room (`forcePositionUpdate` sets *every* watcher's
  // position). The user's own paths (`seek()`, the scrubber's `commitSeek`)
  // deliberately do not.
  //
  // TTL-bounded, and value-agnostic for the ordinary write — see the seek
  // registry block above.
  //
  // An operation is only worth registering the way its write can actually be
  // observed, the same rule `beginProgrammaticPlayback` states for an
  // already-paused element. Writing the position the element *already reports*
  // is the case that forks, and which way depends entirely on `readyState`.
  // Decided here rather than at the seven call sites so an eighth cannot forget
  // it.
  //
  // At `readyState 0` that write fires nothing: it only sets the *default
  // playback start position*, which — being zero — is not seeked to when
  // metadata arrives either. That is the normal case for the two episode-nav
  // rewinds, which run in a `nextTick` *after* the `src` rebind, so the element
  // has already reloaded to `readyState 0` at 0. An operation registered there
  // has no event to consume it, latches for the whole 15 s TTL and swallows the
  // user's *next* real seek — next episode → OP → Skip OP, which is #239's own
  // defect at a new site. So: register nothing, and hand the caller the inert
  // handle. Five of the seven current callers sit here, the restores/rewinds
  // behind the `src` rebind — including the episode-nav rewind on the MSE/remux
  // path. `docs/syncplay.md` used to claim that one arms normally "because
  // `mseSrcUrl` has not been rebound yet"; #306 corrected it from source
  // reading (`startMseSession` assigns `mseSrcUrl` synchronously, inside the
  // awaited `prepareMkvForPlayback`, and the rewind's `nextTick` resolves after
  // the DOM patch), and Phase B carries that correction here. Source inspection
  // is not a browser reproduction either, so the claim is only that this branch
  // is *right for either answer*: at `readyState 0` there is no event to
  // suppress, and at `HAVE_METADATA` the write is value-keyed below.
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
  // programmatic operations are value-agnostic — a `readyState 0` write is
  // clamped into `seekable` once metadata arrives, so a keyed operation would
  // mismatch exactly when the new release is shorter than `savedTime`. That
  // objection cannot reach this branch: it only fires when
  // `target === v.currentTime`, so the target is by construction already inside
  // `seekable` and cannot be clamped.
  //
  // The cost the single slot charged for this branch is *gone* under the
  // registry (#306 Phase B), and that is the one thing here that changed. It
  // used to be the one arming site that never touched the slot, so making it a
  // writer widened the set of paths that could clobber another site's mark. A
  // registry has no slot to clobber: this operation is registered alongside
  // whatever else is outstanding and consumes only a `seeked` that matches it.
  // The old note that it is deliberately *not* guarded by "skip when a live
  // mark already occupies the slot" survives as history — there is no longer a
  // condition to write that guard against.
  //
  // Neither post-metadata caller can reach the branch today: the MSE land's
  // strict `t < resumeLandTarget` makes a same-value write unreachable at any
  // `readyState`, and `resumeFromSavedPosition` runs behind `readyState >= 1`
  // (else on `loadedmetadata`) gated on `saved.position > 5` while the element
  // sits at 0. This is for caller number eight.
  //
  // The residual latch is a write that does move the element but whose `seeked`
  // never arrives (an aborted load). The TTL is still the backstop, and it is
  // now joined by the handle: a caller whose write throws retracts *its own*
  // operation immediately (`use-mse-player`'s land is the one such caller
  // today), which is exact by construction and cannot disturb anything else
  // outstanding. That exactness is pinned by a named test — `use-mse-player`'s
  // "retracts exactly its own seek operation when the land write throws" — and
  // the rule that made it necessary still stands: a retraction path here owes a
  // test, because deleting the `retract()` call is otherwise green across the
  // whole suite.
  function beginProgrammaticSeek(target: number): SyncplaySeekOp {
    const v = deps.getVideoEl()
    if (v && v.currentTime === target) {
      if (v.readyState < 1) return NO_SEEK_OP
      return registerSeekOp(target, 'value')
    }
    return registerSeekOp(target, 'any')
  }

  function setSyncplayLocalReady(ready: boolean): void {
    if (syncplayLocalReady === ready) return
    syncplayLocalReady = ready
    if (syncplayStatus.value.state === 'ready') {
      api.syncplaySetReady(ready).catch(() => {})
    }
    applySyncplayReadyGate()
  }

  /** "Should this element be playing right now?" — the ready gate's own
   *  decision, behind a name (#347).
   *
   *  The pending pause is honored *at the action*, not by suppressing the mirror
   *  write that feeds this (#228). Falsifying `syncplayLastRemotePlaying`
   *  instead would flip the gate's *pause* branch against the user's own later
   *  resume: the room really is playing, and the mirror's other consumers need
   *  that truth.
   *
   *  `outOfFileUserPause` rides beside it for the same reason and on the same
   *  terms (#281, slice B): it is the marker that stands in for the hold in the
   *  one window the hold must not arm in, and the gate is the apply's twin
   *  resume path — `recordRemoteState()` writes `syncplayLastRemotePlaying`
   *  above every refusal, so without this a `canplay` or a roster change would
   *  resume the pause the apply just declined to.
   *
   *  Three callers, one definition. The gate enacts it; `onLocalPlay` reads it
   *  to decide whether the discrete play is worth sending; and PlayerView's
   *  `playProgrammatically` reads it to decide whether a `restore` latched
   *  before an await is still true. Until #347 the first two were hand-mirrored
   *  spellings of the same expression and the comment here warned that a fifth
   *  term had to be added to both — the warning is gone because the duplication
   *  is. A term added here now reaches every reader by construction.
   *
   *  Deliberately *not* session-gated: it answers about the element and the
   *  room mirror, and its callers decide what a dead session means for them.
   *  `syncplayLastRemotePlaying` initialises `false`, so a caller that must not
   *  refuse outside a session has to say so itself — see the `restore` veto. */
  function shouldElementPlay(): boolean {
    return (
      syncplayLastRemotePlaying &&
      syncplayAllUsersReady() &&
      !pendingUserPause &&
      !outOfFileUserPause
    )
  }

  function applySyncplayReadyGate(): void {
    if (syncplayStatus.value.state !== 'ready') return
    const v = deps.getVideoEl()
    if (!v) return
    const shouldPlay = shouldElementPlay()

    // The gate moves the element on the room's behalf, never the user's —
    // register it like a remote apply so the resulting event isn't mistaken for
    // intent however late the element gets around to firing it. `echo`: the
    // gate asserts no intent of its own, it only re-enacts what the mirror
    // already says.
    if (!shouldPlay && !v.paused) {
      beginProgrammaticPlayback('pause')
      v.pause()
    } else if (!shouldPlay && v.paused && v.readyState < HAVE_FUTURE_DATA) {
      // The armed-element half of the same intent (#348), beside the arm above
      // rather than folded into it: the two are answering different questions.
      // The arm above moves an element that is at the wrong paused value; this
      // one disarms an element that is at the *right* value and still about to
      // leave it, because `autoplay` re-arms on every `src` rebind and only the
      // internal pause steps clear the flag.
      //
      // The gate needs its own copy of this. Two of its four call sites run with
      // no apply anywhere in the path — `setSyncplayLocalReady` above, reached
      // from `onVideoWaiting`'s debounce and from `onLocalCanPlay`, and the
      // `watch(syncplayRoomUsers)` at the foot of this file, where a *peer's*
      // readiness flips `syncplayAllUsersReady()`. A roster change against a
      // cold armed element reaches neither arm otherwise: `!v.paused` above is
      // false and `shouldPlay` below is false.
      //
      // Off the registry and bare, for the reason spelled out at the apply site
      // (see `applyRemoteStateToElement`): `v.paused` is already true here, so
      // the internal pause steps clear the flag and fire no `pause` event, and
      // an operation registered for an event that never arrives latches for
      // `PLAYBACK_OP_TTL_MS` and swallows the user's next real press. `v.paused`
      // in the guard is what makes that safe — it is not a redundant restatement
      // of the arm above.
      v.pause()
    } else if (shouldPlay && v.paused) {
      const op = beginProgrammaticPlayback('play')
      v.play().catch(() => {
        // The call failed, so no 'play' event will ever consume this operation —
        // retract it, or the user's next real play is swallowed as this echo.
        // Exact: the handle retracts this operation and cannot touch a newer
        // one, which is what the old shared-slot `null` retraction could not
        // promise (#306).
        op.retract()
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
  //
  // `reassert` is the unpark's one exception, and it is narrower than it looks:
  // it does not force the edge test, it *replaces* the badge half with the badge
  // the park-time record left behind (#350, #240). See `onVideoLoadedMetadata`
  // for why the parked frame's own `setBy` may never be read there. The mirror
  // half needs no argument at all — `syncplayLastRemotePlaying` below is written
  // unconditionally on every call, above the edge test, which is the whole of
  // what #240's re-run repairs. It is also the one path that may overwrite a
  // local pause prediction made while the state sat parked: unlike a periodic's
  // re-elected `setBy`, the restated name is edge-derived — the room paused at
  // park time, not on a re-election — and names the peer who paused the room
  // before the user's own press landed, which is why the overwrite is right
  // here and wrong there.
  function recordRemoteState(
    state: SyncplayRemoteState,
    reassert?: { pausedBy: string | null }
  ): void {
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
    // The one place a *report about the room* moves the badge, and the only
    // reader of the edge flag (#350). `state.setBy` is spent here and nowhere
    // else, because only a frame that flips the room's paused-ness is a frame the
    // reference server attributes to an actor: `forcePositionUpdate` broadcasts
    // the pauser on the transition, while every periodic behind it carries a
    // `setBy` re-elected to `min(watchers)` by `Room.getPosition()`. A badge that
    // can be repainted from a periodic names the laggard.
    const pausedChanged = badgeEdgePaused !== state.paused
    badgeEdgePaused = state.paused
    // The badge body is held while a pause is pending — the mirror writes above
    // are not, because their consumers need the room's truth. Otherwise the
    // first held playing state would clear "Paused by you" off a pause the user
    // can still see the element honoring.
    if (pendingUserPause) return
    if (reassert) {
      syncplayPausedBy.value = state.paused ? reassert.pausedBy : null
    } else if (pausedChanged) {
      if (state.paused && state.setBy) syncplayPausedBy.value = state.setBy
      else if (!state.paused) syncplayPausedBy.value = null
    }
  }

  // The half whose result must reflect the *moment of the write*, so all of it
  // is deferred with the write and none of it is computed at park time:
  // - `effectivePaused` reads the live roster through `syncplayAllUsersReady()`;
  //   a park-time snapshot goes stale and would resume us over a peer that went
  //   not-ready in the meantime.
  // - the no-op early-out decides whether this apply moves anything at all, and
  //   the seek operation it guards is registered immediately before the write,
  //   so both have to fire when the writes do.
  // - `intendedPaused` is the room intent we assert on the next heartbeat;
  //   adopting it while the element still sits at 0 would report an intent we
  //   have not enacted.
  function applyRemoteStateToElement(
    state: SyncplayRemoteState,
    v: HTMLVideoElement,
    // Required, not defaulted: both call sites pass it, so a default would only
    // ever be exercised by a *third* one — and a second deferred unpark site
    // added later would silently take `false` ("immediate"), which is exactly
    // the misattribution the guard below removes. Required makes that caller a
    // typecheck error instead of a wrong toast (#289).
    deferred: boolean
  ): void {
    // Read before the `remoteStateApplied = true` below, which this same call
    // performs: "has the room placed us yet, on this socket" is only answerable
    // from the value on entry. Per socket, not per element — `remoteStateApplied`
    // resets on `reconnecting` too. See the seek-toast guard for what it decides.
    const firstApply = !remoteStateApplied
    // A room position past the end of *our* file is refused, not clamped (#281).
    // Clamping is measurably a no-op — Chromium's seek algorithm already clamps
    // to the seekable end, so a pre-clamped write and the raw write land on the
    // identical final frame — and clamping what the *room* initiates is a
    // documented non-goal (docs/syncplay.md, "Apply Rule"): a shortened position
    // we report back is an unsignalled room seek repeated at 1 Hz.
    //
    // Read at write time, from the element, per docs/syncplay.md's rule for the
    // element half. On the MSE path `v.duration` is `ms.duration` — main's
    // `probe.duration`, the same quantity #275 bounds the spawn against — and
    // after a mid-file respawn `endOfStream()` re-derives it from the buffered
    // ranges, which is `<=` the probe's and so can only refuse a position we
    // could not have reached anyway.
    //
    // Fail-open on a duration we do not have: a moov-at-end MP4 reports
    // `NaN`/`Infinity` until it is complete, and refusing on an unknown duration
    // would refuse every legitimate position on such a file. A growing `.part`
    // is *not* this case — it reports the finished container's duration, so a
    // position past the download frontier is still followed and still stalls on
    // purpose.
    const outOfFile = Number.isFinite(v.duration) && v.duration > 0 && state.position >= v.duration
    const diff = Math.abs(v.currentTime - state.position)
    // Folded into `needsSeek` rather than applied below it, so all four
    // seek-keyed effects fall away together: the no-op early-out, the seek
    // operation that guards the echo, the write itself and the "X seeked to …"
    // toast — which would otherwise announce a seek to a timestamp that does
    // not exist in our file.
    // `needsPlayPause` is computed independently, so a room *pause* carried on
    // an out-of-file state is still honored.
    const wouldSeek = state.doSeek || diff > 3.0
    if (!outOfFile) {
      remoteStateApplied = true
      refusedToastShown = false
      outOfFileUserPause = false
    } else if (wouldSeek && !refusedToastShown) {
      // Ahead of the no-op early-out below: a refused position whose paused flag
      // already matches moves nothing, but the user still has to be told why the
      // room and their playhead have parted company. Gated on `wouldSeek` and
      // not on `outOfFile` alone, because a position inside the 3 s tolerance
      // suppressed no seek — which is the ordinary end of the file, where the
      // room's own position crosses our duration on identical files.
      refusedToastShown = true
      showSyncplayToast(OUT_OF_FILE_TOAST)
    }
    const needsSeek = !outOfFile && wouldSeek
    const effectivePaused = state.paused || !syncplayAllUsersReady()
    // The resume half of the same refusal (#281, slice B). A room *pause* is
    // still honored — that direction costs the user nothing and keeps the two
    // ends agreeing about the one thing they still can — but a resume that
    // would undo a pause the user made while we were out of file is refused for
    // the length of the divergence, because main is silent and that pause has
    // no other way of holding.
    //
    // Folded into `needsPlayPause` rather than applied below it so the no-op early-out still fires:
    // `outOfFile` forces `needsSeek` false, so a refused resume would otherwise fall into the body
    // once a second for the whole divergence — clobbering `intendedPaused` back to "playing" and
    // bumping `intentRevision` on every frame, the intent the refusal exists to keep. Real here:
    // main de-adopts (`src/main/syncplay.ts:1930`), so frames clear `src/main/syncplay.ts:2097` as
    // foreign-`setBy` or as room voice — de-adopted plus a keyed roster with a peer.
    const refusingResume = outOfFile && outOfFileUserPause && !effectivePaused && v.paused
    const needsPlayPause = effectivePaused !== v.paused && !refusingResume

    // Adopting the room's intent on a path that moves nothing (#331). The
    // enactment block below adopts it too, but the early-out on the next line
    // sits above that write, so an apply whose position and paused-ness the
    // element already matches used to adopt nothing — while
    // `pushSyncplaySnapshot` announces `intentOr(v)` (`intendedPaused ??
    // v.paused`, :444), not `v.paused`.
    //
    // What makes that a lost pause rather than a cosmetic gap. Nothing but the
    // user handlers and this adoption writes `intendedPaused`: an `echo`
    // operation establishes nothing by contract (:915), and every pause the app
    // makes on its own behalf that an element can *report* is an echo — the
    // readiness gate's down-arm (:1155-1157), a remote apply, an MSE buffer
    // refill, PlayerView's teardown. The two `autoplay` disarms (#348) are the
    // exception that does not disturb this, and the qualifier is what carries
    // them: each runs only on an element that is already paused, where the
    // internal pause steps fire no `pause` event at all, so neither reaches
    // `onLocalPause` to be classified in the first place — which is also why
    // neither registers an operation. So with intent already established as `false` (the user pressed
    // play, or an earlier apply adopted a playing room; from `null` there is no
    // divergence at all, because `intentOr`'s fallback is the element's own
    // `true`), a gate down-arm pauses the element and leaves `intendedPaused`
    // *unchanged* at `false`. A room **pause** then needs no element move, takes
    // the early-out below, and the 1 s interval announces `paused: false` into the room the user
    // just paused. Not repaired on a schedule: main's `canAssertSnapshot()` asserts it, the
    // server un-pauses the room, and the next inbound state's `syncplayLastRemotePlaying =
    // !state.paused` (use-syncplay-client.ts:1333) flips the mirror the divergence relied on —
    // but only a state surviving `src/main/syncplay.ts:2097`/`:2098` gets there, past adoption
    // maybe none. From there the room is playing, and nothing restores the pause. #324's lost
    // play, in the pause direction.
    //
    // **No `intentRevision++`**, and not because this site is
    // `recordRemoteState`'s under another name — it is not. That one is called
    // above #240's `readyState < 1` park and this one runs only for states that
    // got past it, which is the whole subject of the comment in
    // `applyConsumedPlaybackIntent`: a `restore` registered in the `nextTick`
    // after a source swap lives inside the parked window precisely because the
    // park is there. What carries the omission is a bound of its own, and it is structural, not a
    // rate: a surviving `restore`'s clobber of `intendedPaused` stands until the next inbound
    // state surviving `src/main/syncplay.ts:2097`/`:2098` — the room mirror repairs on that same
    // gated state, `use-syncplay-client.ts:1333` — and no timer, ack, re-adoption or roster event
    // caps that run: uncapped by any schedule in the tree. Reachability is #343. Bumping here
    // would instead supersede queued operations within a second of registration — but only
    // pre-adoption, where `episode-start` is registered and the three same-episode `restore`s are
    // not — against the residual #324 accepted for the racing half.
    //
    // **`!outOfFile`, deliberately broader than `!refusingResume`:** *any*
    // intent write above the early-out is unsafe for the whole out-of-file
    // divergence, not only for the frames the refusal is actually firing on.
    // `refusingResume` carries `!effectivePaused` (:1441) and `effectivePaused`
    // folds in `!syncplayAllUsersReady()` (:1427), so one peer going not-ready
    // makes the refusal false while `outOfFileUserPause` is still armed: a room
    // resume then reaches this line with `v.paused` still true (the gate's
    // resume arm needs `!outOfFileUserPause`, :1243, so nothing resumed us),
    // `needsPlayPause` false and `needsSeek` false under `outOfFile`, and
    // nothing clears the marker in the meantime. A `!refusingResume` guard would perform there,
    // once a second for the whole divergence — main is de-adopted for its length, so the room's
    // own frames clear `src/main/syncplay.ts:2097` — exactly the clobber :1306-1311 says the fold
    // exists to prevent. Do not narrow it to match a prose description of the refusal.
    //
    // **`!holding`** is not implied by that term, and it is reachable rather
    // than defensive. An MSE buffer refill pauses the element and holds
    // `setSyncplayLocalReady(false)` for its duration
    // (`use-mse-player.ts:431`/`:472`), re-playing it on the way out whenever
    // `wasPaused` was false (`:446-456`, `:462-470`). A user pause landing
    // inside that window arms `pendingUserPause` with `intendedPaused = true`;
    // the re-play returns `v.paused` to false through a `play` consumed as an
    // `echo`, which establishes nothing, so the hold survives to meet a
    // playing-room heartbeat with `effectivePaused === v.paused === false`. An
    // unguarded write here would clobber the user's own pause on that frame.
    //
    // That term covers the **pre-adoption** half of a user pause and only that
    // half: the hold arms under `playbackAdopted !== true` (:1986), so a press
    // made after adoption arms nothing and `holding` is false here. What covers
    // the same shape post-adoption is main, not this line — `sendLocalState`
    // bumps `clientIgnoreCounter`/`pendingClientAck` on the discrete pause
    // (`syncplay.ts:884-885`) and `handleState` drops every inbound state while
    // that ack is outstanding (`syncplay.ts:2098-2100`), so the playing state
    // that crossed the press on the wire is dropped rather than applied. The ack
    // is normally cleared by the frame that echoes the counter back
    // (`syncplay.ts:1793`) — but not only: a server-forced State zeroes it
    // unconditionally (`syncplay.ts:1782`), above the `localChangeAcked` read at
    // `syncplay.ts:1972`, so such a frame clears the ack and passes the drop
    // guard in the same `handleState` call. That is the ~1 RTT of lost echo
    // protection `syncplay.ts:1774-1781` accepts by name; in that window the
    // cover is a trade-off rather than a guarantee. The split is
    // named at the arming site (:1931-1934) and from main's end
    // (`syncplay.ts:543-546`), but not where a reader of `!holding` needs it: the
    // gap would be this same defect mirrored — such a state arriving with one
    // peer not ready has `effectivePaused === v.paused === true`, so it is a
    // no-op, and the write would put `intendedPaused = false` over the user's
    // own pause.
    //
    // Only the `holding` **binding** hoists above the early-out.
    // `notePendingPauseHeldState()` stays below it, per its own contract
    // (:560-563): a state that early-outs moved nothing and so held nothing.
    const holding = pendingUserPause && !state.paused
    if (!outOfFile && !holding) intendedPaused = state.paused

    // Enacting a paused intent on an element that is still *armed* (#348).
    // Hoisted above the early-out for the same reason the intent write on the
    // line above is: an apply that moves nothing still has something to do.
    //
    // `PlayerView.vue`'s `<video>` carries a bare `autoplay` attribute, and the
    // HTML media element load algorithm re-sets the *can autoplay flag* on every
    // `src` rebind — so a cold element is armed to start playing on its own the
    // moment it has data, whatever the room intends. Only the internal pause
    // steps clear that flag. `needsPlayPause` cannot see this: it tests
    // `effectivePaused !== v.paused`, which answers "is the element at the right
    // paused value" and not "has the element been *told* to be at it". A cold
    // element already reads `paused === true`, so a paused room made this apply
    // a no-op, it returned on the line below, and the element autostarted a few
    // frames later and destroyed the pause the user had just taken.
    //
    // `v.readyState < 3` because HAVE_FUTURE_DATA is the transition at which the
    // can-autoplay flag is consulted, so `readyState < 3` *is* the window in
    // which the element can still autostart. (Not by analogy to the park's
    // `readyState < 1` fork: that is unsatisfiable at both call sites of this
    // function, and a disarm written against it never fires.)
    //
    // **`v.paused` is load-bearing and the bare `v.pause()` below depends on it.
    // Do not simplify it away.** Two things rest on it, both by construction:
    //
    // - It makes this arm mutually exclusive with the enactment block below,
    //   whose `needsPlayPause` forces `v.paused === false` whenever
    //   `effectivePaused` is true. So a warm element takes that path exactly
    //   once and never both.
    // - It is why **no programmatic operation is registered here, deliberately.**
    //   Clearing the can-autoplay flag is unconditional in the internal pause
    //   steps, but firing the `pause` event is guarded on the element not
    //   already being paused — so on an already-paused element this call
    //   disarms and fires *nothing*. An operation registered for it would never
    //   be consumed and would sit in the registry for the full
    //   `PLAYBACK_OP_TTL_MS` (use-syncplay-client.ts:916), where the user's next genuine pause would
    //   match it and be swallowed as an echo. That is the latch family #236
    //   records one line-block below, on the play side.
    //
    // Drop `v.paused` and both arguments fail at once: `effectivePaused` is
    // `state.paused || !syncplayAllUsersReady()` (use-syncplay-client.ts:1427), a disjunction, so it is
    // true on a *playing* room whenever readiness is down — and a bare
    // `v.pause()` on an element that is still playing fires a real `pause` event
    // that `onLocalPause` reads as the user and announces to the room. A pause
    // nobody pressed, which is this bug's mirror image.
    if (effectivePaused && v.paused && v.readyState < HAVE_FUTURE_DATA) v.pause()

    if (!needsSeek && !needsPlayPause) return

    // A playing state arriving while the user's pre-adoption pause is still
    // pending (#228). The seek half is applied anyway — withholding it would
    // stall the very adoption the hold is waiting for, since main's drift test
    // latches on the position the element reports — while the intent clobber,
    // the play/pause block and the seek toast are all skipped.
    //
    // The *whole* play/pause block, not just the `v.play()`: skipping only the
    // call would leave a resume operation registered with no event left to
    // consume it, and the user's next real play would then be read as that echo
    // and never reach the room until the operation's TTL ran out (the latch
    // family `docs/syncplay.md` documents; #306 bounds it, it does not remove
    // the reason to skip the whole block).
    //
    // The seek toast goes with it because during a hold the element is
    // deliberately behind, so `needsSeek` is true on essentially every apply and
    // "X seeked to …" would describe a seek nobody made, over the message that
    // matters.
    //
    // That same argument reaches two shapes that have nothing to do with a hold,
    // and the seek toast's guard below carries it (#289). An apply that is
    // *deferred* — parked below `HAVE_METADATA` and written from
    // `onVideoLoadedMetadata()` — starts from an element at 0, so `diff` is the
    // room's whole position and `needsSeek` is true for any room past 3 s. So
    // does the *first* apply of a socket, which takes the immediate path when we
    // join with the file already loaded. In both, we did not move: we arrived.
    // The toast would name a peer for a placement, at whatever position the room
    // happened to be at.
    //
    // Neither test subsumes the other, so the guard is their disjunction rather
    // than either alone. `remoteStateApplied` is not per-element — it is reset
    // only by `resetRemoteStateTracking()`, i.e. on the episode/translation
    // watch, on `idle`/`disconnected` and on `reconnecting` — while
    // `selectQuality()` in PlayerView rebinds the stream URL on the *same*
    // element with no episode or translation change, dropping it to
    // `readyState 0` and parking states with the flag still set. That mid-session
    // source swap is a placement `firstApply` cannot see and `deferred` can.
    //
    // `firstApply` is therefore per-*socket*, not per-element, and a **reconnect
    // is a socket ending** — which is the same reason the flag resets there at
    // all. So the first state after the socket returns is silent even though the
    // element was never touched: still loaded, still at the user's real position.
    // That is the right answer, not a leak. Across the gap we cannot tell "a peer
    // scrubbed" from "the room simply played on while we were down" — main's own
    // `doSeek` is one-shot, so a peer's scrub during the outage reaches us as a
    // plain heartbeat re-sending the position — and naming a peer for the second
    // is the same class of lie this guard removes. One *applying* frame of
    // silence: `remoteStateApplied` is armed on the `!outOfFile` branch only, so
    // a room past our duration when the socket returns keeps `firstApply` true
    // until the first in-file apply — which is still that socket's first
    // placement, so it is still the right answer. A peer's *next* real move
    // toasts normally.
    //
    // `state.doSeek` re-admits the toast on both paths, and is why this is a
    // suppression of *attribution* and not of the message: a `doSeek` frame is
    // the server relaying a peer's actual seek, which is a real event to report
    // even if we happened to be loading when it landed. Only the inferred
    // `diff > 3.0` arm invents a mover.
    if (holding) notePendingPauseHeldState()

    // Adopting the room's intent as our own — a later heartbeat must report
    // this, not whatever the buffer machinery has done to the element since.
    // The narrow adoption above the early-out (#331) has already written this
    // same value on every path that reaches here except the out-of-file one;
    // this write is what bumps the revision, and the only one that does.
    //
    // Kept, deliberately, under #306: the operation registry changes how the
    // resulting *echo* is classified, not who establishes intent here. The
    // revision bump is what supersedes an older queued `restore` — the room has
    // spoken more recently than the source swap did.
    if (!holding) {
      intendedPaused = state.paused
      intentRevision++
    }
    if (needsSeek) {
      const target = Math.max(0, state.position)
      // The direct-arming site the seek rewrite is easiest to miss (#306 Phase
      // B), the twin of the `appliedPaused` one below: this one wrote the
      // `appliedSeekPosition` slot inline rather than going through the helper,
      // so it inherited neither an identity nor a retraction path, and any
      // other site's arming could clobber it.
      //
      // It registers a `value` operation *directly* rather than through
      // `beginProgrammaticSeek`, and deliberately so: the apply's strictness is
      // not a `readyState` decision but a standing property of this site. #240
      // makes this the sole renderer-side seek-echo guard for a deferred apply,
      // and a value-agnostic operation would swallow the user's first real seek
      // after every apply. The target is `Math.max(0, state.position)` — the
      // same number main emitted — so the renderer operation and main's
      // `lastAppliedRemotePosition` backstop agree on one value.
      registerSeekOp(target, 'value')
      v.currentTime = target
    }
    if (needsPlayPause && !holding) {
      // The direct-arming site the single-slot rewrite is easiest to miss
      // (#306): this one wrote `appliedPaused` inline rather than going through
      // the mark helper, so it inherited neither the retraction nor the TTL.
      // `echo`, because the intent write above is where this apply establishes
      // what it wants — the element move below is only its enactment.
      if (effectivePaused) {
        beginProgrammaticPlayback('pause')
        v.pause()
      } else {
        // Retracted like every other failed call (#236). Swallowing the
        // rejection here latched `appliedPaused = false` for good: a remote
        // resume refused by autoplay policy fires no `play` event to consume its
        // mark, and `onLocalPlay()` then read the user's next real play as this
        // echo, so it never reached the room.
        const op = beginProgrammaticPlayback('play')
        v.play().catch(() => op.retract())
      }
    }
    // Adopting the room's intent also *announces* it (#324). Nothing else does:
    // the echo consume in `onLocalPause` returns above `sendSyncplayLocalState`,
    // and a paused element fires no `timeupdate` (the known gap on
    // `pushSyncplaySnapshot`, #227), so main's copy of our snapshot keeps saying
    // whatever we were doing before the apply until the 1 s interval fires.
    // Main's own 1 s heartbeat races that interval, and when it wins,
    // `canAssertSnapshot()` asserts the stale value straight back into the room
    // — measured at 146 ms / 26 ms after a room pause, and at 138 ms / 152 ms
    // after a room resume, where it undid the resuming user's play and left the
    // room wedged. Pushing here makes the residual one IPC hop, not one
    // heartbeat.
    //
    // Below the seek write for `position`, and for `position` only: the pushed
    // `paused` is `intentOr(v)` — `intendedPaused ?? v.paused` — already fixed
    // by the intent write above (under a hold, by `onLocalPause`'s; see below),
    // so the element moves in between have no bearing on it. In particular do
    // *not* await `v.play()`: it is async and retracts on rejection, and
    // waiting on it parks the announcement behind autoplay-policy latency in
    // exactly the direction that costs the user their play.
    //
    // Unconditional, a hold included. The seek write above carries no `holding`
    // term — under a hold we still move the element to the room's position —
    // and main's adoption latch is a test on exactly that quantity:
    // `isAdopted()` (src/main/syncplay.ts:2596) is
    // `|snapshot.position - projectedRoomPosition(room)| <= ADOPT_TOLERANCE_S`.
    // So gating the push withheld the position announcement in precisely the
    // pre-adoption window the hold exists to shorten. That is the seek half's
    // own argument above ("withholding it would stall the very adoption the
    // hold is waiting for"), and a gate here contradicted it.
    //
    // The gate never withheld a payload in any case, only delayed one: the 1 s
    // interval (`setInterval(pushSyncplaySnapshot, 1000)`, :2340) is
    // unconditional and `pushSyncplaySnapshot` has no `holding` term of its
    // own, so the identical snapshot reached main within a second regardless.
    // Dropping it is a latency change, not a semantic one.
    //
    // Nor is the held payload a lie about the room: `intentOr(v)` reads
    // `intendedPaused`, which `onLocalPause` sets to `true` (:1905) *above* its
    // `armPendingUserPause()` (:1989). So a push under a hold announces the
    // user's own pause at the position this apply just wrote — never the room's
    // resume, which the intent adoption above declines to adopt. `holding` is
    // false for every paused state by construction, so a room resume is the
    // only shape that reaches it at all.
    //
    // It resets `lastSnapshotPushAt`, so the first `timeupdate` after an apply
    // can be held off for up to SNAPSHOT_MIN_INTERVAL_MS. Harmless rather than
    // a regression: the 1 s interval covers that gap, and the position such a
    // `timeupdate` would have carried is the one just pushed.
    pushSyncplaySnapshot()
    const describesAMove = (!deferred && !firstApply) || state.doSeek
    if (state.setBy && needsSeek && !holding && describesAMove) {
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
      // Read *after* the `recordRemoteState` above, so this is the badge as the
      // room's own report left it — including the case where the report said
      // nothing and the badge is whatever an earlier edge put there (#350).
      pendingRemoteStatePausedBy = syncplayPausedBy.value
      return
    }
    pendingRemoteState = null
    pendingRemoteStatePausedBy = null
    applyRemoteStateToElement(state, v, false)
  }

  function onVideoLoadedMetadata(): void {
    const state = pendingRemoteState
    if (!state) return
    const v = deps.getVideoEl()
    if (!v) return
    const parkedPausedBy = pendingRemoteStatePausedBy
    pendingRemoteState = null
    pendingRemoteStatePausedBy = null
    // Re-assert the bookkeeping at write time. It already ran when the state
    // arrived — that is the point of splitting it out, so the ready gate is
    // never stale — but a local play/pause during the wait overwrites it, and
    // the two halves then disagree: the parked state pauses the element and
    // adopts `intendedPaused = true` while `syncplayLastRemotePlaying` still
    // says the room is playing, so the very next `applySyncplayReadyGate()` plays it again with
    // `syncplayPausedBy` naming nobody.
    //
    // That last clause is why the badge half is passed in rather than re-derived (#350). The
    // mirror repair needs no help — `recordRemoteState` writes `syncplayLastRemotePlaying`
    // unconditionally, above its edge test — but the badge does, because `onLocalPlay` cleared
    // it on the way past and the edge test alone would leave the deferred pause anonymous. What
    // it must *not* do is re-read `state.setBy`: the park overwrites rather than queues, so at
    // 1 Hz any park outliving a tick holds a periodic, whose `setBy` is the elected laggard —
    // re-reading it here would replace a correct author with a wrong one, which is the exact
    // symptom #350 exists to remove. `parkedPausedBy` is what the room had told us when the
    // frame was parked, and that is the only authorship claim an unpark can honestly make; an
    // unattributable park restates nothing. Where no local press intervened the re-assertion is
    // a no-op by construction: `parkedPausedBy` is the badge that same record left, so writing
    // it back changes nothing. The position is not made current the same way:
    // it carries main's one-shot `serverRtt / 2` compensation from emit time
    // (src/main/syncplay.ts:2115) and nothing advances the parked copy, so it applies behind the
    // room by the park's duration. Uncompensated on purpose — the 3 s apply tolerance and main's
    // adoption gate bound the error, and the 1 Hz overwrite too — but only where adoption cleared
    // at `src/main/syncplay.ts:789` and the roster (`src/main/syncplay.ts:2489-2493`) is keyed
    // with a peer; an in-player switch leaves adoption set. docs/syncplay.md, "Apply Rule".
    recordRemoteState(state, { pausedBy: parkedPausedBy })
    applyRemoteStateToElement(state, v, true)
  }

  // A remote episode change swaps the <video> source, and a state parked for the
  // previous episode must never be applied at the new one's `loadedmetadata`. The applied flag is
  // reset with it — it must not latch for the session: main stops emitting `remote-state` once we
  // are alone, so it would eat the user's saved position on every later open. Resetting in a live
  // room costs at most a sub-second flash before the next 1 Hz state seeks us to the room — where
  // adoption cleared at `src/main/syncplay.ts:789` and the roster (`src/main/syncplay.ts:2492`)
  // is keyed with a peer; an in-player switch leaves adoption set, so only a peer's move does.
  // `refusedToastShown` is cleared here too, by default and deliberately: every
  // caller of this function is a point where the file, the room or the socket
  // has changed under the flag, and a stale receipt makes the *next* refusal
  // silent. Defaulting to the clear means a caller added later fails towards a
  // redundant toast rather than towards an explanation the user never sees —
  // silence being the strictly worse failure, since it leaves the room and the
  // playhead sitting apart with no reason given. `keepRefusalNotice` is the one
  // documented exception (#281); see the reconnect branch for why it opts out.
  function resetRemoteStateTracking(opts: { keepRefusalNotice?: boolean } = {}): void {
    pendingRemoteState = null
    // With the park, always (#350). The two are one slot: `applyRemoteState`
    // writes the author at the only site that parks a state, so a survivor here
    // is never actually read — the next park overwrites it before the next
    // unpark can restate it, and no test can tell this line from its absence.
    // It stays because the pairing is the invariant, not because a behaviour
    // rests on it: a later park site that set `pendingRemoteState` without the
    // author would otherwise restate whoever paused the room an episode ago.
    pendingRemoteStatePausedBy = null
    remoteStateApplied = false
    // Under the same opt-out (#281, slice B), and for the same reason the
    // reconnect branch takes it: same room, same file, same divergence, and the
    // user's pause is still on the element. Every other caller — episode
    // change, session end, file swap — has moved the ground the marker stands
    // on, and a survivor there would refuse a resume for a pause nobody made in
    // the state it refuses for.
    if (!opts.keepRefusalNotice) {
      refusedToastShown = false
      outOfFileUserPause = false
    }
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
    // The element's source is about to be replaced, so every operation
    // outstanding against the old one is retired (#306). This watcher is a
    // pre-flush `watch`, so it runs before the `nextTick` in which
    // `selectTranslation`/`goToEpisode` register their restore/episode-start
    // operations — those are therefore registered at the *new* generation, and
    // only genuinely stale ones are retired. `selectQuality` rebinds
    // `activeStreamUrl` without touching either dep, so it calls
    // `bumpPlaybackSourceGeneration()` itself.
    bumpPlaybackSourceGeneration()
    // A new file is a new state of affairs, so the refusal receipt must not
    // survive it — left set it would silently swallow the explanation for a
    // refusal on *this* episode, the next episode of a differently-cut release
    // being exactly where that recurs. That is the default of the reset below,
    // not something this call site has to remember.
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
      await api.syncplayDisconnect()
      return
    }
    const cfg = (await api.getSetting('syncplay')) as {
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
      const shiki = await api.shikimoriGetUser()
      if (shiki?.nickname) {
        username = shiki.nickname
        await api.setSetting('syncplay', { ...(cfg || {}), username })
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
    await api.syncplayConnect({
      host,
      port,
      room,
      username,
      autoReconnect: cfg?.autoReconnect ?? true
    })
  }

  // Consuming *is* the classification (#306 Phase B). An operation matched here
  // is the element realizing a move this app made — the peer's seek arriving
  // back at us, or one of our own programmatic writes — and never the user's.
  //
  // Everything the single slot spelled out inline now lives in `consumeSeekOp`,
  // with the same three answers: an expired operation is pruned and suppresses
  // nothing (expiry releases, it never vetoes); a `value` operation the event
  // does not match is left registered on purpose, because this `seeked` belongs
  // to some other write and consuming it there is what let the real echo escape
  // (#224); and a `seeked` matching nothing outstanding is the user's.
  function onVideoSeeked(): void {
    if (consumeSeekOp(deps.getVideoEl())) return
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
    const op = consumePlaybackOp('play')
    if (op) {
      // The element realizing a play *this app* made. What that establishes is
      // the operation's kind, not a fixed answer — see
      // applyConsumedPlaybackIntent. It runs *before* the gate call below, and
      // that ordering is the whole stuck-pause fix (#306): the gate reads
      // `syncplayLastRemotePlaying`, and returning above these writes is what
      // let it pause an element the app had just resumed.
      applyConsumedPlaybackIntent(op)
      applySyncplayReadyGate()
      return
    }
    // A genuine echo is already caught by the registry above; anything reaching
    // here is the user. The wall-clock window that once gated this write is
    // gone entirely (#304), but the reason it had to stop gating *intent* first
    // (#228) is still worth keeping: a pause inside the window left intent at
    // "playing" while the element sat paused — the heartbeat then asserted play
    // and the next remote apply resumed it, so the pause "didn't work".
    //
    // `intentRevision++` is load-bearing rather than bookkeeping, and its
    // position here matters: `applyConsumedPlaybackIntent` compares an
    // operation's captured revision against this one to decide whether a
    // non-echo operation may still write intent, so a bump that moves below the
    // send or the gate call would let a stale queued `restore` overwrite the
    // press the user just made.
    intendedPaused = false
    intentRevision++
    // The user changed their mind — clear before the gate call below, or it
    // would pause the element they just resumed. The out-of-file marker goes
    // with it (#281): there is no local pause left for the room to override.
    clearPendingUserPause()
    outOfFileUserPause = false
    // Unconditional since #228, like the pause half below: anything reaching
    // here is past the operation-registry echo check, and by #224's
    // classification rule that makes it the user. The wall-clock window that
    // used to gate these writes was re-armed by *every* apply for 1500 ms, at
    // ~1 Hz through the whole convergence window, so it was shut for exactly
    // the presses #228 was about. It went on gating the *send* until #304,
    // which is the last claim in its favour that survived Phase A and did not
    // survive it: `consumePlaybackOp` above now returns for every echo, so the
    // only events left for the window to drop were ones the registry had
    // already classified as this user's press.
    //
    // This half ships with the pause half or not at all: relaxing the pause
    // side alone leaves a stale `false` here that the gate call below reads,
    // and "press play right after pausing" re-pauses itself.
    syncplayLastRemotePlaying = true
    // The badge clears — "Paused by X" is not true of a room this user has just
    // resumed — but `badgeEdgePaused` deliberately does **not** (#350). A press
    // is a local intent, not a report that the room resumed, and it may not
    // stick: a peer's pause stands, or main drops the send at its pre-adoption
    // gate. Writing `false` here armed the edge on that hope, and when the room
    // turned out to still be paused the next 1 Hz periodic read as a
    // playing->paused edge and painted the elected watcher's name onto a pause
    // nobody had just made. The room mirror above is a different claim and still
    // goes true: the gate must not re-pause the element the user just resumed,
    // and the next inbound state repairs it either way.
    //
    // #240's unpark repair used to ride on this write — it re-armed the edge so
    // the parked pause got its name back. It is explicit now, through
    // `recordRemoteState`'s `reassert`; see `onVideoLoadedMetadata`.
    syncplayPausedBy.value = null
    // Only the *send* is conditional, and on the gate's own decision rather than
    // on a hand-copy of one of its terms (#347). By this line
    // `syncplayLastRemotePlaying` is forced true above, `clearPendingUserPause()`
    // has run and `outOfFileUserPause` is false, so `shouldElementPlay()` reduces
    // here to its `syncplayAllUsersReady()` conjunct by construction — which is
    // what the hand-copy used to spell out, at the cost of a fifth term added to
    // the predicate silently not reaching this line. Nothing between here and the
    // gate call perturbs any of the three settled terms.
    //
    // When readiness holds the element, the discrete play is omitted rather
    // than deferred: main arms its ignore counter on a discrete send, and a
    // play we are not going to enact should not deafen us to the acks that tell
    // us when we may. The intent is not lost — `intendedPaused = false` above
    // rides out on `intentOr(v)` with the next snapshot — and when readiness
    // later releases the element the gate's own `play()` is an echo, not a
    // second user command, so there is deliberately no delayed duplicate send.
    //
    // Deliberately *not* inferred by re-reading `v.paused` after the gate call:
    // that conflates "readiness held us" with "the element was already playing",
    // and the gate must stay below the intent and mirror writes it reads.
    if (shouldElementPlay()) sendSyncplayLocalState('play')
    applySyncplayReadyGate()
  }

  function onLocalPause(): void {
    const op = consumePlaybackOp('pause')
    if (op) {
      // Every pause operation registered today is an `echo` — the readiness
      // gate's down-arm, a remote apply, an MSE buffer refill, PlayerView's
      // teardown — so this establishes nothing. Routed through the same kind
      // contract as the play half so a future non-echo pause cannot be added
      // without deciding what it means.
      applyConsumedPlaybackIntent(op)
      return
    }
    intendedPaused = true
    intentRevision++
    // See onLocalPlay: the wall-clock gate that used to sit here was shut for
    // the whole convergence window, so the room mirror kept saying "playing"
    // through the user's own pause and the ready gate resumed the element a
    // beat later. Past the echo check this is the user, so the mirror follows
    // them — which also makes "Paused by you" appear on the press.
    //
    // The pause send below is unconditional, unlike the play half's: readiness
    // never holds a pause. `shouldPlay` false is exactly what the gate enacts,
    // so there is no state in which the element declines to honour this one.
    syncplayLastRemotePlaying = false
    // The prediction, and the only write outside `recordRemoteState` that arms
    // the edge ahead of a transition nobody has observed yet: this user pressing
    // pause *is* a pause edge and the badge that follows it names them.
    // (`expirePendingUserPause` and the status watcher's `roomPaused` landing arm
    // it too, but both of those close the edge *behind* a transition that already
    // happened.) It also closes the flag against the very next paused periodic,
    // which would otherwise arrive carrying the elected watcher's name and
    // repaint over "Paused by you".
    badgeEdgePaused = true
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
    //
    // `!outOfFile` is the fourth conjunct, and it reads the new projection
    // rather than `playbackAdopted` (#281, slice B) — main's de-adoption makes
    // `playbackAdopted !== true` true for the whole divergence, which is exactly
    // the window the hold must *not* arm in. The hold exists to bridge the gap
    // before a pause reaches the room, and here no pause ever will: its normal
    // terminator is `roomPaused` going false → true, which cannot fire for a
    // peer the room cannot hear, so it would run the full
    // PENDING_PAUSE_MAX_MS and expire into PENDING_PAUSE_FAILED_TOAST before
    // the next playing state resumed the user anyway. `outOfFileUserPause`
    // takes over instead, and it holds for as long as the divergence does.
    //
    // The marker shares exactly one of the hold's two guards —
    // `elementHasMetadata` — and deliberately not the `state === 'ready'` one.
    // The shared one is load-bearing: it is the only thing in this composable
    // separating a user's pause from the reload-shaped implicit pause the media
    // load algorithm queues at `readyState === 0`, `PlayerView.vue` calls
    // `onLocalPause()` straight off the raw `@pause` event, and the ordering is
    // against us across an episode switch taken during a divergence. The switch
    // watcher runs `resetRemoteStateTracking()` synchronously and the teardown
    // pause arrives after it, while main's `setFile()` leaves `lastRoomState`
    // alone — so the projection still says `outOfFile`, an unguarded marker
    // comes straight back on, and the ready gate declines the binge auto-resume
    // that `clearPendingUserPause()` beside it is in that watcher to protect
    // for the sibling flag.
    //
    // `state === 'ready'` stays on the hold alone, because the marker's whole
    // job is to survive the socket dropping: the `keepRefusalNotice` opt-out on
    // the `reconnecting` branch exists to carry one *through* that window, and
    // nothing could arm one inside it if this took the state guard too — a
    // pause made while the socket is down would be resumed by the room on
    // reconnect, which is the one thing the divergence rule is for.
    // `roomOutOfFile` already buys what the state test would: the projection is
    // only ever true while main holds a `lastRoomState`, is de-adopted and has
    // peers, and `tearDown()` clears all three, so under
    // `idle`/`disconnected` it is false anyway. `resetTransportState()` clears
    // none of them, which is exactly why `reconnecting` is the state the two
    // guards disagree about.
    const elementHasMetadata = (deps.getVideoEl()?.readyState ?? 0) > 0
    const roomOutOfFile = syncplayStatus.value.outOfFile === true
    if (roomOutOfFile && elementHasMetadata) outOfFileUserPause = true
    if (
      syncplayStatus.value.state === 'ready' &&
      elementHasMetadata &&
      syncplayStatus.value.playbackAdopted !== true &&
      !roomOutOfFile
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
      // And the badge's edge with it: the room is reported paused, so the paused
      // periodics behind this projection are not edges and may not paint (#350).
      badgeEdgePaused = true
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
      badgeEdgePaused = null
      syncplayPausedBy.value = null
      // Intent, and the operations that gate it. Left set, a stale
      // `intendedPaused` reports room A's play state into room B, a live
      // playback operation swallows one real play/pause of the next session, a
      // live seek operation swallows its first real seek for the rest of the
      // 15 s TTL, and `lastSnapshotPushAt` drops the first `timeupdate` snapshot
      // when the next session starts inside SNAPSHOT_MIN_INTERVAL_MS. Since #304
      // the two registries are the whole of what a dead session could carry into
      // the next one on this axis: there is no wall-clock window left to eat the
      // send and the `pausedBy` attribution of room B's first press.
      //
      // Tradeoff, the same widening #227 first wrote down for the suppression
      // window this list has outlived: both registries are also armed by
      // machinery that is *not* scoped to the syncplay session — the buffer
      // refill and the
      // resume-from-middle land in `use-mse-player`, and `PlayerView`'s
      // saved-position restores. A session end landing between one of those
      // registrations and the element's event drops the operation, so that echo
      // reaches the next room as a user action. One event, and the alternative
      // is the swallowed-event bug above — but it is the room-dragging
      // direction, so it is written down rather than discovered.
      intendedPaused = null
      intentRevision++
      // Both registries dropped outright rather than retired: a retired
      // operation exists to absorb a late echo from a source that still belongs
      // to *this* player, and a session end hands the element to a different
      // room entirely. The widening tradeoff two paragraphs up is unchanged by
      // the registries — fewer operations survive here, in the swallowed-event
      // direction, not the room-dragging one.
      playbackOps = []
      seekOps = []
      // Room B must not inherit room A's pending pause — nor its 8 s timer,
      // which would toast a failure into a session that never held anything.
      clearPendingUserPause()
      lastSnapshotPushAt = 0
      // Takes room A's refusal receipt with it, by this function's default: an
      // identical refusal in room B is news to the user, and a flag inherited
      // from the dead session would silently swallow it. The `reconnecting`
      // branch below is the one caller that opts out of that.
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
      // The user's intent is not — `intendedPaused`, the playback and seek
      // operation registries, `lastSnapshotPushAt`, `syncplayLastRemotePlaying`
      // and the ready flag all
      // deliberately survive a reconnect, unlike the `idle`/`disconnected`
      // branch above, which is a genuine session end. The two rules are not in
      // tension: a reconnect keeps what the *user* wants and drops what the
      // *room* told us, exactly as main keeps `roomUsers`/`ownIsReady` through
      // `resetTransportState()` while `tearDown()` clears them (#227, #240).
      //
      // `keepRefusalNotice` is the sole opt-out from that function's default
      // clear, and belongs to this branch alone: it is the same room and the
      // same file on the other side of the socket, so the refusal is not news —
      // and clearing it here would let the very next state re-fire the refusal
      // straight over the reconnect notice on the line below, which is the more
      // useful of the two messages while the socket is down (#281).
      resetRemoteStateTracking({ keepRefusalNotice: true })
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
    const cfg = (await api.getSetting('syncplay')) as { lastRoom?: string } | null
    if (cfg?.lastRoom) syncplayRoomInput.value = cfg.lastRoom

    unsubRemoteState = api.onSyncplayRemoteState((state) => {
      applyRemoteState(state)
    })
    unsubRoomEvent = api.onSyncplayRoomEvent((ev) => {
      if (ev.level === 'warn' || ev.level === 'error') {
        console.warn('[syncplay]', ev.text)
      } else {
        console.log('[syncplay]', ev.text)
      }
      const ms = ev.level === 'warn' || ev.level === 'error' ? 8000 : 3500
      showSyncplayToast(ev.text, ms)
    })
    unsubTrace = api.onSyncplayTrace((entry) => {
      const arrow = entry.dir === 'in' ? '<<' : '>>'
      let flat: string
      try {
        flat = JSON.stringify(entry.msg)
      } catch {
        flat = String(entry.msg)
      }
      console.log(`[syncplay] ${arrow} ${entry.keys} ${flat}`)
    })
    unsubRemoteEpisodeChange = api.onSyncplayRemoteEpisodeChange((ep) => {
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
    // Tell main the player is gone rather than leaving it to infer it from
    // silence (#288). Clearing the timer above only stops the pushes; main's
    // snapshot clock still reads "live" for PLAYBACK_STALE_MS (5 s) after the
    // last one, and for that whole window its heartbeat asserts the *frozen*
    // position at 1 Hz — which wins the server's `min(watchers)` election and
    // drags everyone still watching backwards by up to 5 s in one step.
    //
    // Unconditional, and not gated on `syncplayStatus`: the handler's clears are
    // inert when no session is up, and a status read here would only add a way
    // to skip the signal. One emit per unmount is all there is — the hook runs
    // once and the composable is mount-scoped — so idempotence is the handler's
    // property, not something arranged here. A reopen mounts *after* this
    // teardown and re-announces with `newPlayer: true`, so the two ride the same
    // IPC queue in that order.
    //
    // The ID (#307) names *this* mount, and it is sent whether or not this mount
    // ever announced. Main compares rather than trusts: a mount that skipped its
    // push at `pushSyncplayFile()`'s readiness guard is quoting an ID main has
    // never seen, so its close resets the player state (which it must, #288) and
    // leaves the file an earlier mount announced alone (which it must too — no
    // snapshot re-announces a file).
    api.syncplayPlayerClosed(playerSessionId)
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
    beginProgrammaticPlayback,
    bumpPlaybackSourceGeneration,
    beginProgrammaticSeek,
    shouldElementPlay,
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
