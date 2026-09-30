// The merge tail's cold move (#414).
//
// `_mergeAll` used to invoke `mergeCompleteCallback` *before* unlinking the
// merge sources, and never awaited it. The callback's handler starts a
// cold-storage move that snapshots the hot directory, so the move raced the
// unlinks: it relocated a source file the merge was about to delete and then
// died on one the merge had already deleted.
//
// Two changes fix it, and only together:
//   1. the callback fires after the unlinks, so a handler sees the post-merge
//      directory;
//   2. the callback carries the merged `.mkv`'s download-dir-relative path, and
//      the handler moves exactly that file instead of prefix-matching the
//      episode — because the prefix match carries no author tag and would
//      otherwise sweep a *sibling translation*'s unmerged sources to cold.
//
// Every case here drives the real `mergeCompleted` / `_mergeAll` against a real
// cold-storage service over a real temp hot/cold pair. `runFfmpeg` is private,
// so it is stubbed through an internals cast the way
// `test/services/download-manager-deferred-finalize.test.ts` stubs
// `startDownload`. The stub writes the `.mkv` and **yields on a timer** rather
// than returning an already-resolved promise: a resolved promise drains in the
// same microtask checkpoint as the mover's own `await`, which erases the very
// interleaving under test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  sanitizeFilename,
  type DownloadItem,
  type MergeStatus
} from '../../src/main/download-manager'
import { createColdStorageService } from '../../src/main/services/cold-storage'
import { InMemoryStorage } from '../helpers/in-memory-storage'

/**
 * A writable temp root on a **different filesystem** from `os.tmpdir()`, or
 * `null` if there is none — which is how the copy+delete fallback gets exercised
 * for real rather than simulated.
 *
 * The three routes to a fake EXDEV are all closed here. `moveFileToCold` is a
 * closure inside the service factory, so it cannot be replaced from outside;
 * `vi.spyOn(fs, 'renameSync')` cannot redefine a non-configurable ESM namespace
 * export; and `vi.mock('fs', …)` replaces the `fs` that *vite-node itself*
 * imports, which breaks module resolution for every later test file in the same
 * worker (it surfaces as an unrelated suite failing to resolve a builtin). A
 * real device boundary avoids all of that, and tests the branch the operating
 * system actually takes. CI's `quality` job runs on `ubuntu-latest`, where
 * `/dev/shm` is always a separate tmpfs.
 */
function crossDeviceRoot(): string | null {
  let tmpDev: number
  try {
    tmpDev = fs.statSync(os.tmpdir()).dev
  } catch {
    return null
  }
  for (const candidate of ['/dev/shm', process.env.XDG_RUNTIME_DIR]) {
    if (!candidate) continue
    try {
      if (fs.statSync(candidate).dev === tmpDev) continue
      fs.accessSync(candidate, fs.constants.W_OK)
      return candidate
    } catch {
      /* not present, not writable, or same device */
    }
  }
  return null
}

const CROSS_DEVICE_ROOT = crossDeviceRoot()

const FFMPEG = '/fake/ffmpeg'
const FFPROBE = '/fake/ffprobe'

const ANIME = 'Anime'
const ANIME_DIR = sanitizeFilename(ANIME)

type MergeCompleteInfo = Parameters<Parameters<DownloadManager['onMergeComplete']>[0]>[0]

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  runFfmpeg: (opts: { videoPath: string; outputPath: string }) => Promise<void>
}

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: path.join(ANIME_DIR, 'Anime - 01 [X].mp4'),
    animeName: ANIME,
    animeId: 100,
    episodeInt: '1',
    // episodeLabel is deliberately the numeric `episodeInt`, not the API's
    // display string: the pre-#414 mover pads and prefix-matches whatever label
    // it is handed, so a `"1 серия"`-shaped label (the shape
    // `test/fixtures/smotret/translations-batch.json` actually carries) makes it
    // match nothing at all — the diagnostic run would then go red for "nothing
    // moved" while looking exactly like "the sweep happened" (#416).
    episodeLabel: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'X',
    status: 'completed',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

/** The video + subtitle pair one translation contributes to `getEpisodeGroups()`. */
function translation(tag: string, translationId: number, withSubtitle: boolean): DownloadItem[] {
  const base = `Anime - 01 [${tag}]`
  const items: DownloadItem[] = [
    makeItem({
      id: `video-${translationId}`,
      translationId,
      kind: 'video',
      author: tag,
      filename: path.join(ANIME_DIR, `${base}.mp4`)
    })
  ]
  if (withSubtitle) {
    items.push(
      makeItem({
        id: `sub-${translationId}`,
        translationId,
        kind: 'subtitle',
        author: tag,
        filename: path.join(ANIME_DIR, `${base}.ass`)
      })
    )
  }
  return items
}

