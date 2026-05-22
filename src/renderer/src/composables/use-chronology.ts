// Shikimori chronology (related anime in the franchise) for the
// AnimeDetailView panel. Phase 5 slice 5b.1 (#118).
//
// Self-contained: holds the related list + loading + collapsed UI state,
// exposes a `loadRelated(malId)` action. The caller (AnimeDetailView) decides
// when to fetch — typically on mount once `anime.value?.myAnimeListId` is
// known. Lifecycle hooks intentionally NOT registered here so the composable
// stays usable from Vitest without a component context.

import { ref, type Ref } from 'vue'

export function useChronology(): {
  shikiRelated: Ref<ShikiRelatedEntry[]>
  relatedLoading: Ref<boolean>
  relatedCollapsed: Ref<boolean>
  loadRelated: (malId: number) => Promise<void>
} {
  const shikiRelated = ref<ShikiRelatedEntry[]>([])
  const relatedLoading = ref(false)
  const relatedCollapsed = ref(true)

  async function loadRelated(malId: number): Promise<void> {
    if (!malId) return
    relatedLoading.value = true
    try {
      shikiRelated.value = await window.api.shikimoriGetRelated(malId)
    } catch (err) {
      console.error('Failed to load Shikimori related:', err)
    } finally {
      relatedLoading.value = false
    }
  }

  return { shikiRelated, relatedLoading, relatedCollapsed, loadRelated }
}
