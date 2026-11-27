// The MyAnimeList `TrackerProvider` (#702): the list read and write, the
// session, the rate-cache codec and the relations / recommendations / details
// reads. Every request goes through `client.ts`; every user call carries the
// session's token and retries once on a `401 invalid_token` (`auth.ts`).
// `docs/trackers.md` § MyAnimeList has the tables.

import { malApiBase } from '../../lib/api-bases'
import type { RateValues } from '../../lib/shikimori-rate'
import type { AnimeSearchResult } from '../../smotret-api'
import type { StorageService } from '../../store/types'
import { TrackerApiError } from '../errors'
import { appStatusFromMal, malStatusFromApp, type MalStatus } from '../scores'
import { parseUpdatedAt } from '../shikimori.provider'
import {
  TRACKER_CAPABILITIES,
  type TrackerCapabilities,
  type TrackerEntry,
  type TrackerRateCacheCodec,
  type TrackerRateEntry,
  type TrackerRateEntryPayload,
  type TrackerRateField,
  type TrackerSyncProvider
} from '../types'
import { fetchMalUser, type MalAuth } from './auth'
import { classifyMalError } from './classify'
import type { MalClient, MalFormValue } from './client'
import { MalSessionGoneError } from './errors'

/**
 * The session (#689 § 1): the access token and `myanimelistUser.id`, plus the
 * lifecycle generation `auth()` read them under, which the one 401 retry
 * checks before it reads the stored token (`auth.ts`'s `withRetry`).
 */
export interface MalSession {
  token: string
  userId: number
  generation: number
}

/** `list_status` as the list read returns it, and `my_list_status` on an entry read or write. */
export interface MalListStatus {
  status: MalStatus
  score: number
  num_episodes_watched: number
  is_rewatching: boolean
  num_times_rewatched?: number
  updated_at?: string
}

export interface MalNode {
  id: number
  title: string
  main_picture?: { medium?: string; large?: string }
  num_episodes?: number
  status?: string
  media_type?: string
}

/** One `data[]` element of `/users/@me/animelist`, as read: the provider's `native`. */
export interface MalListRow {
  node: MalNode
  list_status: MalListStatus
}

/** A `myanimelistUserRates` row: the list row and its smotret join. */
export type MalCachedRow = MalListRow & { smotretAnime: AnimeSearchResult | null }

/** `GET /anime/{id}` for `getRelated`: the title's own kind and date beside its relations. */
export interface MalRelatedRead {
  id: number
  title: string
  main_picture?: { medium?: string; large?: string }
  media_type?: string
  start_date?: string
  related_anime?: {
    node: MalNode
    relation_type: string
    relation_type_formatted?: string
  }[]
}

export type MalProvider = TrackerSyncProvider<MalSession, MalListRow, MalListStatus, MalCachedRow>

/**
 * How many rewatches MAL's `num_times_rewatched` is behind the app's count on
 * a `rewatching` entry. The app counts a rewatch when it starts
 * (`nextWatchedRate`); MAL counts one when it is completed (community reports;
 * not verified against a real account, see `docs/trackers.md`). Reads add it,
 * writes take it off, keyed on the entry's canonical status. 0 would make the
 * translation the identity.
 */
export const MAL_REWATCH_SHIFT: number = 1

const LIST_STATUS_FIELDS =
  'status,score,num_episodes_watched,is_rewatching,num_times_rewatched,updated_at'
// `num_times_rewatched` reportedly only comes back when named.
const LIST_FIELDS = `list_status{${LIST_STATUS_FIELDS}},num_episodes,status,media_type,main_picture`
const ENTRY_FIELDS = `my_list_status{${LIST_STATUS_FIELDS}},num_episodes,status`
const RELATED_FIELDS = 'title,main_picture,media_type,start_date,related_anime'
const DETAILS_FIELDS = [
  'title',
  'main_picture',
  'alternative_titles',
  'start_date',
  'end_date',
  'synopsis',
  'mean',
  'rank',
  'popularity',
  'num_list_users',
  'media_type',
  'status',
  'genres',
  'num_episodes',
  'start_season',
  'source',
  'average_episode_duration',
  'rating',
  'studios'
].join(',')
/**
 * How many titles `myanimelistAnimeDetails` keeps. Every write rewrites the
 * whole store file, so the cache is capped; the oldest fetches go first.
 */
