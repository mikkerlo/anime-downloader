// A title's episodes under its other names (#663): romaji was empty at
// download time, so the folder took `ru` or `title`. Deleting a title removes
// its `animeName` folder recursively; this pass removes only the files the
// title's own `downloadedEpisodes` entries resolve to under every other name,
// because two titles can share a `ru` or `title` folder. Shared by Library →
// Delete, and meant for `cleanup:execute` next.

import * as fs from 'fs'
import * as path from 'path'
import { VIDEO_EXT_RE } from '@shared/episode-files'
import { episodeVideoCandidates } from './episode-video-path'
import type { DownloadedEpisodesMap } from './downloaded-episodes'

export interface OtherNameFilesQuery {
  animeId: number
  /** The title's names, `titleNames(record)`. */
  names: string[]
  /** The name whose folder the caller already removed. */
  removedName: string
  dirs: string[]
  episodes: DownloadedEpisodesMap
  sanitizeFilename(name: string): string
}

function unlinkFile(fp: string): 'gone' | 'absent' | 'failed' {
  try {
    fs.unlinkSync(fp)
    return 'gone'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'failed'
  }
}

/**
 * Unlinks every existing candidate video of each of the title's entries, and
 * each candidate's `.ass` (even one whose video is already gone), under each
 * name other than `removedName`, then removes each such folder if it is left
 * empty.
 *
 * @returns whether a file failed to unlink (a locked file): the caller keeps
 * the title's entries, as for a folder left on disk (#656). A folder that
 * can't be removed doesn't count once its files are gone.
 */
export function deleteEpisodeFilesUnderOtherNames(q: OtherNameFilesQuery): boolean {
  const seenDirs = new Set([q.sanitizeFilename(q.removedName)])
  const names = q.names.filter((name) => {
    const dirName = q.sanitizeFilename(name)
    if (seenDirs.has(dirName)) return false
    seenDirs.add(dirName)
    return true
  })
  const prefix = `${q.animeId}:`
  const entries = Object.entries(q.episodes).filter(([key]) => key.startsWith(prefix))

  let leftOnDisk = false
  for (const dir of q.dirs) {
    for (const name of names) {
      for (const [key, entry] of entries) {
        const candidates = episodeVideoCandidates({
          dirs: [dir],
          animeName: name,
          episodeInt: key.split(':')[1],
          author: entry.author ?? '',
          sanitizeFilename: q.sanitizeFilename
        })
        for (const fp of candidates) {
          if (unlinkFile(fp) === 'failed') leftOnDisk = true
          if (unlinkFile(fp.replace(VIDEO_EXT_RE, '.ass')) === 'failed') leftOnDisk = true
        }
      }
      try {
        fs.rmdirSync(path.join(dir, q.sanitizeFilename(name)))
      } catch {
        /* not empty, not there, or held open: its files are what count */
      }
    }
  }
  return leftOnDisk
}
