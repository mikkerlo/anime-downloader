import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Listener<T> = (data: T) => void

type FfmpegProgress = { status: string; progress?: number; message?: string }

type Captured = {
  ffmpeg: Listener<FfmpegProgress>[]
  fpcalc: Listener<{ status: string; progress?: number }>[]
  updateStatus: Listener<unknown>[]
  getSetting: ReturnType<typeof vi.fn>
}

let captured: Captured

function installApi(getSetting?: ReturnType<typeof vi.fn>): void {
  captured = {
    ffmpeg: [],
    fpcalc: [],
    updateStatus: [],
    getSetting: getSetting ?? vi.fn(async () => ({ back: 'Escape', focusSearch: 'Ctrl+F' }))
  }
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      onFfmpegDownloadProgress: (cb: Listener<FfmpegProgress>) => {
        captured.ffmpeg.push(cb)
        return () => {}
      },
      onFpcalcDownloadProgress: (cb: Listener<{ status: string; progress?: number }>) => {
        captured.fpcalc.push(cb)
        return () => {}
      },
      onUpdateStatus: (cb: Listener<unknown>) => {
        captured.updateStatus.push(cb)
        return () => {}
      },
      getSetting: captured.getSetting
    }
  }
}

beforeEach(() => {
  installApi()
  setActivePinia(createPinia())
  vi.resetModules()
})

describe('useSettingsStore', () => {
  it('subscribes to ffmpeg, fpcalc, and update-status broadcasts', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    useSettingsStore()
    expect(captured.ffmpeg.length).toBe(1)
    expect(captured.fpcalc.length).toBe(1)
    expect(captured.updateStatus.length).toBe(1)
  })

  it('toggles ffmpegDownloading on/off based on status payload', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    expect(store.ffmpegDownloading).toBe(false)
    captured.ffmpeg[0]({ status: 'downloading', progress: 42 })
    expect(store.ffmpegDownloading).toBe(true)
    expect(store.ffmpegProgress).toBe(42)
    captured.ffmpeg[0]({ status: 'done' })
    expect(store.ffmpegDownloading).toBe(false)
  })

  it('parks the reason in ffmpegError on a "failed" payload', async () => {
    // On main a 'failed' status falls into the bare `else`, which only clears
    // ffmpegDownloading — the overlay vanishes as if the install had worked and
    // the message is dropped on the floor (#469).
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    captured.ffmpeg[0]({ status: 'downloading', progress: 30 })
    captured.ffmpeg[0]({
      status: 'failed',
      message: 'ffmpeg: ffmpeg-6.1-linux-64.zip is not a valid zip archive'
    })
    expect(store.ffmpegDownloading).toBe(false)
    expect(store.ffmpegError).toBe('ffmpeg: ffmpeg-6.1-linux-64.zip is not a valid zip archive')
  })

  it('falls back to a generic reason when a "failed" payload carries no message', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    captured.ffmpeg[0]({ status: 'failed' })
    expect(store.ffmpegError).toBe('ffmpeg installation failed.')
  })

  it('clearFfmpegError empties the error (the Dismiss button contract)', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    captured.ffmpeg[0]({ status: 'failed', message: 'boom' })
    expect(store.ffmpegError).toBe('boom')
    store.clearFfmpegError()
    expect(store.ffmpegError).toBe('')
  })

  it('a later "downloading" tick clears a stale ffmpegError', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    captured.ffmpeg[0]({ status: 'failed', message: 'boom' })
    captured.ffmpeg[0]({ status: 'downloading', progress: 10 })
    expect(store.ffmpegError).toBe('')
    expect(store.ffmpegDownloading).toBe(true)
    expect(store.ffmpegProgress).toBe(10)
  })

  it('defaults ffmpegProgress to 0 when the payload omits it', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    captured.ffmpeg[0]({ status: 'downloading' })
    expect(store.ffmpegProgress).toBe(0)
  })

  it('mirrors fpcalc download status separately from ffmpeg', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    captured.fpcalc[0]({ status: 'downloading', progress: 17 })
    expect(store.fpcalcDownloading).toBe(true)
    expect(store.fpcalcProgress).toBe(17)
    expect(store.ffmpegDownloading).toBe(false)
  })

  it('replaces updateStatus wholesale', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    expect(store.updateStatus).toEqual({ status: 'idle' })
    captured.updateStatus[0]({ status: 'downloading', percent: 50 })
    expect(store.updateStatus).toEqual({ status: 'downloading', percent: 50 })
  })

  it('loadShortcuts reads keyboardShortcuts and assigns to shortcuts', async () => {
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    await store.loadShortcuts()
    expect(captured.getSetting).toHaveBeenCalledWith('keyboardShortcuts')
    expect(store.shortcuts).toEqual({ back: 'Escape', focusSearch: 'Ctrl+F' })
  })

  it('loadShortcuts defaults to empty object when setting is missing', async () => {
    installApi(vi.fn(async () => null))
    setActivePinia(createPinia())
    const { useSettingsStore } = await import('../../../src/renderer/src/stores/settings')
    const store = useSettingsStore()
    await store.loadShortcuts()
    expect(store.shortcuts).toEqual({})
  })
})
