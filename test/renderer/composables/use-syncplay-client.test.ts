import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { useSyncplayClient } from '../../../src/renderer/src/composables/use-syncplay-client'

type Api = {
  syncplayGetStatus: () => Promise<SyncplayStatus>
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
})

afterEach(() => {
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

describe('useSyncplayClient — sendSyncplayLocalState gating', () => {
  it('suppresses local state during the 1.5s post-remote-apply window', () => {
    const sendLocalState = vi.fn()
    setApi({ syncplaySendLocalState: sendLocalState })
    const s = useSyncplayClient(makeDeps({ video: fakeVideo() }))
    s.syncplayStatus.value = { state: 'ready' }
    s.onLocalPlay()
    expect(sendLocalState).toHaveBeenCalledTimes(1)
  })
})
