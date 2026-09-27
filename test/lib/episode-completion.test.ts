// The four download-completion tails, driven directly (#409).
//
// Before the extraction these were inline closures inside `bootstrap()` in
// `src/main/index.ts`: held in private fields of the download manager, reachable
// from no test, and pinned only by reading `index.ts` back as source text. A
// text guard can assert that one call sits above another; it cannot assert that
// a non-`.mp4` path still persists metadata, or that `autoMerge` on with ffmpeg
// missing takes the `else`. Those are the cases below.
//
// Every test shares one ordered `calls` log rather than asserting on endpoints
// alone. The tails are sequences — invalidate, then write, then move, then
// notify, then schedule — and a refactor that keeps every call but reorders two
// of them is exactly the failure an endpoint assertion misses.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  createEpisodeCompletionHandlers,
  type EpisodeCompletionDeps,
  type EpisodeCompletionHandlers,
  type EpisodeCompletionStore
} from '../../src/main/lib/episode-completion'
import type {
  DownloadItem,
  EpisodeCompleteInfo,
  MergeStatus
} from '../../src/main/download-manager'
import type { DownloadedEpisodesMap } from '../../src/main/lib/downloaded-episodes'

interface Settings {
  autoMerge: boolean
  autoMoveToCold: boolean
  videoCodec: string
  notificationMode: string
}

interface FakeStore extends EpisodeCompletionStore {
  readonly entries: DownloadedEpisodesMap
}

type Group = { translationId: number; animeName: string; animeId: number; episodeLabel: string }

/**
 * Everything a test can steer, in one mutable bag. Every field is read through
 * a closure at call time, not captured when the handlers are built, so a test
 * may flip any of them after `makeHarness()` has already run the factory.
 */
interface Harness {
  handlers: EpisodeCompletionHandlers
  /** The ordered call log every assertion in this file is written against. */
  calls: string[]
  store: FakeStore
  settings: Settings
  /** Groups `getEpisodeGroups()` reports. */
  groups: Group[]
  /** Translation ids `finalizeDeferred()` reports. */
  readyTrIds: number[]
  mergeStatus: MergeStatus | null
  ffmpegAvailable: boolean
  ffmpegPath: string
  /** What `coldStorageService.isAdvanced()` answers. */
  coldAdvanced: boolean
}

function makeHarness(settings: Partial<Settings> = {}): Harness {
  const calls: string[] = []

  let held: DownloadedEpisodesMap = {}
  const store: FakeStore = {
    get: ((key: keyof Settings | 'downloadedEpisodes') => {
      if (key === 'downloadedEpisodes') return structuredClone(held)
      return h.settings[key]
    }) as EpisodeCompletionStore['get'],
    set: ((key: 'downloadedEpisodes', value: DownloadedEpisodesMap) => {
      calls.push(`store.set(${key})`)
      held = structuredClone(value)
    }) as EpisodeCompletionStore['set'],
    get entries() {
      return held
    }
  }

  const deps: EpisodeCompletionDeps = {
    store,
    downloadManager: {
      finalizeDeferred: () => {
        calls.push('finalizeDeferred')
        return h.readyTrIds
      },
      getEpisodeGroups: () => {
        calls.push('getEpisodeGroups')
        return h.groups
      },
      getMergeStatus: (trId) => {
        calls.push(`getMergeStatus(${trId})`)
        return h.mergeStatus
      },
      mergeCompleted: async (ffmpegPath, ffprobePath, videoCodec) => {
        calls.push(`mergeCompleted(${ffmpegPath},${ffprobePath},${videoCodec})`)
      }
    },
    fileScanner: {
      invalidate: (animeName) => calls.push(`invalidate(${animeName})`)
    },
    coldStorageService: {
      isAdvanced: () => {
        calls.push('isAdvanced')
        return h.coldAdvanced
      },
      moveEpisodeToColdStorage: async (animeName, episodeLabel) => {
        calls.push(`moveToCold(${animeName},${episodeLabel})`)
      }
    },
    skipAnalysisService: {
      scheduleAutoSkipAnalysis: (animeId, animeName) =>
        calls.push(`scheduleSkip(${animeId},${animeName})`)
    },
    mp4StatsService: {
      recordCheck: async (filePath) => {
        calls.push(`recordCheck(${path.basename(filePath)})`)
      }
    },
    // A promise, not a value: the real `ffmpegReady` is the background
    // ffmpeg-ensure task's promise, and `await`ing it is what lets a download
    // that lands before ffmpeg is ready still merge.
    ffmpegReady: Promise.resolve({
      get available() {
        return h.ffmpegAvailable
      }
    }),
    getFfmpegPath: () => h.ffmpegPath,
    getFfprobePath: () => '/bin/ffprobe',
    notify: (title, body) => calls.push(`notify(${title}|${body})`)
  }

  const h: Harness = {
    handlers: createEpisodeCompletionHandlers(deps),
    calls,
    store,
    settings: {
      autoMerge: false,
      autoMoveToCold: false,
      videoCodec: 'copy',
      notificationMode: 'off',
      ...settings
    },
    groups: [],
    readyTrIds: [],
    mergeStatus: null,
    ffmpegAvailable: true,
    ffmpegPath: '/bin/ffmpeg',
    coldAdvanced: false
  }
  return h
}

