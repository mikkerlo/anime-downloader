// Local skip-detection / chapter-inject panel state for AnimeDetailView.
// Phase 5 slice 5b.4 (#118).
//
// Owns all per-anime skip-detection state: detections, running flags,
// progress, errors, plus the chapter-inject lifecycle. Exposes the three
// `subscribe*` init functions that the component wires from onMounted —
// each filters broadcasts to this anime's id (component-local subscriptions
// rather than store-global, since the panel only cares about its current
// anime).
//
// Consumes: animeId getter + filteredEpisodes + fileStatus refs (to project
// `skipEpisodeInputs` from on-disk files).

import { computed, ref, type ComputedRef, type Ref } from 'vue'

type FileEntry = {
  type: 'mkv' | 'mp4'
  filePath: string
  translationId?: number
  author?: string
}

export interface SkipEpisodeInput {
  episodeInt: string
  episodeLabel: string
  filePath: string
}

export function useSkipDetection(deps: {
  getAnimeId: () => number
  filteredEpisodes: ComputedRef<EpisodeSummary[]> | Ref<EpisodeSummary[]>
  fileStatus: Ref<Record<string, FileEntry[]>>
}): {
  skipPanelCollapsed: Ref<boolean>
  skipDetections: Ref<ShowSkipDetections | null>
  skipAnalyzing: Ref<boolean>
  skipProgress: Ref<SkipDetectorProgress | null>
  skipError: Ref<string>
  chapterInjecting: Ref<boolean>
  chapterInjectProgress: Ref<ChapterInjectProgress | null>
  chapterInjectError: Ref<string>
  chapterInjectResult: Ref<{
    written: number
    skipped: number
    failed: number
    total: number
  } | null>
  skipEpisodeInputs: ComputedRef<SkipEpisodeInput[]>
  skipMkvEpisodeCount: ComputedRef<number>
  skipProgressLabel: ComputedRef<string>
  chapterInjectProgressLabel: ComputedRef<string>
  formatSkipTime: (sec: number) => string
  loadSkipDetections: () => Promise<void>
  hydrateSkipStatus: () => Promise<void>
  runSkipAnalysis: () => Promise<void>
  cancelSkipAnalysis: () => Promise<void>
  injectChaptersToMkv: () => Promise<void>
  subscribeSkipDetectorProgress: () => Unsubscribe
  subscribeSkipDetectorSignatureUpdated: () => Unsubscribe
  subscribeChapterInjectProgress: () => Unsubscribe
} {
  const skipPanelCollapsed = ref(true)
  const skipDetections = ref<ShowSkipDetections | null>(null)
  const skipAnalyzing = ref(false)
  const skipProgress = ref<SkipDetectorProgress | null>(null)
  const skipError = ref('')
  const chapterInjecting = ref(false)
  const chapterInjectProgress = ref<ChapterInjectProgress | null>(null)
  const chapterInjectError = ref('')
  const chapterInjectResult = ref<{
    written: number
    skipped: number
    failed: number
    total: number
  } | null>(null)

  const skipEpisodeInputs = computed<SkipEpisodeInput[]>(() => {
    const inputs: SkipEpisodeInput[] = []
    const seen = new Set<string>()
    // Walk filteredEpisodes to keep an ordered, label-aware list. fileStatus
    // is keyed by episodeInt.
    for (const ep of deps.filteredEpisodes.value) {
      const files = deps.fileStatus.value[ep.episodeInt]
      if (!files || files.length === 0) continue
      // Prefer .mkv (merged) over .mp4 (raw); first match wins.
      const mkv = files.find((f) => f.type === 'mkv')
      const pick = mkv || files[0]
      if (!pick || !pick.filePath) continue
      if (seen.has(ep.episodeInt)) continue
      seen.add(ep.episodeInt)
      inputs.push({
        episodeInt: ep.episodeInt,
        episodeLabel: ep.episodeFull || `Episode ${ep.episodeInt}`,
        filePath: pick.filePath
      })
    }
    return inputs
  })

  const skipMkvEpisodeCount = computed<number>(
    () => skipEpisodeInputs.value.filter((e) => e.filePath.toLowerCase().endsWith('.mkv')).length
  )

  const skipProgressLabel = computed<string>(() => {
    const p = skipProgress.value
    if (!p) return ''
    if (p.phase === 'fingerprinting') {
      const label = p.episodeLabel ? ` — ${p.episodeLabel}` : ''
      return `Fingerprinting ${p.current}/${p.total}${label}`
    }
    if (p.phase === 'comparing') {
      return `Comparing pairs ${p.current}/${p.total}`
    }
    return 'Done'
  })

  const chapterInjectProgressLabel = computed<string>(() => {
    const p = chapterInjectProgress.value
    if (!p) return ''
    if (p.phase === 'analyzing') return 'Analyzing fingerprints…'
    if (p.phase === 'writing') {
      const label = p.episodeLabel ? ` — ${p.episodeLabel}` : ''
      return `Writing chapters ${p.current + 1}/${p.total}${label}`
    }
    return 'Done'
  })

  function formatSkipTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '—'
    const total = Math.round(sec)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  async function loadSkipDetections(): Promise<void> {
    try {
      const res = await window.api.skipDetectorGetDetections(deps.getAnimeId())
      skipDetections.value = res
    } catch (err) {
      console.error('Failed to load skip detections:', err)
    }
  }

  // Recover the analyzing state if the user navigated away mid-analysis and
  // came back. Without this, the panel would show idle even though main is
  // still chewing on fingerprints — and a fresh "Analyze" click for this same
  // animeId would dedupe onto the in-flight promise (good), while a click on
  // a different anime's panel would now reject (also good).
  async function hydrateSkipStatus(): Promise<void> {
    try {
      const status = await window.api.skipDetectorGetStatus()
      if (status && status.animeId === deps.getAnimeId()) {
        skipAnalyzing.value = true
        skipProgress.value = status.lastProgress
      }
    } catch (err) {
      console.error('Failed to hydrate skip status:', err)
    }
  }

  async function runSkipAnalysis(): Promise<void> {
    if (skipAnalyzing.value) return
    const inputs = skipEpisodeInputs.value
    if (inputs.length < 2) {
      skipError.value = 'Need at least 2 downloaded episodes'
      return
    }
    skipError.value = ''
    skipAnalyzing.value = true
    skipProgress.value = {
      animeId: deps.getAnimeId(),
      phase: 'fingerprinting',
      current: 0,
      total: inputs.length
    }
    try {
      const result = await window.api.skipDetectorAnalyzeShow(deps.getAnimeId(), inputs)
      skipDetections.value = result
    } catch (err) {
      skipError.value = err instanceof Error ? err.message : String(err)
    } finally {
      skipAnalyzing.value = false
      skipProgress.value = null
    }
  }

  async function cancelSkipAnalysis(): Promise<void> {
    try {
      await window.api.skipDetectorCancel()
    } catch (err) {
      console.error('Failed to cancel skip analysis:', err)
    }
  }

  async function injectChaptersToMkv(): Promise<void> {
    if (chapterInjecting.value) return
    if (skipMkvEpisodeCount.value < 3) {
      chapterInjectError.value = 'Need at least 3 downloaded MKV episodes'
      return
    }
    chapterInjectError.value = ''
    chapterInjectResult.value = null
    chapterInjecting.value = true
    chapterInjectProgress.value = {
      animeId: deps.getAnimeId(),
      phase: 'writing',
      current: 0,
      total: skipMkvEpisodeCount.value
    }
    try {
      const res = await window.api.injectChapters(deps.getAnimeId(), skipEpisodeInputs.value)
      chapterInjectResult.value = res
    } catch (err) {
      chapterInjectError.value = err instanceof Error ? err.message : String(err)
    } finally {
      chapterInjecting.value = false
      chapterInjectProgress.value = null
    }
  }

  // Component-local subscriptions filtered by this anime's id. The main
  // process broadcasts to all listeners, but only the panel for the active
  // anime should react.
  function subscribeSkipDetectorProgress(): Unsubscribe {
    return window.api.onSkipDetectorProgress((data) => {
      if (data.animeId !== deps.getAnimeId()) return
      skipProgress.value = data
      skipAnalyzing.value = data.phase !== 'done'
    })
  }

  function subscribeSkipDetectorSignatureUpdated(): Unsubscribe {
    return window.api.onSkipDetectorSignatureUpdated((data) => {
      if (data.animeId !== deps.getAnimeId()) return
      void loadSkipDetections()
    })
  }

  function subscribeChapterInjectProgress(): Unsubscribe {
    return window.api.onChapterInjectProgress((data) => {
      if (data.animeId !== deps.getAnimeId()) return
      chapterInjectProgress.value = data
      chapterInjecting.value = data.phase !== 'done'
    })
  }

  return {
    skipPanelCollapsed,
    skipDetections,
    skipAnalyzing,
    skipProgress,
    skipError,
    chapterInjecting,
    chapterInjectProgress,
    chapterInjectError,
    chapterInjectResult,
    skipEpisodeInputs,
    skipMkvEpisodeCount,
    skipProgressLabel,
    chapterInjectProgressLabel,
    formatSkipTime,
    loadSkipDetections,
    hydrateSkipStatus,
    runSkipAnalysis,
    cancelSkipAnalysis,
    injectChaptersToMkv,
    subscribeSkipDetectorProgress,
    subscribeSkipDetectorSignatureUpdated,
    subscribeChapterInjectProgress
  }
}
