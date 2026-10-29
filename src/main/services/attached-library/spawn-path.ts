// File arguments for a spawned ffmpeg / ffprobe (#578). Node's own `fs` calls
// already go through `path.toNamespacedPath` (`\\?\`) on Windows, so the app's
// reads work past MAX_PATH; a spawned tool gets the path as a plain argument.
// A path under an attached Shared Library root is handed over in the `\\?\`
// form; every other path keeps exactly today's argument. A no-op off Windows.
// S8 (#582) uses the same helper.

import * as path from 'path'

export type SpawnPathImpl = Pick<
  typeof path,
  'resolve' | 'relative' | 'isAbsolute' | 'toNamespacedPath' | 'sep'
>

/** `abs` is strictly below `root`. */
export function isUnder(p: SpawnPathImpl, root: string, abs: string): boolean {
  const rel = p.relative(p.resolve(root), p.resolve(abs))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel)
}

export function spawnPathFor(
  abs: string,
  roots: Iterable<string>,
  p: SpawnPathImpl = path
): string {
  for (const root of roots) {
    if (isUnder(p, root, abs)) return p.toNamespacedPath(abs)
  }
  return abs
}
