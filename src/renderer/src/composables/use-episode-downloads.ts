// File-on-disk helpers, download orchestration, watch progress, and
// continue-watching for AnimeDetailView. Phase 5 slice 5b.2 (#118).
//
// Owns only the transient flags `downloading` + `errorMessage`. The data refs
// (episodeMeta, fileStatus, downloadGroups, watchProgress) live at the
// component level so both this composable and useEpisodeList can read them
// without a circular construction. The composable's job is the actions +
// helpers + computeds derived from those refs.
//
// Lifecycle hooks are NOT registered here — the component wires its own
// onMounted/onUnmounted around `subscribeFileEpisodesChanged()`. Keeps the
// composable callable from Vitest without a Vue component context.

import { ref, computed, nextTick, type Ref, type ComputedRef } from 'vue'
import { sanitizeFilename } from '../utils'
import type { EpisodeRow } from './use-episode-list'
import type { useDownloadsStore } from '../stores/downloads'
import type { usePlayerStore } from '../stores/player'

type FileEntry = {
  type: 'mkv' | 'mp4'
  filePath: string
  translationId?: number
  author?: string
}

type TranslationListEntry = { id: number; label: string; type: string; height: number }

type AllEpisodesEntry = {
  episodeInt: string
  episodeFull: string
  translations: TranslationListEntry[]
  downloadedTrIds: number[]
}