function makeInfo(overrides: Partial<EpisodeCompleteInfo> = {}): EpisodeCompleteInfo {
  return {
    animeName: 'Anime',
    episodeLabel: 'ep1',
    animeId: 100,
    episodeInt: '1',
    translationId: 7,
    translationType: 'subRu',
    author: 'Author',
    quality: 720,
    hasVideo: true,
    ...overrides
  }
}

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'video-1',
    translationId: 7,
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

const ENTRY = { translationType: 'subRu', author: 'Author', quality: 720, translationId: 7 }

describe('episode-completion — the group-complete tail', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  describe('the hasVideo gate', () => {
    it('persists the entry for a group that had a video item', async () => {
      await h.handlers.handleEpisodeComplete(makeInfo({ hasVideo: true }))
      expect(h.store.entries).toEqual({ '100:1:7': ENTRY })
    })

    it('writes nothing for a subtitle-only group, and still runs the rest of the tail', async () => {
      // `enqueue` pushes the subtitle outside the "usable stream" guard, so an
      // embed with a `subtitlesUrl` and no playable stream reaches all-done with
      // a payload copied off the subtitle. The gate must skip the write without
      // skipping the invalidate / notify / skip-analysis that follow it.
      await h.handlers.handleEpisodeComplete(makeInfo({ hasVideo: false }))
      expect(h.store.entries).toEqual({})
      expect(h.calls).toContain('invalidate(Anime)')
      expect(h.calls).toContain('scheduleSkip(100,Anime)')
    })

    it('invalidates the scan cache before the write, on both sides of the gate', async () => {
      await h.handlers.handleEpisodeComplete(makeInfo({ hasVideo: true }))
      const gated = [...h.calls]
      h.calls.length = 0
      await h.handlers.handleEpisodeComplete(makeInfo({ hasVideo: false }))

      // #409 keeps `index.ts`'s invalidate first, as agreed; the write can only
      // follow it, never precede it.
      expect(gated.indexOf('invalidate(Anime)')).toBe(0)
      expect(gated.indexOf('store.set(downloadedEpisodes)')).toBeGreaterThan(0)
      expect(h.calls.indexOf('invalidate(Anime)')).toBe(0)
      expect(h.calls).not.toContain('store.set(downloadedEpisodes)')
    })
  })

  describe("the getMergeStatus === 'deferred' early return", () => {
    it('writes the metadata and then stops, leaving merge and cold-move to the finalize pass', async () => {
      h.mergeStatus = 'deferred'
      h.settings.autoMerge = true
      h.coldAdvanced = true
      h.settings.autoMoveToCold = true

      await h.handlers.handleEpisodeComplete(makeInfo())

      // The player is watching this episode from its .part (#63): the file
      // cannot be renamed or merged yet, so nothing past the guard may run —
      // but the entry is already written, which is what keeps the ⬇ honest.
      expect(h.store.entries).toEqual({ '100:1:7': ENTRY })
      expect(h.calls).toEqual([
        'invalidate(Anime)',
        'store.set(downloadedEpisodes)',
        'getMergeStatus(7)'
      ])
    })

    it('falls through for any other merge status', async () => {
      h.mergeStatus = 'pending'
      await h.handlers.handleEpisodeComplete(makeInfo())
      expect(h.calls).toContain('scheduleSkip(100,Anime)')
    })
  })

  describe('the three-term merge condition', () => {
    it('merges when autoMerge is on, ffmpeg is available and the path resolves', async () => {
      h.settings.autoMerge = true
      h.settings.videoCodec = 'libx265'

      await h.handlers.handleEpisodeComplete(makeInfo())

      expect(h.calls).toContain('mergeCompleted(/bin/ffmpeg,/bin/ffprobe,libx265)')
      // The merge branch delegates cold-move / notify / skip analysis to the
      // merge-complete tail, so none of them may run here.
      expect(h.calls).not.toContain('scheduleSkip(100,Anime)')
      expect(h.calls.some((c) => c.startsWith('moveToCold'))).toBe(false)
      expect(h.calls.some((c) => c.startsWith('notify'))).toBe(false)
    })

    it('defaults the codec to copy when videoCodec is empty', async () => {
      h.settings.autoMerge = true
      h.settings.videoCodec = ''
      await h.handlers.handleEpisodeComplete(makeInfo())
      expect(h.calls).toContain('mergeCompleted(/bin/ffmpeg,/bin/ffprobe,copy)')
    })

    it('takes the else with autoMerge ON but ffmpeg unavailable', async () => {
      // The condition has three terms, not one. `ffmpegInfo.available` false
      // with autoMerge on lands in the same `else` as autoMerge off — the branch
      // #409 needs to reach, and the one a two-state reading of this `if` misses.
      h.settings.autoMerge = true
      h.ffmpegAvailable = false
      h.settings.notificationMode = 'each'

      await h.handlers.handleEpisodeComplete(makeInfo())

      expect(h.calls.some((c) => c.startsWith('mergeCompleted'))).toBe(false)
      expect(h.calls).toContain('notify(Download complete|Anime — ep1)')
      expect(h.calls).toContain('scheduleSkip(100,Anime)')
    })

    it('takes the else with autoMerge ON, ffmpeg available, but no resolved path', async () => {
      h.settings.autoMerge = true
      h.ffmpegPath = ''

      await h.handlers.handleEpisodeComplete(makeInfo())

      expect(h.calls.some((c) => c.startsWith('mergeCompleted'))).toBe(false)
      expect(h.calls).toContain('scheduleSkip(100,Anime)')
    })
  })

  describe('the cold-move branch', () => {
    it('moves when cold storage is advanced and autoMoveToCold is on', async () => {
      h.coldAdvanced = true
      h.settings.autoMoveToCold = true

      await h.handlers.handleEpisodeComplete(makeInfo())

      expect(h.calls).toContain('moveToCold(Anime,ep1)')
    })

    it('does not move with autoMoveToCold on but storage in simple mode', async () => {
      h.coldAdvanced = false
      h.settings.autoMoveToCold = true
      await h.handlers.handleEpisodeComplete(makeInfo())
      expect(h.calls.some((c) => c.startsWith('moveToCold'))).toBe(false)
    })

    it('does not move in advanced mode with autoMoveToCold off', async () => {
      h.coldAdvanced = true
      h.settings.autoMoveToCold = false
      await h.handlers.handleEpisodeComplete(makeInfo())
      expect(h.calls.some((c) => c.startsWith('moveToCold'))).toBe(false)
    })
  })

  describe('characterization — the whole no-merge sequence, in order', () => {
    it('runs invalidate, write, merge-status, cold move, notify, skip analysis', async () => {
      // The assertion this file exists for. Any reordering of the tail — the
      // write below the cold move, the notify before the move, the skip
      // analysis ahead of either — changes this list while leaving every
      // `toContain` above green.
      h.coldAdvanced = true
      h.settings.autoMoveToCold = true
      h.settings.notificationMode = 'each'

      await h.handlers.handleEpisodeComplete(makeInfo())

      expect(h.calls).toEqual([
        'invalidate(Anime)',
        'store.set(downloadedEpisodes)',
        'getMergeStatus(7)',
        'isAdvanced',
        'moveToCold(Anime,ep1)',
        'notify(Download complete|Anime — ep1)',
        'scheduleSkip(100,Anime)'
      ])
    })

    it('skips the notification unless notificationMode is each', async () => {
      h.settings.notificationMode = 'queue'
      await h.handlers.handleEpisodeComplete(makeInfo())
      expect(h.calls.some((c) => c.startsWith('notify'))).toBe(false)
    })

    it('schedules no skip analysis for a manual-scan item with no anime id', async () => {
      await h.handlers.handleEpisodeComplete(makeInfo({ animeId: 0 }))
      expect(h.calls.some((c) => c.startsWith('scheduleSkip'))).toBe(false)
      // …and with no anime id the entry cannot be keyed either.
      expect(h.store.entries).toEqual({})
    })
  })
})

