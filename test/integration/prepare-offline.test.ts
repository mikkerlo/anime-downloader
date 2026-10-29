// Prepare for offline (#592), steps against real services: auto-merge after an
// install, the metadata step over a stub smotret server (S1a's
// `ANIME_DL_SMOTRET_API_BASE`), local integrity over temp roots with a fake
// ffprobe, and the two library steps over S7a's fixture library.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'

import { InMemoryStorage } from '../helpers/in-memory-storage'
import {
  createPrepareOfflineService,
  type PrepareStepContext
} from '../../src/main/services/prepare-offline'
import { createBinariesStep } from '../../src/main/services/prepare-offline/steps/binaries'
import {
  cachableIdsFrom,
  createMetadataStep
} from '../../src/main/services/prepare-offline/steps/metadata'
import { createLocalIntegrityStep } from '../../src/main/services/prepare-offline/steps/local-integrity'
import { createAttachedIntegrityStep } from '../../src/main/services/prepare-offline/steps/attached-integrity'
import { createLibrarySyncStep } from '../../src/main/services/prepare-offline/steps/library-sync'
import { createFfmpegStatus } from '../../src/main/lib/ffmpeg-status'
import {
  createEpisodeCompletionHandlers,
  type EpisodeCompletionDeps
} from '../../src/main/lib/episode-completion'
import { createAnimeCacheService } from '../../src/main/services/anime-cache'
import { createCacheScope } from '../../src/main/services/anime-cache/scope'
import { SmotretApi } from '../../src/main/smotret-api'
import { applyApiBaseOverrides } from '../../src/main/lib/api-bases'
import { probeDuration } from '../../src/main/lib/probe-duration'
import { sanitizeFilename } from '../../src/main/download-manager'
import { createAttachedLibraryService } from '../../src/main/services/attached-library'
import { FIXTURE_LIBRARY_ID, copyFixtureLibrary, mtimeSnapshot } from '../helpers/attached-library'
import { cleanup } from '../helpers/shared-library'

const DAY = 24 * 60 * 60 * 1000

function ctx(): PrepareStepContext & {
  ticks: { done: number; total: number; message?: string }[]
} {
  const ticks: { done: number; total: number; message?: string }[] = []
  return {
    signal: new AbortController().signal,
    isOffline: () => false,
    progress: (p) => ticks.push(p),
    ticks
  }
}

const tmpDirs: string[] = []
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  cleanup()
  vi.restoreAllMocks()
})

// --- Auto-merge after an install ---------------------------------------------------