export function useEpisodeDownloads(deps: {
  anime: Ref<AnimeDetail | null>
  getAnimeId: () => number
  getAnimeName: () => string
  // Component-owned data refs (write access)
  episodeMeta: Ref<Record<string, EpisodeMeta[]>>
  fileStatus: Ref<Record<string, FileEntry[]>>
  downloadGroups: Ref<Map<string, EpisodeGroup>>
  watchProgress: Ref<Record<string, WatchProgressEntry>>
  // From useEpisodeList
  filteredEpisodes: ComputedRef<EpisodeSummary[]>
  episodes: Ref<Map<number, EpisodeDetail>>
  episodeRows: ComputedRef<EpisodeRow[]>
  getRealHeight: (tr: Translation) => number
  currentPage: Ref<number>
  isPaginated: ComputedRef<boolean>
  goToPage: (page: number) => Promise<void>
  loadingEpisodes: Ref<boolean>
  // From component Shikimori state
  shikiRate: Ref<ShikiUserRate | null>
  shikiUser: Ref<ShikiUser | null>
  shikiEpisodes: Ref<number>
  shikiUserChecked: Ref<boolean>
  shikiLoading: Ref<boolean>
  // Stores + settings
  downloadsStore: ReturnType<typeof useDownloadsStore>
  playerStore: ReturnType<typeof usePlayerStore>
  playerMode: Ref<'system' | 'builtin'>
  pageSize: number
}): {
  downloading: Ref<boolean>
  errorMessage: Ref<string>
  continueTarget: ComputedRef<EpisodeSummary | null>
  continueReady: ComputedRef<boolean>
  continueLabel: ComputedRef<string>
  hasActiveDownloads: ComputedRef<boolean>
  episodeProgressPercent: (episodeInt: string) => number
  isEpisodeWatched: (episodeInt: string) => boolean
  getFileForTranslation: (episodeInt: string, translationId: number | undefined) => FileEntry | null
  hasAnyFile: (episodeInt: string) => boolean
  selectedTrHasFile: (row: EpisodeRow) => boolean
  buildTranslationList: (row: EpisodeRow | undefined) => TranslationListEntry[]
  buildAllEpisodes: () => AllEpisodesEntry[]
  dlProgress: (item: DownloadProgressItem | null) => number
  getGroup: (episodeFull: string) => EpisodeGroup | undefined
  downloadGroupChanged: (a: EpisodeGroup | undefined, b: EpisodeGroup | undefined) => boolean
  loadWatchProgress: () => Promise<void>
  checkFileStatus: () => Promise<void>
  updateDownloadGroups: (groups: EpisodeGroup[]) => void
  downloadAll: () => Promise<void>
  downloadEpisode: (row: EpisodeRow) => Promise<void>
  cancelEpisodeDownload: (episodeLabel: string) => Promise<void>
  cancelAllDownloads: () => Promise<void>
  openFile: (row: EpisodeRow) => Promise<void>
  playStream: (row: EpisodeRow) => Promise<void>
  showInFolder: (row: EpisodeRow) => void
  deleteFile: (row: EpisodeRow) => Promise<void>
  continueWatching: () => Promise<void>
  subscribeFileEpisodesChanged: () => Unsubscribe
} {
  const downloading = ref(false)
  const errorMessage = ref('')

  async function loadWatchProgress(): Promise<void> {
    try {
      deps.watchProgress.value = await window.api.watchProgressGetAll(deps.getAnimeId())
    } catch (err) {
      console.error('Failed to load watch progress:', err)
    }
  }

  function episodeProgressPercent(episodeInt: string): number {
    const entry = deps.watchProgress.value[episodeInt]
    if (!entry || !entry.duration) return 0
    const pct = Math.min(100, Math.round((entry.position / entry.duration) * 100))
    return pct < 2 ? 0 : pct
  }

  function isEpisodeWatched(episodeInt: string): boolean {
    if (deps.shikiRate.value?.status === 'completed') return true
    return !!deps.watchProgress.value[episodeInt]?.watched
  }

  const continueTarget = computed<EpisodeSummary | null>(() => {
    const eps = deps.filteredEpisodes.value
    if (eps.length === 0) return null

    // Completed → "Continue" means "start rewatching from ep 1". Without this
    // the shikiEpisodes >= eps.length branch below would land on the last
    // episode.
    if (deps.shikiRate.value?.status === 'completed') {
      return eps[0]
    }

    // 1) If Shikimori reports N completed episodes, jump to episode N+1.
    // Shikimori is authoritative — ignore local saved positions for earlier
    // episodes.
    if (
      deps.shikiUser.value &&
      deps.shikiEpisodes.value > 0 &&
      deps.shikiEpisodes.value < eps.length
    ) {
      return eps[deps.shikiEpisodes.value]
    }

    // 2) Prefer an episode with an unfinished saved position (most recent).
    let bestResume: EpisodeSummary | null = null
    let bestUpdatedAt = 0
    for (const ep of eps) {
      const entry = deps.watchProgress.value[ep.episodeInt]
      if (!entry || entry.watched) continue
      if (!entry.position || !entry.duration) continue
      if (entry.updatedAt > bestUpdatedAt) {
        bestUpdatedAt = entry.updatedAt
        bestResume = ep
      }
    }
    if (bestResume) return bestResume

    // 3) First episode after the last locally-watched one.
    let lastWatchedIdx = -1
    for (let i = 0; i < eps.length; i++) {
      if (isEpisodeWatched(eps[i].episodeInt)) lastWatchedIdx = i
    }
    const nextIdx = lastWatchedIdx + 1
    if (nextIdx < eps.length) return eps[nextIdx]

    // 4) Everything watched — fall back to the last episode.
    return eps[eps.length - 1]
  })

  const continueReady = computed<boolean>(() => {
    if (!deps.anime.value || deps.filteredEpisodes.value.length === 0) return false
    if (deps.loadingEpisodes.value) return false
    if (deps.anime.value.myAnimeListId && !deps.shikiUserChecked.value) return false
    if (deps.shikiUser.value && deps.shikiLoading.value) return false
    return continueTarget.value !== null
  })

  const continueLabel = computed<string>(() => {
    const target = continueTarget.value
    if (!target) return 'Continue'
    const entry = deps.watchProgress.value[target.episodeInt]
    const verb = entry && entry.position > 0 && !entry.watched ? 'Resume' : 'Continue'
    return `${verb} · Ep ${target.episodeInt}`
  })

  async function checkFileStatus(): Promise<void> {
    if (!deps.anime.value || deps.filteredEpisodes.value.length === 0) return
    const name = deps.getAnimeName()
    const episodeInts = deps.filteredEpisodes.value.map((ep) => ep.episodeInt)
    deps.fileStatus.value = await window.api.fileCheckEpisodes(name, episodeInts)
    deps.episodeMeta.value = await window.api.downloadedEpisodesGet(deps.getAnimeId())
  }

  function buildTranslationList(row: EpisodeRow | undefined): TranslationListEntry[] {
    if (!row) return []
    return row.allTranslations.map((tr) => ({
      id: tr.id,
      label: tr.authorsSummary,
      type: tr.type,
      height: deps.getRealHeight(tr)
    }))
  }

  function buildAllEpisodes(): AllEpisodesEntry[] {
    return deps.filteredEpisodes.value.map((ep) => {
      const detail = deps.episodes.value.get(ep.id)
      const translations = detail
        ? detail.translations
            .filter((t) => t.isActive === 1)
            .map((t) => ({
              id: t.id,
              label: t.authorsSummary,
              type: t.type,
              height: deps.getRealHeight(t)
            }))
        : []
      const metas = deps.episodeMeta.value[ep.episodeInt] || []
      const downloadedTrIds = metas.map((m) => m.translationId)
      return {
        episodeInt: ep.episodeInt,
        episodeFull: ep.episodeFull,
        translations,
        downloadedTrIds
      }
    })
  }

  function getFileForTranslation(
    episodeInt: string,
    translationId: number | undefined
  ): FileEntry | null {
    const files = deps.fileStatus.value[episodeInt]
    if (!files || files.length === 0) return null
    // Find file matching the translation's author via metadata
    if (translationId) {
      const metas = deps.episodeMeta.value[episodeInt] || []
      const meta = metas.find((m) => m.translationId === translationId)
      if (meta) {
        // Match by author tag
        const authorTag = sanitizeFilename(meta.author)
        const match = files.find((f) => f.author === authorTag)
        if (match) return match
        // Legacy file (no author tag) — only match if it's the sole metadata
        // entry
        if (metas.length === 1 && files.length === 1 && !files[0].author) {
          return files[0]
        }
      }
    }
    // No specific match found
    return null
  }

  function hasAnyFile(episodeInt: string): boolean {
    const files = deps.fileStatus.value[episodeInt]
    return !!files && files.length > 0
  }

  function selectedTrHasFile(row: EpisodeRow): boolean {
    if (!row.selectedTr) return false
    return !!getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
  }

  function downloadGroupChanged(a: EpisodeGroup | undefined, b: EpisodeGroup | undefined): boolean {
    if (!a && !b) return false
    if (!a || !b) return true
    if (a.mergeStatus !== b.mergeStatus || a.mergePercent !== b.mergePercent) return true
    const av = a.video,
      bv = b.video
    if (!av && !bv) return false
    if (!av || !bv) return true
    return (
      av.status !== bv.status ||
      av.bytesReceived !== bv.bytesReceived ||
      av.totalBytes !== bv.totalBytes ||
      av.speed !== bv.speed
    )
  }

  function updateDownloadGroups(groups: EpisodeGroup[]): void {
    const prev = deps.downloadGroups.value
    const map = new Map<string, EpisodeGroup>()
    let newlyCompleted = false
    let changed = false
    const animeName = deps.getAnimeName()
    for (const g of groups) {
      if (g.animeName === animeName) {
        map.set(g.episodeLabel, g)
        const old = prev.get(g.episodeLabel)
        if (downloadGroupChanged(old, g)) changed = true
        if (g.mergeStatus === 'completed' && old?.mergeStatus !== 'completed') {
          newlyCompleted = true
        }
        if (g.video?.status === 'completed' && old?.video?.status !== 'completed') {
          newlyCompleted = true
        }
      }
    }
    // Also detect removals (prev had entries that new map doesn't)
    if (prev.size !== map.size) changed = true
    if (!changed) return
    deps.downloadGroups.value = map
    if (newlyCompleted) {
      void checkFileStatus()
    }
  }

  function dlProgress(item: DownloadProgressItem | null): number {
    if (!item || item.totalBytes <= 0) return 0
    return (item.bytesReceived / item.totalBytes) * 100
  }

  function getGroup(episodeFull: string): EpisodeGroup | undefined {
    return deps.downloadGroups.value.get(episodeFull)
  }

  const hasActiveDownloads = computed(() => deps.downloadGroups.value.size > 0)

  async function checkToken(): Promise<boolean> {
    const token = (await window.api.getSetting('token')) as string
    if (!token) {
      errorMessage.value = 'API token is required for downloads. Set it in Settings.'
      setTimeout(() => {
        errorMessage.value = ''
      }, 5000)
      return false
    }
    return true
  }

  async function downloadAll(): Promise<void> {
    if (!deps.anime.value) return
    if (!(await checkToken())) return

    const name = deps.getAnimeName()
    const requests: DownloadRequest[] = []

    for (const row of deps.episodeRows.value) {
      if (row.selectedTr && !row.isLocked && !selectedTrHasFile(row)) {
        requests.push({
          translationId: row.selectedTr.id,
          height: deps.getRealHeight(row.selectedTr),
          animeName: name,
          episodeLabel: row.episode.episodeFull,
          episodeInt: row.episode.episodeInt,
          animeId: deps.anime.value!.id,
          translationType: row.selectedTr.type,
          author: row.selectedTr.authorsSummary
        })
      }
    }

    if (requests.length === 0) return
    downloading.value = true
    try {
      await window.api.downloadedAnimeAdd(JSON.parse(JSON.stringify(deps.anime.value)))
      await window.api.downloadEnqueue(requests)
    } finally {
      downloading.value = false
    }
  }

  async function downloadEpisode(row: EpisodeRow): Promise<void> {
    if (!row.selectedTr || !deps.anime.value) return
    if (!(await checkToken())) return

    await window.api.downloadedAnimeAdd(JSON.parse(JSON.stringify(deps.anime.value)))
    await window.api.downloadEnqueue([
      {
        translationId: row.selectedTr.id,
        height: deps.getRealHeight(row.selectedTr),
        animeName: deps.getAnimeName(),
        episodeLabel: row.episode.episodeFull,
        episodeInt: row.episode.episodeInt,
        animeId: deps.anime.value!.id,
        translationType: row.selectedTr.type,
        author: row.selectedTr.authorsSummary
      }
    ])
  }

  async function cancelEpisodeDownload(episodeLabel: string): Promise<void> {
    await window.api.downloadCancelByEpisode(deps.getAnimeName(), episodeLabel)
  }

  async function cancelAllDownloads(): Promise<void> {
    await window.api.downloadCancelByEpisode(deps.getAnimeName())
  }

  async function openFile(row: EpisodeRow): Promise<void> {
    if (!row.selectedTr) return
    const info = getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
    if (!info) return

    if (deps.playerMode.value === 'builtin') {
      const name = deps.anime.value ? deps.getAnimeName() : ''
      const localSubs = await window.api.playerGetLocalSubtitles(info.filePath)
      const allEps = buildAllEpisodes()
      const epIdx = allEps.findIndex((e) => e.episodeInt === row.episode.episodeInt)
      deps.playerStore.openPlayer({
        filePath: info.filePath,
        streamUrl: '',
        subtitleContent: localSubs || '',
        animeName: name,
        episodeLabel: row.episode.episodeInt,
        availableStreams: [],
        translationId: row.selectedTr.id,
        translations: buildTranslationList(row),
        downloadedTrIds: [...row.downloadedTrIds],
        allEpisodes: allEps,
        episodeIndex: epIdx,
        animeId: deps.getAnimeId(),
        malId: deps.anime.value?.myAnimeListId ?? 0
      })
    } else {
      const result = await window.api.fileOpen(info.filePath)
      if (result) {
        errorMessage.value = result
        await checkFileStatus()
      }
    }
  }

  async function playStream(row: EpisodeRow): Promise<void> {
    if (!row.selectedTr) return
    const name = deps.anime.value ? deps.getAnimeName() : ''
    const result = await window.api.playerGetStreamUrl(
      row.selectedTr.id,
      deps.getRealHeight(row.selectedTr)
    )
    if (result) {
      const allEps = buildAllEpisodes()
      const epIdx = allEps.findIndex((e) => e.episodeInt === row.episode.episodeInt)
      deps.playerStore.openPlayer({
        filePath: '',
        streamUrl: result.streamUrl,
        subtitleContent: result.subtitleContent || '',
        animeName: name,
        episodeLabel: row.episode.episodeInt,
        availableStreams: result.availableStreams,
        translationId: row.selectedTr.id,
        translations: buildTranslationList(row),
        downloadedTrIds: [...row.downloadedTrIds],
        allEpisodes: allEps,
        episodeIndex: epIdx,
        animeId: deps.getAnimeId(),
        malId: deps.anime.value?.myAnimeListId ?? 0
      })
    }
  }

  function showInFolder(row: EpisodeRow): void {
    if (!row.selectedTr) return
    const info = getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
    if (!info) return
    void window.api.fileShowInFolder(info.filePath)
  }

  async function deleteFile(row: EpisodeRow): Promise<void> {
    if (!row.selectedTr) return
    const info = getFileForTranslation(row.episode.episodeInt, row.selectedTr.id)
    if (!info) return
    await window.api.fileDeleteEpisode(
      deps.getAnimeName(),
      row.episode.episodeInt,
      deps.getAnimeId(),
      row.selectedTr.id
    )
    await checkFileStatus()
  }

  async function continueWatching(): Promise<void> {
    const target = continueTarget.value
    if (!target) return

    const eps = deps.filteredEpisodes.value
    const targetIdx = eps.findIndex((e) => e.episodeInt === target.episodeInt)
    if (targetIdx < 0) return

    const targetPage = deps.isPaginated.value ? Math.floor(targetIdx / deps.pageSize) : 0
    if (targetPage !== deps.currentPage.value) {
      await deps.goToPage(targetPage)
    }
    await nextTick()

    const row = deps.episodeRows.value.find((r) => r.episode.episodeInt === target.episodeInt)
    if (!row || !row.selectedTr) return

    if (selectedTrHasFile(row)) {
      await openFile(row)
    } else {
      await playStream(row)
    }
  }

  function subscribeFileEpisodesChanged(): Unsubscribe {
    return window.api.onFileEpisodesChanged((animeName, data) => {
      if (deps.anime.value && animeName === deps.getAnimeName()) {
        const episodeInts = deps.filteredEpisodes.value.map((ep) => ep.episodeInt)
        const baseMap = new Map<string, string>()
        for (const epInt of episodeInts) {
          const padded = epInt.padStart(2, '0')
          const base = sanitizeFilename(`${animeName} - ${padded}`)
          baseMap.set(base, epInt)
        }
        const filtered: typeof deps.fileStatus.value = {}
        for (const [base, files] of Object.entries(data)) {
          const epInt = baseMap.get(base)
          if (epInt) filtered[epInt] = files
        }
        deps.fileStatus.value = filtered
      }
    })
  }

  return {
    downloading,
    errorMessage,
    continueTarget,
    continueReady,
    continueLabel,
    hasActiveDownloads,
    episodeProgressPercent,
    isEpisodeWatched,
    getFileForTranslation,
    hasAnyFile,
    selectedTrHasFile,
    buildTranslationList,
    buildAllEpisodes,
    dlProgress,
    getGroup,
    downloadGroupChanged,
    loadWatchProgress,
    checkFileStatus,
    updateDownloadGroups,
    downloadAll,
    downloadEpisode,
    cancelEpisodeDownload,
    cancelAllDownloads,
    openFile,
    playStream,
    showInFolder,
    deleteFile,
    continueWatching,
    subscribeFileEpisodesChanged
  }
}
