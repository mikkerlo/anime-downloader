// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineComponent, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { useSyncplayClient } from '../../../src/renderer/src/composables/use-syncplay-client'
import { useSyncplayStore } from '../../../src/renderer/src/stores/syncplay'

type Api = {
  syncplayGetStatus: () => Promise<SyncplayStatus>
  syncplayGetRoomUsers: () => Promise<SyncplayRoomUser[]>
  syncplayConnect: (cfg: SyncplayConnectConfig) => Promise<void>
  syncplayDisconnect: () => Promise<void>
  syncplaySetFile: (payload: SyncplayFilePayload) => void
  syncplaySendLocalState: (state: { paused: boolean; position: number; cause: string }) => void
  syncplaySendLocalSnapshot: (state: { paused: boolean; position: number }) => void
  syncplayPlayerClosed: (playerSessionId?: string) => void
  syncplaySetReady: (ready: boolean) => Promise<void>
  shikimoriGetUser: () => Promise<{ nickname?: string } | null>
  getSetting: (key: string) => Promise<unknown>
  setSetting: (key: string, value: unknown) => Promise<void>
  onSyncplayConnectionStatus: (cb: (s: SyncplayStatus) => void) => Unsubscribe
  onSyncplayRemoteState: (cb: (s: SyncplayRemoteState) => void) => Unsubscribe
  onSyncplayRoomUsers: (cb: (u: SyncplayRoomUser[]) => void) => Unsubscribe
  onSyncplayRoomEvent: (cb: (e: SyncplayRoomEvent) => void) => Unsubscribe
  onSyncplayTrace: (cb: (e: { dir: string; keys: string; msg: unknown }) => void) => Unsubscribe
  onSyncplayRemoteEpisodeChange: (cb: (ep: SyncplayRemoteEpisode) => void) => Unsubscribe
}

function noopSub(): Unsubscribe {
  return () => {}
}

function setApi(api: Partial<Api>): void {
  const w = (globalThis as { window?: { api?: Partial<Api> } }).window
  const prev = w?.api ?? {}
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...prev, ...api } }
}

const DEFAULT_API: Partial<Api> = {
  syncplayGetStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
  syncplayGetRoomUsers: vi.fn().mockResolvedValue([]),
  syncplayConnect: vi.fn().mockResolvedValue(undefined),
  syncplayDisconnect: vi.fn().mockResolvedValue(undefined),
  syncplaySetFile: vi.fn(),
  syncplaySendLocalState: vi.fn(),
  syncplaySendLocalSnapshot: vi.fn(),
  // Every mount's teardown reaches for this (#288), so it belongs in the
  // default surface rather than in the one case that asserts on it.
  syncplayPlayerClosed: vi.fn(),
  syncplaySetReady: vi.fn().mockResolvedValue(undefined),
  shikimoriGetUser: vi.fn().mockResolvedValue({ nickname: '' }),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  onSyncplayConnectionStatus: noopSub,
  onSyncplayRemoteState: noopSub,
  onSyncplayRoomUsers: noopSub,
  onSyncplayRoomEvent: noopSub,
  onSyncplayTrace: noopSub,
  onSyncplayRemoteEpisodeChange: noopSub
}

beforeEach(() => {
  ;(globalThis as { window?: { api: Partial<Api> } }).window = { api: { ...DEFAULT_API } }
  setActivePinia(createPinia())
})

// Unmounting in the test body is skipped whenever an assertion above it throws,
// and the composable's onMounted installs the snapshot interval — so one red
// test would hand a live interval and its remote-state closure to every test
// after it. Tear them down here instead, where a throw cannot skip it.
const mountedWrappers: { unmount: () => void }[] = []

// Timers first: if an unmount throws, fake timers would otherwise leak into
// every following test — the same bleed this hook exists to stop. useRealTimers
// discards the pending fake timers itself, so the composable's clearInterval
// running against a stale fake id afterwards is harmless.
afterEach(() => {
  vi.useRealTimers()
  mountedWrappers.splice(0).forEach((w) => w.unmount())
})

type Deps = Parameters<typeof useSyncplayClient>[0]

function makeDeps(
  overrides: {
    video?: HTMLVideoElement | null
    /** Live getter, for the cases where the element appears (or is swapped)
     *  after the composable is already running — `video` above is fixed. */
    getVideo?: () => HTMLVideoElement | null
    duration?: number
    animeId?: number
    malId?: number | null
    animeName?: string
    episodeInt?: string
    episodeLabel?: string
    translationId?: number | null
    episodeIndex?: number
    onRemoteEpisodeChange?: (ep: SyncplayRemoteEpisode) => void
  } = {}
): Deps {
  return {
    getVideoEl: overrides.getVideo ?? (() => overrides.video ?? null),
    getDuration: () => overrides.duration ?? 0,
    getAnimeId: () => overrides.animeId ?? 1,
    getMalId: () => overrides.malId ?? null,
    getAnimeName: () => overrides.animeName ?? 'Test Anime',
    getCurrentEpisodeInt: () => overrides.episodeInt ?? '1',
    getActiveEpisodeLabel: () => overrides.episodeLabel ?? '1',
    activeTranslationId: ref(overrides.translationId ?? 1),
    activeEpisodeIndex: ref(overrides.episodeIndex ?? 0),
    formatTime: (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
    onRemoteEpisodeChange: overrides.onRemoteEpisodeChange ?? (() => {})
  }
}

type Client = ReturnType<typeof useSyncplayClient>

// The single mount site. Every mount registers for teardown here, so a new one
// cannot forget — an untracked mount leaks the snapshot interval installed at
// `use-syncplay-client.ts:480` into whatever runs next. The wrapper is
// deliberately not returned: nothing needs to unmount mid-body, and a caller
// that did would then be unmounted a second time by the hook.
function trackedMount(deps: Deps): { client: Client } {
  let client: Client | null = null
  const Host = defineComponent({
    setup() {
      client = useSyncplayClient(deps)
      return () => null
    }
  })
  mountedWrappers.push(mount(Host))
  return { client: client! }
}

// applyRemoteState lives behind the onSyncplayRemoteState subscription, which
// is only wired in onMounted — so reaching it needs a real mount plus a stub
// that hands the callback back out.
async function mountWithRemoteState(
  deps: Deps,
  status: SyncplayStatus = { state: 'ready' }
): Promise<{
  client: Client
  emitRemoteState: (s: Partial<SyncplayRemoteState>) => void
}> {
  let cb: ((s: SyncplayRemoteState) => void) | null = null
  setApi({
    onSyncplayRemoteState: (fn: (s: SyncplayRemoteState) => void) => {
      cb = fn
      return () => {}
    }
  })
  const { client } = trackedMount(deps)
  await flushPromises()
  client.syncplayStatus.value = status
  // Typed rather than cast: a fifth required field on SyncplayRemoteState must
  // fail typecheck here, not leave every test below delivering a payload main
  // would never send.
  const base: SyncplayRemoteState = { position: 0, paused: true, doSeek: false, setBy: null }
  return {
    client,
    emitRemoteState: (s) => cb?.({ ...base, ...s })
  }
}

// `readyState: 1` (HAVE_METADATA) by default, because that is the state the
// apply rule is written for: #240 forks applyRemoteState on `v.readyState >= 1`
// and parks the state below it, so a fake without the field (`undefined >= 1`
// is false) would defer *every* apply in this file and take the apply-rule and
// send-gating blocks with it. The deferral tests pass `readyState: 0`
// explicitly — a real happy-dom <video> is no help there either, since its
// readyState is pinned at 0 and silently ignores assignment.
//
// `currentTime` is an accessor that clamps the written value to `[0, duration]`
// the way Chromium's seek algorithm clamps to the seekable range (#281). Without
// it a write past the end of the file is indistinguishable from a write inside
// it, and the out-of-file cases below would all read back the raw value and pass
// on `main`. `rawCurrentTimeWrites` keeps the unclamped value for the cases that
// need to separate "our code wrote X" from "the element landed on X". The clamp
// is live against `duration`, so a fake given a longer duration accepts a longer
// write — which is what makes the growing-`.part` case at "writes a position
// past the download frontier unclamped" still legible.
const rawCurrentTimeWrites = new WeakMap<object, number[]>()

function fakeVideo(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  const v: Record<string, unknown> = {
    currentTime: 0,
    duration: 1440,
    paused: true,
    readyState: 1,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    ...overrides
  }
  let position = Number(v.currentTime) || 0
  const raw: number[] = []
  rawCurrentTimeWrites.set(v, raw)
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    enumerable: true,
    get: () => position,
    set: (t: number) => {
      raw.push(t)
      const d = Number(v.duration)
      const end = Number.isFinite(d) && d > 0 ? d : Infinity
      position = Math.min(Math.max(0, t), end)
    }
  })
  return v as unknown as HTMLVideoElement
}

describe('useSyncplayClient — initial state', () => {
  it('starts idle with no users + no toast', () => {
    const s = useSyncplayClient(makeDeps())
    expect(s.syncplayStatus.value.state).toBe('idle')
    expect(s.syncplayRoomUsers.value).toEqual([])
    expect(s.syncplayToast.value).toBe('')
    expect(s.syncplayPausedBy.value).toBeNull()
    expect(s.syncplayMenuOpen.value).toBe(false)
  })
})

describe('useSyncplayClient — showSyncplayToast', () => {
  it('sets + clears the toast on timer', () => {
    vi.useFakeTimers()
    const s = useSyncplayClient(makeDeps())
    s.showSyncplayToast('hello')
    expect(s.syncplayToast.value).toBe('hello')
    vi.advanceTimersByTime(3499)
    expect(s.syncplayToast.value).toBe('hello')
    vi.advanceTimersByTime(2)
    expect(s.syncplayToast.value).toBe('')
  })

  it('debounces repeated calls', () => {
    vi.useFakeTimers()
    const s = useSyncplayClient(makeDeps())
    s.showSyncplayToast('first', 1000)
    vi.advanceTimersByTime(500)
    s.showSyncplayToast('second', 1000)
    vi.advanceTimersByTime(600)
    // The first timer was cleared; second is still active.
    expect(s.syncplayToast.value).toBe('second')
  })
})

describe('useSyncplayClient — pushSyncplayFile', () => {
  it('is a no-op when not ready', () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    const s = useSyncplayClient(makeDeps())
    s.pushSyncplayFile()
    expect(setFile).not.toHaveBeenCalled()
  })

  it('sends the IPC payload with episode + canonical name when ready', () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    const v = fakeVideo({ duration: 1500 } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(
      makeDeps({
        video: v,
        animeId: 42,
        malId: 99,
        animeName: 'COTE',
        episodeInt: '7',
        translationId: 123
      })
    )
    s.syncplayStatus.value = { state: 'ready' }
    s.pushSyncplayFile()
    expect(setFile).toHaveBeenCalledWith({
      animeId: 42,
      malId: 99,
      episodeInt: '7',
      translationId: 123,
      canonicalName: 'COTE - 7',
      duration: 1500,
      newPlayer: true,
      // Opaque by design (#307) — main only ever compares it with what a later
      // close quotes back, so the fixture pins its *presence* and its type, not
      // its spelling. The cases below pin the two properties that are load-
      // bearing: constant within a mount, different between mounts.
      playerSessionId: expect.any(String)
    })
  })

  // `newPlayer` is main's only honest signal for "a fresh <video> is announcing
  // itself" (#236) — the canonical name is `"{anime} - {ep}"` with no
  // translation component, so a same-episode reopen re-pushes a byte-identical
  // name, and main's snapshot clock still reads "live" for PLAYBACK_STALE_MS
  // after the previous player closed. Main keys *both* of setFile()'s resets on
  // it, so a wrong value is load-bearing in both directions: claimed on a
  // re-push it tells peers we are ready mid-buffer; missing on a mount it lets
  // the previous player's adoption latch yank the room to 0.
  it('claims newPlayer on the first push of a mount and never again', () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo({ duration: 1500 } as never) }))
    s.syncplayStatus.value = { state: 'ready' }

    s.pushSyncplayFile()
    // The duration re-push and the translation-switch re-push are the same
    // still-live player announcing itself again.
    s.pushSyncplayFile()
    s.pushSyncplayFile()

    expect(setFile.mock.calls.map(([p]) => p.newPlayer)).toEqual([true, false, false])
  })

  // `playerSessionId` is the mirror image of `newPlayer` and its scope is what
  // makes it usable (#307): it says "this player", so it has to be **the same**
  // on every push a mount makes — the duration re-push, the translation switch,
  // the transition-into-ready re-announce after a reconnect. A per-push value
  // would leave main holding an ID the unmount can no longer name, and the
  // close would silently stop clearing the file.
  it('carries one session id across every push of a mount', () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo({ duration: 1500 } as never) }))
    s.syncplayStatus.value = { state: 'ready' }

    s.pushSyncplayFile()
    s.pushSyncplayFile()
    s.pushSyncplayFile()

    const ids = setFile.mock.calls.map(([p]) => p.playerSessionId)
    expect(ids[0]).toEqual(expect.any(String))
    expect(new Set(ids).size).toBe(1)
  })

  // …and different between mounts, which is the half the guard in main actually
  // consumes: a close quoting the previous mount's ID must not clear the file
  // the current one announced.
  it('mints a different session id for each mount', () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    const first = useSyncplayClient(makeDeps({ video: fakeVideo({ duration: 1500 } as never) }))
    first.syncplayStatus.value = { state: 'ready' }
    first.pushSyncplayFile()
    const second = useSyncplayClient(makeDeps({ video: fakeVideo({ duration: 1500 } as never) }))
    second.syncplayStatus.value = { state: 'ready' }
    second.pushSyncplayFile()

    const [a, b] = setFile.mock.calls.map(([p]) => p.playerSessionId)
    expect(a).not.toBe(b)
  })

  // Mount-scoped, not `onMounted`-scoped: a player that mounts *before* the
  // session is ready skips the mount push at the readiness guard, and its first
  // announcement is then the transition-into-ready watcher's — which still has
  // to carry the claim, or main never de-adopts for it.
  it('claims newPlayer on the first push that actually goes out', () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo({ duration: 1500 } as never) }))

    // Not ready yet: this one is dropped at the guard and must not consume it.
    s.pushSyncplayFile()
    s.syncplayStatus.value = { state: 'ready' }
    s.pushSyncplayFile()

    expect(setFile).toHaveBeenCalledTimes(1)
    expect(setFile.mock.calls[0][0].newPlayer).toBe(true)
  })

  // #288 — the other half of "a fresh <video> is announcing itself": saying out
  // loud that the previous one is gone. Without it main infers the close from
  // silence on the 5 s PLAYBACK_STALE_MS horizon and keeps asserting the closed
  // player's frozen position into the room for that whole window.
  it('tells main the player is gone when the composable unmounts, exactly once', async () => {
    const playerClosed = vi.fn()
    setApi({ syncplayPlayerClosed: playerClosed })
    const Host = defineComponent({
      setup() {
        useSyncplayClient(makeDeps())
        return () => null
      }
    })
    const wrapper = mount(Host)
    mountedWrappers.push(wrapper)
    await flushPromises()
    // Not on mount, and not on an ordinary tick — only on teardown.
    expect(playerClosed).not.toHaveBeenCalled()

    mountedWrappers.pop()
    wrapper.unmount()

    // Once per unmount, because the hook runs once and the composable is
    // mount-scoped: idempotence is the handler's property, not the renderer's.
    expect(playerClosed).toHaveBeenCalledTimes(1)
    // And it names itself (#307), even though this mount never announced — main
    // compares rather than trusts, so an ID it has never seen is exactly how a
    // never-announced mount tells it "reset the player state, leave the file".
    expect(playerClosed.mock.calls[0][0]).toEqual(expect.any(String))
  })

  // The two halves of the session ID meeting: what a mount announces under is
  // what its unmount quotes back. If these ever drift apart the file clear
  // silently stops happening and only an integration test would notice.
  it('closes with the same session id it announced under', async () => {
    const playerClosed = vi.fn()
    const setFile = vi.fn()
    setApi({ syncplayPlayerClosed: playerClosed, syncplaySetFile: setFile })
    const Host = defineComponent({
      setup() {
        const c = useSyncplayClient(makeDeps({ video: fakeVideo({ duration: 1500 } as never) }))
        c.syncplayStatus.value = { state: 'ready' }
        c.pushSyncplayFile()
        return () => null
      }
    })
    const wrapper = mount(Host)
    mountedWrappers.push(wrapper)
    await flushPromises()

    mountedWrappers.pop()
    wrapper.unmount()

    expect(setFile).toHaveBeenCalled()
    expect(playerClosed).toHaveBeenCalledWith(setFile.mock.calls[0][0].playerSessionId)
  })

  // The ordering B's unconditional clear rests on, asserted from this side of
  // the IPC boundary: one client's close and the next player's announcement
  // ride the same `invoke` queue, close first. `PlayerView` is the only mount
  // site and is `v-if`-gated with no `key` and no `<KeepAlive>`, so the unmount
  // always precedes the remount — which is why main's handler needs no payload
  // to tell a stale close from a fresh one.
  it('emits the close before a remount announces its new player', async () => {
    const order: string[] = []
    setApi({
      syncplayPlayerClosed: vi.fn(() => {
        order.push('player-closed')
      }),
      syncplaySetFile: vi.fn((f) => {
        order.push(`set-file:newPlayer=${f.newPlayer === true}`)
      })
    })
    let client: Client | null = null
    const Host = defineComponent({
      setup() {
        client = useSyncplayClient(makeDeps({ video: fakeVideo({ duration: 1500 } as never) }))
        client.syncplayStatus.value = { state: 'ready' }
        return () => null
      }
    })

    // The player that closes.
    const first = mount(Host)
    mountedWrappers.push(first)
    await flushPromises()
    mountedWrappers.pop()
    first.unmount()

    // The reopen, mounted only after that teardown has run — and its first
    // announcement, which is what re-establishes adoption in main after the
    // close cleared it.
    const second = mount(Host)
    mountedWrappers.push(second)
    await flushPromises()
    client!.pushSyncplayFile()

    // The whole sequence one renderer puts on the queue, in order: the first
    // player announces itself, the close is emitted at its teardown, and only
    // then does the next player announce — so main can clear unconditionally on
    // the middle one without ever undoing the third.
    expect(order).toEqual(['set-file:newPlayer=true', 'player-closed', 'set-file:newPlayer=true'])
  })
})