export const MAL_DETAILS_CACHE_MAX = 300

/** One `myanimelistAnimeDetails` entry. */
export interface MalCachedDetails {
  details: unknown
  fetchedAt: number
}

/** `cache` with only its `max` most recently fetched entries. */
export function capDetails(
  cache: Record<string, MalCachedDetails>,
  max: number
): Record<string, MalCachedDetails> {
  const ids = Object.keys(cache)
  if (ids.length <= max) return cache
  const keep = ids
    .sort((a, b) => (cache[b].fetchedAt ?? 0) - (cache[a].fetchedAt ?? 0))
    .slice(0, max)
  return Object.fromEntries(keep.map((id) => [id, cache[id]]))
}

/** The list endpoint's maximum page. */
export const MAL_LIST_PAGE = 1000

/** The app's values for a MAL list status, rewatches translated (`MAL_REWATCH_SHIFT`). */
export function malValues(ls: MalListStatus): RateValues {
  const status = appStatusFromMal({ status: ls.status, is_rewatching: Boolean(ls.is_rewatching) })
  const native = ls.num_times_rewatched ?? 0
  return {
    episodes: ls.num_episodes_watched ?? 0,
    status,
    score: ls.score ?? 0,
    rewatches: native + (status === 'rewatching' ? MAL_REWATCH_SHIFT : 0)
  }
}

/** MAL's own `num_times_rewatched` for the app's values. */
export function malNativeRewatches(values: RateValues): number {
  return Math.max(0, values.rewatches - (values.status === 'rewatching' ? MAL_REWATCH_SHIFT : 0))
}

/** The values as a MAL list status (what the codec patch writes into a cached row). */
function listStatusOf(values: RateValues, prev?: MalListStatus): MalListStatus {
  const pair = malStatusFromApp(values.status)
  return {
    ...prev,
    status: pair.status,
    is_rewatching: pair.is_rewatching,
    score: values.score,
    num_episodes_watched: values.episodes,
    num_times_rewatched: malNativeRewatches(values),
    updated_at: new Date().toISOString()
  }
}

/**
 * The `my_list_status` form for `changedFields` only. Write keys differ from
 * read keys (`num_watched_episodes` vs `num_episodes_watched`). A status write
 * is the pair `status` + `is_rewatching`, and with a non-zero shift also
 * `num_times_rewatched`, since entering or leaving `rewatching` moves MAL's
 * count: all one changed field.
 */
export function malWriteForm(
  values: RateValues,
  changedFields: readonly TrackerRateField[]
): Record<string, MalFormValue> {
  const form: Record<string, MalFormValue> = {}
  const changed = new Set(changedFields)
  if (changed.has('status')) {
    const pair = malStatusFromApp(values.status)
    form.status = pair.status
    form.is_rewatching = pair.is_rewatching
    if (MAL_REWATCH_SHIFT !== 0) form.num_times_rewatched = malNativeRewatches(values)
  }
  if (changed.has('episodes')) form.num_watched_episodes = values.episodes
  if (changed.has('score')) form.score = values.score
  if (changed.has('rewatches')) form.num_times_rewatched = malNativeRewatches(values)
  return form
}

function posterOf(node: MalNode | undefined): string | null {
  const url = node?.main_picture?.large ?? node?.main_picture?.medium
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null
}

