// The download-completion tails, lifted out of `bootstrap()` in
// `src/main/index.ts` (#409).
//
// Four closures used to live inline in the bootstrap: the deferred-finalize
// pass the player-lock release and the boot crash-recovery both call, the
// group-complete hook, the merge-complete hook, and the per-video hook. Every
// one of them is a *tail* — the sequence that runs after a file has landed on
// disk: invalidate the scan cache, persist episode metadata, merge or move to
// cold, notify, schedule skip analysis.
//
// None of that was reachable from a test. `index.ts` boots Electron at module
// scope, so nothing under `test/` imports it (it is excluded from the coverage
// gate for the same reason), and a closure held in a private field of the
// download manager cannot be driven from outside. The tails were therefore
// pinned only indirectly, by reading `index.ts` back as *source text* — which
// can assert that a call sits above another call and nothing about what either
// one does.
//
// So they move here, deps-injected, and `index.ts` keeps the wiring: build the
// handlers, hand them to `playerLockService.onRelease` and to the three
// `downloadManager.on*` slots. The extraction is behaviour-preserving by
// construction — statement order inside each tail is unchanged, and the
// `notify` dep is the one seam that stays behind, because
// `showBackgroundNotification` reads `BrowserWindow.getFocusedWindow()`.
//
// Like `lib/downloaded-episodes.ts`, the store arrives by injection rather than
// through the `electron-store` singleton: `electron-store` is externalised from
// the Vitest bundle, so mocking `electron` cannot reach these reads. A test can
// only pass a fake store.

import { persistDownloadedEpisode, type DownloadedEpisodesMap } from './downloaded-episodes'
import type {
  DownloadItem,
  EpisodeCompleteInfo,
  EpisodeGroup,
  MergeStatus
} from '../download-manager'

/** The `FfmpegInfo` field the merge condition reads. */
export interface EpisodeCompletionFfmpegInfo {
  available: boolean
}

/**
 * The store keys these tails touch. `downloadedEpisodes` is here so the object
 * also satisfies `DownloadedEpisodesStore`, which `persistDownloadedEpisode`
 * takes; the other four are settings reads.
 */
export interface EpisodeCompletionStore {
  get(key: 'downloadedEpisodes'): DownloadedEpisodesMap
  get(key: 'autoMerge'): boolean
  get(key: 'autoMoveToCold'): boolean
  get(key: 'videoCodec'): string
  get(key: 'notificationMode'): string
  set(key: 'downloadedEpisodes', value: DownloadedEpisodesMap): void
}

/**
 * The `DownloadManager` methods the tails call. Narrowed to four, and
 * `getEpisodeGroups` narrowed further to the five `EpisodeGroup` fields
 * `finalizeDeferredEpisodes` actually reads — a fake then costs five fields
 * instead of fourteen. `episodeLabel` is deliberately absent: the cold-move
 * takes `episodeInt` + `author`, which is what the filenames are built from
 * (#416), and this pass sends no notification that would need the label.
 */
export interface EpisodeCompletionDownloadManager {
  finalizeDeferred: () => number[]
  getEpisodeGroups: () => Pick<
    EpisodeGroup,
    'translationId' | 'animeName' | 'animeId' | 'episodeInt' | 'author'
  >[]
  getMergeStatus: (translationId: number) => MergeStatus | null
  mergeCompleted: (ffmpegPath: string, ffprobePath: string, videoCodec?: string) => Promise<void>
}

export interface EpisodeCompletionDeps {
  store: EpisodeCompletionStore
  downloadManager: EpisodeCompletionDownloadManager
  /** `createEpisodeFileScanner`'s handle — only `invalidate` is reached here. */
  fileScanner: { invalidate: (animeName: string) => void }
  coldStorageService: {
    isAdvanced: () => boolean
    moveEpisodeToColdStorage: (
      animeName: string,
      episodeInt: string,
      author: string
    ) => Promise<void>
    moveFileToColdByRelPath: (relPath: string) => Promise<void>
  }
  skipAnalysisService: {
    scheduleAutoSkipAnalysis: (animeId: number, animeName: string) => void
  }
  mp4StatsService: {
    recordCheck: (
      filePath: string,
      context: { animeId: number; animeName: string; episodeInt: string; episodeLabel: string }
    ) => Promise<void>
  }
  /**
   * Resolved by the background ffmpeg-ensure task in `bootstrap()`. Awaited
   * rather than polled, so a download that finishes before ffmpeg is ready
   * still merges instead of silently skipping the merge.
   */
  ffmpegReady: Promise<EpisodeCompletionFfmpegInfo>
  getFfmpegPath: () => string
  getFfprobePath: () => string
  /**
   * `showBackgroundNotification` — stays in `index.ts` because it reads
   * `BrowserWindow.getFocusedWindow()` and constructs an Electron
   * `Notification`.
   */
  notify: (title: string, body: string) => void
}