describe('useSyncplayClient — applySyncplayReadyGate', () => {
  it('does nothing when status is not ready', () => {
    const v = fakeVideo({ paused: false } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.applySyncplayReadyGate()
    expect((v.play as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
    expect((v.pause as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })
})

describe('useSyncplayClient — onVideoSeeked / onVideoWaiting', () => {
  it('onVideoSeeked sends local state when ready', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 42, paused: false } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledWith({
      paused: false,
      position: 42,
      cause: 'seek'
    })
  })

  it('onVideoWaiting flips local-ready off after debounce', async () => {
    vi.useFakeTimers()
    const setReady = vi.fn().mockResolvedValue(undefined)
    setApi({ syncplaySetReady: setReady })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready' }
    s.onVideoWaiting()
    vi.advanceTimersByTime(599)
    expect(setReady).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(setReady).toHaveBeenCalledWith(false)
  })
})

describe('useSyncplayClient — toggleSyncplayConnection', () => {
  it('disconnects when state is ready', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)
    setApi({ syncplayDisconnect: disconnect })
    const s = useSyncplayClient(makeDeps())
    s.syncplayStatus.value = { state: 'ready' }
    await s.toggleSyncplayConnection()
    expect(disconnect).toHaveBeenCalled()
  })

  it('toasts when room is missing', async () => {
    setApi({
      getSetting: vi.fn().mockResolvedValue({ username: 'me' })
    })
    const s = useSyncplayClient(makeDeps())
    s.syncplayRoomInput.value = ''
    await s.toggleSyncplayConnection()
    expect(s.syncplayToast.value).toMatch(/room/i)
  })

  it('toasts when username is missing + shiki has no nickname', async () => {
    setApi({
      getSetting: vi.fn().mockResolvedValue({ lastRoom: 'r1' }),
      shikimoriGetUser: vi.fn().mockResolvedValue(null)
    })
    const s = useSyncplayClient(makeDeps())
    await s.toggleSyncplayConnection()
    expect(s.syncplayToast.value).toMatch(/username/i)
  })

  it('connects with stored host/port/room/username/autoReconnect', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    setApi({
      syncplayConnect: connect,
      getSetting: vi.fn().mockResolvedValue({
        lastHost: 'sync.example',
        lastPort: 1234,
        lastRoom: 'r1',
        username: 'me',
        autoReconnect: false
      })
    })
    const s = useSyncplayClient(makeDeps())
    await s.toggleSyncplayConnection()
    expect(connect).toHaveBeenCalledWith({
      host: 'sync.example',
      port: 1234,
      room: 'r1',
      username: 'me',
      autoReconnect: false
    })
  })

  it('falls back to shikimori nickname when username is missing', async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const setSetting = vi.fn().mockResolvedValue(undefined)
    setApi({
      syncplayConnect: connect,
      setSetting,
      getSetting: vi.fn().mockResolvedValue({ lastRoom: 'r1' }),
      shikimoriGetUser: vi.fn().mockResolvedValue({ nickname: 'shiki-user' })
    })
    const s = useSyncplayClient(makeDeps())
    await s.toggleSyncplayConnection()
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ username: 'shiki-user' }))
    expect(setSetting).toHaveBeenCalledWith(
      'syncplay',
      expect.objectContaining({ username: 'shiki-user' })
    )
  })
})

describe('useSyncplayClient — onLocalPlay / onLocalPause / onLocalCanPlay', () => {
  it('onLocalPlay sends local state + applies gate', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready' }
    s.onLocalPlay()
    expect(sendLocalState).toHaveBeenCalledWith(expect.objectContaining({ cause: 'play' }))
  })

  it('onLocalPause sets pausedBy to local username when ready', () => {
    setApi({ syncplaySendLocalState: vi.fn() })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }
    s.onLocalPause()
    expect(s.syncplayPausedBy.value).toBe('me')
  })

  it('onLocalCanPlay clears waiting timer + sets ready', async () => {
    vi.useFakeTimers()
    const setReady = vi.fn().mockResolvedValue(undefined)
    setApi({ syncplaySetReady: setReady })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready' }
    // Trigger waiting (which would eventually flip ready=false).
    s.onVideoWaiting()
    // Cancel via canplay before the debounce fires.
    s.onLocalCanPlay()
    vi.advanceTimersByTime(700)
    // setReady never got the false call because canplay cleared the timer
    // first. The flip from default(true) to true is a no-op.
    expect(setReady).not.toHaveBeenCalled()
  })
})

describe('useSyncplayClient — mounting into an already-ready session (#213)', () => {
  it('pushes the current file on mount when the connection is already ready', async () => {
    const setFile = vi.fn()
    setApi({
      syncplaySetFile: setFile,
      syncplayGetStatus: vi.fn().mockResolvedValue({ state: 'ready' })
    })
    // Reproduce the join flow: the store already holds a ready session
    // (established from WatchTogetherView) before the player mounts, so the
    // transition-into-ready watcher never fires.
    const store = useSyncplayStore()
    store.status = { state: 'ready' }

    const v = fakeVideo({ duration: 1500 } as Partial<HTMLVideoElement>)
    trackedMount(
      makeDeps({ video: v, animeId: 42, animeName: 'COTE', episodeInt: '7', translationId: 123 })
    )
    await flushPromises()

    expect(setFile).toHaveBeenCalledWith(
      expect.objectContaining({ animeId: 42, canonicalName: 'COTE - 7', duration: 1500 })
    )
  })

  it('does not push on mount when there is no active session', async () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    trackedMount(makeDeps({ video: fakeVideo() }))
    await flushPromises()
    expect(setFile).not.toHaveBeenCalled()
  })
})

// `sendSyncplayLocalState` has no wall-clock gate left (#304): every cause
// reaches it only past its own operation registry, so what these tests pin is
// that a *classified user event* is delivered and a *classified echo* is not.
// Each case still applies a remote state first, and deliberately so — the
// suppression that remains is armed by an apply, and a test that never applies
// one would pass against a composable with no echo guard at all.
//
// Reaching the send at all also needs a seek the *value*-keyed guard lets
// through: an event landing on the position we applied is consumed by its seek
// operation and never gets as far as the send.
describe('useSyncplayClient — sendSyncplayLocalState gating', () => {
  // #239: this seek is the user's, to a position nobody applied. It used to die
  // inside the wall-clock window — the user pressed Skip, the video moved
  // locally, and the room never heard about it. Seeks are keyed on the applied
  // value now, so only an actual echo is suppressed.
  it('sends a user seek to an unrelated position 200 ms after an apply', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    // A remote seek registers a `value` operation for 300 and moves the element
    // there.
    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // 200 ms later the user drags the scrubber somewhere else entirely, so the
    // value guard does not match and nothing else may suppress it.
    vi.advanceTimersByTime(200)
    v.currentTime = 900
    client.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // These two rows are the inversion #304 is (`still swallows a $label inside
  // the 1.5s window` before it). The window's remaining case for existing was
  // that play/pause have no applied value to key on, so deleting it wholesale
  // would leak the readiness gate's own pause/resume to the room. Phase A
  // (#306) answered that with the playback operation registry, and the registry
  // answers it *above* this send: `onLocalPlay` / `onLocalPause` return on a
  // matching `consumePlaybackOp` without reaching `sendSyncplayLocalState` at
  // all. From that point the window could only ever drop a press the registry
  // had already vouched for as the user's — which is precisely what these rows
  // used to assert it did.
  //
  // Both halves, because they were only coupled by the shape of one condition
  // and are still worth keeping apart: the `pause` direction is the one #228's
  // residual leaned on (a dropped pause never reaches main's discrete
  // `sendLocalState` path, so a stale playing frame resumes the initiator), and
  // the `play` direction is the one the new `syncplayAllUsersReady()` condition
  // sits on — all users are ready in both rows, so the send is expected.
  //
  // The seek-only apply fixture survives the inversion and is the whole reason
  // these rows are non-vacuous: `onLocalPlay`/`onLocalPause` return early on a
  // matching playback operation, so the apply must move the playhead but *not*
  // the play state (`needsSeek` without `needsPlayPause`). Hence the remote
  // `paused` matching the element's in both rows; a mismatch there registers an
  // operation that consumes the event, the handler returns above the send, and
  // the row would pass for the wrong reason.
  //
  // The `play` row leaves the element `paused: true`, so the ready gate below
  // the send calls `v.play()`. That spy call is not a second IPC send, and the
  // assertion here counts sends only.
  it.each([
    {
      label: 'play',
      paused: true,
      fire: (c: Client) => c.onLocalPlay(),
      expected: { paused: false, position: 300, cause: 'play' }
    },
    {
      label: 'pause',
      paused: false,
      fire: (c: Client) => c.onLocalPause(),
      expected: { paused: true, position: 300, cause: 'pause' }
    }
  ])('sends a $label 200 ms after an apply', async ({ paused, fire, expected }) => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused, doSeek: true })
    sendLocalState.mockClear()

    vi.advanceTimersByTime(200)
    fire(client)

    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith(expected)
  })

  it('sends that same seek 1501 ms after an apply', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    vi.advanceTimersByTime(1501)
    v.currentTime = 900
    client.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // The value-keyed guard is the one that must catch the element's own echo,
  // however late it fires — bounded by the operation's TTL and by nothing
  // shorter. It was the mechanism even while the wall clock still claimed to be
  // a backstop; since #304 it is unambiguously the only thing here.
  it('swallows the echo of an applied seek 4 s later', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // A slow network stream takes seconds to land the seek — far past anything
    // a wall-clock window would have covered, and well inside the TTL.
    vi.advanceTimersByTime(4000)
    v.currentTime = 300
    client.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #304. The readiness gate is where the deleted window was armed most often —
// every buffer refill re-armed it, at ~1 Hz through a stall — so it is where a
// dropped user press was most likely to happen and where the deletion has to be
// shown not to leak the gate's own moves back to the room.
//
// Every case here drives readiness with real events rather than by poking
// `syncplayLocalReady`: the setter early-returns on no change and the flag
// starts `true`, so the only way into the gate through readiness is *down*
// through the 600 ms `waiting` debounce first. The gate arms during that
// advance, not before it — the 601 ms is what makes `setSyncplayLocalReady`
// fire, and the arming is inside it.
//
// After that first advance no case advances timers again. The whole point is
// that a press landing in the same handful of milliseconds as the gate's own
// move is now distinguished by the registry alone, and an advance would let a
// reader believe some clock had helped.
// ─────────────────────────────────────────────────────────────────────────────
describe('useSyncplayClient — user presses survive a readiness gate cycle (#304)', () => {
  // A playing room, an adopted player, all users ready. `playbackAdopted: true`
  // keeps `pendingUserPause` out of it: pre-adoption the hold would falsify
  // `shouldPlay` and these cases would prove nothing about readiness.
  async function readyAndPlaying(v: HTMLVideoElement): Promise<{
    client: Client
    emitRemoteState: (s: Partial<SyncplayRemoteState>) => void
  }> {
    const r = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me',
      playbackAdopted: true
    })
    // Sets `syncplayLastRemotePlaying`. Position and paused both match the
    // element, so this apply is a no-op: it registers no operation of its own
    // and the cases below start with an empty registry.
    r.emitRemoteState({ position: 100, paused: false, doSeek: false, setBy: 'peer' })
    return r
  }

  // The pause direction, which is the one the residual was about: a dropped
  // pause never reaches main's discrete `sendLocalState` path, so the next stale
  // playing frame resumes the person who pressed it.
  it('sends a user pause taken right after the gate recovered readiness', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await readyAndPlaying(v)

    // Buffering. The debounce fires inside this advance and the gate down-arms
    // within it: it registers a `pause` operation and calls `v.pause()`.
    client.onVideoWaiting()
    vi.advanceTimersByTime(601)
    expect(v.pause).toHaveBeenCalled()

    // The element realizes it, and the registry claims the event as the app's.
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()

    // The buffer refills: the gate re-arms upward and plays us.
    ;(v.play as ReturnType<typeof vi.fn>).mockClear()
    client.onLocalCanPlay()
    expect(v.play).toHaveBeenCalled()

    // All users are ready and the element is running again *before* the
    // recovery play's echo is delivered. Both matter: with readiness lapsed at
    // this moment the nested gate would take its down arm instead and register
    // `pause`, which would swallow the real press below and leave the case
    // passing in the wrong direction.
    ;(v as { paused: boolean }).paused = false
    ;(v.pause as ReturnType<typeof vi.fn>).mockClear()
    ;(v.play as ReturnType<typeof vi.fn>).mockClear()
    client.onLocalPlay()
    // The nested gate takes neither branch — `shouldPlay` is true and the
    // element is already playing — so it arms nothing that could eat the press.
    expect(v.play).not.toHaveBeenCalled()
    expect(v.pause).not.toHaveBeenCalled()

    // Now the user presses pause, with the registry empty.
    sendLocalState.mockClear()
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()

    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 100, cause: 'pause' })
  })

  // The play direction, reached through the *down* gate so the user's press is
  // the only resume in the sequence — an intermediate synthetic play would
  // register an operation that consumed the press.
  it('sends a user play taken right after the gate paused for buffering', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await readyAndPlaying(v)

    client.onVideoWaiting()
    vi.advanceTimersByTime(601)
    expect(v.pause).toHaveBeenCalled()
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()

    // Readiness comes back with the element already running — the user pressed
    // play. Ordering the element's state *before* `onLocalCanPlay` is what keeps
    // the gate from issuing a synthetic resume of its own: `shouldPlay` is true
    // and `v.paused` is false, so it takes neither branch and arms nothing.
    ;(v.play as ReturnType<typeof vi.fn>).mockClear()
    ;(v as { paused: boolean }).paused = false
    client.onLocalCanPlay()
    expect(v.play).not.toHaveBeenCalled()

    sendLocalState.mockClear()
    client.onLocalPlay()

    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 100, cause: 'play' })
  })

  // The other half of #304's renderer change: when readiness is what is holding
  // playback, the discrete play is *omitted* rather than deferred. Main arms its
  // ignore counter on a discrete send, and a play we are not going to enact
  // should not deafen us to the acks that say when we may.
  it('omits the discrete play when readiness holds it, and keeps the intent', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await readyAndPlaying(v)

    // A peer is buffering, so `syncplayAllUsersReady()` is false while
    // everything else `shouldPlay` reads is about to be forced true by the
    // press itself.
    client.syncplayRoomUsers.value = [{ name: 'peer', isReady: false } as SyncplayRoomUser]
    await nextTick()
    expect(v.pause).toHaveBeenCalled()
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()

    // The user presses play against a held element.
    sendLocalState.mockClear()
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    // No discrete play on the wire…
    expect(sendLocalState).not.toHaveBeenCalled()
    // …and the gate immediately re-enacts the hold, because the peer is still
    // buffering. This is the badge/indicator behavior the issue accepts as-is:
    // the press cleared "Paused by …" even though the element did not move.
    expect(client.syncplayPausedBy.value).toBeNull()

    // The intent is not lost: it rides out on the snapshot path via `intentOr`,
    // which reports `paused: false` under a physically paused element.
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause() // the gate's own re-pause, consumed as the echo it is
    sendSnapshot.mockClear()
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 100, paused: false })

    // The release is the gate's own play, so it is an echo and not a second
    // user command — no duplicate discrete send when readiness returns.
    sendLocalState.mockClear()
    ;(v.play as ReturnType<typeof vi.fn>).mockClear()
    client.syncplayRoomUsers.value = [{ name: 'peer', isReady: true } as SyncplayRoomUser]
    await nextTick()
    expect(v.play).toHaveBeenCalled()
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    expect(sendLocalState).not.toHaveBeenCalled()
  })
})

// The marker is the whole mechanism now that no wall clock gates anything, so
// its lifetime is load-bearing rather than an implementation detail (#239).
describe('useSyncplayClient — applied-seek marker lifetime (#239)', () => {
  it('survives a mismatching seeked and still catches the real echo', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // Some other seeked arrives first — the user scrubbing while the applied
    // seek is still in flight on a slow stream.
    vi.advanceTimersByTime(2000)
    v.currentTime = 900
    client.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledTimes(1)

    // Consuming the marker on that mismatch is what let the real echo escape
    // and re-armed #224's self-seek loop.
    v.currentTime = 300
    client.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledTimes(1)
  })

  it('expires the marker, so a genuine seek back to the applied position sends', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // Past APPLIED_SEEK_TTL_MS (15 s). Without this case the constant is
    // unpinned upward and 15 s → 15 min would be a silent no-op that swallows
    // any later user seek landing on a position the room once published.
    vi.advanceTimersByTime(15001)
    v.currentTime = 300
    client.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 300, cause: 'seek' })
  })

  it('keeps the marker armed just under the TTL', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // Pins the TTL from below: the transcode respawn path waits up to 15 s for
    // buffer-ahead before the seek lands, so anything shorter leaks that echo.
    vi.advanceTimersByTime(14999)
    v.currentTime = 300
    client.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })
})

