// The AniList tracker (#703, epic #688): the `TrackerProvider` over AniList's
// GraphQL API, its rate-cache codec, its sign-in (the implicit grant's pin
// page and a pasted token), the session expiry, and the capabilities later
// slices consume. `docs/trackers.md` § AniList describes it.
//
// - The session is `{ token, userId }`. `auth()` reads `anilistUser` before its
//   first `await` (the vault read), so `userId` is the owner the drain read at
//   its presence check; every data member takes the session and never re-reads
//   the credential or the user (#588).
// - Reads are `score(format: POINT_100)`; writes send `scoreRaw`, and only the
//   changed fields. The user's `scoreFormat` only gives the scale's precision.
// - `native` is the `MediaList` row as read; the cache codec writes
//   `anilistUserRates` from it, never from the normalized fields.

import type { RateValues } from '../../lib/shikimori-rate'
import type { AnimeSearchResult } from '../../smotret-api'
import type { StorageService } from '../../store/types'
import type { CredentialVault, VaultBlob } from '../credential-vault'
import { DETAILS_STALE_MS } from '../details-freshness'
import { TrackerApiError } from '../errors'
import {
  anilistQuantize,
  anilistRawFromAppScore,
  anilistRawToStore,
  anilistStatusFromApp,
  appScoreFromAnilistRaw,
  appStatusFromAnilist,
  type AnilistScoreFormat,
  type AnilistStatus
} from '../scores'
import type {
  TrackerAuthFlow,
  TrackerCapabilities,
  TrackerEntry,
  TrackerListOptions,
  TrackerRateCacheCodec,
  TrackerRateEntry,
  TrackerRateEntryPayload,
  TrackerRateField,
  TrackerRef,
  TrackerSyncProvider
} from '../types'
import { classifyAnilistError } from './classify'
import { ANILIST_AUTHORIZE_URL, createAniListClient, type AniListClient } from './client'
import { AniListApiError, AniListSessionError, AniListUnmappedError } from './errors'
import { createAniListIdMap, pickMedia, type AniListIdMap } from './id-map'
import type { AniListLimiter, AniListPriority } from './limiter'
import * as Q from './queries'

/** AniList's session: the token and the account `anilistUser` named when it was read. */
export interface AniListSession {
  token: string
  userId: number
}

/** `anilistCredentials`, in the vault: the pasted token and its JWT `exp` in ms. */
export interface AniListCredentials {
  accessToken: string
  /** Null when the token's payload can't be decoded; then there is no expiry warning. */
  expiresAt: number | null
}

/**
 * `anilistUser`: the account plus what the `Viewer` check cached. The token's
 * expiry is mirrored here, in plain text, so the accounts state reads it
 * without decrypting the vault.
 */
export interface AniListUser extends TrackerUser {
  scoreFormat: AnilistScoreFormat
  displayAdultContent: boolean
  tokenExpiresAt: number | null
}

export interface AniListMedia {
  id: number
  idMal: number | null
  title?: { romaji?: string | null; english?: string | null } | null
  coverImage?: { large?: string | null } | null
  format?: string | null
  episodes?: number | null
  status?: string | null
  nextAiringEpisode?: { episode?: number | null } | null
}

/** One `MediaListCollection` entry, as read. */
export interface AniListListEntry {
  id: number
  mediaId: number
  status: AnilistStatus
  score: number | null
  progress: number | null
  repeat: number | null
  updatedAt: number | null
  media: AniListMedia
}

/** What `MediaList` and `SaveMediaListEntry` return: `ENTRY_SELECTION`. */
export interface AniListRate {
  id: number
  status: AnilistStatus
  score: number | null
  progress: number | null
  repeat: number | null
  updatedAt: number | null
}

/** An `anilistUserRates` row: the list entry as read, and its smotret join. */
export interface AniListCachedRow {
  entry: AniListListEntry
  smotretAnime: AnimeSearchResult | null
}

/** `getAiringInfo`'s answer (#706's `AiringInfo`). `episodes` null means no cap. */
export interface AniListAiringInfo {
  episodesAired: number
  episodes: number | null
}

/** One `anilistAnimeDetails` entry, keyed by MAL id: list titles only (ToU). */
export interface AniListDetails {
  anilistId: number
  description: string | null
  genres: string[]
  status: string | null
  episodes: number | null
  episodesAired: number
  kind: string | null
  at: number
}

/**
 * The rewatch-count shift (#703 § 5): what AniList's `repeat` reads as in the
 * app's count-at-start semantics, on a `REPEATING` entry. 0 is the identity
 * (AniList counts at the start too). Unverified: the Verify task "whether
 * `repeat` counts a rewatch at its start" decides it, and a count-at-completion
 * answer makes it 1.
 */
export const ANILIST_REPEAT_SHIFT = 0

/** How long the list cache and a details entry answer `getAiringInfo` (#706). */
export const AIRING_FRESH_MS = 6 * 60 * 60 * 1000

export const TOKEN_NOT_ACCEPTED = "That token wasn't accepted"

const CRED_KEY = 'anilistCredentials'
const USER_KEY = 'anilistUser'
const RATES_KEY = 'anilistUserRates'
const DETAILS_KEY = 'anilistAnimeDetails'
const MAX_LIST_CHUNKS = 100
/** `Page.following` pages read at most (#712): 200 followed users, the rest logged as truncated. */
export const MAX_FOLLOWING_PAGES = 4