describe('episode-completion — the merge-complete tail', () => {
  it('invalidates, moves to cold, notifies and schedules, in that order', async () => {
    const h = makeHarness({ autoMoveToCold: true, notificationMode: 'each' })
    h.coldAdvanced = true

    await h.handlers.handleMergeComplete({
      animeName: 'Anime',
      animeId: 100,
      episodeInt: '1',
      episodeLabel: 'ep1'
    })

    expect(h.calls).toEqual([
      'invalidate(Anime)',
      'isAdvanced',
      'moveToCold(Anime,ep1)',
      'notify(Merge complete|Anime — ep1)',
      'scheduleSkip(100,Anime)'
    ])
  })

  it('writes no metadata — the merge tail is not a metadata writer', async () => {
    const h = makeHarness()
    await h.handlers.handleMergeComplete({
      animeName: 'Anime',
      animeId: 100,
      episodeInt: '1',
      episodeLabel: 'ep1'
    })
    expect(h.store.entries).toEqual({})
    expect(h.calls).toEqual(['invalidate(Anime)', 'isAdvanced', 'scheduleSkip(100,Anime)'])
  })
})

describe('episode-completion — the deferred-finalize pass', () => {
  it('does nothing at all when no episode was deferred', async () => {
    const h = makeHarness()
    h.readyTrIds = []
    await h.handlers.finalizeDeferredEpisodes()
    // Notably it does not even read the groups — the early return is above it.
    expect(h.calls).toEqual(['finalizeDeferred'])
  })

  it('merges once for the whole batch when autoMerge and ffmpeg are both there', async () => {
    const h = makeHarness({ autoMerge: true })
    h.readyTrIds = [7, 8]
    h.groups = [
      { translationId: 7, animeName: 'Anime', animeId: 100, episodeLabel: 'ep1' },
      { translationId: 8, animeName: 'Anime', animeId: 100, episodeLabel: 'ep2' }
    ]

    await h.handlers.finalizeDeferredEpisodes()

    expect(h.calls).toEqual([
      'finalizeDeferred',
      'getEpisodeGroups',
      'mergeCompleted(/bin/ffmpeg,/bin/ffprobe,copy)'
    ])
  })

  it('defaults the codec to copy here too, not only in the group-complete tail', async () => {
    // This pass reads `store.get('videoCodec') || 'copy'` for itself rather than
    // sharing the group-complete tail's read, and it is the only branch in the
    // module the rest of this file leaves unmeasured.
    const h = makeHarness({ autoMerge: true, videoCodec: '' })
    h.readyTrIds = [7]
    h.groups = [{ translationId: 7, animeName: 'Anime', animeId: 100, episodeLabel: 'ep1' }]

    await h.handlers.finalizeDeferredEpisodes()

    expect(h.calls).toContain('mergeCompleted(/bin/ffmpeg,/bin/ffprobe,copy)')
  })

  it('walks the ready ids in the else branch, and never notifies', async () => {
    // Deliberately no 'each'-mode "Download complete" here: the user was
    // literally watching this episode and just closed it. `notificationMode`
    // is set to 'each' so the absence is measured, not assumed.
    const h = makeHarness({ autoMoveToCold: true, notificationMode: 'each' })
    h.coldAdvanced = true
    h.readyTrIds = [7, 8]
    h.groups = [
      { translationId: 7, animeName: 'Anime', animeId: 100, episodeLabel: 'ep1' },
      { translationId: 8, animeName: 'Other', animeId: 0, episodeLabel: 'ep2' }
    ]

    await h.handlers.finalizeDeferredEpisodes()

    expect(h.calls).toEqual([
      'finalizeDeferred',
      'getEpisodeGroups',
      'invalidate(Anime)',
      'isAdvanced',
      'moveToCold(Anime,ep1)',
      'scheduleSkip(100,Anime)',
      'invalidate(Other)',
      'isAdvanced',
      'moveToCold(Other,ep2)'
    ])
    expect(h.calls.some((c) => c.startsWith('notify'))).toBe(false)
  })

  it('skips a ready id whose group has already left the queue', async () => {
    const h = makeHarness()
    h.readyTrIds = [7, 99]
    h.groups = [{ translationId: 7, animeName: 'Anime', animeId: 100, episodeLabel: 'ep1' }]

    await h.handlers.finalizeDeferredEpisodes()

    expect(h.calls).toEqual([
      'finalizeDeferred',
      'getEpisodeGroups',
      'invalidate(Anime)',
      'isAdvanced',
      'scheduleSkip(100,Anime)'
    ])
  })
})

