// Shikimori panel state + friends + details + sync indicator for
// AnimeDetailView. Phase 5 slice 5b.4 (#118).
//
// Owns all per-anime Shikimori state: the rate edit form refs (status,
// episodes, score, rewatches), the user check, friends list + collapsed,
// the Shikimori details (genres + description) + descExpanded.
//
// Consumes: anime ref + the shikimoriStore. Drives the rate edit form,
// mirrors the store's per-malId rate cache, and exposes shikiSave +
// triggerSyncNow.
//
// Lifecycle hooks (onMounted/onUnmounted) are NOT registered here — the
// component calls loadShikimoriData() from its own onMounted. The two
// rate-cache watchers ARE registered inside via vue's watch(), which
// binds to the caller's effect scope.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { useShikimoriStore } from '../stores/shikimori'
import type { useTrackersStore } from '../stores/trackers'

export type LoadRelatedFn = (malId: number) => Promise<void>

export function useShikimori(deps: {
  anime: Ref<AnimeDetail | null>
  shikimoriStore: ReturnType<typeof useShikimoriStore>
  trackersStore: ReturnType<typeof useTrackersStore>
}): {
  /**
   * A non-Shikimori `details` or `airing` source's details (#706), or null for
   * Shikimori, no source, or a miss not yet filled by `tracker:details-updated`.
   */
  trackerDetailsFor: (id: TrackerId | null) => TrackerDetails | null
  shikiUser: Ref<ShikiUser | null>
  shikiRate: Ref<ShikiUserRateResult | null>
  /** The rate came from main's cached list (#570): offline, or the read failed. */
  shikiRateStale: ComputedRef<boolean>
  shikiStatus: Ref<ShikiUserRateStatus>
  shikiEpisodes: Ref<number>
  shikiScore: Ref<number>
  shikiRewatches: Ref<number>
  shikiLoading: Ref<boolean>
  shikiSaving: Ref<boolean>
  shikiError: Ref<string>
  shikiUserChecked: Ref<boolean>
  shikiDetails: Ref<ShikiAnimeDetails | null>
  descExpanded: Ref<boolean>
  shikiDetailsDescription: ComputedRef<string>
  friendsRates: Ref<ShikiFriendRate[]>
  friendsLoading: Ref<boolean>
  friendsCollapsed: Ref<boolean>
  syncState: ComputedRef<'idle' | 'syncing'>
  lastSyncError: ComputedRef<string | null>
  loadShikimoriData: (loadRelated: LoadRelatedFn) => Promise<void>
  shikiSave: () => Promise<void>
  triggerSyncNow: () => Promise<void>
} {
  const shikiUser = ref<ShikiUser | null>(null)
  const shikiRate = ref<ShikiUserRateResult | null>(null)
  const shikiRateStale = computed(() => shikiRate.value?.stale === true)
  const shikiStatus = ref<ShikiUserRateStatus>('planned')
  const shikiEpisodes = ref(0)
  const shikiScore = ref(0)
  const shikiRewatches = ref(0)
  const shikiLoading = ref(false)
  const shikiSaving = ref(false)
  const shikiError = ref('')
  const shikiUserChecked = ref(false)
  const shikiDetails = ref<ShikiAnimeDetails | null>(null)
  const descExpanded = ref(false)
  const friendsRates = ref<ShikiFriendRate[]>([])
  const friendsLoading = ref(false)
  const friendsCollapsed = ref(false)

  const { syncStatus } = storeToRefs(deps.shikimoriStore)
  const syncState = computed(() => syncStatus.value.state)
  const lastSyncError = computed(() => syncStatus.value.lastSyncError)

  const shikiDetailsDescription = computed<string>(() => {
    if (!shikiDetails.value) return ''
    const src = shikiDetails.value.description
    if (src) {
      return src
        .replace(/\[\/?[a-zA-Z][^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }
    const html = shikiDetails.value.description_html
    if (!html) return ''
    let stripped = html.replace(/<br\s*\/?>/gi, ' ')
    let prev: string
    do {
      prev = stripped
      stripped = stripped.replace(/<[^>]*>/g, '')
    } while (stripped !== prev)
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&nbsp;': ' ',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'"
    }
    return stripped
      .replace(/&(?:amp|nbsp|lt|gt|quot|#39);/gi, (m) => entities[m.toLowerCase()] ?? m)
      .replace(/\s+/g, ' ')
      .trim()
  })

  async function loadShikimoriData(loadRelated: LoadRelatedFn): Promise<void> {
    try {
      shikiUser.value = await window.api.shikimoriGetUser()
    } catch (err) {
      console.error('Failed to load Shikimori user:', err)
    } finally {
      shikiUserChecked.value = true
    }
    if (!deps.anime.value?.myAnimeListId) return

    const relatedPromise = loadRelated(deps.anime.value.myAnimeListId)

    if (!shikiUser.value) {
      await relatedPromise
      return
    }

    shikiLoading.value = true
    friendsLoading.value = true

    // Load rate and friends in parallel, neither blocks the other
    const ratePromise = window.api
      .shikimoriGetRate(deps.anime.value.myAnimeListId)
      .then((rate) => {
        shikiRate.value = rate
        if (rate) {
          shikiStatus.value = rate.status
          shikiEpisodes.value = rate.episodes
          shikiScore.value = rate.score
          shikiRewatches.value = rate.rewatches ?? 0
        }
      })
      .catch((err) => console.error('Failed to load Shikimori rate:', err))
      .finally(() => {
        shikiLoading.value = false
      })

    const friendsPromise = window.api
      .shikimoriGetFriendsRates(deps.anime.value.myAnimeListId)
      .then((rates) => {
        friendsRates.value = rates
      })
      .catch((err) => console.error('Failed to load friends rates:', err))
      .finally(() => {
        friendsLoading.value = false
      })

    const detailsPromise = window.api
      .shikimoriGetAnimeDetails(deps.anime.value.myAnimeListId)
      .then((details) => {
        shikiDetails.value = details
      })
      .catch((err) => console.error('Failed to load Shikimori details:', err))

    await Promise.all([ratePromise, friendsPromise, detailsPromise, relatedPromise])
  }

  async function shikiSave(): Promise<void> {
    if (!deps.anime.value?.myAnimeListId) return
    shikiSaving.value = true
    shikiError.value = ''
    try {
      const rate = await window.api.shikimoriUpdateRate(
        deps.anime.value.myAnimeListId,
        shikiEpisodes.value,
        shikiStatus.value,
        shikiScore.value,
        shikiRewatches.value
      )
      shikiRate.value = rate
      shikiRewatches.value = rate.rewatches ?? shikiRewatches.value
    } catch (err) {
      shikiError.value = String(err)
    } finally {
      shikiSaving.value = false
    }
  }

  async function triggerSyncNow(): Promise<void> {
    await deps.shikimoriStore.triggerSync()
  }

  // Auto-status nudge when the user adjusts the episode counter. Matches the
  // original component behavior: at numberOfEpisodes → 'completed';
  // any positive value → 'rewatching' if previously 'completed', else
  // 'watching' if previously 'planned'.
  watch(shikiEpisodes, (eps) => {
    if (deps.anime.value?.numberOfEpisodes && eps >= deps.anime.value.numberOfEpisodes) {
      shikiStatus.value = 'completed'
    } else if (eps > 0) {
      if (shikiStatus.value === 'completed') {
        shikiStatus.value = 'rewatching'
      } else if (shikiStatus.value === 'planned') {
        shikiStatus.value = 'watching'
      }
    }
  })

  // Mirror store-owned rate cache for this anime's malId into the editable
  // refs. Driven by the shikimori store's broadcast.
  watch(
    () =>
      deps.anime.value?.myAnimeListId
        ? deps.shikimoriStore.rateByMalId(deps.anime.value.myAnimeListId)
        : null,
    (entry) => {
      if (!entry) return
      shikiRate.value = {
        id: entry.rate.id,
        score: entry.rate.score,
        status: entry.rate.status,
        episodes: entry.rate.episodes,
        rewatches: entry.rate.rewatches ?? 0,
        target_id: entry.rate.target_id,
        target_type: 'Anime'
      }
      shikiStatus.value = entry.rate.status
      shikiEpisodes.value = entry.rate.episodes
      shikiScore.value = entry.rate.score
      shikiRewatches.value = entry.rate.rewatches ?? 0
    }
  )

  // Mirror store-owned per-malId details cache. Driven by the shikimori
  // store's onShikimoriAnimeDetailsUpdated broadcast.
  watch(
    () =>
      deps.anime.value?.myAnimeListId
        ? deps.shikimoriStore.animeDetailsByMalId(deps.anime.value.myAnimeListId)
        : null,
    (details) => {
      if (details) shikiDetails.value = details
    }
  )

  // ---- A non-Shikimori `details` / `airing` source (#706) -------------------
  // Read once per source from main's cache (`tracker:get-details`, which kicks
  // the prefetch on a miss), then rewritten from the trackers store's
  // `tracker:details-updated` entries, as the Shikimori watch above is. Keyed
  // on the resolved sources as well as the MAL id, so a source switch reads
  // the new tracker.
  const trackerDetails = ref<Partial<Record<TrackerId, TrackerDetails>>>({})
  const otherSources = computed<TrackerId[]>(() => {
    const ids = new Set<TrackerId>()
    for (const feature of ['details', 'airing'] as const) {
      const id = deps.trackersStore.featureSource(feature)
      if (id && id !== 'shikimori') ids.add(id)
    }
    return [...ids]
  })
  let detailsMalId: number | null = null

  watch(
    () => [deps.anime.value?.myAnimeListId ?? null, otherSources.value.join(',')] as const,
    ([malId]) => {
      if (malId !== detailsMalId) {
        detailsMalId = malId
        trackerDetails.value = {}
      }
      if (!malId) return
      for (const id of otherSources.value) {
        if (trackerDetails.value[id]) continue
        void window.api
          .trackerGetDetails(malId, id)
          .then((details) => {
            // A newer broadcast, or another title, wins over this read.
            if (!details || detailsMalId !== malId || trackerDetails.value[id]) return
            trackerDetails.value = { ...trackerDetails.value, [id]: details }
          })
          .catch((err) => console.error('Failed to load tracker details:', err))
      }
    },
    { immediate: true }
  )

  watch(
    () => {
      const malId = deps.anime.value?.myAnimeListId
      if (!malId) return []
      return otherSources.value.map((id) => [id, deps.trackersStore.detailsFor(id, malId)] as const)
    },
    (entries) => {
      for (const [id, details] of entries) {
        if (details && trackerDetails.value[id] !== details) {
          trackerDetails.value = { ...trackerDetails.value, [id]: details }
        }
      }
    }
  )

  function trackerDetailsFor(id: TrackerId | null): TrackerDetails | null {
    if (!id || id === 'shikimori') return null
    return trackerDetails.value[id] ?? null
  }

  return {
    trackerDetailsFor,
    shikiUser,
    shikiRate,
    shikiRateStale,
    shikiStatus,
    shikiEpisodes,
    shikiScore,
    shikiRewatches,
    shikiLoading,
    shikiSaving,
    shikiError,
    shikiUserChecked,
    shikiDetails,
    descExpanded,
    shikiDetailsDescription,
    friendsRates,
    friendsLoading,
    friendsCollapsed,
    syncState,
    lastSyncError,
    loadShikimoriData,
    shikiSave,
    triggerSyncNow
  }
}
