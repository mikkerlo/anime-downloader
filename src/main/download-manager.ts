import { BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc/channels'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import Ffmpeg from 'fluent-ffmpeg'
import type { SmotretApi } from './smotret-api'
import { fetchWithTimeout } from './lib/net'
import { isNetworkError } from './lib/errors'

interface RunFfmpegOptions {
  ffmpegPath: string
  ffprobePath: string
  videoPath: string
  outputPath: string
  subtitlePath?: string | null
  codec?: string
  subMeta?: { language: string; title: string }
  onPercent?: (pct: number) => void
}

/**
 * The fluent-ffmpeg surface `runFfmpeg` drives (#516). Injectable through
 * `setFfmpegDriver` so a test can hand in a fake command and run the real
 * `runFfmpeg` body — the probe re-check, the `'start'` priority drop and the
 * `'end'`/`'error'` bookkeeping — instead of replacing the method wholesale.
 * `unlinkSync` is the unlink `destroy()` uses on a killed merge's output.
 */
export interface FfmpegDriver {
  createCommand: (input: string) => ReturnType<typeof Ffmpeg>
  probeDuration: (ffmpegPath: string, ffprobePath: string, videoPath: string) => Promise<number>
  setPriority: (pid: number, priority: number) => void
  unlinkSync: (file: string) => void
}

/**
 * What `runFfmpeg` resolves with: `'held'` when the player opened while the
 * duration was being probed, so nothing was spawned and the caller has to put
 * the merge back (#516).
 */
type RunFfmpegOutcome = 'done' | 'held'

function probeDuration(
  ffmpegPath: string,
  ffprobePath: string,
  videoPath: string
): Promise<number> {
  return new Promise((resolve) => {
    Ffmpeg.setFfmpegPath(ffmpegPath)
    Ffmpeg.setFfprobePath(ffprobePath)
    Ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error(`[ffprobe] Error probing ${videoPath}:`, err.message)
        resolve(0)
      } else if (!metadata?.format?.duration) {
        console.warn(`[ffprobe] No duration in metadata for ${videoPath}`)
        resolve(0)
      } else {
        console.log(`[ffprobe] Duration: ${metadata.format.duration}s for ${videoPath}`)
        resolve(metadata.format.duration)
      }
    })
  })
}

const DEFAULT_FFMPEG_DRIVER: FfmpegDriver = {
  createCommand: (input) => Ffmpeg(input),
  probeDuration,
  setPriority: (pid, priority) => os.setPriority(pid, priority),
  unlinkSync: (file) => fs.unlinkSync(file)
}

const QUIT_UNLINK_DEADLINE_MS = 200
const QUIT_UNLINK_RETRY_MS = 5

/**
 * Unlinks a killed merge's partial output on quit (#516). On Windows
 * `TerminateProcess` returns before ffmpeg's file handle is closed, so the
 * first unlink fails with a sharing violation (EBUSY, or EPERM) and one a few
 * ms later succeeds. Quit is synchronous, so the retry sleeps with
 * `Atomics.wait` up to a short deadline. ENOENT counts as removed; any other
 * error, or the deadline, gives up and leaves the `.mkv` to the boot fallback.
 */
function unlinkKilledOutput(file: string, unlink: (file: string) => void): void {
  const deadline = Date.now() + QUIT_UNLINK_DEADLINE_MS
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 1; ; attempt++) {
    try {
      unlink(file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      const left = deadline - Date.now()
      if ((code !== 'EBUSY' && code !== 'EPERM') || left <= 0) {
        console.warn(
          `[merge] Could not remove the partial output on quit (${code}, ${attempt} tries); the next launch removes it`
        )
        return
      }
      Atomics.wait(sleeper, 0, 0, Math.min(QUIT_UNLINK_RETRY_MS, left))
    }
  }
}

function heldScanMessage(left: number): string {
  return `Merging is paused while the player is open: ${left} file${left === 1 ? '' : 's'} left`
}

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
// 'deferred': the video finished downloading while the built-in player had the
// file open — both the .part → final rename and the merge wait for the player
// lock to release (finalizeDeferred), surviving restarts via queue.json.
export type MergeStatus = 'pending' | 'merging' | 'completed' | 'failed' | 'deferred'

export interface DownloadItem {
  id: string
  translationId: number
  kind: 'video' | 'subtitle'
  url: string
  filename: string
  animeName: string
  episodeLabel: string
  animeId: number
  episodeInt: string
  quality: number
  translationType: string
  author: string
  status: DownloadStatus
  bytesReceived: number
  totalBytes: number
  speed: number
  error?: string
}

export interface EpisodeGroup {
  translationId: number
  animeName: string
  animeId: number
  episodeInt: string
  episodeLabel: string
  quality: number
  translationType: string
  author: string
  video: DownloadItem | null
  subtitle: DownloadItem | null
  mergeStatus: MergeStatus
  hasMergeEntry: boolean
  mergePercent?: number
  mergeError?: string
}

export interface DownloadRequest {
  translationId: number
  height: number
  animeName: string
  episodeLabel: string
  episodeInt: string
  animeId: number
  translationType: string
  author: string
}

export interface EpisodeCompleteInfo {
  animeName: string
  episodeLabel: string
  animeId: number
  episodeInt: string
  translationId: number
  translationType: string
  author: string
  quality: number
  /**
   * Whether the completed group actually contained a video item (#412). False
   * for a subtitle-only group, which `enqueue` can produce when an embed has a
   * `subtitlesUrl` but no usable stream — the rest of this payload is then
   * copied off the subtitle and describes no file on disk, so a consumer that
   * persists episode metadata must skip it.
   */
  hasVideo: boolean
}

const USER_AGENT = 'smotret-anime-dl'
const RETRY_LIMIT = 3
// A failed attempt that grew the `.part` by at least this much retries at the
// same rung after a short fixed delay instead of the 1/2/4 s ladder (#597): a
// throttled transfer from a server with a short keep-alive is cut off with
// `TypeError: terminated` while it is still making progress. Every attempt in
// one chain counts toward the attempt limit, so a server that drops every
// connection cannot loop forever.
export const PROGRESS_RETRY_MIN_BYTES = 256 * 1024
export const PROGRESS_RETRY_DELAY_MS = 250
export const RETRY_ATTEMPT_LIMIT = 20
const PROGRESS_INTERVAL_MS = 500
// A transfer with no headers, or no bytes, for this long rejects with
// `TimeoutError` and takes the retry ladder; the `.part` stays for the `Range`
// resume (#567). The connect deadline covers redirects to the CDN as well.
export const DOWNLOAD_IDLE_MS = 60_000
export const DOWNLOAD_CONNECT_MS = 60_000

/**
 * How far `item.bytesReceived` is allowed to run **ahead** of the `.part` on
 * disk before `verifyRootBoundFilesUnder()` calls a shorter file someone else's
 * (#455 review).
 *
 * It bounds exactly one quantity: the bytes `trackProgress` had already counted
 * but that had not reached `fileStream` when the transfer was aborted.
 * `trackProgress` is the *first* stage of `pipeline(readable, trackProgress,
 * throttle, fileStream)`, so it increments the counter before `throttle` and the
 * write stream ever see the chunk — a few stream buffers (64 KiB each at most by
 * default) plus the one chunk `throttle` is holding in its `setTimeout`. So the
 * real ceiling is well under a mebibyte and this is roughly fourfold headroom.
 *
 * The gap is not self-correcting, which is why it has to be tolerated rather
 * than reconciled: `destroy()` calls `persistQueue()` *before* it aborts, so a
 * quit mid-download writes the inflated counter to `queue.json`, and by the next
 * start the drive is gone and nothing can stat the `.part` to fix it. That is
 * precisely the relocated-drive situation this check runs in.
 *
 * Too tight a bound over-blocks a move the user could have had, which is the
 * safe failure — they keep the clear refusal they have today. Too loose adopts a
 * foreign `.part`, which corrupts a download silently, so err small. The
 * opposite drift — a `.part` **longer** than the counter, which a hard kill
 * between the 5 s periodic persists can leave behind — is still refused.
 */
export const PART_IN_FLIGHT_SLACK = 4 * 1024 * 1024

/**
 * MIME types a video response is never legitimately served as (#444).
 *
 * A **denylist of clearly-wrong types**, never an allowlist of video ones. The
 * failure being closed is a 200 whose body is a web page — an unauthenticated
 * request answered with an error/interstitial page, streamed to the episode's
 * final filename and recorded `completed`, which writes a durable
 * `downloadedEpisodes` entry for a file `ffprobe` calls `moov atom not found`.
 * An allowlist would instead red every server that serves a stream as
 * `application/octet-stream` or with no `Content-Type` at all, and a false
 * positive here breaks the app's core function — strictly worse than the bug.
 *
 * So the set holds only document types: nothing here is a plausible labelling
 * of a video byte range by any server, correct or sloppy. `text/plain` is
 * deliberately **absent** — it is the type a dumb static server reaches for
 * when it cannot guess a binary's type, so denying it would be the first false
 * positive. `video/*`, `audio/*`, `application/octet-stream`, anything
 * unrecognised and a missing header all pass; a missing `Content-Type` is not
 * grounds for rejection.
 */
const NON_VIDEO_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'application/ld+json',
  'text/xml',
  'application/xml'
])

/**
 * The bare MIME type of a `Content-Type` header, lowercased (#444) — the header
 * carries parameters and arbitrary casing (`Text/HTML; charset=utf-8`), and
 * only the part before the first `;` identifies the body. `''` for a missing or
 * empty header, which is never a match below.
 */
function mimeTypeOf(header: string | null | undefined): string {
  return header ? header.split(';')[0].trim().toLowerCase() : ''
}