describe('auto-merge sees an ffmpeg the binaries step installed, without a restart', () => {
  it('boot without ffmpeg, install through the step, then an episode completes: the merge runs', async () => {
    let installed = false
    const ffmpegStatus = createFfmpegStatus(async () => ({ available: installed }))
    // Boot: ffmpeg is missing (offline, say).
    await ffmpegStatus.refresh()
    expect((await ffmpegStatus.get()).available).toBe(false)

    const step = createBinariesStep({
      ensureFfmpeg: async () => {
        installed = true
        return '/bin/ffmpeg'
      },
      ensureFpcalc: async () => '/bin/fpcalc',
      paths: () => ({ ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe', fpcalc: '/bin/fpcalc' }),
      exists: (p) => p === '/bin/fpcalc' || installed,
      verify: async () => ({ ok: true, version: 'v' }),
      remove: async () => {},
      clearFfmpegPaths: () => {},
      refreshFfmpegStatus: () => ffmpegStatus.refresh(),
      ffmpegUser: () => null,
      isPlayerOpen: () => false,
      isSkipAnalysisRunning: () => false
    })
    expect((await step.run(ctx())).status).toBe('ok')

    const merges: string[] = []
    const settings: Record<string, unknown> = {
      autoMerge: true,
      videoCodec: 'copy',
      notificationMode: 'off',
      autoMoveToCold: false,
      downloadedEpisodes: {}
    }
    const handlers = createEpisodeCompletionHandlers({
      store: {
        get: (key: string) => settings[key],
        set: (key: string, value: unknown) => (settings[key] = value)
      } as unknown as EpisodeCompletionDeps['store'],
      downloadManager: {
        finalizeDeferred: () => [],
        getEpisodeGroups: () => [],
        getMergeStatus: () => 'pending',
        mergeCompleted: async (ffmpeg) => {
          merges.push(ffmpeg)
        },
        takeHeldRequest: () => false
      },
      fileScanner: { invalidate: () => {} },
      coldStorageService: {
        isAdvanced: () => false,
        moveEpisodeToColdStorage: async () => {},
        moveFileToColdByRelPath: async () => {}
      },
      skipAnalysisService: { scheduleAutoSkipAnalysis: () => {} },
      mp4StatsService: { recordCheck: async () => {} },
      getFfmpegInfo: () => ffmpegStatus.get(),
      getFfmpegPath: () => (installed ? '/bin/ffmpeg' : ''),
      getFfprobePath: () => (installed ? '/bin/ffprobe' : ''),
      notify: () => {}
    })
    await handlers.handleEpisodeComplete({
      animeName: 'Show',
      episodeLabel: '1',
      animeId: 1,
      episodeInt: '1',
      translationId: 11,
      translationType: 'subRu',
      author: 'A',
      quality: 720,
      hasVideo: false
    } as Parameters<typeof handlers.handleEpisodeComplete>[0])
    // On main the one-shot `ffmpegReady` stays `false` and nothing merges.
    expect(merges).toEqual(['/bin/ffmpeg'])
  })
})

// --- Metadata over a stub smotret server ----------------------------------------------

interface Stub {
  base: string
  server: http.Server
  /** Poster requests answered so far; a gate delays them when set. */
  posterGate: Promise<void> | null
  failPoster: Set<number>
  failSeries: Set<number>
  requests: string[]
}

function startStub(): Promise<Stub> {
  const stub: Stub = {
    base: '',
    server: http.createServer(),
    posterGate: null,
    failPoster: new Set(),
    failSeries: new Set(),
    requests: []
  }
  stub.server.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    stub.requests.push(url.pathname)
    const series = /^\/api\/series\/(\d+)$/.exec(url.pathname)
    if (series) {
      const id = Number(series[1])
      if (stub.failSeries.has(id)) {
        res.writeHead(500).end('boom')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: {
            id,
            title: `Title ${id}`,
            titles: { romaji: `Title ${id}` },
            posterUrl: `${stub.base}/posters/${id}.jpg`,
            posterUrlSmall: '',
            descriptions: [],
            genres: [],
            episodes: [
              { id: id * 100 + 1, episodeFull: '1', episodeInt: 1, episodeType: 'tv', isActive: 1 }
            ]
          }
        })
      )
      return
    }
    if (url.pathname === '/api/translations') {
      const epId = Number(url.searchParams.getAll('episodeId[]')[0])
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          data: [
            {
              id: epId * 10,
              episodeId: epId,
              type: 'subRu',
              typeKind: 'sub',
              typeLang: 'ru',
              authorsSummary: 'A',
              isActive: 1,
              width: 1280,
              height: 720,
              duration: '1400',
              episode: { episodeFull: '1', episodeInt: 1, episodeType: 'tv' }
            }
          ]
        })
      )
      return
    }
    const poster = /^\/api\/posters\/(\d+)\.jpg$/.exec(url.pathname)
    if (poster) {
      if (stub.posterGate) await stub.posterGate
      if (stub.failPoster.has(Number(poster[1]))) {
        res.writeHead(404).end()
        return
      }
      res.setHeader('content-type', 'image/jpeg')
      res.end(Buffer.from(`jpeg-${poster[1]}`))
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    stub.server.listen(0, '127.0.0.1', () => {
      stub.base = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}/api`
      resolve(stub)
    })
  })
}

describe('step 3: library metadata (stub smotret server)', () => {
  let stub: Stub

  beforeAll(async () => {
    stub = await startStub()
    applyApiBaseOverrides({ ANIME_DL_SMOTRET_API_BASE: stub.base }, false)
  })

  afterAll(async () => {
    applyApiBaseOverrides({}, false)
    await new Promise((r) => stub.server.close(r))
  })

  function rig(initial: Record<string, unknown> = {}) {
    const now = Date.now()
    const store = new InMemoryStorage({
      // 1 starred, 2 downloaded, 3 watched 10 days ago (neither), 4 watched 200 days ago.
      library: { '1': { id: 1 } },
      downloadedAnime: { '2': { id: 2 } },
      watchProgress: {
        '3:1': { updatedAt: now - 10 * DAY },
        '4:1': { updatedAt: now - 200 * DAY }
      },
      animeCache: {},
      ...initial
    })
    const userDataDir = tmp('prep-meta-')
    const api = new SmotretApi(() => '')
    const scope = createCacheScope(store)
    const cache = createAnimeCacheService({
      store,
      userDataDir,
      fetchPoster: (u) => api.fetchPoster(u),
      isCachable: scope.isCachable
    })
    const step = createMetadataStep({
      cachableIds: () => cachableIdsFrom(store, scope.isCachable),
      getAnime: (id) => api.getAnime(id),
      getEpisodesBatch: (ids) => api.getEpisodesBatch(ids),
      refreshAnimeDetail: (id, d) => cache.refreshAnimeDetail(id, d),
      updateEpisodes: (id, d) => cache.updateEpisodes(id, d)
    })
    const posterFile = (id: number): string => cache.getPosterCachePath(id)
    return { store, cache, step, posterFile }
  }

  afterEach(() => {
    stub.posterGate = null
    stub.failPoster.clear()
    stub.failSeries.clear()
    stub.requests.length = 0
  })

  it('every cachable title, watched-only included, gets details, episodes and a poster', async () => {
    const r = rig()
    const out = await r.step.run(ctx())
    expect(out.status).toBe('ok')
    for (const id of [1, 2, 3]) {
      const entry = r.cache.getEntry(id)!
      expect(entry.animeDetail?.id).toBe(id)
      expect(Object.keys(entry.episodes)).toEqual([String(id * 100 + 1)])
      expect(entry.posterCached).toBe(true)
      expect(fs.readFileSync(r.posterFile(id), 'utf8')).toBe(`jpeg-${id}`)
    }
    // 200 days ago is outside S2's scope.
    expect(r.cache.getEntry(4)).toBeNull()
  })

  it('the poster is on disk when the title’s progress tick is reported', async () => {
    let release!: () => void
    stub.posterGate = new Promise<void>((res) => (release = res))
    const r = rig({ library: {}, downloadedAnime: { '2': { id: 2 } }, watchProgress: {} })
    const c = ctx()
    const seenAtTick: boolean[] = []
    const progress = c.progress
    c.progress = (p) => {
      progress(p)
      if (p.done > 0) seenAtTick.push(fs.existsSync(r.posterFile(2)))
    }
    const running = r.step.run(c)
    await vi.waitFor(() => expect(stub.requests).toContain('/api/posters/2.jpg'))
    // Room for a tick that doesn't wait for the poster to happen while it is held.
    await new Promise((res) => setTimeout(res, 200))
    expect(c.ticks.filter((t) => t.done > 0)).toEqual([])
    release()
    await running
    expect(seenAtTick).toEqual([true])
  })

  it('a poster that fails leaves posterCached false and is a warning', async () => {
    stub.failPoster.add(2)
    const r = rig({ library: {}, watchProgress: {} })
    const out = await r.step.run(ctx())
    expect(r.cache.getEntry(2)?.posterCached).toBe(false)
    expect(fs.existsSync(r.posterFile(2))).toBe(false)
    expect(out.status).toBe('warning')
    expect(out.details).toContainEqual({
      text: "Title 2: the poster didn't download",
      status: 'warning',
      animeId: 2
    })
  })

  it('posterCached: true with no file is repaired', async () => {
    const r = rig({
      library: {},
      watchProgress: {},
      animeCache: {
        '2': { animeDetail: null, episodes: {}, qualityProbes: {}, cachedAt: 1, posterCached: true }
      }
    })
    expect(fs.existsSync(r.posterFile(2))).toBe(false)
    await r.step.run(ctx())
    expect(fs.readFileSync(r.posterFile(2), 'utf8')).toBe('jpeg-2')
    expect(r.cache.getEntry(2)?.posterCached).toBe(true)
  })

  it('one title answering 500 is a warning detail; the others still complete', async () => {
    stub.failSeries.add(1)
    const r = rig()
    const out = await r.step.run(ctx())
    expect(out.status).toBe('warning')
    expect(out.details).toContainEqual(
      expect.objectContaining({ status: 'warning', animeId: 1, text: expect.stringMatching(/500/) })
    )
    expect(r.cache.getEntry(2)?.animeDetail?.id).toBe(2)
    expect(r.cache.getEntry(3)?.animeDetail?.id).toBe(3)
  })
})

// --- Local integrity --------------------------------------------------------------------

function treeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      const st = fs.statSync(p)
      out[path.relative(root, p)] = `${e.isDirectory() ? 'd' : st.size}:${st.mtimeMs}`
      if (e.isDirectory()) walk(p)
    }
  }
  walk(root)
  return out
}

describe.skipIf(process.platform === 'win32')('step 4: downloaded episodes (temp roots)', () => {
  it('reports a missing file, a 0-byte file, a truncated .mp4 and an orphan .part; changes nothing', async () => {
    const hot = tmp('prep-hot-')
    const cold = tmp('prep-cold-')
    const bin = tmp('prep-bin-')
    // A fake ffprobe: a file starting "GOOD" has a duration, anything else is
    // rejected the way ffprobe rejects a truncated file.
    const ffprobe = path.join(bin, 'ffprobe')
    fs.writeFileSync(
      ffprobe,
      [
        '#!/bin/sh',
        'for last; do :; done',
        'if head -c 4 "$last" | grep -q GOOD; then',
        '  echo \'{"format":{"duration":"1420.5"}}\'',
        'else',
        '  echo "$last: Invalid data found when processing input" >&2; exit 1',
        'fi'
      ].join('\n') + '\n',
      { mode: 0o755 }
    )
    const show = 'Show'
    const name = (ep: string, ext = '.mp4'): string =>
      `${sanitizeFilename(`${show} - ${ep.padStart(2, '0')}`)} [Author]${ext}`
    fs.mkdirSync(path.join(hot, show))
    fs.mkdirSync(path.join(cold, show))
    fs.writeFileSync(path.join(hot, show, name('2')), '')
    fs.writeFileSync(path.join(hot, show, name('3')), 'TRUNCATED')
    fs.writeFileSync(path.join(cold, show, name('4', '.mkv')), 'GOOD video')
    fs.writeFileSync(path.join(hot, show, `${name('5')}.part`), 'partial')
    fs.writeFileSync(path.join(hot, show, `${name('6')}.part`), 'downloading')
    const activePart = path.join(hot, show, `${name('6')}.part`)

    const before = { hot: treeSnapshot(hot), cold: treeSnapshot(cold) }
    const meta = { author: 'Author', translationId: 1 }
    const step = createLocalIntegrityStep({
      downloadedEpisodes: () => ({ '10:1': meta, '10:2': meta, '10:3': meta, '10:4': meta }),
      downloadedAnime: () => ({ '10': { id: 10, title: show, titles: { romaji: show } } as never }),
      displayName: (a) => a.titles?.romaji || a.title,
      sanitizeFilename,
      roots: () => [hot, cold],
      probeDuration: (f, signal) => probeDuration(ffprobe, f, signal),
      isActivePart: (p) => p === activePart
    })
    const out = await step.run(ctx())

    expect(out.status).toBe('warning')
    expect(out.details).toEqual([
      { text: '1 of 4 episodes ok', status: 'warning' },
      expect.objectContaining({ text: 'Show episode 1: the video file is missing', animeId: 10 }),
      expect.objectContaining({
        text: 'Show episode 2: the video file is empty (0 bytes)',
        animeId: 10
      }),
      expect.objectContaining({
        text: expect.stringMatching(/^Show episode 3: ffprobe can't read it \(.*Invalid data/),
        animeId: 10
      }),
      { text: `${name('5')}.part: a partial download with no download running`, status: 'warning' }
    ])
    expect({ hot: treeSnapshot(hot), cold: treeSnapshot(cold) }).toEqual(before)
  })
})

// --- The library steps over S7a's fixture library -------------------------------------------

describe('steps 5 and 6: Shared Libraries (fixture library)', () => {
  async function attached() {
    const store = new InMemoryStorage({
      shikimoriUser: null,
      shikimoriCredentials: null,
      downloadedAnime: {},
      attachedLibraries: {}
    })
    const svc = createAttachedLibraryService({
      store,
      checkFfmpeg: async () => ({ available: true }),
      onChanged: () => {},
      log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => 1_000
    })
    const root = copyFixtureLibrary()
    const [candidate] = await svc.discover(root)
    const res = await svc.attach(candidate.libraryId!)
    if (!res.ok) throw new Error(res.error)
    return { svc, root }
  }

  it('an item deleted from the drive and one truncated to the wrong size are reported; the tree is unchanged', async () => {
    const { svc, root } = await attached()
    fs.unlinkSync(path.join(root, 'Dungeon Meshi', 'Dungeon Meshi - 01 [AniLibria].mkv'))
    fs.truncateSync(path.join(root, 'Frieren~3f2a1c', 'Frieren~3f2a1c - 01 [Crunchyroll].mp4'), 10)
    const before = mtimeSnapshot(root)
    const out = await createAttachedIntegrityStep(svc).run(ctx())
    expect(out.status).toBe('warning')
    const texts = out.details.map((d) => d.text)
    expect(texts.some((t) => /episode 1 \(AniLibria\): missing on the drive$/.test(t))).toBe(true)
    expect(
      texts.some((t) =>
        /episode 1 \(Crunchyroll\): the file's size doesn't match the library$/.test(t)
      )
    ).toBe(true)
    expect(mtimeSnapshot(root)).toEqual(before)
  })

  it('an intact library is ok', async () => {
    const { svc } = await attached()
    const out = await createAttachedIntegrityStep(svc).run(ctx())
    expect(out.status).toBe('ok')
  })

  it('an unplugged library is "Drive not connected"', async () => {
    const { svc, root } = await attached()
    svc.markUnavailable(FIXTURE_LIBRARY_ID, root)
    const out = await createAttachedIntegrityStep(svc).run(ctx())
    expect(out.details).toEqual([
      { text: `${svc.list()[0].name}: Drive not connected`, status: 'skipped' }
    ])
  })

  it('the sync step calls runAll once with "prepare" and reports the results it returns', async () => {
    const { svc } = await attached()
    const runAll = vi.fn(
      async (): Promise<SyncRunResult> => ({
        runId: 'r1',
        trigger: 'prepare',
        libraries: [
          {
            libraryId: FIXTURE_LIBRARY_ID,
            drive: 'ok',
            shikimori: 'skipped',
            shikimoriReason: 'claim',
            counts: { applied: 2, conflicts: 0, clamped: 0 },
            waitingMalIds: [],
            rewatchesSuperseded: 0
          }
        ]
      })
    )
    const out = await createLibrarySyncStep({ list: () => svc.list(), runAll }).run(ctx())
    expect(runAll).toHaveBeenCalledTimes(1)
    expect(runAll).toHaveBeenCalledWith('prepare')
    expect(out).toEqual({
      status: 'ok',
      details: [
        {
          text: `${svc.list()[0].name}: Drive synced; Shikimori push needs a logged-in owner`,
          status: 'ok'
        }
      ]
    })
  })

  it('with no library attached, both steps are "Not available"', async () => {
    const svc = createPrepareOfflineService({
      store: new InMemoryStorage({ prepareOfflineLastRun: null }),
      isOffline: () => false,
      broadcast: () => {},
      progressChannel: 'p'
    })
    const runAll = vi.fn()
    svc.registerStep(
      createAttachedIntegrityStep({ list: () => [], items: () => [], checkItem: vi.fn() })
    )
    svc.registerStep(createLibrarySyncStep({ list: () => [], runAll }))
    svc.start()
    await svc.idle()
    expect(svc.getState().run!.steps.map((s) => [s.status, s.reason])).toEqual([
      ['unavailable', 'No Shared Library attached'],
      ['unavailable', 'No Shared Library attached']
    ])
    expect(runAll).not.toHaveBeenCalled()
  })
})