export interface EpisodeCompletionHandlers {
  /**
   * Watch-while-downloading (#63): when the player releases a file, finish any
   * episode whose .part → final rename (and merge) was deferred under the lock.
   * Wired to `playerLockService.onRelease`, and run once at boot for crash
   * recovery.
   */
  finalizeDeferredEpisodes: () => Promise<void>
  /** `downloadManager.onEpisodeComplete` — the group-complete tail. */
  handleEpisodeComplete: (info: EpisodeCompleteInfo) => Promise<void>
  /** `downloadManager.onMergeComplete`. */
  handleMergeComplete: (info: {
    animeName: string
    animeId: number
    episodeInt: string
    episodeLabel: string
    mkvFilename: string
  }) => Promise<void>
  /** `downloadManager.onVideoDownloaded` — metadata write + mp4-faststart probe. */
  handleVideoDownloaded: (filePath: string, item: DownloadItem) => void
}

export function createEpisodeCompletionHandlers(
  deps: EpisodeCompletionDeps
): EpisodeCompletionHandlers {
  const {
    store,
    downloadManager,
    fileScanner,
    coldStorageService,
    skipAnalysisService,
    mp4StatsService,
    ffmpegReady,
    getFfmpegPath,
    getFfprobePath,
    notify
  } = deps

  async function finalizeDeferredEpisodes(): Promise<void> {
    const readyTrIds = downloadManager.finalizeDeferred()
    if (readyTrIds.length === 0) return
    const groups = downloadManager.getEpisodeGroups()
    const ffmpegInfo = await ffmpegReady
    const autoMerge = store.get('autoMerge')
    const ffmpegPath = getFfmpegPath()
    if (autoMerge && ffmpegInfo.available && ffmpegPath) {
      const codec = store.get('videoCodec') || 'copy'
      // The merge-complete hook handles cold-move / notify / skip analysis.
      await downloadManager.mergeCompleted(ffmpegPath, getFfprobePath(), codec)
    } else {
      // Deliberately no 'each'-mode "Download complete" notification here:
      // the user was literally watching this episode and just closed it.
      for (const trId of readyTrIds) {
        const group = groups.find((g) => g.translationId === trId)
        if (!group) continue
        fileScanner.invalidate(group.animeName)
        if (coldStorageService.isAdvanced() && store.get('autoMoveToCold')) {
          // `episodeInt` + `author`, not `episodeLabel`: the on-disk name is
          // built from `episodeInt`, and the match is author-scoped so a
          // sibling translation — possibly still mid-download — stays put
          // (#416).
          await coldStorageService.moveEpisodeToColdStorage(
            group.animeName,
            group.episodeInt,
            group.author
          )
        }
        if (group.animeId > 0)
          skipAnalysisService.scheduleAutoSkipAnalysis(group.animeId, group.animeName)
      }
    }
  }

  async function handleEpisodeComplete(info: EpisodeCompleteInfo): Promise<void> {
    const {
      animeName,
      episodeLabel,
      animeId,
      episodeInt,
      translationId,
      translationType,
      author,
      quality
    } = info
    fileScanner.invalidate(animeName)

    // Repair path for episode metadata, not the primary writer any more (#412).
    // `handleVideoDownloaded` below writes the entry as soon as the video item
    // lands; this call exists for queues persisted before that hook did, where
    // a `video: completed` + `subtitle: failed` group only reaches a write when
    // the user finally retries the subtitle. It re-writes the same keyed entry
    // from the same video item, so the two paths agree.
    //
    // Skipped when the group had no video item at all: `enqueue` pushes the
    // subtitle outside the "usable stream" guard, so an embed with a
    // `subtitlesUrl` and no playable stream reaches all-done with a payload
    // copied off the subtitle. Writing that entry would put a ⬇ icon on an
    // episode with nothing on disk.
    if (info.hasVideo) {
      persistDownloadedEpisode(store, {
        animeId,
        episodeInt,
        translationId,
        translationType,
        author,
        quality
      })
    }

    if (downloadManager.getMergeStatus(translationId) === 'deferred') {
      // The player is watching this episode from its .part (#63) — the file
      // can't be renamed or merged yet. finalizeDeferredEpisodes() runs the
      // rest of this tail once the player releases the file.
      return
    }

    const ffmpegInfo = await ffmpegReady
    const autoMerge = store.get('autoMerge')
    const ffmpegPath = getFfmpegPath()
    if (autoMerge && ffmpegInfo.available && ffmpegPath) {
      const codec = store.get('videoCodec') || 'copy'
      await downloadManager.mergeCompleted(ffmpegPath, getFfprobePath(), codec)
    } else {
      // Auto-move to cold if merge is disabled. `episodeInt` + `author`, not
      // `episodeLabel` — see the finalize pass above (#416).
      if (coldStorageService.isAdvanced() && store.get('autoMoveToCold')) {
        await coldStorageService.moveEpisodeToColdStorage(animeName, episodeInt, author)
      }
      const mode = store.get('notificationMode')
      if (mode === 'each') {
        notify('Download complete', `${animeName} — ${episodeLabel}`)
      }
      // With autoMerge off, the .mp4 is the final artifact — trigger here.
      // With autoMerge on, the merge-complete hook triggers against the .mkv
      // instead, so we don't double-fingerprint.
      if (animeId > 0) skipAnalysisService.scheduleAutoSkipAnalysis(animeId, animeName)
    }
  }

  async function handleMergeComplete({
    animeName,
    animeId,
    episodeLabel,
    mkvFilename
  }: {
    animeName: string
    animeId: number
    episodeInt: string
    episodeLabel: string
    mkvFilename: string
  }): Promise<void> {
    fileScanner.invalidate(animeName)
    // Auto-move to cold after merge — exactly the .mkv this merge produced, by
    // its download-dir-relative path (#414). Not moveEpisodeToColdStorage: that
    // one is scoped to an episode+author (#416), which is right for its own two
    // callers but still wider than one file. The merge pass unlinks its own
    // sources before firing this callback, so nothing else in that directory
    // belongs to this merge anyway.
    if (coldStorageService.isAdvanced() && store.get('autoMoveToCold')) {
      await coldStorageService.moveFileToColdByRelPath(mkvFilename)
    }
    const mode = store.get('notificationMode')
    if (mode === 'each') {
      notify('Merge complete', `${animeName} — ${episodeLabel}`)
    }
    if (animeId > 0) skipAnalysisService.scheduleAutoSkipAnalysis(animeId, animeName)
  }

  function handleVideoDownloaded(filePath: string, item: DownloadItem): void {
    // Episode metadata lands with the video item, not with the group (#412). A
    // subtitle that failed its three attempts used to hold `allDone` false
    // forever, so the video sat on disk showing ⬇ with no Play and no Delete.
    //
    // The write must stay ABOVE the .mp4 filter on the next line, which belongs
    // to the mp4-stats consumer only: below it, every .mkv download would go
    // unrecorded. Since #409 that is a behavioural assertion in
    // `test/lib/episode-completion.test.ts` rather than a source-text one — a
    // non-.mp4 path must still persist, and must not probe.
    persistDownloadedEpisode(store, item)
    if (!filePath.toLowerCase().endsWith('.mp4')) return
    void mp4StatsService.recordCheck(filePath, {
      animeId: item.animeId,
      animeName: item.animeName,
      episodeInt: item.episodeInt,
      episodeLabel: item.episodeLabel
    })
  }

  return {
    finalizeDeferredEpisodes,
    handleEpisodeComplete,
    handleMergeComplete,
    handleVideoDownloaded
  }
}