const CAPABILITIES: TrackerCapabilities = {
  getAiringInfo: true,
  getCalendar: true,
  getRelated: true,
  getRecommendations: true,
  getDetails: true,
  getFriends: true,
  getFriendsActivity: true,
  getFriendsRates: true
}

/**
 * A followed user, as `anilistFriends` keeps it (#712): the display fields
 * only, `mean` on the 0–10 scale.
 */
export interface AniListFriend {
  id: number
  nickname: string
  avatar: string
  titles: number
  mean: number
}

/** `statistics.anime.meanScore` (0–100, no `format` argument) on the app's 0–10 scale. */
export function friendMeanOf(meanScore: number | null | undefined): number {
  // / 10, kept to the hundredths so 78.4 reads 7.84, not 7.840000000000001.
  return typeof meanScore === 'number' && Number.isFinite(meanScore)
    ? Math.round(meanScore * 10) / 100
    : 0
}

// ---- Value mapping ---------------------------------------------------------

/** `repeat` in the app's count-at-start semantics. */
export function appRewatches(
  repeat: number | null | undefined,
  status: AnilistStatus,
  shift: number = ANILIST_REPEAT_SHIFT
): number {
  const n = Math.max(0, repeat ?? 0)
  return status === 'REPEATING' ? n + shift : n
}

/** The app's rewatch count as AniList's native `repeat`, keyed on the status written. */
export function nativeRepeat(
  rewatches: number,
  status: RateValues['status'],
  shift: number = ANILIST_REPEAT_SHIFT
): number {
  return status === 'rewatching' ? Math.max(0, rewatches - shift) : Math.max(0, rewatches)
}

export function rateValuesOf(
  rate: Pick<AniListRate, 'status' | 'score' | 'progress' | 'repeat'>,
  shift: number = ANILIST_REPEAT_SHIFT
): RateValues {
  return {
    episodes: rate.progress ?? 0,
    status: appStatusFromAnilist(rate.status),
    score: appScoreFromAnilistRaw(rate.score ?? 0),
    rewatches: appRewatches(rate.repeat, rate.status, shift)
  }
}

/** Aired episodes: `nextAiringEpisode − 1`, else a finished title's total, else 0. */
export function episodesAiredOf(media: AniListMedia | null | undefined): number {
  const next = media?.nextAiringEpisode?.episode
  if (typeof next === 'number') return Math.max(0, next - 1)
  if (media?.status === 'FINISHED') return media.episodes ?? 0
  return 0
}

/** AniList's `MediaStatus` in Shikimori's words (#706); a status with none is unknown. */
const STATUS_WORDS: Readonly<Record<string, TrackerDetails['status']>> = {
  FINISHED: 'released',
  RELEASING: 'ongoing',
  HIATUS: 'ongoing',
  NOT_YET_RELEASED: 'anons'
}

/** `description(asHtml: false)` still carries `<br>` and `<i>`: plain text, or null. */
export function plainDescription(text: string | null | undefined): string | null {
  if (!text) return null
  // Until nothing changes, so a tag spliced from two halves goes too. The
  // renderer shows it as text either way.
  let stripped = text.replace(/<br\s*\/?>/gi, '\n')
  let prev: string
  do {
    prev = stripped
    stripped = stripped.replace(/<[^>]*>/g, '')
  } while (stripped !== prev)
  const plain = stripped
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return plain || null
}

/** An `anilistAnimeDetails` entry as `tracker:get-details` returns it (#706). */
export function trackerDetailsOf(d: Omit<AniListDetails, 'at' | 'anilistId'>): TrackerDetails {
  return {
    description: plainDescription(d.description),
    genres: d.genres ?? [],
    status: (d.status && STATUS_WORDS[d.status]) || null,
    episodes: d.episodes ?? null,
    episodesAired: d.episodesAired ?? null,
    kind: d.kind ? d.kind.toLowerCase() : null
  }
}

export function titleOf(media: AniListMedia | null | undefined): string {
  return media?.title?.english || media?.title?.romaji || ''
}

function animeOf(media: AniListMedia | null | undefined): TrackerRateEntryPayload['anime'] {
  return {
    title: titleOf(media),
    poster: media?.coverImage?.large ?? null,
    // `large` is the biggest cover the queries ask for.
    posterOriginal: media?.coverImage?.large ?? null,
    kind: media?.format ?? null,
    episodes: media?.episodes ?? null,
    episodesAired: media ? episodesAiredOf(media) : null,
    status: media?.status ?? null
  }
}

const updatedAtMs = (s: number | null | undefined): number | null =>
  typeof s === 'number' && Number.isFinite(s) && s > 0 ? s * 1000 : null

/** The JWT's `exp` in ms, decoded from the payload segment (not verified), or null. */
export function jwtExpiry(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof parsed.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp * 1000 : null
  } catch {
    return null
  }
}

function isNotFound(err: unknown): boolean {
  if (!(err instanceof AniListApiError) || err instanceof AniListUnmappedError) return false
  return err.errorStatus === 404 || (err.errorStatus === null && err.status === 404)
}

// ---- The provider ----------------------------------------------------------

