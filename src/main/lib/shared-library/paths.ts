// Paths inside a Shared Library (#573). The reader checks `items[].path`
// lexically only, never with `realpath`: a 200k-item manifest would cost 200k
// syscalls per open, and a missing file would throw `ENOENT` and drop its item.
// The `realpath` runs when an item is used (`resolveItem`) or written
// (`resolveWriteTarget`).

import { promises as fsp } from 'fs'
import * as path from 'path'
import { itemKey } from './format'

/** A path relative to the library root, normalized, `/`-separated, staying inside it. */
export function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || p === '') return false
  if (p.includes('\0') || p.includes('\\') || p.includes(':')) return false
  if (p.startsWith('/')) return false
  for (const part of p.split('/')) {
    if (part === '' || /^\.+$/.test(part)) return false
  }
  return path.posix.normalize(p) === p
}

function isInside(realRoot: string, real: string): boolean {
  return (
    real === realRoot ||
    real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)
  )
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

async function resolveOne(root: string, rel: string): Promise<SharedLibraryResolved> {
  if (!isSafeRelativePath(rel)) return 'escapes'
  let realRoot: string
  let real: string
  try {
    realRoot = await fsp.realpath(root)
    real = await fsp.realpath(path.join(root, ...rel.split('/')))
  } catch (err) {
    if (code(err) === 'ENOENT' || code(err) === 'ENOTDIR') return 'missing'
    throw err
  }
  return isInside(realRoot, real) && real !== realRoot ? real : 'escapes'
}

/**
 * An item's file at the moment it is used: its real absolute path, `'missing'`,
 * or `'escapes'` when a symlink leads out of the root. Either way the item
 * stays in the manifest.
 */
export async function resolveItem(
  root: string,
  item: Pick<SharedLibraryItem, 'path' | 'subtitlePath'>
): Promise<{ path: SharedLibraryResolved; subtitlePath?: SharedLibraryResolved }> {
  const out: { path: SharedLibraryResolved; subtitlePath?: SharedLibraryResolved } = {
    path: await resolveOne(root, item.path)
  }
  if (item.subtitlePath !== undefined) out.subtitlePath = await resolveOne(root, item.subtitlePath)
  return out
}

/**
 * Where a copy into `rel` would land: the deepest existing ancestor resolved
 * with `realpath`, plus the parts that don't exist yet. `'escapes'` when that
 * ancestor (or a dangling symlink on the way) leads out of the root.
 */
export async function resolveWriteTarget(
  root: string,
  rel: string
): Promise<Exclude<SharedLibraryResolved, 'missing'>> {
  if (!isSafeRelativePath(rel)) return 'escapes'
  const realRoot = await fsp.realpath(root)
  const parts = rel.split('/')
  const rest: string[] = []
  for (;;) {
    const candidate = path.join(root, ...parts)
    try {
      const real = await fsp.realpath(candidate)
      if (!isInside(realRoot, real)) return 'escapes'
      return rest.length > 0 ? path.join(real, ...rest) : real
    } catch (err) {
      if (code(err) !== 'ENOENT' && code(err) !== 'ENOTDIR') throw err
      try {
        await fsp.lstat(candidate)
        // It exists but doesn't resolve: a dangling symlink, which a copy would follow.
        return 'escapes'
      } catch {
        // Not there yet; try its parent.
      }
    }
    rest.unshift(parts.pop()!)
    if (parts.length === 0) return path.join(realRoot, ...rest)
  }
}

const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/

/** Windows' MAX_PATH less the terminating NUL. */
export const WINDOWS_MAX_PATH = 259

/**
 * The items whose absolute path under a Windows-style `root` is over 259
 * UTF-16 units: fine inside the app (`\\?\` paths), a problem for VLC,
 * Explorer or a tool without long-path support. Reported, not prevented.
 */
export function absoluteOverflow(
  root: string,
  items: readonly Pick<
    SharedLibraryItem,
    'animeId' | 'episodeInt' | 'translationId' | 'path' | 'subtitlePath'
  >[]
): string[] {
  if (!WINDOWS_ROOT.test(root)) return []
  const base = root.replace(/[\\/]+$/, '')
  const over = (rel: string | undefined): boolean =>
    rel !== undefined && base.length + 1 + rel.length > WINDOWS_MAX_PATH
  return items.filter((i) => over(i.path) || over(i.subtitlePath)).map((i) => itemKey(i))
}

/** `posters/<animeId>.jpg`, the only poster name a library may hold. */
export function posterPath(animeId: number): string | null {
  return Number.isSafeInteger(animeId) && animeId > 0 ? `posters/${animeId}.jpg` : null
}

/** Whether a name under `posters/` is one the format accepts. */
export function isPosterName(name: string): boolean {
  return /^[1-9][0-9]{0,15}\.jpg$/.test(name)
}
