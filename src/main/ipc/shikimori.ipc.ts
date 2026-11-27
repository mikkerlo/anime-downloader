import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { SHIKIMORI_ORIGIN } from '@shared/shikimori'
import * as shikimori from '../shikimori'
import {
  buildTasteProfile,
  filterOutRated,
  rankRecommendations,
  splitAiringRow,
  type RankedRecommendation,
  type RecommendationCandidate,
  type TasteRate
} from '../recommendations'
import { rateFromCacheEntry, type StoredRateEntry } from '../lib/shikimori-rate-cache'
import { type CalendarEntry, type ShikiSyncStatus } from '../services/shikimori-sync'
import { createShikimoriCalendar } from '../services/shikimori-sync/calendar'
import { freshResult as fresh, staleResult as stale } from '../trackers/display-snapshots'
import {
  cachedShikimoriRate,
  createShikimoriPrimary,
  shikimoriRateReply,
  syntheticRate
} from '../services/trackers/shikimori-primary'
import type { TrackerStatus } from '../services/trackers/rates'
import { assertMayConnect } from '../trackers/flags'
import { isConnected } from '../trackers/primary'
import { shikimoriAuthFlow } from '../trackers/shikimori.provider'
import type { AppDeps } from './index'

const SHIKI_BASE = SHIKIMORI_ORIGIN