// Step 1 of #239: the app's own currentTime writes must never reach the wire.
// The PlayerView call sites are unreachable from a unit test (nothing mounts
// PlayerView, and selectQuality / selectTranslation are unexported `<script
// setup>` internals), so the contract is pinned here at the composable seam —
// which is also why the "only register a write that will move the element" rule
// is enforced inside beginProgrammaticSeek instead of at each call site: a guard
// spelled out in PlayerView.vue could not be regression-tested at all.
describe('useSyncplayClient — beginProgrammaticSeek (#239, #306 Phase B)', () => {
  it('swallows the seeked of a write that landed where it was told', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(420)
    v.currentTime = 420
    s.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  it('swallows it even when the element clamped the write somewhere else', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    // The three savedTime restores write to an element at readyState 0 with an
    // empty `seekable`: the value becomes the default playback start position
    // and is clamped into range once metadata arrives. A shorter alt-translation
    // release therefore fires its seeked far from what we asked for — which is
    // why these marks are value-agnostic.
    s.beginProgrammaticSeek(1400)
    v.currentTime = 12
    s.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  it('consumes exactly one seeked — the next real user seek still sends', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(420)
    v.currentTime = 420
    s.onVideoSeeked()

    v.currentTime = 900
    s.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  it('lets the mark expire rather than latching forever when no seeked fires', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    // A real write — the element is at 0 and we ask for 420, so this arms —
    // whose `seeked` never arrives (the load was aborted first). The TTL is the
    // only thing that frees the mark then.
    s.beginProgrammaticSeek(420)
    vi.advanceTimersByTime(15001)
    v.currentTime = 900
    s.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // Regression, and the reason the "will this actually move the element?" rule
  // lives inside beginProgrammaticSeek rather than at the call sites.
  //
  // `goToEpisode` writes `currentTime = 0` in a nextTick that runs *after* the
  // `src` rebind, so the element has already reloaded: `readyState 0`, playhead
  // 0. Per the HTML media element spec that write only sets the default
  // playback start position, which fires no `seeked` then and — being zero — is
  // not seeked to on `loadedmetadata` either. Arming there gave the mark no
  // event to consume it, so it latched for the full 15 s TTL and ate the user's
  // next real seek: next episode → OP → Skip OP within 15 s went nowhere, which
  // is #239's own defect at a new site.
  //
  // `readyState: 0` is passed explicitly and the *near* assertion is the point
  // (#258). `fakeVideo` defaults to `readyState: 1`, and once the same-value
  // path forks on `readyState` an implicit fixture would take the post-metadata
  // branch instead — arming a value-keyed mark at 0 and never executing the
  // early return this test exists to pin. The far-value Skip OP assertion alone
  // cannot see that: 90 is outside APPLIED_SEEK_EPSILON either way, so the test
  // would have stayed green while guarding nothing. The `~0.2` seek is inside
  // the epsilon, so it sends here and is swallowed in the `readyState: 1`
  // mirror below — that pair is the behaviour difference.
  it('arms nothing for a rewind to 0 on an element already at 0, so Skip OP still sends', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(0)

    // The load completes before the user can seek anything — which is what the
    // narrative above already describes ("a few seconds into the new episode"),
    // and what #284's readiness gate now requires the fixture to spell out: an
    // element still at HAVE_NOTHING sends nothing at all, so leaving it there
    // would make both assertions below pass or fail for the gate's reason
    // instead of the mark's. The mark is still taken at `readyState 0`, which is
    // the half this test pins.
    ;(v as { readyState: number }).readyState = 1

    // Nothing armed at all: even a seek landing *within* APPLIED_SEEK_EPSILON of
    // the write goes out, which a value-keyed mark at 0 would have swallowed.
    vi.advanceTimersByTime(1000)
    v.currentTime = 0.2
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 0.2, cause: 'seek' })

    // Well inside the TTL: the user hits Skip OP a few seconds into the new
    // episode.
    sendLocalState.mockClear()
    vi.advanceTimersByTime(4000)
    v.currentTime = 90
    s.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 90, cause: 'seek' })
  })

  // The mirror of the case above, and the behaviour #258 adds. Post-metadata the
  // HTML seek algorithm has no same-position early-out, so the same write really
  // does queue `seeking`/`seeked` — leaving it unmarked would send that echo out
  // as intent at the position we are already at, and `forcePositionUpdate` would
  // push it to every watcher.
  it('arms a value-keyed mark for the same write once metadata has arrived (#258)', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(0)

    vi.advanceTimersByTime(1000)
    v.currentTime = 0.2
    s.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // The spec-compliant engine: the `seeked` arrives at the position asked for,
  // the mark is consumed, and the slot is free again for the user's next seek.
  it('consumes the post-metadata same-value echo at the target and clears the slot (#258)', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 420,
      paused: true,
      readyState: 2
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(420)
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    // Consumed, not latched — the very next real seek is the user's.
    v.currentTime = 900
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // Same engine, an echo that lands just off the target — still inside
  // APPLIED_SEEK_EPSILON (0.5 s), which is what makes value-keying viable here
  // rather than exact-match.
  it('consumes a post-metadata same-value echo that lands within the epsilon (#258)', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 420,
      paused: true,
      readyState: 2
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(420)
    v.currentTime = 420.4
    s.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // The short-circuiting engine — one that silently drops a same-value seek and
  // fires nothing — is the whole reason the mark is value-keyed rather than
  // value-agnostic. Nothing consumes it, so it latches for the full TTL, but a
  // keyed mark can only ever swallow a seek near the position we already hold:
  // the user's real seek elsewhere on the timeline still reaches the room.
  it('keyed mark does not swallow a far user seek when no echo ever arrives (#258)', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 420,
      paused: true,
      readyState: 2
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    // No `seeked` follows — the engine short-circuited the write.
    s.beginProgrammaticSeek(420)

    vi.advanceTimersByTime(3000)
    v.currentTime = 900
    s.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // The honest cost of that latch, pinned so "nearly a no-op for the user" stays
  // an accurate claim rather than an unmeasured one. A value mismatch does not
  // clear the mark (deliberate — #224), so the short-circuited mark survives the
  // far seek above and keeps swallowing seeks within APPLIED_SEEK_EPSILON of the
  // target for the rest of the 15 s TTL.
  it('keyed mark still swallows a near seek for the rest of the TTL (#258)', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 420,
      paused: true,
      readyState: 2
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(420)

    vi.advanceTimersByTime(3000)
    v.currentTime = 900
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledTimes(1)

    // Still armed: a seek back to within 0.5 s of the target is swallowed.
    sendLocalState.mockClear()
    vi.advanceTimersByTime(3000)
    v.currentTime = 420.3
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    // And the TTL is still the backstop for it.
    vi.advanceTimersByTime(15001)
    v.currentTime = 420.3
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 420.3, cause: 'seek' })
  })

  // The other side of that guard: a rewind on an element that has somewhere to
  // move from is a real seek, and its `seeked` must not reach the room or
  // `forcePositionUpdate` drags every peer back to 0. Dropping the registration
  // altogether would pass the test above and fail this one.
  //
  // Deliberately *not* claiming which real call site this is. The comment here
  // used to name the MSE/remux episode-nav rewind, on the reasoning that
  // `mseSrcUrl` has not been rebound yet — #306 corrected that from source
  // reading (`startMseSession` assigns it synchronously inside the awaited
  // preparation, and the rewind's `nextTick` resolves after the DOM patch), so
  // that rewind almost certainly sits at `readyState 0` with the other four. A
  // fake video with an assumed readiness cannot settle browser ordering either
  // way; what it *can* pin, and all this asserts, is the composable's rule —
  // a write that moves the element registers an operation.
  it('still registers the same rewind when the element has somewhere to move from', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticSeek(0)
    v.currentTime = 0
    s.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // The single-slot residual #258 widened, and the case the registry closes
  // (#306 Phase B). Asserted rather than assumed, because the outcome *flipped*
  // here: this is a behaviour-difference test, red against the single slot and
  // green against the registry.
  //
  // Modelled with an element whose `currentTime` has not yet reached the
  // apply's target when the same-value write runs — the only ordering in which
  // the second operation carries a *different* value, since that branch fires
  // only when `target === v.currentTime` and so normally re-arms the very
  // position the apply's echo will report.
  //
  // What the slot did: the second arming overwrote the apply's mark, the
  // apply's echo then mismatched on value, was deliberately not consumed
  // (#224), and `sendSyncplayLocalState('seek')` put the apply's own position
  // back on the wire for `forcePositionUpdate` to fan out to the room.
  //
  // What the registry does: both operations are registered, so the apply's echo
  // at 300 matches the apply's own `value` operation and is consumed, and the
  // same-value operation at 120 is still there afterwards to guard its own
  // position. Nothing reaches the wire in either step. Two writes in flight no
  // longer cost one leaked position.
  it('does not let a same-value post-metadata write clobber an in-flight apply (#258, #306)', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // The element is still reporting 120 — the apply's seek has not completed.
    vi.advanceTimersByTime(2000)
    v.currentTime = 120
    client.beginProgrammaticSeek(120)

    // The apply's echo finally lands. Under the slot this had nothing left to
    // match and went out as the user's seek; the apply's operation is still
    // registered now, so it is consumed.
    v.currentTime = 300
    client.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    // And the same-value operation is untouched by that consume — exact
    // matching, not a shared slot — so it still guards its own position.
    v.currentTime = 120
    client.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    // Both spent: the next real seek is the user's.
    v.currentTime = 900
    client.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })
})

// applyRemoteState is reachable only through the onSyncplayRemoteState
// subscription — it is not on the returned surface — and the default API stub
// wires that to noopSub, so before this block no test ever delivered a remote
// state and the whole apply rule was uncovered.
describe('useSyncplayClient — applyRemoteState', () => {
  it('seeks when the room says doSeek, however small the drift', async () => {
    const v = fakeVideo({ currentTime: 100, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 101, paused: true, doSeek: true })

    expect(v.currentTime).toBe(101)
  })

  it('seeks on drift over the 3s tolerance and ignores drift under it', async () => {
    const v = fakeVideo({ currentTime: 100, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 102, paused: true, doSeek: false })
    expect(v.currentTime).toBe(100)

    emitRemoteState({ position: 110, paused: true, doSeek: false })
    expect(v.currentTime).toBe(110)
  })

  it('clamps a negative remote position to 0 rather than writing it', async () => {
    const v = fakeVideo({ currentTime: 100, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: -5, paused: true, doSeek: true })

    expect(v.currentTime).toBe(0)
  })

  it('plays and pauses the element to match the room', async () => {
    const v = fakeVideo({ currentTime: 10, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 10, paused: false, doSeek: false })
    expect(v.play).toHaveBeenCalled()

    v.paused = false
    emitRemoteState({ position: 10, paused: true, doSeek: false })
    expect(v.pause).toHaveBeenCalled()
  })

  it('records who paused the room and clears it on resume', async () => {
    const v = fakeVideo({ currentTime: 10, paused: false } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 10, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBe('peer')

    v.paused = true
    emitRemoteState({ position: 10, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBeNull()
  })

  it('toasts a remote seek that names its author', async () => {
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 125, paused: true, doSeek: true, setBy: 'peer' })

    expect(client.syncplayToast.value).toBe('peer seeked to 2:05')
  })

  // (The "keeps the element paused while a peer is not ready" case that used to
  // sit here is gone: it could only ever pass through the `!needsSeek &&
  // !needsPlayPause` early return — position matched and the element was already
  // paused — so it never observed *when* effectivePaused was computed and stayed
  // green on a park-time snapshot. #240 replaces it with the live-roster case in
  // the deferral block below.)

  // The other half of the same fold, and the more interesting one: we are
  // already playing when a peer starts buffering. effectivePaused flips to
  // true, so needsPlayPause becomes true and the room stalls us — this is the
  // only case that reaches the pause arm rather than the early return above.
  it('pauses an already-playing element when a peer goes not ready', async () => {
    const v = fakeVideo({ currentTime: 10, paused: false } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })
    client.syncplayRoomUsers.value = [{ username: 'peer', file: null, isReady: false }]

    emitRemoteState({ position: 10, paused: false, doSeek: false })

    expect(v.pause).toHaveBeenCalled()
    expect(v.play).not.toHaveBeenCalled()
  })
})

// #240. At HAVE_NOTHING a `currentTime` write becomes the *default playback
// start position* — it fires nothing and is re-targeted by whatever writes
// `currentTime` next, which on every episode open is the local resume or an MSE
// land. So the remote position has to be held until the element can honor it,
// and the bookkeeping has to survive that wait.
describe('useSyncplayClient — pre-metadata deferral (#240)', () => {
  it('parks the write below HAVE_METADATA and applies it once on loadedmetadata', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true, setBy: 'peer' })
    expect(v.currentTime).toBe(0)
    expect(client.syncplayToast.value).toBe('')
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()
    expect(v.currentTime).toBe(300)
    expect(client.syncplayToast.value).toBe('peer seeked to 5:00')

    // Once applied, the state is consumed: a second metadata event (a source
    // swap, a reload) must not re-seek us to a position the room has moved on
    // from — and on the MSE path every extra write costs an ffmpeg respawn.
    v.currentTime = 42
    client.onVideoLoadedMetadata()
    expect(v.currentTime).toBe(42)
  })

  // The regression guard against a `loadedmetadata`-only implementation: the
  // common case is joining a room with the element already loaded, where a
  // listener-only apply would never fire at all.
  it('writes synchronously at HAVE_METADATA, without waiting for loadedmetadata', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })

    expect(v.currentTime).toBe(300)
  })

  // #278's rewritten frame meets #240's park, as a **characterisation** (#278
  // review). While a local seek intent is live main substitutes *our* position
  // for the room's, and this path stores that frame and writes it to whatever
  // element exists at metadata time — so a mid-session source swap can land our
  // own position on a fresh element rather than the room's. `seekIntent`'s own
  // retirements (new player, stale gap) cover the ordinary route into that
  // state, and the write itself is benign: it puts a fresh element back where
  // the user actually was.
  //
  // **What was not benign, and what #278's plan got wrong.** The plan argued the
  // "X seeked to …" toast cannot fire for a rewritten frame because it is gated
  // on `needsSeek`, which is false once the position is ours. That holds only
  // while the element is *at* our position. On the park path it is at 0, so the
  // gate opened and the toast named a peer for a move they never made. #278
  // pinned that as a wart on the reasoning that fixing it needs main to tell the
  // renderer the frame was rewritten — a new field on `SyncplayRemoteState`,
  // which #278 rules out. #289 closed it without one: the toast never had to
  // know *whether main rewrote the frame*, only whether **this** apply describes
  // a move rather than a placement, which is answerable in the renderer alone.
  // So the silence below is now the fix's, and the write is still #278's.
  it('parks a rewritten frame and writes our own position at metadata time (#278)', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    // What main emits on a rewritten tick: our position, the room's `setBy` and
    // `paused`, and `doSeek` provably false.
    emitRemoteState({ position: 112, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.currentTime).toBe(0)
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    // Our position lands on the fresh element, not the room's.
    expect(v.currentTime).toBe(112)
    // …and no peer is named for putting it there (#289 flipped this assertion
    // from `'peer seeked to 1:52'`).
    expect(client.syncplayToast.value).toBe('')
  })

  // The second bug of the same class: `if (!v) return` at the top of
  // applyRemoteState dropped the state *and* all its bookkeeping.
  it('parks a state that arrives with no element at all', async () => {
    let el: HTMLVideoElement | null = null
    const { emitRemoteState, client } = await mountWithRemoteState(
      makeDeps({ getVideo: () => el }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 300, paused: true, doSeek: true })

    el = fakeVideo({ currentTime: 0, paused: true, readyState: 1 } as Partial<HTMLVideoElement>)
    client.onVideoLoadedMetadata()

    expect(el.currentTime).toBe(300)
  })

  it('keeps the room bookkeeping when the state arrives with no element', async () => {
    let el: HTMLVideoElement | null = null
    const { emitRemoteState, client } = await mountWithRemoteState(
      makeDeps({ getVideo: () => el }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 0, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBe('peer')

    // …and the ready gate sees the play intent the moment a player appears,
    // rather than acting on a stale one.
    emitRemoteState({ position: 0, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBeNull()

    el = fakeVideo({ currentTime: 0, paused: true, readyState: 1 } as Partial<HTMLVideoElement>)
    client.applySyncplayReadyGate()
    expect(el.play).toHaveBeenCalled()
  })

  it('applies only the freshest parked state, and toasts only for that one', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true, setBy: 'stale' })
    emitRemoteState({ position: 600, paused: true, doSeek: true, setBy: 'fresh' })
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.currentTime).toBe(600)
    expect(client.syncplayToast.value).toBe('fresh seeked to 10:00')
  })

  // effectivePaused reads the *live* roster, so it belongs to the write and not
  // to the park: a peer that went not-ready during the wait would otherwise be
  // resumed over.
  it('computes effectivePaused at apply time, not at park time', async () => {
    const v = fakeVideo({
      currentTime: 10,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })
    client.syncplayRoomUsers.value = [{ username: 'peer', file: null, isReady: true }]

    emitRemoteState({ position: 10, paused: false, doSeek: false })

    client.syncplayRoomUsers.value = [{ username: 'peer', file: null, isReady: false }]
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.play).not.toHaveBeenCalled()
  })

  // The deferred write fires arbitrarily far after the state arrived, so the
  // applied-seek marker is the only thing standing between it and the wire —
  // and it has to be armed at the write, not at the park.
  it('does not let the deferred write escape as a local seek', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })

    // Metadata arrives long after the state did — and after the marker's
    // own 15 s TTL, which is what makes this fail on an implementation that arms
    // the marker at park time: that mark would already be stale when the write
    // finally happens, and the echo escapes as the user's seek.
    vi.advanceTimersByTime(20000)
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()
    expect(v.currentTime).toBe(300)

    client.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // #226's no-clamp decision, pinned. The room's position is the `min()` over
  // watchers on the reference server and is re-broadcast every second, so
  // reporting a frontier-shortened position is an unsignalled room seek that
  // drags every peer back — at 1 Hz, through the snapshot heartbeat.
  //
  // Coverage caveats, twice over. (a) `fakeVideo.currentTime` clamps to
  // `[0, duration]` (#281), so what the element does with a write inside the
  // file *is* modelled — but the `duration` it clamps against is the finished
  // container's, which is the whole point of this case: a growing `.part`
  // reports the full duration in its header, so 2400 is inside the file even
  // with ~2 minutes on disk. That the element does not clamp to the *download
  // frontier* rests on the `seekable` span the protocol handler advertises (full
  // `totalBytes` denominator + tail stream), and is covered by manual scenario
  // (a) alone — the fake has no frontier of its own to clamp to.
  // (b) What it pins is a clamp applied *inside* `applyRemoteStateToElement`. It
  // is not a proof against every reintroduction: bringing the clamp back the way
  // #240 originally specified — an optional `clampSeekTarget` on `SyncplayDeps` —
  // leaves `makeDeps` free to default it to `(t) => t`, and this test then passes
  // unchanged. Adding that hook means adding a test that exercises it with a real
  // frontier clamp.
  it('writes a position past the download frontier unclamped, and reports it', async () => {
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    // A `.part` with ~2 minutes on disk; the room is 40 minutes in. `duration`
    // is the **finished** file's (45 minutes), because that is what the
    // container header of a growing `.part` already reports — the helper's 1440
    // default described a 24-minute episode and contradicted this scenario's own
    // comment, which made the case read as an out-of-file position rather than
    // the past-the-frontier one it is about (#281).
    const v = fakeVideo({
      currentTime: 0,
      duration: 2700,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 2400, paused: true, doSeek: true })
    expect(v.currentTime).toBe(2400)

    client.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 2400, paused: true })

    client.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()
  })

  it('drops a parked state when the episode changes under it', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const deps = makeDeps({ video: v })
    const { emitRemoteState, client } = await mountWithRemoteState(deps, { state: 'ready' })

    emitRemoteState({ position: 300, paused: true, doSeek: true })

    deps.activeEpisodeIndex.value = 1
    await flushPromises()
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.currentTime).toBe(0)
  })

  it('drops a parked state on disconnect', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })

    client.syncplayStatus.value = { state: 'disconnected' }
    await flushPromises()
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.currentTime).toBe(0)
  })

  // Splitting the halves let them disagree: the bookkeeping ran at park time,
  // a local play during the wait overwrote it, and the deferred apply then
  // paused the element while `syncplayLastRemotePlaying` still said "playing" —
  // so the next ready-gate pass played it straight back, with `pausedBy` naming
  // nobody. Re-asserting the bookkeeping at write time is what keeps the two
  // consistent; `main` never had the gap because the halves were one function.
  it('re-asserts the room bookkeeping when a local play beat the parked state', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 0, paused: true, doSeek: false, setBy: 'peer' })

    // The user hits play before metadata arrives.
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()
    expect(client.syncplayPausedBy.value).toBeNull()
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    // The parked state pauses the element…
    expect(v.pause).toHaveBeenCalled()
    ;(v as { paused: boolean }).paused = true
    // …and the room bookkeeping agrees with it, so the gate leaves it paused
    // and the popover names the peer that paused rather than nobody.
    expect(client.syncplayPausedBy.value).toBe('peer')
    client.applySyncplayReadyGate()
    expect(v.play).not.toHaveBeenCalled()
  })
})

