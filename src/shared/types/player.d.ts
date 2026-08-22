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
