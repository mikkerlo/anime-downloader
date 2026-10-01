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
