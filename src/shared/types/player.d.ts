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