export interface AniListProviderDeps {
  store: StorageService
  vault: Pick<CredentialVault, 'read' | 'commit'>
  /** Defaults to a client on `limiter`, reporting refusals to `expireSession`. */
  client?: AniListClient
  /** The client's limiter: the module-level host limiter unless a test passes its own. */
  limiter?: AniListLimiter
  /** The smotret join for listed rows, as the rate refresh does it. */
  lookupByMalIds?: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  /** While offline the details prefetch returns early, as Shikimori's does. */
  isOffline?: () => boolean
  /**
   * After a 401 cleared the stored token: `index.ts` broadcasts the sync status
   * and calls `notifyAccountsChanged()` (#696 § 6).
   */
  onSessionExpired?: () => void
  /**
   * After each `anilistAnimeDetails` write, with the entry normalized (#706):
   * `index.ts` passes the sync instance's `broadcastDetails`.
   */
  onDetailsWritten?: (malId: number, details: TrackerDetails) => void
  now?: () => number
  log?: Pick<Console, 'log' | 'warn'>
  /** The rewatch shift; tests run a non-zero one. */
  repeatShift?: number
}

export interface AniListListOptions extends TrackerListOptions {
  priority?: AniListPriority
  signal?: AbortSignal
}

export interface AniListRelatedMedia {
  id: number
  idMal: number | null
  relations: { edges: { relationType: string; node: { id: number; type?: string } }[] }
  [key: string]: unknown
}

export interface AniListProvider extends TrackerSyncProvider<
  AniListSession,
  AniListListEntry,
  AniListRate,
  AniListCachedRow
> {
  readonly idMap: AniListIdMap
  listEntries(
    session: AniListSession,
    opts?: AniListListOptions
  ): Promise<TrackerRateEntry<AniListListEntry>[]>
  /** The AniList media id for a MAL id at `priority`, or null when it isn't on AniList. */
  resolveRef(
    malId: number,
    opts?: { priority?: AniListPriority }
  ): Promise<(TrackerRef & { mediaId: number }) | null>
  getAiringInfo(malId: number): Promise<AniListAiringInfo | null>
  getDetails(malId: number): Promise<Omit<AniListDetails, 'at' | 'anilistId'> | null>
  getCalendar(opts?: { ids?: readonly number[] }): Promise<unknown[]>
  getRelated(ref: TrackerRef): Promise<unknown[] | null>
  /** T11c's level-batched walk (#710): AniList ids in, matched on `id`, ANIME edges only. */
  getRelatedBatch(
    anilistIds: readonly number[],
    opts?: { priority?: AniListPriority }
  ): Promise<Map<number, AniListRelatedMedia>>
  getRecommendations(seedMalIds: readonly number[]): Promise<unknown[]>
  /** `Page.following` of the session's user, up to `MAX_FOLLOWING_PAGES` × 50 (#712). */
  getFriends(session: AniListSession): Promise<AniListFriend[]>
  /** One page of 50 of `Page.mediaList(mediaId, isFollowing)`; `[]` for an unmapped title. */
  getFriendsRates(session: AniListSession, malId: number): Promise<unknown[]>
  /** One page of 50 `ANIME_LIST` activities, adult media dropped unless `displayAdultContent`. */
  getFriendsActivity(session: AniListSession): Promise<unknown[]>
  /** The list titles' details, in batches of 50 at `prefetch`. Never beyond the list (ToU). */
  prefetchDetails(): Promise<void>
  /**
   * A `tracker:get-details` miss (#706): joins the running prefetch, else starts
   * one; nothing for a title not on the list.
   */
  requestPrefetch(malId: number): Promise<void>
  /** Aborts a running prefetch; its queued requests leave the limiter. */
  abortPrefetch(): void
  /** `refreshRates` wrote `anilistUserRates`: the list cache's age for `getAiringInfo`. */
  markRatesFetched(): void
  ratesFetchedAt(): number
  /** The session-expiry path for a refused token (§ 1); a no-op unless it is the stored one. */
  expireSession(token: string): Promise<void>
}