describe('episode-completion — the per-video tail', () => {
  it('persists a .mkv download and does NOT probe it for faststart', async () => {
    // This is the behavioural form of what used to be a source-text assertion
    // that the write sits above the `.mp4` early return (#417 review note 1).
    // Below that filter the write would silently skip every .mkv download; the
    // text guard could only say which line came first.
    const h = makeHarness()
    h.handlers.handleVideoDownloaded('/dl/Anime/Anime - 01 [Author].mkv', makeItem())

    expect(h.store.entries).toEqual({ '100:1:7': ENTRY })
    expect(h.calls.some((c) => c.startsWith('recordCheck'))).toBe(false)
  })

  it('persists a .mp4 download and probes it, write first', async () => {
    const h = makeHarness()
    h.handlers.handleVideoDownloaded('/dl/Anime/Anime - 01 [Author].mp4', makeItem())

    expect(h.store.entries).toEqual({ '100:1:7': ENTRY })
    expect(h.calls).toEqual([
      'store.set(downloadedEpisodes)',
      'recordCheck(Anime - 01 [Author].mp4)'
    ])
  })

  it('matches the extension case-insensitively', async () => {
    const h = makeHarness()
    h.handlers.handleVideoDownloaded('/dl/Anime/Anime - 01 [Author].MP4', makeItem())
    expect(h.calls).toContain('recordCheck(Anime - 01 [Author].MP4)')
  })

  it('persists nothing for an item with no anime id, and still probes', async () => {
    const h = makeHarness()
    h.handlers.handleVideoDownloaded('/dl/x.mp4', makeItem({ animeId: 0 }))
    expect(h.store.entries).toEqual({})
    expect(h.calls).toEqual(['recordCheck(x.mp4)'])
  })

  it('does not await the faststart probe', async () => {
    // `recordCheck` is fired with `void`, deliberately: it opens and reads the
    // file, and the hook runs on the download manager's success path.
    const h = makeHarness()
    const returned = h.handlers.handleVideoDownloaded('/dl/x.mp4', makeItem()) as unknown
    expect(returned).toBeUndefined()
  })
})

