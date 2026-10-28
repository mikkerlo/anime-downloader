// The Shared Library naming rule v1 (#573), Windows-safety included, so adding
// it later doesn't need a `v2`. Pure. It uses a fixed *relative* budget, so an
// item gets the same name whatever the mount point; the player always
// resolves through `items[].path`, never by rebuilding a name.

import { createHash } from 'crypto'
import { sanitizeFilename } from '../../download-manager'
import { itemKey } from './format'

/** The relative path's budget, in UTF-16 code units. */
export const PATH_BUDGET = 200
/** Each component's budget, in UTF-8 bytes. */
export const COMPONENT_BUDGET = 240
// A truncated title keeps at least this many code points before the hash
// while the author tag is left alone; past that the author tag is cut too.
const TITLE_MIN = 24
// The author tag a cut leaves: at most this many UTF-16 units and twice as many bytes.
const AUTHOR_KEEP = 64

const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, '¹', '²', '³'].flatMap((n) => [`COM${n}`, `LPT${n}`])
])

export interface NamingInput {
  animeId: number
  episodeInt: string
  translationId: number
  title: string
  author: string
  // The video's extension, with the dot (`.mkv`, `.mp4`).
  ext: string
  // Whether the item has an `.ass` sidecar.
  subtitle?: boolean
}

export interface NamedItem {
  key: string
  path: string
  subtitlePath?: string
  // The name differs from the plain download-folder name (`naming.renamed`).
  renamed: boolean
}

const hash6 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 6)
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')
const padded = (episodeInt: string): string => episodeInt.padStart(2, '0')

/** Step 2: control characters, empty or dot-only components, reserved device names. */
function windowsSafe(component: string): string {
  // eslint-disable-next-line no-control-regex
  let s = component.replace(/[\u0000-\u001f\u007f]/g, '')
  if (/^\.*$/.test(s)) return '_'
  const dot = s.indexOf('.')
  const stem = dot < 0 ? s : s.slice(0, dot)
  if (RESERVED.has(stem.toUpperCase())) s = `${stem}_${s.slice(stem.length)}`
  return s
}

/** Step 4: Windows silently strips trailing dots and spaces, so the recorded name can't keep them. */
function stripTrailing(component: string): string {
  const s = component.replace(/[. ]+$/, '')
  return s === '' ? '_' : s
}

const finish = (component: string): string => stripTrailing(windowsSafe(component))

/** `s` cut to `n` code points, then `~` and a hash of the full string. */
function cut(s: string, n: number, full: string): string {
  return `${Array.from(s).slice(0, n).join('')}~${hash6(full)}`
}

/** The name today's download folder gives an item (`download-manager.ts` `enqueue`). */
export function plainName(input: NamingInput): { path: string; subtitlePath?: string } {
  const dir = sanitizeFilename(input.title)
  const base = `${sanitizeFilename(`${input.title} - ${padded(input.episodeInt)}`)} [${sanitizeFilename(input.author)}]`
  return {
    path: `${dir}/${base}${input.ext}`,
    ...(input.subtitle ? { subtitlePath: `${dir}/${base}.ass` } : {})
  }
}

interface Built {
  dir: string
  file: string
  sub: string | undefined
}

function nameOne(input: NamingInput, forceTitleHash: boolean, fileSuffix: string): Built {
  const title = sanitizeFilename(input.title)
  const ep = padded(input.episodeInt)
  const build = (t: string | null, author: string): Built => {
    const shown = t ?? title
    const stem =
      t === null ? sanitizeFilename(`${input.title} - ${ep}`) : sanitizeFilename(`${t} - ${ep}`)
    const base = `${stem} [${author}]${fileSuffix}`
    return {
      dir: finish(shown),
      file: finish(`${base}${input.ext}`),
      sub: input.subtitle ? finish(`${base}.ass`) : undefined
    }
  }
  const fits = (b: Built): boolean =>
    [b.file, b.sub].every(
      (f) =>
        f === undefined || (`${b.dir}/${f}`.length <= PATH_BUDGET && bytes(f) <= COMPONENT_BUDGET)
    ) && bytes(b.dir) <= COMPONENT_BUDGET

  const titleLength = Array.from(title).length
  const firstTitle = forceTitleHash ? `${title}~${hash6(input.title)}` : null
  const author = sanitizeFilename(input.author)
  const plain = build(firstTitle, author)
  if (fits(plain)) return plain

  // Step 3: cut the title to fit; when that would leave it too short, cut the author tag too.
  const cutTitle = (authorTag: string, min: number): Built | null => {
    for (let n = titleLength - 1; n >= min; n--) {
      const b = build(cut(title, n, input.title), authorTag)
      if (fits(b)) return b
    }
    return null
  }
  const titleOnly = cutTitle(author, TITLE_MIN)
  if (titleOnly) return titleOnly
  let shortAuthor = author
  if (author.length > AUTHOR_KEEP || bytes(author) > 2 * AUTHOR_KEEP) {
    let n = Array.from(author).length
    do shortAuthor = cut(author, --n, input.author)
    while (n > 1 && (shortAuthor.length > AUTHOR_KEEP || bytes(shortAuthor) > 2 * AUTHOR_KEEP))
  }
  const authorOnly = build(firstTitle, shortAuthor)
  if (fits(authorOnly)) return authorOnly
  return cutTitle(shortAuthor, 1) ?? build(cut(title, 1, input.title), shortAuthor)
}

const fold = (s: string): string => s.toUpperCase()

/**
 * Names every item by the v1 rule, in `items[]` order. A component that
 * collides with an earlier one when case-folded (exFAT, NTFS, APFS) gets the
 * hash suffix: the title directory a hash of the title, the file a hash of
 * the item key.
 */
export function nameItems(inputs: readonly NamingInput[]): NamedItem[] {
  const dirs = new Map<string, string>()
  const files = new Set<string>()
  return inputs.map((input) => {
    let forced = false
    let b = nameOne(input, false, '')
    const seen = dirs.get(fold(b.dir))
    if (seen !== undefined && seen !== b.dir) {
      forced = true
      b = nameOne(input, true, '')
    }
    const taken = (x: Built): boolean =>
      files.has(fold(`${x.dir}/${x.file}`)) ||
      (x.sub !== undefined && files.has(fold(`${x.dir}/${x.sub}`)))
    if (taken(b)) b = nameOne(input, forced, `~${hash6(itemKey(input))}`)
    if (!dirs.has(fold(b.dir))) dirs.set(fold(b.dir), b.dir)
    files.add(fold(`${b.dir}/${b.file}`))
    if (b.sub !== undefined) files.add(fold(`${b.dir}/${b.sub}`))
    const out: NamedItem = { key: itemKey(input), path: `${b.dir}/${b.file}`, renamed: false }
    if (b.sub !== undefined) out.subtitlePath = `${b.dir}/${b.sub}`
    const plain = plainName(input)
    out.renamed = out.path !== plain.path || out.subtitlePath !== plain.subtitlePath
    return out
  })
}

/** One item, with no other item to collide with. */
export function nameItem(input: NamingInput): NamedItem {
  return nameItems([input])[0]
}
