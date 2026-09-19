// Two complete Syncplay stacks in one Vitest process (#361 step 3).
//
// What this exists to remove is a stand-in. `syncplay-seek-crossfire.test.ts`
// used to carry a `LaggyElement` whose `apply()` was commented "the renderer's
// apply rule, verbatim" and was a hand-copied `Math.abs(…) <= 3`. The real rule
// is a separate literal in `use-syncplay-client.ts`, so the two could drift and
// nothing noticed: every two-client fixture that turned on "what the renderer
// does with this frame" was asserting against a copy rather than against the
// code that ships. Here each peer runs the real composable, so the rule under
// test is the shipped one and a mutation to it reds the fixture.
//
// The shape, twice:
//
//   HarnessVideo <-> useSyncplayClient <-> real preload `api`
//        <-> per-peer electron mock <-> real syncplay.ipc.ts <-> real SyncplayClient
//        <-> per-peer net/tls mock <-> MinElectionServer
//
// ── Why a module graph per peer ───────────────────────────────────────────────
//
// `src/main/ipc/syncplay.ipc.ts` imports the `syncplay` **singleton** at module
// scope, so one module instance holds exactly one client (#361 comment on step
// 3). The two ways out were a client parameter on `register()` — a production
// signature change — or a module graph per peer. This takes the second, and it
// buys more than it costs: `vi.resetModules()` plus `vi.doMock()` gives each
// peer its own `electron` (so its own `ipcMain.handle` registry and its own
// renderer listener registry, instead of two peers overwriting each other in the
// one shared spy the global mock keeps), its own `net`/`tls` (so its sockets are
// its own rather than the tail of a shared array), its own `SyncplayClient`
// singleton, and its own real preload `api` object. The graph is four modules
// deep and imports no Electron runtime, so duplicating it is cheap.
//
// The global `electron` mock in `test/setup/electron-mock.ts` — and its
// `__enableIpcLoop()` — is deliberately *not* used: its registries are
// process-wide and keyed by channel name, which is precisely the collision this
// helper has to avoid. #362's bridge test is the file that proves the loop
// against that mock; this one proves two of them side by side.
//
// ── The one production seam ───────────────────────────────────────────────────
//
// `SyncplayDeps.api` (defaulting to `window.api`) is a source change and the
// only one. The renderer half of the loop cannot be per-peer without it:
// `window.api` is one object per renderer, `onMounted` awaits `getSetting`
// *before* installing its four subscriptions, and the 1 Hz snapshot interval
// fires on a clock no test scope covers — so a global swapped around each peer
// hands peer A's frames to peer B's bridge whenever the two interleave. The
// Pinia store still reads the global, and that is safe here for a reason that
// does not generalise: `useSyncplayStore()`'s two subscriptions bind
// synchronously inside `setup`, and `seat()` serialises mount-and-settle, so the
// window in which the global matters is one peer wide. See `seat()`.
//
// ── Determinism ───────────────────────────────────────────────────────────────
//
// Everything in the stack is on `Date.now()` and bare timers with no injection
// point, so the caller owns `vi.useFakeTimers()` + `vi.setSystemTime()` and must
// install them before `createTwoPeerRoom()`. Under fake timers there is exactly
// one clock, shared by both peers, `MinElectionServer` and the composable's
// snapshot interval. `advance()` steps it in slices and drains the microtask
// queue between them, because Vue's scheduler flushes on microtasks rather than
// on the timer queue — advancing in one jump would run a second of main-side
// heartbeats before the renderer reacted to the first frame.
//
// ── What is not modelled ──────────────────────────────────────────────────────
//
//  - Structured clone. Payloads cross the loop by reference, as they do in
//    #362's bridge test; a scenario turning on mutation-after-send is not
//    faithful here.
//  - The real `<video>`. `HarnessVideo` models the playhead, a seek that takes
//    time to land, the queued `play`/`pause`/`seeked`/`loadedmetadata` tasks,
//    and the part of the media load algorithm a source swap makes observable —
//    nothing else. See its own note.
//  - The follow-through on a remote episode change. `Peer.remoteEpisodes`
//    records what the composable handed its consumer, and stops there, because
//    the navigation belongs to `PlayerView` and not to the composable under
//    test. "Peer B's player actually opened episode 8" is not a claim this
//    harness can make; "peer B was told to" is.
//  - Whatever `MinElectionServer` does not model; its header is the authority,
//    and the `ignoringOnTheFly` ignore window is on that list.
//
// Files that use this helper must run under happy-dom
// (`// @vitest-environment happy-dom`): the composable mounts a real Vue
// component and the real preload takes its `window.api = api` branch.

import { vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { EventEmitter } from 'events'
import { useSyncplayClient } from '../../src/renderer/src/composables/use-syncplay-client'
import { MinElectionServer } from './syncplay-min-election-server'
import { InMemoryStorage } from './in-memory-storage'
import type { MinElectionServerOptions } from './syncplay-min-election-server'
import type {
  SyncplayClient as MainSyncplayClient,
  SyncplayRemoteEpisode,
  SyncplayRemoteState,
  SyncplayStatus
} from '../../src/main/syncplay'
import type {
  SyncplayClient as RendererSyncplayClient,
  SyncplayDeps
} from '../../src/renderer/src/composables/use-syncplay-client'

/** The socket shape `src/main/syncplay.ts` reaches for on the mocked modules. */
class HarnessSocket extends EventEmitter {
  setKeepAlive = vi.fn()
  write: (data: string) => void = vi.fn()
  destroy = vi.fn(() => {
    this.emit('close')
  })
}

// ── The element ───────────────────────────────────────────────────────────────

export interface HarnessVideoOptions {
  /** Where the playhead starts. */
  position?: number
  /** `v.duration`. Finite and non-zero, because the apply rule's out-of-file
   *  arm refuses a position at or past it — a fake reporting 0 would send every
   *  seek in every scenario down the refusal branch, green on the wrong one. */
  duration?: number
  paused?: boolean
  /** `HAVE_METADATA`. #240 parks an apply below 1 and the parked path is its own
   *  subject, so the harness default is the state the apply rule is written for
   *  — the same reasoning as `fakeVideo`'s in the composable's own test file. */
  readyState?: number
  /** How long a `currentTime` write takes to land. While one is in flight the
   *  element reports the **seek target**, not a stalled pre-write position:
   *  setting `currentTime` updates the official playback position
   *  synchronously, and the getter returns it while the seek is still pending,
   *  so it is only *readiness* that lags. Captured against the stock build
   *  (#368) — four drags 110 ms apart on a real seek bar, each read taken
   *  immediately before the next write, returned 1107.7 / 1136.1 / 1164.5, i.e.
   *  the preceding target exactly, at `readyState` 1 with nothing buffered
   *  within a thousand seconds of the reported position. A frozen element would
   *  have read the pre-drag 20.686 on all four. That target is what the 1 Hz
   *  snapshot pushes to main, and it makes a mid-seek peer announce *too high*
   *  and lose the server's `min()` election to a peer genuinely behind it — the
   *  opposite sign from what this harness modelled before #368. `0` lands on
   *  the write. */
  seekLandMs?: number
  /** `v.src`. Identity only — nothing here fetches it — but identity is the
   *  whole subject of #360, where a frame describing the *previous* episode is
   *  applied to the element the next one just bound. A fixture that cannot say
   *  which file the element is on cannot tell that apart from an ordinary seek. */
  src?: string
  /** How long `reload()` takes to reach HAVE_METADATA, i.e. the gap between the
   *  media load algorithm's synchronous reset and the `loadedmetadata` task.
   *  #284's suppression window, and the staleness this file's adoption fixture
   *  turns on, both live inside this gap. The default opens a 500 ms one — enough
   *  for that suppression, far short of `PLAYBACK_ASSERT_STALE_MS` (2 s) and
   *  `PLAYBACK_STALE_MS` (5 s), so the adoption fixture still seats 30 s itself.
   *
   *  Defaults to **500**, the gap the shipped app actually runs. The value is
   *  chosen by a criterion rather than by a distance from a measured onset:
   *  a positive gap is clean iff `k = ceil(bindGapMs / HEARTBEAT_MS) === 1`,
   *  where `HEARTBEAT_MS` is 1000 (`src/main/syncplay.ts:19`). That is checkable
   *  against a constant in the tree, which a band map of measured millisecond
   *  cells would not be. #360's 1 ms sweep indexes the whole drag axis on that
   *  `k`: `k = 1` is clean, `k = 2` through `k = 5` drag the non-switching peer
   *  backwards, and `k >= 6` drags iff `k` is odd.
   *
   *  Two values the criterion rules out, both counter-intuitive enough to be
   *  worth recording. **3000 is `k = 3`** — mid-drag — so a 3000 default would
   *  start every reloading two-peer fixture inside the regime where the innocent
   *  peer is pulled backwards, silently baking #360's defect into the harness
   *  baseline: the fixture would pass and what it pinned would be the bug.
   *  **1000 is `k = 1` and still wrong as a default**, because the drag onset is
   *  1001, so 1000 clears the gate by one millisecond. 500 sits mid-cell in the
   *  only clean cell that is unbounded below, with 500 ms of slack on each side
   *  — that is the property being chosen, not a distance from an onset.
   *
   *  `0` stays reachable and is only no longer the default: the one case that
   *  depends on it seats it explicitly, in a bare `new HarnessVideo({…})` rather
   *  than through `seat()`. */
  bindGapMs?: number
}

type QueuedMediaEvent = 'play' | 'pause' | 'seeked' | 'loadedmetadata'

/**
 * A `<video>` with a clock.
 *
 * Deliberately *not* the composable test file's `fakeVideo`, and the difference
 * is the point rather than duplication: `fakeVideo` models a static playhead,
 * because 205 unit cases hand it one frame and read the reaction. A two-peer
 * room needs a playhead that walks with wall time and a seek that takes time to
 * land, and bending `fakeVideo` to do both would change the fixture those cases
 * are written against. The two properties that *are* shared are shared
 * deliberately: the write clamps to `[0, duration]` the way Chromium's seek
 * algorithm clamps to the seekable range (#281), and the raw pre-clamp write is
 * kept so "our code wrote X" stays separable from "the element landed on X".
 *
 * Media events are **queued**, not fired from inside the call that causes them:
 * a real element queues a task, and firing `pause` synchronously inside
 * `applyRemoteState`'s own `v.pause()` would re-enter the composable halfway
 * through an apply, which is a shape the shipped app never sees. `tick()` is
 * where they are delivered.
 */
export class HarnessVideo {
  duration: number
  /** `v.src`. Written by `reload()`, read by fixtures that need to say which
   *  file an apply landed on. */
  src: string
  /** Every `currentTime` write, pre-clamp, in order. */
  readonly seekWrites: number[] = []
  /** Every `readyState` **transition**, in order, seeded with the value the
   *  element was constructed at. A same-value write records nothing, because on
   *  a real element `readyState` is a derived read-only attribute and only its
   *  transitions are observable; the seed is here so a fixture reading this can
   *  tell "never moved" from "moved back to where it started". */
  readonly readyStates: number[] = []
  /** Every source this element has been bound to, in order, seeded with the
   *  constructor's. `loads.length - 1` is the number of reloads. */
  readonly loads: string[] = []

  private readyStateFlag: number
  private pausedFlag: boolean
  private anchor: number
  private anchorAt: number
  /** Non-null while a write is in flight: the clamped target the element
   *  reports meanwhile, and when it is due to land. */
  private pending: { target: number; dueAt: number } | null = null
  /** Non-null while a load is running: when `loadedmetadata` is due. */
  private metadataDueAt: number | null = null
  private readonly queued: QueuedMediaEvent[] = []
  private readonly seekLandMs: number
  private readonly bindGapMs: number

  constructor(opts: HarnessVideoOptions = {}) {
    this.duration = opts.duration ?? 1440
    this.readyStateFlag = opts.readyState ?? 1
    this.readyStates.push(this.readyStateFlag)
    this.src = opts.src ?? 'harness://initial'
    this.loads.push(this.src)
    this.pausedFlag = opts.paused ?? true
    this.anchor = opts.position ?? 0
    this.anchorAt = Date.now()
    this.seekLandMs = opts.seekLandMs ?? 0
    this.bindGapMs = opts.bindGapMs ?? 500
  }

  get readyState(): number {
    return this.readyStateFlag
  }

  /** Settable, because the composable's own test fixtures move `readyState` by
   *  hand and a harness that only reached it through `reload()` could not
   *  express a park at HAVE_NOTHING that never ends. Recorded either way. */
  set readyState(next: number) {
    if (next === this.readyStateFlag) return
    this.readyStateFlag = next
    this.readyStates.push(next)
  }

  private live(): number {
    const walked = this.pausedFlag ? this.anchor : this.anchor + (Date.now() - this.anchorAt) / 1000
    return Math.min(Math.max(0, walked), this.duration)
  }

  private reanchor(): void {
    this.anchor = this.live()
    this.anchorAt = Date.now()
  }

  /** The **clamped** target while a write is in flight, the walking playhead
   *  otherwise. Clamped rather than raw because Chromium clamps to the seekable
   *  range before setting the official position, and #281's out-of-file arm
   *  reads downstream of this; `seekWrites` keeps the raw pre-clamp value, so
   *  "our code wrote X" stays separable from "the element landed on X". */
  get currentTime(): number {
    return this.pending !== null ? this.pending.target : this.live()
  }

  /** True while a write is in flight, the way a real element reports it through
   *  the whole of the capture in #368. Nothing reads it yet: the outbound
   *  announceability door is `readyState` alone
   *  (`use-syncplay-client.ts:770`), which is exactly why a mid-seek element at
   *  `readyState` 1 gets into the election holding a position it has no data
   *  for. Any fix on that door gates on this, and a harness that could not say
   *  `seeking` could not express the fix.
   *
   *  The `seekLandMs > 0` conjunct is not redundant with `pending !== null`, and
   *  dropping it inverts the reading on every element the harness has: the arm
   *  in the setter below is *unconditional*, outside its `seekLandMs <= 0`
   *  branch, so a `seekLandMs: 0` element — one the setter has already
   *  re-anchored onto its target — still holds a `pending` from the write until
   *  the `tick()` that clears it. A bare `pending !== null` therefore says
   *  `seeking` on an element that is not in flight and whose `currentTime` has
   *  already taken the target, which is the file's own `seekLandMs` doc ("`0`
   *  lands on the write") read backwards. It is the same condition `tick()`
   *  spends fourteen lines defending, and a production gate written against
   *  `seeking` would otherwise silence every landed element in the suite for
   *  the slice after any write. */
  get seeking(): boolean {
    return this.pending !== null && this.seekLandMs > 0
  }

  set currentTime(t: number) {
    this.seekWrites.push(t)
    const target = Math.min(Math.max(0, t), this.duration)
    if (this.seekLandMs <= 0) {
      this.anchor = target
      this.anchorAt = Date.now()
    }
    // A second write arriving before the first lands replaces the target
    // outright, and that is right on both halves. The reported position follows
    // the *latest* target rather than staying where an earlier one left it —
    // the getter above reads `pending.target`, so there is nothing to freeze
    // here — and an interrupted seek fires no `seeked` of its own, so only the
    // survivor's landing is announced.
    //
    // The arm below is unconditional — it is outside the `seekLandMs <= 0`
    // branch — so `pending` stays set on *landed* elements too, in the window
    // between the write and the `tick()` that clears it. `seeking` carries its
    // own `seekLandMs > 0` conjunct against that; `currentTime` above does not,
    // and reads `pending.target` through that window. The `seekLandMs: 0` files
    // (seek-echo, ignore-counters, rtt, playpause) stay green through it only
    // because `Date.now()` is the fake clock and does not move inside a slice,
    // so `pending.target` and `live()` are bit-identical. It keys on the
    // clock's granularity, not on `seekLandMs`: a fixture reading `currentTime`
    // across an `advance()` boundary before the landing tick gets the target
    // where it used to get the walked playhead, at the same ~0.05 s scale as
    // the artifacts named on the guard in `tick()`.
    this.pending = { target, dueAt: Date.now() + this.seekLandMs }
  }

  get paused(): boolean {
    return this.pausedFlag
  }

  play(): Promise<void> {
    if (this.pausedFlag) {
      this.reanchor()
      this.pausedFlag = false
      this.queued.push('play')
    }
    return Promise.resolve()
  }

  pause(): void {
    if (!this.pausedFlag) {
      this.reanchor()
      this.pausedFlag = true
      this.queued.push('pause')
    }
  }

  /**
   * Bind a new source — the HTML media load algorithm, to the depth these
   * fixtures can see.
   *
   * Three things happen synchronously in the spec's algorithm and all three are
   * modelled, because each one is load-bearing somewhere in the syncplay stack:
   *
   *  - `readyState` drops to HAVE_NOTHING. That is the gate
   *    `hasAnnounceablePosition()` closes in `use-syncplay-client.ts` (#284), so
   *    a reloading element stops pushing snapshots — which is what eventually
   *    takes main past `PLAYBACK_ASSERT_STALE_MS` and then `PLAYBACK_STALE_MS`.
   *  - the playhead resets to 0. An element announcing that 0 is #220, and the
   *    gate above is the only thing standing between the two.
   *  - a playing element is paused and a `pause` task is queued. Not incidental
   *    either: that pause is delivered while the element still reports
   *    HAVE_NOTHING, where `hasAnnounceablePosition()`
   *    (`use-syncplay-client.ts:770`) drops it before it can reach the wire and
   *    `onLocalPause`'s `readyState > 0` conjunct keeps it from arming the
   *    pending user pause. An element that reloaded without queuing one would
   *    leave both guards unobserved.
   *
   * `loadedmetadata` then arrives asynchronously, `bindGapMs` later, and takes
   * `readyState` back to HAVE_METADATA. It is delivered through `tick()` with
   * the other media events, so nothing fires re-entrantly from inside this call.
   *
   * What this is deliberately *not* is a new element. A real episode change
   * rebinds the same `<video>`, which is why `newPlayer` exists on the file push
   * at all (`src/main/syncplay.ts:743`) and why the harness keeps one object
   * here: a fixture that swapped the element out would be testing a mount, and
   * the mount is the case main can already see.
   */
  reload(src: string): void {
    this.src = src
    this.loads.push(src)
    if (!this.pausedFlag) {
      this.pausedFlag = true
      this.queued.push('pause')
    }
    this.anchor = 0
    this.anchorAt = Date.now()
    // Dropping `pending` is also what makes the inverted getter need no
    // reload-specific arm: a reloaded element falls straight back to `live()`,
    // which is 0 here, and that is what a real one reports too.
    this.pending = null
    this.readyState = 0
    this.metadataDueAt = Date.now() + this.bindGapMs
  }

  /**
   * Land anything due and hand back the media events to deliver. Called once
   * per `advance()` slice; the caller routes each event into the composable the
   * way `PlayerView` wires `@seeked` / `@play` / `@pause` / `@loadedmetadata`.
   */
  tick(): QueuedMediaEvent[] {
    // Before the seek landing below. A `reload()` drops `pending`, so the two
    // cannot land in the tick a load starts — but a `currentTime` write after it
    // re-arms `pending`, and at `seekLandMs: 0` that write plus a due landing
    // hands back `['loadedmetadata', 'seeked']` in one batch. The order here is
    // the right one for that case too: metadata is the event that reopens the
    // door a load closed.
    //
    // Held back while the load's own queued tasks are still undelivered: on a
    // real element those run before the task that reaches HAVE_METADATA, so the
    // `pause` a reload queues is handed to `onLocalPause` at `readyState` 0.
    //
    // The hold-back is bounded rather than open-ended, and that bound is worth
    // stating because a gate on someone else's queue is the shape that starves:
    // every `tick()` ends by draining the queue, and the `seeked` below is
    // pushed past this check and drained by that same drain, so only a caller
    // queuing between two ticks can defer the landing — and `play()`/`pause()`
    // are edge-guarded, so deferring it forever needs a fixture (or an apply
    // path) flipping the element *both* ways in every slice. One press, or a
    // pause that stays a pause, defers by exactly one tick. The gate is the
    // whole queue rather than the load's own tasks, so it also defers a task
    // queued *after* metadata came due: a `play()` there comes back at
    // `readyState` 0 with `loadedmetadata` a tick behind it, where a real
    // element runs the older task first and delivers that `play` at
    // HAVE_METADATA.
    if (
      this.metadataDueAt !== null &&
      Date.now() >= this.metadataDueAt &&
      this.queued.length === 0
    ) {
      this.metadataDueAt = null
      this.readyState = 1
      this.queued.push('loadedmetadata')
    }
    if (this.pending !== null && Date.now() >= this.pending.dueAt) {
      // `seekLandMs > 0` is what the deleted `stalled !== null` null-check was
      // always standing in for, and it has to stay. Re-anchoring
      // unconditionally snaps every `seekLandMs: 0` element back onto its
      // target on the following slice, discarding the ~0.05 s it has already
      // walked since the write landed, and reds three files by exactly that
      // much for reasons with no connection to the mid-seek reading:
      // `syncplay-two-peer-seek-echo.test.ts:104` reads 400.1000000715256
      // against a close-to of 400.15, the same shape repeats at
      // `syncplay-two-peer-seek-echo.test.ts:193` and
      // `syncplay-two-peer-seek-echo.test.ts:194` (800.1 against 800.15), and
      // `syncplay-two-peer-ignore-counters.test.ts:230` reads 700.0499999523163
      // against 700.1 — plus `syncplay-two-peer-rtt.test.ts` and one adoption
      // test off the same shift. The numbers are written down because keeping
      // this guard is what makes deleting the field free, and the next person
      // tidying the field's leftovers away will try exactly this.
      if (this.seekLandMs > 0) {
        this.anchor = this.pending.target
        this.anchorAt = Date.now()
      }
      this.pending = null
      this.queued.push('seeked')
    }
    return this.queued.splice(0)
  }
}

// ── Peers ─────────────────────────────────────────────────────────────────────

/** One remote-state frame as the renderer was handed it, with what main held. */
export interface ObservedFrame {
  /** ms since the room was created. */
  at: number
  state: SyncplayRemoteState
  /** `SyncplayClient`'s private seek intent at that instant (#278's subject). */
  intent: { at: number; attempts: number } | null
  /** Where this peer's element read at that instant. */
  element: number
}

export interface SeatPeerOptions extends HarnessVideoOptions {
  username: string
  /** Symmetric one-way link delay in ms, as `MinElectionServer` seats it. */
  delayMs?: number
  animeName?: string
  /** The episode this peer *starts* on. Mutable afterwards through
   *  `Peer.goToEpisode()` — see the note there on why it cannot be a constant. */
  episodeInt?: string
}

/** `SyncplayClient`'s three `ignoringOnTheFly` counters, sampled together. */
export interface IgnoreCounters {
  /** Bumped once per *discrete* change the client originates, and by nothing
   *  else. Monotonic within a connection: `resetTransportState()` zeroes it
   *  with the other two (`src/main/syncplay.ts:1071-1073`). */
  clientIgnoreCounter: number
  /** The counter of our newest outstanding change, or 0. */
  pendingClientAck: number
  /** The server counter we owe an answer for. */
  pendingServerAck: number
}

export interface Peer {
  readonly username: string
  /** This peer's real main-process client. */
  readonly client: MainSyncplayClient
  /** This peer's real preload bridge object. */
  readonly api: Api
  /** This peer's mounted composable — the renderer half of the loop. */
  readonly ui: RendererSyncplayClient
  readonly el: HarnessVideo
  /** Every `remote-state` main handed the renderer, in order. */
  readonly frames: ObservedFrame[]
  /** Every channel broadcast to this peer's renderer, in order. */
  readonly broadcasts: { channel: string; payload: unknown }[]
  /** Every episode change a *peer* signalled, in the order this renderer's
   *  `SyncplayDeps.onRemoteEpisodeChange` was handed them.
   *
   *  Recorded rather than acted on, and that is the honest shape: the composable
   *  explicitly does not own the follow-through — its own header says so, and it
   *  hands the episode to the consumer while `PlayerView` wires the navigation.
   *  A harness that navigated here would be asserting against its own model of
   *  PlayerView rather than against PlayerView. */
  readonly remoteEpisodes: SyncplayRemoteEpisode[]
  /** The episode this peer's renderer currently reports, i.e. what its next
   *  file push will announce. */
  episode(): string
  status(): SyncplayStatus
  /** `SyncplayClient`'s private `seekIntent`. Private by design — read here
   *  rather than re-derived, because the fixtures that care about it are about
   *  the exact instant it is retired. */
  seekIntent(): { at: number; attempts: number } | null
  /** `SyncplayClient`'s private `ignoringOnTheFly` counters, as one triple.
   *  Surfaced here for the same reason as `seekIntent()`, and so the fixtures
   *  that read them spell the field names in one place rather than one per
   *  scenario file. */
  counters(): IgnoreCounters
  /** `SyncplayClient`'s private `serverRtt`, in **seconds** — the round trip the
   *  ping exchange last measured, and the term `handleState()` halves into both
   *  the position compensation and the room anchor's back-date.
   *
   *  Read here for the same reason as `seekIntent()` and `counters()`: it is
   *  private, it is projected onto nothing — not `SyncplayStatus`, not the
   *  `Peer` surface before this — and a fixture that re-derived it from the link
   *  delay would be asserting against its own arithmetic rather than against
   *  what the client measured. It is 0 until the first echo completes a round
   *  trip, which is itself worth being able to say. */
  rtt(): number
  /** The user drags the scrubber: a bare `currentTime` write with no
   *  programmatic operation armed, so the resulting `seeked` reaches the room as
   *  the user's own seek. */
  userSeek(to: number): void
  /** The user presses play / pause. */
  userPlay(): void
  userPause(): void
  /**
   * The user presses **next episode**: the element rebinds to a new source and
   * `activeEpisodeIndex` moves.
   *
   * Deliberately only those two writes. Everything else an episode change does
   * to the room is the composable's own watcher on
   * `[activeEpisodeIndex, activeTranslationId]` — `clearPendingUserPause()`,
   * `bumpPlaybackSourceGeneration()`, `resetRemoteStateTracking()` and the
   * `pushSyncplayFile()` that main turns into a de-adoption — so driving the
   * refs is what puts the shipped path under test. A harness that called
   * `ui.pushSyncplayFile()` directly would announce the file and skip the three
   * resets, which is a shape no episode change produces.
   *
   * The index is bumped rather than set: nothing downstream reads its *value*
   * (PlayerView resolves the source before writing it, and the composable only
   * watches for a change), so a monotone counter is the honest model and spares
   * every caller from tracking an index it has no other use for.
   *
   * The `src` defaults to a per-episode identity so two calls never collide;
   * pass one to pin an exact `v.src` an assertion reads back.
   */
  goToEpisode(episodeInt: string, src?: string): void
  /** Deliver whatever the element has queued, into the composable. */
  tick(): void
  unmount(): void
}

interface PeerGraph {
  client: MainSyncplayClient
  api: Api
  plain: HarnessSocket[]
  tls: HarnessSocket[]
  emit: (channel: string, ...args: unknown[]) => void
  broadcasts: { channel: string; payload: unknown }[]
}

/**
 * Build one peer's private module graph: its own `electron`, `net` and `tls`,
 * and therefore its own IPC registries, sockets, `SyncplayClient` singleton and
 * preload `api`.
 *
 * `observe` runs against the fresh client **before** the broadcast wiring, and
 * that ordering is load-bearing rather than tidiness: `EventEmitter` calls its
 * listeners in registration order and the whole renderer leg of a frame — the
 * IPC hop, the composable's handler, the `currentTime` write — is synchronous,
 * so a `remote-state` observer registered after `registerSyncplayBroadcasts`
 * reads the element the apply has already moved. Every fixture that asks "where
 * was the playhead when this frame arrived" needs the other side of that.
 */
async function buildPeerGraph(observe: (client: MainSyncplayClient) => void): Promise<PeerGraph> {
  const mainHandlers = new Map<string, (...args: unknown[]) => unknown>()
  const rendererListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const broadcasts: { channel: string; payload: unknown }[] = []
  const plain: HarnessSocket[] = []
  const tls: HarnessSocket[] = []

  vi.resetModules()
  vi.doMock('electron', () => ({
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        mainHandlers.set(channel, handler)
      },
      on: vi.fn(),
      removeHandler: (channel: string) => {
        mainHandlers.delete(channel)
      },
      removeAllListeners: vi.fn()
    },
    ipcRenderer: {
      // The renderer→main half. Same contract as the global mock's loop: always
      // a promise, a missing handler and a throwing handler both rejecting the
      // way real `invoke` does.
      //
      // `test/setup/electron-mock.ts` is the source of truth for these two
      // rejection shapes; this copy exists only because a per-peer
      // `vi.doMock('electron')` replaces that module wholesale, registries
      // included, so the loop has to be rebuilt rather than imported. Keep the
      // strings in step with it: in Electron the no-handler error is raised in
      // main and comes back through the very same renderer-side wrapper as a
      // handler throw, so a renderer sees
      // `Error invoking remote method '<channel>': <Name>: <message>` either way.
      //
      // "Keep them in step" is enforced rather than asked for, and on both legs:
      // `test/services/syncplay-two-peer-loop.test.ts` pins the no-handler shape
      // below, which reds on a mutated prefix here, and the handler-throw shape,
      // which reds if `throw asRemoteError(err)` is relaxed to a bare `throw err`
      // — that one used to leave every file that uses this harness green. Before
      // those two cases neither leg was observed, and the drift this paragraph
      // warns about would have been silent on whichever one it hit.
      invoke: (channel: string, ...args: unknown[]) => {
        const handler = mainHandlers.get(channel)
        const asRemoteError = (err: unknown): Error =>
          new Error(
            `Error invoking remote method '${channel}': ` +
              (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
          )
        return (async () => {
          if (!handler) throw asRemoteError(new Error(`No handler registered for '${channel}'`))
          try {
            return await handler({}, ...args)
          } catch (err) {
            throw asRemoteError(err)
          }
        })()
      },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        let bucket = rendererListeners.get(channel)
        if (!bucket) {
          bucket = new Set()
          rendererListeners.set(channel, bucket)
        }
        bucket.add(listener)
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        rendererListeners.get(channel)?.delete(listener)
      },
      removeAllListeners: (channel: string) => {
        rendererListeners.get(channel)?.clear()
      },
      send: vi.fn()
    },
    contextBridge: { exposeInMainWorld: vi.fn() }
  }))
  vi.doMock('net', () => ({
    createConnection: vi.fn(() => {
      const s = new HarnessSocket()
      plain.push(s)
      return s
    })
  }))
  vi.doMock('tls', () => ({
    connect: vi.fn(() => {
      const s = new HarnessSocket()
      tls.push(s)
      return s
    })
  }))

  const syncplayMod = await import('../../src/main/syncplay')
  const routerMod = await import('../../src/main/ipc/syncplay.ipc')
  const broadcastMod = await import('../../src/main/ipc/syncplay-broadcasts')
  // `onMounted` reads `getSetting('syncplay')` before it installs its
  // subscriptions, so the settings router is in the loop whether the harness
  // wants it or not — and a rejected read aborts the hook, leaving a mount with
  // no remote-state subscription and no snapshot interval. The real router
  // rather than a stub, so that stays true if the key it reads ever moves.
  const settingsMod = await import('../../src/main/ipc/settings.ipc')

  const emit = (channel: string, ...args: unknown[]): void => {
    broadcasts.push({ channel, payload: args[0] })
    const bucket = rendererListeners.get(channel)
    if (!bucket) return
    for (const listener of [...bucket]) listener({}, ...args)
  }

  const client = syncplayMod.syncplay
  observe(client)
  // The real wiring `src/main/index.ts` performs at boot, against this peer's
  // own client and its own renderer.
  broadcastMod.registerSyncplayBroadcasts(client, emit)
  // Two of `AppDeps`' seams are read here and no others: `store` (the connect
  // handler's persistence and the password vault) and, for the `downloadDir`
  // key alone, `coldStorageService`.
  const deps = {
    store: new InMemoryStorage(),
    coldStorageService: { getDownloadDir: () => '/tmp/anime-dl-two-peer' }
  } as unknown as Parameters<typeof routerMod.register>[0]
  routerMod.register(deps)
  settingsMod.register(deps)

  await import('../../src/preload/index')
  const api = (globalThis as unknown as { window: { api: Api } }).window.api

  return { client, api, plain, tls, emit, broadcasts }
}