// #289. The seek toast reads `needsSeek`, which answers "does the element have
// to move" — not "did a peer move". Those come apart on every *placement*: an
// apply that puts a fresh or freshly-rebound element where the room already was.
// `diff` is then the room's whole position, `needsSeek` is true for any room
// past 3 s, and the toast names a peer for a move nobody performed.
//
// Two placement shapes, and neither predicate sees both. `deferred` catches the
// park (#240), including the mid-session source swap where `remoteStateApplied`
// is still set. `firstApply` catches the join with the file already loaded,
// which takes the immediate path and so is not deferred at all. Hence the
// disjunction. `state.doSeek` re-admits the toast on both, because a `doSeek`
// frame is the server relaying a peer's actual seek — a real event even if we
// happened to be loading when it landed. The writes are untouched throughout:
// this is a fix to what we *say*, not to what we do.
describe('useSyncplayClient — placement is not a peer’s move (#289)', () => {
  it('writes a parked position without naming a peer for it', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    // The room simply *is* at 112 while our element loads. `doSeek: false`:
    // nobody seeked, this is the 1 Hz state.
    emitRemoteState({ position: 112, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.currentTime).toBe(0)
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    // The write is load-bearing and stays — it puts us where the room is…
    expect(v.currentTime).toBe(112)
    // …and on `main` it came with `'peer seeked to 1:52'`.
    expect(client.syncplayToast.value).toBe('')
  })

  it('does not name a peer for the first placement on an already-loaded element', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    // Joining a room mid-episode with the file already loaded: nothing parks,
    // the immediate path runs, and the element is still at 0. `deferred` is
    // false here, so `firstApply` is the only thing standing between this and
    // the same invented attribution.
    emitRemoteState({ position: 112, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.currentTime).toBe(112)
    expect(client.syncplayToast.value).toBe('')
  })

  it('names the peer on the *next* move after the placement', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 112, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe('')

    // The room has placed this element once, so it is no longer arriving — it is
    // being moved. Anti-vacuity for the `firstApply` arm: a suppression that
    // latched for the session would kill the feature and still pass above.
    emitRemoteState({ position: 400, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.currentTime).toBe(400)
    expect(client.syncplayToast.value).toBe('peer seeked to 6:40')
  })

  // The case that pins the disjunction rather than `firstApply` alone.
  // `remoteStateApplied` is not per-element: `resetRemoteStateTracking()` is its
  // only writer back to false, and `selectQuality()` in PlayerView rebinds the
  // stream URL on the *same* element without touching `activeEpisodeIndex` or
  // `activeTranslationId` — so the element drops to `readyState 0` with the flag
  // still true. A placement predicate built on `firstApply` alone reads this as
  // an ordinary mid-session apply and toasts; `deferred` is what sees it.
  it('does not name a peer after a mid-session source swap on the same element', async () => {
    const v = fakeVideo({
      currentTime: 40,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const deps = makeDeps({ video: v })
    const { emitRemoteState, client } = await mountWithRemoteState(deps, { state: 'ready' })

    // The room places us once, normally. This is what sets `remoteStateApplied`.
    emitRemoteState({ position: 40, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe('')
    expect(client.hasRemoteStateApplied()).toBe(true)

    // A quality switch: same <video>, new source, back to HAVE_NOTHING at 0.
    // Deliberately no episode or translation change — that is the whole point,
    // since the watch that resets the flag never fires.
    ;(v as { readyState: number }).readyState = 0
    v.currentTime = 0
    expect(deps.activeEpisodeIndex.value).toBe(0)
    expect(deps.activeTranslationId.value).toBe(1)

    emitRemoteState({ position: 112, paused: true, doSeek: false, setBy: 'peer' })
    expect(v.currentTime).toBe(0)
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.currentTime).toBe(112)
    expect(client.syncplayToast.value).toBe('')
  })

  // The third placement shape, and the one the element half cannot see at all:
  // the element is untouched across it — still loaded, still at the user's real
  // position — and only the *socket* changed. `resetRemoteStateTracking({
  // keepRefusalNotice: true })` runs on `reconnecting` and clears
  // `remoteStateApplied`, so the first state after the socket returns is a
  // `firstApply` and is silent. That is the rule being per-socket rather than
  // per-element, and it is deliberate: across the gap we cannot tell "a peer
  // scrubbed" from "the room simply played on while we were down", and main's
  // `doSeek` is one-shot — the next heartbeat re-sends the position with
  // `doSeek: false` — so a peer's scrub during the outage really does reach us
  // as a plain frame. Naming a peer for the far more common second case is the
  // same class of lie #289 removes. On `main` this frame says
  // `peer seeked to 15:00`.
  it('does not name a peer for the first placement after a reconnect', async () => {
    const v = fakeVideo({
      currentTime: 500,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    // An ordinary in-sync apply first: this is what arms `remoteStateApplied`,
    // so the reset on `reconnecting` below has something to clear.
    emitRemoteState({ position: 500, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.hasRemoteStateApplied()).toBe(true)
    expect(client.syncplayToast.value).toBe('')

    client.syncplayStatus.value = { state: 'reconnecting' }
    await flushPromises()
    expect(client.hasRemoteStateApplied()).toBe(false)
    client.syncplayStatus.value = { state: 'ready' }
    await flushPromises()
    // The reconnect notice itself is not what this case is about; drop it so the
    // assertion below reads only what the apply said.
    client.syncplayToast.value = ''

    // The room moved on while we were down. The element never left
    // HAVE_METADATA and is still exactly where the user left it.
    expect(v.readyState).toBe(1)
    expect(v.currentTime).toBe(500)
    emitRemoteState({ position: 900, paused: true, doSeek: false, setBy: 'peer' })

    // The write still happens — we follow the room…
    expect(v.currentTime).toBe(900)
    // …and nobody is named for a 400 s gap we cannot attribute.
    expect(client.syncplayToast.value).toBe('')

    // Anti-vacuity, and the cost of the rule stated exactly: one *applying*
    // frame. The socket has now placed us once, so the peer's next real move
    // speaks.
    emitRemoteState({ position: 1200, paused: true, doSeek: false, setBy: 'peer' })
    expect(v.currentTime).toBe(1200)
    expect(client.syncplayToast.value).toBe('peer seeked to 20:00')
  })

  // #292 review: "one frame" is one *applying* frame, and the two differ on a
  // reachable shape. `remoteStateApplied` is armed on the `!outOfFile` branch
  // only, so frames naming a position past our duration arm nothing and
  // `firstApply` survives them — the silence then spans more than one frame on
  // the wire. The behaviour is still right (an out-of-file frame could not have
  // toasted a seek anyway, `needsSeek` being false under `outOfFile`), but the
  // count in the comment above is load-bearing enough to pin.
  it('counts applying frames, not wire frames, when the room is past our end', async () => {
    const v = fakeVideo({
      currentTime: 500,
      paused: true,
      readyState: 1,
      duration: 1440
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 500, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.hasRemoteStateApplied()).toBe(true)

    client.syncplayStatus.value = { state: 'reconnecting' }
    await flushPromises()
    client.syncplayStatus.value = { state: 'ready' }
    await flushPromises()
    client.syncplayToast.value = ''

    // Frame one: out of file. Refused, so the write does not happen and the
    // toast it raises is the refusal, not an attribution. (That this frame arms
    // nothing is pinned by #281's "does not count a refused state as the room
    // having told us where it is" — asserted there, not restated here, so the
    // toast claim below is what carries this case.)
    emitRemoteState({ position: 3000, paused: true, doSeek: false, setBy: 'peer' })
    expect(v.currentTime).toBe(500)
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)
    client.syncplayToast.value = ''

    // Frame two: back inside the file. This is the socket's first *placement*,
    // so it is still the silent one — two wire frames after the reconnect.
    emitRemoteState({ position: 900, paused: true, doSeek: false, setBy: 'peer' })
    expect(v.currentTime).toBe(900)
    expect(client.syncplayToast.value).toBe('')

    // And the frame after it speaks, so the silence is still bounded.
    emitRemoteState({ position: 1200, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe('peer seeked to 20:00')
  })

  // The discriminating anti-vacuity case. The obvious one — a live element at
  // HAVE_METADATA taking a `doSeek: true` frame — survives *every* candidate
  // guard, including a blanket suppression of the deferred path, so it proves
  // nothing. A **deferred** `doSeek: true` is the one that separates them: it is
  // a placement by position and a peer's real move by provenance, and only the
  // `state.doSeek` disjunct keeps it speaking.
  it('still names the peer for a genuine seek that arrives while we load', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe('')
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.currentTime).toBe(300)
    expect(client.syncplayToast.value).toBe('peer seeked to 5:00')
  })

  // `state.setBy &&` is still the first term, and the new one must not have
  // become the only guard: #277's mirror-sourced emits carry no author, and an
  // unattributed frame has nobody to name on either path.
  it('stays silent for an unattributed frame on both paths', async () => {
    const parked = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const deferred = await mountWithRemoteState(makeDeps({ video: parked }), { state: 'ready' })
    deferred.emitRemoteState({ position: 300, paused: true, doSeek: true, setBy: null })
    ;(parked as { readyState: number }).readyState = 1
    deferred.client.onVideoLoadedMetadata()
    expect(parked.currentTime).toBe(300)
    expect(deferred.client.syncplayToast.value).toBe('')

    const live = fakeVideo({
      currentTime: 600,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const immediate = await mountWithRemoteState(makeDeps({ video: live }), { state: 'ready' })
    immediate.emitRemoteState({ position: 300, paused: true, doSeek: true, setBy: null })
    immediate.emitRemoteState({ position: 900, paused: true, doSeek: true, setBy: null })
    expect(live.currentTime).toBe(900)
    expect(immediate.client.syncplayToast.value).toBe('')
  })
})

// The predicate PlayerView's resumeFromSavedPosition reads. Its *reset* is the
// load-bearing half: main stops emitting `remote-state` the moment we are alone
// in a room, so a session-scoped latch would eat the user's saved position on
// every later episode open, forever.
describe('useSyncplayClient — hasRemoteStateApplied (#240)', () => {
  it('is false before any remote state arrives', async () => {
    const { client } = await mountWithRemoteState(makeDeps({ video: fakeVideo() }), {
      state: 'ready'
    })

    expect(client.hasRemoteStateApplied()).toBe(false)
  })

  it('is true while a state is parked, before anything has been written', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })

    expect(v.currentTime).toBe(0)
    expect(client.hasRemoteStateApplied()).toBe(true)
  })

  // A state whose position and play state already match ours still reaches the
  // element half and still means "the room has told us where it is" — resuming
  // to the saved position on top of it would drag the room.
  it('is true after a state that needed no write at all', async () => {
    const v = fakeVideo({
      currentTime: 10,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 10, paused: true, doSeek: false })

    expect(client.hasRemoteStateApplied()).toBe(true)
  })

  it('does not latch across an episode switch', async () => {
    const deps = makeDeps({ video: fakeVideo() })
    const { emitRemoteState, client } = await mountWithRemoteState(deps, { state: 'ready' })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    expect(client.hasRemoteStateApplied()).toBe(true)

    deps.activeEpisodeIndex.value = 1
    await flushPromises()

    expect(client.hasRemoteStateApplied()).toBe(false)
  })

  it('does not latch across a disconnect', async () => {
    const { emitRemoteState, client } = await mountWithRemoteState(
      makeDeps({ video: fakeVideo() }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    expect(client.hasRemoteStateApplied()).toBe(true)

    client.syncplayStatus.value = { state: 'disconnected' }
    await flushPromises()

    expect(client.hasRemoteStateApplied()).toBe(false)
  })

  // `reconnecting` is neither an episode switch nor a disconnect, but it has the
  // same shape: main stops emitting `remote-state` while we are out of the room
  // and we may come back to it alone. Leaving the flag armed biases toward
  // suppressing the resume — safe in the moment, but it is exactly the latch the
  // reset exists to prevent, and `docs/syncplay.md` claims it unlatches here.
  it('does not latch across a reconnect', async () => {
    const { emitRemoteState, client } = await mountWithRemoteState(
      makeDeps({ video: fakeVideo() }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    expect(client.hasRemoteStateApplied()).toBe(true)

    client.syncplayStatus.value = { state: 'reconnecting' }
    await flushPromises()

    expect(client.hasRemoteStateApplied()).toBe(false)
  })
})

// #281. Peers in a room need not hold the same file — a different release, a
// re-encode, a different cut — so the room's single shared position can land
// past the end of *ours*. Following it parks the playhead on the final frame
// (Chromium clamps the seek to the seekable end, which is why a clamp of our
// own is a measured no-op), spawns an `-ss` at the duration, reaches `ended`
// and auto-advances us to the next episode — while the toast announces a seek
// to a timestamp that does not exist in our file. The rule is to refuse the
// position, not to clamp it: `docs/syncplay.md`'s "Apply Rule" forbids clamping
// what the *room* initiates, because a shortened position we report back is an
// unsignalled room seek repeated at 1 Hz.
const OUT_OF_FILE_TOAST = "Can't follow — the room is past the end of your file"

describe('useSyncplayClient — a room position past the end of our file (#281)', () => {
  // The immediate apply. On `main` the raw write is 3000, the element clamps it
  // to `duration` and we sit on the last frame of a 24-minute episode.
  it('refuses a position past our duration instead of parking on the last frame', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: true, setBy: 'peer' })

    // The symptom first, and it is the assertion the clamping setter exists for:
    // on `main` the element lands on `duration` — the last frame — which is what
    // spawns the `-ss` at the end, reaches `ended` and auto-advances. Against a
    // plain `currentTime` property the read-back would be a harmless-looking
    // 3000 and this would pass while the bug was fully present.
    expect(v.currentTime).not.toBe(1440)
    expect(v.currentTime).toBe(0)
    // Not merely clamped-and-discarded: nothing was written at all, so the
    // echo-guard arming never fires either.
    expect(rawCurrentTimeWrites.get(v as unknown as object)).toEqual([])
  })

  // The primary case, not an extra: joining a room already parked past our end
  // is the shape that reaches the deferral at all, because the element is at
  // HAVE_NOTHING while the room's 1 Hz state is already arriving. The unpark
  // path runs the identical function, so it carried the identical bug.
  it('refuses it on the unpark path too, not just the immediate one', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: true, setBy: 'peer' })
    expect(v.currentTime).toBe(0)
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.currentTime).toBe(0)
    expect(rawCurrentTimeWrites.get(v as unknown as object)).toEqual([])
    expect(client.hasRemoteStateApplied()).toBe(false)
  })

  // The phantom toast: `"peer seeked to 50:00"` on a 24-minute episode. It goes
  // away by construction, because the toast keys off the same `needsSeek` the
  // refusal folds into — and the refusal takes its place rather than sitting
  // beside it.
  it('replaces the phantom seek toast with the refusal', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: true, setBy: 'peer' })

    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)
    expect(client.syncplayToast.value).not.toMatch(/seeked to/)
  })

  // Q2. `roomOwnsPlayhead()` reads this to cancel the user's saved-position
  // resume, and the rule it encodes is "something is going to move the playhead
  // to the room's position". A refusal is the statement that nothing will, so
  // the saved position has to win — otherwise, composed with #275's spawn
  // bound, the user sits at 0 with no resume for the whole episode.
  it('does not count a refused state as the room having told us where it is', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: true })

    expect(client.hasRemoteStateApplied()).toBe(false)
  })

  // …and it stays a latch: an earlier in-range state that set the flag is not
  // un-set by a later refusal. The flag means "the room has told us where it
  // is", and it has.
  it('leaves an earlier in-range apply latched', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 600, paused: true, doSeek: true })
    expect(client.hasRemoteStateApplied()).toBe(true)

    emitRemoteState({ position: 3000, paused: true, doSeek: true })
    expect(client.hasRemoteStateApplied()).toBe(true)
  })

  // The control: the refusal must be the loosest rule that fixes the bug, so an
  // ordinary in-file position is untouched.
  it('still follows a legitimate in-file position', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 600, paused: true, doSeek: true, setBy: 'peer' })

    expect(v.currentTime).toBe(600)
    expect(client.syncplayToast.value).toBe('peer seeked to 10:00')
  })

  // Q5's independence: the refusal is folded into `needsSeek`, and
  // `needsPlayPause` is computed separately — so a room that pauses while its
  // position is out of our file still pauses us. Refusing to go somewhere is
  // not refusing to stop.
  it('still honors a room pause carried on an out-of-file state', async () => {
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: true, setBy: 'peer' })

    expect(v.pause).toHaveBeenCalled()
    expect(v.currentTime).toBe(300)
  })

  // Fail-open, matching #275's renderer copy. A moov-at-end MP4 reports
  // `NaN`/`Infinity` for `duration` until it is complete; refusing on a duration
  // we do not have would refuse every legitimate position on such a file.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['0', 0]
  ])('follows the room when duration is %s (fail-open)', async (_label, duration) => {
    const v = fakeVideo({
      currentTime: 0,
      duration,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: true })

    expect(v.currentTime).toBe(3000)
  })

  // The boundary. `>= duration` exactly: unlike #275, whose quantity has already
  // had the 1 s pre-roll subtracted, `state.position` is the room's position raw
  // and there is no window to accept.
  it('refuses exactly at the duration and follows just below it', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 1439.9, paused: true, doSeek: true })
    expect(v.currentTime).toBe(1439.9)

    v.currentTime = 0
    emitRemoteState({ position: 1440, paused: true, doSeek: true })
    expect(v.currentTime).toBe(0)
  })
})

