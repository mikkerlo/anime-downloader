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
//    time to land, and the queued `play`/`pause`/`seeked` tasks — nothing else.
//    See its own note.
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
   *  element reports its **stalled** pre-write position, which is what the 1 Hz
   *  snapshot pushes to main and what wins the server's `min()` election — the
   *  property the crossfire fixture is built on. `0` lands on the write. */
  seekLandMs?: number
}

type QueuedMediaEvent = 'play' | 'pause' | 'seeked'

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
  readyState: number
  /** Every `currentTime` write, pre-clamp, in order. */
  readonly seekWrites: number[] = []

  private pausedFlag: boolean
  private anchor: number
  private anchorAt: number
  /** Non-null while a write is in flight: what the element reports meanwhile. */
  private stalled: number | null = null
  private pending: { target: number; dueAt: number } | null = null
  private readonly queued: QueuedMediaEvent[] = []
  private readonly seekLandMs: number

  constructor(opts: HarnessVideoOptions = {}) {
    this.duration = opts.duration ?? 1440
    this.readyState = opts.readyState ?? 1
    this.pausedFlag = opts.paused ?? true
    this.anchor = opts.position ?? 0
    this.anchorAt = Date.now()
    this.seekLandMs = opts.seekLandMs ?? 0
  }

  private live(): number {
    const walked = this.pausedFlag ? this.anchor : this.anchor + (Date.now() - this.anchorAt) / 1000
    return Math.min(Math.max(0, walked), this.duration)
  }

  private reanchor(): void {
    this.anchor = this.live()
    this.anchorAt = Date.now()
  }

  get currentTime(): number {
    return this.stalled ?? this.live()
  }

  set currentTime(t: number) {
    this.seekWrites.push(t)
    const target = Math.min(Math.max(0, t), this.duration)
    if (this.seekLandMs <= 0) {
      this.anchor = target
      this.anchorAt = Date.now()
      this.stalled = null
    } else if (this.stalled === null) {
      // Only the *first* in-flight write freezes the reading. A second write
      // arriving before the first lands must not re-read `live()`: `live()`
      // walks from the old anchor, so re-reading un-freezes the playhead and
      // jumps it forward by however long the first seek had been pending. A
      // real element stays where the first seek left it until one of them
      // lands. Replacing `pending` outright *is* right — an interrupted seek
      // fires no `seeked` of its own.
      this.stalled = this.live()
    }
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
   * Land anything due and hand back the media events to deliver. Called once
   * per `advance()` slice; the caller routes each event into the composable the
   * way `PlayerView` wires `@seeked` / `@play` / `@pause`.
   */
  tick(): QueuedMediaEvent[] {
    if (this.pending !== null && Date.now() >= this.pending.dueAt) {
      if (this.stalled !== null) {
        this.anchor = this.pending.target
        this.anchorAt = Date.now()
        this.stalled = null
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
  episodeInt?: string
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
  status(): SyncplayStatus
  /** `SyncplayClient`'s private `seekIntent`. Private by design — read here
   *  rather than re-derived, because the fixtures that care about it are about
   *  the exact instant it is retired. */
  seekIntent(): { at: number; attempts: number } | null
  /** The user drags the scrubber: a bare `currentTime` write with no
   *  programmatic operation armed, so the resulting `seeked` reaches the room as
   *  the user's own seek. */
  userSeek(to: number): void
  /** The user presses play / pause. */
  userPlay(): void
  userPause(): void
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
    const deps: SyncplayDeps = {
      api: graph.api,
      getVideoEl: () => el as unknown as HTMLVideoElement,
      getDuration: () => el.duration,
      getAnimeId: () => 1,
      getMalId: () => 2,
      getAnimeName: () => peerOpts.animeName ?? 'Some Anime',
      getCurrentEpisodeInt: () => peerOpts.episodeInt ?? '7',
      getActiveEpisodeLabel: () => peerOpts.episodeInt ?? '7',
      activeTranslationId: ref(3),
      activeEpisodeIndex: ref(0),
      formatTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
      onRemoteEpisodeChange: () => {}
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
        else ui!.onLocalPause()
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
      status: () => client.getStatus(),
      seekIntent: () => seekIntentOf(client),
      userSeek: (to: number) => {
        el.currentTime = to
      },
      userPlay: () => {
        void el.play()
      },
      userPause: () => {
        el.pause()
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
    dispose: () => {
      server.stop()
      for (const peer of peers) {
        peer.unmount()
        peer.client.disconnect()
      }
      peers.length = 0
    }
  }
}

const seekIntentOf = (client: MainSyncplayClient): { at: number; attempts: number } | null =>
  (client as unknown as { seekIntent: { at: number; attempts: number } | null }).seekIntent