// ── The room ──────────────────────────────────────────────────────────────────

export interface TwoPeerRoomOptions {
  room?: string
  /** Where the room already is when the fixture starts. */
  position?: number
  paused?: boolean
  /** Passed straight through to `MinElectionServer`. */
  server?: MinElectionServerOptions
}

export interface TwoPeerRoom {
  readonly server: MinElectionServer
  /** ms since the room was created — the `t0` every `ObservedFrame` is relative to. */
  elapsed(): number
  seat(opts: SeatPeerOptions): Promise<Peer>
  /**
   * Run the room for `seconds` of fake time, in `stepMs` slices, delivering the
   * elements' queued media events and draining microtasks between them.
   */
  advance(seconds: number, stepMs?: number): Promise<void>
  dispose(): void
}

const DEFAULT_STEP_MS = 50

/**
 * Stand up a modelled room. The caller owns the fake clock and must install it
 * first — `vi.useFakeTimers()` plus `vi.setSystemTime()` — because
 * `MinElectionServer`'s periodic `State` starts in its constructor.
 */
export async function createTwoPeerRoom(opts: TwoPeerRoomOptions = {}): Promise<TwoPeerRoom> {
  const t0 = Date.now()
  const server = new MinElectionServer({
    room: opts.room ?? 'cinema',
    position: opts.position ?? 0,
    paused: opts.paused ?? false,
    ...opts.server
  })
  const peers: Peer[] = []

  let seating = false
  const seat = async (peerOpts: SeatPeerOptions): Promise<Peer> => {
    // Serialised by contract, not re-entrant — see the note on the global
    // below. Two seats in flight at once interleave `vi.resetModules()` and the
    // `window.api` swap, and cross-wire the peers with no error. Left latched on
    // a throw deliberately: a seat that failed halfway has left the module
    // registry in a state the room cannot recover from anyway.
    if (seating) throw new Error('seat() is not re-entrant: await each seat before the next')
    seating = true
    const el = new HarnessVideo(peerOpts)
    const frames: ObservedFrame[] = []
    // Registered ahead of the broadcast wiring — see `buildPeerGraph` — so
    // `element` is where the playhead was when the frame arrived, not where the
    // apply it triggered put it.
    const graph = await buildPeerGraph((client) => {
      client.on('remote-state', (state: SyncplayRemoteState) => {
        frames.push({
          at: Date.now() - t0,
          state,
          intent: seekIntentOf(client),
          element: el.currentTime
        })
      })
    })

    // Connect through the real bridge — the connect handler is where the
    // password injection and the settings write live (#216), so the harness
    // takes the same door the join flows do. The handler body runs
    // synchronously inside `invoke`, so the socket exists by the time the
    // promise is awaited and `seat()` can take it.
    const connected = graph.api.syncplayConnect({
      host: 'syncplay.test',
      port: 8999,
      room: opts.room ?? 'cinema',
      username: peerOpts.username,
      autoReconnect: false
    })
    server.seat({
      username: peerOpts.username,
      delayMs: peerOpts.delayMs ?? 0,
      plain: graph.plain[graph.plain.length - 1],
      takeTls: () => graph.tls[graph.tls.length - 1]
    })
    await connected

    // The Pinia store and the preload global are the two things still resolved
    // per-renderer rather than per-peer. Both are read only while this mount is
    // settling — the store's subscriptions bind synchronously inside `setup`,
    // and `refresh()`'s second read lands one microtask later — so seating is
    // serialised here: set the global, mount, flush, and only then let the next
    // peer touch it.
    setActivePinia(createPinia())
    ;(globalThis as unknown as { window: { api: Api } }).window.api = graph.api

    let ui: RendererSyncplayClient | null = null
    // Per-peer and mutable, where these three used to be constants closed over
    // `peerOpts`. An episode is not a property of the seat: `goToEpisode()` has
    // to move it *between* `pushSyncplayFile()` calls, and a constant made the
    // one thing a file-change fixture needs to say unsayable — every push
    // announced the episode the peer was seated on, so main's `setFile()` never
    // saw `identityChanged` and the de-adoption it drives was unreachable.
    let episodeInt = peerOpts.episodeInt ?? '7'
    const activeEpisodeIndex = ref(0)
    const activeTranslationId = ref<number | null>(3)
    const remoteEpisodes: SyncplayRemoteEpisode[] = []
    const deps: SyncplayDeps = {
      api: graph.api,
      getVideoEl: () => el as unknown as HTMLVideoElement,
      getDuration: () => el.duration,
      getAnimeId: () => 1,
      getMalId: () => 2,
      getAnimeName: () => peerOpts.animeName ?? 'Some Anime',
      getCurrentEpisodeInt: () => episodeInt,
      getActiveEpisodeLabel: () => episodeInt,
      activeTranslationId,
      activeEpisodeIndex,
      formatTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
      onRemoteEpisodeChange: (ep) => {
        remoteEpisodes.push(ep)
      }
    }
    const Host = defineComponent({
      setup() {
        ui = useSyncplayClient(deps)
        return () => null
      }
    })
    const wrapper = mount(Host)
    await flushPromises()

    const client = graph.client
    const deliver = (): void => {
      for (const event of el.tick()) {
        if (event === 'seeked') ui!.onVideoSeeked()
        else if (event === 'play') ui!.onLocalPlay()
        else if (event === 'pause') ui!.onLocalPause()
        // `src/renderer/src/components/views/PlayerView.vue:2835` is the
        // `@loadedmetadata="syncplay.onVideoLoadedMetadata"` this stands in for.
        else ui!.onVideoLoadedMetadata()
      }
    }

    const peer: Peer = {
      username: peerOpts.username,
      client,
      api: graph.api,
      ui: ui!,
      el,
      frames,
      broadcasts: graph.broadcasts,
      remoteEpisodes,
      episode: () => episodeInt,
      status: () => client.getStatus(),
      seekIntent: () => seekIntentOf(client),
      counters: () => countersOf(client),
      rtt: () => rttOf(client),
      userSeek: (to: number) => {
        el.currentTime = to
      },
      userPlay: () => {
        void el.play()
      },
      userPause: () => {
        el.pause()
      },
      goToEpisode: (ep: string, src?: string) => {
        episodeInt = ep
        el.reload(src ?? `harness://${peerOpts.username}/ep-${ep}`)
        activeEpisodeIndex.value += 1
      },
      tick: deliver,
      unmount: () => wrapper.unmount()
    }
    peers.push(peer)
    seating = false
    return peer
  }

  const advance = async (seconds: number, stepMs = DEFAULT_STEP_MS): Promise<void> => {
    // `Math.round` on the product first, deliberately: `15.95 * 1000` is exact
    // but `0.07 * 1000` is not, and a raw float remainder check would reject
    // callers that are actually fine. Rounding the *step count* instead would
    // silently run a different duration than asked — `advance(0.07)` would run
    // 50 ms — and the crossfire timings are quoted to the slice.
    const ms = Math.round(seconds * 1000)
    if (ms % stepMs !== 0) {
      throw new Error(`advance(${seconds}, ${stepMs}): ${ms}ms is not a whole number of slices`)
    }
    const steps = ms / stepMs
    for (let i = 0; i < steps; i += 1) {
      await vi.advanceTimersByTimeAsync(stepMs)
      for (const peer of peers) peer.tick()
      // Vue's scheduler flushes on microtasks, so a watcher woken by a frame
      // this slice delivered has not run yet. Drain before the next slice.
      await flushPromises()
    }
  }

  return {
    server,
    elapsed: () => Date.now() - t0,
    seat,
    advance,
    // Drains `peers` up front and tears every one of them down even if an
    // earlier peer throws, then rethrows the first error. Both halves matter
    // once a case mocks something this calls: a throw used to abandon the rest
    // of the room *and* leave `peers` populated, so the next case's
    // `room?.dispose()` — `room` being a describe-scoped `let` that a case
    // building no room of its own never reassigns — re-ran the same throwing
    // teardown and red a neighbour with nothing wrong with it. Rethrowing keeps
    // the failure on the case that armed the throw.
    dispose: () => {
      server.stop()
      let firstError: unknown
      let threw = false
      for (const peer of peers.splice(0)) {
        try {
          peer.unmount()
          peer.client.disconnect()
        } catch (err) {
          if (!threw) {
            threw = true
            firstError = err
          }
        }
      }
      if (threw) throw firstError
    }
  }
}

