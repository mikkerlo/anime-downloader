import { fetchWithTimeout, type NetworkObserver } from '../../lib/net'
import { isNetworkError } from '../../lib/errors'
import type { StorageService } from '../../store/types'

export const PROBE_TIMEOUT_MS = 5_000
export const REPROBE_MIN_MS = 15_000
export const REPROBE_MAX_MS = 120_000

/**
 * Any HTTP answer, a 404 or a 405 for `HEAD` included, means the host is
 * reachable; only a throw (network error, timeout) means down. The one caller
 * allowed past the offline refusal — the adoption guard enforces that.
 */
export async function probeHost(url: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'HEAD',
      connectMs: PROBE_TIMEOUT_MS,
      idleMs: PROBE_TIMEOUT_MS,
      bypassOffline: true
    })
    await res.body?.cancel().catch(() => {})
    return true
  } catch {
    return false
  }
}

export interface OfflineServiceDeps {
  store: Pick<StorageService, 'get' | 'set'>
  /** The hosts a probe tries; offline only when every one is down. */
  probeUrls: () => string[]
  /** Runs after the state has turned online, so `isOffline()` is already false. */
  onOnline: () => void
  /** Runs on the online → offline edge only, after the state has changed. */
  onOffline: () => void
  probe?: (url: string) => Promise<boolean>
  now?: () => number
}

export interface OfflineService {
  getState(): OfflineState
  isOffline(): boolean
  /** Work offline on/off; persisted as `workOffline`. */
  setManual(on: boolean): OfflineState
  /** Probes now (joining one in flight). A no-op in manual mode. */
  retryNow(): Promise<OfflineState>
  onChange(listener: (state: OfflineState) => void): () => void
  /** Installed into `net.ts` with `setNetworkObserver`. */
  readonly observer: NetworkObserver
  dispose(): void
}

/**
 * The single source of truth for "are we offline" (#567).
 *
 * A network-classified failure only makes the service *suspect*: it probes
 * both API hosts, and goes `offline-auto` only when both are down. A bug that
 * throws a `TypeError` (which `isNetworkError` counts as network) therefore
 * costs one probe, not a false offline. While `offline-auto` it re-probes with
 * backoff (15 s doubling to 2 min) and returns online on the first reachable
 * probe. Manual mode never probes and never clears itself.
 */
export function createOfflineService(deps: OfflineServiceDeps): OfflineService {
  const now = deps.now ?? Date.now
  const probe = deps.probe ?? probeHost
  const listeners = new Set<(state: OfflineState) => void>()
  let state: OfflineState = {
    mode: deps.store.get('workOffline') ? 'offline-manual' : 'online',
    since: now(),
    lastProbeAt: null
  }
  let probing: Promise<void> | null = null
  let reprobeTimer: ReturnType<typeof setTimeout> | null = null
  let backoffMs = REPROBE_MIN_MS
  let disposed = false

  const getState = (): OfflineState => ({ ...state })
  const isOffline = (): boolean => state.mode !== 'online'

  function emit(): void {
    const snapshot = getState()
    for (const listener of [...listeners]) listener(snapshot)
  }

  /** Changes mode and runs the edge hook; the caller emits. */
  function setMode(mode: OfflineMode): void {
    if (state.mode === mode) return
    const wasOffline = isOffline()
    state = { ...state, mode, since: now() }
    if (mode === 'online') deps.onOnline()
    else if (!wasOffline) deps.onOffline()
  }

  function clearReprobe(): void {
    if (reprobeTimer) clearTimeout(reprobeTimer)
    reprobeTimer = null
  }

  function scheduleReprobe(): void {
    clearReprobe()
    reprobeTimer = setTimeout(() => {
      reprobeTimer = null
      void runProbe()
    }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, REPROBE_MAX_MS)
  }

  function runProbe(): Promise<void> {
    if (probing) return probing
    probing = (async () => {
      const results = await Promise.all(
        deps.probeUrls().map((url) => probe(url).catch(() => false))
      )
      probing = null
      if (disposed || state.mode === 'offline-manual') return
      state = { ...state, lastProbeAt: now() }
      if (results.some(Boolean)) {
        backoffMs = REPROBE_MIN_MS
        clearReprobe()
        setMode('online')
      } else {
        setMode('offline-auto')
        scheduleReprobe()
      }
      emit()
    })()
    return probing
  }

  const observer: NetworkObserver = {
    onFailure(err) {
      if (state.mode !== 'online') return
      if (err instanceof Error && err.name === 'OfflineError') return
      if (!isNetworkError(err)) return
      void runProbe()
    },
    onSuccess() {}
  }

  function setManual(on: boolean): OfflineState {
    deps.store.set('workOffline', on)
    if (on) {
      clearReprobe()
      setMode('offline-manual')
    } else if (state.mode === 'offline-manual') {
      backoffMs = REPROBE_MIN_MS
      setMode('online')
    }
    emit()
    return getState()
  }

  async function retryNow(): Promise<OfflineState> {
    if (state.mode !== 'offline-manual') {
      clearReprobe()
      await runProbe()
    }
    return getState()
  }

  function onChange(listener: (state: OfflineState) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function dispose(): void {
    disposed = true
    clearReprobe()
    listeners.clear()
  }

  return { getState, isOffline, setManual, retryNow, onChange, observer, dispose }
}