export function createAniListProvider(deps: AniListProviderDeps): AniListProvider {
  const { store, vault } = deps
  const now = deps.now ?? Date.now
  const log = deps.log ?? console
  const shift = deps.repeatShift ?? ANILIST_REPEAT_SHIFT
  const client =
    deps.client ??
    createAniListClient({
      limiter: deps.limiter,
      onTokenRejected: (token) => void expireSession(token)
    })

  const cachedRows = (): AniListCachedRow[] =>
    (store.get(RATES_KEY) as AniListCachedRow[] | undefined) ?? []
  const listMediaIds = (): ReadonlySet<number> =>
    new Set(
      cachedRows().flatMap((r) => (typeof r?.entry?.mediaId === 'number' ? [r.entry.mediaId] : []))
    )
  const idMap = createAniListIdMap({ store, client, listMediaIds, now })
  const storedUser = (): AniListUser | null =>
    (store.get(USER_KEY) as AniListUser | null | undefined) ?? null
  const scoreFormat = (): AnilistScoreFormat => storedUser()?.scoreFormat ?? 'POINT_10'
  const showAdult = (): boolean => storedUser()?.displayAdultContent === true

  let ratesFetched = 0
  let prefetchController: AbortController | null = null
  const offListAiring = new Map<number, { info: AniListAiringInfo | null; at: number }>()

  // -- the codec -------------------------------------------------------------

  // The raw score a cache row keeps for an app score: the stored one while it
  // still reads as that score, else the app score on the format's own step,
  // where AniList stores it (a `POINT_3` 9 is 85, not 90).
  const cachedRaw = (appScore: number, storedRaw: number | null): number => {
    const format = scoreFormat()
    const raw = anilistRawToStore(appScore, storedRaw, format)
    return raw === storedRaw ? raw : anilistQuantize(raw, format)
  }

  const malIdOfRow = (row: AniListCachedRow): number | undefined => {
    const id = row?.entry?.media?.idMal
    return typeof id === 'number' ? id : undefined
  }

  const rateCache: TrackerRateCacheCodec<AniListListEntry, AniListCachedRow> = {
    fromEntries: (entries) =>
      entries.map((e) => ({ entry: e.native, smotretAnime: e.smotretAnime ?? null })),
    malIdOf: malIdOfRow,
    indexOf: (rows, malId) => rows.findIndex((r) => malIdOfRow(r) === malId),
    read: (row) => ({
      remoteId: typeof row.entry.id === 'number' ? row.entry.id : null,
      values: rateValuesOf(row.entry, shift)
    }),
    patch(row, values, remoteId) {
      return {
        ...row,
        entry: {
          ...row.entry,
          ...(remoteId !== undefined ? { id: remoteId } : {}),
          status: anilistStatusFromApp(values.status),
          progress: values.episodes,
          score: cachedRaw(values.score, row.entry.score ?? null),
          repeat: nativeRepeat(values.rewatches, values.status, shift),
          updatedAt: Math.floor(now() / 1000)
        }
      }
    },
    entryOf: (row) =>
      ({
        trackerId: 'anilist',
        malId: malIdOfRow(row) as number,
        remoteId: typeof row.entry.id === 'number' ? row.entry.id : null,
        values: rateValuesOf(row.entry, shift),
        updatedAt: updatedAtMs(row.entry.updatedAt),
        anime: animeOf(row.entry.media),
        smotretAnime: row.smotretAnime ?? null
      }) satisfies TrackerRateEntryPayload
  }

  // -- the session -----------------------------------------------------------

  async function auth(): Promise<AniListSession> {
    // Before the first await: the owner the drain read at its presence check.
    const user = storedUser()
    const read = await vault.read<AniListCredentials>(CRED_KEY)
    if (!user) throw new Error('Not logged in to AniList')
    if (read.state === 'ok' && typeof read.value?.accessToken === 'string') {
      return { token: read.value.accessToken, userId: user.id }
    }
    throw new AniListSessionError(
      read.state === 'locked'
        ? 'Your AniList sign-in can’t be read on this device — sign in again in Settings → Trackers'
        : undefined
    )
  }

  async function expireSession(token: string): Promise<void> {
    const blob = store.get(CRED_KEY) as VaultBlob | null | undefined
    if (!blob) return
    const read = await vault.read<AniListCredentials>(CRED_KEY)
    if (read.state !== 'ok' || read.value?.accessToken !== token) return
    // A sign-in that committed a new token meanwhile keeps it.
    const current = store.get(CRED_KEY) as VaultBlob | null | undefined
    if (!current || current.data !== blob.data) return
    store.set('anilistSessionExpired', true)
    vault.commit(CRED_KEY, null)
    log.warn('[anilist] the token was rejected: session expired')
    deps.onSessionExpired?.()
  }

  // -- sign-in -----------------------------------------------------------------

  async function viewer(token: string): Promise<AniListUser> {
    const data = await client.request<{
      Viewer: {
        id: number
        name: string
        avatar?: { medium?: string | null } | null
        options?: { displayAdultContent?: boolean | null } | null
        mediaListOptions?: { scoreFormat?: AnilistScoreFormat | null } | null
      } | null
    }>(Q.VIEWER, {}, { priority: 'interactive', token, reportRejection: false })
    const v = data?.Viewer
    if (!v || typeof v.id !== 'number') {
      throw new AniListApiError('AniList returned no account for that token', 200, '', null)
    }
    return {
      id: v.id,
      nickname: v.name,
      avatar: v.avatar?.medium ?? null,
      scoreFormat: v.mediaListOptions?.scoreFormat ?? 'POINT_10',
      displayAdultContent: v.options?.displayAdultContent === true,
      tokenExpiresAt: null
    }
  }

  /** "That token wasn't accepted" for every failure but a transient one (§ 1). */
  function rejectionOf(err: unknown): unknown {
    const cls = classifyAnilistError(err)
    if (cls === 'network') return err
    if (cls === 'server' || cls === 'rate-limit') {
      const api = err as TrackerApiError
      return new AniListApiError(
        'AniList isn’t answering right now. Try again in a minute.',
        api.status,
        api.body,
        err instanceof AniListApiError ? err.errorStatus : null,
        { cause: err }
      )
    }
    const api = err instanceof TrackerApiError ? err : null
    // Kept `auth`-class whatever the cause, so the card reads it as a refusal.
    return new AniListApiError(TOKEN_NOT_ACCEPTED, 401, api?.body ?? '', 401, { cause: err })
  }

  const authFlow: TrackerAuthFlow = {
    paste: 'token',
    begin: () => ({ authorizeUrl: ANILIST_AUTHORIZE_URL }),
    async exchange(input) {
      const token = input.trim()
      let user: AniListUser
      try {
        user = await viewer(token)
      } catch (err) {
        throw rejectionOf(err)
      }
      const expiresAt = jwtExpiry(token)
      const credentials: AniListCredentials = { accessToken: token, expiresAt }
      return { credentials, user: { ...user, tokenExpiresAt: expiresAt } }
    }
  }

  // -- the list ----------------------------------------------------------------

  async function mediaIdFor(
    malId: number,
    priority: AniListPriority,
    signal?: AbortSignal
  ): Promise<number> {
    const map = await idMap.resolve([malId], { priority, signal })
    const id = map.get(malId)
    if (typeof id !== 'number') throw new AniListUnmappedError(malId)
    return id
  }

  function toEntry(malId: number, rate: AniListRate): TrackerEntry<AniListRate> {
    return {
      trackerId: 'anilist',
      malId,
      remoteId: rate.id,
      values: rateValuesOf(rate, shift),
      native: rate
    }
  }

  async function listEntries(
    session: AniListSession,
    opts: AniListListOptions = {}
  ): Promise<TrackerRateEntry<AniListListEntry>[]> {
    const priority = opts.priority ?? 'interactive'
    const raw: AniListListEntry[] = []
    for (let chunk = 1; chunk <= MAX_LIST_CHUNKS; chunk++) {
      const data = await client.request<{
        MediaListCollection: {
          hasNextChunk?: boolean | null
          lists?: { isCustomList?: boolean | null; entries?: AniListListEntry[] | null }[] | null
        } | null
      }>(
        Q.MEDIA_LIST_COLLECTION,
        {
          userId: session.userId,
          chunk,
          perChunk: Q.LIST_CHUNK_SIZE,
          ...(opts.status ? { status: anilistStatusFromApp(opts.status) } : {})
        },
        { priority, token: session.token, signal: opts.signal }
      )
      const coll = data?.MediaListCollection
      for (const list of coll?.lists ?? []) {
        // Custom lists repeat entries that are on a status list already.
        if (!list || list.isCustomList) continue
        for (const e of list.entries ?? []) if (e) raw.push(e)
      }
      if (!coll?.hasNextChunk) break
    }

    const byMedia = new Map<number, AniListListEntry>()
    for (const e of raw) if (!byMedia.has(e.mediaId)) byMedia.set(e.mediaId, e)
    let noIdMal = 0
    let duplicates = 0
    const byMal = new Map<number, AniListListEntry>()
    for (const e of byMedia.values()) {
      const malId = e.media?.idMal
      if (typeof malId !== 'number') {
        noIdMal++
        continue
      }
      const prev = byMal.get(malId)
      if (!prev) byMal.set(malId, e)
      else {
        duplicates++
        // Both are on the list: the § 4 rule keeps the lowest media id.
        if (e.media.id < prev.media.id) byMal.set(malId, e)
      }
    }
    if (noIdMal > 0 || duplicates > 0) {
      log.log(
        `[anilist] list refresh: ${byMal.size} entries; left out ${noIdMal} with no MAL id and ${duplicates} sharing a MAL id`
      )
    }
    const kept = [...byMal.values()]
    idMap.seed(kept.map((e) => ({ malId: e.media.idMal as number, anilistId: e.media.id })))
    const malIds = kept.map((e) => e.media.idMal as number)
    const smotret =
      deps.lookupByMalIds && malIds.length > 0 ? await deps.lookupByMalIds(malIds) : {}
    return kept.map((e) => {
      const malId = e.media.idMal as number
      return {
        trackerId: 'anilist',
        malId,
        remoteId: e.id,
        values: rateValuesOf(e, shift),
        updatedAt: updatedAtMs(e.updatedAt),
        anime: animeOf(e.media),
        smotretAnime: smotret[malId] ?? null,
        native: e
      }
    })
  }

  async function getEntry(
    session: AniListSession,
    ref: TrackerRef
  ): Promise<TrackerEntry<AniListRate> | null> {
    const mediaId = await mediaIdFor(ref.malId, 'interactive')
    let data: { MediaList: AniListRate | null }
    try {
      data = await client.request(
        Q.MEDIA_LIST,
        { userId: session.userId, mediaId },
        { priority: 'interactive', token: session.token }
      )
    } catch (err) {
      // "Not found" comes through `errors`: the drain takes its create branch.
      if (isNotFound(err)) return null
      // A refused token (a 400 or 401 `Invalid token`, an `errors[].status`
      // 401, the limiter's dead-token rejection) is the session gone, so
      // `tracker:get-rate` and the cold-cache read answer as they do once the
      // credential is cleared (#740). `onTokenRejected` clears it on its own.
      if (classifyAnilistError(err) === 'auth')
        throw new AniListSessionError(undefined, { cause: err })
      throw err
    }
    return data?.MediaList ? toEntry(ref.malId, data.MediaList) : null
  }

  async function upsertEntry(
    session: AniListSession,
    ref: TrackerRef,
    values: RateValues,
    changedFields: readonly TrackerRateField[]
  ): Promise<TrackerEntry<AniListRate>> {
    const mediaId = await mediaIdFor(ref.malId, 'interactive')
    const changed = new Set(changedFields)
    const vars: Record<string, unknown> = { mediaId }
    if (changed.has('status')) vars.status = anilistStatusFromApp(values.status)
    if (changed.has('episodes')) vars.progress = values.episodes
    if (changed.has('score')) vars.scoreRaw = anilistRawFromAppScore(values.score)
    // Under a non-zero shift a status write into or out of `rewatching` moves
    // the native count even when the app's doesn't change.
    if (changed.has('rewatches') || (shift !== 0 && changed.has('status'))) {
      vars.repeat = nativeRepeat(values.rewatches, values.status, shift)
    }
    if (Object.keys(vars).length === 1) {
      // Nothing to write: answer with the entry as it stands, sending no write.
      const current = await getEntry(session, ref)
      if (current) return current
      vars.status = anilistStatusFromApp(values.status)
      vars.progress = values.episodes
      vars.scoreRaw = anilistRawFromAppScore(values.score)
      vars.repeat = nativeRepeat(values.rewatches, values.status, shift)
    }
    const data = await client.request<{ SaveMediaListEntry: AniListRate }>(
      Q.SAVE_MEDIA_LIST_ENTRY,
      vars,
      { priority: 'interactive', token: session.token }
    )
    return toEntry(ref.malId, data.SaveMediaListEntry)
  }

  async function deleteEntry(session: AniListSession, ref: TrackerRef): Promise<void> {
    if (ref.remoteId === null) return
    try {
      await client.request(
        Q.DELETE_MEDIA_LIST_ENTRY,
        { id: ref.remoteId },
        { priority: 'interactive', token: session.token }
      )
    } catch (err) {
      // Already gone: the one write whose 404 isn't `item`.
      if (isNotFound(err)) return
      throw err
    }
  }

  // -- capabilities ----------------------------------------------------------

  async function resolveRef(
    malId: number,
    opts: { priority?: AniListPriority } = {}
  ): Promise<(TrackerRef & { mediaId: number }) | null> {
    const map = await idMap.resolve([malId], { priority: opts.priority ?? 'interactive' })
    const mediaId = map.get(malId)
    if (typeof mediaId !== 'number') return null
    const row = cachedRows().find((r) => malIdOfRow(r) === malId)
    return { malId, remoteId: row ? row.entry.id : null, mediaId }
  }

  const airingOf = (media: AniListMedia): AniListAiringInfo => ({
    episodesAired: episodesAiredOf(media),
    episodes: media.episodes ?? null
  })

  function detailsStore(): Record<string, AniListDetails> {
    return (store.get(DETAILS_KEY) as Record<string, AniListDetails> | undefined) ?? {}
  }

  async function getAiringInfo(malId: number): Promise<AniListAiringInfo | null> {
    const t = now()
    const row = cachedRows().find((r) => malIdOfRow(r) === malId)
    if (row && ratesFetched > 0 && t - ratesFetched < AIRING_FRESH_MS)
      return airingOf(row.entry.media)
    const details = detailsStore()[String(malId)]
    if (details && t - details.at < AIRING_FRESH_MS) {
      return { episodesAired: details.episodesAired, episodes: details.episodes }
    }
    const memo = offListAiring.get(malId)
    if (!row && memo && t - memo.at < AIRING_FRESH_MS) return memo.info
    const data = await client.request<{ Page: { media: AniListMedia[] | null } }>(
      Q.AIRING_LOOKUP,
      { ids: [malId] },
      { priority: 'interactive' }
    )
    const matches = (data?.Page?.media ?? []).filter((m) => m?.idMal === malId)
    const chosen = matches.length
      ? matches.find(
          (m) =>
            m.id ===
            pickMedia(
              matches.map((x) => x.id),
              listMediaIds()
            )
        )!
      : null
    const info = chosen ? airingOf(chosen) : null
    // In memory only: an off-list title's answer is never stored (ToU).
    if (!row) offListAiring.set(malId, { info, at: t })
    return info
  }

  const detailsOf = (m: {
    id: number
    description?: string | null
    genres?: string[] | null
    status?: string | null
    episodes?: number | null
    format?: string | null
    nextAiringEpisode?: { episode?: number | null } | null
  }): Omit<AniListDetails, 'at'> => ({
    anilistId: m.id,
    description: m.description ?? null,
    genres: m.genres ?? [],
    status: m.status ?? null,
    episodes: m.episodes ?? null,
    episodesAired: episodesAiredOf(m as AniListMedia),
    kind: m.format ?? null
  })

  type DetailsMedia = Parameters<typeof detailsOf>[0] & { idMal: number | null }

  async function fetchDetails(
    malIds: readonly number[],
    priority: AniListPriority,
    signal?: AbortSignal
  ): Promise<Map<number, Omit<AniListDetails, 'at'>>> {
    const out = new Map<number, Omit<AniListDetails, 'at'>>()
    const onList = listMediaIds()
    for (let i = 0; i < malIds.length; i += Q.PAGE_SIZE) {
      const chunk = malIds.slice(i, i + Q.PAGE_SIZE)
      const data = await client.request<{ Page: { media: DetailsMedia[] | null } }>(
        Q.DETAILS_LOOKUP,
        { ids: chunk },
        { priority, signal }
      )
      const byMal = new Map<number, DetailsMedia[]>()
      for (const m of data?.Page?.media ?? []) {
        if (typeof m?.idMal !== 'number') continue
        byMal.set(m.idMal, [...(byMal.get(m.idMal) ?? []), m])
      }
      for (const [malId, media] of byMal) {
        const id = pickMedia(
          media.map((m) => m.id),
          onList
        )
        out.set(malId, detailsOf(media.find((m) => m.id === id)!))
      }
    }
    return out
  }

  async function getDetails(
    malId: number
  ): Promise<Omit<AniListDetails, 'at' | 'anilistId'> | null> {
    const cached = detailsStore()[String(malId)]
    if (cached) {
      const { at: _at, anilistId: _id, ...details } = cached
      return details
    }
    const fetched = (await fetchDetails([malId], 'interactive')).get(malId)
    if (!fetched) return null
    const { anilistId: _id, ...details } = fetched
    // Stored for a list title only (ToU clauses 2 and 3).
    if (cachedRows().some((r) => malIdOfRow(r) === malId)) {
      store.set(DETAILS_KEY, { ...detailsStore(), [String(malId)]: { ...fetched, at: now() } })
      deps.onDetailsWritten?.(malId, trackerDetailsOf(details))
    }
    return details
  }

  function cachedDetails(malId: number): TrackerDetails | null {
    const cached = detailsStore()[String(malId)]
    return cached ? trackerDetailsOf(cached) : null
  }

  // The prefetch in flight, which a `tracker:get-details` miss joins (#706).
  let prefetchRun: Promise<void> | null = null

  function prefetchDetails(): Promise<void> {
    const run = walkDetails()
    prefetchRun = run
    const clear = (): void => {
      if (prefetchRun === run) prefetchRun = null
    }
    run.then(clear, clear)
    return run
  }

  // A details miss (#706): nothing for a title off the list, which the
  // prefetch never fetches (ToU); the running prefetch if there is one, so a
  // miss never restarts it (Prepare-offline awaits it); else a new one.
  function requestPrefetch(malId: number): Promise<void> {
    if (!cachedRows().some((r) => malIdOfRow(r) === malId)) return Promise.resolve()
    return prefetchRun ?? prefetchDetails()
  }

  async function walkDetails(): Promise<void> {
    if (deps.isOffline?.()) return
    prefetchController?.abort()
    const controller = new AbortController()
    prefetchController = controller
    try {
      const t = now()
      const details = detailsStore()
      const malIds = [
        ...new Set(
          cachedRows().flatMap((r) => (malIdOfRow(r) !== undefined ? [malIdOfRow(r)!] : []))
        )
      ].filter((malId) => {
        const d = details[String(malId)]
        return !d || t - d.at >= DETAILS_STALE_MS
      })
      for (let i = 0; i < malIds.length; i += Q.PAGE_SIZE) {
        if (controller.signal.aborted) return
        const chunk = malIds.slice(i, i + Q.PAGE_SIZE)
        const fetched = await fetchDetails(chunk, 'prefetch', controller.signal)
        if (controller.signal.aborted) return
        const at = now()
        const next = { ...detailsStore() }
        for (const [malId, d] of fetched) next[String(malId)] = { ...d, at }
        store.set(DETAILS_KEY, next)
        for (const [malId, d] of fetched) deps.onDetailsWritten?.(malId, trackerDetailsOf(d))
      }
    } finally {
      if (prefetchController === controller) prefetchController = null
    }
  }

  async function getCalendar(opts: { ids?: readonly number[] } = {}): Promise<unknown[]> {
    const ids =
      opts.ids ??
      cachedRows()
        .filter(
          (r) =>
            r.entry.media?.status === 'RELEASING' || r.entry.media?.status === 'NOT_YET_RELEASED'
        )
        .map((r) => r.entry.media.id)
    const wanted = new Set(ids)
    const out: unknown[] = []
    const adult = showAdult()
    const list = [...wanted]
    for (let i = 0; i < list.length; i += Q.PAGE_SIZE) {
      const data = await client.request<{
        Page: { media: (AniListMedia & { isAdult?: boolean | null })[] | null }
      }>(Q.CALENDAR, { ids: list.slice(i, i + Q.PAGE_SIZE) }, { priority: 'interactive' })
      for (const m of data?.Page?.media ?? []) {
        if (!m || !wanted.has(m.id)) continue
        if (m.isAdult && !adult) continue
        out.push(m)
      }
    }
    return out
  }

  const animeEdges = (media: AniListRelatedMedia): AniListRelatedMedia => ({
    ...media,
    relations: {
      edges: (media.relations?.edges ?? []).filter((e) => e?.node?.type === 'ANIME')
    }
  })

  async function getRelated(ref: TrackerRef): Promise<unknown[] | null> {
    const resolved = await resolveRef(ref.malId)
    if (!resolved) return null
    const data = await client.request<{ Media: AniListRelatedMedia | null }>(
      Q.RELATIONS,
      { id: resolved.mediaId },
      { priority: 'interactive' }
    )
    return data?.Media ? animeEdges(data.Media).relations.edges : []
  }

  async function getRelatedBatch(
    anilistIds: readonly number[],
    opts: { priority?: AniListPriority } = {}
  ): Promise<Map<number, AniListRelatedMedia>> {
    const wanted = [...new Set(anilistIds)]
    const out = new Map<number, AniListRelatedMedia>()
    for (let i = 0; i < wanted.length; i += Q.PAGE_SIZE) {
      const chunk = wanted.slice(i, i + Q.PAGE_SIZE)
      const data = await client.request<{ Page: { media: AniListRelatedMedia[] | null } }>(
        Q.RELATED_BATCH,
        { ids: chunk },
        { priority: opts.priority ?? 'interactive' }
      )
      const asked = new Set(chunk)
      for (const m of data?.Page?.media ?? []) {
        if (m && asked.has(m.id)) out.set(m.id, animeEdges(m))
      }
    }
    return out
  }

  async function getRecommendations(seedMalIds: readonly number[]): Promise<unknown[]> {
    const map = await idMap.resolve(seedMalIds, { priority: 'interactive' })
    const ids = [...map.values()].filter((id): id is number => typeof id === 'number')
    const adult = showAdult()
    type Node = {
      rating?: number | null
      mediaRecommendation?: (AniListMedia & { isAdult?: boolean | null; type?: string }) | null
    }
    const out: unknown[] = []
    for (let i = 0; i < ids.length; i += Q.PAGE_SIZE) {
      const chunk = ids.slice(i, i + Q.PAGE_SIZE)
      const data = await client.request<{
        Page: {
          media:
            | {
                id: number
                idMal: number | null
                recommendations?: { nodes?: Node[] | null } | null
              }[]
            | null
        }
      }>(Q.RECOMMENDATIONS, { ids: chunk }, { priority: 'interactive' })
      const asked = new Set(chunk)
      for (const m of data?.Page?.media ?? []) {
        if (!m || !asked.has(m.id)) continue
        const nodes = (m.recommendations?.nodes ?? []).filter(
          (n) => n?.mediaRecommendation && (adult || !n.mediaRecommendation.isAdult)
        )
        out.push({ seedAnilistId: m.id, seedMalId: m.idMal, recommendations: nodes })
      }
    }
    return out
  }

  async function getFriends(session: AniListSession): Promise<AniListFriend[]> {
    type User = {
      id?: number | null
      name?: string | null
      avatar?: { medium?: string | null } | null
      statistics?: { anime?: { count?: number | null; meanScore?: number | null } | null } | null
    }
    const out: AniListFriend[] = []
    for (let page = 1; page <= MAX_FOLLOWING_PAGES; page++) {
      const data = await client.request<{
        Page: { pageInfo?: { hasNextPage?: boolean | null } | null; following: User[] | null }
      }>(
        Q.FOLLOWING,
        { userId: session.userId, page },
        { priority: 'interactive', token: session.token }
      )
      for (const u of data?.Page?.following ?? []) {
        if (typeof u?.id !== 'number' || typeof u.name !== 'string') continue
        out.push({
          id: u.id,
          nickname: u.name,
          avatar: u.avatar?.medium ?? '',
          titles: u.statistics?.anime?.count ?? 0,
          mean: friendMeanOf(u.statistics?.anime?.meanScore)
        })
      }
      if (!data?.Page?.pageInfo?.hasNextPage) break
      if (page === MAX_FOLLOWING_PAGES) {
        log.warn(
          `[anilist] following: more than ${MAX_FOLLOWING_PAGES * Q.PAGE_SIZE} users, showing the first ${out.length}`
        )
      }
    }
    return out
  }

  async function getFriendsRates(session: AniListSession, malId: number): Promise<unknown[]> {
    const resolved = await resolveRef(malId)
    if (!resolved) return []
    const data = await client.request<{
      Page: { mediaList: ({ user?: { id?: number | null } | null } | null)[] | null }
    }>(
      Q.FRIENDS_RATES,
      { mediaId: resolved.mediaId, page: 1 },
      { priority: 'interactive', token: session.token }
    )
    return (data?.Page?.mediaList ?? []).filter((r) => r && notViewer(session, r)) as unknown[]
  }

  // `isFollowing: true` also answers the viewer's own rows (#712's real-account
  // check), so both friends reads drop the session's user.
  const notViewer = (session: AniListSession, row: { user?: { id?: unknown } | null }): boolean =>
    row.user?.id !== session.userId

  async function getFriendsActivity(session: AniListSession): Promise<unknown[]> {
    const data = await client.request<{
      Page: {
        activities:
          | ({
              user?: { id?: number | null } | null
              media?: { isAdult?: boolean | null } | null
            } | null)[]
          | null
      }
    }>(Q.FRIENDS_ACTIVITY, { page: 1 }, { priority: 'interactive', token: session.token })
    const adult = showAdult()
    return (data?.Page?.activities ?? []).filter(
      (a) => a && a.media && notViewer(session, a) && (adult || !a.media.isAdult)
    ) as unknown[]
  }

  return {
    id: 'anilist',
    capabilities: CAPABILITIES,
    idMap,
    auth,
    authFlow,
    getUser: (token) => viewer(token),
    classifyError: classifyAnilistError,
    isSessionGone: (err) => err instanceof AniListSessionError,
    rateCache,
    listEntries,
    getEntry,
    upsertEntry,
    deleteEntry,
    hasTitle: (malId) => idMap.known(malId) !== null,
    resolveRef,
    getAiringInfo,
    getDetails,
    cachedDetails,
    getCalendar,
    getRelated,
    getRelatedBatch,
    getRecommendations,
    getFriends,
    getFriendsRates,
    getFriendsActivity,
    prefetchDetails,
    requestPrefetch,
    abortPrefetch: () => prefetchController?.abort(),
    markRatesFetched: () => void (ratesFetched = now()),
    ratesFetchedAt: () => ratesFetched,
    expireSession
  }
}
