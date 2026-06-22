import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import * as shikimori from '../shikimori'
import {
  buildTasteProfile,
  filterOutRated,
  rankRecommendations,
  type RecommendationCandidate,
  type TasteRate
} from '../recommendations'
import { isNetworkError } from '../lib/errors'
import { type QueuedShikimoriUpdate } from '../lib/shikimori-queue'
import { CALENDAR_CACHE_TTL_MS, type CalendarEntry } from '../services/shikimori-sync'
import type { AppDeps } from './index'

const SHIKI_BASE = 'https://shikimori.one'

export function register({
  store,
  shikimoriSyncService: sync,
  lookupByMalIds,
  maybeBroadcastCleanupPrompt,
  runAutoDownloadTick,
  broadcast
}: AppDeps): void {
  async function fetchAndCacheShikimoriRates(status?: string): Promise<unknown[]> {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    const rates = await shikimori.getUserAnimeRates(
      accessToken,
      user.id,
      status as shikimori.ShikiUserRateStatus | undefined
    )
    const malIds = rates.map((r) => r.anime.id)
    const malMap = await lookupByMalIds(malIds)
    const entries = rates.map((rate) => ({
      rate: {
        id: rate.id,
        score: rate.score,
        status: rate.status,
        episodes: rate.episodes,
        rewatches: rate.rewatches ?? 0,
        updated_at: rate.updated_at,
        target_id: rate.target_id
      },
      shikiAnime: rate.anime,
      smotretAnime: malMap[rate.anime.id] ?? null
    }))
    if (!status) {
      store.set('shikimoriUserRates', entries)
    }
    return entries
  }

  function refreshShikimoriRatesInBackground(): void {
    fetchAndCacheShikimoriRates()
      .then((entries) => {
        sync.invalidateCalendarCache()
        // A full rate refresh can carry completions made outside the app (e.g.
        // on shikimori.one); clear the recs cache so it rebuilds from the
        // updated list rather than surfacing a now-rated title (#193 follow-up).
        invalidateRecommendations()
        broadcast(EVENT_CHANNELS.SHIKIMORI_RATES_REFRESHED, entries)
        void sync.syncShikimoriQueue()
        void sync.prefetchShikimoriDetails()
        void runAutoDownloadTick('rates-refreshed').catch((err) =>
          console.warn('[auto-dl] rates-refreshed tick failed:', err)
        )
      })
      .catch((err) => console.warn('[shikimori] background refresh failed:', err))
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

  async function fetchAndCacheShikimoriRecommendations(): Promise<RecommendationEntry[] | null> {
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

    // Enrich the top candidates with genres so the genre-affinity term in the
    // final ranking can fire. A preliminary rank (genre term mostly dormant —
    // most candidates have no cached genres yet) picks which candidates are
    // worth a detail fetch; we mutate their `genres` in place (same object
    // refs live in `candidatesByMal`), then re-rank with the genre signal live.
    const allCandidates = [...candidatesByMal.values()]
    const prelim = rankRecommendations(allCandidates, taste, RECS_ENRICH_LIMIT)
    for (const r of prelim) {
      const cand = candidatesByMal.get(r.malId)
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

    const ranked = rankRecommendations(allCandidates, taste, RECS_RESULT_LIMIT)
    const malMap = await lookupByMalIds(ranked.map((r) => r.malId))

    const entries: RecommendationEntry[] = ranked.map((r) => {
      const smotret = malMap[r.malId] ?? null
      return {
        malId: r.malId,
        animeId: smotret?.id ?? null,
        title: r.title,
        posterUrl: smotret?.posterUrlSmall || r.posterUrl,
        kind: r.kind,
        communityScore: r.communityScore,
        reason: r.reason
      }
    })

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

  // A rate change shifts the taste signal, so the cached feed is stale. Clear it
  // (rather than recompute eagerly — that costs N `/similar` calls) so the next
  // tab open rebuilds from fresh taste.
  function invalidateRecommendations(): void {
    store.set('shikimoriRecommendations', [])
  }

  // When the detail-prefetch worker finishes a run, the genres aggregation has
  // broader coverage — recompute and rebroadcast the profile so an open
  // dashboard fills in its favorite-genres panel without a manual refresh (#183).
  sync.setOnDetailsPrefetched(refreshShikimoriProfileInBackground)

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_AUTH_URL, () => {
    return shikimori.getAuthUrl()
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_EXCHANGE_CODE, async (_event, code: string) => {
    const creds = await shikimori.exchangeCode(code)
    store.set('shikimoriCredentials', creds)
    const user = await shikimori.getUser(creds.access_token)
    store.set('shikimoriUser', user)
    return user
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_LOGOUT, () => {
    store.set('shikimoriCredentials', null)
    store.set('shikimoriUser', null)
    store.set('shikimoriUserRates', [])
    store.set('shikimoriUpdateQueue', [])
    store.set('shikimoriAnimeDetails', {})
    store.set('shikimoriProfile', null)
    store.set('shikimoriFriends', [])
    store.set('shikimoriRecommendations', [])
    sync.abortPrefetch()
    sync.invalidateCalendarCache()
    sync.stopSyncTimer()
    broadcast(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, { length: 0 })
    sync.broadcastSyncStatus()
  })

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
      if (filtered.length !== cached.length) store.set('shikimoriRecommendations', filtered)
      refreshShikimoriRecommendationsInBackground()
      return filtered
    }
    try {
      return await fetchAndCacheShikimoriRecommendations()
    } catch (err) {
      console.warn('[shikimori] recommendations fetch failed:', err)
      return null
    }
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_RATE, async (_event, malId: number) => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    return shikimori.getUserRate(accessToken, user.id, malId)
  })

  ipcMain.handle(
    CHANNELS.SHIKIMORI_UPDATE_RATE,
    async (
      _event,
      malId: number,
      episodes: number,
      status: shikimori.ShikiUserRateStatus,
      score: number,
      rewatches: number
    ) => {
      const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
      if (!user) throw new Error('Not logged in to Shikimori')

      const cached = store.get('shikimoriUserRates') as {
        rate: Record<string, unknown> & {
          id?: number
          target_id: number
          episodes: number
          status: shikimori.ShikiUserRateStatus
          score: number
          rewatches?: number
        }
        shikiAnime: unknown
        smotretAnime: unknown
      }[]
      const idx = cached.findIndex((e) => e.rate.target_id === malId)
      const prevStatus = idx !== -1 ? cached[idx].rate.status : undefined

      try {
        const accessToken = await shikimori.ensureFreshToken(store)
        const existing = await shikimori.getUserRate(accessToken, user.id, malId)
        const updatedRate = existing
          ? await shikimori.updateUserRate(
              accessToken,
              existing.id,
              episodes,
              status,
              score,
              rewatches
            )
          : await shikimori.createUserRate(
              accessToken,
              user.id,
              malId,
              episodes,
              status,
              score,
              rewatches
            )

        if (idx !== -1) {
          cached[idx] = {
            ...cached[idx],
            rate: {
              id: updatedRate.id,
              score: updatedRate.score,
              status: updatedRate.status,
              episodes: updatedRate.episodes,
              rewatches: updatedRate.rewatches ?? 0,
              updated_at: new Date().toISOString(),
              target_id: updatedRate.target_id
            }
          }
          store.set('shikimoriUserRates', cached)
          sync.invalidateCalendarCache()
          invalidateRecommendations()
          broadcast(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED, cached[idx])
          void maybeBroadcastCleanupPrompt(
            cached[idx].smotretAnime,
            malId,
            updatedRate.status,
            prevStatus
          )
        } else {
          invalidateRecommendations()
          refreshShikimoriRatesInBackground()
          void maybeBroadcastCleanupPrompt(null, malId, updatedRate.status, undefined)
        }

        void sync.syncShikimoriQueue()
        return updatedRate
      } catch (err) {
        if (!isNetworkError(err) || idx === -1) throw err

        const cachedEntry = cached[idx]
        const rateId = typeof cachedEntry.rate.id === 'number' ? cachedEntry.rate.id : null
        const before = {
          episodes: cachedEntry.rate.episodes,
          status: cachedEntry.rate.status,
          score: cachedEntry.rate.score,
          rewatches: cachedEntry.rate.rewatches ?? 0
        }
        const after = { episodes, status, score, rewatches }

        const queue = store.get('shikimoriUpdateQueue') as QueuedShikimoriUpdate[]
        queue.push({ malId, rateId, before, after, queuedAt: Date.now() })
        store.set('shikimoriUpdateQueue', queue)

        cached[idx] = {
          ...cachedEntry,
          rate: {
            ...cachedEntry.rate,
            episodes,
            status,
            score,
            rewatches,
            updated_at: new Date().toISOString()
          }
        }
        store.set('shikimoriUserRates', cached)
        sync.invalidateCalendarCache()
        invalidateRecommendations()
        broadcast(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED, cached[idx])
        broadcast(EVENT_CHANNELS.SHIKIMORI_OFFLINE_QUEUE_CHANGED, { length: queue.length })
        sync.startSyncTimer()
        void maybeBroadcastCleanupPrompt(cached[idx].smotretAnime, malId, status, prevStatus)

        return {
          id: rateId ?? -1,
          score,
          status,
          episodes,
          rewatches,
          target_id: malId,
          target_type: 'Anime'
        } satisfies shikimori.ShikiUserRate
      }
    }
  )

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_FRIENDS_RATES, async (_event, malId: number) => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')
    return shikimori.getFriendsRatesForAnime(accessToken, user.id, malId)
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_ANIME_RATES, async (_event, status?: string) => {
    if (!status) {
      const cached = store.get('shikimoriUserRates') as unknown[]
      if (cached.length > 0) {
        refreshShikimoriRatesInBackground()
        return cached
      }
    }
    const entries = await fetchAndCacheShikimoriRates(status)
    if (!status) void sync.prefetchShikimoriDetails()
    return entries
  })

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

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_OFFLINE_QUEUE_LENGTH, () => {
    return (store.get('shikimoriUpdateQueue') as unknown[]).length
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_SYNC_STATUS, () => sync.getSyncStatus())

  ipcMain.handle(CHANNELS.SHIKIMORI_TRIGGER_SYNC, () => {
    void sync.syncShikimoriQueue()
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_FRIENDS_ACTIVITY, async () => {
    const accessToken = await shikimori.ensureFreshToken(store)
    const user = store.get('shikimoriUser') as shikimori.ShikiUser | null
    if (!user) throw new Error('Not logged in to Shikimori')

    const activities = await shikimori.getFriendsActivity(accessToken, user.id)
    const malIds = Array.from(new Set(activities.map((a) => a.malId)))
    const malMap = await lookupByMalIds(malIds)

    return activities.map((a) => ({
      ...a,
      smotretAnime: malMap[a.malId] ?? null
    }))
  })

  ipcMain.handle(CHANNELS.SHIKIMORI_GET_CALENDAR, async (_event, force = false) => {
    const cachedCalendar = sync.getCachedCalendar()
    if (!force && cachedCalendar && Date.now() - cachedCalendar.fetchedAt < CALENDAR_CACHE_TTL_MS) {
      return cachedCalendar.data
    }

    let cachedRates = store.get('shikimoriUserRates') as {
      rate: { target_id?: number; episodes: number; status: shikimori.ShikiUserRateStatus }
      shikiAnime?: { id: number }
    }[]

    if (cachedRates.length === 0) {
      try {
        await fetchAndCacheShikimoriRates()
        cachedRates = store.get('shikimoriUserRates') as typeof cachedRates
      } catch (err) {
        console.warn('[shikimori] calendar: rate fetch failed:', err)
      }
    }

    // Older cached entries may lack `rate.target_id`; fall back to `shikiAnime.id`
    // (also the MAL ID) — same compatibility shim used by `home:get-continue-watching`.
    function malIdOf(r: (typeof cachedRates)[number]): number | undefined {
      return r.rate.target_id ?? r.shikiAnime?.id
    }

    const tracked = new Set<number>()
    const statusByMal = new Map<number, shikimori.ShikiUserRateStatus>()
    for (const r of cachedRates) {
      const malId = malIdOf(r)
      if (!malId) continue
      statusByMal.set(malId, r.rate.status)
      if (
        r.rate.status === 'watching' ||
        r.rate.status === 'rewatching' ||
        r.rate.status === 'planned'
      ) {
        tracked.add(malId)
      }
    }

    if (tracked.size === 0) {
      sync.setCachedCalendar([])
      return []
    }

    const calendar = await shikimori.getCalendar()
    const filtered = calendar.filter((c) => c.next_episode_at && tracked.has(c.anime.id))

    const malIds = Array.from(new Set(filtered.map((c) => c.anime.id)))
    const malMap = await lookupByMalIds(malIds)

    function absoluteImage(url: string): string {
      return url.startsWith('http') ? url : `${SHIKI_BASE}${url}`
    }

    const entries: CalendarEntry[] = filtered.map((c) => {
      const malId = c.anime.id
      const smotret = malMap[malId] ?? null
      const posterUrl =
        smotret?.posterUrlSmall ||
        absoluteImage(c.anime.image.preview || c.anime.image.x96 || c.anime.image.original)
      return {
        malId,
        animeId: smotret?.id ?? null,
        name: c.anime.russian || c.anime.name,
        posterUrl,
        kind: c.anime.kind,
        episodeInt: String(c.next_episode ?? c.anime.episodes_aired + 1),
        nextEpisodeAt: c.next_episode_at!,
        userStatus: statusByMal.get(malId) ?? 'planned'
      }
    })

    sync.setCachedCalendar(entries)
    return entries
  })

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
}
