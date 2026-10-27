import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import {
  createOfflineService,
  probeHost,
  PROBE_TIMEOUT_MS,
  REPROBE_MAX_MS,
  REPROBE_MIN_MS,
  type OfflineService
} from '../../src/main/services/offline'
import {
  AUTO_DOWNLOAD_STAGGER_MS,
  PREFETCH_STAGGER_MS,
  createOfflineKickoff,
  type OfflineKickoffDeps
} from '../../src/main/services/offline/kickoff'
import { OfflineError, TimeoutError } from '../../src/main/lib/net'
import { InMemoryStorage } from '../helpers/in-memory-storage'

const SMOTRET = 'https://smotret.test/api'
const SHIKI = 'https://shiki.test'

interface Harness {
  service: OfflineService
  store: InMemoryStorage
  probe: Mock<(url: string) => Promise<boolean>>
  onOnline: Mock
  onOffline: Mock
  changes: OfflineState[]
  /** Which hosts answer the next probes. */
  up: Set<string>
}

function harness(initial: Record<string, unknown> = {}): Harness {
  const store = new InMemoryStorage(initial)
  const up = new Set<string>([SMOTRET, SHIKI])
  const probe = vi.fn(async (url: string) => up.has(url))
  const onOnline = vi.fn()
  const onOffline = vi.fn()
  const service = createOfflineService({
    store,
    probeUrls: () => [SMOTRET, SHIKI],
    probe,
    onOnline,
    onOffline
  })
  const changes: OfflineState[] = []
  service.onChange((s) => changes.push(s))
  return { service, store, probe, onOnline, onOffline, changes, up }
}

/** Reports a failure the way `net.ts` does and lets the probe settle. */
async function fail(h: Harness, err: unknown): Promise<void> {
  h.service.observer.onFailure(err, `${SMOTRET}/series`)
  await vi.advanceTimersByTimeAsync(0)
}

const netError = (): Error =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OfflineService — auto-detect needs a probe', () => {
  it('a TypeError from a bug, with the probe succeeding, stays online', async () => {
    const h = harness()
    await fail(h, new TypeError("Cannot read properties of undefined (reading 'id')"))
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(h.service.getState().mode).toBe('online')
    expect(h.service.isOffline()).toBe(false)
    expect(h.onOffline).not.toHaveBeenCalled()
  })

  it('a network error with both probes failing goes offline-auto', async () => {
    const h = harness()
    h.up.clear()
    await fail(h, netError())
    expect(h.service.getState().mode).toBe('offline-auto')
    expect(h.service.isOffline()).toBe(true)
    expect(h.onOffline).toHaveBeenCalledTimes(1)
    expect(h.changes.map((c) => c.mode)).toEqual(['offline-auto'])
    expect(h.service.getState().lastProbeAt).not.toBeNull()
  })

  it('one host up while the other is down stays online', async () => {
    const h = harness()
    h.up.delete(SHIKI)
    await fail(h, netError())
    expect(h.service.getState().mode).toBe('online')
    expect(h.onOffline).not.toHaveBeenCalled()
  })

  it('ignores OfflineError (self-inflicted) and non-network errors without probing', async () => {
    const h = harness()
    await fail(h, new OfflineError())
    await fail(h, new Error('HTTP 500'))
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('counts a timeout as a network failure', async () => {
    const h = harness()
    h.up.clear()
    await fail(h, new TimeoutError('No response within 15000 ms'))
    expect(h.service.getState().mode).toBe('offline-auto')
  })

  it('coalesces failures that arrive while a probe is in flight', async () => {
    const h = harness()
    const pending: Array<(v: boolean) => void> = []
    h.probe.mockImplementation(() => new Promise<boolean>((r) => pending.push(r)))
    h.service.observer.onFailure(netError(), SMOTRET)
    h.service.observer.onFailure(netError(), SHIKI)
    h.service.observer.onFailure(netError(), SHIKI)
    expect(h.probe).toHaveBeenCalledTimes(2)
    for (const release of pending) release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.service.getState().lastProbeAt).not.toBeNull()
  })
})

