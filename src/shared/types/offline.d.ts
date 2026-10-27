// Shared domain types — offline mode (#567).
// Ambient globals (see anime.ts header).

/**
 * `offline-auto`: both API hosts failed a probe after a network error; the app
 * re-probes with backoff. `offline-manual`: the user turned on Work offline;
 * nothing probes and only the user turns it off.
 */
type OfflineMode = 'online' | 'offline-auto' | 'offline-manual'

interface OfflineState {
  mode: OfflineMode
  /** When `mode` last changed (ms epoch). */
  since: number
  /** When the last probe finished (ms epoch), or null if none has run. */
  lastProbeAt: number | null
}
