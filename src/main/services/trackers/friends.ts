// The merged Friends page (#712, epic #688): Shikimori's friends plus the users
// the AniList account follows, their activity in time order, and their rates on
// one title. `docs/trackers.md` § Friends describes the rules.
//
// - A friends source is a connected tracker (`<provider>User` set) with
//   `getFriends` in the capability matrix (#706): Shikimori and AniList, never
//   MyAnimeList. Every one contributes; there is no feature source.
// - Shikimori's three reads are the `shikimori:get-friends*` handlers' bodies,
//   moved here unchanged: the aliases call `shikimoriCards`,
//   `shikimoriActivity` and `shikimoriRates`, with today's payloads and throws.
//   `shikimoriFriends` and `shikimori-snapshots.json` keep their shape: `source`
//   and the URLs are added on the way out, never persisted.
// - The `tracker:*` reads catch per source: a source that fails is
//   `{ status: 'error', error }` beside the other's data, and an expired
//   session also says `sessionExpired` while its cache is still served.
// - AniList's cards are cache-first on `anilistFriends` and refreshed in the
//   background; its activity snapshot is the `friendsActivity` section of
//   `anilist-snapshots.json`. Both are written only for the user a fetch began
//   with, so a fetch that outlives an account switch writes nothing.
// - The merged activity joins both sources' MAL ids in one smotret lookup; a
//   failed lookup leaves the batch `smotretAnime: null` instead of failing both.

import { CAPABILITY_MATRIX, TRACKER_ORDER } from '@shared/trackers/feature-source'
import { friendProfileUrl } from '@shared/trackers/friend-links'
import { trackerTitleUrl } from '@shared/trackers/title-links'
import type * as shikimori from '../../shikimori'
import type { AnimeSearchResult } from '../../smotret-api'
import type { StorageService } from '../../store/types'
import type { ShikimoriSyncService } from '../shikimori-sync'
import { freshResult, staleResult } from '../../trackers/display-snapshots'
import type {
  AniListCachedFriendsActivity,
  AniListSnapshots
} from '../../trackers/anilist/calendar'
import {
  titleOf,
  type AniListFriend,
  type AniListMedia,
  type AniListProvider
} from '../../trackers/anilist/provider'
import { TRACKER_KEYS } from '../../trackers/keys'
import { isConnected } from '../../trackers/primary'
import { appStatusFromAnilist, type AnilistStatus } from '../../trackers/scores'
import type { ShikimoriProvider } from '../../trackers/shikimori.provider'

/** The two broadcasts, passed in by `index.ts` (the emitter scan reads them there). */
export interface TrackerFriendsChannels {
  /** `shikimori:friends-refreshed`: Shikimori's cards, today's payload. */
  shikimoriFriendsRefreshed: string
  /** `tracker:friends-refreshed`: `{ trackerId, cards }`. Unset emits only the alias. */
  friendsRefreshed?: string
}

export interface TrackerFriendsDeps {
  store: StorageService
  shikimori: {
    provider: Pick<
      ShikimoriProvider,
      'auth' | 'getFriends' | 'getFriendsActivity' | 'getFriendsRates'
    >
    sync: Pick<ShikimoriSyncService, 'getCachedFriendsActivity' | 'setCachedFriendsActivity'>
  }
  /** Unset: AniList is never a source (a router registered without it). */
  anilist?: {
    provider: Pick<
      AniListProvider,
      'auth' | 'getFriends' | 'getFriendsActivity' | 'getFriendsRates'
    >
    snapshots: Pick<AniListSnapshots, 'get' | 'put'>
  }
  lookupByMalIds: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  isOffline: () => boolean
  broadcast: (channel: string, ...args: unknown[]) => void
  channels: TrackerFriendsChannels
  log?: Pick<Console, 'warn'>
}

export interface TrackerFriends {
  /** `shikimori:get-friends`: cache-first; `null` signed out or when a cold fetch fails. */
  shikimoriCards(): Promise<ShikiFriendCard[] | null>
  /** `shikimori:get-friends-activity`: throws when the fetch fails with no snapshot. */
  shikimoriActivity(): Promise<ShikiSnapshotResult<ShikiFriendActivityEntry[]>>
  /** `shikimori:get-friends-rates`: throws signed out. */
  shikimoriRates(malId: number): Promise<ShikiFriendRate[]>
  /** The connected friends sources, in `TRACKER_ORDER`. */
  sources(): TrackerId[]
  getFriends(): Promise<TrackerFriendsResult>
  getActivity(): Promise<TrackerFriendsActivityResult>
  getRates(malId: number): Promise<TrackerFriendRates[]>
}