describe('OfflineService — offline-auto recovery', () => {
  async function goOffline(h: Harness): Promise<void> {
    h.up.clear()
    await fail(h, netError())
    expect(h.service.getState().mode).toBe('offline-auto')
    h.probe.mockClear()
  }

  it('re-probes with backoff, 15 s doubling to 2 min, and comes back online', async () => {
    const h = harness()
    await goOffline(h)
    const gaps = [15_000, 30_000, 60_000, 120_000, 120_000]
    expect(gaps[0]).toBe(REPROBE_MIN_MS)
    expect(gaps[3]).toBe(REPROBE_MAX_MS)
    for (const gap of gaps) {
      const before = h.probe.mock.calls.length
      await vi.advanceTimersByTimeAsync(gap - 1)
      expect(h.probe.mock.calls.length).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(h.probe.mock.calls.length).toBe(before + 2)
    }
    h.up.add(SHIKI)
    await vi.advanceTimersByTimeAsync(REPROBE_MAX_MS)
    expect(h.service.getState().mode).toBe('online')
    expect(h.onOnline).toHaveBeenCalledTimes(1)
  })

  it('retryNow() probes at once instead of waiting out the backoff', async () => {
    const h = harness()
    await goOffline(h)
    h.up.add(SMOTRET)
    const state = await h.service.retryNow()
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(state.mode).toBe('online')
    expect(h.onOnline).toHaveBeenCalledTimes(1)
    // The pending backoff probe was cancelled.
    h.probe.mockClear()
    await vi.advanceTimersByTimeAsync(REPROBE_MAX_MS)
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('retryNow() joins a probe already in flight', async () => {
    const h = harness()
    await goOffline(h)
    const pending: Array<(v: boolean) => void> = []
    h.probe.mockImplementation(() => new Promise<boolean>((r) => pending.push(r)))
    const a = h.service.retryNow()
    const b = h.service.retryNow()
    expect(h.probe).toHaveBeenCalledTimes(2)
    for (const release of pending) release(true)
    const [sa, sb] = await Promise.all([a, b])
    expect(sa.mode).toBe('online')
    expect(sb.mode).toBe('online')
    expect(h.onOnline).toHaveBeenCalledTimes(1)
  })

  it('a probe answered while offline-auto that still fails keeps it offline and re-arms', async () => {
    const h = harness()
    await goOffline(h)
    await h.service.retryNow()
    expect(h.service.getState().mode).toBe('offline-auto')
    expect(h.onOnline).not.toHaveBeenCalled()
  })
})

describe('OfflineService — manual mode', () => {
  it('starts in offline-manual when workOffline is persisted', () => {
    const h = harness({ workOffline: true })
    expect(h.service.getState().mode).toBe('offline-manual')
    expect(h.service.isOffline()).toBe(true)
  })

  it('setManual(true) persists, goes offline and never probes or self-clears', async () => {
    const h = harness()
    const state = h.service.setManual(true)
    expect(state.mode).toBe('offline-manual')
    expect(h.store.get('workOffline')).toBe(true)
    expect(h.onOffline).toHaveBeenCalledTimes(1)
    await fail(h, netError())
    await h.service.retryNow()
    await vi.advanceTimersByTimeAsync(10 * REPROBE_MAX_MS)
    expect(h.probe).not.toHaveBeenCalled()
    expect(h.service.getState().mode).toBe('offline-manual')
    expect(h.onOnline).not.toHaveBeenCalled()
  })

  it('setManual(false) persists and goes online, running the online edge once', () => {
    const h = harness({ workOffline: true })
    const state = h.service.setManual(false)
    expect(state.mode).toBe('online')
    expect(h.store.get('workOffline')).toBe(false)
    expect(h.onOnline).toHaveBeenCalledTimes(1)
    expect(h.changes.map((c) => c.mode)).toEqual(['online'])
  })

  it('manual over offline-auto stops the backoff probes and does not re-run the offline edge', async () => {
    const h = harness()
    h.up.clear()
    await fail(h, netError())
    h.probe.mockClear()
    h.service.setManual(true)
    expect(h.onOffline).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * REPROBE_MAX_MS)
    expect(h.probe).not.toHaveBeenCalled()
  })

  it('a probe in flight when manual mode starts does not override it', async () => {
    const h = harness()
    const pending: Array<(v: boolean) => void> = []
    h.probe.mockImplementation(() => new Promise<boolean>((r) => pending.push(r)))
    h.service.observer.onFailure(netError(), SMOTRET)
    h.service.setManual(true)
    expect(pending).toHaveLength(2)
    for (const release of pending) release(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.service.getState().mode).toBe('offline-manual')
    expect(h.onOnline).not.toHaveBeenCalled()
  })

  it('onChange returns an unsubscribe handle', () => {
    const h = harness()
    const seen: string[] = []
    const off = h.service.onChange((s) => seen.push(s.mode))
    h.service.setManual(true)
    off()
    h.service.setManual(false)
    expect(seen).toEqual(['offline-manual'])
  })
})

describe('OfflineService — the online transition runs the kick-off once', () => {
  it('calls the injected syncShikimoriQueue exactly once per online edge', async () => {
    const syncShikimoriQueue = vi.fn(async () => undefined)
    const kickoff = createOfflineKickoff({
      syncShikimoriQueue,
      suspendDownloads: vi.fn(),
      resumeDownloads: vi.fn(),
      suspendSyncplay: vi.fn(),
      resumeSyncplay: vi.fn(),
      retryBinaries: vi.fn(),
      runAutoDownloadTick: vi.fn(),
      prefetchShikimoriDetails: vi.fn()
    })
    const service = createOfflineService({
      store: new InMemoryStorage({ workOffline: true }),
      probeUrls: () => [SMOTRET, SHIKI],
      probe: async () => true,
      onOnline: kickoff.onOnline,
      onOffline: kickoff.onOffline
    })
    service.setManual(false)
    expect(syncShikimoriQueue).toHaveBeenCalledTimes(1)
    // Already online: a second "go online" is not an edge.
    service.setManual(false)
    await service.retryNow()
    expect(syncShikimoriQueue).toHaveBeenCalledTimes(1)
  })
})

describe('probeHost', () => {
  let realFetch: typeof globalThis.fetch
  beforeEach(() => {
    realFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it.each([200, 404, 405, 503])('counts an HTTP %i answer as reachable', async (status) => {
    const stub = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status })
    )
    globalThis.fetch = stub
    expect(await probeHost(SHIKI)).toBe(true)
    expect(stub.mock.calls[0][1]).toMatchObject({ method: 'HEAD' })
  })

  it('counts a thrown network error as down', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await probeHost(SHIKI)).toBe(false)
  })

  it('counts a host that never answers as down after 5 s', async () => {
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {}))
    let result: boolean | undefined
    void probeHost(SHIKI).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toBe(false)
  })
})