describe('episode-completion — the wiring left in src/main/index.ts', () => {
  const source = (): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf-8')

  it('hands every completion hook to the extracted handlers, and keeps no tail inline', () => {
    // The extraction's own guard, and the reason every behavioural test above
    // describes production rather than a museum piece: if a tail is ever pasted
    // back into a bootstrap closure, these registrations stop being one-liners.
    // `index.ts` boots Electron at module scope and cannot be imported here, so
    // reading it back as text is the only way to check the wiring.
    //
    // The single-callback-slot constraint — a second `onVideoDownloaded(...)`
    // anywhere would silently unregister this one, keeping the metadata write
    // and dropping the .mp4 probe with no error — keeps its own count guard in
    // `test/services/download-manager-episode-metadata.test.ts`, which is where
    // that consumer pair is exercised end to end.
    const text = source()
    expect(text).toContain(
      'downloadManager.onEpisodeComplete(episodeCompletion.handleEpisodeComplete)'
    )
    expect(text).toContain('downloadManager.onMergeComplete(episodeCompletion.handleMergeComplete)')
    expect(text).toContain(
      'downloadManager.onVideoDownloaded(episodeCompletion.handleVideoDownloaded)'
    )
    expect(text).toContain('createEpisodeCompletionHandlers({')
  })
})

describe('episode-completion — construction', () => {
  it('builds the four handlers and calls nothing at construction time', () => {
    const h = makeHarness()
    expect(Object.keys(h.handlers).sort()).toEqual([
      'finalizeDeferredEpisodes',
      'handleEpisodeComplete',
      'handleMergeComplete',
      'handleVideoDownloaded'
    ])
    expect(h.calls).toEqual([])
    expect(vi.isMockFunction(h.handlers.handleEpisodeComplete)).toBe(false)
  })
})
