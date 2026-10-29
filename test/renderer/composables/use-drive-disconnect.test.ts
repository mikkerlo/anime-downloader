// @vitest-environment happy-dom
//
// The player's disconnect overlay (#582), against the real shared-libraries
// store: an `anime-video://` `<video>` error raises it only when the store
// reports the library unavailable within one poll interval (at once when it
// already does), Retry is enabled only once the library is available again, and
// it never retries by itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  DISCONNECT_WAIT_MS,
  useDriveDisconnect
} from '../../../src/renderer/src/composables/use-drive-disconnect'
import { useSharedLibrariesStore } from '../../../src/renderer/src/stores/shared-libraries'

const LIB = '5d7c1f3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f'

let available = true
let changed: (() => void) | null = null

function lib(): AttachedLibraryInfo {
  return {
    libraryId: LIB,
    root: '/media/usb/Fixture library',
    name: 'Fixture library',
    mode: 'metadata',
    ownerNickname: 'owner',
    role: 'owner',
    access: 'read-write',
    available,
    lastSeenAt: 1_000,
    lastSyncAt: null,
    pathOverflow: 0,
    mkvCount: 0,
    titles: []
  }
}

/** What main does when the poller sees the drive change: a broadcast, then the store re-lists. */
async function poll(next: boolean): Promise<void> {
  available = next
  changed!()
  await flushPromises()
}

async function rig(libraryId = LIB) {
  const store = useSharedLibrariesStore()
  await flushPromises()
  const savePosition = vi.fn()
  const pause = vi.fn()
  const reopen = vi.fn(async () => true)
  const d = useDriveDisconnect({
    getLibraryId: () => libraryId,
    isAvailable: (id) => store.isAvailable(id),
    waitForUnavailable: (id, ms) => store.waitForUnavailable(id, ms),
    savePosition,
    pause,
    reopen
  })
  return { d, store, savePosition, pause, reopen }
}

beforeEach(() => {
  setActivePinia(createPinia())
  available = true
  changed = null
  ;(window as unknown as { api: unknown }).api = {
    sharedLibraryList: vi.fn(async () => [lib()]),
    ffmpegCheck: vi.fn(async () => ({ available: true })),
    onSharedLibrariesChanged: (cb: () => void) => {
      changed = cb
      return () => {}
    },
    onSharedLibraryFound: () => () => {},
    syncGetStatus: async () => ({ running: [], libraries: {} }),
    onSyncRunFinished: () => () => {}
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a <video> error on an attached title (anime-video://)', () => {
  it('shows the overlay once SHARED_LIBRARIES_CHANGED reports available: false within the wait', async () => {
    const { d, savePosition, pause } = await rig()
    vi.useFakeTimers()
    const outcome = d.onVideoError()
    await vi.advanceTimersByTimeAsync(DISCONNECT_WAIT_MS - 1_000)
    expect(d.disconnected.value).toBe(false)
    await poll(false)
    expect(await outcome).toBe('overlay')
    expect(d.disconnected.value).toBe(true)
    expect(savePosition).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('a library that stays available is the generic error (a sleeping drive that woke up)', async () => {
    const { d, savePosition } = await rig()
    vi.useFakeTimers()
    const outcome = d.onVideoError()
    await vi.advanceTimersByTimeAsync(DISCONNECT_WAIT_MS)
    expect(await outcome).toBe('generic')
    expect(d.disconnected.value).toBe(false)
    expect(savePosition).not.toHaveBeenCalled()
    // A report after the wait is not this error's.
    await poll(false)
    expect(d.disconnected.value).toBe(false)
  })

  it("doesn't wait when the store already knows the library is unavailable", async () => {
    const { d } = await rig()
    await poll(false)
    vi.useFakeTimers()
    const outcome = d.onVideoError()
    // No timer advanced: it resolves on the store's current state.
    await vi.advanceTimersByTimeAsync(0)
    expect(await outcome).toBe('overlay')
    expect(d.disconnected.value).toBe(true)
  })

  it('a file not on an attached drive is ignored', async () => {
    const { d, savePosition } = await rig('')
    expect(await d.onVideoError()).toBe('ignored')
    expect(savePosition).not.toHaveBeenCalled()
  })

  it('a stall and the error that follows it are one check: one wait, one save, one overlay', async () => {
    const { d, store, savePosition, pause } = await rig()
    const wait = vi.spyOn(store, 'waitForUnavailable')
    vi.useFakeTimers()
    const stall = d.onVideoError()
    await vi.advanceTimersByTimeAsync(3_000)
    const error = d.onVideoError()
    expect(error).toBe(stall)
    await poll(false)
    expect(await stall).toBe('overlay')
    expect(wait).toHaveBeenCalledTimes(1)
    expect(savePosition).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('the wait covers a whole poll interval and the tick after it', () => {
    expect(DISCONNECT_WAIT_MS).toBeGreaterThan(10_000)
  })
})

describe('MSE: main said drive-disconnected', () => {
  it('raises the overlay and pauses; the position was saved by the MSE composable', async () => {
    const { d, pause, savePosition } = await rig()
    d.onMseDisconnected()
    expect(d.disconnected.value).toBe(true)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(savePosition).not.toHaveBeenCalled()
  })
})

describe('Retry', () => {
  it('is enabled only after available: true, re-opens, and closes the overlay', async () => {
    const { d, reopen } = await rig()
    await poll(false)
    d.onMseDisconnected()
    expect(d.retryEnabled.value).toBe(false)
    await d.retry()
    expect(reopen).not.toHaveBeenCalled()
    await poll(true)
    expect(d.retryEnabled.value).toBe(true)
    await d.retry()
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(d.disconnected.value).toBe(false)
  })

  it('a reopen that fails keeps the overlay with a message, and nothing retries by itself', async () => {
    const { d, reopen } = await rig()
    reopen.mockResolvedValue(false)
    d.onMseDisconnected()
    await d.retry()
    expect(d.disconnected.value).toBe(true)
    expect(d.retryError.value).toBe("The episode still can't be opened from the drive.")
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    await poll(false)
    await poll(true)
    expect(reopen).toHaveBeenCalledTimes(1)
  })
})
