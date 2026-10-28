// Builders, trees and fs probes for the Shared Library format tests (#573).
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { vi } from 'vitest'

export const LIB = '3b0e7a52-5c1f-4d8e-9a6b-2f4c8d1e7a90'
export const OTHER_LIB = '9c2d4e6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f'
export const OWNER_ID = 4242
export const FIXTURES = path.resolve(__dirname, '../fixtures/shared-library/v1')
export const SCHEMA_FIXTURE = path.resolve(__dirname, '../fixtures/shared-library/schema-v1.json')

export const OWNER: SharedLibraryActor = {
  installId: 'pc-owner',
  appVersion: '5.0.25',
  shikimoriUserId: OWNER_ID,
  claim: null
}
export const STRANGER: SharedLibraryActor = {
  installId: 'pc-stranger',
  appVersion: '5.0.25',
  shikimoriUserId: 777,
  claim: null
}
export const LOGGED_OUT: SharedLibraryActor = {
  installId: 'pc-anon',
  appVersion: '5.0.25',
  shikimoriUserId: null,
  claim: null
}
export const CLAIMANT: SharedLibraryActor = {
  installId: 'pc-claim',
  appVersion: '5.0.25',
  shikimoriUserId: null,
  claim: { libraryId: LIB, ownerId: OWNER_ID }
}

export function item(episodeInt: string, translationId: number, extra: object = {}): object {
  const ep = episodeInt.padStart(2, '0')
  return {
    animeId: 101,
    episodeInt,
    translationId,
    translationType: 'subRu',
    author: 'Crunchyroll',
    quality: 1080,
    path: `Frieren/Frieren - ${ep} [Crunchyroll].mkv`,
    size: 1000 + translationId,
    ...extra
  }
}

/** A minimal valid item, so 200,001 of them stay under the 32 MB manifest cap. */
export function tinyItem(translationId: number): object {
  return {
    animeId: 1,
    episodeInt: '1',
    translationId,
    translationType: 't',
    author: 'a',
    quality: 1,
    path: 'a/b.mkv',
    size: 1
  }
}

/** A manifest at `generation` / `stateGeneration`, in the serializer's order. */
export function manifest(
  generation: number,
  stateGeneration: number | null,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  const videos = over.mode === 'videos'
  return {
    layoutVersion: 1,
    layoutMinor: 0,
    libraryId: LIB,
    name: 'Test library',
    owner: videos ? null : { shikimoriId: OWNER_ID, nickname: 'owner' },
    mode: 'metadata',
    generation,
    stateGeneration,
    lastWriter: { installId: 'pc-owner', appVersion: '5.0.24', at: 1761600000000 },
    titles: [{ animeId: 101, name: 'Frieren' }],
    items: [item('1', 9001), item('2', 9002)],
    naming: { rule: 'v1', renamed: [] },
    ...over
  }
}

/** A state envelope at `generation` / `manifestGeneration`, in the serializer's order. */
export function state(
  generation: number,
  manifestGeneration: number,
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    stateVersion: 1,
    stateMinor: 0,
    libraryId: LIB,
    generation,
    manifestGeneration,
    doc: {
      stateVersion: 1,
      stateMinor: 0,
      installId: 'pc-owner',
      titles: {
        '101': {
          watch: {
            '1': {
              position: {
                value: { position: 10 * generation, duration: 1440, translationId: 9001 },
                at: 1000 + generation,
                origin: 'pc-owner'
              },
              watched: { value: false, at: 1000, origin: 'pc-owner' },
              watchedAt: null
            }
          },
          starred: { value: true, at: 900, origin: 'pc-owner' }
        }
      },
      priorityOrder: { value: ['101'], at: 800, origin: 'pc-owner' },
      tombstones: {}
    },
    ...over
  }
}

export const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** A fresh temp root, removed by `cleanup`. */
const roots: string[] = []
export function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anime-dl-shared-lib-'))
  roots.push(root)
  return root
}
export function cleanup(): void {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
}

/** Writes `.anime-dl/<name>` files (objects as canonical JSON, strings verbatim) into a fresh root. */
export function tree(files: Record<string, unknown>): string {
  const root = tempRoot()
  const dir = path.join(root, '.anime-dl')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof value === 'string' ? value : text(value))
  }
  return root
}

/** A checked-in fixture tree, copied into a fresh root. */
export function fixture(name: string): string {
  const root = tempRoot()
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true })
  return root
}

export function fixtureText(name: string, file: string): string {
  return fs.readFileSync(path.join(FIXTURES, name, '.anime-dl', file), 'utf8')
}

export function readJson(root: string, file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(root, '.anime-dl', file), 'utf8'))
}

export function readText(root: string, file: string): string {
  return fs.readFileSync(path.join(root, '.anime-dl', file), 'utf8')
}

export function exists(root: string, file: string): boolean {
  return fs.existsSync(path.join(root, '.anime-dl', file))
}

/** Every file under `root`: relative path → size and content hash. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const buf = fs.readFileSync(p)
        out[path.relative(root, p)] =
          `${buf.length}:${createHash('sha256').update(buf).digest('hex')}`
      }
    }
  }
  walk(root)
  return out
}

export class CrashError extends Error {
  constructor() {
    super('injected crash')
  }
}

/**
 * Makes the `n`-th mutating fs call (`open`, `unlink`, `rename` on
 * `fs.promises`; the writer's only mutations) throw `CrashError`, as if the
 * drive were pulled right before it. Returns a counter of the calls seen.
 */
export function crashAt(n: number): { calls: () => number; restore: () => void } {
  let count = 0
  const spies = (['open', 'unlink', 'rename'] as const).map((name) => {
    const original = fs.promises[name] as (...args: unknown[]) => Promise<unknown>
    return vi.spyOn(fs.promises, name).mockImplementation((async (...args: unknown[]) => {
      count++
      if (count === n) throw new CrashError()
      return original.apply(fs.promises, args)
    }) as never)
  })
  return { calls: () => count, restore: () => spies.forEach((s) => s.mockRestore()) }
}

/** Writes a sparse file of `size` bytes. */
export function sparse(root: string, file: string, size: number): void {
  const p = path.join(root, '.anime-dl', file)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const fd = fs.openSync(p, 'w')
  fs.ftruncateSync(fd, size)
  fs.closeSync(fd)
}
