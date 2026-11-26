// The detail page's rate panel state (#704, epic #688), renamed from
// use-shikimori.ts (Phase 5 slice 5b.4, #118).
//
// Owns the rate edit form (status, episodes, score, rewatches) for the
// **primary** tracker, its sync state, and `resumeProgress` for Continue.
// Reads go through `tracker:get-rate`, saves through `tracker:update-rate`
// (which fans out to the mirrors), live updates come from the trackers store's
// `rateFor(primary, malId)`.
//
// - The rate load waits for the store's `accountsLoaded`, then reads
//   `primary`; with no primary it loads nothing.
// - `loading` starts true on every mount. It clears in the `finally` of a load
//   whose tracker and MAL id are still current, never in a dropped one, or at
//   once with no primary or no MAL id, so Continue never readies on the local
//   target first.
// - A primary switch drops the form's edits and reloads from the new primary.
//
// Still Shikimori-only, as before: the Shikimori user read (`shikiUser`,
// `shikiUserChecked`), the friends' rates (#712 moves them) and the details
// (#706 moves them). Each is one block below.
//
// Lifecycle hooks are NOT registered here: the component calls
// loadTrackerData() from its own onMounted. The watchers bind to the caller's
// effect scope.

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { useShikimoriStore } from '../stores/shikimori'
import type { useTrackersStore } from '../stores/trackers'
import type { ResumeProgress } from './use-episode-downloads'

export type LoadRelatedFn = (malId: number) => Promise<void>

function sameValues(a: TrackerRateValues | null, b: TrackerRateValues | null): boolean {
  if (!a || !b) return a === b
  return (
    a.episodes === b.episodes &&
    a.status === b.status &&
    a.score === b.score &&
    a.rewatches === b.rewatches
  )
}

