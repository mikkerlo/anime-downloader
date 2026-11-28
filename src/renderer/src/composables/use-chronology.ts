// The chronology (the franchise's related anime) for the AnimeDetailView
// panel. Phase 5 slice 5b.1 (#118); from the resolved `chronology` source
// since #710.
//
// Self-contained: holds the related list + loading + collapsed UI state,
// exposes a `loadRelated(malId)` action. The caller (AnimeDetailView) decides
// when to fetch — typically on mount once `anime.value?.myAnimeListId` is
// known. Lifecycle hooks intentionally NOT registered here so the composable
// stays usable from Vitest without a component context.
//
// `loadRelated` waits for the trackers store's first accounts read, then reads
// the `chronology` source once. A MyAnimeList source is lazy: it sets
// `relatedDeferred` and fetches on the panel's first expand (once per mount),
// since its walk is one ~1 s request per title. `relatedDeferred` clears when
// that fetch settles, so a failed or empty walk hides the panel, as a failed
// read does. Every other source fetches at once.

import { ref, watch, type Ref } from 'vue'
import { useTrackersStore } from '../stores/trackers'

export function useChronology(): {
  shikiRelated: Ref<ShikiRelatedEntry[]>
  relatedLoading: Ref<boolean>
  relatedCollapsed: Ref<boolean>
  relatedDeferred: Ref<boolean>
  loadRelated: (malId: number) => Promise<void>
} {
  const trackers = useTrackersStore()
  const shikiRelated = ref<ShikiRelatedEntry[]>([])
  const relatedLoading = ref(false)
  const relatedCollapsed = ref(true)
  const relatedDeferred = ref(false)
  let deferredMalId: number | null = null

  function whenAccountsLoaded(): Promise<void> {
    if (trackers.accountsLoaded) return Promise.resolve()
    return new Promise((resolve) => {
      const stop = watch(
        () => trackers.accountsLoaded,
        (loaded) => {
          if (!loaded) return
          stop()
          resolve()
        }
      )
    })
  }

  async function fetchRelated(malId: number): Promise<void> {
    relatedLoading.value = true
    try {
      shikiRelated.value = await window.api.trackerGetRelated(malId)
    } catch (err) {
      console.error('Failed to load the chronology:', err)
    } finally {
      relatedLoading.value = false
    }
  }

  function fetchDeferred(): void {
    const malId = deferredMalId
    if (malId === null) return
    deferredMalId = null
    void fetchRelated(malId).finally(() => {
      relatedDeferred.value = false
    })
  }

  watch(relatedCollapsed, (collapsed) => {
    if (!collapsed) fetchDeferred()
  })

  async function loadRelated(malId: number): Promise<void> {
    if (!malId) return
    relatedLoading.value = true
    await whenAccountsLoaded()
    if (trackers.featureSource('chronology') === 'mal') {
      relatedLoading.value = false
      deferredMalId = malId
      relatedDeferred.value = true
      // Expanded while the accounts read was pending: fetch now.
      if (!relatedCollapsed.value) fetchDeferred()
      return
    }
    await fetchRelated(malId)
  }

  return { shikiRelated, relatedLoading, relatedCollapsed, relatedDeferred, loadRelated }
}
