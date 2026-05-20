import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { InMemoryStorage } from '../helpers/in-memory-storage'

interface BuildOpts {
  initial?: Record<string, unknown>
  downloadsFallbackDir?: string
  scanEpisodeFiles?: Parameters<typeof createColdStorageService>[0]['scanEpisodeFiles']
  invalidateFileCache?: (animeName: string) => void
  broadcasts?: { channel: string; args: unknown[] }[]
}

function buildSvc(opts: BuildOpts = {}) {
  const store = new InMemoryStorage(opts.initial ?? {})
  const broadcasts = opts.broadcasts ?? []
  const svc = createColdStorageService({
    store,
    downloadsFallbackDir: opts.downloadsFallbackDir ?? '/users/me/Downloads',
    sanitizeFilename: (s) => s,
    parseEpisodeFromFilename: () => null,
    scanEpisodeFiles: opts.scanEpisodeFiles ?? (() => ({})),
    invalidateFileCache: opts.invalidateFileCache ?? (() => {}),
    broadcast: (channel, ...args) => broadcasts.push({ channel, args }),
    usageProgressChannel: 'usage-progress',
    cleanupPendingChannel: 'cleanup-pending',
    cleanupFinishedChannel: 'cleanup-finished',
    fileEpisodesChangedChannel: 'file-episodes-changed'
  })
  return { svc, store, broadcasts }
}

describe('ColdStorageService path helpers', () => {
  it('falls back to <downloads>/anime-dl when no downloadDir set in simple mode', () => {
    const { svc } = buildSvc({
      initial: { storageMode: 'simple', downloadDir: '', hotStorageDir: '' }
    })
    expect(svc.getDownloadDir()).toBe(join('/users/me/Downloads', 'anime-dl'))
  })

  it('prefers downloadDir over the fallback in simple mode', () => {
    const { svc } = buildSvc({ initial: { storageMode: 'simple', downloadDir: '/custom/dl' } })
    expect(svc.getDownloadDir()).toBe('/custom/dl')
  })

  it('prefers hotStorageDir over downloadDir in advanced mode', () => {
    const { svc } = buildSvc({
      initial: { storageMode: 'advanced', hotStorageDir: '/hot', downloadDir: '/custom/dl' }
    })
    expect(svc.getDownloadDir()).toBe('/hot')
  })

  it('falls back to downloadDir when advanced mode has no hot dir set', () => {
    const { svc } = buildSvc({
      initial: { storageMode: 'advanced', hotStorageDir: '', downloadDir: '/custom/dl' }
    })
    expect(svc.getDownloadDir()).toBe('/custom/dl')
  })

  it('isAdvanced reflects storageMode exactly', () => {
    expect(buildSvc({ initial: { storageMode: 'advanced' } }).svc.isAdvanced()).toBe(true)
    expect(buildSvc({ initial: { storageMode: 'simple' } }).svc.isAdvanced()).toBe(false)
  })

  it('getColdStorageDir returns empty string when unset', () => {
    expect(buildSvc().svc.getColdStorageDir()).toBe('')
    expect(buildSvc({ initial: { coldStorageDir: '/cold' } }).svc.getColdStorageDir()).toBe('/cold')
  })

  it('dirsForScan only includes cold dir when advanced+configured', () => {
    expect(
      buildSvc({
        initial: { storageMode: 'simple', downloadDir: '/hot', coldStorageDir: '/cold' }
      }).svc.dirsForScan()
    ).toEqual(['/hot'])
    expect(
      buildSvc({
        initial: { storageMode: 'advanced', hotStorageDir: '/hot', coldStorageDir: '/cold' }
      }).svc.dirsForScan()
    ).toEqual(['/hot', '/cold'])
    expect(
      buildSvc({
        initial: { storageMode: 'advanced', hotStorageDir: '/hot', coldStorageDir: '' }
      }).svc.dirsForScan()
    ).toEqual(['/hot'])
  })
})