/** Every file under `root`, as paths relative to it, sorted. */
function walk(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const rec = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name
      if (entry.isDirectory()) rec(path.join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  rec(root, '')
  return out.sort()
}

describe('DownloadManager merge tail — cold move ordering (#414)', () => {
  let userDataDir: string
  let hotDir: string
  let coldDir: string
  let dm: DownloadManager
  let store: InMemoryStorage
  let svc: ReturnType<typeof createColdStorageService>
  /** Merge-complete payloads, in the order the callback saw them. */
  let seen: MergeCompleteInfo[]
  /** Hot-directory listings taken *inside* the callback, one per merge. */
  let hotAtCallback: string[][]
  /** The fire-and-forget handler promises, joined at the end of each test. */
  let handlerRuns: Promise<void>[]

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-cold-ud-'))
    hotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-cold-hot-'))
    coldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-mgr-cold-cold-'))
    dm = new DownloadManager(hotDir, {} as never, userDataDir)
    store = new InMemoryStorage({
      storageMode: 'advanced',
      hotStorageDir: hotDir,
      coldStorageDir: coldDir,
      autoMoveToCold: true
    })
    svc = createColdStorageService({
      store,
      downloadsFallbackDir: os.tmpdir(),
      sanitizeFilename,
      parseEpisodeFromFilename: () => null,
      scanEpisodeFiles: () => ({}),
      invalidateFileCache: () => {},
      broadcast: () => {},
      usageProgressChannel: 'usage-progress',
      cleanupPendingChannel: 'cleanup-pending',
      cleanupFinishedChannel: 'cleanup-finished',
      fileEpisodesChangedChannel: 'file-episodes-changed'
    })
    seen = []
    hotAtCallback = []
    handlerRuns = []

    // Mirrors `handleMergeComplete`'s cold-move step
    // (`src/main/lib/episode-completion.ts`): registered as a `=> void`
    // callback, so the merge pass does not await it — exactly the
    // fire-and-forget shape that made the race possible.
    dm.onMergeComplete((info) => {
      seen.push(info)
      hotAtCallback.push(walk(hotDir))
      handlerRuns.push(
        (async () => {
          if (!svc.isAdvanced() || !store.get('autoMoveToCold')) return
          await svc.moveFileToColdByRelPath(info.mkvFilename)
        })()
      )
    })
  })

  afterEach(() => {
    dm.destroy()
    for (const d of [userDataDir, hotDir, coldDir]) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  /** Writes the sources every seeded translation claims to have downloaded. */
  function putSources(items: DownloadItem[]): void {
    for (const item of items) {
      const abs = path.join(hotDir, item.filename)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, `${item.kind}-bytes`)
    }
  }

  function seed(items: DownloadItem[]): void {
    const internals = dm as unknown as Internals
    internals.queue = items
    internals.mergeStatuses.clear()
    putSources(items)
  }

  /**
   * Replaces the private `runFfmpeg` with a stub that writes the `.mkv` (so
   * `outputPath` really exists afterwards) and yields on a **timer**. The timer
   * is the point: a resolved promise would settle in the same microtask
   * checkpoint as `moveFileToCold`'s `await`, and the unlinks would never be
   * observed to interleave with the move.
   */
  function stubFfmpeg(): string[] {
    const internals = dm as unknown as Internals
    const outputs: string[] = []
    internals.runFfmpeg = (opts) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          outputs.push(path.relative(hotDir, opts.outputPath))
          fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true })
          fs.writeFileSync(opts.outputPath, 'mkv-bytes')
          resolve()
        }, 0)
      })
    return outputs
  }

  /** Runs the merge cycle and joins the fire-and-forget handlers it released. */
  async function runMerges(): Promise<void> {
    await dm.mergeCompleted(FFMPEG, FFPROBE, 'copy')
    await Promise.all(handlerRuns)
  }

  it('moves each translation of one episode to cold as its own .mkv, and sweeps no sibling', async () => {
    // The case change 1 alone regresses: the mover's key is
    // `sanitizeFilename("Anime - 01")` with **no** author tag, so X's move also
    // matches `[Y].mp4` / `[Y].ass`. Today that is masked by the very abort this
    // issue removes; hoist the callback with the prefix mover still in place and
    // Y's unmerged sources are swept to cold before Y can merge.
    const x = translation('X', 1, true)
    const y = translation('Y', 2, true)
    seed([...x, ...y])
    const outputs = stubFfmpeg()

    await runMerges()

    // Exact cold paths, not "a basename exists somewhere under cold": a
    // double-join lands at cold/<anime>/<anime>/… and a per-anime mover handed
    // an already-anime-prefixed name finds nothing at all. Under the per-file
    // log-and-continue both of those are a log line, never a throw.
    expect(walk(coldDir)).toEqual([
      path.join(ANIME_DIR, 'Anime - 01 [X].mkv'),
      path.join(ANIME_DIR, 'Anime - 01 [Y].mkv')
    ])
    // Y's merge actually ran — it did not merge from a vanished input, and it
    // was not skipped at the `existsSync(videoPath)` gate.
    expect(outputs).toEqual([
      path.join(ANIME_DIR, 'Anime - 01 [X].mkv'),
      path.join(ANIME_DIR, 'Anime - 01 [Y].mkv')
    ])
    expect(dm.getMergeStatus(1)).toBe('completed')
    expect(dm.getMergeStatus(2)).toBe('completed')
    // Nothing left behind in hot, and no source ever reached cold.
    expect(walk(hotDir)).toEqual([])
  })

  it('leaves cold holding only the merged .mkv on one filesystem', async () => {
    // Pre-#414, the same-FS interleaving put the source .ass in cold too: the
    // .ass sorts first, its rename completes, then the mover's `await` yields
    // and the unlinks run — so the .ass survives in cold as an orphan.
    const x = translation('X', 1, true)
    seed(x)
    stubFfmpeg()

    await runMerges()

    expect(walk(coldDir)).toEqual([path.join(ANIME_DIR, 'Anime - 01 [X].mkv')])
    expect(walk(hotDir)).toEqual([])
  })

  it.skipIf(CROSS_DEVICE_ROOT === null)(
    'still lands the .mkv in cold when the move has to fall back to copy+delete',
    async () => {
      // Cross-filesystem, the usual setup — cold storage is normally another
      // drive. A real device boundary makes `renameSync` fail with EXDEV, so
      // `moveFileToCold` takes its `copyFile` + `unlinkSync` fallback, and that
      // `copyFile` yields. Pre-#414 the .ass's fallback yielded, the unlinks
      // ran, and `unlinkSync(src)` then threw ENOENT on the .ass it had just
      // copied — aborting the loop through the bare outer catch *before* the
      // .mkv was reached, so the merged file stayed in hot with autoMoveToCold
      // on and nothing logged.
      const otherFsCold = fs.mkdtempSync(path.join(CROSS_DEVICE_ROOT!, 'dl-mgr-cold-xdev-'))
      store.set('coldStorageDir', otherFsCold)
      try {
        expect(fs.statSync(otherFsCold).dev).not.toBe(fs.statSync(hotDir).dev)
        const x = translation('X', 1, true)
        seed(x)
        stubFfmpeg()

        await runMerges()

        expect(walk(otherFsCold)).toEqual([path.join(ANIME_DIR, 'Anime - 01 [X].mkv')])
        expect(walk(hotDir)).toEqual([])
      } finally {
        fs.rmSync(otherFsCold, { recursive: true, force: true })
      }
    }
  )

  it('fires the merge-complete callback only after the sources are unlinked', async () => {
    // Pins the ordering directly, so a refactor that hoists the callback back
    // above the unlinks reds here rather than only in the filesystem scenarios.
    const x = translation('X', 1, true)
    seed(x)
    stubFfmpeg()

    await runMerges()

    expect(hotAtCallback).toEqual([[path.join(ANIME_DIR, 'Anime - 01 [X].mkv')]])
    expect(hotAtCallback[0].some((f) => f.endsWith('.mp4') || f.endsWith('.ass'))).toBe(false)
  })

  it('carries the merged .mkv as a download-dir-relative path, not a bare basename', async () => {
    // The contract the rel-path mover resolves against: `group.video.filename`
    // is `path.join(animeDirName, …)`, so the payload already carries the anime
    // directory. A later change that strips it — or absolutises it — must red
    // here rather than silently at the mover, where log-and-continue would
    // reduce it to a console line.
    const x = translation('X', 1, true)
    seed(x)
    stubFfmpeg()

    await runMerges()

    expect(seen).toHaveLength(1)
    expect(seen[0].mkvFilename).toBe(path.join(ANIME_DIR, 'Anime - 01 [X].mkv'))
    expect(seen[0].mkvFilename).not.toBe('Anime - 01 [X].mkv')
    expect(path.isAbsolute(seen[0].mkvFilename)).toBe(false)
    expect(seen[0]).toMatchObject({
      animeName: ANIME,
      animeId: 100,
      episodeInt: '1',
      episodeLabel: '1'
    })
  })

  it('moves a no-subtitle group unchanged, orphaning nothing', async () => {
    const x = translation('X', 1, false)
    seed(x)
    stubFfmpeg()

    await runMerges()

    expect(walk(coldDir)).toEqual([path.join(ANIME_DIR, 'Anime - 01 [X].mkv')])
    expect(walk(hotDir)).toEqual([])
  })
})
