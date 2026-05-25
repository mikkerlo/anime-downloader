// Episode list / paging / projection for AnimeDetailView. Phase 5 slice 5b.1 (#118).
//
// Owns: episodes Map, currentPage, realQuality (probed), episodeOverrides,
// focusApplied, loadingEpisodes.
//
// Consumes (as Refs) the per-anime state owned by the component or other
// composables: anime, animeId (getter), translationType, selectedAuthor,
// episodeMeta, fileStatus, downloadGroups, watchProgress.
//
// Returns:
// - the page projections (filteredEpisodes, pagedEpisodes, episodeRows),
// - paging + load + focus actions,
// - quality probing,
// - the 5-priority episode-row selection algorithm (the central piece of
//   AnimeDetailView's reactivity surface).
//
// Lifecycle hooks are NOT registered here — the component is responsible for
// wiring up onMounted/onUnmounted timing of loadPageEpisodes etc. This keeps
// the composable callable from Vitest.

import { ref, computed, nextTick, type Ref, type ComputedRef } from 'vue'
import type { useLibraryStore } from '../stores/library'

export interface EpisodeRow {
  episode: EpisodeSummary
  allTranslations: Translation[]
  selectedTr: Translation | null
  isLocked: boolean
  lockSource: 'downloaded' | 'queued' | null
  downloadedTrIds: Set<number>
}

export const PAGE_SIZE = 30

const TRANSLATION_TYPE_ORDER: readonly string[] = ['subRu', 'subEn', 'voiceRu', 'voiceEn', 'raw']

