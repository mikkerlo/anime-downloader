import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  // `dirsForScan()` above moves with `storageMode`; `allConfiguredRoots()` must
  // not, or the GC in `downloaded-episodes-get` deletes metadata for files it
  // merely cannot see after a settings toggle (#421).
  it('allConfiguredRoots spans every stored root regardless of storageMode', () => {
    const initial = {
      hotStorageDir: '/hot',
      downloadDir: '/custom/dl',
      coldStorageDir: '/cold'
    }
    expect(
      buildSvc({ initial: { ...initial, storageMode: 'simple' } }).svc.allConfiguredRoots()
    ).toEqual(['/custom/dl', '/hot', '/cold'])
    expect(
      buildSvc({ initial: { ...initial, storageMode: 'advanced' } }).svc.allConfiguredRoots()
    ).toEqual(['/custom/dl', '/hot', '/cold'])
  })

  it('allConfiguredRoots keeps downloadDir in advanced mode, unlike getDownloadDir', () => {
    // The withdrawn formula routed the union through `getDownloadDir()`, which
    // returns `hotStorageDir` here — dropping the root that holds everything
    // downloaded before the user switched to advanced mode.
    const { svc } = buildSvc({
      initial: { storageMode: 'advanced', hotStorageDir: '/hot', downloadDir: '/custom/dl' }
    })
    expect(svc.getDownloadDir()).toBe('/hot')
    expect(svc.allConfiguredRoots()).toContain('/custom/dl')
  })

  it('allConfiguredRoots substitutes the fallback for an empty downloadDir and de-duplicates', () => {
    expect(
      buildSvc({
        initial: { storageMode: 'advanced', downloadDir: '', hotStorageDir: '/hot' }
      }).svc.allConfiguredRoots()
    ).toEqual([join('/users/me/Downloads', 'anime-dl'), '/hot'])
    expect(
      buildSvc({
        initial: { storageMode: 'advanced', downloadDir: '/hot', hotStorageDir: '/hot' }
      }).svc.allConfiguredRoots()
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

  it('episodeFileExists finds an empty-author tag, which is what download-manager writes', () => {
    const { svc } = svcWithDirs()
    // download-manager appends ` [${authorTag}]` unconditionally, so an empty author
    // lands on disk as `Show - NN [].ext`. Both extensions are candidates.
    writeFile(hotDir, 'Show', 'Show - 03 [].mkv')
    expect(svc.episodeFileExists('Show', '3', '')).toBe(true)
    writeFile(hotDir, 'Show', 'Show - 04 [].mp4')
    expect(svc.episodeFileExists('Show', '4', '')).toBe(true)
  })

  // #421: the predicate that both metadata-deleting callers trust. Its answer
  // must not depend on `storageMode`, because nothing migrates files when the
  // mode flips and nothing rewrites the store after the GC has run.
  it('episodeFileExists finds a cold-resident file in simple mode too', () => {
    writeFile(coldDir, 'Show', 'Show - 01 [Crunchy].mkv')
    expect(svcWithDirs().svc.episodeFileExists('Show', '1', 'Crunchy')).toBe(true)
    expect(
      svcWithDirs({ storageMode: 'simple', downloadDir: hotDir }).svc.episodeFileExists(
        'Show',
        '1',
        'Crunchy'
      )
    ).toBe(true)
  })

  it('episodeFileExists finds a downloadDir-resident file in advanced mode too', () => {
    // Setup 4: the file landed in `downloadDir` during simple mode, and
    // `getDownloadDir()` now points at the hot dir instead.
    const otherHot = join(tmpRoot, 'hot2')
    fs.mkdirSync(otherHot, { recursive: true })
    writeFile(hotDir, 'Show', 'Show - 01 [Crunchy].mkv')
    const { svc } = svcWithDirs({ hotStorageDir: otherHot, downloadDir: hotDir })
    expect(svc.getDownloadDir()).toBe(otherHot)
    expect(svc.episodeFileExists('Show', '1', 'Crunchy')).toBe(true)
  })

  it('missingConfiguredRoot names an absent stored root and exempts the fallback', () => {
    // `downloadDir` is '' here and `/users/me/Downloads` does not exist, so a
    // check that included the fallback would report a missing root forever.
    expect(svcWithDirs().svc.missingConfiguredRoot()).toBeNull()
    const away = join(tmpRoot, 'away')
    expect(svcWithDirs({ coldStorageDir: away }).svc.missingConfiguredRoot()).toBe(away)
  })

  it('missingConfiguredRoot returns the first missing root in ROOT_KEYS order', () => {
    // Two roots away at once, which the case above never exercises — and the
    // only shape that can see a reorder of `ROOT_KEYS` (#454). `hotStorageDir`
    // precedes `coldStorageDir` in that array, so the hot one is the answer;
    // swap the array and this test is what reds. The order is load-bearing
    // beyond this function: `StorageTab.vue` maps the returned path back to a
    // key by walking the same list, so the notice's Clear button would start
    // naming a different root.
    const hotAway = join(tmpRoot, 'hot-away')
    const coldAway = join(tmpRoot, 'cold-away')
    const { svc } = svcWithDirs({ hotStorageDir: hotAway, coldStorageDir: coldAway })
    expect(svc.missingConfiguredRoot()).toBe(hotAway)

    // The mirror: with only the cold one away the answer moves, so the test
    // above is reading the order rather than just the first truthy key.
    expect(
      svcWithDirs({ hotStorageDir: hotDir, coldStorageDir: coldAway }).svc.missingConfiguredRoot()
    ).toBe(coldAway)
  })

  it('pruneDownloadedEpisode is a no-op while a configured root is away', () => {
    const away = join(tmpRoot, 'away')
    const entries = {
      '1:1:7': { translationType: 'subRu', author: 'Crunchy', quality: 720, translationId: 7 }
    }
    const { svc, store } = svcWithDirs({ coldStorageDir: away, downloadedEpisodes: entries })
    svc.pruneDownloadedEpisode(1, '1', 7, 'Show', 'Crunchy')
    expect(store.get('downloadedEpisodes')).toEqual(entries)
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

  it('pruneDownloadedEpisode keeps an empty-author entry whose tagged file is on disk', () => {
    const { svc, store } = svcWithDirs({
      downloadedEpisodes: {
        '7:3:42': { translationType: 'sub', author: '', quality: 720, translationId: 42 },
        '7:3': { translationType: 'sub', author: '', quality: 720, translationId: 42 }
      }
    })

    // The video is on disk under the empty tag download-manager writes → prune must no-op
    writeFile(hotDir, 'Show', 'Show - 03 [].mkv')
    svc.pruneDownloadedEpisode(7, '3', 42, 'Show', '')
    expect(Object.keys(store.get<Record<string, unknown>>('downloadedEpisodes')!).sort()).toEqual([
      '7:3',
      '7:3:42'
    ])
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

    await svcMoveEpisode(svc, 'Show', '1', 'A')
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01.mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [A].ass'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01.mp4'))).toBe(false)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01.mp4'))).toBe(true) // still in hot
  })

  it('moveEpisodeToColdStorage logs a per-file failure and still moves the rest', async () => {
    // Regression for #414: the loop's only `catch` was the outer one around
    // `readdirSync`, so the first file that failed to move abandoned every file
    // behind it — silently, since the catch was bare. With autoMoveToCold on
    // that left the merged .mkv in hot and printed nothing at all.
    const { svc } = svcWithDirs()
    // Sorts first, and cannot be moved: its cold destination is a non-empty
    // directory, so `renameSync` fails and the `copyFile` fallback fails too.
    writeFile(hotDir, 'Show', 'Show - 01 [A].ass', 'y')
    fs.mkdirSync(join(coldDir, 'Show', 'Show - 01 [A].ass'), { recursive: true })
    fs.writeFileSync(join(coldDir, 'Show', 'Show - 01 [A].ass', 'occupied'), 'x')
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv', 'x')

    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args)
    })
    try {
      await svcMoveEpisode(svc, 'Show', '1', 'A')
    } finally {
      spy.mockRestore()
    }

    // The file behind the failure still reached cold.
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [A].mkv'))).toBe(true)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [A].mkv'))).toBe(false)
    // The unmovable one stayed in hot rather than vanishing.
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [A].ass'))).toBe(true)
    // …and the failure was logged, naming the file, instead of being swallowed.
    expect(errors).toHaveLength(1)
    expect(String(errors[0][0])).toContain('Show - 01 [A].ass')
  })

  // #416. Every case below carries a *positive control* — an assertion that the
  // requested translation's own file reached cold — because the failure these
  // tests guard against and the failure "the matcher matched nothing at all"
  // both leave the sibling in hot. Without the control, a mover that moves
  // nothing passes every "stays in hot" assertion here.
  it('moveEpisodeToColdStorage leaves a sibling translation of the same episode in hot', async () => {
    // Red before the fix: the prefix was `Show - 01`, which stops before the
    // ` [author]` tag, so moving X swept Y's files too — and Y can still be
    // mid-download.
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 01 [X].mkv', 'x-video')
    writeFile(hotDir, 'Show', 'Show - 01 [X].ass', 'x-subs')
    writeFile(hotDir, 'Show', 'Show - 01 [Y].mkv', 'y-video')
    writeFile(hotDir, 'Show', 'Show - 01 [Y].ass', 'y-subs')

    await svcMoveEpisode(svc, 'Show', '1', 'X')

    // Positive control: the mover did fire and did move X's pair.
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [X].mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [X].ass'))).toBe(true)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [X].mkv'))).toBe(false)
    // …and Y stayed put, by exact path on both sides.
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [Y].mkv'))).toBe(true)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [Y].ass'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [Y].mkv'))).toBe(false)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [Y].ass'))).toBe(false)
  })

  it('moveEpisodeToColdStorage moving episode 10 does not sweep episode 100', async () => {
    // Red before the fix: `padStart(2, '0')` pads to two digits and no further,
    // so `Show - 10` is an unbounded prefix of `Show - 100`.
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 10 [A].mkv', 'ten')
    writeFile(hotDir, 'Show', 'Show - 100 [A].mkv', 'hundred')

    await svcMoveEpisode(svc, 'Show', '10', 'A')

    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 10 [A].mkv'))).toBe(true) // control
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 100 [A].mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 100 [A].mkv'))).toBe(false)
  })

  it('moveEpisodeToColdStorage moving episode 10 does not sweep episode 10.5', async () => {
    // Red before the fix, same unbounded prefix. Fractional episodes are real
    // and preserved verbatim — `lib/filename.ts` is pinned on `- 5.5`.
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 10 [A].mkv', 'ten')
    writeFile(hotDir, 'Show', 'Show - 10.5 [A].mkv', 'ten-point-five')

    await svcMoveEpisode(svc, 'Show', '10', 'A')

    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 10 [A].mkv'))).toBe(true) // control
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 10.5 [A].mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 10.5 [A].mkv'))).toBe(false)
  })

  it('moveEpisodeToColdStorage still pads a single-digit episodeInt to the on-disk form', async () => {
    // Non-regression: `'5'.padStart(2, '0')` is `'05'` on both sides, and a
    // caller that already passes `'05'` lands on the same name.
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 05 [A].mkv', 'five')
    await svcMoveEpisode(svc, 'Show', '5', 'A')
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 05 [A].mkv'))).toBe(true)

    writeFile(hotDir, 'Show', 'Show - 06 [A].mkv', 'six')
    await svcMoveEpisode(svc, 'Show', '06', 'A')
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 06 [A].mkv'))).toBe(true)
  })

  it('moveEpisodeToColdStorage matches the empty-author `[]` form enqueue writes', async () => {
    // Non-regression, and the case that rules out routing this through
    // `parseEpisodeFromFilename`: `enqueue` appends the tag unconditionally, so
    // an empty `author` produces `Show - 01 [].mkv`, which the parser's
    // `\[[^\]]+\]` rejects. The tag is appended unconditionally here too, the
    // way `deleteEpisodeFiles` does it — not made conditional the way
    // `episodeFileExists` does, which looks for the bare base instead.
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 01 [].mkv', 'untagged-author')
    await svcMoveEpisode(svc, 'Show', '1', '')
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [].mkv'))).toBe(true)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [].mkv'))).toBe(false)
  })

  it('moveEpisodeToColdStorage moves every present candidate when the .mp4 is absent', async () => {
    // Non-regression that catches the iterate-the-candidate-names shape: with no
    // `.mp4` on disk (the normal state after a merge), `moveFileToCold`'s
    // `copyFile` fallback would reject ENOENT for that name and, depending on
    // where the `try` sits, leave the `.ass` behind.
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv', 'video')
    writeFile(hotDir, 'Show', 'Show - 01 [A].ass', 'subs')

    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args)
    })
    try {
      await svcMoveEpisode(svc, 'Show', '1', 'A')
    } finally {
      spy.mockRestore()
    }

    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [A].mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [A].ass'))).toBe(true)
    // A missing candidate is the normal case, not a failure worth logging.
    expect(errors).toEqual([])
  })

  it('moveFileToColdByRelPath moves exactly the named file, sweeping no sibling translation', async () => {
    // #414's exact-file entry: the path is relative to the *download dir* and
    // already carries the anime directory, so it must not be joined onto a
    // per-anime hot dir (that would name <hot>/Show/Show/… and match nothing).
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv', 'x')
    writeFile(hotDir, 'Show', 'Show - 01 [B].mp4', 'sibling-video')
    writeFile(hotDir, 'Show', 'Show - 01 [B].ass', 'sibling-subs')

    await svc.moveFileToColdByRelPath(join('Show', 'Show - 01 [A].mkv'))

    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [A].mkv'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show', 'Show - 01 [A].mkv'))).toBe(false)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [A].mkv'))).toBe(false)
    // The sibling translation's unmerged sources are untouched.
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [B].mp4'))).toBe(true)
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [B].ass'))).toBe(true)
    expect(fs.existsSync(join(coldDir, 'Show', 'Show - 01 [B].mp4'))).toBe(false)
  })

  it('moveFileToColdByRelPath logs a failed move and resolves instead of rejecting', async () => {
    // The merge tail does not guard this call: `handleMergeComplete` awaits it
    // bare, and DownloadManager's merge pass drops the promise the handler
    // returns. So a rejection here would skip the merge notification and the
    // skip-analysis schedule, then land as an unhandled rejection. Same
    // occupied-destination trick as the per-file case above.
    const { svc } = svcWithDirs()
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv', 'x')
    fs.mkdirSync(join(coldDir, 'Show', 'Show - 01 [A].mkv'), { recursive: true })
    fs.writeFileSync(join(coldDir, 'Show', 'Show - 01 [A].mkv', 'occupied'), 'x')

    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args)
    })
    try {
      await expect(
        svc.moveFileToColdByRelPath(join('Show', 'Show - 01 [A].mkv'))
      ).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }

    // The failure was logged, naming the file, instead of escaping the mover.
    expect(errors).toHaveLength(1)
    expect(String(errors[0][0])).toContain('Show - 01 [A].mkv')
    // …and the unmovable source stayed in hot rather than vanishing.
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [A].mkv'))).toBe(true)
  })

  it('moveFileToColdByRelPath no-ops when cold is unconfigured or the file is gone', async () => {
    const { svc } = svcWithDirs()
    // Missing source: no throw, and no empty directory left in cold.
    await svc.moveFileToColdByRelPath(join('Show', 'Show - 99 [A].mkv'))
    expect(fs.existsSync(join(coldDir, 'Show'))).toBe(false)

    const { svc: simple } = buildSvc({
      initial: { storageMode: 'advanced', hotStorageDir: hotDir, coldStorageDir: '' }
    })
    writeFile(hotDir, 'Show', 'Show - 01 [A].mkv', 'x')
    await simple.moveFileToColdByRelPath(join('Show', 'Show - 01 [A].mkv'))
    expect(fs.existsSync(join(hotDir, 'Show', 'Show - 01 [A].mkv'))).toBe(true)
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

// Helper so the awaited move tests read cleanly. The parameter names are the
// production ones on purpose (#416): the old helper called its second parameter
// `episodeInt` while every caller in `src/` passed `episodeLabel`, which is how
// the field mismatch stayed invisible here for as long as it did.
async function svcMoveEpisode(
  svc: ReturnType<typeof createColdStorageService>,
  animeName: string,
  episodeInt: string,
  author: string
): Promise<void> {
  await svc.moveEpisodeToColdStorage(animeName, episodeInt, author)
}
