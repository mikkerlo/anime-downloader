// Shared domain types — offline mode (#567).
// Ambient globals (see anime.ts header).

/**
 * `offline-auto`: both API hosts failed a probe after a network error; the app
 * re-probes with backoff. `offline-manual`: the user turned on Work offline;
 * nothing probes and only the user turns it off.
 */
type OfflineMode = 'online' | 'offline-auto' | 'offline-manual'

// --- Prepare for offline (#592) ------------------------------------------------

type PrepareOfflineStatus = 'ok' | 'warning' | 'failed' | 'skipped'

type PrepareOfflineStepId =
  | 'binaries'
  | 'shikimori-rates'
  | 'metadata'
  | 'local-integrity'
  | 'attached-integrity'
  | 'library-sync'

/** One line of a step's details; `animeId` links it to the title's detail page. */
interface PrepareOfflineDetail {
  text: string
  status: PrepareOfflineStatus
  animeId?: number
}

interface PrepareOfflineStepState {
  id: PrepareOfflineStepId
  label: string
  state: 'pending' | 'running' | 'done'
  /** Set once done; `unavailable` is a step whose `isAvailable()` said no. */
  status?: PrepareOfflineStatus | 'unavailable'
  /** Why it was skipped or not available. */
  reason?: string
  done: number
  total: number
  message?: string
  details: PrepareOfflineDetail[]
}

/** The run in flight or the last one this session; the progress event's payload. */
interface PrepareOfflineRun {
  runId: string
  startedAt: number
  finishedAt: number | null
  cancelled: boolean
  steps: PrepareOfflineStepState[]
}

/** `prepareOfflineLastRun`: survives a restart, with no per-file details. */
interface PrepareOfflineLastRun {
  finishedAt: number
  cancelled: boolean
  steps: { id: PrepareOfflineStepId; label: string; status: PrepareOfflineStatus | 'unavailable' }[]
}

interface PrepareOfflineState {
  running: boolean
  run: PrepareOfflineRun | null
  lastRun: PrepareOfflineLastRun | null
}

interface OfflineState {
  mode: OfflineMode
  /** When `mode` last changed (ms epoch). */
  since: number
  /** When the last probe finished (ms epoch), or null if none has run. */
  lastProbeAt: number | null
}