/**
 * Whether a `Content-Type` header names one of the document types above (#444).
 */
export function isNonVideoContentType(header: string | null | undefined): boolean {
  return NON_VIDEO_CONTENT_TYPES.has(mimeTypeOf(header))
}

/**
 * A rejection the same request cannot talk its way out of (#444).
 *
 * `startDownload`'s catch re-queues an item and re-fetches the same URL up to
 * `RETRY_LIMIT` times with 1/2/4 s backoff. A wrong content type is
 * deterministic, so retrying costs four requests and ~7 s of a user staring at
 * 'queued' before the row finally says what was wrong on the first response.
 * The catch skips the retry branch for this class.
 */
class NonRetryableDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableDownloadError'
  }
}

function partSize(partPath: string): number {
  try {
    return fs.statSync(partPath).size
  } catch {
    return 0
  }
}

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
}

function subtitleLanguage(translationType: string): string {
  if (
    translationType.endsWith('Ru') ||
    translationType === 'voiceRu' ||
    translationType === 'subRu'
  )
    return 'rus'
  if (
    translationType.endsWith('En') ||
    translationType === 'voiceEn' ||
    translationType === 'subEn'
  )
    return 'eng'
  return 'und'
}

export class DownloadManager {
  private queue: DownloadItem[] = []
  private mergeStatuses = new Map<
    number,
    { status: MergeStatus; error?: string; percent?: number }
  >()
  private activeCount = 0
  private abortControllers = new Map<string, AbortController>()
  private progressTimer: ReturnType<typeof setInterval> | null = null
  private downloadDir: string
  private api: SmotretApi
  private getSpeedLimit: () => number
  private getConcurrentLimit: () => number
  // The four consumer slots all return `void | Promise<void>` on purpose
  // (#428). They used to be typed `=> void`, which did not stop a consumer from
  // being declared `async` — and then the disposition of a thrown error
  // depended on that keyword: a sync throw hit whatever try happened to
  // surround the dispatch site, while a rejection from an un-awaited call
  // escaped as an unhandled rejection. `dispatchHook` now handles both shapes
  // identically, and the widened type says so instead of leaving it to the far
  // side of the slot.
  private episodeCompleteCallback: ((info: EpisodeCompleteInfo) => void | Promise<void>) | null =
    null
  private mergeCompleteCallback:
    | ((info: {
        animeName: string
        animeId: number
        episodeInt: string
        episodeLabel: string
        /**
         * The merged `.mkv`, as a path relative to the download dir — it
         * already carries the anime directory, because it derives from
         * `group.video.filename` (itself `path.join(animeDirName, …)`). Lets a
         * handler move exactly the file this merge produced instead of matching
         * the whole episode, which is wider than one file even now that it is
         * author-scoped, and back then swept sibling translations (#414, #416).
         */
        mkvFilename: string
      }) => void | Promise<void>)
    | null = null
  private queueCompleteCallback: (() => void | Promise<void>) | null = null
  private videoDownloadedCallback:
    | ((filePath: string, item: DownloadItem) => void | Promise<void>)
    | null = null
  private merging = false
  private activeFfmpegCmd: ReturnType<typeof Ffmpeg> | null = null
  private activeMergeTranslationId: number | null = null
  private mergeCancelled = false
  // A merge trigger that arrived while a cycle was running (#410). The cycle
  // drains it with a follow-up pass instead of dropping it.
  private mergeRequested = false
  // Translations cancelled one-by-one during the current merge cycle. Separate
  // from `mergeCancelled` on purpose: the global flag ends the whole cycle,
  // this set only skips its own translations, so cancelling one episode's
  // merge cannot drop another episode's requested rerun.
  private cancelledMerges = new Set<number>()
  private queueFilePath: string
  private persistScheduled = false
  private isFileLocked: (absPath: string) => boolean = () => false
  // Merge hold (#516): while a player view is open no new merge starts. A pass
  // that reaches an eligible group under the hold records `heldRequest` and
  // ends — separate from `mergeRequested`, which would re-enter the cycle at
  // once and spin — and `resumeHeldMerges()` takes it on the release edge.
  private isMergeHeld: () => boolean = () => false
  private heldRequest = false
  // Offline (#567): the pump starts nothing while this is true.
  private isOffline: () => boolean = () => false
  // Set by `destroy()` (quit). Every merge path checks it so nothing starts,
  // persists or completes once the queue has been written for the last time.
  private destroyed = false
  private activeMergeOutputPath: string | null = null
  private ffmpegDriver: FfmpegDriver = DEFAULT_FFMPEG_DRIVER

  constructor(
    downloadDir: string,
    api: SmotretApi,
    userDataPath: string,
    getSpeedLimit: () => number = () => 0,
    getConcurrentLimit: () => number = () => 2
  ) {
    this.downloadDir = downloadDir
    this.api = api
    this.getSpeedLimit = getSpeedLimit
    this.getConcurrentLimit = getConcurrentLimit
    this.queueFilePath = path.join(userDataPath, 'queue.json')
    this.progressTimer = setInterval(() => this.broadcastProgress(), PROGRESS_INTERVAL_MS)
  }

