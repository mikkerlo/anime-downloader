// Attached Shared Library roots are never storage roots (#582). Every consumer
// of a storage root is enumerated here: the `ROOT_KEYS` settings, the
// `coldStorageService` roots, the usage scan, `findCleanupCandidates`, the
// episode-file scan, the player's `dirsToCheck` and `download:scan-merge`. With
// a library attached at one path and then re-plugged at another, none of them
// is handed, or touches, a path under either root. S7a (#578) added the first
// guard (only the attached-library service knows these roots); this pins it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BrowserWindow, ipcMain } from 'electron'
import * as fs from 'fs'
import { createRequire, syncBuiltinESMExports } from 'module'
import * as path from 'path'
import { register as registerPlayer } from '../../src/main/ipc/player.ipc'
import { register as registerDownloads } from '../../src/main/ipc/downloads.ipc'
import { CHANNELS } from '../../src/shared/ipc/channels'
import { ROOT_KEYS } from '../../src/shared/storage-roots'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { createEpisodeFileScanner } from '../../src/main/lib/episode-file-scan'
import { sanitizeFilename } from '../../src/main/download-manager'
import { parseEpisodeFromFilename } from '../../src/main/lib/filename'
import type { AppDeps } from '../../src/main/ipc'
import { makeHarness } from '../helpers/app-harness'
import { cleanup, tempRoot } from '../helpers/shared-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary } from '../helpers/attached-library'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const requireCjs = createRequire(import.meta.url)

const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8')

const ANIME = 'Dungeon Meshi'
const OWNER = { id: 4242, nickname: 'owner', avatar: '' }

interface Rig {
  svc: ReturnType<typeof createAttachedLibraryService>
  cold: ReturnType<typeof createColdStorageService>
  store: ReturnType<typeof makeHarness>['store']
  handlers: Map<string, Handler>
  scanMerge: ReturnType<typeof vi.fn>
  scanner: ReturnType<typeof createEpisodeFileScanner>
  /** Every attached root this run has had, as picked and as realpath'd. */
  attachedRoots: Set<string>
  plugAt: (dir: string) => Promise<void>
}

let rig: Rig

