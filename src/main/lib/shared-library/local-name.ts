// The local path of an episode copied from a Shared Library onto this PC
// (#579). A library is untrusted input: its titles, authors and episode
// numbers come from another PC or another person. The local naming is the
// download folder's (`sanitizeFilename` + `{T}/{T} - NN [A].ext`), and
// `sanitizeFilename` leaves `.`, `..`, control characters and NUL alone, so a
// title of `..` would put the file outside the download root. Every component
// is checked here first, and the joined path is checked once more by
// `assertInsideRoot`. `sanitizeFilename` itself is not changed: it names every
// existing download.

import * as path from 'path'
import { EPISODE_ARTIFACT_EXTS } from '@shared/episode-files'
import { sanitizeFilename } from '../../download-manager'

/** The reason an item with such a name is listed and never created. */
export const UNSAFE_NAME = 'Can’t copy: unsafe name in the library'

export class UnsafeLocalNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeLocalNameError'
  }
}

export interface LocalEpisodeName {
  animeId: number
  translationId: number
  /** The title the player and cleanup derive (`romaji || ru || title`). */
  title: string
  episodeInt: string
  author: string
  /** With the dot: `.mkv`, `.mp4` or `.ass`. */
  ext: string
}

export type LocalEpisodePath =
  | { ok: true; path: string; dirName: string; fileName: string }
  | { ok: false; reason: string }

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const EPISODE_INT = /^\d{1,4}(\.\d+)?$/
const DOT_ONLY = /^[\s.]*$/

const isPositiveId = (n: unknown): boolean =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0

/**
 * The backstop: `dest`, resolved, must be strictly inside `root`, resolved.
 * `path.relative(root, dest)` must be non-empty, not absolute, and not start
 * with `..`. Throws `UnsafeLocalNameError` otherwise.
 */
export function assertInsideRoot(root: string, dest: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(dest))
  if (rel === '' || path.isAbsolute(rel) || rel.startsWith('..')) {
    throw new UnsafeLocalNameError(`${dest} is not inside ${root}`)
  }
}

/**
 * `root/<title dir>/<title> - NN [author].ext`, or the reason the item is
 * refused: a control character or NUL in the title, author or episode number,
 * a title whose folder name is empty or only dots, an episode number outside
 * the filename grammar, an extension outside `EPISODE_ARTIFACT_EXTS`, an id
 * that isn't a positive safe integer, or a joined path outside `root`.
 */
export function buildLocalEpisodePath(root: string, n: LocalEpisodeName): LocalEpisodePath {
  const refuse = (why: string): LocalEpisodePath => ({ ok: false, reason: why })
  if (!isPositiveId(n.animeId) || !isPositiveId(n.translationId)) return refuse('bad id')
  for (const s of [n.title, n.author, n.episodeInt]) {
    if (typeof s !== 'string' || CONTROL.test(s)) return refuse('control character')
  }
  if (!EPISODE_INT.test(n.episodeInt)) return refuse('bad episode number')
  if (!(EPISODE_ARTIFACT_EXTS as readonly string[]).includes(n.ext)) return refuse('bad extension')
  const dirName = sanitizeFilename(n.title)
  if (DOT_ONLY.test(dirName)) return refuse('dot-only title')
  const fileName = `${sanitizeFilename(`${n.title} - ${n.episodeInt.padStart(2, '0')}`)} [${sanitizeFilename(n.author)}]${n.ext}`
  const dest = path.join(root, dirName, fileName)
  try {
    assertInsideRoot(root, dest)
  } catch {
    return refuse('outside the root')
  }
  return { ok: true, path: dest, dirName, fileName }
}
