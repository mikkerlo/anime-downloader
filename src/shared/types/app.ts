// Shared domain types — app-level (auto-updater).
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

interface UpdateStatus {
  status: 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
}
