// Episode metadata is keyed on the VIDEO ITEM landing, not on the group
// finishing (#412). A subtitle that burned its three attempts used to hold
// `allDone` false forever, so `onEpisodeComplete` never fired and the video sat
// on disk showing ⬇ with no Play and no Delete.
//
// These cases drive the real `startDownload` success tail (stubbed `fetch`), so
// the `onVideoDownloaded` hook fires where production fires it — immediately
// after `finishDownloadedFile` and the 'completed' assignment, and immediately
// before `checkEpisodeComplete`.
//
// The two consumers are wired here the way `src/main/index.ts` wires them: the
// video hook calls `persistDownloadedEpisode` unconditionally, and the
// group-complete hook calls it only when `info.hasVideo`. Since #409 those two
// tails live in `src/main/lib/episode-completion.ts`, so the mirror is checked
// against the real handlers rather than against `index.ts` as source text — see
// the equivalence block at the bottom. `index.ts` itself is still not importable
// under Vitest (module-scope Electron boot) and is still excluded from coverage,
// so the one constraint that is purely about the wiring — that the manager's
// single `onVideoDownloaded` slot is claimed exactly once — remains a text guard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  type DownloadItem,
  type EpisodeCompleteInfo,
  type MergeStatus
} from '../../src/main/download-manager'
import {
  persistDownloadedEpisode,
  type DownloadedEpisodesMap,
  type DownloadedEpisodesStore
} from '../../src/main/lib/downloaded-episodes'
import {
  createEpisodeCompletionHandlers,
  type EpisodeCompletionStore
} from '../../src/main/lib/episode-completion'

const VIDEO_BODY = 'video-bytes'

function makeItem(overrides: Partial<DownloadItem>): DownloadItem {
  return {
    id: 'video-1',
    translationId: 1,
    kind: 'video',
    url: 'http://example.invalid/v.mp4',
    filename: path.join('Anime', 'Anime - 01 [Author].mp4'),
    animeName: 'Anime',
    episodeLabel: 'ep1',
    animeId: 100,
    episodeInt: '1',
    quality: 720,
    translationType: 'subRu',
    author: 'Author',
    status: 'queued',
    bytesReceived: 0,
    totalBytes: 0,
    speed: 0,
    ...overrides
  }
}

function makeSubtitle(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return makeItem({
    id: 'sub-1',
    kind: 'subtitle',
    filename: path.join('Anime', 'Anime - 01 [Author].ass'),
    url: 'http://example.invalid/s.ass',
    ...overrides
  })
}

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  startDownload: (item: DownloadItem, retryCount?: number) => Promise<void>
  checkEpisodeComplete: (translationId: number) => void
  fetchEmbed: (translationId: number) => Promise<unknown>
}

/** Swap the whole queue, the way the sibling `download-manager-*` tests do. */
function seed(dm: DownloadManager, items: DownloadItem[]): void {
  const internals = dm as unknown as Internals
  internals.queue = items
  internals.mergeStatuses.clear()
}

interface FakeStore extends DownloadedEpisodesStore {
  readonly entries: DownloadedEpisodesMap
}

function makeStore(): FakeStore {
  let held: DownloadedEpisodesMap = {}
  return {
    get: () => structuredClone(held),
    set: (_key, value) => {
      held = structuredClone(value)
    },
    get entries() {
      return held
    }
  }
}

/** `setTimeout(…, 100)` defers the group-complete callback — outwait it. */
const settleEpisodeComplete = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 200))

