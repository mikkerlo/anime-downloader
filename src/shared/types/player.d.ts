// Shared domain types — playback, watch progress, MP4 streaming diagnostics.
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

interface WatchProgressEntry {
  position: number
  duration: number
  updatedAt: number
  watched?: boolean
  watchedAt?: number
  translationId?: number
}

// `player:find-local-file` result. `isPartial` marks a growing `.part` file
// being watched while it downloads (#63); `totalBytes` is the expected final
// size reported by the download's Content-Range.
interface PlayerLocalFileResult {
  filePath: string
  subtitleContent: string | null
  isPartial?: boolean
  totalBytes?: number
}

interface Mp4StreamingStatsSample {
  animeId: number
  animeName: string
  episodeInt: string
  episodeLabel: string
  filePath: string
  firstNonFtypBox: string
  checkedAt: number
}

interface Mp4StreamingStats {
  totalChecked: number
  faststartCount: number
  nonFaststartSamples: Mp4StreamingStatsSample[]
}
