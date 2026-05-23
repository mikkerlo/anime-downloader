// Per-anime translation type + author selection for AnimeDetailView.
// Phase 5 slice 5b.1 (#118).
//
// Owns translationType + selectedAuthor refs and the
// applyDownloadedTranslationDefault heuristic that picks the most
// frequently-downloaded type+author combo on first load. The dep snapshot
// (episodeMeta + availableAuthors) is passed as a parameter to the helper,
// not held as a reactive input — this avoids a circular construction with
// useEpisodeList, which derives availableAuthors from translationType.

import { ref, type Ref } from 'vue'

export function useAnimeDetailPrefs(): {
  translationType: Ref<string>
  selectedAuthor: Ref<string>
  applyDownloadedTranslationDefault: (snapshot: {
    episodeMeta: Record<string, EpisodeMeta[]>
    availableAuthors: [string, number][]
  }) => void
  loadInitialTranslationType: (initialPrefsValue?: string) => Promise<void>
} {
  const translationType = ref('subRu')
  const selectedAuthor = ref('')

  async function loadInitialTranslationType(initialPrefsValue?: string): Promise<void> {
    if (initialPrefsValue) {
      translationType.value = initialPrefsValue
      return
    }
    translationType.value = ((await window.api.getSetting('translationType')) as string) || 'subRu'
  }

  function applyDownloadedTranslationDefault(snapshot: {
    episodeMeta: Record<string, EpisodeMeta[]>
    availableAuthors: [string, number][]
  }): void {
    const counts = new Map<string, { type: string; author: string; count: number }>()
    for (const metaArr of Object.values(snapshot.episodeMeta)) {
      for (const m of metaArr) {
        const key = `${m.translationType}|${m.author}`
        const existing = counts.get(key)
        if (existing) existing.count++
        else counts.set(key, { type: m.translationType, author: m.author, count: 1 })
      }
    }
    if (counts.size === 0) return
    let best: { type: string; author: string; count: number } | null = null
    for (const entry of counts.values()) {
      if (!best || entry.count > best.count) best = entry
    }
    if (!best) return
    translationType.value = best.type
    if (best.author && snapshot.availableAuthors.some(([a]) => a === best!.author)) {
      selectedAuthor.value = best.author
    }
  }

  return {
    translationType,
    selectedAuthor,
    applyDownloadedTranslationDefault,
    loadInitialTranslationType
  }
}
