// The checked-in fixture library and the "never written" probes for the
// attached-library tests (#578).
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'
import { snapshot, tempRoot } from './shared-library'

export const FIXTURE_LIBRARY = path.resolve(__dirname, '../fixtures/shared-library/fixture-library')
export const FIXTURE_LIBRARY_ID = '5d7c1f3e-8a2b-4c6d-9e0f-1a2b3c4d5e6f'

/** The fixture library (an `.mp4` + `.ass`, an `.mkv`, a poster) copied into a fresh root. */
export function copyFixtureLibrary(): string {
  const root = path.join(tempRoot(), 'Fixture library')
  fs.cpSync(FIXTURE_LIBRARY, root, { recursive: true })
  return root
}

/** Every file and directory under `root`: content hash, size and mtime. */
export function mtimeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rel, hash] of Object.entries(snapshot(root))) {
    out[rel] = `${hash}:${fs.statSync(path.join(root, rel)).mtimeMs}`
  }
  const walk = (dir: string): void => {
    out[`${path.relative(root, dir) || '.'}/`] = String(fs.statSync(dir).mtimeMs)
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name))
    }
  }
  walk(root)
  return out
}

const WRITE_CALLS = [
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'rename',
  'unlink',
  'rm',
  'rmdir',
  'copyFile',
  'cp',
  'truncate',
  'utimes',
  'chmod',
  'symlink',
  'link'
] as const

function isWriteFlag(flags: unknown): boolean {
  if (flags === undefined) return false
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0
  }
  return /[wa+]/.test(String(flags))
}

/**
 * Spies on every `fs.promises` call that can change a file (and `open` with a
 * write flag) and returns the ones whose path is under `root`. The service and
 * S5's reader only use `fs.promises`.
 */
export function fsWritesUnder(root: string): () => { call: string; path: string }[] {
  const real = fs.realpathSync(root)
  const under = (p: unknown): boolean => {
    if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false
    const s = path.resolve(String(p))
    return [root, real].some((r) => s === r || s.startsWith(r + path.sep))
  }
  const seen: { call: string; path: string }[] = []
  const promises = fs.promises as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  for (const name of WRITE_CALLS) {
    const original = promises[name]
    vi.spyOn(fs.promises, name as never).mockImplementation(((...args: unknown[]) => {
      for (const a of args.slice(0, 2)) if (under(a)) seen.push({ call: name, path: String(a) })
      return original.apply(fs.promises, args)
    }) as never)
  }
  const open = promises.open
  vi.spyOn(fs.promises, 'open').mockImplementation(((...args: unknown[]) => {
    if (under(args[0]) && isWriteFlag(args[1])) seen.push({ call: 'open', path: String(args[0]) })
    return open.apply(fs.promises, args)
  }) as never)
  return () => seen
}