export function register({
  store,
  shikimoriSyncService: sync,
  trackers,
  trackerRates,
  trackerLifecycle,
  trackerAuth,
  lookupByMalIds,
  maybeBroadcastCleanupPrompt,
  runAutoDownloadTick,
  broadcast,
  offlineService,
  syncRunner,
  secondTrackerEnabled
}: AppDeps) {
  // The shared refresh (#694): the calendar, recs and `SHIKIMORI_RATES_REFRESHED`
  // go with the instance's `refreshRates`, and this tail runs after it.
  trackerRates.setRefreshHooks('shikimori', {
    afterBackgroundRefresh() {
      void sync.syncShikimoriQueue()
      void sync.prefetchShikimoriDetails()
      void runAutoDownloadTick('rates-refreshed').catch((err) =>
        console.warn('[auto-dl] rates-refreshed tick failed:', err)
      )
    },
    afterFetch() {
      void sync.prefetchShikimoriDetails()
    }
  })

  function refreshShikimoriRatesInBackground(): void {
    trackerRates.refreshInBackground('shikimori')
  }

  // Friends page cards (#179): friend list joined with presence + per-friend
  // stats (titles/mean/mutual + current watch). Cache-first like the rate
  // cache; `null` when logged out. `mutual` is shared rated titles with the
  // signed-in user, derived from the cached own-rate list.
  async function fetchAndCacheShikimoriFriends(): Promise<ShikiFriendCard[] | null> {
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) return null
    const accessToken = await shikimori.ensureFreshToken(store)
    const ownRates = store.get('shikimoriUserRates') as {
      rate: { target_id?: number }
      shikiAnime?: { id: number }
    }[]
    const ownMalIds = new Set<number>()
    for (const e of ownRates) {
      const malId = e.rate?.target_id ?? e.shikiAnime?.id
      if (malId) ownMalIds.add(malId)
    }
    const cards = await shikimori.getFriendsWithStats(accessToken, user.id, ownMalIds)
    // Resolve each friend's current-watch MAL id to a smotret-anime id so the
    // card can deep-link in-app (one batched lookup for all friends).
    const watchMalIds = cards.map((c) => c.watching?.malId).filter((m): m is number => m != null)
    if (watchMalIds.length > 0) {
      const malMap = await lookupByMalIds(watchMalIds)
      for (const c of cards) {
        if (c.watching) c.watching.animeId = malMap[c.watching.malId]?.id ?? null
      }
    }
    store.set('shikimoriFriends', cards)
    return cards
  }

  function refreshShikimoriFriendsInBackground(): void {
    fetchAndCacheShikimoriFriends()
      .then((cards) => {
        if (cards) broadcast(EVENT_CHANNELS.SHIKIMORI_FRIENDS_REFRESHED, cards)
      })
      .catch((err) => console.warn('[shikimori] friends background refresh failed:', err))
  }

  // Assemble the profile-dashboard payload (#178): identity from the cached
  // user, status-breakdown + score-distribution from the Shikimori stats block,
  // and titles/episodes/mean/days/genres derived from data already cached
  // locally (the rate list + pre-fetched anime details). Returns null when
  // logged out so the renderer shows the connect affordance instead of erroring.
  async function fetchAndCacheShikimoriProfile(): Promise<ShikimoriProfile | null> {
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) return null
    const accessToken = await shikimori.ensureFreshToken(store)
    const stats = await shikimori.getUserStats(accessToken, user.id)

    let friendsCount = 0
    try {
      friendsCount = (await shikimori.getFriends(accessToken, user.id)).length
    } catch (err) {
      console.warn('[shikimori] profile: friends count failed:', err)
    }

    const rates = store.get('shikimoriUserRates') as {
      rate: { target_id?: number; episodes: number; score: number }
      shikiAnime?: { id: number }
    }[]
    const detailsCache = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >

    const episodes = rates.reduce((sum, e) => sum + (e.rate?.episodes ?? 0), 0)
    let scoreSum = 0
    let scoreCount = 0
    stats.scores.forEach((count, i) => {
      scoreSum += (i + 1) * count
      scoreCount += count
    })
    const mean = scoreCount > 0 ? scoreSum / scoreCount : 0

    const genreCounts = new Map<string, number>()
    for (const e of rates) {
      const malId = e.rate?.target_id ?? e.shikiAnime?.id
      const details = malId != null ? detailsCache[String(malId)]?.details : undefined
      for (const g of details?.genres ?? []) {
        const name = g.russian || g.name
        if (name) genreCounts.set(name, (genreCounts.get(name) ?? 0) + 1)
      }
    }
    const genres = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, n]) => ({ name, n }))

    const profile: ShikimoriProfile = {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      friendsCount,
      lists: stats.statuses.map((s) => ({ status: s.name, n: s.size })),
      scores: stats.scores,
      genres,
      // ~24 min per episode → days.
      stats: { titles: rates.length, episodes, mean, daysWatched: (episodes * 24) / 1440 }
    }
    store.set('shikimoriProfile', profile)
    return profile
  }

  function refreshShikimoriProfileInBackground(): void {
    fetchAndCacheShikimoriProfile()
      .then((profile) => {
        if (profile) broadcast(EVENT_CHANNELS.SHIKIMORI_PROFILE_REFRESHED, profile)
      })
      .catch((err) => console.warn('[shikimori] profile background refresh failed:', err))
  }

  // Recommendations feed (#193). Shikimori has no personalized endpoint, so we
  // build it locally: seed from the user's highest-rated titles, fan out
  // `/similar` per seed, then rank the merged pool with the pure engine in
  // `recommendations.ts`. Results are resolved to smotret-anime ids (deep-link)
  // and cached cache-first like the profile/friends payloads. `null` when logged
  // out; `[]` when the user hasn't rated enough to seed (renderer shows a hint).
  const RECS_SEED_LIMIT = 8
  const RECS_RESULT_LIMIT = 40
  // How many of the top candidates to fetch genres for so the genre term in the
  // ranking actually fires (candidate genres aren't in the rated-anime detail
  // cache by default). Bounded + throttled to respect the rate limit; results
  // are cached so rebuilds are cheap.
  const RECS_ENRICH_LIMIT = 25
  const RECS_ENRICH_DELAY_MS = 250
  // "Airing now for you" (#206): how many top-ranked ongoing titles to pull as
  // a second candidate pool, and how many survive into the row after the
  // genre-affinity gate.
  const RECS_AIRING_FETCH_LIMIT = 30
  const RECS_AIRING_ROW_LIMIT = 10
  const SEED_STATUSES: shikimori.ShikiUserRateStatus[] = ['completed', 'watching', 'rewatching']

  // Genres of an anime from the shared detail cache, fetching + caching on miss
  // (the same `shikimoriAnimeDetails` store the detail-prefetch worker fills, so
  // an enrichment fetch also benefits the AnimeDetailView panel). Read-modify-
  // write is synchronous after the await, so it can't clobber a concurrent
  // worker write.
  async function fetchAndCacheAnimeDetails(
    accessToken: string,
    malId: number
  ): Promise<shikimori.ShikiAnimeDetails> {
    const cache = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >
    const hit = cache[String(malId)]
    if (hit) return hit.details
    const details = await shikimori.getAnimeDetails(accessToken, malId)
    const fresh = store.get('shikimoriAnimeDetails') as typeof cache
    fresh[String(malId)] = { details, fetchedAt: Date.now() }
    store.set('shikimoriAnimeDetails', fresh)
    broadcast(EVENT_CHANNELS.SHIKIMORI_ANIME_DETAILS_UPDATED, { malId, details })
    return details
  }

  // Every MAL id on the user's list (any status), read from the live rate
  // cache. Used both at build time and to re-validate the cached feed on read.
  function ratedMalIdSet(): Set<number> {
    const rates = store.get('shikimoriUserRates') as {
      rate: { target_id?: number }
      shikiAnime?: { id: number }
    }[]
    const set = new Set<number>()
    for (const e of rates) {
      const malId = e.rate?.target_id ?? e.shikiAnime?.id
      if (malId) set.add(malId)
    }
    return set
  }

  // A rebuild is the most expensive refresh in the app (franchise + /similar
  // fan-out per seed, plus genre enrichment), and both the cache-hit read path
  // and the Refresh button can trigger one — dedupe concurrent callers onto a
  // single in-flight build instead of stacking rebuilds (PR #194 review).
  let recommendationsBuild: Promise<RecommendationEntry[] | null> | null = null
  function fetchAndCacheShikimoriRecommendations(): Promise<RecommendationEntry[] | null> {
    if (!recommendationsBuild) {
      recommendationsBuild = buildShikimoriRecommendations().finally(() => {
        recommendationsBuild = null
      })
    }
    return recommendationsBuild
  }

  async function buildShikimoriRecommendations(): Promise<RecommendationEntry[] | null> {
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) return null
    const accessToken = await shikimori.ensureFreshToken(store)

    const rates = store.get('shikimoriUserRates') as {
      rate: { target_id?: number; status: shikimori.ShikiUserRateStatus; score: number }
      shikiAnime?: { id: number; name: string; russian: string }
    }[]
    const detailsCache = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >

    const malIdOf = (e: (typeof rates)[number]): number | undefined =>
      e.rate?.target_id ?? e.shikiAnime?.id
    const genresOf = (malId: number): string[] =>
      (detailsCache[String(malId)]?.details?.genres ?? [])
        .map((g) => g.russian || g.name)
        .filter((n): n is string => Boolean(n))
    const absoluteImage = (url: string): string =>
      url.startsWith('http') ? url : `${SHIKI_BASE}${url}`

    const tasteRates: TasteRate[] = []
    for (const e of rates) {
      const malId = malIdOf(e)
      if (!malId) continue
      tasteRates.push({
        malId,
        status: e.rate.status,
        score: e.rate.score ?? 0,
        genres: genresOf(malId)
      })
    }
    const taste = buildTasteProfile(tasteRates)

    const seeds = rates
      .map((e) => ({ e, malId: malIdOf(e) }))
      .filter(
        (s): s is { e: (typeof rates)[number]; malId: number } =>
          s.malId != null && s.e.rate.score > 0 && SEED_STATUSES.includes(s.e.rate.status)
      )
      .sort((a, b) => b.e.rate.score - a.e.rate.score)
      .slice(0, RECS_SEED_LIMIT)

    if (seeds.length === 0) {
      store.set('shikimoriRecommendations', [])
      return []
    }

    // Exclusion set = everything already rated, plus every entry in the
    // franchise of any seed (other seasons/sequels/recaps). `/similar` happily
    // returns sibling cours as "similar", but a continuation of a show the user
    // has watched is not discovery — it belongs in the Chronology panel. Built
    // up front (before the `/similar` pass) so a candidate is dropped no matter
    // which seed surfaces it (#193 follow-up).
    const excludedIds = new Set<number>(taste.ratedMalIds)
    for (const { malId } of seeds) {
      try {
        const franchise = await shikimori.getFranchise(malId)
        for (const node of franchise.nodes) excludedIds.add(node.id)
      } catch (err) {
        console.warn('[shikimori] recommendations: franchise fetch failed for', malId, err)
      }
    }

    const candidatesByMal = new Map<number, RecommendationCandidate>()
    for (const { e, malId } of seeds) {
      let similar: shikimori.ShikiSimilarAnime[]
      try {
        similar = await shikimori.getSimilar(accessToken, malId)
      } catch (err) {
        console.warn('[shikimori] recommendations: similar fetch failed for', malId, err)
        continue
      }
      const seedTitle = e.shikiAnime?.russian || e.shikiAnime?.name || 'a show you rated'
      const seed = { title: seedTitle, score: e.rate.score }
      for (const s of similar) {
        if (excludedIds.has(s.id)) continue
        const existing = candidatesByMal.get(s.id)
        if (existing) {
          existing.seeds.push(seed)
        } else {
          candidatesByMal.set(s.id, {
            malId: s.id,
            title: s.russian || s.name,
            posterUrl: absoluteImage(s.image.preview || s.image.x96 || s.image.original),
            kind: s.kind,
            communityScore: Number(s.score) || 0,
            genres: genresOf(s.id),
            seeds: [seed]
          })
        }
      }
    }

    // Second candidate pool (#206): the top currently-airing titles. `/similar`
    // is community-derived and lags for brand-new shows, so a just-started
    // season may not be surfaced by any seed — this pool closes that sourcing
    // gap. The `excludedIds` guard must be applied here explicitly (it lives
    // inline in the `/similar` loop above, and `rankRecommendations` only
    // checks rated ids), or an airing sequel of a watched show would leak into
    // the row. A failed fetch degrades to the similar-only pool.
    try {
      const ongoing = await shikimori.getOngoingRanked(accessToken, RECS_AIRING_FETCH_LIMIT)
      for (const a of ongoing) {
        if (excludedIds.has(a.id)) continue
        const existing = candidatesByMal.get(a.id)
        if (existing) {
          existing.airing = true
        } else {
          candidatesByMal.set(a.id, {
            malId: a.id,
            title: a.russian || a.name,
            posterUrl: absoluteImage(a.image.preview || a.image.x96 || a.image.original),
            kind: a.kind,
            communityScore: Number(a.score) || 0,
            genres: genresOf(a.id),
            seeds: [],
            airing: true
          })
        }
      }
    } catch (err) {
      console.warn('[shikimori] recommendations: ongoing fetch failed', err)
    }

    // Enrich the top candidates with genres so the genre-affinity term in the
    // final ranking can fire. A preliminary rank (genre term mostly dormant —
    // most candidates have no cached genres yet) picks which candidates are
    // worth a detail fetch; we mutate their `genres` in place (same object
    // refs live in `candidatesByMal`), then re-rank with the genre signal live.
    // Airing candidates are enriched unconditionally: seedless, they score only
    // the popularity term in the prelim rank and would never make the cut —
    // yet genres are exactly what gates them into the row. The pool is bounded
    // (RECS_AIRING_FETCH_LIMIT), so this adds at most ~7.5 s to a rebuild at
    // the 250 ms throttle, and nothing when genres are already cached.
    const allCandidates = [...candidatesByMal.values()]
    const prelim = rankRecommendations(allCandidates, taste, RECS_ENRICH_LIMIT)
    const enrichIds = new Set<number>(prelim.map((r) => r.malId))
    for (const c of allCandidates) {
      if (c.airing) enrichIds.add(c.malId)
    }
    for (const malId of enrichIds) {
      const cand = candidatesByMal.get(malId)
      if (!cand || cand.genres.length > 0) continue
      try {
        const details = await fetchAndCacheAnimeDetails(accessToken, cand.malId)
        cand.genres = (details.genres ?? [])
          .map((g) => g.russian || g.name)
          .filter((n): n is string => Boolean(n))
      } catch (err) {
        console.warn('[shikimori] recommendations: detail enrich failed for', cand.malId, err)
      }
      await new Promise((resolve) => setTimeout(resolve, RECS_ENRICH_DELAY_MS))
    }

    // Rank UNCAPPED (explicit Infinity — the default limit is 60), partition
    // into the airing row + main feed, then cap each section. Ranking straight
    // to RECS_RESULT_LIMIT would truncate the bottom-clustered seedless airing
    // entries before the partition ever saw them.
    const ranked = rankRecommendations(allCandidates, taste, Infinity)
    const { airingRow, mainFeed } = splitAiringRow(ranked, RECS_AIRING_ROW_LIMIT, RECS_RESULT_LIMIT)
    const finalRanked = [...airingRow, ...mainFeed]
    const malMap = await lookupByMalIds(finalRanked.map((r) => r.malId))

    // The persisted `airing` flag means "belongs in the airing row" (the
    // renderer partitions the flat cached feed on it), NOT "came from the
    // ongoing pool" — a gated-out airing title that makes the main feed is
    // stored unflagged so the renderer can't resurrect it into the row.
    const toEntry = (r: RankedRecommendation, inAiringRow: boolean): RecommendationEntry => {
      const smotret = malMap[r.malId] ?? null
      return {
        malId: r.malId,
        animeId: smotret?.id ?? null,
        title: r.title,
        posterUrl: smotret?.posterUrlSmall || r.posterUrl,
        kind: r.kind,
        communityScore: r.communityScore,
        reason: inAiringRow ? `Airing now · ${r.reason}` : r.reason,
        ...(inAiringRow ? { airing: true } : {})
      }
    }
    const entries: RecommendationEntry[] = [
      ...airingRow.map((r) => toEntry(r, true)),
      ...mainFeed.map((r) => toEntry(r, false))
    ]

    store.set('shikimoriRecommendations', entries)
    return entries
  }

  function refreshShikimoriRecommendationsInBackground(): void {
    fetchAndCacheShikimoriRecommendations()
      .then((recs) => {
        if (recs) broadcast(EVENT_CHANNELS.SHIKIMORI_RECOMMENDATIONS_REFRESHED, recs)
      })
      .catch((err) => console.warn('[shikimori] recommendations background refresh failed:', err))
  }

  function invalidateRecommendations(): void {
    sync.invalidateRecommendations()
  }

  // Shikimori's steps in the account lifecycle (#695), which runs login,
  // switch and logout for every tracker: today's `sync.*` calls, the
  // user-scoped reset's prefetch abort and snapshots, and the Shared Library
  // login run (#584). An AniList or MAL login runs it through the lifecycle's
  // own `afterLogin` (#714).
  trackerLifecycle.setSteps('shikimori', {
    resetExtra() {
      sync.abortPrefetch()
      sync.clearOfflineSnapshots()
    },
    startTimer: () => sync.startSyncTimer(),
    drain: () => void sync.syncShikimoriQueue(),
    stopTimer: () => sync.stopSyncTimer(),
    broadcastStatus: () => sync.broadcastSyncStatus(),
    broadcastQueue: (length) =>
      broadcast(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, { length }),
    afterLogin() {
      // The merge on login (#584), after S0b's restore: its Shikimori leg drains first.
      void syncRunner
        ?.runAll('login')
        .catch((err) => console.error('[sync] the login run failed:', err))
    }
  })

  // The primary branch of `applyChange` for Shikimori (#692): 6.x's
  // `sendRate` / `queueRate`, moved to `services/trackers`, with this router's
  // refresh and recommendations invalidation injected.
  const primary = createShikimoriPrimary({
    store,
    sync,
    broadcast,
    rateUpdatedChannel: EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED,
    offlineQueueChangedChannel: EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED,
    maybeBroadcastCleanupPrompt,
    invalidateRecommendations,
    refreshRatesInBackground: refreshShikimoriRatesInBackground
  })
  trackers.setPrimaryWriter('shikimori', primary.write)

  // When the detail-prefetch worker finishes a run, the genres aggregation has
  // broader coverage — recompute and rebroadcast the profile so an open
  // dashboard fills in its favorite-genres panel without a manual refresh (#183).
  sync.setOnDetailsPrefetched(refreshShikimoriProfileInBackground)

  // The four account aliases (#695) delegate to the tracker lifecycle and
  // Shikimori's `authFlow`, with today's payloads, until v7.0 (#717). Unlike
  // `tracker:begin-auth`, none of them refuses while offline.
  // The second-tracker flag (#701) refuses here as `tracker:begin-auth` does;
  // the exchange below meets the lifecycle's commit-time check.
  ipcMain.handle(CHANNELS.SHIKIMORI_GET_AUTH_URL, () => {
    assertMayConnect(secondTrackerEnabled, 'shikimori', (t) => isConnected(store, t))
    return shikimoriAuthFlow.begin().authorizeUrl
  })

  // The live queue only ever holds the signed-in user's changes (#588); the
  // lifecycle writes nothing until `getUser` resolves (`trackers/lifecycle.ts`).
  // Unguarded, as in 6.x: it only cancels a `tracker:begin-auth('shikimori')`
  // still held, so that `BEGIN` doesn't stay pending.
  ipcMain.handle(CHANNELS.SHIKIMORI_EXCHANGE_CODE, async (_event, code: string) => {
    trackerAuth.cancel('shikimori')
    const outcome = await trackerLifecycle.completeLogin('shikimori', () =>
      shikimoriAuthFlow.exchange(code, null)
    )
    if (outcome.status !== 'connected') throw new Error('The Shikimori sign-in was cancelled')
    return outcome.user as shikimori.ShikiUser
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_LOGOUT, (_event, opts?: ShikiLogoutOptions) => {
    trackerLifecycle.logout('shikimori', { pending: opts?.pending, clearWhenSignedOut: true })
  })

  // `tracker:list-accounts` carries the same `shikimoriUser` read as its `user`.
  ipcMain.handle(CHANNELS.SHIKIMORI_GET_USER, () => {
    return store.get('shikimoriUser') as shikimori.ShikiUser | null
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_FRIENDS, async () => {
    if (!store.get('shikimoriUser')) return null
    const cached = store.get('shikimoriFriends') as ShikiFriendCard[]
    if (cached && cached.length > 0) {
      refreshShikimoriFriendsInBackground()
      return cached
    }
    try {
      return await fetchAndCacheShikimoriFriends()
    } catch (err) {
      console.warn('[shikimori] friends fetch failed:', err)
      return null
    }
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_PROFILE, async () => {
    if (!store.get('shikimoriUser')) return null
    const cached = store.get('shikimoriProfile') as ShikimoriProfile | null
    if (cached) {
      refreshShikimoriProfileInBackground()
      return cached
    }
    try {
      return await fetchAndCacheShikimoriProfile()
    } catch (err) {
      console.warn('[shikimori] profile fetch failed:', err)
      return null
    }
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_RECOMMENDATIONS, async () => {
    if (!store.get('shikimoriUser')) return null
    const cached = store.get('shikimoriRecommendations') as RecommendationEntry[]
    if (cached && cached.length > 0) {
      // The cached feed outlives rate changes, so re-validate it against the
      // current list before serving — an entry the user has since rated or
      // completed must never show even if the cache predates that change.
      const filtered = filterOutRated(cached, ratedMalIdSet())
      if (filtered.length > 0) {
        if (filtered.length !== cached.length) store.set('shikimoriRecommendations', filtered)
        refreshShikimoriRecommendationsInBackground()
        return filtered
      }
      // The filter emptied the feed — every cached entry has since been rated.
      // Fall through to the synchronous rebuild instead of returning [] and
      // flashing the "rate a few shows" empty state while a background refresh
      // runs (PR #194 review).
      store.set('shikimoriRecommendations', [])
    }
    try {
      return await fetchAndCacheShikimoriRecommendations()
    } catch (err) {
      console.warn('[shikimori] recommendations fetch failed:', err)
      return null
    }
  })

  // The nine handlers below are aliases of their `tracker:*` channels until
  // v7.0 (#717): each calls the shared function in `services/trackers/rates.ts`
  // with `'shikimori'` and replies in today's shape, signed out included.

  // Offline, or when the live read fails the way a queued write would, the
  // cached list answers (#570), as `ShikiUserRateResult` with `stale: true`.
  ipcMain.handle(
    CHANNELS.SHIKIMORI_GET_RATE,
    async (_event, malId: number): Promise<ShikiUserRateResult | null> => {
      const read = await trackerRates.readRate('shikimori', malId)
      if (!read) return null
      if (read.stale) return read.row ? rateFromCacheEntry(read.row as StoredRateEntry) : null
      return (read.entry?.native as shikimori.ShikiUserRate | undefined) ?? null
    }
  )

  ipcMain.handle(
    CHANNELS.SHIKIMORI_UPDATE_RATE,
    async (
      _event,
      malId: number,
      episodes: number,
      status: shikimori.ShikiUserRateStatus,
      score: number,
      rewatches: number
    ): Promise<shikimori.ShikiUserRate> => {
      const values = { episodes, status, score, rewatches }
      const outcome = await trackerRates.updateRate(malId, values, 'shikimori')
      // An equal copy queued nothing: `values` already match the projection.
      return shikimoriRateReply(malId, outcome, () =>
        syntheticRate(malId, cachedShikimoriRate(store, malId)?.id ?? null, values)
      )
    }
  )

  // The player's auto-mark (#565): the primary's live read and its queue
  // fallback are Shikimori's primary branch (`services/trackers`).
  ipcMain.handle(
    CHANNELS.SHIKIMORI_MARK_EPISODE_WATCHED,
    async (_event, malId: number, epNum: number): Promise<shikimori.ShikiUserRate | null> => {
      const outcome = await trackerRates.markEpisodeWatched(malId, epNum, 'shikimori')
      return outcome ? shikimoriRateReply(malId, outcome, () => null) : null
    }
  )

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_FRIENDS_RATES, async (_event, malId: number) => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    return shikimori.getFriendsRatesForAnime(accessToken, user.id, malId)
  })

  ipcMain.handle(
    CHANNELS.SHIKIMORI_GET_ANIME_RATES,
    async (_event, status?: string) =>
      (await trackerRates.getRates(
        'shikimori',
        (status || undefined) as shikimori.ShikiUserRateStatus | undefined
      )) ?? []
  )

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_ANIME_DETAILS, (_event, malId: number) => {
    const cache = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >
    const entry = cache[String(malId)]
    if (!entry) {
      const creds = store.get('shikimoriCredentials') as shikimori.ShikiCredentials | null
      if (creds) void sync.prefetchShikimoriDetails()
      return null
    }
    return entry.details
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_TRIGGER_DETAIL_PREFETCH, () => {
    void sync.prefetchShikimoriDetails()
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_OFFLINE_QUEUE_LENGTH, () =>
    trackerRates.getOfflineQueueLength('shikimori')
  )

  // The store key, signed in or not: logout is what fills it (#694).
  ipcMain.handle(CHANNELS.SHIKIMORI_GET_PARKED_QUEUES, (): ShikiParkedQueueSummary[] =>
    trackerRates.getParkedQueues('shikimori').map((bucket) => ({
      ...bucket,
      ownerId: bucket.ownerId === null ? null : Number(bucket.ownerId)
    }))
  )

  ipcMain.handle(CHANNELS.SHIKIMORI_DISCARD_PARKED_QUEUE, (_event, ownerId: number | null) =>
    trackerRates.discardParkedQueue('shikimori', ownerId === null ? null : String(ownerId))
  )

  // Today's five fields: "Needs setup" is the `tracker:*` status's only.
  ipcMain.handle(CHANNELS.SHIKIMORI_GET_SYNC_STATUS, () =>
    legacyStatus(trackerRates.getSyncStatus('shikimori'))
  )

  ipcMain.handle(CHANNELS.SHIKIMORI_TRIGGER_SYNC, () => {
    trackerRates.triggerSync('shikimori')
  })

  // Offline (#568) both lists come from the sync service's snapshot, whatever
  // its age, before anything that could reach the network; with none, an empty
  // stale shape. Online a failed fetch falls back to the snapshot the same way.
  ipcMain.handle(
    CHANNELS.SHIKIMORI_GET_FRIENDS_ACTIVITY,
    async (): Promise<ShikiSnapshotResult<ShikiFriendActivityEntry[]>> => {
      if (offlineService?.isOffline()) return stale(sync.getCachedFriendsActivity())
      try {
        const accessToken = await shikimori.ensureFreshToken(store)
        const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
        if (!user) throw new Error('Not logged in to Shikimori')

        const activities = await shikimori.getFriendsActivity(accessToken, user.id)
        const malIds = Array.from(new Set(activities.map((a) => a.malId)))
        const malMap = await lookupByMalIds(malIds)

        const data = activities.map((a) => ({
          ...a,
          smotretAnime: malMap[a.malId] ?? null
        }))
        return fresh(sync.setCachedFriendsActivity(user.id, data))
      } catch (err) {
        const snapshot = sync.getCachedFriendsActivity()
        if (!snapshot) throw err
        console.warn('[shikimori] friends activity fetch failed, serving the snapshot:', err)
        return stale(snapshot)
      }
    }
  )

  // The body is shared with `tracker:get-calendar`'s Shikimori branch (#709);
  // this alias keeps its key and behaviour until v7.0 (#717).
  const getShikimoriCalendar = createShikimoriCalendar({
    store,
    sync,
    lookupByMalIds,
    isOffline: () => offlineService?.isOffline() ?? false
  })

  ipcMain.handle(
    CHANNELS.SHIKIMORI_GET_CALENDAR,
    (_event, force = false): Promise<ShikiSnapshotResult<CalendarEntry[]>> =>
      getShikimoriCalendar(force)
  )

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_RELATED, async (_event, malId: number) => {
    const franchise = await shikimori.getFranchise(malId)

    const CANONICAL_RELATIONS = new Set([
      'sequel',
      'prequel',
      'side_story',
      'parent_story',
      'alternative_version',
      'summary',
      'full_story',
      'spin_off',
      'alternative_setting'
    ])

    const adjacency = new Map<number, { nodeId: number; relation: string }[]>()
    for (const link of franchise.links) {
      if (!CANONICAL_RELATIONS.has(link.relation)) continue
      if (!adjacency.has(link.source_id)) adjacency.set(link.source_id, [])
      adjacency.get(link.source_id)!.push({ nodeId: link.target_id, relation: link.relation })
      if (!adjacency.has(link.target_id)) adjacency.set(link.target_id, [])
      adjacency.get(link.target_id)!.push({ nodeId: link.source_id, relation: link.relation })
    }

    const reachable = new Set<number>([franchise.current_id])
    const queue = [franchise.current_id]
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]
      for (const { nodeId } of adjacency.get(cur) || []) {
        if (reachable.has(nodeId)) continue
        reachable.add(nodeId)
        queue.push(nodeId)
      }
    }

    const filteredNodes = franchise.nodes.filter((n) => reachable.has(n.id))
    const malIds = Array.from(new Set(filteredNodes.map((n) => n.id)))
    const malMap = await lookupByMalIds(malIds)

    const relationByNodeId = new Map<number, string>()
    for (const link of franchise.links) {
      if (link.source_id === franchise.current_id) {
        relationByNodeId.set(link.target_id, link.relation)
      }
    }

    const cachedDetails = store.get('shikimoriAnimeDetails') as Record<
      string,
      { details: shikimori.ShikiAnimeDetails; fetchedAt: number }
    >
    const cachedRates = store.get('shikimoriUserRates') as {
      rate: { status: shikimori.ShikiUserRateStatus }
      shikiAnime: { id: number; kind?: string }
    }[]
    const kindByMalId = new Map<number, string>()
    const statusByMalId = new Map<number, shikimori.ShikiUserRateStatus>()
    for (const r of cachedRates) {
      const id = r.shikiAnime?.id
      if (id == null) continue
      if (r.shikiAnime.kind) kindByMalId.set(id, r.shikiAnime.kind)
      if (r.rate?.status) statusByMalId.set(id, r.rate.status)
    }

    function normalizeKind(
      node: shikimori.ShikiFranchiseNode,
      smotretType: string | undefined
    ): string | null {
      const cached = cachedDetails[String(node.id)]?.details?.kind
      if (cached) return cached
      const rated = kindByMalId.get(node.id)
      if (rated) return rated
      if (smotretType) return smotretType.toLowerCase()
      const k = (node.kind || '').toLowerCase()
      if (k.includes('проморолик') || k === 'pv') return 'pv'
      if (k.includes('реклама') || k === 'cm') return 'cm'
      if (k.includes('клип') || k === 'music') return 'music'
      if (k.includes('тв-спешл') || k === 'tv_special') return 'tv_special'
      if (k.includes('спешл') || k === 'special') return 'special'
      if (k.includes('полнометраж') || k === 'movie') return 'movie'
      if (k.includes('ova')) return 'ova'
      if (k.includes('ona')) return 'ona'
      if (k.includes('tv')) return 'tv'
      return node.kind ?? null
    }

    const EXCLUDED_KINDS = new Set(['pv', 'cm', 'music'])

    const sorted = [...filteredNodes].sort((a, b) => {
      if (a.date == null && b.date == null) return 0
      if (a.date == null) return 1
      if (b.date == null) return -1
      return a.date - b.date
    })

    return sorted
      .map((n) => {
        const smotret = malMap[n.id] ?? null
        const kind = normalizeKind(n, smotret?.type)
        return {
          relation: relationByNodeId.get(n.id) ?? null,
          shikiAnime: {
            id: n.id,
            name: n.name,
            image_url: n.image_url,
            url: n.url,
            year: n.year,
            kind,
            date: n.date
          },
          smotretAnime: smotret,
          isCurrent: n.id === franchise.current_id,
          watchStatus: statusByMalId.get(n.id) ?? null
        }
      })
      .filter((e) => e.isCurrent || !(e.shikiAnime.kind && EXCLUDED_KINDS.has(e.shikiAnime.kind)))
  })

  // The rate funnels, for a caller that writes with `stamp: false` and supplies
  // its own clocks (the Shared Library merge, #584).
  return { sendRate: primary.sendRate, queueRate: primary.queueRate }
}

function legacyStatus(status: TrackerStatus): ShikiSyncStatus {
  const { state, queueLength, lastSyncAt, lastSyncError, sessionExpired } = status
  return { state, queueLength, lastSyncAt, lastSyncError, sessionExpired }
}