// #281 slice B, the renderer half. Main de-adopts for the length of the
// divergence, so `sendLocalState()` returns at its adoption gate — no
// assertion, not even an ignore-counter bump — and a local pause can no longer
// reach the room. The room's next 1 Hz *playing* state would then resume the
// user, on a `needsPlayPause` that is deliberately independent of `outOfFile`.
// We cannot tell the room anything, so it must not be able to override us
// either: honour a room pause, refuse a room resume that would override a local
// user pause.
//
// Clearing the flag makes it worse before it makes it better, which is the
// second half of this block: the projection goes false, so `onLocalPause()`'s
// old arming condition (`playbackAdopted !== true`) is true for the whole
// divergence, and the hold's normal terminator — `roomPaused` going
// `false → true` — can never fire for a peer the room cannot hear. It would run
// the full 8 s and expire into "your pause didn't stick" before the next
// playing state resumed the user anyway. So the hold does not arm, and
// `outOfFileUserPause` stands in for it.
describe('useSyncplayClient — a user pause while the room is out of our file (#281 slice B)', () => {
  const PENDING_PAUSE_TOAST = 'Pausing once synced with the room…'
  const PENDING_PAUSE_FAILED_TOAST = "The room kept playing — your pause didn't stick"

  /** Main's projection during the divergence: de-adopted, and out of file. */
  const DIVERGED: SyncplayStatus = {
    state: 'ready',
    username: 'me',
    playbackAdopted: false,
    outOfFile: true
  }

  const pausedByUser = (v: HTMLVideoElement, client: Client): void => {
    // The element really does stop; the composable's own pause path then runs
    // against it, exactly as the `pause` event would drive it.
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()
  }

  it('holds the pause against the room’s next playing state', async () => {
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), DIVERGED)

    pausedByUser(v, client)
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).not.toHaveBeenCalled()
    expect(v.paused).toBe(true)
    // …and it keeps holding, because the room is going to say the same thing
    // once a second for the whole divergence.
    emitRemoteState({ position: 3001, paused: false, doSeek: false, setBy: 'peer' })
    emitRemoteState({ position: 3002, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).not.toHaveBeenCalled()
  })

  it('leaves no pending-pause hold armed behind the divergence', async () => {
    // The hold's arming is only *observable* through what it does after the
    // divergence, which is why this case runs on past it rather than stopping
    // at the refusal: while the refusal is up the apply early-outs before
    // `holding` is even computed, so an armed hold holds nothing and expires
    // silently. What it does do is survive — and then hold the first state that
    // *does* apply in range, and expire into the failure toast on a pause the
    // room could never have been told about. Both halves are asserted below,
    // and both are red if the `outOfFile` conjunct comes out of the arming
    // condition.
    vi.useFakeTimers()
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), DIVERGED)

    pausedByUser(v, client)
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).not.toBe(PENDING_PAUSE_TOAST)
    expect(v.play).not.toHaveBeenCalled()

    // The room comes back into our file, 4 s in — inside the hold's 8 s budget.
    vi.advanceTimersByTime(4000)
    emitRemoteState({ position: 600, paused: false, doSeek: true, setBy: 'peer' })
    expect(v.play).toHaveBeenCalled()
    expect(client.syncplayToast.value).not.toBe(PENDING_PAUSE_TOAST)

    // …and nothing is left to expire.
    vi.advanceTimersByTime(9000)
    expect(client.syncplayToast.value).not.toBe(PENDING_PAUSE_FAILED_TOAST)
  })

  it('refuses the resume through the ready gate as well as through the apply', async () => {
    // `recordRemoteState()` writes `syncplayLastRemotePlaying` above every
    // refusal — deliberately, because its other consumers need the room's truth
    // — so the gate is the apply's twin resume path. Without the marker in
    // `shouldPlay`, a `canplay` or a roster change resumes the pause the apply
    // just declined to.
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), DIVERGED)

    pausedByUser(v, client)
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })
    client.applySyncplayReadyGate()

    expect(v.play).not.toHaveBeenCalled()
  })

  it('still honors a room pause, and lets the user’s own play end the refusal', async () => {
    // The other direction of the same rule: refusing to be moved is not
    // refusing to stop. And the user retains the last word — pressing play
    // clears the marker, so the room owns the transport again.
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), DIVERGED)

    pausedByUser(v, client)
    emitRemoteState({ position: 3000, paused: true, doSeek: false, setBy: 'peer' })
    expect(v.play).not.toHaveBeenCalled()
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()
    ;(v as { paused: boolean }).paused = true
    emitRemoteState({ position: 3001, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).toHaveBeenCalled()
  })

  it('is scoped to the divergence: an ordinary adopted pause is still overridden by the room', async () => {
    // Anti-vacuity, and the "today" behaviour. Same element, same out-of-file
    // room position, same user pause — but main has not de-adopted, so the
    // marker is never set and the resume lands. This is what the case above
    // measures the difference against; without the `outOfFile` conjunct in
    // `onLocalPause()` the two would be indistinguishable.
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me',
      playbackAdopted: true
    })

    pausedByUser(v, client)
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).toHaveBeenCalled()
  })

  it('releases the refusal on the first state that applies in range', async () => {
    // The marker is a receipt for a divergence, not a permanent veto: once the
    // room is back inside our file, ordinary sync owns the transport again —
    // and a survivor would silently refuse the *next* divergence's resume, one
    // the user never paused for.
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), DIVERGED)

    pausedByUser(v, client)
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).not.toHaveBeenCalled()

    emitRemoteState({ position: 600, paused: false, doSeek: true, setBy: 'peer' })
    expect(v.currentTime).toBe(600)
    expect(v.play).toHaveBeenCalled()
  })

  it('does not arm the refusal for a reload-shaped pause taken at readyState 0', async () => {
    // The marker carries the same two guards `armPendingUserPause()` does, and
    // `readyState > 0` is the load-bearing one: `PlayerView.vue` calls
    // `onLocalPause()` straight off the raw `@pause` event, and the media load
    // algorithm resets `readyState` synchronously and delivers the `pause` it
    // queued *after* that reset. Without the guard the marker arms for a pause
    // nobody made, and refuses the resume that follows the load.
    const v = fakeVideo({
      currentTime: 0,
      duration: NaN,
      paused: false,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), DIVERGED)

    // The implicit pause: HAVE_NOTHING, no duration, and no user behind it.
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()

    // The element finishes loading, and the room — still out of our file, since
    // main does not clear `lastRoomState` under a reload — says it is playing.
    ;(v as { readyState: number }).readyState = 1
    ;(v as { duration: number }).duration = 1440
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).toHaveBeenCalled()
  })

  it('does not re-arm the refusal from the teardown pause of an episode switch', async () => {
    // The ordering the guard actually costs us: the switch watcher runs
    // `resetRemoteStateTracking()` synchronously — clearing the marker, exactly
    // as `clearPendingUserPause()` beside it clears the sibling flag — and the
    // teardown `pause` before the `src` swap arrives *after* it. Main's
    // `setFile()` does not clear `lastRoomState`, so the `outOfFile` projection
    // is still true across the swap (the new file's duration against the old
    // room position), and without the guard the marker comes straight back on
    // and refuses the resume for a pause nobody made an episode later.
    //
    // The refusal lands on the room's next playing state rather than on the
    // ready gate: `onLocalPause()` falsifies `syncplayLastRemotePlaying` above
    // everything else, so the teardown pause has already taken the gate's
    // `shouldPlay` out on its own and the gate is not the reachable half of
    // this ordering. `recordRemoteState()` repairs the mirror on the next
    // inbound state, and that is where the marker bites.
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const deps = makeDeps({ video: v })
    const { emitRemoteState, client } = await mountWithRemoteState(deps, DIVERGED)

    // A divergence is already up, and the user paused inside it.
    pausedByUser(v, client)
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).not.toHaveBeenCalled()

    // Next episode, taken during the divergence.
    deps.activeEpisodeIndex.value = 1
    await nextTick()

    // The teardown pause, on an element already back at HAVE_NOTHING.
    ;(v as { readyState: number }).readyState = 0
    ;(v as { duration: number }).duration = NaN
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()

    // The new episode loads, and the room says the same thing it has been
    // saying at 1 Hz all along — still past the end of this file too.
    ;(v as { readyState: number }).readyState = 1
    ;(v as { duration: number }).duration = 1440
    emitRemoteState({ position: 3100, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).toHaveBeenCalled()
  })

  it('arms the refusal for a pause taken while the socket is reconnecting', async () => {
    // The reconnect window is the one place the marker's guards must *not*
    // follow the hold's: `armPendingUserPause()` wants `state === 'ready'`
    // because a hold that cannot reach the room expires into a failure toast,
    // but the marker's whole job is to survive a socket drop —
    // `resetRemoteStateTracking({ keepRefusalNotice: true })` on the
    // `reconnecting` branch exists to carry one *through*, and nothing could
    // arm one inside the window if the marker took the state guard too.
    //
    // Main keeps it armable there: `resetTransportState()` touches neither
    // `lastRoomState` nor `playbackAdopted` nor `roomUsers`, so the `outOfFile`
    // projection is still true on the status that goes out with
    // `state: 'reconnecting'` — same room, same file, same divergence.
    const v = fakeVideo({
      currentTime: 300,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), DIVERGED)

    // The socket drops mid-divergence, and the user pauses while it is down.
    client.syncplayStatus.value = {
      state: 'reconnecting',
      username: 'me',
      playbackAdopted: false,
      outOfFile: true
    }
    pausedByUser(v, client)

    // Back on the socket, still past the end of our file, and the room resumes
    // its 1 Hz playing states.
    client.syncplayStatus.value = DIVERGED
    emitRemoteState({ position: 3000, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).not.toHaveBeenCalled()
    expect(v.paused).toBe(true)
  })
})

// `showSyncplayToast` is not a debounce — it assigns the single toast slot and
// *re-arms* its 3500 ms clear timer on every call. So a refusal emitted per
// inbound state at 1 Hz would never expire, and last-writer-wins would swallow
// every other syncplay toast for the whole divergence: the pending-pause pair,
// the reconnect notice and all `room-event` text. The refusal is therefore
// emitted on the transition *into* the refusal only.
describe('useSyncplayClient — the refusal toast fires on the transition only (#281)', () => {
  it('emits once across a 1 Hz stream of refused states', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)

    // Four more seconds of the room's periodic. Under a re-armed timer the
    // message would still be on screen at the end of this; under a
    // transition-only emit it expires on schedule and stays gone.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1000)
      emitRemoteState({ position: 3000 + i, paused: true, doSeek: false })
    }
    expect(client.syncplayToast.value).toBe('')

    vi.advanceTimersByTime(4000)
    emitRemoteState({ position: 3010, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe('')
  })

  it('does not swallow the reconnect notice that follows it', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)

    client.syncplayStatus.value = { state: 'reconnecting' }
    await flushPromises()
    expect(client.syncplayToast.value).toBe('Reconnecting to Syncplay server…')

    // The room is still out of our file when the states resume. The reconnect
    // notice must survive them — this is the assertion that fails if the flag
    // is cleared in `resetRemoteStateTracking()`, which the reconnect path runs.
    client.syncplayStatus.value = { state: 'ready' }
    await flushPromises()
    emitRemoteState({ position: 3001, paused: true, doSeek: false })
    emitRemoteState({ position: 3002, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe('Reconnecting to Syncplay server…')
  })

  it('does not swallow a room event that follows it', async () => {
    let emitRoomEvent: ((e: SyncplayRoomEvent) => void) | null = null
    setApi({
      onSyncplayRoomEvent: (fn: (e: SyncplayRoomEvent) => void) => {
        emitRoomEvent = fn
        return () => {}
      }
    })
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)
    ;(emitRoomEvent as unknown as (e: SyncplayRoomEvent) => void)({
      level: 'info',
      text: 'peer joined'
    })
    expect(client.syncplayToast.value).toBe('peer joined')

    emitRemoteState({ position: 3001, paused: true, doSeek: false })
    emitRemoteState({ position: 3002, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe('peer joined')
  })

  // The flag is cleared where `remoteStateApplied` becomes conditional — on a
  // state that applies in range — so a room that leaves our file, comes back and
  // leaves again is announced both times. This is the convergence direction Q2
  // relies on, seen from the toast.
  it('re-arms once a state has applied in range again', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)

    emitRemoteState({ position: 600, paused: true, doSeek: true })
    expect(v.currentTime).toBe(600)

    client.syncplayToast.value = ''
    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)
  })

  // The regression the refusal shipped with, and the reason the emit is gated on
  // the seek rather than on `outOfFile` alone. `state.position >= v.duration` is
  // *also* true at the ordinary end of an episode where every peer holds the
  // same file: main emits `position + serverRtt / 2` for a playing room
  // (`src/main/syncplay.ts:1636`), so the last state or two before our own end
  // already read past `duration`. Nothing is refused that the user can see — the
  // room is well inside the 3 s tolerance, so no seek was suppressed — and the
  // message would land in the middle of the 5 s next-episode countdown, on every
  // episode of a room that is working perfectly.
  it('stays silent at the natural end of a playing episode', async () => {
    const v = fakeVideo({
      currentTime: 1439.6,
      duration: 1440,
      paused: false,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 1440.05, paused: false, doSeek: false })

    expect(client.syncplayToast.value).toBe('')
  })

  // …and the `ended` side of the same moment: once we are `ended` the room's
  // min() over its watchers sits at exactly `duration`, which `>=` catches too.
  it('stays silent once our own element has ended', async () => {
    const v = fakeVideo({
      currentTime: 1440,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    // A periodic, not a seek: main's heartbeat sends `doSeek: false`
    // (`syncplay.ts:2199`), and only a genuine room seek sets the bit.
    emitRemoteState({ position: 1440.2, paused: true, doSeek: false })

    expect(client.syncplayToast.value).toBe('')
  })

  // The other half of the gate, so it does not widen into "never explain a
  // near-duration refusal": a room *seek* to a position past our end is refused
  // whether or not it is within the tolerance, and a refused seek is exactly
  // what the message exists to explain.
  it('still explains a refused room seek that lands inside the tolerance', async () => {
    const v = fakeVideo({
      currentTime: 1439.6,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 1440.05, paused: true, doSeek: true, setBy: 'peer' })

    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)
  })
})

// `resetRemoteStateTracking()` clears the flag by default, and a *reconnect* is
// the one caller that opts out with `{ keepRefusalNotice: true }` — same room,
// same file, and clearing it would let the refusal re-fire straight over the
// reconnect notice (pinned above by "does not swallow the reconnect notice that
// follows it"). The two tests below drive callers that take the default: the
// file or the session has changed under the flag, so it is stale state about
// something we no longer have open, and leaving it set makes the *next* refusal
// silent — the next episode of a differently-cut release being exactly where
// that recurs. They fail if the clear is lifted back out of the function, which
// is what makes them the behavioural pin on the default rather than on two
// hand-written assignments.
describe('useSyncplayClient — the refusal toast re-arms on a new file or session (#281)', () => {
  it('re-arms across an episode change', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const deps = makeDeps({ video: v })
    const { emitRemoteState, client } = await mountWithRemoteState(deps, { state: 'ready' })

    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)

    deps.activeEpisodeIndex.value = 1
    await flushPromises()
    client.syncplayToast.value = ''

    // The same refusal, but about a file the user has only just opened.
    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)
  })

  it('re-arms across a session end', async () => {
    const v = fakeVideo({
      currentTime: 0,
      duration: 1440,
      paused: true,
      readyState: 1
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)

    // Room A ends, room B begins. Room B must not inherit room A's explanation.
    client.syncplayStatus.value = { state: 'idle' }
    await flushPromises()
    client.syncplayStatus.value = { state: 'ready' }
    await flushPromises()
    client.syncplayToast.value = ''

    emitRemoteState({ position: 3000, paused: true, doSeek: false })
    expect(client.syncplayToast.value).toBe(OUT_OF_FILE_TOAST)
  })
})

// The two tests above pin the *behaviour* of the default through the only two
// callers that take it. What they cannot reach is the property the default
// exists for: that a caller added tomorrow inherits the clear rather than the
// reconnect's keep. `resetRemoteStateTracking` is a closure over module-private
// state and is not exported, so there is no hypothetical fourth caller to
// construct from a test — driving one would mean re-implementing the function,
// and such a test would pass no matter what the source did.
//
// So this guard reads the source instead, in the same spirit as
// `theme-tokens.test.ts` and `player-overlay-stacking.test.ts`: it asserts the
// clear lives *inside* the function and that every call site either takes the
// default or opts out in the one spelling, with the opt-out count pinned at one
// and located in the reconnect branch. Lift the clear back out to the call
// sites, or add a second silent opt-out, and this goes red.
describe('useSyncplayClient — the refusal clear defaults on, exception is explicit (#281)', () => {
  const SOURCE = readFileSync(
    resolve(__dirname, '../../../src/renderer/src/composables/use-syncplay-client.ts'),
    'utf8'
  )
  // Comments name the function and the opt-out verbatim; only real code counts.
  const CODE = SOURCE.split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

  it('clears the flag inside resetRemoteStateTracking, not at its call sites', () => {
    const body = CODE.match(
      /function resetRemoteStateTracking\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/
    )?.[1]
    expect(body, 'resetRemoteStateTracking declaration not found').toBeTruthy()
    expect(body).toMatch(/!\s*opts\.keepRefusalNotice[\s\S]*?refusedToastShown = false/)
  })

  it('has every call site take the default or opt out in the one spelling', () => {
    const callSites = CODE.split('\n')
      .filter((l) => l.includes('resetRemoteStateTracking(') && !l.includes('function '))
      .map((l) => l.trim())

    // Non-vacuity: the three known callers must actually be found.
    expect(callSites.length).toBeGreaterThanOrEqual(3)

    for (const site of callSites) {
      expect(
        site === 'resetRemoteStateTracking()' ||
          site === 'resetRemoteStateTracking({ keepRefusalNotice: true })',
        `unrecognized call form — a new caller must take the default or opt out explicitly: ${site}`
      ).toBe(true)
    }

    const optOuts = callSites.filter((s) => s.includes('keepRefusalNotice'))
    expect(optOuts, 'exactly one caller may keep the refusal notice').toHaveLength(1)
  })

  it('places the sole opt-out in the reconnect branch', () => {
    const start = CODE.indexOf("if (status.state === 'reconnecting') {")
    const end = CODE.indexOf("} else if (status.state === 'disconnected')", start)
    expect(start, 'reconnecting branch not found').toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    expect(CODE.slice(start, end)).toContain(
      'resetRemoteStateTracking({ keepRefusalNotice: true })'
    )
  })
})

// Live sessions (#220) kept surfacing the same class of bug: the app's own
// machinery moves the <video>, and the element's flags were read as the
// user's intent — pausing everyone on every buffer stall, and (once intent
// tracking landed) swallowing the user's real pause instead.
describe('useSyncplayClient — playback intent vs machinery (#220)', () => {
  it('reports the user intent, not the element flag, in the snapshot', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.onLocalPause()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 50, cause: 'pause' })
  })

  // Defect A: registering a pause that fires no event used to latch the old
  // single slot for good, and the guard then ate the user's *next* real pause —
  // "pauses don't work". An operation expires instead (#306).
  it('does not swallow a real pause after a programmatic mark that never fired', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    // Buffer refill registered a pause; suppose no event followed.
    s.beginProgrammaticPlayback('pause')
    s.onLocalPause() // the echo it was registered for
    sendLocalState.mockClear()
    s.onLocalPause() // the user, moments later

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 50, cause: 'pause' })
  })

  // A marked pause is machinery and must not reach the room at all.
  it('swallows exactly one marked programmatic pause', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticPlayback('pause')
    s.onLocalPause()

    expect(sendLocalState).not.toHaveBeenCalled()
  })
})

// The marker latches whenever the call it flags fires no event. The
// already-paused door was closed in cc7db47; this is the failed-call door.
describe('useSyncplayClient — a retracted mark cannot swallow the next play (#220)', () => {
  it('does not eat a real play after a programmatic mark was retracted', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 30, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    // A refill registered a resume, then play() rejected and retracted it.
    const op = s.beginProgrammaticPlayback('play')
    op.retract()
    s.onLocalPlay()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 30, cause: 'play' })
  })

  // A play() promise can outlive the operation it was registered with. Under
  // the old single slot this was carried by a heuristic — `markProgrammaticPlayback(
  // null)` cleared only a *resume* mark — which happened to cover this ordering
  // and demonstrably did not cover the next one down. The handle makes it
  // structural (#306).
  it('does not retract a pause operation when a stale play() rejection lands', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready' }

    // A resume was registered, a pause superseded it, and only afterwards does
    // the old play() reject — the pause's own operation must survive that.
    const play = s.beginProgrammaticPlayback('play')
    s.beginProgrammaticPlayback('pause')
    play.retract()
    s.onLocalPause()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // The third door, and the one that was still open (#236). Both cases above
  // register through a caller that owns the retraction; `applyRemoteState`
  // marked its own resume inline and then swallowed the rejection with
  // `catch(() => {})`, so a remote resume refused by autoplay policy left a
  // resume expectation standing with no `play` event coming to consume it — and
  // the user's next real play took the echo branch and never reached the room.
  // The one site that structurally could not retract; it registers an operation
  // and retracts it on rejection now (#306).
  it('does not eat the user’s play after a remote resume was refused', async () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 30,
      paused: true,
      play: vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'))
    } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 30, paused: false, doSeek: false })
    await flushPromises()
    expect(v.play).toHaveBeenCalled()

    // Kept from when a 1500 ms wall-clock window also gated the send: past it,
    // only the marker could suppress this, so the case could not pass for the
    // wrong reason. The window is gone (#304) and the advance is now simply
    // realistic — a real press does not arrive in the same tick as the apply.
    vi.useFakeTimers()
    vi.advanceTimersByTime(2000)
    v.paused = false
    client.onLocalPlay()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 30, cause: 'play' })

    // …and the operation was *retracted*, not flipped. An operation left
    // registered as a pause lets this same play through and swallows the user's
    // next real pause instead, which is exactly the edit a refactor of the
    // retraction path could make. Only the second half of the pair tells the two
    // apart.
    v.paused = true
    client.onLocalPause()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 30, cause: 'pause' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #306 Phase A — the programmatic playback operation registry.