describe('ColdStorageService write-side disk ops', () => {
  let tmpRoot: string
  let hotDir: string
  let coldDir: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(join(os.tmpdir(), 'cold-storage-test-'))
    hotDir = join(tmpRoot, 'hot')
    coldDir = join(tmpRoot, 'cold')
    fs.mkdirSync(hotDir, { recursive: true })
    fs.mkdirSync(coldDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function writeFile(dir: string, sub: string, name: string, body = 'data'): string {
    const animeDir = join(dir, sub)
    fs.mkdirSync(animeDir, { recursive: true })
    const p = join(animeDir, name)
    fs.writeFileSync(p, body)
    return p
  }

  function svcWithDirs(extra: Record<string, unknown> = {}) {
    return buildSvc({
      initial: {
        storageMode: 'advanced',
        hotStorageDir: hotDir,
        coldStorageDir: coldDir,
        downloadedEpisodes: {},
        watchProgress: {},
        downloadedAnime: {},
        cleanupLog: [],
        ...extra
      }
    })
  }

  it('episodeFileExists matches tagged and untagged variants', () => {
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 01 [Crunchy].mkv')
    expect(svc.episodeFileExists('Show', '1', 'Crunchy')).toBe(true)
    expect(svc.episodeFileExists('Show', '1', 'OtherTeam')).toBe(false)
    writeFile(hotDir, 'Show', 'Show - 02.mp4')
    expect(svc.episodeFileExists('Show', '2', '')).toBe(true)
    expect(svc.episodeFileExists('Show', '99', '')).toBe(false)
  })

  it('episodeHasInProgressDownload detects a .part file', () => {
    const { svc } = svcWithDirs()
    expect(svc.episodeHasInProgressDownload('Show', '1')).toBe(false)
    writeFile(hotDir, 'Show', 'Show - 01.mp4.part')
    expect(svc.episodeHasInProgressDownload('Show', '1')).toBe(true)
  })

  it('pruneDownloadedEpisode drops keys only when no on-disk file backs the translation', () => {
    const { svc, store } = svcWithDirs({
      downloadedEpisodes: {
        '7:1:42': { translationType: 'sub', author: 'A', quality: 720, translationId: 42 },
        '7:1': { translationType: 'sub', author: 'A', quality: 720, translationId: 42 }
      }
    })

    // File exists for author A → no-op
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv')
    svc.pruneDownloadedEpisode(7, '1', 42, 'Show', 'A')
    expect(Object.keys(store.get<Record<string, unknown>>('downloadedEpisodes')!).sort()).toEqual([
      '7:1',
      '7:1:42'
    ])

    // Delete the file, then prune drops both the tagged and the legacy twin
    fs.rmSync(hotDir, { recursive: true, force: true })
    fs.mkdirSync(hotDir, { recursive: true })
    svc.pruneDownloadedEpisode(7, '1', 42, 'Show', 'A')
    expect(Object.keys(store.get<Record<string, unknown>>('downloadedEpisodes')!)).toEqual([])
  })

  it('deleteEpisodeFiles untargeted: removes every base-matching file across hot+cold', () => {
    const invalidations: string[] = []
    const tracking = buildSvc({
      initial: {
        storageMode: 'advanced',
        hotStorageDir: hotDir,
        coldStorageDir: coldDir,
        downloadedEpisodes: {
          '7:1:1': { translationType: 'sub', author: 'A', quality: 0, translationId: 1 },
          '7:1': { translationType: 'sub', author: 'A', quality: 0, translationId: 1 }
        }
      },
      invalidateFileCache: (n) => invalidations.push(n)
    })

    writeFile(hotDir, 'Show', 'Show - 01.mkv', 'aaa')
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv', 'bbbb')
    writeFile(coldDir, 'Show', 'Show - 01.mp4', 'cc')
    writeFile(hotDir, 'Show', 'Show - 02.mkv', 'untouched') // different episode

    const { bytesDeleted } = tracking.svc.deleteEpisodeFiles('Show', '1', 7)
    expect(bytesDeleted).toBe(3 + 4 + 2)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01.mkv'))).toBe(false)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [A].mkv'))).toBe(false)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01.mp4'))).toBe(false)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 02.mkv'))).toBe(true)
    expect(Object.keys(tracking.store.get<Record<string, unknown>>('downloadedEpisodes')!)).toEqual(
      []
    )
    expect(invalidations).toEqual(['Show'])
  })

  it('deleteEpisodeFiles with translationId: only removes the tagged variant + legacy twin', () => {
    const { svc, store } = svcWithDirs({
      downloadedEpisodes: {
        '7:1:42': { translationType: 'sub', author: 'A', quality: 0, translationId: 42 },
        '7:1:43': { translationType: 'sub', author: 'B', quality: 0, translationId: 43 }
      }
    })
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv', 'aaa')
    writeFile(hotDir, 'Show', 'Show - 01 [B].mkv', 'bbbb')
    svc.deleteEpisodeFiles('Show', '1', 7, 42)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [A].mkv'))).toBe(false)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [B].mkv'))).toBe(true)
    expect(Object.keys(store.get<Record<string, unknown>>('downloadedEpisodes')!).sort()).toEqual([
      '7:1:43'
    ])
  })

  it('moveEpisodeToColdStorage moves matching files from hot to cold, skips .part-shadowed mp4s', async () => {
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 01.mkv', 'x')
    writeFile(hotDir, 'Show', 'Show - 01 [A].ass', 'y')
    writeFile(hotDir, 'Show', 'Show - 01.mp4', 'z') // shadowed by .part
    writeFile(hotDir, 'Show', 'Show - 01.mp4.part', 'p')

    await svcMoveEpisode(svc, 'Show', '1')
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01.mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [A].ass'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01.mp4'))).toBe(false)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01.mp4'))).toBe(true) // still in hot
  })

  it('moveAllFilesToColdStorage skips .part files + their mp4 shadow + non-media files', async () => {
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'A', 'A - 01.mkv')
    writeFile(hotDir, 'A', 'A - 02.mp4')
    writeFile(hotDir, 'A', 'A - 02.mp4.part')
    writeFile(hotDir, 'A', 'A - 02.txt') // non-media
    const result = await svc.moveAllFilesToColdStorage()
    expect(result.moved).toBe(1) // only A - 01.mkv
    expect(fs.existsSync(join(coldDir, 'A', 'A - 01.mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'A', 'A - 02.mp4'))).toBe(false)
    expect(result.failed).toEqual([])
  })

  describe('findCleanupCandidates + runWatchedCleanup', () => {
    const dayMs = 86400_000
    const now = Date.now()

    it('findCleanupCandidates returns only watched-and-aged episodes with a file backing them', () => {
      const { svc } = svcWithDirs({
        watchProgress: {
          '7:1': { watched: true, watchedAt: now - 14 * dayMs },
          '7:2': { watched: true, watchedAt: now - 1 * dayMs }, // too fresh
          '7:3': { watched: false, watchedAt: now - 14 * dayMs } // unwatched
        },
        downloadedAnime: { '7': { title: 'Show', titles: {} } }
      })
      writeFile(hotDir, 'Show', 'Show - 01.mkv', 'x'.repeat(100))
      writeFile(hotDir, 'Show', 'Show - 02.mkv', 'y'.repeat(50))
      writeFile(hotDir, 'Show', 'Show - 03.mkv', 'z'.repeat(50))
      const candidates = svc.findCleanupCandidates(7) // 7-day cutoff
      expect(candidates).toHaveLength(1)
      expect(candidates[0]).toMatchObject({
        animeId: 7,
        animeName: 'Show',
        episodeInt: '1',
        bytes: 100
      })
    })

    it('returns [] for days <= 0', () => {
      const { svc } = svcWithDirs()
      expect(svc.findCleanupCandidates(0)).toEqual([])
      expect(svc.findCleanupCandidates(-1)).toEqual([])
    })

    it('runWatchedCleanup broadcasts pending when confirm-required and not forced', async () => {
      const { svc, broadcasts } = svcWithDirs({
        autoCleanupWatchedDays: 7,
        autoCleanupConfirm: true,
        watchProgress: { '7:1': { watched: true, watchedAt: now - 14 * dayMs } },
        downloadedAnime: { '7': { title: 'Show', titles: {} } }
      })
      writeFile(hotDir, 'Show', 'Show - 01.mkv', 'x'.repeat(100))
      const result = await svc.runWatchedCleanup(false)
      expect(result.deletedCount).toBe(0)
      const pending = broadcasts.find((b) => b.channel === 'cleanup-pending')
      expect(pending).toBeDefined()
      expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01.mkv'))).toBe(true)
    })

    it('runWatchedCleanup with force=true deletes and broadcasts finished', async () => {
      const { svc, broadcasts, store } = svcWithDirs({
        autoCleanupWatchedDays: 7,
        autoCleanupConfirm: true,
        watchProgress: { '7:1': { watched: true, watchedAt: now - 14 * dayMs } },
        downloadedAnime: { '7': { title: 'Show', titles: {} } }
      })
      writeFile(hotDir, 'Show', 'Show - 01.mkv', 'x'.repeat(123))
      const result = await svc.runWatchedCleanup(true)
      expect(result.deletedCount).toBe(1)
      expect(result.freedBytes).toBe(123)
      expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01.mkv'))).toBe(false)
      expect(broadcasts.some((b) => b.channel === 'cleanup-finished')).toBe(true)
      // autoCleanupLastRun is recorded
      expect(
        store.get<{ deletedCount: number; freedBytes: number }>('autoCleanupLastRun')
      ).toMatchObject({ deletedCount: 1, freedBytes: 123 })
    })

    it('runWatchedCleanup no-ops when days is 0 and not forced', async () => {
      const { svc } = svcWithDirs({ autoCleanupWatchedDays: 0 })
      const result = await svc.runWatchedCleanup(false)
      expect(result.deletedCount).toBe(0)
    })
  })
})

// Helper so the awaited move test reads cleanly.
async function svcMoveEpisode(
  svc: ReturnType<typeof createColdStorageService>,
  animeName: string,
  episodeInt: string
): Promise<void> {
  await svc.moveEpisodeToColdStorage(animeName, episodeInt)
}