beforeEach(async () => {
  const base = fs.realpathSync(tempRoot())
  const hot = path.join(base, 'hot')
  const coldDir = path.join(base, 'cold')
  const dl = path.join(base, 'downloads')
  for (const d of [hot, coldDir, dl]) fs.mkdirSync(path.join(d, ANIME), { recursive: true })
  // A local copy of another episode, so every scan has something to walk.
  fs.writeFileSync(path.join(hot, ANIME, `${ANIME} - 02 [AniLibria].mkv`), 'local')
  const harness = makeHarness({
    shikimoriUser: OWNER,
    storageMode: 'advanced',
    downloadDir: dl,
    hotStorageDir: hot,
    coldStorageDir: coldDir,
    downloadedAnime: { '202': { id: 202, title: ANIME } },
    // Episode 1's metadata says it was downloaded, so the player's local
    // resolution walks `dirsToCheck` before falling back to the drive.
    downloadedEpisodes: {
      '202:1': {
        translationType: 'voiceRu',
        author: 'AniLibria',
        quality: 720,
        translationId: 9101
      },
      '202:2': {
        translationType: 'voiceRu',
        author: 'AniLibria',
        quality: 720,
        translationId: 9102
      }
    },
    watchProgress: {
      '202:1': { position: 0, duration: 1400, updatedAt: 1, watched: true, watchedAt: 1 },
      '202:2': { position: 0, duration: 1400, updatedAt: 1, watched: true, watchedAt: 1 }
    },
    attachedLibraries: {}
  })
  const scanner = createEpisodeFileScanner({
    // The same wiring as `src/main/index.ts` (pinned below).
    getDirsToScan: () => {
      const dirs = [cold.getDownloadDir()]
      if (cold.isAdvanced()) {
        const c = cold.getColdStorageDir()
        if (c) dirs.push(c)
      }
      return dirs
    },
    sanitizeFilename,
    onEpisodesChanged: () => {}
  })
  const cold = createColdStorageService({
    store: harness.store as never,
    downloadsFallbackDir: dl,
    sanitizeFilename,
    parseEpisodeFromFilename,
    scanEpisodeFiles: (name) => scanner.scanEpisodeFiles(name),
    invalidateFileCache: () => {},
    broadcast: harness.broadcast,
    usageProgressChannel: 'usage-progress',
    cleanupPendingChannel: 'cleanup-pending',
    cleanupFinishedChannel: 'cleanup-finished',
    fileEpisodesChangedChannel: 'file-episodes-changed'
  })
  const svc = createAttachedLibraryService({
    store: harness.store,
    checkFfmpeg: async () => ({ available: true }),
    log: { log: () => {}, warn: () => {}, error: () => {} }
  })
  const scanMerge = vi.fn(async () => ({ merged: 0, failed: [] }))
  const deps = {
    store: harness.store,
    smotretApi: {},
    coldStorageService: cold,
    streamingService: {},
    mp4StatsService: { recordCheck: vi.fn() },
    downloadManager: {
      getMergeStatus: vi.fn().mockReturnValue(null),
      getPartialVideoPath: vi.fn().mockReturnValue(null),
      scanAndMerge: scanMerge
    },
    animeCacheService: {},
    playerLockService: { open: vi.fn(), close: vi.fn() },
    playerPresenceService: { open: vi.fn(), close: vi.fn() },
    getFfmpegPath: () => '/bin/ffmpeg',
    getFfprobePath: () => '',
    attachedLibraryService: svc
  } as unknown as AppDeps
  ;(BrowserWindow as unknown as { getAllWindows: () => [] }).getAllWindows = () => []
  ;(ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockClear()
  registerPlayer(deps)
  registerDownloads(deps)
  const handlers = new Map(
    (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls
  )

  const mounts = path.join(base, 'mounts')
  const attachedRoots = new Set<string>()
  let current: string | null = null
  const plugAt = async (dir: string): Promise<void> => {
    const root = path.join(mounts, dir, 'Fixture library')
    fs.mkdirSync(path.dirname(root), { recursive: true })
    if (current) {
      fs.renameSync(current, root)
      svc.markUnavailable(FIXTURE_LIBRARY_ID, current)
      expect(await svc.reopenAt(FIXTURE_LIBRARY_ID, root)).toBe(true)
    } else {
      fs.cpSync(copyFixtureLibrary(), root, { recursive: true })
      await svc.discover(root)
      const res = await svc.attach(FIXTURE_LIBRARY_ID)
      if (!res.ok) throw new Error(res.error)
    }
    current = root
    for (const r of svc.roots()) attachedRoots.add(r)
    attachedRoots.add(root)
  }
  rig = {
    svc,
    cold,
    store: harness.store,
    handlers,
    scanMerge,
    scanner,
    attachedRoots,
    plugAt
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

const under = (roots: Iterable<string>, p: unknown): boolean => {
  if (typeof p !== 'string' || !p) return false
  const s = path.resolve(p)
  return [...roots].some((r) => s === r || s.startsWith(r + path.sep))
}

/** Every fs call made under an attached root while `fn` runs. */
async function touches(fn: () => unknown): Promise<string[]> {
  const seen: string[] = []
  const sync = ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'rmSync']
  const promises = ['readdir', 'stat', 'lstat', 'readFile', 'opendir', 'rm', 'rename', 'unlink']
  // `fs`'s ESM namespace can't be spied on; patching the builtin and syncing
  // its ESM exports reaches every `import * as fs` in the code under test.
  const cjs = requireCjs('fs') as Record<string, (...a: unknown[]) => unknown>
  const originals = new Map<string, (...a: unknown[]) => unknown>()
  for (const name of sync) {
    const real = cjs[name]
    originals.set(name, real)
    cjs[name] = (...args: unknown[]) => {
      if (under(rig.attachedRoots, args[0])) seen.push(`${name} ${String(args[0])}`)
      return real.apply(cjs, args)
    }
  }
  syncBuiltinESMExports()
  for (const name of promises) {
    const real = (fs.promises as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
    vi.spyOn(fs.promises, name as never).mockImplementation(((...args: unknown[]) => {
      if (under(rig.attachedRoots, args[0])) seen.push(`promises.${name} ${String(args[0])}`)
      return real.apply(fs.promises, args)
    }) as never)
  }
  try {
    await fn()
  } finally {
    for (const [name, real] of originals) cjs[name] = real
    syncBuiltinESMExports()
    vi.restoreAllMocks()
  }
  return seen
}

/** Each consumer, and what it was handed or touched under an attached root. */
async function consumers(): Promise<Record<string, unknown[]>> {
  const r = rig
  const handed = (paths: string[]): string[] => paths.filter((p) => under(r.attachedRoots, p))
  const out: Record<string, unknown[]> = {}
  out.rootKeys = handed(ROOT_KEYS.map((k) => (r.store.get(k) as string) || ''))
  out.coldStorageRoots = handed([
    r.cold.getDownloadDir(),
    r.cold.getColdStorageDir(),
    ...r.cold.dirsForScan(),
    ...r.cold.allConfiguredRoots()
  ])
  out.usageScan = await touches(() => r.cold.scanUsage())
  out.cleanupCandidates = await touches(() => r.cold.findCleanupCandidates(0))
  out.episodeFileScan = await touches(async () => {
    r.scanner.scanEpisodeFiles(ANIME)
    await r.scanner.scanEpisodeFilesAsync(ANIME)
  })
  // The player's local resolution: `dirsToCheck` is walked with `existsSync`
  // before the drive is asked (through `resolveItem`, which is allowed to).
  out.dirsToCheck = (
    await touches(() =>
      r.handlers.get(CHANNELS.PLAYER_FIND_LOCAL_FILE)!({}, ANIME, '1', 9101, '1', 202)
    )
  ).filter((t) => t.startsWith('existsSync '))
  await r.handlers.get(CHANNELS.DOWNLOAD_SCAN_MERGE)!({})
  const [, , , , extraDirs] = r.scanMerge.mock.calls.at(-1) as unknown[]
  out.scanMerge = handed([r.cold.getDownloadDir(), ...((extraDirs as string[] | undefined) ?? [])])
  return out
}

const NONE = {
  rootKeys: [],
  coldStorageRoots: [],
  usageScan: [],
  cleanupCandidates: [],
  episodeFileScan: [],
  dirsToCheck: [],
  scanMerge: []
}

describe('attached roots never reach a storage-root consumer', () => {
  it('attached at one path, then re-plugged at another: no consumer sees either', async () => {
    const setSpy = vi.spyOn(rig.store, 'set')
    await rig.plugAt('E')
    expect(await consumers()).toEqual(NONE)
    await rig.plugAt('F')
    expect(rig.attachedRoots.size).toBeGreaterThanOrEqual(2)
    expect(await consumers()).toEqual(NONE)
    // Attaching and re-plugging never write a storage-root setting.
    expect(
      setSpy.mock.calls.map(([k]) => k).filter((k) => (ROOT_KEYS as readonly string[]).includes(k))
    ).toEqual([])
    // The drive is still what plays.
    const found = (await rig.handlers.get(CHANNELS.PLAYER_FIND_LOCAL_FILE)!(
      {},
      ANIME,
      '1',
      9101,
      '1',
      202
    )) as PlayerLocalFileResult
    expect(found.libraryId).toBe(FIXTURE_LIBRARY_ID)
    expect(under(rig.attachedRoots, found.filePath)).toBe(true)
  })

  it('the spy sees an attached root a consumer was handed (control)', async () => {
    await rig.plugAt('E')
    const root = [...rig.attachedRoots][0]
    expect(await touches(() => fs.existsSync(path.join(root, ANIME)))).toHaveLength(1)
  })
})

describe('the consumers are wired only from storage roots (source pins)', () => {
  it('none of the storage-root modules knows the attached-library service', () => {
    for (const rel of [
      'main/services/cold-storage/index.ts',
      'main/lib/episode-file-scan.ts',
      'main/download-manager.ts',
      'main/ipc/downloads.ipc.ts',
      'main/ipc/storage.ipc.ts',
      'main/ipc/settings.ipc.ts',
      'shared/storage-roots.ts'
    ]) {
      const src = read(rel)
      expect(src, rel).not.toMatch(/attachedLibrar|attached-library/)
    }
  })

  it("main's episode-file scan reads its dirs from coldStorageService alone", () => {
    const src = read('main/index.ts')
    const start = src.indexOf('const fileScanner = createEpisodeFileScanner({')
    const body = src.slice(start, src.indexOf('sanitizeFilename,', start))
    expect(body).toContain('coldStorageService.getDownloadDir()')
    expect(body).not.toMatch(/attached/)
  })

  it("the player's dirsToCheck is built from coldStorageService alone", () => {
    const src = read('main/ipc/player.ipc.ts')
    const start = src.indexOf('const dirsToCheck = [')
    const body = src.slice(start, src.indexOf('const onResolved', start))
    expect(body).toContain('coldStorageService.getDownloadDir()')
    expect(body).not.toMatch(/attached/)
  })
})