// The three readers below reach into `SyncplayClient`'s private state, and they
// are the only place in the two-peer fixtures that does. Element access rather
// than `as unknown as { … }`: TypeScript resolves `client['seekIntent']`
// against the real class — the escape hatch it leaves open for private members
// — so the field name and its type are checked against the declaration, where a
// structural cast invents whatever shape it is handed and a renamed field goes
// on compiling. Verified: rename `clientIgnoreCounter` in `src/main/syncplay.ts`
// and `tsc` reports one error on the `countersOf` line below, nowhere else. The
// code it carries depends on the new name; see the recipe further down.
//
// Two caveats, so nobody reads more into this than it gives. First, no CI gate
// fails on that rename: `npm run typecheck` runs the two projects, and neither
// `tsconfig.node.json` nor `tsconfig.web.json` includes `test/**`. Second,
// reproducing it by hand is not the one-liner it sounds like. `tsc` on this
// file alone refuses to start while a `tsconfig.json` sits beside it (TS5112,
// which tells you to pass `--ignoreConfig`), and once past that it resolves
// neither the ambient `src/shared/types/*.d.ts` nor the `@shared/*` paths, so
// the one real error would land under the ~120 resolution errors this file
// already reports that way — mostly TS2304 and TS2307, and the exact count
// moves with the next import added here, so read it as a wall, not a fixture.
// The config that reproduces it exactly is `tsconfig.node.json` with
// `composite` dropped, `"types": ["node"]` added, and this file appended to
// `include`: zero errors at baseline, one error on the `countersOf` line under
// the rename — TS7053 when the new name is unlike the old, TS2551 ("did you
// mean 'clientIgnoreCounterX'?") when it is a near miss; `--noImplicitAny
// false` clears either, so the paragraph below holds for both. Dropping
// `composite` only trims noise: kept, the same run adds four TS6307 for the
// files reached by import but not listed, and still reports the real error
// beside them.
// What that config does *not* need is a strictness flag: both codes come from
// the same `noImplicitAny` check on the element access — TS7053 is its plain
// form, TS2551 the same check with a spelling suggestion attached — and the
// TypeScript 6 pinned here defaults it on, measured with no config at all and
// under a `tsconfig.json` that omits `strict`, as both of ours do. So it is an
// explicit `--noImplicitAny false` (or `--strict false`), not the default,
// that turns the rename back into a clean run.
//
// What the single reader buys unconditionally is the blast radius — a rename
// breaks one line here instead of failing at runtime in every scenario file
// that spelled the field out for itself.
const seekIntentOf = (client: MainSyncplayClient): { at: number; attempts: number } | null =>
  client['seekIntent']

const countersOf = (client: MainSyncplayClient): IgnoreCounters => ({
  clientIgnoreCounter: client['clientIgnoreCounter'],
  pendingClientAck: client['pendingClientAck'],
  pendingServerAck: client['pendingServerAck']
})

const rttOf = (client: MainSyncplayClient): number => client['serverRtt']
