// A temp PC for the export pre-fetch tests (#577): the export environment of
// `shared-library-export.ts`, plus a real `DownloadManager` on the hot root
// with a fake network (`fetch` and the embed API) and a fake ffmpeg, and the
// real episode-completion tails wired to it the way `src/main/index.ts` wires
// them. `boot()` is a kill and restart: a new manager and service on the same
// `userData`, store and roots.

import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'
import { DownloadManager, type DownloadItem } from '../../src/main/download-manager'
import {
  createEpisodeCompletionHandlers,
  isMergeExpected,
  type EpisodeCompletionStore
} from '../../src/main/lib/episode-completion'
import type {
  SharedLibraryExportDeps,
  SharedLibraryExportService
} from '../../src/main/services/shared-library-export'
import { nodeFs } from '../../src/main/services/shared-library-export/copy'
import { fakeFfmpeg, until, type FakeFfmpeg } from './fake-ffmpeg'
import { bytesFor, makeExportEnv, type ExportEnv } from './shared-library-export'

export const FFMPEG = '/fake/ffmpeg'
export const TICK_MS = 15

const videoUrl = (tr: number): string => `http://video.invalid/${tr}`
const subUrl = (tr: number): string => `http://subs.invalid/${tr}`

export interface CachedTranslation {
  id: number
  author: string
  type?: string
  height?: number
  /** Seconds, as the API's string. */
  duration?: string
  isActive?: number
}

export interface CachedEpisode {
  episodeInt: string
  translations: CachedTranslation[]
}

/** The fake network: every download answers at once unless held, failed or given a subtitle-less embed. */
export interface FakeNet {
  /** Holds the downloads of `tr`'s video (or subtitle) until `release`. */
  hold: (tr: number, kind?: 'video' | 'subtitle') => void
  release: (tr: number, kind?: 'video' | 'subtitle') => void
  /** Answers `tr`'s video with an HTML page: a deterministic failure. */
  failVideo: (tr: number) => void
  /** Answers `tr`'s subtitle with a 404 (after the retry ladder, so hold it short). */
  failSubtitle: (tr: number) => void
  /** Video bytes for `tr`. */
  videoBytes: (tr: number) => Buffer
  noSubtitles: Set<number>
}

export interface PrefetchRig {
  env: ExportEnv
  dm: DownloadManager
  ff: FakeFfmpeg
  net: FakeNet
  svc: SharedLibraryExportService
  /** The pre-fetch clock (`now`): moved by the test. */
  clock: { t: number }
  /** What `checkFfmpeg` reports to episode completion and the export's predicate. */
  ffmpeg: { available: boolean }
  offline: { on: boolean }
  /** Absolute paths the player holds (`setFileLockCheck`). */
  locked: Set<string>
  /** Every `enqueue` call's requests, and the order of `downloadedAnime` writes and enqueues. */
  enqueued: DownloadRequest[][]
  order: string[]
  /** `onVideoDownloaded` events on the current manager, by translation id. */
  videoEvents: number[]
  /** `mergeCompleted` calls on the current manager. */
  mergeCalls: { n: number }
  seedTitle: (spec: { animeId: number; title: string; episodes: CachedEpisode[] }) => void
  /** A kill and restart on the same userData, store and roots; the service is `init`ed. */
  boot: (beforeRestart?: () => void | Promise<void>) => Promise<void>
  /** Every source path the export read (the copy spy). */
  reads: string[]
  /** Runs as the export opens a source, before the read. */
  onRead: ((p: string) => void) | null
  /** How many times the job read "a merge is expected". */
  predicateReads: { n: number }
  /** Holds the first write of a drive file matching `match` until `go` resolves. */
  copyGate: { current: { match: RegExp; reached: () => void; go: Promise<void> } | null }
  /** The drive's free bytes as `statfs` reports them; null for the real value. */
  driveFree: { bytes: number | null }
  /** The hot root's free bytes, likewise. */
  localFree: { bytes: number | null }
  cleanup: () => void
}

