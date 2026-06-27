import { ipcMain } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/ipc/channels'
import { SHIKIMORI_ORIGIN } from '@shared/shikimori'
import * as shikimori from '../shikimori'
import { isNetworkError } from '../lib/errors'
import { type QueuedShikimoriUpdate } from '../lib/shikimori-queue'
import { buildRateCacheEntries } from '../lib/shikimori-rate-cache'
import { CALENDAR_CACHE_TTL_MS, type CalendarEntry } from '../services/shikimori-sync'
import type { AppDeps } from './index'

const SHIKI_BASE = SHIKIMORI_ORIGIN

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
    const entries = buildRateCacheEntries(rates, malMap)
    if (!status) {
      store.set('shikimoriUserRates', entries)
    }
    return entries
  }

  function refreshShikimoriRatesInBackground(): void {
    fetchAndCacheShikimoriRates()
      .then((entries) => {
        sync.invalidateCalendarCache()
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
          broadcast(EVENT_CHANNELS.SHIKIMORI_RATE_UPDATED, cached[idx])
          void maybeBroadcastCleanupPrompt(
            cached[idx].smotretAnime,
            malId,
            updatedRate.status,
            prevStatus
          )
        } else {
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