//
// Every case below is written against the *old* single `appliedPaused` slot:
// each either sends where the old shape swallowed, or swallows where the old
// shape sent. The three groups map to the three properties the slot could not
// hold — one live expectation at a time, retraction by shape rather than by
// identity, and no lifetime at all.
// ─────────────────────────────────────────────────────────────────────────────
describe('useSyncplayClient — playback operations are individually tracked (#306)', () => {
  // THE characterization case for the single slot. The ready gate registers a
  // pause, an inbound remote resume registers its own operation *before* the
  // gate's `pause` event is delivered, and then that event lands.
  //
  // Old behavior: the apply's `appliedPaused = effectivePaused` overwrote the
  // gate's `true` with `false`, so the gate's own pause event fell through
  // `onLocalPause`'s `appliedPaused === true` test into the user branch and this
  // app's readiness pause was broadcast to the room as the user pausing it.
  it('does not broadcast a queued gate pause that a newer operation overwrote', async () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // A peer goes not-ready: the gate down-arms and registers its pause.
    client.syncplayRoomUsers.value = [{ name: 'peer', isReady: false } as SyncplayRoomUser]
    await nextTick()
    expect(v.pause).toHaveBeenCalled()

    // Before the element gets around to firing `pause`, the room sends a state
    // that registers an operation of its own.
    v.paused = true
    client.syncplayRoomUsers.value = [{ name: 'peer', isReady: true } as SyncplayRoomUser]
    await nextTick()
    emitRemoteState({ position: 100, paused: false, doSeek: false, setBy: 'peer' })
    await flushPromises()

    // Now the gate's pause event finally arrives. The 2000 ms advance is
    // deliberate and stays: it was written to clear the 1500 ms wall-clock
    // window so that only the registry could suppress this — otherwise the case
    // passed for the wrong reason. That is exactly why this test needed no
    // change when the window was deleted (#304): it was already proving the
    // registry rather than the clock.
    vi.useFakeTimers()
    vi.advanceTimersByTime(2000)
    sendLocalState.mockClear()
    client.onLocalPause()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // Exact retraction. The old `markProgrammaticPlayback(null)` cleared whatever
  // resume mark was in the slot, so this ordering — first play consumed, second
  // play registered, *then* the first play's promise rejects — retracted the
  // second operation's expectation, and its echo escaped as the user's.
  it('a stale play rejection does not retract the newer play operation', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 40, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    const first = s.beginProgrammaticPlayback('play')
    s.onLocalPlay() // the first operation's own echo, consumed
    const second = s.beginProgrammaticPlayback('play')
    first.retract() // …and only now does the first call's promise reject

    sendLocalState.mockClear()
    s.onLocalPlay() // the second operation's echo

    expect(sendLocalState).not.toHaveBeenCalled()
    // The second operation was consumed, not left behind: the user's next play
    // must still reach the room.
    second.retract() // a no-op — it is already gone
    s.onLocalPlay()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 40, cause: 'play' })
  })

  // Bounded lifetime. `appliedPaused` had none, so a registered pause whose
  // element event never arrived swallowed the user's real pause for the whole
  // session. Expiry may only ever release an event *toward* being sent — it is
  // never a new veto.
  it('an operation whose event never arrives expires instead of latching', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 70, paused: false } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticPlayback('pause')
    // Still inside the TTL: the expectation stands and the echo is swallowed.
    vi.advanceTimersByTime(14000)
    s.onLocalPause()
    expect(sendLocalState).not.toHaveBeenCalled()

    // A second operation that never fires, carried past its TTL.
    s.beginProgrammaticPlayback('pause')
    vi.advanceTimersByTime(15001)
    s.onLocalPause()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 70, cause: 'pause' })
  })
})

// The operation *kind* contract. Without it, registering the five programmatic
// PlayerView plays reproduces the documented stuck pause verbatim: the generic
// echo branch returns above the intent and room-mirror writes, and the nested
// ready-gate evaluation then reads the unwritten mirror and pauses the element
// the app had just resumed.
describe('useSyncplayClient — restore and episode-start intent kinds (#306)', () => {
  it('a wasPlaying restore keeps the element playing and does not send', () => {
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    // The element the source swap left behind: reloaded, paused, and about to be
    // resumed by the `if (wasPlaying)` restore.
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.beginProgrammaticPlayback('play', 'restore')
    v.paused = false
    s.onLocalPlay()

    // No stuck pause. `syncplayLastRemotePlaying` starts false, so an `echo`
    // here would return above the mirror write and the gate call at the end of
    // `onLocalPlay` would down-arm onto this very element.
    expect(v.pause).not.toHaveBeenCalled()
    // Not a second copy of a user command — the room hears it on the heartbeat.
    expect(sendLocalState).not.toHaveBeenCalled()
    // …and the intent really was carried across the swap.
    s.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 0, paused: false })
  })

  it('a later real user pause supersedes an earlier queued restore', () => {
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 12, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    // The restore is registered, and before its `play` event is delivered the
    // user presses pause.
    s.beginProgrammaticPlayback('play', 'restore')
    s.onLocalPause()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 12, cause: 'pause' })

    sendLocalState.mockClear()
    s.onLocalPlay() // the restore's delayed echo

    // Consumed — it is still this app's own play, so it is not sent…
    expect(sendLocalState).not.toHaveBeenCalled()
    // …and superseded — the user's pause is what the room is told next.
    s.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 12, paused: true })
  })

  // The other half of the supersession rule, characterized rather than claimed:
  // a *parked* remote state does not supersede. The revision is bumped where
  // intent is written, inside `applyRemoteStateToElement`, and #240 parks the
  // state above that call — so a room pause landing in exactly the window a
  // `restore` lives in leaves the restore current, and it writes its resume.
  // This is the residual the comment on `applyConsumedPlaybackIntent` names;
  // bumping the revision in `recordRemoteState` instead would supersede nearly
  // every restore at 1 Hz, which is worse. What bounds it is asserted below.
  it('a parked remote pause does not supersede a queued restore', async () => {
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({
      readyState: 0,
      currentTime: 0,
      paused: true
    } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // The source has just been swapped: the restore is queued against an element
    // that cannot honor a write yet.
    client.beginProgrammaticPlayback('play', 'restore')

    // A peer pauses the room while we are still at HAVE_NOTHING. `recordRemoteState`
    // runs — the badge appears — but the state is parked before any intent write.
    emitRemoteState({ position: 100, paused: true, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBe('peer')

    // The restore's own `play` event finally arrives, still current.
    v.paused = false
    client.onLocalPlay()

    // Not superseded: it writes its resume over the room's pause, and the badge
    // blinks off with it.
    expect(client.syncplayPausedBy.value).toBeNull()
    // Nothing goes out as a user command…
    expect(sendLocalState).not.toHaveBeenCalled()
    // …and while the element is parked `hasAnnounceablePosition()` keeps the
    // divergent snapshot off the wire too.
    client.onVideoTimeUpdate()
    expect(sendSnapshot).not.toHaveBeenCalled()

    // The divergence is real, not merely theoretical: once the element reports
    // metadata, the intent standing against a paused room is `paused: false`.
    ;(v as { readyState: number }).readyState = 1
    client.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 0, paused: false })

    // And this is what bounds it: the unpark re-applies the parked state, which
    // adopts the room's `paused`, pauses the element and restores the badge —
    // about one heartbeat of blink, not a room-dragging resume.
    sendSnapshot.mockClear()
    client.onVideoLoadedMetadata()
    expect(v.pause).toHaveBeenCalled()
    expect(client.syncplayPausedBy.value).toBe('peer')
  })

  it('an episode start replaces the previous episode’s intent without sending', async () => {
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 1400, paused: false } as Partial<HTMLVideoElement>)
    const deps = makeDeps({ video: v })
    const { client } = trackedMount(deps)
    await flushPromises()
    client.syncplayStatus.value = { state: 'ready', username: 'me' }

    // The previous episode ended paused.
    client.onLocalPause()
    sendLocalState.mockClear()

    // goToEpisode: the episode index moves, the watcher retires the old
    // source's operations, and the nav's play is registered against the new one.
    deps.activeEpisodeIndex.value = 1
    await nextTick()
    ;(v as { currentTime: number }).currentTime = 0
    client.beginProgrammaticPlayback('play', 'episode-start')
    v.paused = false
    client.onLocalPlay()

    // The physical echo is not a second copy of the navigation, and nothing at
    // the old source's playhead reaches the wire.
    expect(sendLocalState).not.toHaveBeenCalled()
    expect(v.pause).not.toHaveBeenCalled()
    // The previous episode's `intendedPaused` is gone, established once here.
    client.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 0, paused: false })
  })

  // What the harness actually observes on the MSE navigation path, recorded
  // rather than presumed (#306). `startMseSession` assigns `mseSrcUrl`
  // synchronously inside the awaited `prepareMkvForPlayback`, `videoSrc` selects
  // it, and the play runs in a `nextTick` *after* the DOM patch — so the element
  // this play is issued against is the NEW source at HAVE_NOTHING, not the old
  // metadata-bearing one. A fake cannot settle real Chromium event ordering (see
  // the note in docs/syncplay.md); what it can pin is that the classification is
  // correct for the readiness this sequence produces.
  it('the MSE episode-start play sees the new source at HAVE_NOTHING and sends nothing', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0,
      src: 'blob:new-episode'
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    const atCall = { src: v.src, readyState: v.readyState }
    s.beginProgrammaticPlayback('play', 'episode-start')
    v.paused = false
    const atEvent = { src: v.src, readyState: v.readyState }
    s.onLocalPlay()

    expect(atCall).toEqual({ src: 'blob:new-episode', readyState: 0 })
    expect(atEvent).toEqual({ src: 'blob:new-episode', readyState: 0 })
    // Two independent reasons, and both must hold: the operation consumes the
    // echo, and `hasAnnounceablePosition()` refuses to put a HAVE_NOTHING
    // element's 0 on the wire.
    expect(sendLocalState).not.toHaveBeenCalled()
  })
})

// A generation bump must not simply erase outstanding expectations: their late
// raw events would then be classified as new user input and the old source's
// move would reach the room. Retired operations stay tracked, can consume their
// own compatible late echo, and can write neither intent nor another operation.
describe('useSyncplayClient — late operations from a replaced source (#306)', () => {
  it('a late gen-N pause after gen-N+1 has metadata sends nothing and mutates no intent', async () => {
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 300, paused: false } as Partial<HTMLVideoElement>)
    const deps = makeDeps({ video: v })
    const { client } = trackedMount(deps)
    await flushPromises()
    client.syncplayStatus.value = { state: 'ready', username: 'me' }

    // gen N: a buffer refill registers a pause whose event has not arrived.
    client.beginProgrammaticPlayback('pause')

    // The source is replaced and gen N+1 loads to HAVE_METADATA, where the
    // readiness send guard no longer hides anything.
    deps.activeEpisodeIndex.value = 1
    await nextTick()
    ;(v as { currentTime: number }).currentTime = 0
    client.beginProgrammaticPlayback('play', 'episode-start')
    v.paused = false
    client.onLocalPlay()
    sendLocalState.mockClear()
    sendSnapshot.mockClear()

    // gen N's pause finally lands.
    client.onLocalPause()

    // Absorbed by the retired expectation — not reclassified as the user.
    expect(sendLocalState).not.toHaveBeenCalled()
    // …and it wrote nothing: the new episode's intent stands.
    client.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 0, paused: false })
  })

  it('retracting a retired operation cannot clear the newer one', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 200, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    const old = s.beginProgrammaticPlayback('play')
    s.bumpPlaybackSourceGeneration()
    s.beginProgrammaticPlayback('play', 'restore')

    // The old source's `play()` rejects long after its source is gone.
    old.retract()
    v.paused = false
    s.onLocalPlay()

    expect(sendLocalState).not.toHaveBeenCalled()
    expect(v.pause).not.toHaveBeenCalled()
  })

  // The class order in `consumePlaybackOp`, pinned. Drop the retraction above
  // and the retired operation is still in the registry when the live restore's
  // echo lands; matching retired-first hands that echo to an operation that
  // writes nothing, `syncplayLastRemotePlaying` stays false, and the nested
  // ready-gate call pauses the element the app just resumed.
  it('a retired operation does not absorb the live operation’s echo', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 200, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    // gen N: an echo play whose element event never arrived.
    s.beginProgrammaticPlayback('play')
    // The source is replaced; the restore is registered against gen N+1.
    s.bumpPlaybackSourceGeneration()
    s.beginProgrammaticPlayback('play', 'restore')

    v.paused = false
    s.onLocalPlay()

    expect(v.pause).not.toHaveBeenCalled()
    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // The documented residual: a retired expectation is bounded like any other,
  // and past its TTL the ambiguity is resolved toward the user. This is the
  // property that stops a source swap from latching a suppression forever.
  it('a retired operation still expires, releasing the next event to the user', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 200, paused: false } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    s.beginProgrammaticPlayback('pause')
    s.bumpPlaybackSourceGeneration()
    vi.advanceTimersByTime(15001)
    s.onLocalPause()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 200, cause: 'pause' })
  })
})

// The seek half of the registry (#306 Phase B) — the properties that only exist
// once the single `appliedSeekPosition` slot is gone. The matching *rules* it
// inherits (strict value vs. any-value, the epsilon, the `readyState` fork, the
// deliberate non-consume on a mismatch) are pinned in the `beginProgrammaticSeek`
// and `applied-seek marker lifetime` blocks above and are unchanged here.
describe('useSyncplayClient — seek operations are individually tracked (#306)', () => {
  // The behaviour difference, and the case the issue names: a source swap must
  // not erase an outstanding old-generation seek expectation and let its late
  // raw `seeked` be reclassified as new user input.
  //
  // Red against the single slot. There, the gen-N+1 write *overwrites* the
  // gen-N mark, so the late gen-N `seeked` consumes the only mark there is and
  // the new source's own `seeked` finds nothing armed — `position: 0` goes out
  // as the user's seek and `forcePositionUpdate` drags every peer to 0. Green
  // against the registry: both operations are tracked, the live one takes the
  // first event (class order) and the retired one is still there to absorb the
  // second.
  //
  // Note what is *not* claimed: neither event carries provenance, so which
  // physical `seeked` belongs to which write is unknowable. What is asserted is
  // that two registered writes account for two events — no leak, no erasure.
  it('a retired seek expectation is not erased, and absorbs its late echo', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    // gen N: a write against the old source whose `seeked` has not arrived.
    s.beginProgrammaticSeek(300)
    // `selectQuality` rebinds the stream on the same element and bumps.
    s.bumpPlaybackSourceGeneration()
    // gen N+1: the restore's rewind, on an element that has not reloaded yet.
    s.beginProgrammaticSeek(0)

    // Two `seeked` events arrive for two writes. Neither may reach the room.
    v.currentTime = 300
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    v.currentTime = 0
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    // Both spent — the user's next seek is the user's.
    v.currentTime = 900
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // Exact retraction, the seek twin of "retracting a retired operation cannot
  // clear the newer one". The slot had no retraction path at all; the failure
  // mode a naive one would have introduced is retracting by shape — clearing
  // whatever occupies the slot, which by then is a newer write's expectation.
  it('retracting one seek operation leaves a newer one armed', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    // The MSE resume land registers, then its `currentTime` assignment throws.
    const land = s.beginProgrammaticSeek(600)
    // A remote apply's write is registered in between, and does move the element.
    s.beginProgrammaticSeek(120)
    land.retract()

    // The apply's echo is still guarded.
    v.currentTime = 120
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    // And the retracted operation guards nothing: a later seek to the position
    // the failed write asked for is the user's.
    v.currentTime = 600
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 600, cause: 'seek' })
  })

  it('retracting an already-consumed operation is a no-op, not a second removal', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    const first = s.beginProgrammaticSeek(300)
    v.currentTime = 300
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    // A newer write, then the first operation's late retraction. Retracting by
    // identity finds nothing; retracting by shape would take this one.
    s.beginProgrammaticSeek(700)
    first.retract()

    v.currentTime = 700
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // The `readyState 0` same-position branch registers nothing and hands back the
  // inert handle. Retracting it must not reach into the registry — under a
  // shape-based retraction it would have taken whatever else was outstanding.
  it('the inert handle from a no-op registration retracts nothing', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    const real = s.beginProgrammaticSeek(420)
    expect(real.id).not.toBe(0)

    // The episode-nav rewind on an element already at 0: nothing to expect.
    const inert = s.beginProgrammaticSeek(0)
    expect(inert.id).toBe(0)
    inert.retract()
    ;(v as { readyState: number }).readyState = 1

    // The real operation is untouched.
    v.currentTime = 420
    s.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // TTL direction, with more than one operation outstanding: expiry releases,
  // it never vetoes. Pins that a stale operation cannot latch and swallow the
  // user's next real seek, which is the property the slot had only by accident
  // of being a single value.
  it('expired seek operations release the next event instead of swallowing it', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    // Two writes that move the element and whose `seeked` never arrives — an
    // aborted load on each.
    s.beginProgrammaticSeek(300)
    s.beginProgrammaticSeek(700)

    vi.advanceTimersByTime(15001)
    v.currentTime = 900
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })

    // And nothing survived to eat the one after it either.
    sendLocalState.mockClear()
    v.currentTime = 300
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 300, cause: 'seek' })
  })

  // A source swap on its own must not resolve the ambiguity toward suppression
  // forever: a retired seek operation is bounded like any other.
  it('a retired seek operation still expires', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    s.beginProgrammaticSeek(300)
    s.bumpPlaybackSourceGeneration()

    vi.advanceTimersByTime(15001)
    v.currentTime = 300
    s.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 300, cause: 'seek' })
  })

  // The registry is bounded in size as well as in time, so a run of writes whose
  // events never arrive cannot grow it without bound. Oldest first, matching the
  // consume order: the earliest expectation is the one dropped.
  it('caps the registry, dropping the oldest expectation first', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready', username: 'me' }

    // SEEK_OP_MAX is 16. Seventeen registrations, none of them consumed.
    for (let i = 1; i <= 17; i++) s.beginProgrammaticSeek(i)

    // Sixteen events are absorbed…
    for (let i = 0; i < 16; i++) {
      v.currentTime = 1000 + i
      s.onVideoSeeked()
    }
    expect(sendLocalState).not.toHaveBeenCalled()

    // …and the seventeenth is the user's, because the first registration was
    // evicted rather than the registry growing.
    v.currentTime = 2000
    s.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledTimes(1)
  })

  // The remote apply is the eighth arming site and the one that never went
  // through the helper. It registers a *strict* operation regardless of
  // `readyState`, because #240 makes it the sole renderer-side echo guard for a
  // deferred apply — a value-agnostic one would swallow the user's first real
  // seek after every apply.
  it('the remote apply registers a strict operation that does not swallow a far user seek', async () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // The user hits Skip OP before the apply's own echo lands. Value-keyed, so
    // this is not mistaken for it and still reaches the room.
    v.currentTime = 900
    client.onVideoSeeked()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })

    // The apply's echo arrives afterwards and is still guarded — a mismatch does
    // not consume (#224), so the expectation survived the user's seek.
    sendLocalState.mockClear()
    v.currentTime = 300
    client.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // Two remote applies in quick succession — the first shape of the documented
  // single-slot residual, and the second case the registry closes. The slot held
  // the second target when the first apply's echo landed, so that echo
  // mismatched and went out as a user seek; main's belt misses it too, because
  // `lastAppliedRemotePosition` has also moved on.
  //
  // The two `seeked` events below are driven by hand, and that is the right unit
  // for the registry's bookkeeping — each expectation is keyed to its own value
  // and consumed by its own event, whichever of them the element delivers. It is
  // *not* a claim about the browser: a real element aborts the pending seek when
  // the second write supersedes it, so this pair of writes fires one `seeked`,
  // not two, and the 300 expectation is then orphaned for its TTL. That orphan
  // is the residual the registry widened (see `docs/syncplay.md`); what this
  // test pins is only that neither expectation can clobber the other.
  it('two remote applies in flight each keep their own expectation', async () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    emitRemoteState({ position: 700, paused: true, doSeek: true })
    sendLocalState.mockClear()

    v.currentTime = 300
    client.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()

    v.currentTime = 700
    client.onVideoSeeked()
    expect(sendLocalState).not.toHaveBeenCalled()
  })
})

