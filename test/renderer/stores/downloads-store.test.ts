import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Listener<T> = (data: T) => void

type Captured = {
  downloadProgress: Listener<unknown>[]
  scanMergeProgress: Listener<unknown>[]
  fixMetadataProgress: Listener<unknown>[]
  downloadGetQueue: ReturnType<typeof vi.fn>
}

let captured: Captured

function installApi(): void {
  captured = {
    downloadProgress: [],
    scanMergeProgress: [],
    fixMetadataProgress: [],
    downloadGetQueue: vi.fn(async () => [{ animeName: 'x', episodes: [] }])
  }
  ;(globalThis as { window?: { api: unknown } }).window = {
    api: {
      onDownloadProgress: (cb: Listener<unknown>) => {
        captured.downloadProgress.push(cb)
        return () => {}
      },
      onScanMergeProgress: (cb: Listener<unknown>) => {
        captured.scanMergeProgress.push(cb)
        return () => {}
      },
      onFixMetadataProgress: (cb: Listener<unknown>) => {
        captured.fixMetadataProgress.push(cb)
        return () => {}
      },
      downloadGetQueue: captured.downloadGetQueue
    }
  }
}

beforeEach(() => {
  installApi()
  setActivePinia(createPinia())
  // Drop any prior module cache so the store re-binds against the fresh stub.
  vi.resetModules()
})

describe('useDownloadsStore', () => {
  it('subscribes to all three broadcasts at construction', async () => {
    const { useDownloadsStore } = await import('../../../src/renderer/src/stores/downloads')
    useDownloadsStore()
    expect(captured.downloadProgress.length).toBe(1)
    expect(captured.scanMergeProgress.length).toBe(1)
    expect(captured.fixMetadataProgress.length).toBe(1)
  })

  it('updates groups when onDownloadProgress fires', async () => {
    const { useDownloadsStore } = await import('../../../src/renderer/src/stores/downloads')
    const store = useDownloadsStore()
    expect(store.groups).toEqual([])
    captured.downloadProgress[0]([{ animeName: 'A', episodes: ['1'] }])
    expect(store.groups).toEqual([{ animeName: 'A', episodes: ['1'] }])
  })

  it('updates scanMergeProgress when onScanMergeProgress fires', async () => {
    const { useDownloadsStore } = await import('../../../src/renderer/src/stores/downloads')
    const store = useDownloadsStore()
    expect(store.scanMergeProgress).toBeNull()
    captured.scanMergeProgress[0]({ current: 3, total: 10 })
    expect(store.scanMergeProgress).toEqual({ current: 3, total: 10 })
  })

  it('updates fixMetadataProgress when onFixMetadataProgress fires', async () => {
    const { useDownloadsStore } = await import('../../../src/renderer/src/stores/downloads')
    const store = useDownloadsStore()
    expect(store.fixMetadataProgress).toBeNull()
    captured.fixMetadataProgress[0]({ current: 1, total: 5, file: 'a.mkv' })
    expect(store.fixMetadataProgress).toEqual({ current: 1, total: 5, file: 'a.mkv' })
  })

  it('refreshQueue() pulls the queue from IPC and assigns groups', async () => {
    const { useDownloadsStore } = await import('../../../src/renderer/src/stores/downloads')
    const store = useDownloadsStore()
    await store.refreshQueue()
    expect(captured.downloadGetQueue).toHaveBeenCalledTimes(1)
    expect(store.groups).toEqual([{ animeName: 'x', episodes: [] }])
  })

  it('reuses the same store singleton — subscriptions are not duplicated', async () => {
    const { useDownloadsStore } = await import('../../../src/renderer/src/stores/downloads')
    useDownloadsStore()
    useDownloadsStore()
    useDownloadsStore()
    expect(captured.downloadProgress.length).toBe(1)
  })
})
