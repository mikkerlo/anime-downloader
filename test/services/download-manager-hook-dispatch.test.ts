// The two timer-dispatched consumer hooks, driven with consumers that fail
// (#428).
//
// `episodeComplete` and `queueComplete` both fire out of a `setTimeout` (100 ms
// and 200 ms), which means there is no surrounding `try` anywhere: before this
// issue a rejection from the `async` episode-complete consumer floated off as
// an unhandled rejection, and a *synchronous* throw from the queue-complete
// consumer — whose real first statement is `store.get('notificationMode')`, an
// electron-store read and therefore throwable — reached the main process as an
// uncaught exception raised from a timer callback. Nothing in the repo decided
// what happened next: `process.on('unhandledRejection' | 'uncaughtException')`
// appears nowhere under `src/main` or `src/preload`.
//
// Neither hook carries a queue item, so the policy for these two is "absorbed
// and logged, nothing escapes". That is what the cases below assert, with the
// process-level listeners the app itself does not install.

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

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
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
    status: 'completed',
    bytesReceived: 1,
    totalBytes: 1,
    speed: 0,
    ...overrides
  }
}

type Internals = {
  queue: DownloadItem[]
  mergeStatuses: Map<number, { status: MergeStatus; error?: string; percent?: number }>
  checkEpisodeComplete: (translationId: number) => void
}

/**
 * Both process-level escapes at once, for the duration of one test. Vitest
 * reports either of them as an unhandled error and fails the file, so these
 * listeners are not what makes the test red — they are what makes it say which
 * dispatch escaped rather than just that something did.
 */
function captureEscapes(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = []
  const onEscape = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', onEscape)
  process.on('uncaughtException', onEscape)
  return {
    seen,
    stop: () => {
      process.off('unhandledRejection', onEscape)
      process.off('uncaughtException', onEscape)
    }
  }
}

/** Outwaits both timers (100 ms / 200 ms) and lets a rejection settle. */
const settleHooks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

describe('DownloadManager — timer-dispatched hook failures (#428)', () => {
  let userDataDir: string
  let downloadDir: string
  let dm: DownloadManager
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-hook-ud-'))
    downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-hook-dl-'))
    dm = new DownloadManager(downloadDir, {} as never, userDataDir)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    dm.destroy()
    vi.restoreAllMocks()
    fs.rmSync(userDataDir, { recursive: true, force: true })
    fs.rmSync(downloadDir, { recursive: true, force: true })
  })

  /** One all-done group, so both gates open on `checkEpisodeComplete(1)`. */
  const seedCompleted = (): void => {
    const internals = dm as unknown as Internals
    internals.queue = [makeItem()]
    internals.mergeStatuses.clear()
  }

  const warnings = (): string =>
    warn.mock.calls.map((args) => args.map((a) => String(a)).join(' ')).join('\n')

  it('absorbs a synchronous throw from the queue-complete consumer', async () => {
    const escapes = captureEscapes()
    try {
      let called = 0
      dm.onQueueComplete(() => {
        called++
        throw new Error('notificationMode read failed')
      })
      seedCompleted()
      ;(dm as unknown as Internals).checkEpisodeComplete(1)
      await settleHooks()

      expect(called).toBe(1)
      // The reachable one before #428: an uncaught exception out of a
      // `setTimeout` in the main process, with nothing in the repo deciding
      // what happens next.
      expect(escapes.seen).toEqual([])
      expect(warnings()).toContain('queueComplete callback failed')
    } finally {
      escapes.stop()
    }
  })

  it('absorbs a rejection from the queue-complete consumer', async () => {
    const escapes = captureEscapes()
    try {
      dm.onQueueComplete(async () => {
        throw new Error('notificationMode read failed')
      })
      seedCompleted()
      ;(dm as unknown as Internals).checkEpisodeComplete(1)
      await settleHooks()

      // Same disposition for both shapes — which is the point of the issue: it
      // used to depend on whether the consumer happened to be declared `async`.
      expect(escapes.seen).toEqual([])
      expect(warnings()).toContain('queueComplete callback failed')
    } finally {
      escapes.stop()
    }
  })

  it('absorbs a synchronous throw from the episode-complete consumer', async () => {
    const escapes = captureEscapes()
    try {
      const payloads: EpisodeCompleteInfo[] = []
      dm.onEpisodeComplete((info) => {
        payloads.push(info)
        throw new Error('fileScanner.invalidate blew up')
      })
      seedCompleted()
      ;(dm as unknown as Internals).checkEpisodeComplete(1)
      await settleHooks()

      expect(payloads).toHaveLength(1)
      expect(escapes.seen).toEqual([])
      expect(warnings()).toContain('episodeComplete callback failed')
    } finally {
      escapes.stop()
    }
  })

  it('absorbs a rejection from the episode-complete consumer', async () => {
    const escapes = captureEscapes()
    try {
      // The production consumer is `async` and awaits a cold-storage move, so
      // this is its live shape.
      dm.onEpisodeComplete(async () => {
        throw new Error('moveEpisodeToColdStorage rejected')
      })
      seedCompleted()
      ;(dm as unknown as Internals).checkEpisodeComplete(1)
      await settleHooks()

      expect(escapes.seen).toEqual([])
      expect(warnings()).toContain('episodeComplete callback failed')
    } finally {
      escapes.stop()
    }
  })

  it('marks no queue row for either hook — neither one carries an item', async () => {
    const escapes = captureEscapes()
    try {
      dm.onEpisodeComplete(() => {
        throw new Error('nope')
      })
      dm.onQueueComplete(() => {
        throw new Error('nope')
      })
      seedCompleted()
      ;(dm as unknown as Internals).checkEpisodeComplete(1)
      await settleHooks()

      // Only `videoDownloaded` has a row to blame. A failure in either of these
      // two describes the whole group or the whole queue, and `item.error`
      // renders as a per-row line, so there is nothing honest to mark.
      expect((dm as unknown as Internals).queue[0].error).toBeUndefined()
      expect(escapes.seen).toEqual([])
    } finally {
      escapes.stop()
    }
  })
})
