// Shared domain types — OP/ED skip detection and chapter injection.
// Ambient globals (see anime.ts header). Part of #84 Phase 1 slice 1a.

interface SkipRange {
  startSec: number
  endSec: number
  pairCount: number
}

interface EpisodeSkipDetection {
  episodeInt: string
  episodeLabel: string
  filePath: string
  durationSec: number
  hashesPerSec: number
  op: SkipRange | null
  ed: SkipRange | null
}

interface ShowSkipDetections {
  animeId: number
  perEpisode: Record<string, EpisodeSkipDetection>
  analyzedAt: number
  episodeCount: number
  algorithm: {
    source: 'local'
    sampleRate: number
    matchBitThreshold: number
    minRunSec: number
    windowSec: number
    refineBitThreshold: number
    refineSustainHashes: number
  }
}

interface SkipDetectorProgress {
  animeId: number
  phase: 'fingerprinting' | 'comparing' | 'done'
  current: number
  total: number
  episodeLabel?: string
}

interface ChapterInjectProgress {
  animeId: number
  phase: 'analyzing' | 'writing' | 'done'
  current: number
  total: number
  episodeLabel?: string
}
