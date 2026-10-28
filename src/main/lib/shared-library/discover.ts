// Finding Shared Libraries on a drive (#573): `dir` itself, then each folder
// one level below it. One drive can hold several libraries.

import { promises as fsp } from 'fs'
import * as path from 'path'
import { LIBRARY_DIR, MANIFEST, MANIFEST_PREV } from './read'

async function holdsLibrary(root: string): Promise<boolean> {
  for (const name of [MANIFEST, MANIFEST_PREV]) {
    try {
      if ((await fsp.stat(path.join(root, LIBRARY_DIR, name))).isFile()) return true
    } catch {
      // Not here.
    }
  }
  return false
}

/** The roots under `dir` (itself included) holding `.anime-dl/manifest.json`, or its `.prev` alone. */
export async function discoverLibraries(dir: string): Promise<string[]> {
  const found: string[] = []
  if (await holdsLibrary(dir)) found.push(dir)
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  const children = entries
    .filter((e) => e.isDirectory() && e.name !== LIBRARY_DIR)
    .map((e) => e.name)
    .sort()
  for (const name of children) {
    const child = path.join(dir, name)
    if (await holdsLibrary(child)) found.push(child)
  }
  return found
}
