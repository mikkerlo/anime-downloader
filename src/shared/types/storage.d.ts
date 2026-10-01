// Shared domain types — hot/cold storage usage and cleanup.
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

/**
 * Container of a playable episode file. The runtime counterpart is
 * `VIDEO_EXTS` in `src/shared/episode-files.ts`, which carries the leading
 * dots because it feeds `endsWith`; this union is the bare form the scanner
 * reports and the regex capture groups yield. The two are locked together by
 * a compile-time equality assertion in `test/lib/episode-files.test.ts` — a
 * `.d.ts` cannot import, so the mirror cannot be derived here.
 */
type EpisodeFileType = 'mkv' | 'mp4'

/** `EpisodeFileType` plus the `.ass` sidecar — mirrors `EPISODE_ARTIFACT_EXTS`. */
type EpisodeArtifactExt = EpisodeFileType | 'ass'

/**
 * One on-disk episode artifact as the episode-file scanner reports it, and the
 * element type of the `CHANNELS.FILE_CHECK_EPISODES` reply and the
 * `FILE_EPISODES_CHANGED` broadcast. Declared once here (#429): this shape was
 * re-typed byte-identically at 11 sites across main, preload and the renderer,
 * so the compiler could not notice the producer and a consumer drifting apart.
 * Ambient like everything else in this file, so a consumer deletes its literal
 * and gains no import — `src/preload/types.d.ts` in particular must stay
 * declaration-only (see its header).
 */
interface EpisodeFileEntry {
  type: EpisodeFileType
  filePath: string
  translationId?: number
  author?: string
}

/**
 * The three `electron-store` keys that can name a storage root. Clearing one is
 * the escape hatch from the `missingConfiguredRoot()` guard (#440): while any of
 * them names a directory that is not on disk, both metadata-deleting paths
 * refuse to run, and a root the user deleted for good never comes back.
 */
type StorageRootKey = 'downloadDir' | 'hotStorageDir' | 'coldStorageDir'

/**
 * Raw root state, as `CHANNELS.STORAGE_GET_MISSING_ROOT` and
 * `CHANNELS.STORAGE_CLEAR_ROOT` both report it.
 *
 * The three paths are the **stored** values, `''` when unset — deliberately not
 * what `CHANNELS.GET_SETTING` returns, which resolves `downloadDir` through
 * `getDownloadDir()` and so hands back the fallback path (or the hot dir, in
 * advanced mode) for a key that was never set. The renderer needs the unresolved
 * form to decide which rows have something to clear, and to know which key holds
 * `missingRoot` when that key's own row is not visible in the current mode.
 */
interface StorageRootsState {
  downloadDir: string
  hotStorageDir: string
  coldStorageDir: string
  autoMoveToCold: boolean
  /** First stored root that is absent from disk, or `null` — `missingConfiguredRoot()`. */
  missingRoot: string | null
}

/** The `storageMode` setting: one root, or a hot/cold split. */
type StorageMode = 'simple' | 'advanced'

/**
 * Reply of `CHANNELS.STORAGE_SET_MODE` (#443).
 *
 * The mode is not written through `set-setting`, because the effective download
 * root is a function of it: `getDownloadDir()` answers `hotStorageDir` in
 * advanced mode and `downloadDir` in simple mode, while `DownloadManager` holds
 * its root in a cached field. A bare store write moves the former and not the
 * latter, and the manager keeps re-deriving paths under the root the user just
 * left until the app restarts.
 *
 * `mode` is the mode **now in force**, which is the previous one whenever
 * `refusedReason` is set — the switch is refused while the manager still has
 * work whose paths it will re-derive later, so the renderer adopts this value
 * rather than letting its own `ref` flip optimistically. `roots` carries the
 * same `StorageRootsState` the clear and the getter report, so the Storage tab
 * re-adopts root state here exactly as it already does after a clear.
 */
interface StorageSetModeResult {
  mode: StorageMode
  refusedReason: string | null
  roots: StorageRootsState
}

/**
 * Reply of the two **root-moving** folder pickers, `CHANNELS.DOWNLOAD_PICK_DIR`
 * and `CHANNELS.STORAGE_PICK_HOT_DIR` (#447).
 *
 * Deliberately the shape of `StorageSetModeResult` with `dir` where `mode` is,
 * because the two pickers move the effective download root exactly the way
 * `storage:set-mode` does and are refused by the same predicate. A bare
 * `string | null` could not carry that: `null` already means "the user
 * cancelled the dialog", and the renderer treats it as a no-op, so a refusal
 * sent that way would discard the pick with nothing on screen to say why.
 *
 * `dir` is the picked path, and `null` for **both** a cancel and a refusal —
 * nothing was written in either case, so there is no new value to adopt.
 * `refusedReason` is what tells the two apart, and the Storage tab shows it
 * verbatim. `roots` carries the same `StorageRootsState` the clear, the getter
 * and the mode switch report.
 *
 * `storage:pick-cold-dir` keeps its `string | null`: `coldStorageDir` is a move
 * *target* and is not an input to `getDownloadDir()`, so picking one never
 * re-points the manager and there is nothing for the predicate to refuse.
 */
interface StoragePickDirResult {
  dir: string | null
  refusedReason: string | null
  roots: StorageRootsState
}

interface StorageEpisodeUsage {
  episodeInt: string
  files: {
    mkv?: { path: string; size: number }
    mp4?: { path: string; size: number }
    ass?: { path: string; size: number }
  }
  totalBytes: number
  watched: boolean
  watchedAt?: number
}

interface StorageAnimeUsage {
  animeId: number
  animeName: string
  posterUrlSmall: string
  bytes: number
  bytesHot: number
  bytesCold: number
  fileCount: number
  episodes: StorageEpisodeUsage[]
}

interface StorageUsage {
  totalBytes: number
  bytesHot: number
  bytesCold: number
  fileCount: number
  perAnime: StorageAnimeUsage[]
}

interface CleanupCandidate {
  animeId: number
  animeName: string
  episodeInt: string
  bytes: number
  watchedAt: number
}

interface CleanupResult {
  ranAt: number
  deletedCount: number
  freedBytes: number
  items: CleanupCandidate[]
}

interface CleanupLogEntry {
  ranAt: number
  animeId: number
  animeName: string
  episodeInt: string
  bytes: number
}
