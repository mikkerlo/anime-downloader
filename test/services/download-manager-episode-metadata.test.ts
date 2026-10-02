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

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  DownloadManager,
  isNonVideoContentType,
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

/**
 * A store whose write fails the way electron-store's really does (#428). `set`
 * is a synchronous whole-file atomic JSON write, so it propagates ENOSPC,
 * EACCES on a locked userData dir, EROFS and serialization errors straight out
 * of `persistDownloadedEpisode`, which has no try/catch of its own.
 *
 * No fixture in the suite injected a failure here before this issue — the nine
 * cases in `test/lib/downloaded-episodes.test.ts` all use a store that only
 * clones and counts — so the hook's catch had never been executed by a test.
 */
function makeFailingStore(
  err: Error = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
): FakeStore & {
  readonly attempts: number
} {
  let attempts = 0
  return {
    get: () => ({}),
    set: () => {
      attempts++
      throw err
    },
    get entries() {
      return {}
    },
    get attempts() {
      return attempts
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
  let mirrorVideoHook: (filePath: string, item: DownloadItem) => void
  let mirrorEpisodeHook: (info: EpisodeCompleteInfo) => void

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-meta-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-meta-dl-'))
    dm = new DownloadManager(downloadDir, { getSubtitlesUrl: () => 's' } as never, userDataDir)
    store = makeStore()
    episodePayloads = []
    videoHookCalls = []

    // Mirror of src/main/index.ts: the video hook writes unconditionally, the
    // group-complete hook is the repair path and is gated on `hasVideo`. Both
    // are named so the equivalence block at the bottom can call these exact
    // closures instead of re-copying their bodies.
    mirrorVideoHook = (filePath, item) => {
      videoHookCalls.push({ filePath, itemId: item.id })
      persistDownloadedEpisode(store, item)
    }
    mirrorEpisodeHook = (info) => {
      episodePayloads.push(info)
      if (info.hasVideo) persistDownloadedEpisode(store, info)
    }
    dm.onVideoDownloaded(mirrorVideoHook)
    dm.onEpisodeComplete(mirrorEpisodeHook)

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

  /**
   * The real `src/main/lib/episode-completion.ts` tails over an injected store,
   * with every other dep inert — no `autoMerge`, no `autoMoveToCold`, no
   * `notificationMode`, so the group-complete tail reduces to invalidate,
   * write, merge-status, schedule and the store is the only thing observed.
   * Shared by the #409 equivalence block and the #428 failure block.
   */
  const realHandlers = (
    target: DownloadedEpisodesStore
  ): ReturnType<typeof createEpisodeCompletionHandlers> =>
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
        moveEpisodeToColdStorage: async () => {},
        moveFileToColdByRelPath: async () => {}
      },
      skipAnalysisService: { scheduleAutoSkipAnalysis: () => {} },
      mp4StatsService: { recordCheck: async () => {} },
      ffmpegReady: Promise.resolve({ available: false }),
      getFfmpegPath: () => '',
      getFfprobePath: () => '',
      notify: () => {}
    })

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

  // The same store, driven through the other new way an entry can be wrong
  // (#444). A 200 whose body is a web page — an unauthenticated request
  // answered with an error/interstitial page — used to be streamed to the
  // episode's final filename and recorded 'completed', so the video hook wrote
  // a `downloadedEpisodes` entry for a 169 KB HTML document. `episodeFileExists`
  // is satisfied by it, so #421/#439's GC correctly refuses to collect it and
  // the bogus ⬇ is durable: the only recovery was deleting the file by hand.
  //
  // These cases live next to the #412 ones because the headline claim is about
  // this file's subject — the entry — and not only about the status. The
  // rejection rule is a denylist of document types rather than an allowlist of
  // video ones, so the false-positive guards below are half the block: a
  // stream served as `application/octet-stream`, one with no `Content-Type` at
  // all, a resumed 206 and a subtitle's `text/*` body all still complete.
  //
  // Both status paths are refused and both are asserted. The 206 arm needs its
  // own case rather than riding on the 200 ones: narrowing the gate to
  // `response.status === 200` is invisible to every other case here, and the
  // scenario it reopens — Resume against an expired link answered `206` with an
  // interstitial — appends the page to a `.part` that was previously good.
  describe('a response that is not video is refused before it reaches disk (#444)', () => {
    /** The observed body: an interstitial page served 200 for a video URL. */
    const HTML_BODY = '<!doctype html><html><body>Sign in to continue</body></html>'

    /**
     * Stubs one response, and means it when a case says "no `Content-Type`".
     *
     * `new Response('<string body>')` does not leave the header absent —
     * undici supplies `text/plain;charset=UTF-8` for a string body, measured:
     * `new Response('video-bytes', { headers: { 'content-length': '11' } })
     * .headers.get('content-type')` is `"text/plain;charset=UTF-8"`. Nor does
     * passing a `Headers` object with the key deleted, because the default is
     * applied at construction from the body source. So a case meaning to
     * exercise the genuinely-headerless path has to strip it afterwards, which
     * is what the `delete` below does — otherwise those cases silently retest
     * the `text/plain` abstention, which is covered on its own elsewhere.
     *
     * (That default is also why this file's `beforeEach` mock has been serving
     * every other case here as `text/plain` all along, and why they stay green:
     * `text/plain` is deliberately NOT in the denylist. nginx's `default_type`
     * is `text/plain`, so the abstention is load-bearing, not merely prudent.)
     */
    const respondWith = (body: string, headers: Record<string, string>, status = 200): void => {
      global.fetch = vi.fn(async () => {
        const response = new Response(body, { status, headers })
        if (!('content-type' in headers)) response.headers.delete('content-type')
        return response
      }) as unknown as typeof fetch
    }

    /** Outwaits the first retry's `2^0 * 1000` ms backoff. */
    const settleFirstBackoff = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 1300))

    const finalPath = (item: DownloadItem): string => path.join(downloadDir, item.filename)

    it('lands failed with a reason and writes no downloadedEpisodes entry', async () => {
      // THE regression case. Without the content-type check this ends
      // 'completed' with `{ '100:1:1': ENTRY }` in the store and the HTML body
      // sitting at the episode's final filename.
      const video = makeItem({})
      seed(dm, [video])
      respondWith(HTML_BODY, { 'content-type': 'text/html; charset=utf-8' })

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(video.status).toBe('failed')
      expect(video.error).toMatch(/text\/html/)
      expect(store.entries).toEqual({})
      expect(videoHookCalls).toEqual([])
      // Nothing was streamed, so neither name exists — in particular the body
      // is not parked as a resumable `.part` for the next attempt to append to.
      expect(fs.existsSync(finalPath(video))).toBe(false)
      expect(fs.existsSync(finalPath(video) + '.part')).toBe(false)
    })

    it('refuses on the first response instead of burning the retry ladder', async () => {
      // A wrong content type is deterministic: three more fetches of the same
      // URL cost ~7 s and cannot change the answer. This is the assertion that
      // pins the non-retryable arm of the catch.
      const video = makeItem({})
      seed(dm, [video])
      respondWith(HTML_BODY, { 'content-type': 'text/html' })

      await (dm as unknown as Internals).startDownload(video)
      // The count is the distinctive half: without the non-retryable arm this
      // reads 2 one backoff later, on its way to RETRY_LIMIT + 1 fetches of a
      // URL whose answer cannot change.
      expect(global.fetch).toHaveBeenCalledTimes(1)
      expect(video.status).toBe('failed')

      await settleFirstBackoff()
      expect(global.fetch).toHaveBeenCalledTimes(1)
      expect(video.status).toBe('failed')
      expect(store.entries).toEqual({})
    })

    it('does not let a completed sibling subtitle carry the group to complete', async () => {
      // The group gate is the second writer, and the name is only honest if
      // the gate is actually run. Asserting `episodePayloads` after the
      // rejection alone does not do that: the refusal never calls
      // `checkEpisodeComplete`, so an empty payload list there is the trivial
      // consequence of nothing having been dispatched, and the case would red
      // under exactly the same mutant as the headline and no other. (Adding a
      // `checkEpisodeComplete` call to the failure path is harmless for the
      // same reason, which is why that mutant survives this file — the
      // property is `allDone`, not the call site.)
      //
      // So drive the gate directly afterwards, with the group in the state a
      // user would be looking at: a completed `.ass` beside a refused video.
      // `allDone` is `every(i => i.status === 'completed')`, so the refused
      // video is what holds it false — and a rule that ignored failed videos
      // would write the repair entry for an episode with no playable file.
      const video = makeItem({})
      const subtitle = makeSubtitle({ status: 'completed' })
      seed(dm, [video, subtitle])
      respondWith(HTML_BODY, { 'content-type': 'text/html' })

      await (dm as unknown as Internals).startDownload(video)
      ;(dm as unknown as Internals).checkEpisodeComplete(1)
      await settleEpisodeComplete()

      expect(video.status).toBe('failed')
      expect(subtitle.status).toBe('completed')
      expect(episodePayloads).toEqual([])
      expect(store.entries).toEqual({})
    })

    it('parses the header rather than matching it, so parameters and casing still reject', async () => {
      const video = makeItem({})
      seed(dm, [video])
      respondWith(HTML_BODY, { 'content-type': 'Text/HTML; charset=UTF-8' })

      await (dm as unknown as Internals).startDownload(video)

      expect(video.status).toBe('failed')
      expect(store.entries).toEqual({})
    })

    it('refuses a JSON error envelope too', async () => {
      const video = makeItem({})
      seed(dm, [video])
      respondWith('{"error":"unauthorized"}', { 'content-type': 'application/json' })

      await (dm as unknown as Internals).startDownload(video)

      expect(video.status).toBe('failed')
      expect(store.entries).toEqual({})
    })

    it('refuses a 206 Range reply that is a document, leaving the .part byte-identical', async () => {
      // The resume arm, and the one case the rest of this block cannot reach:
      // every other rejection here is a 200, so narrowing the gate to
      // `item.kind === 'video' && response.status === 200` left the full suite
      // green. The live scenario is ordinary — a half-downloaded episode's
      // `.part` is on disk, the stream link expires, the user hits Resume, and
      // the edge cache answers `206 Partial Content` with an HTML
      // interstitial. Under that narrowing the item takes the 206 bookkeeping,
      // APPENDS the page to the `.part` (`fileFlags` is 'a' on this path, not
      // 'w'), completes, renames and writes the entry — #444 restored on the
      // resume path, on top of bytes that were previously good.
      const existing = 'abc'
      const video = makeItem({})
      seed(dm, [video])
      fs.mkdirSync(path.dirname(finalPath(video)), { recursive: true })
      fs.writeFileSync(finalPath(video) + '.part', existing)
      respondWith(HTML_BODY, { 'content-type': 'text/html', 'content-range': 'bytes 3-12/13' }, 206)

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      // The premise, read off the Response the manager was actually handed
      // rather than assumed: a dropped `206` argument makes this a 200 case
      // the gate already covers, and the mutant it exists to catch walks
      // straight through it. (It did, once — the status defaults to 200.)
      const served = (await (global.fetch as unknown as Mock).mock.results[0]
        .value) as unknown as Response
      expect(served.status).toBe(206)
      expect(video.status).toBe('failed')
      expect(store.entries).toEqual({})
      expect(videoHookCalls).toEqual([])
      // Byte-identical: not appended to, not truncated, and not renamed. The
      // good bytes a later Restart would discard are at least still here for a
      // Resume against a freshly resolved URL.
      expect(fs.readFileSync(finalPath(video) + '.part', 'utf-8')).toBe(existing)
      expect(fs.existsSync(finalPath(video))).toBe(false)
    })

    // ---- false-positive guards: a rule that reds a good download is worse ----

    it('still completes a normal video response and still writes its entry', async () => {
      const video = makeItem({})
      seed(dm, [video])
      respondWith(VIDEO_BODY, {
        'content-type': 'video/mp4',
        'content-length': String(Buffer.byteLength(VIDEO_BODY))
      })

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(video.status).toBe('completed')
      expect(store.entries).toEqual({ '100:1:1': ENTRY })
      expect(fs.readFileSync(finalPath(video), 'utf-8')).toBe(VIDEO_BODY)
    })

    it('still completes a response with no Content-Type at all', async () => {
      // A missing header is not grounds for rejection: there is nothing to
      // disagree with, and the alternative — rejecting the unknown — is the
      // allowlist this rule deliberately is not.
      const video = makeItem({})
      seed(dm, [video])
      respondWith(VIDEO_BODY, { 'content-length': String(Buffer.byteLength(VIDEO_BODY)) })

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(video.status).toBe('completed')
      expect(store.entries).toEqual({ '100:1:1': ENTRY })
    })

    it('still completes a stream served as application/octet-stream', async () => {
      const video = makeItem({})
      seed(dm, [video])
      respondWith(VIDEO_BODY, { 'content-type': 'application/octet-stream' })

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(video.status).toBe('completed')
      expect(store.entries).toEqual({ '100:1:1': ENTRY })
    })

    it('leaves subtitle items alone — the gate is keyed on kind, not on the type', async () => {
      // An `.ass` legitimately arrives as `text/plain`, so a document denylist
      // applied to a subtitle would be a pure false-positive generator. The
      // sharper half is the second case: even `text/html` on a subtitle
      // completes, which is only true if the gate reads `item.kind`.
      const subtitle = makeSubtitle({})
      seed(dm, [subtitle])
      respondWith('[Script Info]', { 'content-type': 'text/plain; charset=utf-8' })

      await (dm as unknown as Internals).startDownload(subtitle)
      expect(subtitle.status).toBe('completed')

      const second = makeSubtitle({ id: 'sub-2', status: 'queued' })
      seed(dm, [second])
      respondWith('[Script Info]', { 'content-type': 'text/html' })

      await (dm as unknown as Internals).startDownload(second)
      expect(second.status).toBe('completed')
    })

    it('still completes a resumed 206, both with a video type and with none', async () => {
      // The check runs above the 206 bookkeeping and gates both status paths,
      // so the resume arm is where it could most easily misfire. A legitimate
      // Range reply carries a video type or no type; neither is in the set.
      const existing = 'abc'
      const headerSets: Record<string, string>[] = [
        { 'content-type': 'video/mp4', 'content-range': 'bytes 3-12/13' },
        { 'content-range': 'bytes 3-12/13' }
      ]
      for (const headers of headerSets) {
        const video = makeItem({})
        seed(dm, [video])
        // The hook closes over the `store` binding, so swapping the store is
        // all the second iteration needs — re-registering `mirrorVideoHook`
        // would be a no-op into a single slot it already occupies.
        store = makeStore()
        fs.mkdirSync(path.dirname(finalPath(video)), { recursive: true })
        fs.writeFileSync(finalPath(video) + '.part', existing)
        respondWith(VIDEO_BODY, headers, 206)

        await (dm as unknown as Internals).startDownload(video)
        await settleEpisodeComplete()

        expect(video.status).toBe('completed')
        expect(store.entries).toEqual({ '100:1:1': ENTRY })
        // Appended, not truncated — the resume really resumed.
        expect(fs.readFileSync(finalPath(video), 'utf-8')).toBe(existing + VIDEO_BODY)
        expect(video.totalBytes).toBe(13)
        fs.rmSync(finalPath(video), { force: true })
      }
    })

    it('leaves a pre-existing .part in place on rejection', async () => {
      // Nothing was streamed, so the only thing at stake is a `.part` from an
      // earlier partial transfer whose `Range` the server ignored. It stays,
      // consistent with every other failure out of this catch: `restart()` is
      // what unlinks a `.part`, and deleting it here would discard resumable
      // bytes over a response that never reached the disk.
      const video = makeItem({})
      seed(dm, [video])
      fs.mkdirSync(path.dirname(finalPath(video)), { recursive: true })
      fs.writeFileSync(finalPath(video) + '.part', 'partial-video-bytes')
      respondWith(HTML_BODY, { 'content-type': 'text/html' })

      await (dm as unknown as Internals).startDownload(video)

      expect(video.status).toBe('failed')
      expect(fs.readFileSync(finalPath(video) + '.part', 'utf-8')).toBe('partial-video-bytes')
      expect(fs.existsSync(finalPath(video))).toBe(false)
      expect(store.entries).toEqual({})
    })

    it('classifies types directly, including the ones it deliberately permits', () => {
      // The conservative half of the rule, asserted where it is readable:
      // `text/plain` is the type a dumb static server reaches for when it
      // cannot guess a binary's, so denying it would be the first false
      // positive.
      for (const bad of [
        'text/html',
        'TEXT/HTML',
        'text/html;charset=utf-8',
        'application/xhtml+xml',
        'application/json',
        'application/ld+json',
        'text/xml',
        'application/xml'
      ]) {
        expect(isNonVideoContentType(bad)).toBe(true)
      }
      for (const good of [
        null,
        undefined,
        '',
        'video/mp4',
        'video/x-matroska',
        'audio/mpeg',
        'application/octet-stream',
        'binary/octet-stream',
        'text/plain',
        'text/vtt',
        'application/vnd.apple.mpegurl'
      ]) {
        expect(isNonVideoContentType(good)).toBe(false)
      }
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
      // only the VIDEO item's quality (`download-manager.ts:701`); the subtitle
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
    // (`realHandlers` itself lives in the outer describe: the #428 block below
    // drives the same production handler with a store whose `set` throws.)

    it('writes what this file writes for a .mp4 video item', () => {
      const real = makeStore()
      const video = makeItem({ status: 'completed' })

      mirrorVideoHook(path.join(downloadDir, video.filename), video)
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

      mirrorVideoHook(path.join(downloadDir, video.filename), video)
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
      mirrorEpisodeHook(withVideo)
      expect(a.entries).toEqual(store.entries)
      expect(a.entries).toEqual({ '100:1:1': ENTRY })

      store = makeStore()
      const b = makeStore()
      await realHandlers(b).handleEpisodeComplete(subtitleOnly)
      mirrorEpisodeHook(subtitleOnly)
      expect(b.entries).toEqual(store.entries)
      expect(b.entries).toEqual({})
    })
  })

  // A lost `downloadedEpisodes` entry is permanent: nothing in the tree can
  // reconstruct one. `episode-file-scan.ts` never touches the store and no
  // filename carries a translation id, so `fileStatus` self-heals on a rescan
  // and `episodeMeta` structurally cannot — which is a video on disk with no
  // Play and no Delete, the #412 symptom exactly. Until #428 the hook's catch
  // was one `console.warn`, with the row already 'completed' and already
  // persisted above the dispatch, so the queue reported a clean download.
  describe('a failed metadata write is visible on the row (#428)', () => {
    /** Replaces the mirror hook with the real production tail over `target`. */
    const wireReal = (target: DownloadedEpisodesStore): void => {
      const handlers = realHandlers(target)
      dm.onVideoDownloaded((filePath, item) => {
        videoHookCalls.push({ filePath, itemId: item.id })
        handlers.handleVideoDownloaded(filePath, item)
      })
    }

    /**
     * Counts `startDownload` entries and calls through. `dispatchHook` runs
     * inside `startDownload`'s try, whose catch re-queues with exponential
     * backoff — so an escape from the helper would re-download a video that is
     * already on disk, and the call count is how that shows up.
     */
    const countStarts = (): number[] => {
      const internals = dm as unknown as Internals
      const original = internals.startDownload.bind(dm)
      const retries: number[] = []
      internals.startDownload = (item, retryCount = 0) => {
        retries.push(retryCount)
        return original(item, retryCount)
      }
      return retries
    }

    /** Outwaits the first retry's `2^0 * 1000` ms backoff. */
    const settleFirstBackoff = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 1300))

    /**
     * Collects process-level unhandled rejections for the duration of one test,
     * the same way the merge-complete cases in
     * `download-manager-merge-scheduling.test.ts` do. Vitest fails a run on an
     * escaped rejection anyway; the listener is what says which dispatch let it
     * out instead of just failing the file.
     */
    function captureUnhandled(): { seen: unknown[]; stop: () => void } {
      const seen: unknown[] = []
      const onUnhandled = (reason: unknown): void => {
        seen.push(reason)
      }
      process.on('unhandledRejection', onUnhandled)
      return { seen, stop: () => process.off('unhandledRejection', onUnhandled) }
    }

    it('marks the item instead of reporting a clean completion', async () => {
      const failing = makeFailingStore()
      wireReal(failing)
      const video = makeItem({})
      seed(dm, [video])

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      // The file really did land, so 'completed' is right — what was wrong was
      // reporting it with nothing to say that the metadata went missing.
      expect(video.status).toBe('completed')
      expect(fs.existsSync(path.join(downloadDir, video.filename))).toBe(true)
      expect(failing.attempts).toBe(1)
      expect(video.error).toMatch(/ENOSPC/)
    })

    it('marks the item when an async consumer rejects, not only when one throws', async () => {
      // The thenable half of `dispatchHook`, at the only dispatch site that
      // passes an item. Today's consumer is synchronous, so the sync case
      // above is the one that runs in production — but #428 widened the slot to
      // `=> void | Promise<void>`, which makes an `async` consumer legal here,
      // and the merge consumer next door already awaits a cold move. Dropping
      // the `.catch` attachment for a bare `void result` leaves the row
      // 'completed' with no error at all and floats the reason out of the
      // process, which is the same silent clean-success report #428 removed.
      const watch = captureUnhandled()
      try {
        const failing = makeFailingStore()
        const handlers = realHandlers(failing)
        dm.onVideoDownloaded(async (filePath, item) => {
          videoHookCalls.push({ filePath, itemId: item.id })
          // The await is the point: the throw lands after the dispatch has
          // already returned, so only the attached `.catch` can see it.
          await Promise.resolve()
          handlers.handleVideoDownloaded(filePath, item)
        })
        const video = makeItem({})
        seed(dm, [video])

        await (dm as unknown as Internals).startDownload(video)
        await settleEpisodeComplete()

        expect(videoHookCalls).toHaveLength(1)
        expect(failing.attempts).toBe(1)
        expect(video.status).toBe('completed')
        expect(fs.existsSync(path.join(downloadDir, video.filename))).toBe(true)
        expect(video.error).toMatch(/Post-download step failed: ENOSPC/)
        expect(watch.seen).toEqual([])
      } finally {
        watch.stop()
      }
    })

    it('does not re-download the completed video (the helper never throws)', async () => {
      wireReal(makeFailingStore())
      const video = makeItem({})
      seed(dm, [video])
      const retries = countStarts()

      await (dm as unknown as Internals).startDownload(video)
      await settleFirstBackoff()

      // One entry, at retryCount 0. A throw escaping `dispatchHook` would flip
      // the row to 'queued' and schedule `startDownload(item, 1)`.
      expect(retries).toEqual([0])
      expect(video.status).toBe('completed')
      expect(video.error).toMatch(/ENOSPC/)
    })

    it('leaves the loss visible in the narrow window the repair path cannot reach', async () => {
      // Permanent loss needs both halves: the write fails AND the group never
      // reaches `allDone`, so `onEpisodeComplete` — the repair writer — never
      // fires. A failed sibling subtitle is exactly that, and is the case #412
      // existed to fix.
      const failing = makeFailingStore()
      wireReal(failing)
      const video = makeItem({})
      const subtitle = makeSubtitle({ status: 'failed', error: 'HTTP 404 Not Found' })
      seed(dm, [video, subtitle])

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(episodePayloads).toEqual([])
      expect(failing.entries).toEqual({})
      expect(video.status).toBe('completed')
      expect(video.error).toMatch(/Post-download step failed: ENOSPC/)
    })

    it('leaves no error on an unkeyable item — a false return is not a failure', async () => {
      // `persistDownloadedEpisode` returns false only for `animeId <= 0 ||
      // !episodeInt`. The rest of main treats those as expected and skips them
      // quietly, so marking the row would put a permanent red line on every
      // manual-scan download for a write that could never have been read back.
      const working = makeStore()
      wireReal(working)
      const video = makeItem({ animeId: 0 })
      seed(dm, [video])

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(videoHookCalls).toHaveLength(1)
      expect(working.entries).toEqual({})
      expect(video.status).toBe('completed')
      expect(video.error).toBeUndefined()
    })

    it('keeps the entry that the repair path manages to write afterwards', async () => {
      // The complement of the case above: when the group DOES reach `allDone`,
      // the group-complete repair write runs outside the video hook's failure
      // and lands the entry. Nothing clears the `item.error` the manager set —
      // accepted deliberately (it was true when it was set), and stated in
      // `docs/data-flow.md` rather than given a manager API to undo it.
      const real = makeStore()
      let firstWrite = true
      const flaky: DownloadedEpisodesStore = {
        get: () => real.get('downloadedEpisodes'),
        set: (key, value) => {
          if (firstWrite) {
            firstWrite = false
            throw new Error('ENOSPC: no space left on device')
          }
          real.set(key, value)
        }
      }
      const handlers = realHandlers(flaky)
      dm.onVideoDownloaded((filePath, item) => {
        videoHookCalls.push({ filePath, itemId: item.id })
        handlers.handleVideoDownloaded(filePath, item)
      })
      dm.onEpisodeComplete(handlers.handleEpisodeComplete)

      const video = makeItem({})
      seed(dm, [video])

      await (dm as unknown as Internals).startDownload(video)
      await settleEpisodeComplete()

      expect(real.entries).toEqual({ '100:1:1': ENTRY })
      expect(video.error).toMatch(/ENOSPC/)
    })
  })
})
