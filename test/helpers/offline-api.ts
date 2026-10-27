// The `window.api` half of `useOfflineStore` (#567) for renderer component
// tests (#568). Spread it into a test's API stub: a permissive stub would
// answer `offlineGetState()` with a function, whose missing `mode` reads as
// offline. `emit` drives the `offline:state-changed` subscription.

export interface OfflineApi {
  api: {
    offlineGetState: () => Promise<OfflineState>
    offlineSetManual: (on: boolean) => Promise<OfflineState>
    offlineRetry: () => Promise<OfflineState>
    onOfflineStateChanged: (cb: (state: OfflineState) => void) => () => void
  }
  emit(mode: OfflineMode): void
  /** Live subscriptions; an unmounted view must not leave one behind. */
  listenerCount(): number
}

export function offlineApi(mode: OfflineMode = 'online'): OfflineApi {
  const listeners = new Set<(state: OfflineState) => void>()
  let state: OfflineState = { mode, since: 1, lastProbeAt: null }
  const set = (next: OfflineMode): OfflineState => {
    state = { mode: next, since: state.since + 1, lastProbeAt: null }
    return state
  }
  return {
    api: {
      offlineGetState: async () => state,
      offlineSetManual: async (on) => set(on ? 'offline-manual' : 'online'),
      offlineRetry: async () => state,
      onOfflineStateChanged: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    },
    emit(next) {
      const s = set(next)
      for (const cb of [...listeners]) cb(s)
    },
    listenerCount: () => listeners.size
  }
}
