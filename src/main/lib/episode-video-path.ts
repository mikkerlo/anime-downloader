// Where a downloaded episode's video can be, in the order the player looks
// (`player:find-local-file`): per root (hot first, then cold), the
// author-tagged name in each container, then the legacy untagged name. Shared
// with Prepare for offline's integrity step (#592), so both find the same file.

import * as path from 'path'
import { VIDEO_EXTS } from '@shared/episode-files'

export interface EpisodeVideoQuery {
  dirs: string[]
  animeName: string
  episodeInt: string
  author: string
  sanitizeFilename(name: string): string
}

export function episodeVideoCandidates(q: EpisodeVideoQuery): string[] {
  const animeDirName = q.sanitizeFilename(q.animeName)
  const padded = q.episodeInt.padStart(2, '0')
  const base = q.sanitizeFilename(`${q.animeName} - ${padded}`)
  const taggedBase = `${base} [${q.sanitizeFilename(q.author)}]`
  const out: string[] = []
  for (const dir of q.dirs) {
    const animeDir = path.join(dir, animeDirName)
    for (const ext of VIDEO_EXTS) out.push(path.join(animeDir, `${taggedBase}${ext}`))
    for (const ext of VIDEO_EXTS) out.push(path.join(animeDir, `${base}${ext}`))
  }
  return out
}