/** A `ListActivity` row of `Page.activities`, as the provider returns it. */
export interface AniListActivity {
  id?: number | null
  status?: string | null
  progress?: string | null
  createdAt?: number | null
  user?: { id?: number | null; name?: string | null; avatar?: { medium?: string | null } | null }
  media?: (AniListMedia & { isAdult?: boolean | null }) | null
}

/** A `Page.mediaList(isFollowing)` row, as the provider returns it. */
export interface AniListFriendRateRow {
  user?: { id?: number | null; name?: string | null; avatar?: { medium?: string | null } | null }
  status?: AnilistStatus | null
  score?: number | null
  progress?: number | null
}

// `ListActivity.progress` is a string, and can be a range ("1 - 3"). Only
// these shapes are used, verbatim; anything else is left out.
const PROGRESS_RE = /^\d+(?: - \d+)?$/

/**
 * An AniList activity's `description`, built by the app from its `status` and
 * `progress` as given (#712). No AniList-provided free text goes in: the view
 * runs it through `innerHTML`.
 */
export function anilistActivityDescription(
  status: string | null | undefined,
  progress: string | null | undefined
): string {
  const p = typeof progress === 'string' && PROGRESS_RE.test(progress) ? progress : null
  switch (status) {
    case 'watched episode':
      return p ? `watched episode ${p}` : 'watched an episode'
    case 'rewatched episode':
      return p ? `rewatched episode ${p}` : 'rewatched an episode'
    case 'completed':
      return 'completed'
    case 'rewatched':
      return 'rewatched'
    case 'plans to watch':
      return 'plans to watch'
    case 'dropped':
      return p ? `dropped at episode ${p}` : 'dropped'
    case 'paused watching':
      return p ? `paused at episode ${p}` : 'paused'
    default:
      return 'updated their list'
  }
}

/** One AniList activity in the merged shape, or null when it can't be shown. */
export function anilistActivityEntry(
  a: AniListActivity | null | undefined
): TrackerFriendActivityEntry | null {
  const user = a?.user
  const media = a?.media
  if (typeof user?.id !== 'number' || typeof user.name !== 'string') return null
  if (typeof media?.id !== 'number' || typeof a?.createdAt !== 'number') return null
  const malId = typeof media.idMal === 'number' ? media.idMal : null
  return {
    source: 'anilist',
    friendId: user.id,
    friendNickname: user.name,
    friendAvatar: user.avatar?.medium ?? '',
    malId,
    animeName: titleOf(media),
    animeImage: media.coverImage?.large ?? '',
    description: anilistActivityDescription(a.status, a.progress),
    createdAt: new Date(a.createdAt * 1000).toISOString(),
    smotretAnime: null,
    friendUrl: friendProfileUrl('anilist', user.name),
    titleUrl: trackerTitleUrl('anilist', malId ?? 0, media.id)
  }
}

/**
 * A friend's AniList rate on a title: the canonical status, and the POINT_100
 * score / 10. The score is the friend's, so the viewer's `scoreFormat` plays no
 * part; 0 stays 0 (unscored, hidden).
 */
export function anilistFriendRate(
  row: AniListFriendRateRow | null | undefined
): TrackerFriendRate | null {
  const status = row?.status ? appStatusFromAnilist(row.status) : undefined
  if (!status || typeof row?.user?.name !== 'string') return null
  return {
    source: 'anilist',
    nickname: row.user.name,
    avatar: row.user.avatar?.medium ?? '',
    status,
    score: (row.score ?? 0) / 10,
    episodes: row.progress ?? 0
  }
}

export function shikimoriFriendCard(card: ShikiFriendCard): TrackerFriendCard {
  return { source: 'shikimori', presence: true, ...card }
}

export function anilistFriendCard(f: AniListFriend): TrackerFriendCard {
  return {
    source: 'anilist',
    id: f.id,
    nickname: f.nickname,
    avatar: f.avatar,
    presence: false,
    lastOnlineAt: null,
    online: false,
    titles: f.titles,
    mean: f.mean,
    mutual: null,
    watching: null
  }
}

