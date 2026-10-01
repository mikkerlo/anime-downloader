// Parse episodeInt from a sanitized download filename. Format produced by
// download-manager.ts: `${name} - ${NN}[ [Author]].(mkv|mp4|ass|part)`.
//
// The extension alternation is derived from `EPISODE_ARTIFACT_EXTS` (#429), so
// this regex is one of the sites a new container reaches automatically. Note
// the comment above lists a *fifth* member, `part`, which this regex has never
// matched: a `.part` file is an in-progress download and has no parsed episode.
// Built once at module scope, case-insensitive as before.
import { EPISODE_ARTIFACT_EXT_ALTERNATION } from '@shared/episode-files'

export const FILENAME_EP_RE = new RegExp(
  `\\s-\\s(\\d{1,4}(?:\\.\\d+)?)(?:\\s\\[[^\\]]+\\])?\\.(${EPISODE_ARTIFACT_EXT_ALTERNATION})$`,
  'i'
)

export function parseEpisodeFromFilename(
  file: string
): { episodeInt: string; ext: EpisodeArtifactExt } | null {
  const m = FILENAME_EP_RE.exec(file)
  if (!m) return null
  const raw = m[1]
  const episodeInt = raw.includes('.') ? raw : String(parseInt(raw, 10))
  return { episodeInt, ext: m[2].toLowerCase() as EpisodeArtifactExt }
}