  private persistQueue(): void {
    const activeItems = this.queue.filter((i) => i.status !== 'cancelled')
    if (activeItems.length === 0) {
      try {
        fs.unlinkSync(this.queueFilePath)
      } catch {
        /* ignore */
      }
      return
    }
    const data = {
      queue: activeItems.map((item) => ({ ...item, speed: 0 })),
      mergeStatuses: Object.fromEntries(this.mergeStatuses)
    }
    const tmpPath = this.queueFilePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.queueFilePath)
  }

  private schedulePersist(): void {
    if (this.persistScheduled) return
    this.persistScheduled = true
    queueMicrotask(() => {
      this.persistScheduled = false
      this.persistQueue()
    })
  }

  loadQueue(): void {
    try {
      if (!fs.existsSync(this.queueFilePath)) return
      const raw = fs.readFileSync(this.queueFilePath, 'utf-8')
      const data = JSON.parse(raw)

      if (Array.isArray(data.queue)) {
        for (const item of data.queue) {
          if (item.status === 'downloading' || item.status === 'queued') {
            item.status = 'paused'
            item.speed = 0
          }
          // Defensive: older queue.json predates animeId/episodeInt on items
          if (typeof item.animeId !== 'number') item.animeId = 0
          if (typeof item.episodeInt !== 'string') item.episodeInt = ''
          this.queue.push(item)
        }
      }

      if (data.mergeStatuses && typeof data.mergeStatuses === 'object') {
        for (const [key, value] of Object.entries(data.mergeStatuses)) {
          const ms = value as { status: MergeStatus; error?: string; percent?: number }
          if (ms.status === 'merging') {
            this.dropTruncatedMerge(Number(key))
            ms.status = 'pending'
            ms.percent = undefined
          }
          this.mergeStatuses.set(Number(key), ms)
        }
      }

      console.log(`[download] Restored ${this.queue.length} items from queue.json`)
    } catch (err) {
      console.error('[download] Failed to load queue from disk:', err)
    }
  }

  /**
   * Boot-time fallback for a merge the app never saw finish (#516): a crash,
   * `kill -9`, power loss or a `destroy()` unlink that Windows still refused
   * (EBUSY) when its retry deadline ran out leaves a truncated `.mkv` at the
   * final path. Only removed while the
   * source `.mp4` still exists — a merge that finished and already unlinked its
   * source is left alone, and deleting a finished-but-unrecorded output only
   * costs a re-merge.
   */
  private dropTruncatedMerge(translationId: number): void {
    const video = this.queue.find((i) => i.translationId === translationId && i.kind === 'video')
    if (!video) return
    const mkvFilename = video.filename.replace(/\.mp4$/, '.mkv')
    if (mkvFilename === video.filename) return
    if (!fs.existsSync(path.join(this.downloadDir, video.filename))) return
    try {
      fs.unlinkSync(path.join(this.downloadDir, mkvFilename))
    } catch {
      /* best-effort: usually there is no .mkv at all */
    }
  }

  onEpisodeComplete(callback: (info: EpisodeCompleteInfo) => void | Promise<void>): void {
    this.episodeCompleteCallback = callback
  }

  onMergeComplete(
    callback: (info: {
      animeName: string
      animeId: number
      episodeInt: string
      episodeLabel: string
      /** Download-dir-relative path of the merged `.mkv` — see the field (#414). */
      mkvFilename: string
    }) => void | Promise<void>
  ): void {
    this.mergeCompleteCallback = callback
  }

  onQueueComplete(callback: () => void | Promise<void>): void {
    this.queueCompleteCallback = callback
  }

  onVideoDownloaded(
    callback: (filePath: string, item: DownloadItem) => void | Promise<void>
  ): void {
    this.videoDownloadedCallback = callback
  }

  /**
   * The one error policy for all four consumer hooks (#428).
   *
   * Before this the boundary had four different dispositions and which one a
   * failure got depended on whether the consumer happened to be declared
   * `async`: `videoDownloaded` swallowed a sync throw into a `console.warn`
   * while its own status said 'completed'; a sync throw out of the
   * merge-complete consumer would have fallen into the ffmpeg catch, which
   * `unlinkSync`es the freshly merged `.mkv` and records the merge as failed;
   * and the two timer dispatches turned a throw into an unhandled rejection or
   * an uncaught exception raised from a `setTimeout` in the main process.
   *
   * So: call the consumer inside a `try`, and if it handed back a thenable,
   * route its rejection into the same handler. Nothing is awaited — the merge
   * consumer awaits a cold-storage move, and awaiting it here would hold
   * `this.merging`, and the whole merge queue behind it, for a multi-GB
   * cross-drive copy.
   *
   * `item`, when given, is marked with `error` so the queue row stops claiming
   * a clean completion. Only `videoDownloaded` has an item to mark; the other
   * three hooks carry no queue row (see `docs/data-flow.md`).
   *
   * This method must never throw. Its `videoDownloaded` call site sits inside
   * `startDownload`'s try, whose catch re-queues with exponential backoff — an
   * escape from here would re-download a video that is already on disk.
   */
  private dispatchHook(name: string, fn: () => void | Promise<void>, item?: DownloadItem): void {
    const handle = (err: unknown): void => {
      console.warn(`[download] ${name} callback failed:`, err)
      if (!item) return
      try {
        item.error = `Post-download step failed: ${err instanceof Error ? err.message : String(err)}`
        this.schedulePersist()
      } catch (inner) {
        console.warn(`[download] could not record the ${name} failure on the item:`, inner)
      }
    }
    try {
      const result = fn()
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).catch(handle)
      }
    } catch (err) {
      handle(err)
    }
  }

  setDownloadDir(dir: string): void {
    this.downloadDir = dir
  }

  getItem(id: string): DownloadItem | null {
    return this.queue.find((i) => i.id === id) || null
  }

  /**
   * Resolve an absolute on-disk path (with or without a `.part` suffix) to its
   * queue item. Used by the anime-video:// protocol handler to serve growing
   * .part files with the expected final size.
   */
  getActiveDownloadByPath(
    absPath: string
  ): { bytesReceived: number; totalBytes: number; status: DownloadStatus } | null {
    const normalized = path.resolve(
      absPath.endsWith('.part') ? absPath.slice(0, -'.part'.length) : absPath
    )
    const item = this.queue.find(
      (i) => i.status !== 'cancelled' && path.resolve(this.downloadDir, i.filename) === normalized
    )
    if (!item) return null
    return { bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, status: item.status }
  }

  setFileLockCheck(isLocked: (absPath: string) => boolean): void {
    this.isFileLocked = isLocked
  }

  /** Merge hold (#516): true while any player view is open. */
  setMergeHoldCheck(isHeld: () => boolean): void {
    this.isMergeHeld = isHeld
  }

  setOfflineCheck(isOffline: () => boolean): void {
    this.isOffline = isOffline
  }

  /**
   * Entering offline (#567): aborts every active transfer and puts it back in
   * 'queued'. The `.part` stays, so the next start resumes with `Range`; the
   * aborted attempt's `finally` gives its slot back (#601's `slotReleased`).
   */
  suspendForOffline(): void {
    for (const item of this.queue) {
      if (item.status !== 'downloading') continue
      const controller = this.abortControllers.get(item.id)
      if (!controller) continue
      this.abortControllers.delete(item.id)
      item.status = 'queued'
      item.speed = 0
      controller.abort()
    }
    this.schedulePersist()
  }

  /** Back online (#567): the pump starts what the offline gate held. */
  resumeAfterOffline(): void {
    this.processQueue()
  }

  setFfmpegDriver(driver: FfmpegDriver): void {
    this.ffmpegDriver = driver
  }

  /** Reads and clears the held-merge request — `resumeHeldMerges()` (#516). */
  takeHeldRequest(): boolean {
    const held = this.heldRequest
    this.heldRequest = false
    return held
  }

  /**
   * Absolute `.part` path + expected size for a translation whose video is
   * still in flight (#63). Resolved from the queue item itself — during a
   * download there is no `downloadedEpisodes` metadata to reconstruct the
   * filename from. Null when the download is dead or its size is unknown.
   */
  getPartialVideoPath(
    translationId: number
  ): { partPath: string; totalBytes: number; status: DownloadStatus } | null {
    const item = this.queue.find(
      (i) =>
        i.translationId === translationId &&
        i.kind === 'video' &&
        i.status !== 'cancelled' &&
        i.status !== 'failed'
    )
    if (!item || item.totalBytes <= 0) return null
    return {
      partPath: path.join(this.downloadDir, item.filename) + '.part',
      totalBytes: item.totalBytes,
      status: item.status
    }
  }

  findCancellableItems(animeName: string, episodeLabel?: string): DownloadItem[] {
    return this.queue.filter(
      (i) =>
        i.animeName === animeName &&
        (!episodeLabel || i.episodeLabel === episodeLabel) &&
        i.status !== 'completed' &&
        i.status !== 'cancelled'
    )
  }

  getEpisodeGroups(): EpisodeGroup[] {
    const groups = new Map<number, EpisodeGroup>()

    for (const item of this.queue) {
      if (item.status === 'cancelled') continue
      if (!groups.has(item.translationId)) {
        const merge = this.mergeStatuses.get(item.translationId)
        groups.set(item.translationId, {
          translationId: item.translationId,
          animeName: item.animeName,
          animeId: item.animeId,
          episodeInt: item.episodeInt,
          episodeLabel: item.episodeLabel,
          quality: item.quality,
          translationType: item.translationType,
          author: item.author,
          video: null,
          subtitle: null,
          mergeStatus: merge?.status || 'pending',
          hasMergeEntry: merge !== undefined,
          mergePercent: merge?.percent,
          mergeError: merge?.error
        })
      }
      const group = groups.get(item.translationId)!
      if (item.kind === 'video') group.video = { ...item }
      else group.subtitle = { ...item }
    }

    return [...groups.values()]
  }

  private async fetchEmbed(translationId: number) {
    console.log(`[download] Fetching embed for translation ${translationId}`)
    const data = await this.api.getEmbed(translationId)
    console.log(
      `[download] Embed response for ${translationId}: ${data.stream?.length || 0} stream URLs, subtitles: ${!!data.subtitlesUrl}`
    )
    return data
  }

  async enqueue(requests: DownloadRequest[]): Promise<void> {
    for (const req of requests) {
      const padded = req.episodeInt.padStart(2, '0')
      const animeDirName = sanitizeFilename(req.animeName)
      const authorTag = sanitizeFilename(req.author)
      const baseFilename = sanitizeFilename(`${req.animeName} - ${padded}`) + ` [${authorTag}]`

      const videoId = `video-${req.translationId}`
      const existing = this.queue.find((i) => i.id === videoId)
      if (existing) {
        if (
          existing.status === 'completed' ||
          existing.status === 'cancelled' ||
          existing.status === 'failed'
        ) {
          // Remove stale entry so it can be re-enqueued
          this.queue = this.queue.filter((i) => i.translationId !== req.translationId)
          this.mergeStatuses.delete(req.translationId)
        } else {
          continue // still active — skip
        }
      }

      try {
        const embed = await this.fetchEmbed(req.translationId)

        const sorted = [...embed.stream].sort((a, b) => b.height - a.height)
        const best = sorted.find((d) => d.height <= req.height) || sorted[0]

        if (best && best.urls.length > 0) {
          console.log(`[download] Using stream URL for ${req.translationId} at ${best.height}p`)
          this.queue.push({
            id: videoId,
            translationId: req.translationId,
            kind: 'video',
            url: best.urls[0],
            filename: path.join(animeDirName, `${baseFilename}.mp4`),
            animeName: req.animeName,
            episodeLabel: req.episodeLabel,
            animeId: req.animeId,
            episodeInt: req.episodeInt,
            quality: best.height,
            translationType: req.translationType,
            author: req.author,
            status: 'queued',
            bytesReceived: 0,
            totalBytes: 0,
            speed: 0
          })
        }

        if (embed.subtitlesUrl) {
          const subId = `sub-${req.translationId}`
          if (!this.queue.find((i) => i.id === subId)) {
            this.queue.push({
              id: subId,
              translationId: req.translationId,
              kind: 'subtitle',
              url: this.api.getSubtitlesUrl(req.translationId),
              filename: path.join(animeDirName, `${baseFilename}.ass`),
              animeName: req.animeName,
              episodeLabel: req.episodeLabel,
              animeId: req.animeId,
              episodeInt: req.episodeInt,
              quality: best?.height || req.height,
              translationType: req.translationType,
              author: req.author,
              status: 'queued',
              bytesReceived: 0,
              totalBytes: 0,
              speed: 0
            })
          }
        }
      } catch (err) {
        this.queue.push({
          id: videoId,
          translationId: req.translationId,
          kind: 'video',
          url: this.api.getFallbackVideoUrl(req.translationId, req.height),
          filename: path.join(animeDirName, `${baseFilename}.mp4`),
          animeName: req.animeName,
          episodeLabel: req.episodeLabel,
          animeId: req.animeId,
          episodeInt: req.episodeInt,
          quality: req.height,
          translationType: req.translationType,
          author: req.author,
          status: 'queued',
          bytesReceived: 0,
          totalBytes: 0,
          speed: 0,
          error: `Embed fetch failed, using fallback URL`
        })
      }
    }

    this.persistQueue()
    this.processQueue()
  }

  pause(id: string): void {
    const item = this.queue.find((i) => i.id === id)
    if (!item) return
    if (item.status === 'downloading') {
      const controller = this.abortControllers.get(id)
      controller?.abort()
      this.abortControllers.delete(id)
      item.status = 'paused'
      item.speed = 0
      // Don't decrement activeCount here — the finally block in startDownload handles it
    } else if (item.status === 'queued') {
      item.status = 'paused'
    }
    this.schedulePersist()
  }

  resume(id: string): void {
    const item = this.queue.find((i) => i.id === id)
    if (item && (item.status === 'paused' || item.status === 'failed')) {
      item.status = 'queued'
      item.error = undefined
      this.schedulePersist()
      this.processQueue()
    }
  }

  pauseAll(): void {
    for (const item of this.queue) {
      if (item.status === 'downloading' || item.status === 'queued') {
        this.pause(item.id)
      }
    }
  }

  resumeAll(): void {
    for (const item of this.queue) {
      if (item.status === 'paused') {
        item.status = 'queued'
        item.error = undefined
      }
    }
    this.schedulePersist()
    this.processQueue()
  }

  async restart(id: string): Promise<void> {
    const item = this.queue.find((i) => i.id === id)
    if (!item || (item.status !== 'failed' && item.status !== 'paused')) return

    // Delete .part file
    const partPath = path.join(this.downloadDir, item.filename + '.part')
    try {
      fs.unlinkSync(partPath)
    } catch {
      /* ignore */
    }

    // Re-fetch embed API for fresh URLs
    try {
      const embed = await this.fetchEmbed(item.translationId)

      if (item.kind === 'video') {
        const sorted = [...embed.stream].sort((a, b) => b.height - a.height)
        const best = sorted.find((d) => d.height <= item.quality) || sorted[0]
        if (best && best.urls.length > 0) {
          item.url = best.urls[0]
          item.quality = best.height
        }
      } else if (item.kind === 'subtitle' && embed.subtitlesUrl) {
        item.url = this.api.getSubtitlesUrl(item.translationId)
      }
    } catch (err) {
      console.error(`[download] Restart: failed to re-fetch embed for ${item.translationId}`, err)
    }

    item.bytesReceived = 0
    item.totalBytes = 0
    item.speed = 0
    item.error = undefined
    item.status = 'queued'
    this.schedulePersist()
    this.processQueue()
  }

  async restartAllFailed(): Promise<void> {
    const failed = this.queue.filter((i) => i.status === 'failed')
    for (const item of failed) {
      await this.restart(item.id)
    }
    this.schedulePersist()
  }

  cancel(id: string): void {
    const item = this.queue.find((i) => i.id === id)
    if (!item) return
    if (item.status === 'downloading') {
      const controller = this.abortControllers.get(id)
      controller?.abort()
      this.abortControllers.delete(id)
      // Don't decrement activeCount here — the finally block in startDownload handles it
    }
    item.status = 'cancelled'
    item.speed = 0
    // Delete .part file and completed file
    const partPath = path.join(this.downloadDir, item.filename + '.part')
    const filePath = path.join(this.downloadDir, item.filename)
    try {
      fs.unlinkSync(partPath)
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* ignore */
    }

    // Also cancel and clean up the subtitle for this translation
    if (item.kind === 'video') {
      const subItem = this.queue.find(
        (i) => i.translationId === item.translationId && i.kind === 'subtitle'
      )
      if (subItem && subItem.status !== 'cancelled') {
        this.cancel(subItem.id)
      }
    }

    this.schedulePersist()
    this.processQueue()
  }

  cancelMerge(translationId?: number): void {
    if (translationId) {
      // Per-translation cancel joins the one-cycle cancel set and never raises
      // the global flag: raising it would break the running pass and drop a
      // rerun another episode's completion had already requested. The set is
      // only joined while a cycle is in flight — an entry added with nothing
      // merging has no cycle exit to clear it, and would skip that group for
      // every later request. The insertion sits ahead of the kill path so a
      // group that is queued rather than active is skipped too, and the kill
      // is now conditional instead of returning out of the whole method, so
      // the pending-merge status reset below always runs.
      if (this.merging) this.cancelledMerges.add(translationId)
      if (this.activeFfmpegCmd && this.activeMergeTranslationId === translationId) {
        this.activeFfmpegCmd.kill('SIGKILL')
      }
      // Also cancel pending merges by resetting their status
      this.mergeStatuses.delete(translationId)
      return
    }
    // Global cancel (the user's Cancel button) ends the whole cycle. The flag
    // goes up whenever a cycle is running, not only when a command is active,
    // so a Cancel pressed while duration is being probed or between two groups
    // is not lost.
    if (this.merging) this.mergeCancelled = true
    if (this.activeFfmpegCmd) {
      this.mergeCancelled = true
      this.activeFfmpegCmd.kill('SIGKILL')
    }
  }

  cancelByEpisode(animeName: string, episodeLabel?: string): void {
    for (const item of [...this.queue]) {
      if (item.animeName !== animeName) continue
      if (episodeLabel && item.episodeLabel !== episodeLabel) continue
      if (item.status === 'completed' || item.status === 'cancelled') continue
      // Also cancel merge if active for this translation
      const mergeStatus = this.mergeStatuses.get(item.translationId)
      if (mergeStatus?.status === 'merging') {
        this.cancelMerge(item.translationId)
      }
      this.cancel(item.id)
    }
    this.schedulePersist()
  }

  clearCompleted(): void {
    const removedTrIds = new Set<number>()
    for (const item of this.queue) {
      if (item.status === 'cancelled' || item.status === 'failed') {
        removedTrIds.add(item.translationId)
      } else if (item.status === 'completed') {
        // Clear when merge is done/failed, or when no merge has ever started
        // (ready-for-merge: user opted out, or files deleted from disk).
        // Mid-merge ('merging'), crash-recovered ('pending'), and
        // player-locked ('deferred') stay — user may want to resume them
        // with "Merge finished", and deferred files are still .part.
        const merge = this.mergeStatuses.get(item.translationId)
        if (!merge || merge.status === 'completed' || merge.status === 'failed') {
          removedTrIds.add(item.translationId)
        }
      }
    }
    this.queue = this.queue.filter((i) => !removedTrIds.has(i.translationId))
    for (const trId of removedTrIds) {
      this.mergeStatuses.delete(trId)
    }
    this.schedulePersist()
  }

  getMergeStatus(translationId: number): MergeStatus | null {
    return this.mergeStatuses.get(translationId)?.status ?? null
  }

  /**
   * Does the manager still hold work whose on-disk paths it will re-derive from
   * its cached download directory *later* (#443)? `storage:set-mode` refuses a
   * storage-mode switch while this is true.
   *
   * A download that is running at the moment of a switch is not the hazard, and
   * the issue was wrong to say so: `startDownload` resolves `filePath` and
   * `partPath` into locals once and hands those same strings to
   * `finishDownloadedFile`, so an in-flight item finishes cleanly under the root
   * it started on. What breaks is every path rebuilt from the field after the
   * move — `_mergeAll` looks for a finished video under the new root and its
   * `existsSync` miss `continue`s silently, so the episode never merges;
   * `finalizeDeferred` renames a `.part` that is not there; a `paused` or
   * `failed` item that resumes stats its `.part` under the new root, finds
   * nothing, and re-downloads from byte 0 while orphaning the old one; `cancel`
   * and `restart` unlink at the new root and miss the real files; and
   * `getActiveDownloadByPath`/`getPartialVideoPath` hand the player a path that
   * does not exist, breaking watch-while-downloading.
   *
   * So the states that matter are the ones that outlive the switch and then go
   * looking: anything not yet finished (`queued`, `downloading`, `paused`,
   * `failed` — the last two because they survive a restart through
   * `queue.json`), and any merge still owed work (`pending`, `deferred`,
   * `merging`).
   *
   * A `completed` item is *not* inert on its own: it stays root-bound until its
   * merge has actually **completed**. `getEpisodeGroups()` defaults a missing
   * `mergeStatuses` entry to `'pending'`, and `_mergeAll` skips only
   * `'completed'`, `'merging'` and `'deferred'` — so a finished video with no
   * merge entry (autoMerge off, or nothing has triggered a pass yet) and one
   * whose merge is `'failed'` are both still picked up, and both rebuild
   * `path.join(this.downloadDir, group.video.filename)`. Under a moved root that
   * `existsSync` misses and `continue`s silently, which is the first hazard this
   * guard exists to stop. Only `cancelled` items are inert unconditionally.
   *
   * One predicate rather than a per-item root (#443's decision): pinning the
   * root on each `DownloadItem` would change the persisted queue format, which
   * is a bigger change than the defect warrants.
   */
  hasRootBoundWork(): boolean {
    const pending: DownloadStatus[] = ['queued', 'downloading', 'paused', 'failed']
    if (this.queue.some((i) => pending.includes(i.status))) return true
    // A finished item is still owed a merge pass until its merge succeeds: no
    // entry (autoMerge off) and a `failed` merge are both picked up by
    // `_mergeAll`, which rebuilds the path from `this.downloadDir`.
    const unmerged = this.queue.some(
      (i) =>
        i.status === 'completed' && this.mergeStatuses.get(i.translationId)?.status !== 'completed'
    )
    if (unmerged) return true
    const owed: MergeStatus[] = ['pending', 'deferred', 'merging']
    for (const ms of this.mergeStatuses.values()) {
      if (owed.includes(ms.status)) return true
    }
    return false
  }

  /**
   * Could `root` serve every piece of root-bound work this manager holds (#451)?
   *
   * The companion to `hasRootBoundWork()` above, for the one case blocking
   * cannot recover: the drive came back at a **different** path. `#440`'s notice
   * promises "re-pick the folder to resume" and #449 honours that only for a
   * re-pick of the root already in force, so a relocated drive is a genuine root
   * move and is refused. This answers the question that makes such a move safe
   * to allow after all, and it **mutates nothing** — the `store.set` plus
   * `resyncDownloadDir()` half lives in `storage:rebind-root`, which is the only
   * position where the answer is still true when the write happens, for the
   * reason `rootMoveRefusal()` gives.
   *
   * Still shape (1), not the per-item root #443 declined: the items have no root
   * of their own to rewrite, every path comes from `this.downloadDir`, so what
   * a "re-bind" means here is moving that one root after proving the files are
   * where it will look for them. Re-binding to a root that does **not** hold
   * them would turn a clear refusal into silent data loss on the next merge or
   * cancel, which is worse than the over-blocking it replaces.
   *
   * A name match alone is not that proof, so each state is checked for the file
   * the code that resumes it actually opens:
   *
   * - `queued`/`paused`/`failed` carrying bytes: `<root>/<filename>.part` exists
   *   **and** its size is `bytesReceived`, or short of it by at most
   *   `PART_IN_FLIGHT_SLACK`. The size half is the one that matters.
   *   `startDownload` stats the `.part` and resumes with
   *   `Range: bytes=<size>-` (`src/main/download-manager.ts:1745-1750`), so a same-named `.part` left
   *   by some *other* download is appended to from its own length and nothing
   *   anywhere reports an error — the "adopts someone else's files" hazard.
   *   Equality would be the wrong test, though, because the counter legitimately
   *   runs ahead of the file: `trackProgress` is the first `pipeline` stage and
   *   counts a chunk before `throttle` and `fileStream` see it, `destroy()`
   *   calls `persistQueue()` *before* it aborts, so a quit mid-download persists
   *   the inflated number — and by the next start the drive is gone, so nothing
   *   can stat the `.part` to correct it, which is this check's own situation. A
   *   `.part` **longer** than the counter is still refused: a hard kill between
   *   the periodic persists can produce that, and it is not a gap any in-flight
   *   buffer explains.
   * - `completed` still owed a merge: the finished artifact exists. `_mergeAll`
   *   reads the video and, when the group has one, the subtitle, and skips a
   *   video it cannot find with a silent `continue`. Both items are in the queue
   *   as `completed`, so iterating items covers the pair without special-casing.
   * - a `deferred` merge: either the `.part` or the final file, because the
   *   rename is exactly what `finalizeDeferred` has not done yet and it copes
   *   with both shapes.
   * - `queued` at zero bytes: nothing has been written, so there is nothing a
   *   root move can strand. Excluded from both lists rather than refused —
   *   otherwise "queue filled, drive unplugged before the first byte" would be
   *   unrecoverable for no gain.
   * - `cancelled`, and `completed` whose merge completed: inert, the same two
   *   exclusions `hasRootBoundWork()` makes.
   *
   * `busy` is separate because a `downloading` item or a `merging` merge cannot
   * be settled by looking at files at all: both hold their paths in locals taken
   * under the old root, and `mkdirSync(…, { recursive: true })`
   * (`src/main/download-manager.ts:1741`)
   * recreates a dead mount path rather than failing, so a live write may be
   * landing somewhere that is neither the old drive nor the new one. The caller
   * refuses on it.
   *
   * Nothing here needs a separate "at least one real match" rule: `matched` and
   * `unmatched` partition everything checkable, and the caller refuses on any
   * `unmatched` entry, so an empty folder cannot validate trivially while the
   * queue holds real partial work — it comes back with every one of those files
   * in `unmatched`.
   */
  verifyRootBoundFilesUnder(root: string): RootRebindCheck {
    const matched: RootBoundFileReport[] = []
    const unmatched: RootBoundFileReport[] = []
    const busy: string[] = []

    for (const [translationId, ms] of this.mergeStatuses) {
      if (ms.status !== 'merging') continue
      const group = this.queue.find((i) => i.translationId === translationId && i.kind === 'video')
      busy.push(`merging ${group?.filename ?? `translation ${translationId}`}`)
    }

    for (const item of this.queue) {
      if (item.status === 'cancelled') continue
      if (item.status === 'downloading') {
        busy.push(`downloading ${item.filename}`)
        continue
      }

      const finalPath = path.join(root, item.filename)
      const partPath = finalPath + '.part'
      const merge = this.mergeStatuses.get(item.translationId)?.status

      if (item.status === 'completed') {
        if (merge === 'completed' || merge === 'merging') continue
        if (merge === 'deferred') {
          if (fs.existsSync(finalPath) || fs.existsSync(partPath)) {
            matched.push({ filename: item.filename, reason: null })
          } else {
            unmatched.push({
              filename: item.filename,
              reason: 'waiting to be finalized, but neither the file nor its .part is there'
            })
          }
          continue
        }
        if (fs.existsSync(finalPath)) {
          matched.push({ filename: item.filename, reason: null })
        } else {
          unmatched.push({
            filename: item.filename,
            reason: 'waiting to be merged, but the finished file is not there'
          })
        }
        continue
      }

      // 'queued' | 'paused' | 'failed'. `resumeAll()` turns `paused` into
      // `queued` and keeps `bytesReceived`, so the status alone does not say
      // whether a transfer has started — only the byte count does.
      if (item.bytesReceived <= 0) continue
      let size: number | null = null
      try {
        size = fs.statSync(partPath).size
      } catch {
        /* no .part under this root */
      }
      if (size === null) {
        unmatched.push({
          filename: item.filename,
          reason: `partly downloaded, but its .part file is not there`
        })
      } else if (size > item.bytesReceived || item.bytesReceived - size > PART_IN_FLIGHT_SLACK) {
        unmatched.push({
          filename: item.filename,
          reason: `its .part file is ${size} bytes, but ${item.bytesReceived} were downloaded — this looks like a different file`
        })
      } else {
        matched.push({ filename: item.filename, reason: null })
      }
    }

    return { matched, unmatched, busy }
  }

  /**
   * Finish episodes whose finalize (.part → final rename, then merge) was
   * deferred because the player held the file (#63). Renames what is no
   * longer locked and flips its status to 'pending'; returns the
   * translationIds that became ready so the caller can run the normal
   * episode-complete tail (auto-merge, cold move, skip analysis).
   */
  finalizeDeferred(): number[] {
    const ready: number[] = []
    for (const [translationId, ms] of this.mergeStatuses) {
      if (ms.status !== 'deferred') continue
      const video = this.queue.find(
        (i) => i.translationId === translationId && i.kind === 'video' && i.status === 'completed'
      )
      if (!video) {
        // Video item vanished (queue cleared) — nothing left to finalize.
        this.mergeStatuses.delete(translationId)
        continue
      }
      const filePath = path.join(this.downloadDir, video.filename)
      if (this.isFileLocked(filePath)) continue
      const partPath = filePath + '.part'
      try {
        if (fs.existsSync(partPath)) fs.renameSync(partPath, filePath)
      } catch (err) {
        console.error(`[download] Deferred rename failed: ${video.filename}`, err)
        continue
      }
      this.mergeStatuses.set(translationId, { status: 'pending' })
      ready.push(translationId)
    }
    if (ready.length > 0) this.schedulePersist()
    return ready
  }

  async mergeCompleted(
    ffmpegPath: string,
    ffprobePath: string,
    videoCodec = 'copy'
  ): Promise<void> {
    // A trigger that arrives mid-cycle used to be dropped outright, and the
    // running pass could not pick the episode up either: it iterates a
    // snapshot of the groups taken before that episode was completed (#410).
    // Record the request and let the running cycle drain it.
    if (this.destroyed) return
    if (this.merging) {
      this.mergeRequested = true
      return
    }
    this.merging = true

    try {
      let held: boolean
      do {
        // Cleared before each pass, so a request that arrives while the pass
        // runs survives into the next one. Clearing it afterwards instead
        // would lose exactly the requests this fix is about. Every pass calls
        // getEpisodeGroups() again, so a follow-up pass sees the episode that
        // completed mid-pass rather than the stale snapshot.
        this.mergeRequested = false
        held = await this._mergeAll(ffmpegPath, ffprobePath, videoCodec)
        // _mergeAll only resets mergeCancelled on entry, so after it returns
        // the flag still describes the pass that just ran. Ending the cycle on
        // it is what stops a follow-up pass from un-cancelling a global Cancel
        // and carrying on with the next group.
        //
        // A held pass ends the cycle too (#516): it breaks before any real
        // await, so re-entering on `mergeRequested` would spin main on
        // microtasks. The request it stopped at is in `heldRequest` instead.
      } while (this.mergeRequested && !this.mergeCancelled && !held && !this.destroyed)
    } finally {
      this.merging = false
      this.cancelledMerges.clear()
    }
  }

  private async _mergeAll(
    ffmpegPath: string,
    ffprobePath: string,
    videoCodec: string
  ): Promise<boolean> {
    this.mergeCancelled = false
    const groups = this.getEpisodeGroups()
    let held = false

    for (const group of groups) {
      // Only the global cancel breaks the pass; a single cancelled translation
      // must not abandon the groups behind it.
      if (this.mergeCancelled || this.destroyed) break
      // Read from the live set, not from the snapshot: group.mergeStatus was
      // frozen when the pass started, so a cancel that lands mid-pass is
      // invisible there and this pass would merge the group just cancelled.
      if (this.cancelledMerges.has(group.translationId)) continue
      if (!group.video || group.video.status !== 'completed') continue
      if (group.mergeStatus === 'completed' || group.mergeStatus === 'merging') continue
      // Deferred episodes still live as .part under a player lock — never
      // hand them to ffmpeg; finalizeDeferred() re-queues them as 'pending'.
      if (group.mergeStatus === 'deferred') continue

      const videoPath = path.join(this.downloadDir, group.video.filename)
      if (!fs.existsSync(videoPath)) continue

      // A player that grabbed the file between finalize and this merge pass
      // holds it open (merging would unlink it out from under the <video>).
      // Defer again — the lock's onRelease hook re-runs finalizeDeferred().
      if (this.isFileLocked(videoPath)) {
        this.mergeStatuses.set(group.translationId, { status: 'deferred' })
        this.schedulePersist()
        continue
      }

      // A player view is open (#516): start nothing new. The group stays
      // 'pending', so its source .mp4 keeps serving `find-local-file`.
      if (this.isMergeHeld()) {
        this.heldRequest = true
        held = true
        break
      }

      const hasSubtitle = group.subtitle && group.subtitle.status === 'completed'
      const subtitlePath = hasSubtitle
        ? path.join(this.downloadDir, group.subtitle!.filename)
        : null

      const mkvFilename = group.video.filename.replace(/\.mp4$/, '.mkv')
      const mkvPath = path.join(this.downloadDir, mkvFilename)

      this.mergeStatuses.set(group.translationId, { status: 'merging' })
      // On disk before ffmpeg spawns (#516): the boot fallback in `loadQueue`
      // only runs for a persisted 'merging'.
      this.schedulePersist()
      this.activeMergeTranslationId = group.translationId

      const subMeta = hasSubtitle
        ? {
            language: subtitleLanguage(group.translationType),
            title: group.author || 'Subtitles'
          }
        : undefined

      // Gates the merge-complete dispatch below the try (#428). A plain
      // fall-through after the catch would fire the hook for a failed or
      // cancelled merge as well, so the success path has to say so explicitly.
      let merged = false

      try {
        const outcome = await this.runFfmpeg({
          ffmpegPath,
          ffprobePath,
          videoPath,
          subtitlePath,
          outputPath: mkvPath,
          codec: videoCodec,
          subMeta,
          onPercent: (pct) => {
            this.mergeStatuses.set(group.translationId, { status: 'merging', percent: pct })
          }
        })
        // The player opened while the duration was probed (#516): nothing was
        // spawned, so there is no output to unlink and nothing failed. Put the
        // group back the way the gate above would have left it.
        if (outcome === 'held') {
          this.mergeStatuses.set(group.translationId, { status: 'pending' })
          this.schedulePersist()
          this.activeMergeTranslationId = null
          this.heldRequest = true
          held = true
          break
        }
        this.mergeStatuses.set(group.translationId, { status: 'completed' })
        this.schedulePersist()
        console.log(`[merge] Completed: ${mkvFilename}`)
        // Delete source files after successful merge
        try {
          fs.unlinkSync(videoPath)
        } catch {
          /* ignore */
        }
        if (subtitlePath) {
          try {
            fs.unlinkSync(subtitlePath)
          } catch {
            /* ignore */
          }
        }
        // The last statement of the success path, so the dispatch below the try
        // still lands after the unlinks (#414/#431).
        merged = true
      } catch (err) {
        // Clean up partial output file
        try {
          fs.unlinkSync(mkvPath)
        } catch {
          /* ignore */
        }
        // Quit (#516): `destroy()` already wrote queue.json with this group
        // 'merging' and killed ffmpeg. Recording 'failed' and persisting would
        // overwrite that write — the episode would boot as failed instead of
        // reaching the boot fallback — and carrying on would start the next
        // group during quit.
        if (this.destroyed) {
          console.log(`[merge] Stopped by quit: ${mkvFilename}`)
          break
        }
        // The cancel set counts as a cancel here as much as the global flag
        // does. A per-translation cancel kills ffmpeg without raising the
        // global flag, so without this check the rejection would be recorded
        // as a 'failed' merge — and 'failed' is eligible again on the next
        // pass, which would re-merge exactly what the user cancelled.
        if (this.mergeCancelled || this.cancelledMerges.has(group.translationId)) {
          this.mergeStatuses.delete(group.translationId)
          console.log(`[merge] Cancelled: ${mkvFilename}`)
        } else {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          this.mergeStatuses.set(group.translationId, { status: 'failed', error: msg })
          this.schedulePersist()
          console.error(`[merge] Failed: ${mkvFilename} - ${msg}`)
        }
      }

      // Three things are load-bearing about where this sits.
      //
      // BELOW THE UNLINKS (#414, #431): the handler's cold move snapshots the
      // hot directory, so firing above them let the move relocate a source the
      // merge was about to delete and then die on one it had already deleted.
      // `merged` is set as the success path's last statement, after both
      // unlinks, so moving the dispatch out of the try did not move it above
      // them.
      //
      // OUTSIDE THE TRY (#428): the catch `unlinkSync`es `mkvPath` and records
      // the merge as 'failed'. A consumer that threw synchronously — which the
      // widened slot type allows, and which the extracted handler in
      // `lib/episode-completion.ts` is one `async` keyword away from — would
      // otherwise delete a successfully merged file and blame ffmpeg for it.
      // `dispatchHook` already absorbs both throw shapes, which makes that
      // unreachable; out here it is structurally impossible instead of merely
      // currently-false, so a later edit that hoists the payload out of the
      // arrow or adds a statement before the call cannot re-arm it. A consumer
      // bug must never be reportable as a merge failure.
      //
      // GATED ON `merged`, not a fall-through: the catch handles a failed merge
      // and a cancelled one (global flag or `cancelledMerges`), and neither may
      // fire a completion hook.
      //
      // Still fire-and-forget — awaiting it would hold `this.merging`, and the
      // whole merge queue behind it, for a multi-GB cross-drive copy that the
      // between-groups `mergeCancelled` check cannot interrupt.
      if (merged && this.mergeCompleteCallback) {
        const callback = this.mergeCompleteCallback
        this.dispatchHook('mergeComplete', () =>
          callback({
            animeName: group.animeName,
            animeId: group.animeId,
            episodeInt: group.episodeInt,
            episodeLabel: group.episodeLabel,
            mkvFilename
          })
        )
      }
    }
    this.activeMergeTranslationId = null
    return held
  }

  private async runFfmpeg(opts: RunFfmpegOptions): Promise<RunFfmpegOutcome> {
    const { ffmpegPath, ffprobePath, videoPath, outputPath, subMeta, onPercent } = opts
    const subtitlePath = opts.subtitlePath ?? null
    const videoCodec = opts.codec ?? 'copy'
    const driver = this.ffmpegDriver
    const totalDuration = await driver.probeDuration(ffmpegPath, ffprobePath, videoPath)
    console.log(`[merge] Probed duration: ${totalDuration}s for ${videoPath}`)
    // Re-checked after the probe (#516): the caller's gate ran before it, and
    // the player can open or the app quit while ffprobe runs.
    if (this.destroyed) throw new Error('destroyed')
    if (this.isMergeHeld()) return 'held'

    return new Promise((resolve, reject) => {
      Ffmpeg.setFfmpegPath(ffmpegPath)

      let cmd = driver
        .createCommand(videoPath)
        .outputOptions('-y')
        .videoCodec(videoCodec)
        .audioCodec('copy')

      if (subtitlePath && fs.existsSync(subtitlePath)) {
        cmd = cmd
          .input(subtitlePath)
          .outputOptions(['-map', '0:v', '-map', '0:a', '-map', '1:s'])
          .outputOptions('-c:s', 'ass')
          .outputOptions('-disposition:s:0', 'default')
        if (subMeta) {
          cmd = cmd
            .outputOptions('-metadata:s:s:0', `language=${subMeta.language}`)
            .outputOptions('-metadata:s:s:0', `title=${subMeta.title}`)
        }
      }

      console.log(`[merge] Running ffmpeg: ${videoPath} -> ${outputPath} (codec: ${videoCodec})`)

      cmd
        .output(outputPath)
        .on('start', () => {
          // fluent-ffmpeg assigns `ffmpegProc` and emits 'start' from the same
          // spawn callback, so the PID is here — and not before, which is why a
          // `kill()` from `destroy()` in the window after `run()` was a no-op
          // and has to be repeated now.
          const pid = (cmd as unknown as { ffmpegProc?: { pid?: number } }).ffmpegProc?.pid
          if (this.destroyed) {
            cmd.kill('SIGKILL')
            return
          }
          if (pid === undefined) return
          // Merges are background work (#516). Set once and never raised
          // back: an unprivileged process cannot raise a child's priority on
          // Linux or macOS. Windows maps PRIORITY_LOW to IDLE_PRIORITY_CLASS.
          try {
            driver.setPriority(pid, os.constants.priority.PRIORITY_LOW)
          } catch (err) {
            console.warn(`[merge] Could not lower ffmpeg priority (pid ${pid}):`, err)
          }
        })
        .on('progress', (progress) => {
          let pct = progress.percent ?? 0
          // fluent-ffmpeg percent is often NaN/0; calculate from timemark
          if ((!pct || isNaN(pct)) && totalDuration > 0 && progress.timemark) {
            const parts = progress.timemark.split(':').map(Number)
            const currentSec = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)
            pct = (currentSec / totalDuration) * 100
          }
          onPercent?.(Math.min(100, Math.round(pct)))
        })
        .on('end', () => {
          this.activeFfmpegCmd = null
          this.activeMergeTranslationId = null
          this.activeMergeOutputPath = null
          // ffmpeg can exit 0 just before `destroy()` and have 'end' arrive
          // after it, once stderr closes. `destroy()` has then unlinked this
          // finished output, so resolving would let the caller unlink the
          // sources as well and record a merge with no file on disk (#516).
          if (this.destroyed) reject(new Error('destroyed'))
          else resolve('done')
        })
        .on('error', (err) => {
          this.activeFfmpegCmd = null
          this.activeMergeTranslationId = null
          this.activeMergeOutputPath = null
          reject(err)
        })

      this.activeFfmpegCmd = cmd
      this.activeMergeOutputPath = outputPath
      cmd.run()
    })
  }

  async scanAndMerge(
    ffmpegPath: string,
    ffprobePath: string,
    videoCodec = 'copy',
    onProgress?: (current: number, total: number, file: string, percent: number) => void,
    extraDirs?: string[]
  ): Promise<{ merged: number; failed: string[] }> {
    // Queuing a scan behind a running pass buys nothing (it walks the
    // directories and drives its own progress reporting), but reporting
    // "0 merged, no errors" made the manual button look like a silent no-op.
    // Same IPC return shape, so nothing downstream changes.
    if (this.destroyed) return { merged: 0, failed: [] }
    if (this.merging) return { merged: 0, failed: ['A merge is already running'] }
    this.merging = true
    // Only _mergeAll resets this on entry, so a global Cancel from an earlier
    // cycle would otherwise still be up and make the drain below skip.
    this.mergeCancelled = false

    const result = { merged: 0, failed: [] as string[] }

    try {
      const scanDirs = [this.downloadDir, ...(extraDirs || [])].filter((d) => fs.existsSync(d))

      // Collect all mp4 files that have no matching mkv
      const toMerge: {
        videoPath: string
        subtitlePath: string | null
        outputPath: string
        label: string
      }[] = []

      for (const scanDir of scanDirs) {
        const animeDirs = fs
          .readdirSync(scanDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)

        for (const dir of animeDirs) {
          const dirPath = path.join(scanDir, dir)
          const files = fs.readdirSync(dirPath)

          const mp4Files = files.filter((f) => f.endsWith('.mp4'))
          for (const mp4 of mp4Files) {
            const base = mp4.replace(/\.mp4$/, '')
            const mkvPath = path.join(dirPath, `${base}.mkv`)
            if (fs.existsSync(mkvPath)) continue // already merged

            const videoPath = path.join(dirPath, mp4)
            const assFile = `${base}.ass`
            const subtitlePath = files.includes(assFile) ? path.join(dirPath, assFile) : null
            toMerge.push({ videoPath, subtitlePath, outputPath: mkvPath, label: `${dir}/${mp4}` })
          }
        }
      }

      console.log(`[scan-merge] Found ${toMerge.length} files to merge`)

      for (let i = 0; i < toMerge.length; i++) {
        if (this.destroyed) break
        // Merge hold (#516). Reported in `failed` so a stopped scan never looks
        // like a silent success; the resumed pass only covers queue groups.
        if (this.isMergeHeld()) {
          this.heldRequest = true
          result.failed.push(heldScanMessage(toMerge.length - i))
          break
        }
        const item = toMerge[i]
        onProgress?.(i + 1, toMerge.length, item.label, 0)

        try {
          const outcome = await this.runFfmpeg({
            ffmpegPath,
            ffprobePath,
            videoPath: item.videoPath,
            subtitlePath: item.subtitlePath,
            outputPath: item.outputPath,
            codec: videoCodec,
            onPercent: (pct) => {
              onProgress?.(i + 1, toMerge.length, item.label, pct)
            }
          })
          if (outcome === 'held') {
            this.heldRequest = true
            result.failed.push(heldScanMessage(toMerge.length - i))
            break
          }

          // Delete source files
          try {
            fs.unlinkSync(item.videoPath)
          } catch {
            /* ignore */
          }
          if (item.subtitlePath) {
            try {
              fs.unlinkSync(item.subtitlePath)
            } catch {
              /* ignore */
            }
          }

          result.merged++
          console.log(`[scan-merge] Merged: ${item.label}`)
        } catch (err) {
          // Quit (#516): `destroy()` killed this merge and unlinked its output;
          // the source stays, so the next scan picks the file up again.
          if (this.destroyed) break
          const msg = err instanceof Error ? err.message : 'Unknown error'
          result.failed.push(`${item.label}: ${msg}`)
          console.error(`[scan-merge] Failed: ${item.label} - ${msg}`)
        }
      }
    } finally {
      this.merging = false
      this.cancelledMerges.clear()
    }

    // An episode that completed while the scan was running only got as far as
    // setting mergeRequested, so drain it with a normal pass. This must stay
    // outside the finally: with `merging` still true, mergeCompleted's own
    // busy check would swallow the request and the scan case would keep the
    // bug while the direct case's test still passed. Skipped after a global
    // Cancel — the scan loop never checks that flag itself (pre-existing, out
    // of scope), but the drain must not restart merging the user cancelled,
    // which a pass would do because _mergeAll clears the flag on entry.
    if (this.mergeRequested && !this.mergeCancelled && !this.destroyed) {
      await this.mergeCompleted(ffmpegPath, ffprobePath, videoCodec)
    }

    return result
  }

  private processQueue(): void {
    if (this.isOffline()) return
    while (this.activeCount < this.getConcurrentLimit()) {
      // Subtitles first: they are tiny and watching-while-downloading (#63)
      // needs the .ass on disk before the video is anywhere near done.
      const next =
        this.queue.find((i) => i.status === 'queued' && i.kind === 'subtitle') ||
        this.queue.find((i) => i.status === 'queued')
      if (!next) break
      this.startDownload(next)
    }
  }

  private async startDownload(item: DownloadItem, retryCount = 0, attemptCount = 0): Promise<void> {
    item.status = 'downloading'
    item.error = undefined
    this.activeCount++

    const controller = new AbortController()
    this.abortControllers.set(item.id, controller)

    const filePath = path.join(this.downloadDir, item.filename)
    const partPath = filePath + '.part'

    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    const headers: Record<string, string> = { 'User-Agent': USER_AGENT }

    let existingBytes = 0
    try {
      const stat = fs.statSync(partPath)
      existingBytes = stat.size
      if (existingBytes > 0) {
        headers['Range'] = `bytes=${existingBytes}-`
      }
    } catch {
      /* file doesn't exist yet */
    }

    let fileStream: fs.WriteStream | undefined
    let slotReleased = false
    try {
      console.log(`[download] Starting: ${item.filename} -> ${item.url.substring(0, 120)}...`)
      const response = await fetchWithTimeout(item.url, {
        headers,
        signal: controller.signal,
        redirect: 'follow',
        connectMs: DOWNLOAD_CONNECT_MS,
        idleMs: DOWNLOAD_IDLE_MS
      })

      console.log(
        `[download] Response: ${response.status} ${response.statusText} for ${item.filename}`
      )

      // Range not satisfiable — .part file is stale, delete and retry from zero
      if (response.status === 416) {
        console.log(`[download] Got 416, deleting .part and retrying from zero: ${item.filename}`)
        try {
          fs.unlinkSync(partPath)
        } catch {
          /* ignore */
        }
        this.abortControllers.delete(item.id)
        slotReleased = true
        this.activeCount--
        item.status = 'queued'
        item.bytesReceived = 0
        item.totalBytes = 0
        setTimeout(() => this.processQueue(), 500)
        return
      }

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }

      // A 200 (or 206) whose body is a document rather than video (#444).
      // Checked HERE — above the progress bookkeeping and above
      // `createWriteStream` — so nothing is written to the `.part` and nothing
      // on the item is mutated: the row keeps the counters it had and the file
      // on disk is untouched. A pre-existing `.part` from an earlier partial
      // transfer is deliberately LEFT in place, consistent with every other
      // failure out of this catch: deleting it here would throw away resumable
      // bytes over a response that never reached the disk. Note that the
      // message below points at Restart, which unlinks the `.part` as its
      // first act — the two are not aligned, and that is the trade. Keeping
      // the bytes leaves a Resume possible against a re-resolved URL; Restart
      // spends them to get a URL that works at all, which is the only recovery
      // when the link itself is dead, since `resume()` re-fetches the same one
      // forever.
      //
      // Video items only. A subtitle legitimately arrives as `text/plain` or
      // `text/vtt`, so a document denylist applied to one would be a pure
      // false-positive generator. Both status paths are gated, because a 206
      // carrying an HTML body is the same wrong answer in a Range reply — and a
      // legitimate resume answers with a video type or none, neither of which
      // this rule touches.
      if (item.kind === 'video') {
        const contentType = response.headers.get('content-type')
        if (isNonVideoContentType(contentType)) {
          // Release the connection: nothing downstream will read this body.
          await response.body?.cancel().catch(() => {})
          // Three causes, none of them asserted: a captive portal on hotel or
          // airport WiFi is an ordinary producer of `text/html` on a video URL,
          // and naming only an expired link would make the row confidently
          // wrong there. Kept short — the row renders it unclamped, so it wraps.
          throw new NonRetryableDownloadError(
            `Server sent ${mimeTypeOf(contentType)} instead of video — expired link, ` +
              `signed-out session, or a network portal. Restart re-resolves it.`
          )
        }
      }

      if (response.status === 206) {
        item.bytesReceived = existingBytes
        const contentRange = response.headers.get('content-range')
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/)
          if (match) item.totalBytes = parseInt(match[1])
        }
      } else {
        item.bytesReceived = 0
        existingBytes = 0
        const contentLength = response.headers.get('content-length')
        item.totalBytes = contentLength ? parseInt(contentLength) : 0
      }

      if (!response.body) throw new Error('No response body')

      const fileFlags = existingBytes > 0 && response.status === 206 ? 'a' : 'w'
      fileStream = fs.createWriteStream(partPath, { flags: fileFlags })

      let lastTime = Date.now()
      let lastBytes = item.bytesReceived

      const trackProgress = new (await import('stream')).Transform({
        transform(chunk: Buffer, _encoding, callback) {
          item.bytesReceived += chunk.length
          const now = Date.now()
          const elapsed = (now - lastTime) / 1000
          if (elapsed >= 0.5) {
            item.speed = (item.bytesReceived - lastBytes) / elapsed
            lastBytes = item.bytesReceived
            lastTime = now
          }
          callback(null, chunk)
        }
      })

      const getSpeedLimit = this.getSpeedLimit
      const getActiveCount = (): number => this.activeCount
      let throttleTokens = 0
      let throttleLastTime = Date.now()

      const throttle = new (await import('stream')).Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const limit = getSpeedLimit()
          if (limit <= 0) {
            callback(null, chunk)
            return
          }

          const perDownload = limit / Math.max(1, getActiveCount())
          const now = Date.now()
          const elapsed = (now - throttleLastTime) / 1000
          throttleTokens += elapsed * perDownload
          if (throttleTokens > perDownload) throttleTokens = perDownload
          throttleLastTime = now

          if (chunk.length <= throttleTokens) {
            throttleTokens -= chunk.length
            callback(null, chunk)
          } else {
            const delay = ((chunk.length - throttleTokens) / perDownload) * 1000
            throttleTokens = 0
            setTimeout(() => {
              throttleLastTime = Date.now()
              callback(null, chunk)
            }, delay)
          }
        }
      })

      const readable = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
      await pipeline(readable, trackProgress, throttle, fileStream)

      this.finishDownloadedFile(item, filePath, partPath)
      item.status = 'completed'
      item.speed = 0
      this.schedulePersist()

      if (item.kind === 'video' && this.videoDownloadedCallback) {
        // `item` is passed so a failed metadata write marks the row (#428).
        // Status and persist above already said 'completed', so without the
        // mark the queue reports a clean download for a video whose
        // `downloadedEpisodes` entry is missing — and nothing in the tree can
        // reconstruct that entry, because the file scanner is pure filesystem
        // and no filename carries a translation id.
        const callback = this.videoDownloadedCallback
        this.dispatchHook('videoDownloaded', () => callback(filePath, item), item)
      }

      this.checkEpisodeComplete(item.translationId)
    } catch (err: unknown) {
      if (this.abortControllers.get(item.id) === controller) this.abortControllers.delete(item.id)

      if (err instanceof Error && err.name === 'AbortError') {
        return
      }

      // Both the progress measurement below and the next attempt's `Range`
      // stat read the `.part` size, so the previous fd's last write must have
      // landed first (#597).
      if (fileStream) await this.waitForPartClose(fileStream)
      // A pause, cancel, resume or restart reached the item while the stream
      // was closing: a new attempt may own it now, so this one only gives
      // back its own slot and schedules nothing.
      if (
        this.abortControllers.get(item.id) !== undefined ||
        (item.status as DownloadItem['status']) !== 'downloading'
      ) {
        slotReleased = true
        this.activeCount--
        this.processQueue()
        return
      }

      // A failure that arrives while offline (#567) is the offline switch, not
      // the transfer: back to 'queued' without spending a rung of the ladder.
      if (this.isOffline() && isNetworkError(err)) {
        item.status = 'queued'
        item.speed = 0
        slotReleased = true
        this.activeCount--
        return
      }

      // A deterministic rejection (#444) skips the retry ladder: the same URL
      // would answer with the same wrong body three more times, and the user
      // would wait ~7 s for a verdict the first response already gave.
      const attempts = attemptCount + 1
      if (!(err instanceof NonRetryableDownloadError) && attempts < RETRY_ATTEMPT_LIMIT) {
        // Measured on disk, never from `item.bytesReceived`, which counts
        // bytes `throttle` and `fileStream` never wrote (PART_IN_FLIGHT_SLACK).
        // `existingBytes` is this attempt's baseline: 0 after a 200.
        const progress = partSize(partPath) - existingBytes
        if (progress >= PROGRESS_RETRY_MIN_BYTES) {
          item.status = 'queued'
          slotReleased = true
          this.activeCount--
          setTimeout(
            () => this.startFromRetryTimer(item, retryCount, attempts),
            PROGRESS_RETRY_DELAY_MS
          )
          return
        }
        if (retryCount < RETRY_LIMIT) {
          item.status = 'queued'
          slotReleased = true
          this.activeCount--
          const delay = Math.pow(2, retryCount) * 1000
          setTimeout(() => this.startFromRetryTimer(item, retryCount + 1, attempts), delay)
          return
        }
      }

      item.status = 'failed'
      item.error = err instanceof Error ? err.message : 'Unknown error'
      item.speed = 0
      this.schedulePersist()
    } finally {
      // Whether the slot is released depends on what this attempt did, never
      // on the status: a pause + resume can leave the item 'queued' before
      // the aborted attempt's catch runs (#597 review).
      if (!slotReleased) {
        if (this.abortControllers.get(item.id) === controller) this.abortControllers.delete(item.id)
        this.activeCount--
        this.processQueue()
      }
    }
  }

  /**
   * The retry ladder's timer bypasses the pump, so it re-checks the pump's
   * gates (#567): offline leaves the item 'queued' for the pump, and an item
   * the pump already started — or that was paused or cancelled meanwhile — is
   * no longer this timer's to start.
   */
  private startFromRetryTimer(item: DownloadItem, retryCount: number, attemptCount: number): void {
    if (item.status !== 'queued' || this.isOffline()) return
    void this.startDownload(item, retryCount, attemptCount)
  }

  /**
   * Resolves once the `.part` write stream's fd is closed (#597). On Node 21
   * `pipeline()` rejects while the destroyed `fs.WriteStream` still has a
   * write in flight, and that write lands afterwards — so a `.part` stat taken
   * before `'close'` can be short, and a `Range` built from it re-requests
   * bytes the file already holds. Node 22 and Electron 41's Node 24 wait for
   * the `'close'` inside `pipeline()`; this does not rely on that.
   */
  private waitForPartClose(stream: fs.WriteStream): Promise<void> {
    if (!stream.destroyed) stream.destroy()
    if (stream.closed) return Promise.resolve()
    return new Promise((resolve) => stream.once('close', () => resolve()))
  }

  /**
   * Applies a finished transfer to disk. Normally renames `.part` → final,
   * but while the built-in player is reading the file (#63) the rename would
   * EPERM on Windows and 404 the player's anime-video:// URL everywhere —
   * so the .part stays put and the episode is marked 'deferred';
   * finalizeDeferred() renames + merges once the player lets go.
   */
  private finishDownloadedFile(item: DownloadItem, filePath: string, partPath: string): void {
    if (item.kind === 'video' && this.isFileLocked(filePath)) {
      this.mergeStatuses.set(item.translationId, { status: 'deferred' })
      console.log(`[download] Player holds file, deferring finalize: ${item.filename}`)
    } else {
      fs.renameSync(partPath, filePath)
    }
  }

  private checkEpisodeComplete(translationId: number): void {
    const items = this.queue.filter(
      (i) => i.translationId === translationId && i.status !== 'cancelled'
    )
    const allDone = items.length > 0 && items.every((i) => i.status === 'completed')
    if (allDone) {
      // Prefer the video item rather than whichever row survived the filter
      // first (#412). Both matter: `restart()` corrects only the video item's
      // `quality` to the freshly re-resolved stream height, so a stale embed
      // makes the subtitle's copy wrong; and `hasVideo` tells the
      // consumer when the fallback fired, instead of hiding a subtitle-only
      // group behind a payload that looks like a video's.
      const video = items.find((i) => i.kind === 'video')
      const first = video ?? items[0]
      if (this.episodeCompleteCallback) {
        const info: EpisodeCompleteInfo = {
          animeName: first.animeName,
          episodeLabel: first.episodeLabel,
          animeId: first.animeId,
          episodeInt: first.episodeInt,
          translationId: first.translationId,
          translationType: first.translationType,
          author: first.author,
          quality: first.quality,
          hasVideo: !!video
        }
        setTimeout(
          () => this.dispatchHook('episodeComplete', () => this.episodeCompleteCallback?.(info)),
          100
        )
      }
      this.checkQueueComplete()
    }
  }

  private checkQueueComplete(): void {
    if (!this.queueCompleteCallback) return
    const hasRemaining = this.queue.some((i) => i.status === 'queued' || i.status === 'downloading')
    if (!hasRemaining) {
      // Both timer dispatches go through `dispatchHook` (#428): a throw out of
      // a `setTimeout` callback has no surrounding try at all, so it used to
      // reach the main process as an uncaught exception. Neither hook carries a
      // queue item, so the disposition here is the log alone.
      setTimeout(
        () => this.dispatchHook('queueComplete', () => this.queueCompleteCallback?.()),
        200
      )
    }
  }

  private broadcastTick = 0

  private broadcastProgress(): void {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) return
    const data = this.getEpisodeGroups()
    for (const win of windows) {
      win.webContents.send(EVENT_CHANNELS.DOWNLOAD_PROGRESS, data)
    }
    // Periodic persist every 10 ticks (5s) while downloads are active
    this.broadcastTick++
    if (this.broadcastTick >= 10 && this.activeCount > 0) {
      this.broadcastTick = 0
      this.persistQueue()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.persistQueue()
    if (this.progressTimer) {
      clearInterval(this.progressTimer)
      this.progressTimer = null
    }
    for (const controller of this.abortControllers.values()) {
      controller.abort()
    }
    // Quit mid-merge (#516): no ffmpeg may outlive the app and no truncated
    // .mkv may sit at the final path. After the persist above, so the queue
    // keeps this group 'merging' for the boot fallback; the kill's rejection
    // takes the `destroyed` branches, which persist nothing.
    if (this.activeFfmpegCmd) {
      try {
        this.activeFfmpegCmd.kill('SIGKILL')
      } catch (err) {
        console.warn('[merge] Could not kill ffmpeg on quit:', err)
      }
      if (this.activeMergeOutputPath) {
        unlinkKilledOutput(this.activeMergeOutputPath, this.ffmpegDriver.unlinkSync)
      }
    }
  }
}
