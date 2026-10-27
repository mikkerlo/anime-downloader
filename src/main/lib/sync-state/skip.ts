// `skip` in a SyncDoc (#572 §4): skip detections without local paths. Pure;
// the file identity comes from an injected resolver, so no `fs` here.

export interface EpisodeFileIdentity {
  translationId: number
  fileSize: number
}

/**
 * `det` with every `filePath` replaced by the file's identity. An episode whose
 * file `resolve` can't identify is left out. Returns undefined when no episode
 * is left.
 */
export function stripSkip(
  det: ShowSkipDetections,
  resolve: (episodeInt: string, filePath: string) => EpisodeFileIdentity | null
): SyncSkipState | undefined {
  const perEpisode: Record<string, SyncSkipEpisode> = {}
  for (const [episodeInt, entry] of Object.entries(det.perEpisode)) {
    const file = resolve(episodeInt, entry.filePath)
    if (!file) continue
    perEpisode[episodeInt] = {
      file: { translationId: file.translationId, fileSize: file.fileSize },
      episodeLabel: entry.episodeLabel,
      durationSec: entry.durationSec,
      hashesPerSec: entry.hashesPerSec,
      op: entry.op,
      ed: entry.ed
    }
  }
  if (Object.keys(perEpisode).length === 0) return undefined
  return {
    algorithm: det.algorithm,
    analyzedAt: det.analyzedAt,
    episodeCount: det.episodeCount,
    perEpisode
  }
}

/** A drive entry turned back into a local detection on this PC's own file. */
export function restoreSkipEpisode(
  episodeInt: string,
  entry: SyncSkipEpisode,
  filePath: string
): EpisodeSkipDetection {
  return {
    episodeInt,
    episodeLabel: entry.episodeLabel,
    filePath,
    durationSec: entry.durationSec,
    hashesPerSec: entry.hashesPerSec,
    op: entry.op,
    ed: entry.ed
  }
}