export function shikimoriActivityEntry(e: ShikiFriendActivityEntry): TrackerFriendActivityEntry {
  return {
    source: 'shikimori',
    ...e,
    friendUrl: friendProfileUrl('shikimori', e.friendNickname),
    titleUrl: trackerTitleUrl('shikimori', e.malId)
  }
}

/** Newest first, by time alone: each source keeps its own cap, so the merge is the union. */
export function mergeActivity(
  feeds: readonly (readonly TrackerFriendActivityEntry[])[]
): TrackerFriendActivityEntry[] {
  const at = (e: TrackerFriendActivityEntry): number => {
    const ms = Date.parse(e.createdAt)
    return Number.isNaN(ms) ? 0 : ms
  }
  return feeds.flat().sort((a, b) => at(b) - at(a))
}

/** `stale` when any source is; the stamp is then the oldest stale snapshot's. */
export function mergedStamp(parts: readonly ShikiSnapshotResult<unknown>[]): {
  fetchedAt: number | null
  stale: boolean
} {
  const stale = parts.some((p) => p.stale)
  const stamps = parts
    .filter((p) => (stale ? p.stale : true))
    .flatMap((p) => (p.fetchedAt === null ? [] : [p.fetchedAt]))
  return { fetchedAt: stamps.length > 0 ? Math.min(...stamps) : null, stale }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createTrackerFriends(deps: TrackerFriendsDeps): TrackerFriends {
  const { store, broadcast, channels, lookupByMalIds } = deps
  const log = deps.log ?? console
  const sh = deps.shikimori
  const al = deps.anilist

  const anilistUserId = (): number | undefined =>
    (store.get('anilistUser') as { id?: number } | null | undefined)?.id
  const sessionExpired = (id: TrackerId): boolean =>
    store.get(TRACKER_KEYS[id].sessionExpired) === true

  function sources(): TrackerId[] {
    return TRACKER_ORDER.filter(
      (id) =>
        CAPABILITY_MATRIX.getFriends[id] &&
        isConnected(store, id) &&
        (id === 'shikimori' || (id === 'anilist' && !!al))
    )
  }

  // A source whose read succeeded: still an error line while its session is expired.
  function served(id: TrackerId): TrackerFriendsSourceState {
    return sessionExpired(id)
      ? { status: 'error', error: 'Session expired', sessionExpired: true }
      : { status: 'ok' }
  }

  function failure(id: TrackerId, err: unknown): TrackerFriendsSourceState {
    return sessionExpired(id)
      ? { status: 'error', error: messageOf(err), sessionExpired: true }
      : { status: 'error', error: messageOf(err) }
  }

  // ---- Shikimori: the alias bodies ------------------------------------------

  // Friends page cards (#179): friend list joined with presence + per-friend
  // stats (titles/mean/mutual + current watch). Cache-first like the rate
  // cache; `null` when logged out. `mutual` is shared rated titles with the
  // signed-in user, derived from the cached own-rate list.
  async function fetchAndCacheShikimoriFriends(): Promise<ShikiFriendCard[] | null> {
    if (!store.get('shikimoriUser')) return null
    const session = await sh.provider.auth()
    const cards = await sh.provider.getFriends(session)
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

  function refreshShikimoriInBackground(): void {
    fetchAndCacheShikimoriFriends()
      .then((cards) => {
        if (!cards) return
        broadcast(channels.shikimoriFriendsRefreshed, cards)
        if (channels.friendsRefreshed) {
          broadcast(channels.friendsRefreshed, {
            trackerId: 'shikimori',
            cards: cards.map(shikimoriFriendCard)
          } satisfies TrackerFriendsRefreshedEvent)
        }
      })
      .catch((err) => log.warn('[shikimori] friends background refresh failed:', err))
  }

  async function shikimoriCards(): Promise<ShikiFriendCard[] | null> {
    if (!store.get('shikimoriUser')) return null
    const cached = store.get('shikimoriFriends') as ShikiFriendCard[]
    if (cached && cached.length > 0) {
      refreshShikimoriInBackground()
      return cached
    }
    try {
      return await fetchAndCacheShikimoriFriends()
    } catch (err) {
      log.warn('[shikimori] friends fetch failed:', err)
      return null
    }
  }

  // Offline (#568) the snapshot, whatever its age, before anything that could
  // reach the network; with none, an empty stale shape. Online a failed fetch
  // falls back to the snapshot the same way, and throws with none.
  async function shikimoriActivity(): Promise<ShikiSnapshotResult<ShikiFriendActivityEntry[]>> {
    if (deps.isOffline()) return staleResult(sh.sync.getCachedFriendsActivity())
    try {
      const session = await sh.provider.auth()
      const activities = await sh.provider.getFriendsActivity(session)
      const malIds = Array.from(new Set(activities.map((a) => a.malId)))
      const malMap = await lookupByMalIds(malIds)
      return freshResult(
        sh.sync.setCachedFriendsActivity(session.userId, withSmotret(activities, malMap))
      )
    } catch (err) {
      const snapshot = sh.sync.getCachedFriendsActivity()
      if (!snapshot) throw err
      log.warn('[shikimori] friends activity fetch failed, serving the snapshot:', err)
      return staleResult(snapshot)
    }
  }

  function withSmotret(
    activities: readonly shikimori.ShikiFriendActivity[],
    malMap: Readonly<Record<number, AnimeSearchResult>>
  ): ShikiFriendActivityEntry[] {
    return activities.map((a) => ({ ...a, smotretAnime: malMap[a.malId] ?? null }))
  }

  async function shikimoriRates(malId: number): Promise<ShikiFriendRate[]> {
    const session = await sh.provider.auth()
    return sh.provider.getFriendsRates(session, malId)
  }

  // ---- AniList ---------------------------------------------------------------

  async function fetchAndCacheAniListFriends(): Promise<AniListFriend[] | null> {
    const userId = anilistUserId()
    if (!al || userId === undefined) return null
    const session = await al.provider.auth()
    const friends = await al.provider.getFriends(session)
    // An account switch while this ran: these are the old user's.
    if (session.userId !== userId || anilistUserId() !== userId) return null
    store.set('anilistFriends', friends)
    return friends
  }

  function refreshAniListInBackground(): void {
    fetchAndCacheAniListFriends()
      .then((friends) => {
        if (!friends || !channels.friendsRefreshed) return
        broadcast(channels.friendsRefreshed, {
          trackerId: 'anilist',
          cards: friends.map(anilistFriendCard)
        } satisfies TrackerFriendsRefreshedEvent)
      })
      .catch((err) => log.warn('[anilist] friends background refresh failed:', err))
  }

  // ---- The merged reads ------------------------------------------------------

  async function readCards(id: TrackerId): Promise<TrackerFriendCard[]> {
    if (id === 'shikimori') {
      const cached = (store.get('shikimoriFriends') as ShikiFriendCard[] | undefined) ?? []
      if (cached.length > 0) {
        refreshShikimoriInBackground()
        return cached.map(shikimoriFriendCard)
      }
      return ((await fetchAndCacheShikimoriFriends()) ?? []).map(shikimoriFriendCard)
    }
    const cached = (store.get('anilistFriends') as AniListFriend[] | undefined) ?? []
    if (cached.length > 0) {
      refreshAniListInBackground()
      return cached.map(anilistFriendCard)
    }
    return ((await fetchAndCacheAniListFriends()) ?? []).map(anilistFriendCard)
  }

  async function getFriends(): Promise<TrackerFriendsResult> {
    const reads = await Promise.all(
      sources().map(async (id) => {
        try {
          return { id, cards: await readCards(id), state: served(id) }
        } catch (err) {
          log.warn(`[trackers] ${id} friends fetch failed:`, err)
          return { id, cards: [] as TrackerFriendCard[], state: failure(id, err) }
        }
      })
    )
    const result: TrackerFriendsResult = { cards: [], sources: {} }
    for (const r of reads) {
      result.cards.push(...r.cards)
      result.sources[r.id] = r.state
    }
    return result
  }

  interface FetchedFeed {
    malIds: number[]
    /** Joins the lookup, stores the snapshot (for the user the fetch began with) and returns it. */
    commit(malMap: Readonly<Record<number, AnimeSearchResult>>): {
      data: TrackerFriendActivityEntry[]
      fetchedAt: number
    }
  }

  async function fetchFeed(id: TrackerId): Promise<FetchedFeed> {
    if (id === 'shikimori') {
      const session = await sh.provider.auth()
      const activities = await sh.provider.getFriendsActivity(session)
      return {
        malIds: activities.map((a) => a.malId),
        commit: (malMap) => {
          const snapshot = sh.sync.setCachedFriendsActivity(
            session.userId,
            withSmotret(activities, malMap)
          )
          return { data: snapshot.data.map(shikimoriActivityEntry), fetchedAt: snapshot.fetchedAt }
        }
      }
    }
    if (!al) throw new Error(`${id} has no friends activity`)
    const session = await al.provider.auth()
    const raw = (await al.provider.getFriendsActivity(session)) as AniListActivity[]
    const entries = raw.flatMap((a) => {
      const e = anilistActivityEntry(a)
      return e ? [e] : []
    })
    return {
      malIds: entries.flatMap((e) => (e.malId === null ? [] : [e.malId])),
      commit: (malMap) => {
        const record: AniListCachedFriendsActivity = {
          data: entries.map((e) => ({
            ...e,
            smotretAnime: e.malId === null ? null : (malMap[e.malId] ?? null)
          })),
          fetchedAt: Date.now(),
          userId: session.userId
        }
        // Stored only while `session.userId` is still the signed-in user.
        al.snapshots.put('friendsActivity', record)
        return record
      }
    }
  }

  function snapshotOf(
    id: TrackerId
  ): { data: TrackerFriendActivityEntry[]; fetchedAt: number } | null {
    if (id === 'shikimori') {
      const s = sh.sync.getCachedFriendsActivity()
      return s ? { data: s.data.map(shikimoriActivityEntry), fetchedAt: s.fetchedAt } : null
    }
    return al?.snapshots.get('friendsActivity') ?? null
  }

  async function getActivity(): Promise<TrackerFriendsActivityResult> {
    const ids = sources()
    const offline = deps.isOffline()
    const reads = await Promise.all(
      ids.map(async (id) => {
        if (offline) return { id, offline: true as const }
        try {
          return { id, feed: await fetchFeed(id) }
        } catch (err) {
          return { id, err }
        }
      })
    )

    // One lookup for every fetched feed; its failure only costs the join.
    const malIds = [...new Set(reads.flatMap((r) => ('feed' in r && r.feed ? r.feed.malIds : [])))]
    let malMap: Record<number, AnimeSearchResult> = {}
    if (malIds.length > 0) {
      try {
        malMap = await lookupByMalIds(malIds)
      } catch (err) {
        log.warn('[trackers] friends activity: the smotret lookup failed:', err)
      }
    }

    const sourcesOut: TrackerFriendsActivityResult['sources'] = {}
    for (const r of reads) {
      if ('feed' in r && r.feed) {
        sourcesOut[r.id] = { ...freshResult(r.feed.commit(malMap)), status: 'ok' }
      } else if ('offline' in r) {
        sourcesOut[r.id] = { ...staleResult(snapshotOf(r.id)), ...served(r.id) }
      } else {
        const err = 'err' in r ? r.err : undefined
        log.warn(`[trackers] ${r.id} friends activity fetch failed:`, err)
        sourcesOut[r.id] = { ...staleResult(snapshotOf(r.id)), ...failure(r.id, err) }
      }
    }
    const parts = ids.map((id) => sourcesOut[id]!)
    return {
      data: mergeActivity(parts.map((p) => p.data)),
      ...mergedStamp(parts),
      sources: sourcesOut
    }
  }

  async function readRates(id: TrackerId, malId: number): Promise<TrackerFriendRate[]> {
    if (id === 'shikimori') {
      return (await shikimoriRates(malId)).map((r) => ({ source: 'shikimori' as const, ...r }))
    }
    if (!al) return []
    const session = await al.provider.auth()
    const rows = (await al.provider.getFriendsRates(session, malId)) as AniListFriendRateRow[]
    return rows.flatMap((row) => {
      const rate = anilistFriendRate(row)
      return rate ? [rate] : []
    })
  }

  async function getRates(malId: number): Promise<TrackerFriendRates[]> {
    return Promise.all(
      sources().map(async (id): Promise<TrackerFriendRates> => {
        try {
          return { source: id, status: 'ok', rates: await readRates(id, malId) }
        } catch (err) {
          log.warn(`[trackers] ${id} friends rates failed:`, err)
          return { source: id, ...failure(id, err), rates: [] }
        }
      })
    )
  }

  return {
    shikimoriCards,
    shikimoriActivity,
    shikimoriRates,
    sources,
    getFriends,
    getActivity,
    getRates
  }
}
