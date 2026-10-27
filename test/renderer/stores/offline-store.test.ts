import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

type Listener = (state: OfflineState) => void

const ONLINE: OfflineState = { mode: 'online', since: 1, lastProbeAt: null }
const AUTO: OfflineState = { mode: 'offline-auto', since: 2, lastProbeAt: 2 }
const MANUAL: OfflineState = { mode: 'offline-manual', since: 3, lastProbeAt: null }

let listeners: Listener[]
let api: {
  offlineGetState: ReturnType<typeof vi.fn>
  offlineSetManual: ReturnType<typeof vi.fn>
  offlineRetry: ReturnType<typeof vi.fn>
  onOfflineStateChanged: (cb: Listener) => () => void
}

function installApi(seed: OfflineState = ONLINE): void {
  listeners = []
  api = {
    offlineGetState: vi.fn(async () => seed),
    offlineSetManual: vi.fn(async (on: boolean) => (on ? MANUAL : ONLINE)),
    offlineRetry: vi.fn(async () => ONLINE),
    onOfflineStateChanged: (cb) => {
      listeners.push(cb)
      return () => {}
    }
  }
  ;(globalThis as { window?: { api: unknown } }).window = { api }
}

async function loadStore(): Promise<
  ReturnType<(typeof import('../../../src/renderer/src/stores/offline'))['useOfflineStore']>
> {
  const { useOfflineStore } = await import('../../../src/renderer/src/stores/offline')
  return useOfflineStore()
}

beforeEach(() => {
  installApi()
  setActivePinia(createPinia())
  vi.resetModules()
})

describe('useOfflineStore (#567)', () => {
  it('subscribes once and seeds from main', async () => {
    installApi(AUTO)
    const store = await loadStore()
    expect(listeners).toHaveLength(1)
    await vi.waitFor(() => expect(store.state.mode).toBe('offline-auto'))
    expect(store.isOffline).toBe(true)
    expect(store.isManual).toBe(false)
    // A second consumer shares the singleton: still one subscription.
    await loadStore()
    expect(listeners).toHaveLength(1)
  })

  it('follows the broadcast', async () => {
    const store = await loadStore()
    listeners[0](MANUAL)
    expect(store.isOffline).toBe(true)
    expect(store.isManual).toBe(true)
    listeners[0](ONLINE)
    expect(store.isOffline).toBe(false)
  })

  it('setManual() goes through main and takes its answer', async () => {
    const store = await loadStore()
    await store.setManual(true)
    expect(api.offlineSetManual).toHaveBeenCalledWith(true)
    expect(store.state).toEqual(MANUAL)
    await store.setManual(false)
    expect(store.state).toEqual(ONLINE)
  })

  it('retry() probes through main, once at a time', async () => {
    installApi(AUTO)
    let release!: (s: OfflineState) => void
    api.offlineRetry.mockImplementation(() => new Promise<OfflineState>((r) => (release = r)))
    const store = await loadStore()
    const first = store.retry()
    expect(store.retrying).toBe(true)
    await store.retry()
    expect(api.offlineRetry).toHaveBeenCalledTimes(1)
    release(ONLINE)
    await first
    expect(store.retrying).toBe(false)
    expect(store.state).toEqual(ONLINE)
  })

  it('clears retrying when the retry fails', async () => {
    const store = await loadStore()
    api.offlineRetry.mockRejectedValueOnce(new Error('ipc gone'))
    await expect(store.retry()).rejects.toThrow('ipc gone')
    expect(store.retrying).toBe(false)
  })
})