describe('DownloadManager — episode metadata on video landing (#412)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let store: FakeStore
  let episodePayloads: EpisodeCompleteInfo[]
  let videoHookCalls: Array<{ filePath: string; itemId: string }>

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-meta-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-meta-dl-'))
    dm = new DownloadManager(downloadDir, { getSubtitlesUrl: () => 's' } as never, userDataDir)
    store = makeStore()
    episodePayloads = []
    videoHookCalls = []

    // Mirror of src/main/index.ts: the video hook writes unconditionally, the
    // group-complete hook is the repair path and is gated on `hasVideo`.
    dm.onVideoDownloaded((filePath, item) => {
      videoHookCalls.push({ filePath, itemId: item.id })
      persistDownloadedEpisode(store, item)
    })
    dm.onEpisodeComplete((info) => {
      episodePayloads.push(info)
      if (info.hasVideo) persistDownloadedEpisode(store, info)
    })

    global.fetch = vi.fn(
      async () =>
        new Response(VIDEO_BODY, {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(VIDEO_BODY)) }
        })
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    dm.destroy()
    vi.restoreAllMocks()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  const ENTRY = { translationType: 'subRu', author: 'Author', quality: 720, translationId: 1 }

  describe('path 3 — the user never retries the failed subtitle', () => {
    it('writes the entry when the video lands, with the sibling subtitle already failed', async () => {
      const video = makeItem({})
      const subtitle = makeSubtitle({ status: 'failed', error: 'HTTP 404 Not Found' })
      seed(dm, [video, subtitle])

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      // The whole point: an entry exists with no user action and no retry.
      expect(store.entries).toEqual({ '100:1:1': ENTRY })
      expect(videoHookCalls).toEqual([
        { filePath: path.join(downloadDir, video.filename), itemId: 'video-1' }
      ])
      // And it did NOT come from the group gate — that never fired, because the
      // failed subtitle is in `items` and is not 'completed'.
      expect(episodePayloads).toEqual([])
      expect(video.status).toBe('completed')
    })
  })

  describe('path 1 — the user cancels the failed subtitle', () => {
    it('keeps the entry across the subtitle cancel', async () => {
      const video = makeItem({})
      const subtitle = makeSubtitle({ status: 'failed' })
      seed(dm, [video, subtitle])
      await (dm as unknown as Internals).startDownload(video)

      dm.cancel('sub-1')
      await settleEpisodeComplete()

      expect(store.entries).toEqual({ '100:1:1': ENTRY })
      // Cancelling the subtitle does not reach `checkEpisodeComplete`, which is
      // exactly why the pre-#412 code left this episode unrecorded for good.
      expect(episodePayloads).toEqual([])
      expect(subtitle.status).toBe('cancelled')
    })
  })

  describe('path 2 — the user clicks "Clear done"', () => {
    it('keeps the entry after the failed group is filtered out of the queue', async () => {
      const video = makeItem({})
      const subtitle = makeSubtitle({ status: 'failed' })
      seed(dm, [video, subtitle])
      await (dm as unknown as Internals).startDownload(video)

      dm.clearCompleted()
      await settleEpisodeComplete()

      expect(dm.getEpisodeGroups()).toEqual([])
      // Clear done destroys the resume/restart recovery route, so before #412
      // this was the point of no return.
      expect(store.entries).toEqual({ '100:1:1': ENTRY })
    })
  })

  describe('negatives — what the pre-#412 late-write comment was protecting', () => {
    it('writes nothing for a video that fails before completing', async () => {
      const video = makeItem({})
      seed(dm, [video])
      global.fetch = vi.fn(
        async () => new Response('nope', { status: 404, statusText: 'Not Found' })
      ) as unknown as typeof fetch

      // retryCount = RETRY_LIMIT so the catch goes straight to 'failed' instead
      // of scheduling three real backoff timers.
      await (dm as unknown as Internals).startDownload(video, 3)
      await settleEpisodeComplete()

      expect(video.status).toBe('failed')
      expect(videoHookCalls).toEqual([])
      expect(store.entries).toEqual({})
    })

    it('writes nothing for a video cancelled mid-transfer', async () => {
      const video = makeItem({})
      seed(dm, [video])
      global.fetch = vi.fn(
        (_url: unknown, init: unknown) =>
          new Promise((_resolve, reject) => {
            const { signal } = init as { signal: AbortSignal }
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
      ) as unknown as typeof fetch

      const inFlight = (dm as unknown as Internals).startDownload(video)
      dm.cancel('video-1')
      await inFlight
      await settleEpisodeComplete()

      expect(video.status).toBe('cancelled')
      expect(videoHookCalls).toEqual([])
      expect(store.entries).toEqual({})
    })

    it('writes nothing for an item with no anime id (manual-scan provenance)', async () => {
      const video = makeItem({ animeId: 0 })
      seed(dm, [video])

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(videoHookCalls).toHaveLength(1)
      expect(store.entries).toEqual({})
    })
  })

  describe('deferred finalize — the player is holding the file', () => {
    it('still writes the entry while the video is parked as .part', async () => {
      const video = makeItem({})
      const subtitle = makeSubtitle({ status: 'failed' })
      seed(dm, [video, subtitle])
      dm.setFileLockCheck(() => true)

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      // `finishDownloadedFile` runs before the 'completed' assignment, so by the
      // time the hook fires the disk state is settled either way: renamed, or
      // deliberately left as .part and marked 'deferred'.
      expect(dm.getMergeStatus(1)).toBe('deferred')
      expect(fs.existsSync(path.join(downloadDir, video.filename) + '.part')).toBe(true)
      expect(fs.existsSync(path.join(downloadDir, video.filename))).toBe(false)
      expect(store.entries).toEqual({ '100:1:1': ENTRY })
    })
  })

  describe('two writers, one entry', () => {
    it('leaves an identical entry after the video hook and the group gate both run', async () => {
      const video = makeItem({})
      const subtitle = makeSubtitle({ status: 'completed' })
      seed(dm, [video, subtitle])

      await (dm as unknown as Internals).startDownload(video)
      const afterVideoHook = structuredClone(store.entries)
      await settleEpisodeComplete()

      // A double write is the design — the group gate stays as the repair path
      // for queues persisted before the video hook existed. So the assertion is
      // agreement, not a call count.
      expect(episodePayloads).toHaveLength(1)
      expect(afterVideoHook).toEqual({ '100:1:1': ENTRY })
      expect(store.entries).toEqual(afterVideoHook)
    })

    it('takes the group payload from the video item, not from whichever row is first', async () => {
      // The stale-embed divergence: `restart` re-resolves the embed and corrects
      // only the VIDEO item's quality (`download-manager.ts:541`); the subtitle
      // branch sets `url` alone, so the two genuinely disagree afterwards.
      // Queue order is then the only thing deciding which number gets persisted,
      // and the payload must not depend on it.
      const subtitle = makeSubtitle({ status: 'completed', quality: 1080 })
      const video = makeItem({ status: 'failed', quality: 1080 })
      seed(dm, [subtitle, video])
      ;(dm as unknown as Internals).fetchEmbed = async () => ({
        stream: [{ height: 720, urls: ['http://example.invalid/720.mp4'] }],
        subtitlesUrl: 'http://example.invalid/s.ass'
      })

      await dm.restart('video-1')
      expect(video.quality).toBe(720)
      expect(subtitle.quality).toBe(1080)

      await settleEpisodeComplete()

      expect(episodePayloads).toHaveLength(1)
      expect(episodePayloads[0].quality).toBe(720)
      expect(episodePayloads[0].hasVideo).toBe(true)
      expect(store.entries['100:1:1'].quality).toBe(720)
    })
  })

  describe('subtitle-only group — no video item to describe', () => {
    it('reports hasVideo false and writes no entry', async () => {
      // `enqueue` pushes the subtitle outside the "usable stream" guard, so an
      // embed with a `subtitlesUrl` and no playable stream produces a group with
      // no video item at all. Before #412 the group gate wrote an entry for it.
      const subtitle = makeSubtitle({})
      seed(dm, [subtitle])

      await (dm as unknown as Internals).startDownload(subtitle)
      await settleEpisodeComplete()

      expect(subtitle.status).toBe('completed')
      expect(videoHookCalls).toEqual([])
      expect(episodePayloads).toHaveLength(1)
      expect(episodePayloads[0].hasVideo).toBe(false)
      expect(store.entries).toEqual({})
    })

    it('is the case the pre-#412 ungated write got wrong', async () => {
      // Side-by-side: one consumer shaped like the old `index.ts` write (which
      // only checked `animeId > 0 && episodeInt`) and one carrying the gate.
      // Same payload, same helper — the flag is the whole difference.
      const ungated = makeStore()
      const gated = makeStore()
      dm.onEpisodeComplete((info) => {
        episodePayloads.push(info)
        persistDownloadedEpisode(ungated, info)
        if (info.hasVideo) persistDownloadedEpisode(gated, info)
      })
      seed(dm, [makeSubtitle({})])

      await (dm as unknown as Internals).startDownload(
        (dm as unknown as Internals).queue[0] as DownloadItem
      )
      await settleEpisodeComplete()

      // `quality: req.height` for an episode with no video anywhere on disk —
      // precisely the stale ⬇ class the late-write comment existed to prevent.
      expect(ungated.entries).toEqual({ '100:1:1': ENTRY })
      expect(gated.entries).toEqual({})
    })

    it('still reports hasVideo true when the group has a video (contrast)', () => {
      seed(dm, [
        makeSubtitle({ status: 'completed' }),
        makeItem({ status: 'completed', quality: 720 })
      ])
      ;(dm as unknown as Internals).checkEpisodeComplete(1)

      return settleEpisodeComplete().then(() => {
        expect(episodePayloads).toHaveLength(1)
        expect(episodePayloads[0].hasVideo).toBe(true)
      })
    })
  })

  describe('wiring placement in src/main/index.ts', () => {
    const source = (): string =>
      fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf-8')

    it('registers onVideoDownloaded exactly once', () => {
      // The manager holds one callback slot, not a list: a second registration
      // would silently unregister the mp4-stats consumer — the metadata write
      // would work and the .mp4 probe would stop, with no error anywhere.
      // Comment lines are dropped first; the comment inside the hook names the
      // method and would otherwise count as a call site.
      const registrations = source()
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .filter((l) => l.includes('onVideoDownloaded('))
      expect(registrations).toHaveLength(1)
    })
  })

  describe('the mirror above, checked against the real handlers (#409)', () => {
    // The other two constraints the old source-text block pinned — the write
    // sitting above the .mp4 filter, and the group-complete write being gated on
    // `info.hasVideo` — are behavioural now that the tails are importable. They
    // are asserted directly in `test/lib/episode-completion.test.ts`; here they
    // are re-asserted as an *equivalence*, so this file's hand-rolled
    // `beforeEach` mirror cannot drift away from production without saying so.
    // (That the hooks are still wired to these handlers at all, rather than to a
    // pasted-back inline closure, is guarded in that same file.)
    //
    // The deps are inert on purpose: no `autoMerge`, no `autoMoveToCold`, no
    // `notificationMode`, so the group-complete tail reduces to invalidate,
    // write, merge-status, schedule — and the store is the only thing compared.
    const realHandlers = (target: FakeStore): ReturnType<typeof createEpisodeCompletionHandlers> =>
      createEpisodeCompletionHandlers({
        store: {
          get: ((key: string) =>
            key === 'downloadedEpisodes'
              ? target.get('downloadedEpisodes')
              : undefined) as EpisodeCompletionStore['get'],
          set: target.set as EpisodeCompletionStore['set']
        },
        downloadManager: dm,
        fileScanner: { invalidate: () => {} },
        coldStorageService: {
          isAdvanced: () => false,
          moveEpisodeToColdStorage: async () => {}
        },
        skipAnalysisService: { scheduleAutoSkipAnalysis: () => {} },
        mp4StatsService: { recordCheck: async () => {} },
        ffmpegReady: Promise.resolve({ available: false }),
        getFfmpegPath: () => '',
        getFfprobePath: () => '',
        notify: () => {}
      })

    it('writes what this file writes for a .mp4 video item', () => {
      const real = makeStore()
      const video = makeItem({ status: 'completed' })

      persistDownloadedEpisode(store, video)
      realHandlers(real).handleVideoDownloaded(path.join(downloadDir, video.filename), video)

      expect(real.entries).toEqual(store.entries)
      expect(real.entries).toEqual({ '100:1:1': ENTRY })
    })

    it('writes what this file writes for a .mkv video item', () => {
      // The ordering case. With the write below the .mp4 filter, production
      // would record nothing here while this file's mirror still recorded the
      // entry — the two sides would disagree and this assertion would fail.
      const real = makeStore()
      const video = makeItem({
        status: 'completed',
        filename: path.join('Anime', 'Anime - 01 [Author].mkv')
      })

      persistDownloadedEpisode(store, video)
      realHandlers(real).handleVideoDownloaded(path.join(downloadDir, video.filename), video)

      expect(real.entries).toEqual(store.entries)
      expect(real.entries).toEqual({ '100:1:1': ENTRY })
    })

    it('agrees on both sides of the group-complete hasVideo gate', async () => {
      const withVideo: EpisodeCompleteInfo = {
        animeName: 'Anime',
        episodeLabel: 'ep1',
        animeId: 100,
        episodeInt: '1',
        translationId: 1,
        translationType: 'subRu',
        author: 'Author',
        quality: 720,
        hasVideo: true
      }
      const subtitleOnly: EpisodeCompleteInfo = { ...withVideo, hasVideo: false }

      const a = makeStore()
      await realHandlers(a).handleEpisodeComplete(withVideo)
      if (withVideo.hasVideo) persistDownloadedEpisode(store, withVideo)
      expect(a.entries).toEqual(store.entries)
      expect(a.entries).toEqual({ '100:1:1': ENTRY })

      const b = makeStore()
      await realHandlers(b).handleEpisodeComplete(subtitleOnly)
      expect(b.entries).toEqual({})
    })
  })
})