describe('createOfflineKickoff', () => {
  function deps(): { [K in keyof OfflineKickoffDeps]: Mock } {
    return {
      syncShikimoriQueue: vi.fn(async () => undefined),
      suspendDownloads: vi.fn(),
      resumeDownloads: vi.fn(),
      suspendSyncplay: vi.fn(),
      resumeSyncplay: vi.fn(),
      retryBinaries: vi.fn(async () => undefined),
      runAutoDownloadTick: vi.fn(async () => undefined),
      prefetchShikimoriDetails: vi.fn(async () => undefined)
    }
  }

  it('online: drain, downloads, Syncplay and binaries at once; auto-download and prefetch staggered', async () => {
    const d = deps()
    createOfflineKickoff(d).onOnline()
    for (const k of [
      'syncShikimoriQueue',
      'resumeDownloads',
      'resumeSyncplay',
      'retryBinaries'
    ] as const) {
      expect(d[k]).toHaveBeenCalledTimes(1)
    }
    expect(d.runAutoDownloadTick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AUTO_DOWNLOAD_STAGGER_MS)
    expect(d.runAutoDownloadTick).toHaveBeenCalledTimes(1)
    expect(d.prefetchShikimoriDetails).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(PREFETCH_STAGGER_MS - AUTO_DOWNLOAD_STAGGER_MS)
    expect(d.prefetchShikimoriDetails).toHaveBeenCalledTimes(1)
    expect(d.suspendDownloads).not.toHaveBeenCalled()
  })

  it('offline: suspends downloads and Syncplay, and cancels the staggered jobs', async () => {
    const d = deps()
    const k = createOfflineKickoff(d)
    k.onOnline()
    k.onOffline()
    expect(d.suspendDownloads).toHaveBeenCalledTimes(1)
    expect(d.suspendSyncplay).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PREFETCH_STAGGER_MS)
    expect(d.runAutoDownloadTick).not.toHaveBeenCalled()
    expect(d.prefetchShikimoriDetails).not.toHaveBeenCalled()
  })

  it('one failing job does not stop the others', async () => {
    const d = deps()
    d.syncShikimoriQueue.mockRejectedValue(new Error('boom'))
    d.resumeDownloads.mockImplementation(() => {
      throw new Error('sync boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createOfflineKickoff(d).onOnline()
    await vi.advanceTimersByTimeAsync(0)
    expect(d.resumeSyncplay).toHaveBeenCalledTimes(1)
    expect(d.retryBinaries).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