function animeOf(node: MalNode | undefined): TrackerRateEntryPayload['anime'] {
  const total = node?.num_episodes ? node.num_episodes : null
  return {
    title: node?.title ?? '',
    poster: posterOf(node),
    kind: node?.media_type ?? null,
    // 0 is MAL's "unknown".
    episodes: total,
    // Only a finished title's total is its aired count; MAL has none for an airing one.
    episodesAired: node?.status === 'finished_airing' ? total : null,
    status: node?.status ?? null
  }
}

function payloadOf(
  row: MalListRow,
  smotretAnime: AnimeSearchResult | null
): TrackerRateEntryPayload {
  return {
    trackerId: 'mal',
    malId: row.node.id,
    // MAL keys entries by the anime id: no id map.
    remoteId: row.node.id,
    values: malValues(row.list_status),
    updatedAt: parseUpdatedAt(row.list_status.updated_at),
    anime: animeOf(row.node),
    smotretAnime
  }
}

/** `myanimelistUserRates`: the `native` rows as read, with their smotret join. */
export const malRateCache: TrackerRateCacheCodec<MalListRow, MalCachedRow> = {
  fromEntries: (entries) =>
    entries.map((e) => ({
      node: e.native.node,
      list_status: e.native.list_status,
      smotretAnime: e.smotretAnime
    })),
  malIdOf: (row) => row.node?.id,
  indexOf: (rows, malId) => rows.findIndex((r) => r.node?.id === malId),
  read: (row) => ({ remoteId: row.node.id, values: malValues(row.list_status) }),
  patch: (row, values) => ({ ...row, list_status: listStatusOf(values, row.list_status) }),
  entryOf: (row) => payloadOf(row, row.smotretAnime ?? null)
}

const CAPABILITIES = Object.fromEntries(
  TRACKER_CAPABILITIES.map((c) => [
    c,
    c === 'getRelated' || c === 'getRecommendations' || c === 'getDetails'
  ])
) as unknown as TrackerCapabilities

