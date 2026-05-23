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

export type LoadRelatedFn = (malId: number) => Promise<void>

export function useShikimori(deps: {
  anime: Ref<AnimeDetail | null>
  shikimoriStore: ReturnType<typeof useShikimoriStore>
}): {
  shikiUser: Ref<ShikiUser | null>
  shikiRate: Ref<ShikiUserRate | null>
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
  const shikiRate = ref<ShikiUserRate | null>(null)
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

  return {
    shikiUser,
    shikiRate,
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
