// Shared domain types — app-level (auto-updater).
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

interface UpdateStatus {
  status: 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
  /** Portable build: update can't self-install, "download" opens the release page. */
  manual?: boolean
}

/**
 * Why this launch didn't start from the `config.json` it found (#648). A
 * `config-restored` without `corruptPath` found no `config.json` at all.
 */
type StartupNotice =
  | { kind: 'config-restored'; corruptPath?: string; backupSavedAt: number }
  | { kind: 'config-reset'; corruptPath: string }
