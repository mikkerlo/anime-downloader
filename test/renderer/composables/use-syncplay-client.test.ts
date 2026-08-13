// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
// 1.5s-window blocks with it. The deferral tests pass `readyState: 0`
// explicitly — a real happy-dom <video> is no help there either, since its
// readyState is pinned at 0 and silently ignores assignment.
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
      newPlayer: true
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

// The window is armed by an apply, so a test that never applies a remote state
// asserts nothing about it — the previous version of this block called
// onLocalPlay() on a fresh client and checked the state *was* sent, which
// passes with the gate at use-syncplay-client.ts:156 deleted.
//
// Reaching the wall-clock gate also needs a seek the *value*-keyed guard lets
// through (use-syncplay-client.ts:343-351): an event landing on the position we
// applied is consumed there and never gets as far as the window.
describe('useSyncplayClient — sendSyncplayLocalState gating', () => {
  // #239: this seek is the user's, to a position nobody applied. It used to die
  // inside the wall-clock window — the user pressed Skip, the video moved
  // locally, and the room never heard about it. Seeks are keyed on the applied
  // value now, so only an actual echo is suppressed.
  it('sends a user seek to an unrelated position inside the 1.5s window', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    // A remote seek arms the window and moves the element to 300.
    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // 200 ms later the user drags the scrubber somewhere else entirely, so the
    // value guard does not match and only the wall clock could suppress it.
    vi.advanceTimersByTime(200)
    v.currentTime = 900
    client.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // The window still gates play/pause: they have no applied value to key on, so
  // deleting it wholesale would leak the readiness gate's own pause/resume.
  //
  // Both halves, because they are only coupled by the shape of one condition:
  // with the `play` case alone, narrowing `cause !== 'seek'` to `cause ===
  // 'play'` at use-syncplay-client.ts:190 leaves the whole suite green, and the
  // `pause` half is the one #228's `cause === 'pause'` residual leans on.
  //
  // Each case has to reach the window at all: `onLocalPlay`/`onLocalPause`
  // return early on a matching `appliedPaused`, so the apply that arms the
  // window must leave that flag unset — i.e. it must move the playhead but not
  // the play state (`needsSeek` without `needsPlayPause`). Hence the remote
  // `paused` matching the element's in both rows; a mismatch there sets
  // `appliedPaused` and the case goes vacuous.
  it.each([
    {
      label: 'play',
      paused: true,
      fire: (c: Client) => c.onLocalPlay()
    },
    {
      label: 'pause',
      paused: false,
      fire: (c: Client) => c.onLocalPause()
    }
  ])('still swallows a $label inside the 1.5s window', async ({ paused, fire }) => {
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

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  it('sends that same seek once the window has expired', async () => {
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
  // however late it fires — this is what makes the window a backstop and not
  // the mechanism.
  it('swallows the echo of an applied seek even after the window has expired', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // A slow network stream takes longer than the window to land the seek.
    vi.advanceTimersByTime(4000)
    v.currentTime = 300
    client.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
  })
})

// The marker is the whole mechanism once the wall clock stops gating seeks, so
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
// which is also why the "only arm a write that will move the element" rule is
// enforced inside markProgrammaticSeek instead of at each call site: a guard
// spelled out in PlayerView.vue could not be regression-tested at all.
describe('useSyncplayClient — markProgrammaticSeek (#239)', () => {
  it('swallows the seeked of a write that landed where it was told', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.markProgrammaticSeek(420)
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
    s.markProgrammaticSeek(1400)
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

    s.markProgrammaticSeek(420)
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
    s.markProgrammaticSeek(420)
    vi.advanceTimersByTime(15001)
    v.currentTime = 900
    s.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
  })

  // Regression, and the reason the "will this actually move the element?" rule
  // lives inside markProgrammaticSeek rather than at the call sites.
  //
  // `goToEpisode` writes `currentTime = 0` in a nextTick that runs *after* the
  // `src` rebind, so the element has already reloaded: `readyState 0`, playhead
  // 0. Per the HTML media element spec that write only sets the default
  // playback start position, which fires no `seeked` then and — being zero — is
  // not seeked to on `loadedmetadata` either. Arming there gave the mark no
  // event to consume it, so it latched for the full 15 s TTL and ate the user's
  // next real seek: next episode → OP → Skip OP within 15 s went nowhere, which
  // is #239's own defect at a new site.
  it('arms nothing for a rewind to 0 on an element already at 0, so Skip OP still sends', () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.markProgrammaticSeek(0)

    // Well inside the TTL: the user hits Skip OP a few seconds into the new
    // episode.
    vi.advanceTimersByTime(4000)
    v.currentTime = 90
    s.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 90, cause: 'seek' })
  })

  // The other side of that guard: the same rewind on the MSE/remux path is a
  // real seek. `mseSrcUrl` has not been rebound yet, so the element still holds
  // the old source at a non-zero position and `currentTime = 0` does fire a
  // `seeked` — which must not reach the room, or `forcePositionUpdate` drags
  // every peer back to 0. Dropping the arming altogether would pass the test
  // above and fail this one.
  it('still arms the same rewind when the element has somewhere to move from', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 512, paused: true } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    s.markProgrammaticSeek(0)
    v.currentTime = 0
    s.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
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

  // The deferred write fires arbitrarily far outside the 1500 ms window, so the
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

    // Metadata arrives long after the wall-clock window — and after the marker's
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
  // Coverage caveats, twice over. (a) `fakeVideo.currentTime` is a plain
  // property, so this proves only that *our code* writes the room's position
  // verbatim. That the *element* does not clamp it on a growing `.part` rests on
  // the `seekable` span the protocol handler advertises (full `totalBytes`
  // denominator + tail stream), and is covered by manual scenario (a) alone.
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
    // A `.part` with ~2 minutes on disk; the room is 40 minutes in.
    const v = fakeVideo({
      currentTime: 0,
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

  // Defect A: marking a pause that fires no event latched appliedPaused, and
  // the guard then ate the user's *next* real pause — "pauses don't work".
  it('does not swallow a real pause after a programmatic mark that never fired', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 50, paused: false } as Partial<HTMLVideoElement>)
    const s = useSyncplayClient(makeDeps({ video: v }))
    s.syncplayStatus.value = { state: 'ready' }

    // Buffer refill marked a pause; suppose no event followed.
    s.markProgrammaticPlayback(true)
    s.onLocalPause() // the echo it was marking
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

    s.markProgrammaticPlayback(true)
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

    // A refill marked a resume, then play() rejected and retracted it.
    s.markProgrammaticPlayback(false)
    s.markProgrammaticPlayback(null)
    s.onLocalPlay()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 30, cause: 'play' })
  })

  // The retraction only clears a *resume* mark: the slot is single, and a
  // play() promise can outlive the mark it was installed with.
  it('does not retract a pause mark when a stale play() rejection lands', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready' }

    // A resume was marked, a pause superseded it, and only afterwards does the
    // old play() reject — the pause's own mark must survive that retraction.
    s.markProgrammaticPlayback(false)
    s.markProgrammaticPlayback(true)
    s.markProgrammaticPlayback(null)
    s.onLocalPause()

    expect(sendLocalState).not.toHaveBeenCalled()
  })

  // The third door, and the one that was still open (#236). Both cases above
  // reach `markProgrammaticPlayback` through a caller that owns the retraction;
  // `applyRemoteState` marked its own resume inline and then swallowed the
  // rejection with `catch(() => {})`, so a remote resume refused by autoplay
  // policy latched `appliedPaused = false` with no `play` event coming to
  // consume it — and the user's next real play took the echo branch and never
  // reached the room. The one mark site that structurally could not retract.
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

    // Past the 1500 ms window the apply arms, so only the marker can suppress
    // the send — without this the case would pass for the wrong reason.
    vi.useFakeTimers()
    vi.advanceTimersByTime(2000)
    v.paused = false
    client.onLocalPlay()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 30, cause: 'play' })

    // …and the mark was *retracted*, not flipped. A mark left at `true` lets
    // this same play through — `onLocalPlay`'s echo branch tests
    // `appliedPaused === false` — and swallows the user's next real pause
    // instead, which is exactly the edit a refactor of `markProgrammaticPlayback`
    // could make. Only the second half of the pair tells the two apart.
    v.paused = true
    client.onLocalPause()
    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 30, cause: 'pause' })
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

    // A buffer refill marked a pause whose event never arrived — `appliedPaused`
    // is latched at the moment the session dies.
    client.markProgrammaticPlayback(true)
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
    client.markProgrammaticSeek(120)
    await cycle(client, 'disconnected')

    // Well inside APPLIED_SEEK_TTL_MS, so only the reset can disarm it.
    vi.advanceTimersByTime(2000)
    ;(v as { currentTime: number }).currentTime = 42
    sendLocalState.mockClear()
    client.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: false, position: 42, cause: 'seek' })
  })

  it('re-opens the send gate and the pausedBy attribution for the next session', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    // Paused element + paused room: the apply needs a seek but no play/pause,
    // so it arms `suppressNextLocalEventUntil` and leaves `appliedPaused` null.
    // That isolation is the point — with `appliedPaused` set, `onLocalPause`
    // returns at its own guard and the case would pass for the wrong reason.
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me'
    })

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    await cycle(client, 'disconnected')

    // Still inside the dead session's 1500 ms window.
    sendLocalState.mockClear()
    client.onLocalPause()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 300, cause: 'pause' })
    // The same gate guards the room bookkeeping, so a leaked window also costs
    // the next session's first `pausedBy` attribution. This is the race the
    // reset deliberately widens (an echo pause arriving after it now runs the
    // bookkeeping) — asserted rather than left to chance.
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

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()
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

    // A seek-only apply, which is what re-arms the 1500 ms window at ~1 Hz
    // through the whole convergence window — on head that window is what shut
    // the user's own mirror write out.
    // `paused: false` matches the element, so this apply is seek-only: it leaves
    // `appliedPaused` unset and the pause below reaches the bookkeeping instead
    // of the echo branch.
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

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 200, paused: false })
  })

  // 7. Decision 2's pause half, isolated from the hold (post-adoption, so
  // nothing arms): a pause classified as real by the `appliedPaused` echo check
  // moves the room mirror even inside the 1500 ms window an apply just re-armed.
  // Red on head, where the window shut both the mirror write and the badge.
  it('writes room-mirror state for a real pause inside the suppression window', async () => {
    vi.useFakeTimers()
    const v = fakeVideo({ currentTime: 0, paused: false } as Partial<HTMLVideoElement>)
    const { client, emitRemoteState } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready',
      username: 'me',
      playbackAdopted: true
    })

    // Seek-only apply: it arms the window and leaves `appliedPaused` unset, so
    // the pause below reaches the bookkeeping instead of the echo branch.
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

    // PlayerView.onBeforeUnmount: mark, then pause, then swap the source.
    client.markProgrammaticPlayback(true)
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

    // Arms the 1500 ms window and leaves the mirror saying "the room is playing".
    emitRemoteState({ position: 300, paused: false, doSeek: true, setBy: 'peer' })
    vi.advanceTimersByTime(200)

    pressPause(client, v)
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    expect(v.pause).not.toHaveBeenCalled()
    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()
    expect(sendSnapshot).toHaveBeenCalledWith({ position: 300, paused: false })
  })

  // 12. Why the hold skips the *whole* play/pause block: skipping only the
  // `v.play()` would latch `appliedPaused = false` with no event left to consume
  // it, and the user's next real play would be eaten as that echo.
  it('leaves no applied-pause latch behind, so a real play still reaches intent', async () => {
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

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()
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

    // The quality/translation switch: `pause()` + `src` swap, then a restore
    // `play()` once the new source is loaded.
    pressPause(client, v)
    ;(v as { readyState: number }).readyState = 1
    ;(v as { paused: boolean }).paused = false
    client.onLocalPlay()

    emitRemoteState({ position: 200, paused: false, doSeek: true, setBy: 'peer' })

    expect(v.currentTime).toBe(200)
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
    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()
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

    sendSnapshot.mockClear()
    client.onVideoTimeUpdate()
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
})