// The renderer half of main's session-vs-socket split (#227). `tearDown()`
// clears main's `snapshot`/`lastRoomState`/`playbackAdopted` and the reconnect
// path skips it; the renderer's own intent refs had no such rule, so room A's
// intent and its in-flight markers rode into room B inside one player mount.
//
// Every case here drives the status watcher through a real terminal state and
// then back to `ready`, which no other test in this file does. Two mechanics
// they all respect: the watcher is a pre-flush `watch`, so the write has to be
// followed by `nextTick()`; and the vacuity guard is the element's own
// `paused: false` — `intentOr()` falls back to `v.paused`, so a paused fake
// would report `paused: true` with `intendedPaused` deleted outright.
describe('useSyncplayClient — session-scoped state resets on disconnect (#227)', () => {
  // Drives one full session end and re-join without unmounting the player.
  const cycle = async (client: Client, via: 'disconnected' | 'idle' | 'reconnecting') => {
    client.syncplayStatus.value = { state: via }
    await nextTick()
    client.syncplayStatus.value = { state: 'ready', username: 'me' }
    await nextTick()
  }

  it('clears the user intent, so the next session reports the element again', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // Room A: the user pauses, latching intent.
    client.onLocalPause()
    await cycle(client, 'disconnected')

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()

    // Room B has been told nothing yet, so the element is the best answer —
    // and it is playing. Room A's `true` would pause the new room.
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 50, paused: false })
  })

  it("does not swallow the next session's first real pause", async () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // A buffer refill registered a pause whose event never arrived — the
    // operation is still outstanding at the moment the session dies.
    client.beginProgrammaticPlayback('pause')
    await cycle(client, 'disconnected')

    sendLocalState.mockClear()
    client.onLocalPause()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 50, cause: 'pause' })
  })

  it("does not swallow the next session's first real seek", async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // A programmatic write that moved the element but whose `seeked` never
    // arrived (an aborted load) — the residual latch the 15 s TTL backstops.
    client.beginProgrammaticSeek(120)
    await cycle(client, 'disconnected')

    // Well inside APPLIED_SEEK_TTL_MS, so only the reset can disarm it.
    vi.advanceTimersByTime(2000)
    ;(v as { currentTime: number }).currentTime = 42
    sendLocalState.mockClear()
    client.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 42, cause: 'seek' })
  })

  it("attributes the next session's first pause after a session reset", async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    // Paused element + paused room: the apply needs a seek but no play/pause,
    // so it registers a seek operation and no *playback* operation. That
    // isolation is what keeps the `pausedBy` half meaningful — with a pause
    // operation left in the registry, `onLocalPause` returns at its own guard,
    // writes no attribution, and the case would fail (or, with the reset
    // clearing it, pass) for reasons that have nothing to do with what is
    // asserted here. Kept deliberately after the gate deletion for exactly that
    // reason: dropping the fixture hollows out the surviving half too.
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    await cycle(client, 'disconnected')

    sendLocalState.mockClear()
    client.onLocalPause()

    expect(sendLocalState).toHaveBeenCalledTimes(1)
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 300, cause: 'pause' })
    // The session end nulls `syncplayPausedBy`, and the next session's first
    // user pause must re-establish it. This is the race the reset deliberately
    // widens (an echo pause arriving after it now runs the bookkeeping) —
    // asserted rather than left to chance.
    expect(client.syncplayPausedBy.value).toBe('me')
  })

  it("lets the next session's first timeupdate snapshot through", async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // The 1 s interval is live in a mounted test: one tick stamps
    // `lastSnapshotPushAt` with no explicit push anywhere in the case.
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalled()
    await cycle(client, 'disconnected')

    // The reconnect lands inside SNAPSHOT_MIN_INTERVAL_MS of that stamp.
    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()

    expect(sendSnapshot).toHaveBeenCalledWith({ position: 50, paused: false })
  })

  // The other half of the rule, and the one that keeps the reset honest: a
  // socket drop that auto-reconnects goes `ready` → `reconnecting` → `ready`
  // without ever passing through `disconnected`, and it is the same room, the
  // same player and the same user — main skips `tearDown()` there for exactly
  // this reason. Only the per-socket remote-state tracking resets on this path
  // (covered by 'does not latch across a reconnect' above).
  it('keeps the user intent across a reconnect', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    client.onLocalPause()
    await cycle(client, 'reconnecting')

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()

    // The element is playing — the machinery moved it, not the user — so this
    // `true` can only come from the intent that survived the reconnect.
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 50, paused: true })
  })

  // A user-initiated disconnect ends at `idle`, a failure at `disconnected`.
  // Both are session ends and both must reset; only one of them is on the
  // branch's obvious path.
  it('resets on a user-initiated disconnect too, not only on a failure', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    client.onLocalPause()
    await cycle(client, 'idle')

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()

    expect(sendSnapshot).toHaveBeenCalledWith({ position: 50, paused: false })
  })
})

// #228. A user pause made in the pre-adoption window — player mounted, still
// converging on the room — used to undo itself: the next inbound playing state
// resumed the element through the apply, and the ready gate resumed it through
// a room mirror the user's own pause could not reach (its write was gated on a
// wall-clock window every apply re-armed at ~1 Hz). `pendingUserPause` makes the
// pause outrank the room until it has had its chance to reach the room.
describe('useSyncplayClient — a pending user pause outranks the room (#228)', () => {
  const PENDING = 'Pausing once synced with the room…'
  const FAILED = "The room kept playing — your pause didn't stick"

  // Press pause on a playing element, the way the element reports it: the
  // `pause` event fires with `v.paused` already true.
  const pressPause = (client: Client, v: HTMLVideoElement): void => {
    client.onLocalPause()
    ;(v as unknown as { paused: boolean }).paused = true
  }

  // The gate's second entry point is `setSyncplayLocalReady`, and reaching it
  // takes the setup trap the ready-gate tests all share: `syncplayLocalReady`
  // starts `true` and the setter early-returns on no change, so it has to be
  // driven *down* through the 600 ms `waiting` debounce first. Needs fake timers.
  const driveGateEntry = (client: Client): void => {
    client.onVideoWaiting()
    vi.advanceTimersByTime(601)
    client.onLocalCanPlay()
  }

  // 1. The apply half: the seek still lands (withholding it would stall the very
  // adoption the hold waits for — main's drift test reads the element position),
  // but nothing resumes the element and the room's intent is not adopted.
  it('holds a playing remote state: it seeks, but neither resumes nor clobbers intent', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.currentTime).toBe(200)
    expect(v.play).not.toHaveBeenCalled()

    // Read the intent off the 1 s interval rather than a `timeupdate`: the apply
    // above pushes a snapshot of its own (#324) and stamps `lastSnapshotPushAt`
    // doing it, so a `timeupdate` on the next line returns at the
    // SNAPSHOT_MIN_INTERVAL_MS throttle and this would assert on silence. The
    // interval calls `pushSyncplaySnapshot` directly and is what carries the
    // value in production anyway. Same substitution in every case below that
    // reads a snapshot straight after an apply.
    sendSnapshot.mockClear()
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 200, paused: true })
  })

  // 2. The other resume path, and the one the wall-clock window kept open: the
  // room mirror says "playing", every user is ready, and the gate plays us.
  it('the ready gate does not resume a held pause', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // A seek-only apply, the shape that arrives at ~1 Hz through the whole
    // convergence window — and on the head of #228 the shape that re-armed the
    // 1500 ms window that shut the user's own mirror write out.
    // `paused: false` matches the element, so this apply is seek-only: it
    // registers no playback operation and the pause below reaches the
    // bookkeeping instead of the echo branch.
    emitRemoteState({ position: 300, paused: false, doSeek: true, setBy: 'peer' })
    vi.advanceTimersByTime(200)
    pressPause(client, v)

    // A peer's playing state crosses the press. It is held — but the mirror
    // above it is not, so the room really does read as "playing" while the
    // pause stands, and only the gate's own `!pendingUserPause` term stops it
    // resuming us.
    emitRemoteState({ position: 320, paused: false, doSeek: false, setBy: 'peer' })
    ;(v.play as ReturnType<typeof vi.fn>).mockClear()

    driveGateEntry(client)

    expect(v.play).not.toHaveBeenCalled()
  })

  // 3. The clear lives in `recordRemoteState`, which #240 guarantees runs for
  // every inbound state — this one's element half returns at the no-op early-out,
  // so a clear placed there would never fire.
  it('clears the hold on a paused state whose element half early-outs', async () => {
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    // Paused element, paused room, within the 3 s tolerance: no seek, no
    // play/pause, straight out at the early-out.
    emitRemoteState({ position: 101, paused: true, doSeek: false, setBy: 'peer' })

    emitRemoteState({ position: 101, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).toHaveBeenCalled()
  })

  // 4. Keyed on `state.paused`, not on the element half's `effectivePaused`: a
  // playing room we happen to be gating locally is still a playing room, and
  // clearing there would end the hold on a state that asserted no pause at all.
  it('does not clear on a playing state that local readiness turned into a pause', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    client.onVideoWaiting()
    vi.advanceTimersByTime(601)

    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })

    // Held, not cleared: the toast is the observable side of "a playing state
    // was held", and the element is still where the hold left it.
    expect(client.syncplayToast.value).toBe(PENDING)
    expect(v.play).not.toHaveBeenCalled()
  })

  // 5. The backstop fires and hands the room back, with the failure message the
  // reference client's own "ready-to-unpause" notification is the precedent for.
  it('expires after 8 s, toasting the failure and applying the next state normally', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe(PENDING)

    vi.advanceTimersByTime(8000)
    expect(client.syncplayToast.value).toBe(FAILED)

    emitRemoteState({ position: 300, paused: false, doSeek: false })
    expect(v.play).toHaveBeenCalled()
    expect(v.currentTime).toBe(300)
    // The seek toast would have overwritten the failure message; this state
    // carries no `setBy`, so what is on screen is still the failure.
    expect(client.syncplayToast.value).toBe(FAILED)
  })

  // 6. The user changing their mind ends the hold — and must not leave the gate
  // holding a stale mirror that re-pauses the resume (the R8 half of decision 2).
  it('ends the hold on a real play, leaving the element playing', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe(PENDING)
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    expect(v.pause).not.toHaveBeenCalled()
    expect(client.syncplayToast.value).toBe('')

    // The interval, not a `timeupdate` — the apply's own push (#324) throttles
    // one landing this soon after it. See case 1.
    sendSnapshot.mockClear()
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 200, paused: false })
  })

  // 7. Decision 2's pause half, isolated from the hold (post-adoption, so
  // nothing registers): a pause classified as real by the operation registry
  // moves the room mirror, promptly, on the press. This was written against the
  // 1500 ms window an apply re-armed at ~1 Hz — it was red on the head of #228,
  // where that window shut both the mirror write and the badge — and it outlives
  // the window's deletion (#304) as the assertion that classification, not the
  // clock, is what admits these writes. The 200 ms advance below is kept for the
  // same reason: it is when a press actually lands relative to an apply.
  it('writes room-mirror state for a real pause moments after an apply', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 0, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me',
      playbackAdopted: true
    })

    // Seek-only apply: it registers a seek operation and no playback operation,
    // so the pause below reaches the bookkeeping instead of the echo branch.
    emitRemoteState({ position: 300, paused: false, doSeek: true, setBy: 'peer' })
    vi.advanceTimersByTime(200)

    pressPause(client, v)

    expect(client.syncplayPausedBy.value).toBe('me')
    // `syncplayLastRemotePlaying` has no accessor — the gate is how it is
    // observed. A stale `true` there resumes the element the user just paused.
    ;(v.play as ReturnType<typeof vi.fn>).mockClear()
    driveGateEntry(client)
    expect(v.play).not.toHaveBeenCalled()
  })

  // 8. R7's prerequisite: with the mirror gates relaxed, an *unmarked* pause
  // moves room state, so PlayerView's teardown pause has to be marked. Asserted
  // through the marker rather than through the absence of a send, which passes
  // vacuously whenever `getVideoEl()` is null.
  it('lets a marked teardown pause pass without touching intent', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    client.onLocalPlay()

    // PlayerView.onBeforeUnmount: register, then pause, then swap the source.
    client.beginProgrammaticPlayback('pause')
    client.onLocalPause()
    ;(v as { paused: boolean }).paused = true

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()
    // The pre-teardown intent, not the element's flag — the marked pause was
    // consumed and changed nothing.
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 100, paused: false })
    expect(client.syncplayPausedBy.value).toBeNull()
  })

  // 9. The whole happy path end to end: the state crossing the press on the wire
  // is held, the room going paused ends the hold, and the room owns us again.
  it('holds the state crossing the press and applies the next one after the clear', async () => {
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).not.toHaveBeenCalled()

    client.syncplayStatus.value = { state: 'ready', username: 'me', roomPaused: true }
    await nextTick()

    emitRemoteState({ position: 250, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).toHaveBeenCalled()
    expect(v.currentTime).toBe(250)
  })

  // 10. The parked path (#240): "a playing state was held" is recorded when the
  // apply is *enacted*, not when the state arrived — a parked state has held
  // nothing yet, and counting it at arrival would toast for a hold that never
  // happened.
  it('records a parked state as held at unpark, not at arrival', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    emitRemoteState({ position: 300, paused: false, doSeek: true, setBy: 'peer' })
    // Metadata has landed on the element (so the pause can arm) but our
    // `loadedmetadata` handler has not run yet.
    ;(v as { readyState: number }).readyState = 1
    pressPause(client, v)
    expect(client.syncplayToast.value).toBe('')

    client.onVideoLoadedMetadata()

    expect(client.syncplayToast.value).toBe(PENDING)
    expect(v.currentTime).toBe(300)
    expect(v.play).not.toHaveBeenCalled()
  })

  // 11. The pairing decision 2 insists on, in the order that goes red: pause and
  // play back to back with no apply in between. Green on head, red with the
  // pause-side relaxation alone (the gate reads a stale `false` and re-pauses
  // the user's own resume), green with both halves.
  it('does not re-pause a play pressed immediately after a pause', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // Leaves the mirror saying "the room is playing".
    emitRemoteState({ position: 300, paused: false, doSeek: true, setBy: 'peer' })
    vi.advanceTimersByTime(200)

    pressPause(client, v)
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    expect(v.pause).not.toHaveBeenCalled()
    // Read the intent off the 1 s interval rather than a `timeupdate`: the apply
    // above now pushes a snapshot of its own (#324) and stamps
    // `lastSnapshotPushAt` with it, so a `timeupdate` 200 ms later returns at
    // the SNAPSHOT_MIN_INTERVAL_MS throttle and this would be asserting on
    // silence. The interval calls `pushSyncplaySnapshot` directly and is what
    // carries the value in production anyway.
    sendSnapshot.mockClear()
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 300, paused: false })
  })

  // 12. Why the hold skips the *whole* play/pause block: skipping only the
  // `v.play()` would leave its play operation registered with no event left to
  // consume it, and the user's next real play would be eaten as that echo.
  it('leaves no applied-pause latch behind, so a real play still reaches intent', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    // The interval, not a `timeupdate` — the apply's own push (#324) throttles
    // one landing this soon after it. See case 1.
    sendSnapshot.mockClear()
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 200, paused: false })
  })

  // 13. The badge: it appears on the press (decision 2 opened that write), the
  // held state does not clear it, and the handoff to a peer rides the ordinary
  // `pausedChanged` path once the clear falls through.
  it('keeps "paused by you" through a held state and hands it to the peer on the clear', async () => {
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    expect(client.syncplayPausedBy.value).toBe('me')

    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBe('me')

    emitRemoteState({ position: 200, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBe('peer')
  })

  // 14. A new episode deliberately auto-resumes the binge through the gate, so a
  // hold surviving the switch would sit on that resume until it expired.
  it('clears the hold on an episode change', async () => {
    const deps = makeDeps({ video: fakeVideo({ currentTime: 100, paused: false }) })
    const v = deps.getVideoEl()!
    const { client, emitRemoteState } = await mountWithRemoteState(deps, {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    deps.activeEpisodeIndex.value = 1
    await nextTick()

    emitRemoteState({ position: 0, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).toHaveBeenCalled()
  })

  // 15. Decision 5's arming guard, which is what keeps every reload-shaped
  // implicit pause out without any PlayerView plumbing: the load algorithm
  // resets `readyState` synchronously and delivers its `pause` — if the engine
  // fires one at all — afterwards.
  it('never arms for a pause delivered at HAVE_NOTHING, and lets the state apply', async () => {
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // The quality/translation switch: `pause()` + `src` swap. The restore
    // `play()` is deliberately *not* driven here — `onLocalPlay()` clears the
    // hold by itself, so with it in place this case passes whether or not the
    // arming guard exists.
    pressPause(client, v)
    ;(v as { readyState: number }).readyState = 1

    emitRemoteState({ position: 200, paused: false, doSeek: true, setBy: 'peer' })

    // Nothing armed, so the state applies in full — seek, resume and toast.
    expect(v.currentTime).toBe(200)
    expect(v.play).toHaveBeenCalled()
    expect(client.syncplayToast.value).toBe('peer seeked to 3:20')
  })

  it('stays silent for a HAVE_NOTHING pause with no restore behind it', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // The failed-remux shape: the source went away and nothing ever resumes.
    pressPause(client, v)
    vi.advanceTimersByTime(8000)

    expect(client.syncplayToast.value).toBe('')
  })

  // 15c. The other half of decision 5's arming condition: post-adoption the
  // hold is redundant (main's ack protection is on) and arming would toast a
  // failure nobody earned.
  it('never arms once adoption has latched', async () => {
    const v = fakeVideo({ currentTime: 0, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me',
      playbackAdopted: true
    })

    pressPause(client, v)
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).toHaveBeenCalled()
  })

  // 15d. The third term, matching the `syncplayPausedBy` write beside it: with
  // no session there is no room to outrank. Without it an idle pause arms the
  // flag and the 8 s timer, and a join inside that window starts the new
  // session already mid-hold — holding the room's first states against a pause
  // that predates the room.
  it('does not arm for a pause made outside a Syncplay session', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'idle'
    })

    pressPause(client, v)

    // "Join & watch", well inside the 8 s the idle pause would have armed.
    client.syncplayStatus.value = { state: 'ready', username: 'me' }
    await nextTick()
    vi.advanceTimersByTime(1000)

    // The room owns us from its very first state: nothing from before the
    // session is holding anything.
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).toHaveBeenCalled()
    expect(client.syncplayToast.value).not.toBe(PENDING)
  })

  // 16. An expiry that held nothing is not a failure the user can see, so it
  // says nothing.
  it('expires silently when no playing state was ever held', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    vi.advanceTimersByTime(8000)

    expect(client.syncplayToast.value).toBe('')
  })

  // 16b. …and it leaves the badge alone. The reachable case: a hold armed while
  // the room is *already* reported paused never produces the `roomPaused`
  // false→true edge test 19 pins, so it runs to the backstop having held
  // nothing — and "Paused by you" was true the whole time.
  it('leaves a correct "paused by you" badge alone when the expiry held nothing', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me',
      roomPaused: true
    })

    pressPause(client, v)
    expect(client.syncplayPausedBy.value).toBe('me')

    vi.advanceTimersByTime(8000)

    expect(client.syncplayToast.value).toBe('')
    expect(client.syncplayPausedBy.value).toBe('me')
  })

  // 17a. The falsifier, and the reason the hold's lifetime cannot be shortened
  // to the latch flip (decision 4). Written first, before any of the above
  // existed, in exactly this shape minus the timer advance — and it passed,
  // confirming that on unmodified apply code adoption is no protection at all:
  // a pause made pre-adoption never armed main's `pendingClientAck` (a
  // pre-adoption `sendLocalState()` returns before the bump, on purpose), and
  // post-adoption only the heartbeat asserts it, which reads that counter but
  // never writes it. So the moment the hold ends for any reason other than the
  // room actually pausing, the playing state already on the wire wins.
  it('is not protected by adoption once the hold ends', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    client.syncplayStatus.value = { state: 'ready', username: 'me', playbackAdopted: true }
    await nextTick()

    vi.advanceTimersByTime(8000)
    emitRemoteState({ position: 100, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).toHaveBeenCalled()
  })

  // 17b. The pin: adoption flipping true clears nothing. Red against any
  // revision that adds a clear on the latch.
  it('keeps holding across the adoption flip', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    client.syncplayStatus.value = { state: 'ready', username: 'me', playbackAdopted: true }
    await nextTick()

    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })

    expect(v.play).not.toHaveBeenCalled()
    // The interval, not a `timeupdate` — the apply's own push (#324) throttles
    // one landing this soon after it. See case 1.
    sendSnapshot.mockClear()
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 200, paused: true })
  })

  // 18. The normal terminator, and the repair it has to carry: the hold *masked*
  // the room mirror, it did not undo it, so a bare clear hands the next gate
  // entry a `true` and it resumes the pause we just confirmed had landed.
  it('clears on the roomPaused edge and repairs the mirror it was masking', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    // One held playing state, so the mirror says "the room is playing" again.
    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe(PENDING)

    client.syncplayStatus.value = { state: 'ready', username: 'me', roomPaused: true }
    await nextTick()
    expect(client.syncplayToast.value).toBe('')
    ;(v.play as ReturnType<typeof vi.fn>).mockClear()

    driveGateEntry(client)
    expect(v.play).not.toHaveBeenCalled()

    // The interval, not a `timeupdate` — the apply's own push (#324) throttles
    // one landing this soon after it. See case 1.
    sendSnapshot.mockClear()
    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 200, paused: true })

    // …and the room owns us again from the next state on.
    emitRemoteState({ position: 260, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).toHaveBeenCalled()
  })

  // 19. An edge, not a level: a hold armed while the room is *already* reported
  // paused (we are locally gated, say) would be cleared by its very first status
  // emit under a level test, before it ever held anything.
  it('clears on the false→true transition of roomPaused, not on the level', async () => {
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me',
      roomPaused: true
    })

    pressPause(client, v)
    client.syncplayStatus.value = { state: 'ready', username: 'me', roomPaused: true }
    await nextTick()

    emitRemoteState({ position: 200, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).not.toHaveBeenCalled()
    expect(client.syncplayToast.value).toBe(PENDING)

    client.syncplayStatus.value = { state: 'ready', username: 'me', roomPaused: false }
    await nextTick()
    client.syncplayStatus.value = { state: 'ready', username: 'me', roomPaused: true }
    await nextTick()

    emitRemoteState({ position: 260, paused: false, doSeek: false, setBy: 'peer' })
    expect(v.play).toHaveBeenCalled()
  })

  // 20. "Held" is recorded below the no-op early-out: a state that moved nothing
  // held nothing, so the window can expire on it in silence. Distinct from the
  // silent-expiry case above, where no state arrived at all.
  it('does not count a state that early-outs as held', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 100, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)
    // A peer is buffering, so `effectivePaused` matches the element and the
    // position matches too — the apply returns at the early-out.
    client.syncplayRoomUsers.value = [{ username: 'peer', file: null, isReady: false }]
    emitRemoteState({ position: 100, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayToast.value).toBe('')

    vi.advanceTimersByTime(8000)
    expect(client.syncplayToast.value).toBe('')
  })

  // 21. The stream this hold now actually runs against (#277). Until that fix a
  // *playing* pre-adoption frame essentially never reached the renderer — main's
  // self-`setBy` guard ate the lot, and this whole path was exercised only by
  // main's own `roomPaused` status projection. Since #277 the mirror-sourced
  // class is emitted at ~1 Hz, unattributed (`setBy: null`), with the room
  // playing and the element paused — so `needsPlayPause` is true on **every**
  // one of them and the hold is asked the same question seven times in a row
  // instead of once.
  //
  // Two things have to survive that. The window is anchored at
  // `pendingPauseArmedAt` and the "held" record is one-shot, so re-holding must
  // not restart the budget (early expiry into the failure toast) and must not
  // leak a `v.play()` on any frame. The seek half keeps landing throughout, by
  // design: it is what lets main's drift test latch adoption and end the hold
  // the honest way.
  it('holds against a 1 Hz stream of mirror-sourced playing frames (#277)', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 600, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    pressPause(client, v)

    // Seven mirror frames, one a second, each carrying the room a second
    // further on and none of them naming an author.
    for (let i = 1; i <= 7; i++) {
      emitRemoteState({ position: 600 + i, paused: false, doSeek: false, setBy: null })
      expect(v.play).not.toHaveBeenCalled()
      expect(client.syncplayToast.value).toBe(PENDING)
      expect(client.syncplayPausedBy.value).toBe('me')
      vi.advanceTimersByTime(1000)
    }

    // The budget ran from the press, not from the latest frame: the backstop
    // fires at 8 s and only then.
    vi.advanceTimersByTime(1000)
    expect(client.syncplayToast.value).toBe(FAILED)
    expect(v.play).not.toHaveBeenCalled()

    // The seek half was never withheld — the element moved on the one frame
    // whose drift cleared the renderer's 3 s apply tolerance (604 against a
    // playhead parked at 600). That write is what lets main's drift test latch
    // adoption and end the hold the honest way.
    expect(v.currentTime).toBe(604)
  })
})