export interface MalProviderDeps {
  store: StorageService
  client: MalClient
  auth: MalAuth
  /** The lifecycle's MAL session generation. */
  generation: () => number
  lookupByMalIds?: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export function createMalProvider(deps: MalProviderDeps): MalProvider {
  const { store, client, auth } = deps
  const base = (): string => malApiBase()

  // A user call: the session's token, and rule 1's one retry.
  function userRequest<T>(
    session: MalSession,
    send: (headers: Record<string, string>) => Promise<T>
  ): Promise<T> {
    return auth.withRetry(session.token, session.generation, (token) => send(bearer(token)))
  }

  // A public read by id: the client header, no token.
  async function publicRead(path: string): Promise<unknown> {
    const { body } = await client.request({
      url: `${base()}${path}`,
      headers: { 'X-MAL-CLIENT-ID': auth.clientId() }
    })
    return body
  }

  // A `paging.next` off the configured base is rebuilt from its offset, so a
  // stubbed run never leaves the stub.
  function nextPage(first: string, next: string): string {
    if (next.startsWith(`${base()}/`)) return next
    const offset = new URL(next).searchParams.get('offset') ?? '0'
    return `${first}&offset=${encodeURIComponent(offset)}`
  }

  return {
    id: 'mal',
    capabilities: CAPABILITIES,

    // The user before the first await (the vault read, then the half-life
    // refresh), so `userId` is the owner the drain read at its presence check.
    async auth() {
      const user = store.get('myanimelistUser') as TrackerUser | null
      const generation = deps.generation()
      if (!user) throw new Error('Not logged in to MyAnimeList')
      const token = await auth.freshToken(generation)
      return { token, userId: user.id, generation }
    },

    authFlow: auth.flow,
    getUser: (token) => fetchMalUser(client, token),
    classifyError: classifyMalError,
    isSessionGone: (err) => err instanceof MalSessionGoneError,
    rateCache: malRateCache,

    async listEntries(session, opts) {
      const first = `${base()}/users/@me/animelist?fields=${encodeURIComponent(LIST_FIELDS)}&limit=${MAL_LIST_PAGE}&nsfw=true`
      const rows: MalListRow[] = []
      let url: string | null = first
      while (url) {
        const page: { data?: MalListRow[]; paging?: { next?: string } } = await userRequest(
          session,
          async (headers) => (await client.request({ url: url!, headers })).body as never
        )
        rows.push(...(page.data ?? []))
        url = page.paging?.next ? nextPage(first, page.paging.next) : null
      }
      const wanted = opts?.status
        ? rows.filter((r) => malValues(r.list_status).status === opts.status)
        : rows
      const malMap = deps.lookupByMalIds
        ? await deps.lookupByMalIds(wanted.map((r) => r.node.id))
        : {}
      return wanted.map(
        (row): TrackerRateEntry<MalListRow> => ({
          ...payloadOf(row, malMap[row.node.id] ?? null),
          native: row
        })
      )
    },

    async getEntry(session, ref) {
      const url = `${base()}/anime/${ref.malId}?fields=${encodeURIComponent(ENTRY_FIELDS)}&nsfw=true`
      const anime = (await userRequest(session, async (headers) => {
        return (await client.request({ url, headers })).body
      })) as { my_list_status?: MalListStatus }
      const ls = anime.my_list_status
      if (!ls) return null
      return {
        trackerId: 'mal',
        malId: ref.malId,
        remoteId: ref.malId,
        values: malValues(ls),
        native: ls
      }
    },

    // The same PATCH creates a missing entry. Only `changedFields` are sent.
    async upsertEntry(session, ref, values, changedFields) {
      const form = malWriteForm(values, changedFields)
      if (Object.keys(form).length === 0) {
        const native = listStatusOf(values)
        return { trackerId: 'mal', malId: ref.malId, remoteId: ref.malId, values, native }
      }
      const url = `${base()}/anime/${ref.malId}/my_list_status`
      const ls = (await userRequest(session, async (headers) => {
        return (await client.request({ method: 'PATCH', url, headers, form })).body
      })) as MalListStatus
      return {
        trackerId: 'mal',
        malId: ref.malId,
        remoteId: ref.malId,
        values: malValues(ls),
        native: ls
      } satisfies TrackerEntry<MalListStatus>
    },

    // Already gone counts as done.
    async deleteEntry(session, ref) {
      const url = `${base()}/anime/${ref.malId}/my_list_status`
      try {
        await userRequest(session, (headers) => client.request({ method: 'DELETE', url, headers }))
      } catch (err) {
        if (err instanceof TrackerApiError && err.status === 404) return
        throw err
      }
    },

    async getRelated(ref) {
      return (await publicRead(
        `/anime/${ref.malId}?fields=${encodeURIComponent(RELATED_FIELDS)}&nsfw=true`
      )) as MalRelatedRead
    },

    async getRecommendations(seedMalIds) {
      const out: { malId: number; recommendations: unknown[] }[] = []
      for (const malId of seedMalIds) {
        const body = (await publicRead(`/anime/${malId}?fields=recommendations&nsfw=true`)) as {
          recommendations?: unknown[]
        }
        out.push({ malId, recommendations: body.recommendations ?? [] })
      }
      return out
    },

    // On demand only, cached in `myanimelistAnimeDetails` by MAL id as
    // `{ details, fetchedAt }` (`shikimoriAnimeDetails`' shape), capped.
    async getDetails(malId) {
      const details = await publicRead(
        `/anime/${malId}?fields=${encodeURIComponent(DETAILS_FIELDS)}&nsfw=true`
      )
      const id = String(malId)
      const { [id]: _previous, ...others } =
        (store.get('myanimelistAnimeDetails') as Record<string, MalCachedDetails> | null) ?? {}
      // The new entry always stays: the others make room for it.
      const kept = capDetails(others, MAL_DETAILS_CACHE_MAX - 1)
      store.set('myanimelistAnimeDetails', { ...kept, [id]: { details, fetchedAt: Date.now() } })
      return details
    }
  }
}