export function useEpisodeList(deps: {
  anime: Ref<AnimeDetail | null>
  getAnimeId: () => number
  getInitialAuthor: () => string | undefined
  translationType: Ref<string>
  selectedAuthor: Ref<string>
  episodeMeta: Ref<Record<string, EpisodeMeta[]>>
  fileStatus: Ref<
    Record<
      string,
      { type: 'mkv' | 'mp4'; filePath: string; translationId?: number; author?: string }[]
    >
  >
  downloadGroups: Ref<Map<string, EpisodeGroup>>
  watchProgress: Ref<Record<string, WatchProgressEntry>>
  libraryStore: ReturnType<typeof useLibraryStore>
  checkFileStatus: () => Promise<void>
}): {
  episodes: Ref<Map<number, EpisodeDetail>>
  currentPage: Ref<number>
  realQuality: Ref<Map<number, number>>
  episodeOverrides: Ref<Map<number, number>>
  focusApplied: Ref<boolean>
  loadingEpisodes: Ref<boolean>
  filteredEpisodes: ComputedRef<EpisodeSummary[]>
  pagedEpisodes: ComputedRef<EpisodeSummary[]>
  episodeRows: ComputedRef<EpisodeRow[]>
  totalPages: ComputedRef<number>
  isPaginated: ComputedRef<boolean>
  translationTypeCounts: ComputedRef<Map<string, number>>
  availableAuthors: ComputedRef<[string, number][]>
  PAGE_SIZE: number
  getRealHeight: (tr: Translation) => number
  qualityLabel: (height: number) => string
  bestPerAuthor: (translations: Translation[]) => Translation[]
  goToPage: (page: number) => Promise<void>
  loadPageEpisodes: () => Promise<void>
  probeSelectedQualities: () => Promise<void>
  onEpisodeTranslationChange: (episodeId: number, episodeInt: string, translationId: number) => void
  applyFocusEpisode: (target: string) => Promise<void>
  resetEpisodeOverrides: () => void
} {
  const episodes = ref<Map<number, EpisodeDetail>>(new Map())
  const currentPage = ref(0)
  const realQuality = ref<Map<number, number>>(new Map())
  const episodeOverrides = ref<Map<number, number>>(new Map())
  const focusApplied = ref(false)
  const loadingEpisodes = ref(false)

  let probeGeneration = 0

  function getRealHeight(tr: Translation): number {
    return realQuality.value.get(tr.id) ?? tr.height
  }

  function qualityLabel(height: number): string {
    if (height >= 1080) return '1080p'
    if (height >= 720) return '720p'
    if (height >= 480) return '480p'
    return `${height}p`
  }

  function bestPerAuthor(translations: Translation[]): Translation[] {
    const best = new Map<string, Translation>()
    for (const tr of translations) {
      const key = `${tr.type}:${tr.authorsSummary}`
      const existing = best.get(key)
      if (!existing || getRealHeight(tr) > getRealHeight(existing)) {
        best.set(key, tr)
      }
    }
    return [...best.values()]
  }

  const filteredEpisodes = computed(() => {
    if (!deps.anime.value) return []
    const allActive = deps.anime.value.episodes.filter(
      (ep) => ep.isActive === 1 && ep.episodeType !== 'preview'
    )
    if (!deps.anime.value.type) return allActive
    const matched = deps.anime.value.episodes.filter(
      (ep) => ep.isActive === 1 && ep.episodeType === deps.anime.value!.type
    )
    if (matched.length === 0) return allActive
    if (deps.anime.value.numberOfEpisodes && matched.length !== deps.anime.value.numberOfEpisodes)
      return allActive
    return matched
  })

  const totalPages = computed(() =>
    Math.max(1, Math.ceil(filteredEpisodes.value.length / PAGE_SIZE))
  )
  const isPaginated = computed(() => filteredEpisodes.value.length > PAGE_SIZE)
  const pagedEpisodes = computed(() => {
    if (!isPaginated.value) return filteredEpisodes.value
    const start = currentPage.value * PAGE_SIZE
    return filteredEpisodes.value.slice(start, start + PAGE_SIZE)
  })

  const translationTypeCounts = computed(() => {
    const counts = new Map<string, number>()
    for (const ep of episodes.value.values()) {
      const seen = new Set<string>()
      for (const tr of ep.translations) {
        if (tr.isActive === 1) seen.add(tr.type)
      }
      for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1)
    }
    return counts
  })

  const availableAuthors = computed(() => {
    const counts = new Map<string, number>()
    for (const ep of episodes.value.values()) {
      const seen = new Set<string>()
      for (const tr of ep.translations) {
        if (
          tr.type === deps.translationType.value &&
          tr.isActive === 1 &&
          !seen.has(tr.authorsSummary)
        ) {
          seen.add(tr.authorsSummary)
          counts.set(tr.authorsSummary, (counts.get(tr.authorsSummary) || 0) + 1)
        }
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  })

  const episodeRows = computed<EpisodeRow[]>(() => {
    return pagedEpisodes.value.map((ep) => {
      const detail = episodes.value.get(ep.id)
      const rawTranslations = detail ? detail.translations.filter((tr) => tr.isActive === 1) : []
      const allTranslations = bestPerAuthor(rawTranslations)

      const sorted = [...allTranslations].sort((a, b) => {
        const aMatch = a.type === deps.translationType.value ? 0 : 1
        const bMatch = b.type === deps.translationType.value ? 0 : 1
        if (aMatch !== bMatch) return aMatch - bMatch
        const aH = getRealHeight(a)
        const bH = getRealHeight(b)
        if (aH !== bH) return bH - aH
        return TRANSLATION_TYPE_ORDER.indexOf(a.type) - TRANSLATION_TYPE_ORDER.indexOf(b.type)
      })

      const metas = deps.episodeMeta.value[ep.episodeInt] || []
      const group = deps.downloadGroups.value.get(ep.episodeFull)

      const downloadedTrIds = new Set<number>()
      for (const m of metas) {
        if (m.translationId) downloadedTrIds.add(m.translationId)
      }

      let selectedTr: Translation | null = null
      let isLocked = false
      let lockSource: 'downloaded' | 'queued' | null = null

      // Priority 1: queued/active download — lock the row
      if (
        group &&
        group.video &&
        !['completed', 'cancelled', 'failed'].includes(group.video.status)
      ) {
        selectedTr = sorted.find((tr) => tr.id === group.translationId) || null
        if (selectedTr) {
          isLocked = true
          lockSource = 'queued'
        }
      }

      // Priority 2: in-session user override (sync, gives instant dropdown feedback
      // before the persisted watchProgress update lands)
      if (!isLocked && episodeOverrides.value.has(ep.id)) {
        selectedTr = sorted.find((tr) => tr.id === episodeOverrides.value.get(ep.id)) || null
      }

      // Priority 3: last-used translation persisted in watchProgress. Ranked above
      // downloaded so an explicit user choice — even a stream — wins over a file.
      if (!isLocked && !selectedTr) {
        const remembered = deps.watchProgress.value[ep.episodeInt]?.translationId
        if (remembered != null) {
          selectedTr = sorted.find((tr) => tr.id === remembered) || null
        }
      }

      // Priority 4: any downloaded translation — avoids silent fallback to streaming
      // when the global default doesn't match what's on disk. Within same-type
      // downloads, honor the user's author preference before falling back to highest.
      if (!isLocked && !selectedTr && downloadedTrIds.size > 0) {
        const downloaded = sorted.filter((tr) => downloadedTrIds.has(tr.id))
        const sameType = downloaded.filter((tr) => tr.type === deps.translationType.value)
        const sameAuthor = sameType.find((tr) => tr.authorsSummary === deps.selectedAuthor.value)
        const bestSameType = [...sameType].sort((a, b) => getRealHeight(b) - getRealHeight(a))[0]
        selectedTr = sameAuthor || bestSameType || downloaded[0] || null
      }

      // Priority 5: global default (translation type + author)
      if (!isLocked && !selectedTr) {
        const typeFiltered = sorted.filter((tr) => tr.type === deps.translationType.value)
        selectedTr =
          typeFiltered.find((tr) => tr.authorsSummary === deps.selectedAuthor.value) ||
          typeFiltered[0] ||
          null
      }

      return {
        episode: ep,
        allTranslations: sorted,
        selectedTr,
        isLocked,
        lockSource,
        downloadedTrIds
      }
    })
  })

  function onEpisodeTranslationChange(
    episodeId: number,
    episodeInt: string,
    translationId: number
  ): void {
    episodeOverrides.value = new Map(episodeOverrides.value.set(episodeId, translationId))
    const prev = deps.watchProgress.value[episodeInt]
    window.api
      .watchProgressSave(
        deps.getAnimeId(),
        episodeInt,
        prev?.position ?? 0,
        prev?.duration ?? 0,
        prev?.watched,
        translationId
      )
      .catch((err) => console.warn('[anime-detail] failed to persist translation choice:', err))
  }

  function resetEpisodeOverrides(): void {
    episodeOverrides.value = new Map()
  }

  async function loadPageEpisodes(): Promise<void> {
    if (!deps.anime.value || pagedEpisodes.value.length === 0) return
    loadingEpisodes.value = true

    const toLoad = pagedEpisodes.value.filter((ep) => !episodes.value.has(ep.id))

    if (toLoad.length > 0) {
      const res = await window.api.getEpisodesBatch(
        toLoad.map((ep) => ep.id),
        deps.getAnimeId()
      )
      const byId = new Map(res.data.map((d) => [d.id, d]))
      const updated = new Map(episodes.value)
      for (const ep of toLoad) {
        // Episodes with no translations are absent from the bulk response —
        // synthesize an empty detail so the map stays complete and they aren't
        // re-fetched on every page revisit.
        updated.set(
          ep.id,
          byId.get(ep.id) ?? {
            id: ep.id,
            episodeFull: ep.episodeFull,
            episodeInt: ep.episodeInt,
            episodeType: ep.episodeType,
            translations: []
          }
        )
      }
      episodes.value = updated
    }

    if (availableAuthors.value.length > 0 && !deps.selectedAuthor.value) {
      const initial = deps.getInitialAuthor()
      if (initial && availableAuthors.value.some(([a]) => a === initial)) {
        deps.selectedAuthor.value = initial
      } else {
        deps.selectedAuthor.value = availableAuthors.value[0][0]
      }
    }

    loadingEpisodes.value = false
    void probeSelectedQualities()
  }

  async function goToPage(page: number): Promise<void> {
    currentPage.value = page
    await loadPageEpisodes()
    await deps.checkFileStatus()
  }

  async function probeSelectedQualities(): Promise<void> {
    const gen = ++probeGeneration

    const trMeta = new Map<number, Translation>()
    for (const row of episodeRows.value) {
      for (const tr of row.allTranslations) {
        trMeta.set(tr.id, tr)
      }
    }

    const selectedIds: number[] = []
    for (const row of episodeRows.value) {
      if (row.selectedTr && !realQuality.value.has(row.selectedTr.id)) {
        selectedIds.push(row.selectedTr.id)
      }
    }

    if (selectedIds.length > 0) {
      const updated = await probeIds(selectedIds, trMeta, gen)
      if (updated) realQuality.value = updated
    }

    if (gen !== probeGeneration) return

    const bgProbeEnabled = (await window.api.getSetting('backgroundQualityProbe')) as boolean
    if (!bgProbeEnabled) return

    const episodeCount = filteredEpisodes.value.length
    const needsFullScan = await window.api.probeFullScanNeeded(deps.getAnimeId(), episodeCount)
    if (!needsFullScan || gen !== probeGeneration) return

    const remainingIds: number[] = []
    for (const id of trMeta.keys()) {
      if (!realQuality.value.has(id)) remainingIds.push(id)
    }

    if (remainingIds.length > 0) {
      const updated = await probeIds(remainingIds, trMeta, gen, true)
      if (updated) realQuality.value = updated
    }

    if (gen === probeGeneration) {
      void window.api.probeFullScanDone(deps.getAnimeId(), episodeCount)
    }
  }

  async function probeIds(
    ids: number[],
    trMeta: Map<number, Translation>,
    gen: number,
    throttle = false
  ): Promise<Map<number, number> | null> {
    const batchSize = throttle ? 2 : 5
    const collected = new Map<number, number>()
    for (let i = 0; i < ids.length; i += batchSize) {
      if (gen !== probeGeneration) return null
      if (throttle) await new Promise((r) => setTimeout(r, 100))
      const batch = ids.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map((id) =>
          window.api.probeEmbedQuality(id, deps.getAnimeId()).then((h) => ({ id, height: h }))
        )
      )
      for (const r of results) {
        if (r.height !== null) {
          collected.set(r.id, r.height)
          const tr = trMeta.get(r.id)
          if (tr && tr.height !== r.height) {
            console.warn(
              `[quality-mismatch] Translation ${r.id} (${tr.authorsSummary}, ${tr.type}): reported=${tr.height}p, actual=${r.height}p`
            )
            void window.api.reportQualityMismatch({
              translationId: r.id,
              author: tr.authorsSummary,
              type: tr.type,
              reported: tr.height,
              actual: r.height
            })
          }
        }
      }
    }
    if (gen !== probeGeneration) return null
    const merged = new Map(realQuality.value)
    for (const [id, h] of collected) {
      merged.set(id, h)
    }
    return merged
  }

  async function applyFocusEpisode(target: string): Promise<void> {
    if (focusApplied.value) return
    const eps = filteredEpisodes.value
    if (eps.length === 0) return
    const targetIdx = eps.findIndex((e) => e.episodeInt === target)
    if (targetIdx < 0) {
      focusApplied.value = true
      deps.libraryStore.clearFocusEpisode(deps.getAnimeId())
      return
    }
    const targetPage = isPaginated.value ? Math.floor(targetIdx / PAGE_SIZE) : 0
    if (targetPage !== currentPage.value) {
      await goToPage(targetPage)
    }
    await nextTick()
    const el = document.querySelector(
      `.episode-row[data-ep-int="${CSS.escape(target)}"]`
    ) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    focusApplied.value = true
    deps.libraryStore.clearFocusEpisode(deps.getAnimeId())
  }

  return {
    episodes,
    currentPage,
    realQuality,
    episodeOverrides,
    focusApplied,
    loadingEpisodes,
    filteredEpisodes,
    pagedEpisodes,
    episodeRows,
    totalPages,
    isPaginated,
    translationTypeCounts,
    availableAuthors,
    PAGE_SIZE,
    getRealHeight,
    qualityLabel,
    bestPerAuthor,
    goToPage,
    loadPageEpisodes,
    probeSelectedQualities,
    onEpisodeTranslationChange,
    applyFocusEpisode,
    resetEpisodeOverrides
  }
}