export function makePrefetchRig(
  opts: {
    autoMerge?: boolean
    ffmpegAvailable?: boolean
    concurrent?: number
    exportDeps?: Partial<SharedLibraryExportDeps>
  } = {}
): PrefetchRig {
  const holds = new Map<string, { promise: Promise<void>; release: () => void }>()
  const failures = new Map<string, Response | (() => Response)>()
  const noSubtitles = new Set<number>()
  const key = (tr: number, kind: 'video' | 'subtitle' = 'video'): string =>
    kind === 'video' ? videoUrl(tr) : subUrl(tr)
  const net: FakeNet = {
    hold: (tr, kind) => {
      let release!: () => void
      const promise = new Promise<void>((r) => (release = r))
      holds.set(key(tr, kind), { promise, release })
    },
    release: (tr, kind) => {
      const h = holds.get(key(tr, kind))
      holds.delete(key(tr, kind))
      h?.release()
    },
    failVideo: (tr) =>
      failures.set(
        videoUrl(tr),
        () =>
          new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      ),
    failSubtitle: (tr) =>
      failures.set(
        subUrl(tr),
        () => new Response('gone', { status: 404, statusText: 'Not Found' })
      ),
    videoBytes: (tr) => bytesFor(`video-${tr}`, 3000 + tr),
    noSubtitles
  }

  global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const h = holds.get(url)
    if (h) {
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal
        const onAbort = (): void => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        void h.promise.then(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    }
    const fail = failures.get(url)
    if (fail) return typeof fail === 'function' ? fail() : fail
    const tr = Number(url.split('/').pop())
    const body = url.startsWith('http://video')
      ? net.videoBytes(tr)
      : Buffer.from(`[Script Info]\nTitle: ${tr}\n`)
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'content-length': String(body.length),
        'content-type': url.startsWith('http://video') ? 'video/mp4' : 'text/plain'
      }
    })
  }) as unknown as typeof fetch

  const api = {
    getEmbed: async (tr: number) => ({
      stream: [{ height: 720, urls: [videoUrl(tr)] }],
      subtitlesUrl: noSubtitles.has(tr) ? null : subUrl(tr)
    }),
    getSubtitlesUrl: (tr: number) => subUrl(tr),
    getFallbackVideoUrl: (tr: number) => videoUrl(tr)
  }

  const clock = { t: 1_000_000 }
  const ffmpeg = { available: opts.ffmpegAvailable ?? true }
  const offline = { on: false }
  const locked = new Set<string>()
  const enqueued: DownloadRequest[][] = []
  const order: string[] = []
  const videoEvents: number[] = []
  const mergeCalls = { n: 0 }
  const ff = fakeFfmpeg()

  let offRelease: () => void = () => {}
  const rig = {} as PrefetchRig
  const reads: string[] = []
  const copyGate: PrefetchRig['copyGate'] = { current: null }
  const driveFree: PrefetchRig['driveFree'] = { bytes: null }
  const localFree: PrefetchRig['localFree'] = { bytes: null }

  const predicateReads = { n: 0 }
  const mergeExpected = async (): Promise<boolean> => {
    predicateReads.n++
    return isMergeExpected({
      autoMerge: env.store.get('autoMerge') as boolean,
      ffmpegInfo: { available: ffmpeg.available },
      ffmpegPath: FFMPEG
    })
  }

  const exportDeps = (): Partial<SharedLibraryExportDeps> => ({
    mergeStatus: (tr) => rig.dm.getMergeStatus(tr),
    downloads: {
      enqueue: async (requests) => {
        order.push('enqueue')
        enqueued.push(requests)
        await rig.dm.enqueue(requests)
      },
      getItem: (id) => rig.dm.getItem(id),
      isMergeCycleActive: () => rig.dm.isMergeCycleActive(),
      hasHeldMerge: () => rig.dm.hasHeldMerge(),
      onVideoDownloaded: (cb) => rig.dm.onVideoDownloaded(() => cb()),
      onMergeComplete: (cb) => rig.dm.onMergeComplete(() => cb())
    },
    mergeExpected,
    isOffline: () => offline.on,
    downloadRoots: () => [env.hot, env.cold],
    prefetchTickMs: TICK_MS,
    now: () => clock.t,
    ffmpegCheck: async () => ({ available: ffmpeg.available, encoders: ['libx265'] }),
    xfs: {
      // The copy spy: every source the export reads.
      createReadStream: (p) => {
        reads.push(p)
        rig.onRead?.(p)
        return nodeFs.createReadStream(p)
      },
      // A write under the drive that matches `copyGate` stops before its first
      // byte until the test lets it go.
      open: async (p, flags) => {
        const h = await nodeFs.open(p, flags)
        const g = copyGate.current
        if (!g || !g.match.test(p)) return h
        let first = true
        return {
          ...h,
          write: async (buf) => {
            if (first) {
              first = false
              g.reached()
              await g.go
            }
            return h.write(buf)
          }
        }
      },
      statfs: async (p) => {
        if (driveFree.bytes !== null && p.startsWith(env.drive)) {
          return { bavail: driveFree.bytes, bsize: 1 }
        }
        if (localFree.bytes !== null && p.startsWith(env.hot)) {
          return { bavail: localFree.bytes, bsize: 1 }
        }
        return nodeFs.statfs(p)
      }
    },
    merger: {
      merge: (req) => rig.dm.mergeForExport({ ...req, ffmpegPath: FFMPEG, ffprobePath: FFMPEG }),
      cancel: (jobId) => rig.dm.cancelExportMerge(jobId)
    },
    ...opts.exportDeps
  })

  const env: ExportEnv = makeExportEnv(exportDeps())
  env.store.set('token', 'test-token')
  env.store.set('autoMerge', opts.autoMerge ?? false)
  env.store.set('autoMoveToCold', false)
  env.store.set('videoCodec', 'copy')
  env.store.set('notificationMode', 'none')
  // Records the order of `downloadedAnime` writes against the enqueues.
  const set = env.store.set.bind(env.store)
  env.store.set = (k: string, v: unknown): void => {
    if (k === 'downloadedAnime') order.push('downloadedAnime')
    set(k, v)
  }

  function makeManager(): DownloadManager {
    const dm = new DownloadManager(
      env.hot,
      api as never,
      env.userData,
      () => 0,
      () => opts.concurrent ?? 2
    )
    dm.loadQueue()
    dm.setFfmpegDriver(ff.driver)
    dm.setFileLockCheck((p) => locked.has(p))
    dm.setMergeHoldCheck(() => env.presence.isOpen())
    dm.setOfflineCheck(() => offline.on)
    const ec = createEpisodeCompletionHandlers({
      store: env.store as unknown as EpisodeCompletionStore,
      downloadManager: dm,
      fileScanner: { invalidate: () => {} },
      coldStorageService: {
        isAdvanced: () => false,
        moveEpisodeToColdStorage: async () => {},
        moveFileToColdByRelPath: async () => {}
      },
      skipAnalysisService: { scheduleAutoSkipAnalysis: () => {} },
      mp4StatsService: { recordCheck: async () => {} },
      getFfmpegInfo: () =>
        Promise.resolve({
          get available() {
            return ffmpeg.available
          }
        }),
      getFfmpegPath: () => FFMPEG,
      getFfprobePath: () => FFMPEG,
      notify: () => {}
    })
    const real = dm.mergeCompleted.bind(dm)
    dm.mergeCompleted = (...args) => {
      mergeCalls.n++
      return real(...args)
    }
    dm.onEpisodeComplete(ec.handleEpisodeComplete)
    dm.onMergeComplete(ec.handleMergeComplete)
    dm.onVideoDownloaded(ec.handleVideoDownloaded)
    dm.onVideoDownloaded((_p, item: DownloadItem) => {
      videoEvents.push(item.translationId)
    })
    offRelease()
    offRelease = env.presence.onRelease(() => void ec.resumeHeldMerges())
    rig.finalizeDeferred = () => ec.finalizeDeferredEpisodes()
    return dm
  }

  Object.assign(rig, {
    env,
    reads,
    onRead: null,
    predicateReads,
    copyGate,
    driveFree,
    localFree,
    ff,
    net,
    clock,
    ffmpeg,
    offline,
    locked,
    enqueued,
    order,
    videoEvents,
    mergeCalls
  })
  rig.dm = makeManager()
  rig.svc = env.svc

  rig.seedTitle = ({ animeId, title, episodes }) => {
    const detail = {
      id: animeId,
      title,
      titles: { romaji: title },
      posterUrlSmall: '',
      numberOfEpisodes: episodes.length,
      type: 'tv',
      typeTitle: 'TV',
      year: 2024,
      season: 'spring',
      posterUrl: '',
      descriptions: [],
      genres: [],
      episodes: episodes.map((e) => ({
        id: animeId * 1000 + Number(e.episodeInt),
        episodeFull: `${e.episodeInt} серия`,
        episodeInt: e.episodeInt,
        episodeType: 'tv',
        isActive: 1
      }))
    }
    const cached: Record<number, EpisodeDetail> = {}
    for (const e of episodes) {
      const id = animeId * 1000 + Number(e.episodeInt)
      cached[id] = {
        id,
        episodeFull: `${e.episodeInt} серия`,
        episodeInt: e.episodeInt,
        episodeType: 'tv',
        translations: e.translations.map((t) => ({
          id: t.id,
          type: t.type ?? 'subRu',
          typeKind: 'sub',
          typeLang: 'ru',
          authorsSummary: t.author,
          isActive: t.isActive ?? 1,
          width: 1280,
          height: t.height ?? 720,
          duration: t.duration ?? '1440'
        }))
      }
    }
    const cache = (env.store.get('animeCache') as Record<string, unknown>) ?? {}
    cache[animeId] = { animeDetail: detail, episodes: cached, qualityProbes: {} }
    env.store.set('animeCache', cache)
  }

  rig.boot = async (beforeRestart) => {
    // A kill: nothing of the old manager or service runs again. The old jobs
    // stop first (a boot shows them paused either way). The old manager is
    // stopped without `destroy()`: no last persist, and its ffmpeg is never
    // killed, so no cleanup of a quit (the `.mkv` unlink) runs either — a
    // killed process runs nothing. Its transfers are aborted and its pump
    // starts nothing more.
    for (const j of rig.svc.list()) await rig.svc.pause(j.jobId)
    const dead = rig.dm as unknown as {
      destroyed: boolean
      getConcurrentLimit: () => number
      progressTimer: ReturnType<typeof setInterval> | null
      abortControllers: Map<string, AbortController>
    }
    dead.destroyed = true
    dead.getConcurrentLimit = () => 0
    if (dead.progressTimer) clearInterval(dead.progressTimer)
    for (const c of dead.abortControllers.values()) c.abort()
    await beforeRestart?.()
    videoEvents.length = 0
    mergeCalls.n = 0
    rig.dm = makeManager()
    rig.svc = env.restart(exportDeps())
    await rig.svc.init()
  }

  rig.cleanup = () => {
    rig.dm.destroy()
    env.cleanup()
  }
  return rig
}

export interface PrefetchRig {
  /** Episode completion's `finalizeDeferredEpisodes` on the current manager. */
  finalizeDeferred: () => Promise<void>
}

/** The job view the service reports now. */
export function jobOf(rig: PrefetchRig, jobId: string): ExportJobView {
  const j = rig.svc.list().find((x) => x.jobId === jobId)
  if (!j) throw new Error(`no job ${jobId}`)
  return j
}

/** Waits until the job's pre-fetched item `key` reaches `state`. */
export async function untilPrefetch(
  rig: PrefetchRig,
  jobId: string,
  key: string,
  state: ExportPrefetchView['state'],
  ms = 3000
): Promise<void> {
  await until(
    () => jobOf(rig, jobId).prefetch?.find((p) => p.key === key)?.state === state,
    `${key} → ${state}`,
    ms
  )
}

/** The files under the library root, relative. */
export function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(path.relative(root, p))
    }
  }
  walk(root)
  return out.sort()
}
