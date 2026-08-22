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

// `player:remux-mkv-stream` / `player:remux-mkv-stream-transcode` success
// reply. Declared once here (#294) so main, preload and the renderer share a
// single owner — five literal copies of this shape are what let the
// `initialSeek` collision fixed in #275 survive unnoticed.
interface MseOpenResult {
  sessionId: string
  generation: number
  duration: number
  mimeType: string
  hasSubtitlesPending: boolean
  /**
   * The true PTS the ffmpeg run starts emitting at, as measured by the offset
   * probe — the renderer's `SourceBuffer.timestampOffset`. Named for what it
   * is (#275): main already computes it into a local called `contentStart`,
   * and the old `initialSeek` collided with the *request* field of the same
   * name on the renderer side, where the wrong one compiled and read 0.
   */
  contentStart: number
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