export function useTrackerRate(deps: {
  anime: Ref<AnimeDetail | null>
  shikimoriStore: ReturnType<typeof useShikimoriStore>
  trackersStore: ReturnType<typeof useTrackersStore>
}): {
  /** The last loaded, saved or live rate of the primary for this title. */
  rate: Ref<TrackerRateResult | null>
  /** The rate came from main's cached list (#570): offline, or the read failed. */
  rateStale: ComputedRef<boolean>
  /** The primary's own media id where it isn't the MAL id (AniList, #703). */
  mediaId: Ref<number | undefined>
  rateStatus: Ref<ShikiUserRateStatus>
  rateEpisodes: Ref<number>
  rateScore: Ref<number>
  rateRewatches: Ref<number>
  loading: Ref<boolean>
  saving: Ref<boolean>
  saveError: Ref<string>
  resumeProgress: ComputedRef<ResumeProgress>
  syncState: ComputedRef<'idle' | 'syncing'>
  lastSyncError: ComputedRef<string | null>
  shikiUser: Ref<ShikiUser | null>
  shikiUserChecked: Ref<boolean>
  shikiDetails: Ref<ShikiAnimeDetails | null>
  descExpanded: Ref<boolean>
  shikiDetailsDescription: ComputedRef<string>
  friendsRates: Ref<ShikiFriendRate[]>
  friendsLoading: Ref<boolean>
  friendsCollapsed: Ref<boolean>
  loadTrackerData: (loadRelated: LoadRelatedFn) => Promise<void>
  hydrateSyncState: () => void
  save: () => Promise<void>
  triggerSyncNow: () => Promise<void>
} {
  const trackers = deps.trackersStore

  const rate = ref<TrackerRateResult | null>(null)
  const rateStale = computed(() => rate.value?.stale === true)
  const mediaId = ref<number | undefined>(undefined)
  const rateStatus = ref<ShikiUserRateStatus>('planned')
  const rateEpisodes = ref(0)
  const rateScore = ref(0)
  const rateRewatches = ref(0)
  // Per mount, not the app-lifetime `accountsLoaded` (#704 §3).
  const loading = ref(true)
  const saving = ref(false)
  const saveError = ref('')
  const shikiUser = ref<ShikiUser | null>(null)
  const shikiUserChecked = ref(false)
  const shikiDetails = ref<ShikiAnimeDetails | null>(null)
  const descExpanded = ref(false)
  const friendsRates = ref<ShikiFriendRate[]>([])
  const friendsLoading = ref(false)
  const friendsCollapsed = ref(false)

  const malIdOf = (): number | undefined => deps.anime.value?.myAnimeListId || undefined

  const syncStatus = computed(() => trackers.syncStatusFor(trackers.primary))
  const syncState = computed(() => syncStatus.value.state)
  const lastSyncError = computed(() => syncStatus.value.lastSyncError)

  const resumeProgress = computed<ResumeProgress>(() => ({
    checked: trackers.accountsLoaded,
    hasAccount: trackers.anyAccount,
    // A title with no MAL id never loads a rate, so nothing is pending for it.
    loading: loading.value && malIdOf() !== undefined,
    status: rate.value?.values?.status ?? null,
    episodes: rateEpisodes.value
  }))

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

  function fillForm(values: TrackerRateValues): void {
    rateStatus.value = values.status
    rateEpisodes.value = values.episodes
    rateScore.value = values.score
    rateRewatches.value = values.rewatches ?? 0
  }

  function resetForm(): void {
    rate.value = null
    mediaId.value = undefined
    rateStatus.value = 'planned'
    rateEpisodes.value = 0
    rateScore.value = 0
    rateRewatches.value = 0
  }

  // Resolved by a watcher registered here, in the caller's effect scope: the
  // load awaits the Shikimori user read first, so a watch created then would
  // outlive an unmount and still load a rate for a closed page.
  let accountsWaiters: (() => void)[] = []
  watch(
    () => trackers.accountsLoaded,
    (loaded) => {
      if (!loaded) return
      const waiters = accountsWaiters
      accountsWaiters = []
      waiters.forEach((resolve) => resolve())
    }
  )

  function whenAccountsLoaded(): Promise<void> {
    if (trackers.accountsLoaded) return Promise.resolve()
    return new Promise((resolve) => accountsWaiters.push(resolve))
  }

  // Set once a load has read `primary`: from then on a primary switch reloads.
  let rateRequested = false

  function loadPrimaryRate(): Promise<void> {
    rateRequested = true
    const malId = malIdOf()
    const id = trackers.primary
    if (!malId || !id) {
      loading.value = false
      return Promise.resolve()
    }
    loading.value = true
    // A response for a tracker that is no longer the primary, or for another
    // title, is dropped whole, `finally` included (#704 §9).
    const current = (): boolean => trackers.primary === id && malIdOf() === malId
    return window.api
      .trackerGetRate(id, malId)
      .then((result) => {
        if (!current()) return
        // `tracker:get-rate` answers the remote or cached row; the form shows
        // the projection, so a queued `after` wins (#704 §2).
        const queued = trackers.queuedAfterByTracker[id]?.[malId]
        rate.value = queued && result ? { ...result, values: { ...queued } } : result
        mediaId.value = result?.mediaId
        if (rate.value?.values) fillForm(rate.value.values)
      })
      .catch((err) => console.error(`Failed to load the ${id} rate:`, err))
      .finally(() => {
        if (current()) loading.value = false
      })
  }

  async function loadTrackerData(loadRelated: LoadRelatedFn): Promise<void> {
    if (!malIdOf()) loading.value = false
    try {
      shikiUser.value = await window.api.shikimoriGetUser()
    } catch (err) {
      console.error('Failed to load Shikimori user:', err)
    } finally {
      shikiUserChecked.value = true
    }
    const malId = malIdOf()
    if (!malId) return

    const relatedPromise = loadRelated(malId)
    const ratePromise = whenAccountsLoaded().then(loadPrimaryRate)

    if (!shikiUser.value) {
      await Promise.all([relatedPromise, ratePromise])
      return
    }

    friendsLoading.value = true

    const friendsPromise = window.api
      .shikimoriGetFriendsRates(malId)
      .then((rates) => {
        friendsRates.value = rates
      })
      .catch((err) => console.error('Failed to load friends rates:', err))
      .finally(() => {
        friendsLoading.value = false
      })

    const detailsPromise = window.api
      .shikimoriGetAnimeDetails(malId)
      .then((details) => {
        shikiDetails.value = details
      })
      .catch((err) => console.error('Failed to load Shikimori details:', err))

    await Promise.all([ratePromise, friendsPromise, detailsPromise, relatedPromise])
  }

  // The primary's sync status and queue length, on mount and on a switch; later
  // updates arrive through the store's broadcasts.
  function hydrateSyncState(): void {
    const id = trackers.primary
    if (!id) return
    void trackers.refreshOfflineQueueLength(id).catch(() => {})
    void trackers.refreshSyncStatus(id).catch(() => {})
  }

  async function save(): Promise<void> {
    const malId = malIdOf()
    if (!malId) return
    saving.value = true
    saveError.value = ''
    try {
      const values = await window.api.trackerUpdateRate(malId, {
        episodes: rateEpisodes.value,
        status: rateStatus.value,
        score: rateScore.value,
        rewatches: rateRewatches.value
      })
      rate.value = { values, stale: false }
      rateRewatches.value = values.rewatches ?? rateRewatches.value
    } catch (err) {
      saveError.value = String(err)
    } finally {
      saving.value = false
    }
  }

  async function triggerSyncNow(): Promise<void> {
    const id = trackers.primary
    if (id) await trackers.triggerSync(id)
  }

  // Auto-status nudge when the user adjusts the episode counter. Matches the
  // original component behavior: at numberOfEpisodes → 'completed';
  // any positive value → 'rewatching' if previously 'completed', else
  // 'watching' if previously 'planned'.
  watch(rateEpisodes, (eps) => {
    if (deps.anime.value?.numberOfEpisodes && eps >= deps.anime.value.numberOfEpisodes) {
      rateStatus.value = 'completed'
    } else if (eps > 0) {
      if (rateStatus.value === 'completed') {
        rateStatus.value = 'rewatching'
      } else if (rateStatus.value === 'planned') {
        rateStatus.value = 'watching'
      }
    }
  })

  // A primary switch while the page is open: the edits go, the new primary's
  // rate and sync state load. Registered before the `rateFor` watcher, so the
  // new primary's projection fills the reset form in the same flush.
  watch(
    () => trackers.primary,
    () => {
      if (!rateRequested) return
      resetForm()
      void loadPrimaryRate()
      hydrateSyncState()
    }
  )

  // Mirror the primary's projected rate (its cache overlaid with its last
  // queued `after`, #697) into the editable refs. Compared by value: the
  // overlay is a fresh object on every queue event.
  watch(
    () => {
      const malId = malIdOf()
      const id = trackers.primary
      return malId && id ? trackers.rateFor(id, malId) : null
    },
    (values, prev) => {
      if (!values || sameValues(values, prev ?? null)) return
      rate.value = { values: { ...values }, stale: false }
      fillForm(values)
    }
  )

  // Mirror store-owned per-malId details cache. Driven by the shikimori
  // store's onShikimoriAnimeDetailsUpdated broadcast.
  watch(
    () => {
      const malId = malIdOf()
      return malId ? deps.shikimoriStore.animeDetailsByMalId(malId) : null
    },
    (details) => {
      if (details) shikiDetails.value = details
    }
  )

  return {
    rate,
    rateStale,
    mediaId,
    rateStatus,
    rateEpisodes,
    rateScore,
    rateRewatches,
    loading,
    saving,
    saveError,
    resumeProgress,
    syncState,
    lastSyncError,
    shikiUser,
    shikiUserChecked,
    shikiDetails,
    descExpanded,
    shikiDetailsDescription,
    friendsRates,
    friendsLoading,
    friendsCollapsed,
    loadTrackerData,
    hydrateSyncState,
    save,
    triggerSyncNow
  }
}
