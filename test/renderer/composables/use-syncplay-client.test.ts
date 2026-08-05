// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
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

afterEach(() => {
  mountedWrappers.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
})

type Deps = Parameters<typeof useSyncplayClient>[0]

function makeDeps(
  overrides: {
    video?: HTMLVideoElement | null
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
    getVideoEl: () => overrides.video ?? null,
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

// applyRemoteState lives behind the onSyncplayRemoteState subscription, which
// is only wired in onMounted — so reaching it needs a real mount plus a stub
// that hands the callback back out.
async function mountWithRemoteState(
  deps: Deps,
  status: SyncplayStatus = { state: 'ready' }
): Promise<{
  client: Client
  emitRemoteState: (s: Partial<SyncplayRemoteState>) => void
  wrapper: ReturnType<typeof mount>
}> {
  let cb: ((s: SyncplayRemoteState) => void) | null = null
  setApi({
    onSyncplayRemoteState: (fn: (s: SyncplayRemoteState) => void) => {
      cb = fn
      return () => {}
    }
  })
  let client: Client | null = null
  const Host = defineComponent({
    setup() {
      client = useSyncplayClient(deps)
      return () => null
    }
  })
  const wrapper = mount(Host)
  mountedWrappers.push(wrapper)
  await flushPromises()
  client!.syncplayStatus.value = status
  // Typed rather than cast: a fifth required field on SyncplayRemoteState must
  // fail typecheck here, not leave every test below delivering a payload main
  // would never send.
  const base: SyncplayRemoteState = { position: 0, paused: true, doSeek: false, setBy: null }
  return {
    client: client!,
    emitRemoteState: (s) => cb?.({ ...base, ...s }),
    wrapper
  }
}

// NEEDS `readyState: 1` UNDER #240. That issue forks applyRemoteState on
// `v.readyState >= 1` and parks the state below it; with no readyState here
// `undefined >= 1` is false, so every remote apply in this file would defer and
// the apply-rule and 1.5s-window tests go red at once. Default it to 1 there.
function fakeVideo(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  const v: Record<string, unknown> = {
    currentTime: 0,
    duration: 1440,
    paused: true,
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
      duration: 1500
    })
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
  function mountHost(deps: Deps): ReturnType<typeof mount> {
    const Host = defineComponent({
      setup() {
        useSyncplayClient(deps)
        return () => null
      }
    })
    return mount(Host)
  }

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
    const wrapper = mountHost(
      makeDeps({ video: v, animeId: 42, animeName: 'COTE', episodeInt: '7', translationId: 123 })
    )
    await flushPromises()

    expect(setFile).toHaveBeenCalledWith(
      expect.objectContaining({ animeId: 42, canonicalName: 'COTE - 7', duration: 1500 })
    )
    wrapper.unmount()
  })

  it('does not push on mount when there is no active session', async () => {
    const setFile = vi.fn()
    setApi({ syncplaySetFile: setFile })
    const wrapper = mountHost(makeDeps({ video: fakeVideo() }))
    await flushPromises()
    expect(setFile).not.toHaveBeenCalled()
    wrapper.unmount()
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
  // Characterization of today's behavior, and precisely the defect #239 is
  // filed against: this seek is the user's, to a position nobody applied, and
  // the room never hears about it. When #239 lands this expectation flips.
  it('swallows a user seek to an unrelated position inside the 1.5s window (#239)', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client, wrapper } = await mountWithRemoteState(
      makeDeps({ video: v }),
      { state: 'ready' }
    )

    // A remote seek arms the window and moves the element to 300.
    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // 200 ms later the user drags the scrubber somewhere else entirely, so the
    // value guard does not match and only the wall clock can suppress it.
    vi.advanceTimersByTime(200)
    v.currentTime = 900
    client.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('sends that same seek once the window has expired', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client, wrapper } = await mountWithRemoteState(
      makeDeps({ video: v }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    vi.advanceTimersByTime(1501)
    v.currentTime = 900
    client.onVideoSeeked()

    expect(sendLocalState).toHaveBeenCalledWith({ paused: true, position: 900, cause: 'seek' })
    wrapper.unmount()
  })

  // The value-keyed guard is the one that must catch the element's own echo,
  // however late it fires — this is what makes the window a backstop and not
  // the mechanism.
  it('swallows the echo of an applied seek even after the window has expired', async () => {
    vi.useFakeTimers()
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client, wrapper } = await mountWithRemoteState(
      makeDeps({ video: v }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 300, paused: true, doSeek: true })
    sendLocalState.mockClear()

    // A slow network stream takes longer than the window to land the seek.
    vi.advanceTimersByTime(4000)
    v.currentTime = 300
    client.onVideoSeeked()

    expect(sendLocalState).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

// applyRemoteState is reachable only through the onSyncplayRemoteState
// subscription — it is not on the returned surface — and the default API stub
// wires that to noopSub, so before this block no test ever delivered a remote
// state and the whole apply rule was uncovered.
describe('useSyncplayClient — applyRemoteState', () => {
  it('seeks when the room says doSeek, however small the drift', async () => {
    const v = fakeVideo({ currentTime: 100, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, wrapper } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 101, paused: true, doSeek: true })

    expect(v.currentTime).toBe(101)
    wrapper.unmount()
  })

  it('seeks on drift over the 3s tolerance and ignores drift under it', async () => {
    const v = fakeVideo({ currentTime: 100, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, wrapper } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 102, paused: true, doSeek: false })
    expect(v.currentTime).toBe(100)

    emitRemoteState({ position: 110, paused: true, doSeek: false })
    expect(v.currentTime).toBe(110)
    wrapper.unmount()
  })

  it('clamps a negative remote position to 0 rather than writing it', async () => {
    const v = fakeVideo({ currentTime: 100, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, wrapper } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: -5, paused: true, doSeek: true })

    expect(v.currentTime).toBe(0)
    wrapper.unmount()
  })

  it('plays and pauses the element to match the room', async () => {
    const v = fakeVideo({ currentTime: 10, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, wrapper } = await mountWithRemoteState(makeDeps({ video: v }), {
      state: 'ready'
    })

    emitRemoteState({ position: 10, paused: false, doSeek: false })
    expect(v.play).toHaveBeenCalled()

    v.paused = false
    emitRemoteState({ position: 10, paused: true, doSeek: false })
    expect(v.pause).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('records who paused the room and clears it on resume', async () => {
    const v = fakeVideo({ currentTime: 10, paused: false } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client, wrapper } = await mountWithRemoteState(
      makeDeps({ video: v }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 10, paused: true, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBe('peer')

    v.paused = true
    emitRemoteState({ position: 10, paused: false, doSeek: false, setBy: 'peer' })
    expect(client.syncplayPausedBy.value).toBeNull()
    wrapper.unmount()
  })

  it('toasts a remote seek that names its author', async () => {
    const v = fakeVideo({ currentTime: 0, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client, wrapper } = await mountWithRemoteState(
      makeDeps({ video: v }),
      { state: 'ready' }
    )

    emitRemoteState({ position: 125, paused: true, doSeek: true, setBy: 'peer' })

    expect(client.syncplayToast.value).toBe('peer seeked to 2:05')
    wrapper.unmount()
  })

  // The room saying "playing" is not enough on its own: a peer still buffering
  // holds the gate down, and applying the room's play there would resume a
  // client the rest of the room is waiting for.
  //
  // REPLACE WITH #240. Not because it goes red — the `readyState: 1` default
  // above keeps it on the immediate path — but because it can only ever pass
  // through the `!needsSeek && !needsPlayPause` early return
  // (`use-syncplay-client.ts:263`): position matches and the element is already
  // paused, so it never observes *when* effectivePaused was computed. #240
  // replaces it with the live-roster case: park at an explicit `readyState: 0`
  // with every peer ready, flip one to not-ready, fire loadedmetadata, assert
  // no play(). effectivePaused is recomputed at apply time precisely so that
  // case fails on a park-time snapshot.
  it('keeps the element paused while a peer is not ready, even on a playing room', async () => {
    const v = fakeVideo({ currentTime: 10, paused: true } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client, wrapper } = await mountWithRemoteState(
      makeDeps({ video: v }),
      { state: 'ready' }
    )
    client.syncplayRoomUsers.value = [{ username: 'peer', file: null, isReady: false }]

    emitRemoteState({ position: 10, paused: false, doSeek: false })

    expect(v.play).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  // The other half of the same fold, and the more interesting one: we are
  // already playing when a peer starts buffering. effectivePaused flips to
  // true, so needsPlayPause becomes true and the room stalls us — this is the
  // only case that reaches the pause arm rather than the early return above.
  it('pauses an already-playing element when a peer goes not ready', async () => {
    const v = fakeVideo({ currentTime: 10, paused: false } as Partial<HTMLVideoElement>)
    const { emitRemoteState, client, wrapper } = await mountWithRemoteState(
      makeDeps({ video: v }),
      { state: 'ready' }
    )
    client.syncplayRoomUsers.value = [{ username: 'peer', file: null, isReady: false }]

    emitRemoteState({ position: 10, paused: false, doSeek: false })

    expect(v.pause).toHaveBeenCalled()
    expect(v.play).not.toHaveBeenCalled()
    wrapper.unmount()
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
})
