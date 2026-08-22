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
  /**
   * True when main *refused* the requested open position because it was at or
   * past the probed duration, and spawned at 0 instead (#275). The decision
   * itself, transported (#295): the renderer drops its resume land on it
   * rather than re-deriving the same comparison from the numbers, which is two
   * copies of one rule on either side of a process boundary. Not inferable
   * from `contentStart` — a legitimate open at 0 reports the same 0.
   */
  refusedSeek: boolean
}

// `player:close-stream-session` reply (#291). The renderer names ONE session to
// reap — the one a superseded `prepareMkvForPlayback` opened — instead of the
// blanket `player:cleanup-remux`, which would SIGKILL the winning open's
// session too and unlink the shared tmpDir out from under it.
//
// `closed` is false when no such session is registered *or* when the calling
// `webContents` does not own it. The two are deliberately indistinguishable to
// the renderer: the unwind issues this fire-and-forget and has nothing useful
// to do with either answer.
interface PlayerCloseStreamSessionResult {
  closed: boolean
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