// #284. Both outbound doors — the 1 Hz snapshot and the play/pause/seek State —
// are gated on the element having at least metadata, because a *reloading*
// element reports `currentTime === 0` for the whole load and neither of main's
// two de-adoption escapes fires during an in-player translation or quality
// switch: `buildCanonicalName()` carries no translation component and
// `newPlayer` is false, so `setFile()` does not reset the latch, and the zeros
// themselves keep `hasLivePlayback()` true so the stale-gap reset is never
// reached either. An adopted client announcing 0 wins the server's `min()` and
// drags every peer to the start.
//
// What this does *not* buy — and what the acceptance criteria were corrected to
// say — is "the room does not move". With both doors shut nothing refreshes
// main's `snapshot`, so its heartbeat keeps re-asserting the frozen pre-switch
// position at 1 Hz and the room stalls there until `PLAYBACK_STALE_MS`. The
// property pinned here is the renderer half: no `position: 0` on the wire, and
// pushes resuming the moment the element has metadata again.
// `test/services/syncplay-frozen-snapshot.test.ts` carries the room half.
describe('useSyncplayClient — a reloading element announces nothing (#284)', () => {
  // `readyState 0` is HAVE_NOTHING — the state the media load algorithm resets
  // to synchronously when `videoSrc` computes to `''` on a translation switch.
  const RELOADING = 0
  // HAVE_METADATA. The gate sits *below* this on purpose: an MSE buffer respawn
  // drops the element to exactly here and never lower, so a stricter test would
  // suppress real positions on every refill.
  const RESPAWNED = 1

  it('pushes no snapshot on a timer tick while the element is reloading', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({
      currentTime: 0,
      paused: false,
      readyState: RELOADING
    } as Partial<HTMLVideoElement>)
    await mountWithRemoteState(makeDeps({ video: v }), { state: 'ready', username: 'me' })

    // Five seconds of the awaited round trip, at the composable's own cadence.
    vi.advanceTimersByTime(5000)

    expect(sendSnapshot).not.toHaveBeenCalled()
  })

  it('sends no State for the implicit pause the reload queues', async () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: RELOADING
    } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    client.onLocalPause()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // Deliberate, and called out so it does not read as an accidental behaviour
  // change: PlayerView's restore `nextTick` calls `v.play()` while the element
  // is still at HAVE_NOTHING, and `play` is dispatched regardless of
  // `readyState`. Ungated that puts `paused: false, position: 0` on the wire.
  // The intent is not lost — the case below shows it arriving on the first
  // post-load snapshot, carried by `intentOr(v)`.
  it('swallows the auto-resume play, and the intent still reaches the room after the load', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: RELOADING
    } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // The restore resumes an element that has not loaded yet.
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()
    expect(sendLocalState).not.toHaveBeenCalled()

    // …the load then completes at the restored position.
    ;(v as { readyState: number }).readyState = RESPAWNED
    v.currentTime = 612
    vi.advanceTimersByTime(1000)

    expect(sendSnapshot).toHaveBeenCalledWith({ position: 612, paused: false })
  })

  it('carries currentTime on both doors once the element has metadata', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({
      currentTime: 612,
      paused: false,
      readyState: RESPAWNED
    } as Partial<HTMLVideoElement>)
    const { client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    vi.advanceTimersByTime(1000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 612, paused: false })
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 612, cause: 'pause' })
  })

  // The boundary case, and the one that separates "HAVE_NOTHING" from "not
  // ready": an MSE respawn removes the buffered range and drops the element to
  // HAVE_METADATA with `currentTime` still on the real position. Suppressing
  // there would stop the pushes for the length of a refill and make
  // `PLAYBACK_STALE_MS` reachable — de-adoption *and* a dropped `seekIntent` in
  // `maybeReassertSeek()` — through a path that is working correctly.
  it('keeps pushing through an MSE respawn, which never goes below HAVE_METADATA', async () => {
    vi.useFakeTimers()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({
      currentTime: 845,
      paused: false,
      readyState: 4
    } as Partial<HTMLVideoElement>)
    await mountWithRemoteState(makeDeps({ video: v }), { state: 'ready', username: 'me' })

    // `sb.remove()` over the full range: the data is gone, the seek stays
    // pending, and `currentTime` sits on the target.
    ;(v as { readyState: number }).readyState = RESPAWNED
    vi.advanceTimersByTime(1000)

    expect(sendSnapshot).toHaveBeenCalledWith({ position: 845, paused: false })
  })

  // The scenario end to end, at the composable's real cadence: an adopted
  // client mid-episode switches translation, the element reloads and sits at
  // HAVE_NOTHING across the awaited round trip, and the restore then writes the
  // saved position. Nothing this client puts on the wire ever claims 0 — which
  // is the whole defect — and the first post-load push is a normal one.
  it('puts no position 0 on the wire across a translation switch, and resumes after it', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({
      currentTime: 612,
      paused: false,
      readyState: 4
    } as Partial<HTMLVideoElement>)
    const deps = makeDeps({ video: v })
    const { client } = await mountWithRemoteState(deps, { state: 'ready', username: 'me' })

    // Two seconds of ordinary playback first, so the "no 0 on the wire"
    // assertion below has real frames to be true about.
    vi.advanceTimersByTime(2000)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 612, paused: false })

    // `selectTranslation()` → `resetMseState()` → `videoSrc` becomes `''`. The
    // element reloads: HAVE_NOTHING, playhead 0, and the teardown queues a
    // `pause`.
    ;(v as { readyState: number }).readyState = RELOADING
    ;(v as { paused: boolean }).paused = true
    v.currentTime = 0
    client.onLocalPause()

    // The awaited `playerFindLocalFile` / `prepareMkvForPlayback` /
    // `playerGetStreamUrl` round trip, with the 1 Hz interval running through
    // all of it.
    deps.activeTranslationId.value = 2
    await flushPromises()
    vi.advanceTimersByTime(4000)

    // The restore `nextTick`: seek back to the saved position, then resume —
    // both still on an element that has not loaded.
    client.beginProgrammaticSeek(612)
    v.currentTime = 612
    client.onVideoSeeked()
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    const positions = [
      ...sendSnapshot.mock.calls.map((c) => (c[0] as { position: number }).position),
      ...sendLocalState.mock.calls.map((c) => (c[0] as { position: number }).position)
    ]
    expect(positions).not.toContain(0)
    // Nor anything else below where we were when the switch began: a peer that
    // applied any of these frames is never dragged backwards.
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(612)

    // The load completes and the pushes resume, unchanged.
    sendSnapshot.mockClear()
    ;(v as { readyState: number }).readyState = 4
    client.onVideoLoadedMetadata()
    vi.advanceTimersByTime(1000)

    expect(sendSnapshot).toHaveBeenCalledWith({ position: 612, paused: false })
  })
})

// Adopting the room's intent also announces it (#324). Before the push the
// renderer sat on a state change it already had: the echo consume in
// `onLocalPause` returns above `sendSyncplayLocalState`, and a paused element
// fires no `timeupdate` (#227), so main's copy of our snapshot kept the
// pre-apply value until the 1 s interval fired. Main's own 1 s heartbeat races
// that interval, and when it wins, `canAssertSnapshot()` asserts the stale
// value back into the room.
//
// So the shared shape of every case below is: emit the state, then assert on
// the push **with no timer tick and no `timeupdate` anywhere in the body**. A
// case that advanced a timer would pass on `main` too — waiting for the
// interval is the defect.
//
// The numbers are the measured runs': pause-run2 (146 ms to the stale
// `paused: false`) and resume-run5 (152 ms to the stale `paused: true`, which
// undid the resuming user's play and left the room wedged at the 7 s probe).
describe('useSyncplayClient — applying a remote state announces it (#324)', () => {
  it('pushes a snapshot carrying paused: true when it applies a room pause', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    // pause-run2: B's element was at 14.179569 and the room's pause carried
    // 12.840873 — 1.34 s apart, inside the 3 s tolerance, so the apply pauses
    // without seeking and the pushed position is the element's own.
    const v = fakeVideo({ currentTime: 14.179569, paused: false } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    sendSnapshot.mockClear()
    emitRemoteState({ position: 12.840873, paused: true, doSeek: false, setBy: 'peerA' })

    expect(v.pause).toHaveBeenCalled()
    // On `main` this is the run's stale `{position: 13.898323, paused: false}`,
    // asserted by main's heartbeat 146 ms later.
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 14.179569, paused: true })
  })

  it('pushes a snapshot carrying paused: false when it applies a room resume', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    // resume-run5: B was paused at 12.4732 and the room resumed at
    // 12.531306821145725 — 58 ms apart, so again a play with no seek.
    //
    // `play` deliberately returns a promise that never settles, which is the
    // autoplay-policy shape the push must not be parked behind: the pushed
    // `paused` comes off `intentOr()`, already fixed by the intent write above
    // the enactment block, so awaiting the call would buy nothing and cost the
    // whole latency in the direction that loses the user's play. An
    // implementation that awaits it fails here rather than in production.
    const v = fakeVideo({
      currentTime: 12.4732,
      paused: true,
      play: vi.fn().mockReturnValue(new Promise(() => {}))
    } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    sendSnapshot.mockClear()
    emitRemoteState({
      position: 12.531306821145725,
      paused: false,
      doSeek: false,
      setBy: 'peerA'
    })

    expect(v.play).toHaveBeenCalled()
    // On `main` this is the run's stale `{paused: true}`, which main's heartbeat
    // asserted 152 ms later and pushed peer A back to paused 3 ms after its own
    // Play click landed.
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 12.4732, paused: false })
  })

  // Necessarily a resume: `holding = pendingUserPause && !state.paused`, so the
  // gate is false for every paused state by construction and this cannot be a
  // variant of the pause case above.
  //
  // The push is *not* withheld under a hold. The seek write above carries no
  // `holding` term, and main's `isAdopted()` latches on position — withholding
  // the announcement here would stall the very adoption the hold is waiting
  // for. What the hold does change is the payload, and this pins that: the
  // intent adoption is skipped, so `intentOr()` still reads the `true`
  // `onLocalPause` wrote before arming the hold. Red against anyone who drops
  // the `!holding` term from the *intent* write above, which would make this
  // announce the room's `paused: false` over the user's own pause.
  it("pushes the user's own pause, not the room's resume, while a hold is in effect", async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 200, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    // Pre-adoption, so the press arms the hold: `intendedPaused = true` first,
    // then `armPendingUserPause()`.
    client.onLocalPause()
    ;(v as { paused: boolean }).paused = true

    sendSnapshot.mockClear()
    emitRemoteState({ position: 250, paused: false, doSeek: true, setBy: 'peerA' })

    // The seek landed even under the hold, and the push carries that position
    // with the user's own intent — which is what main needs to adopt us.
    expect(v.currentTime).toBe(250)
    expect(sendSnapshot).toHaveBeenCalledTimes(1)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 250, paused: true })
  })

  // An apply that moves nothing announces nothing: `if (!needsSeek &&
  // !needsPlayPause) return` sits above the enactment block, so the push is
  // never reached. Do not "fix" the residual on this path by hoisting the push
  // above that early-out — a 1 Hz re-push of a snapshot nothing changed is what
  // the interval is already for, and this test is here to go red if someone
  // does. The path keeps the old one-heartbeat residual, deliberately and
  // knowingly; #324 does not close it.
  //
  // It is reachable, which is why it is worth pinning. An element paused by an
  // *echo* operation — an MSE buffer refill, the ready gate's down-arm — leaves
  // `intendedPaused` at `false`: `onLocalPause` consumes the op and
  // `applyConsumedPlaybackIntent` returns on `kind === 'echo'` without writing
  // intent. A room pause arriving then has `effectivePaused === v.paused`, so
  // `needsPlayPause` is false, and the 1 Hz interval keeps pushing
  // `paused: false` into a paused room until something else moves.
  //
  // That is a live bug and it is tracked in #331, not only here — this case
  // pins the *push*'s placement, not the staleness. The fix cannot be the
  // hoist: hoisting the push re-sends the same stale `intentOr()`, and hoisting
  // the *intent adoption* is blocked by `refusingResume`, which is folded into
  // `needsPlayPause` precisely so this early-out still fires (#281). So this
  // case stays green through #331's fix; only the paragraph above changes.
  it('pushes nothing when the apply moves neither the playhead nor playback', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 100, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    sendSnapshot.mockClear()
    // Inside the 3 s tolerance and already paused: nothing to seek, nothing to
    // enact.
    emitRemoteState({ position: 101, paused: true, doSeek: false, setBy: 'peerA' })

    expect(v.pause).not.toHaveBeenCalled()
    expect(v.currentTime).toBe(100)
    expect(sendSnapshot).not.toHaveBeenCalled()
  })

  // The one place where the push and "at `readyState` 1" meet: #240 parks a
  // state that arrives below HAVE_METADATA and replays it through the same
  // block from `onVideoLoadedMetadata`, at a `readyState` that has just
  // reached 1 — so `hasAnnounceablePosition` passes and the push fires there
  // too. Wanted: main learns the unparked position without waiting out the
  // interval.
  it('pushes on the deferred apply, once the parked state is finally written', async () => {
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({
      currentTime: 0,
      paused: true,
      readyState: 0
    } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    sendSnapshot.mockClear()
    emitRemoteState({ position: 300, paused: false, doSeek: true, setBy: 'peerA' })
    // Parked: the element was never written, so there is no position to claim.
    expect(sendSnapshot).not.toHaveBeenCalled()
    ;(v as { readyState: number }).readyState = 1
    client.onVideoLoadedMetadata()

    expect(v.currentTime).toBe(300)
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 300, paused: false })
  })

  // Pin the channel, not only the resulting `paused`. The obvious "simplify" is
  // a `sendSyncplayLocalState('pause')` in its place, which is green on the
  // room's pause state and wrong on the ignore counter: the discrete send bumps
  // `pendingClientAck` and asserts *intent* into the room, which is exactly the
  // misclassification the echo branch exists to prevent for a peer that is
  // merely following.
  it('announces through the snapshot channel, never as a discrete State', async () => {
    const sendLocalState = vi.fn()
    const sendSnapshot = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState, syncplaySendLocalSnapshot: sendSnapshot })
    const v = fakeVideo({ currentTime: 14.179569, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    sendLocalState.mockClear()
    sendSnapshot.mockClear()
    emitRemoteState({ position: 12.840873, paused: true, doSeek: false, setBy: 'peerA' })
    // The element's own `pause` event, arriving after the apply: it consumes the
    // echo operation and returns above the send, which is the whole reason main
    // hears nothing without the push.
    ;(v as { paused: boolean }).paused = true
    client.onLocalPause()

    expect(sendSnapshot).toHaveBeenCalledTimes(1)
    expect(sendLocalState).not.toHaveBeenCalled()
  })
})
