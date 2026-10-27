// The local store as a SyncDoc v1 (#572 §4). Reads only; never writes. Only
// in-scope titles are read, and no out-of-scope id appears anywhere in the
// result. No `fs`: file identities come from `deps.resolveEpisodeFile`.

import type { StorageService } from '../../store/types'
import type { CachedRateEntry } from '../shikimori-rate-cache'
import type { QueuedShikimoriUpdate } from '../shikimori-queue'
import { LEGACY_ORIGIN, watchSyncOf } from './clock'
import { sameValue } from './field-table'
import { stripSkip, type EpisodeFileIdentity } from './skip'

export const STATE_VERSION = 1 as const
export const STATE_MINOR = 0 as const

export const RATE_FIELDS: readonly SyncRateField[] = ['episodes', 'status', 'score', 'rewatches']

export const SHIKIMORI_ORIGIN = 'shikimori'

/** The keys of `SyncTitleState` this version knows; any other key is carried verbatim. */
export const KNOWN_TITLE_FIELDS: ReadonlySet<string> = new Set([
  'watch',
  'starred',
  'priority',
  'rate',
  'dismissed',
  'skip'
])

/** The keys of `SyncDoc` this version knows. */
export const KNOWN_DOC_FIELDS: ReadonlySet<string> = new Set([
  'stateVersion',
  'stateMinor',
  'installId',
  'titles',
  'priorityOrder',
  'tombstones'
])

export interface ProjectDeps {
  /** The identity of the file a skip detection was made from, or null to leave it out. */
  resolveEpisodeFile(
    animeId: string,
    episodeInt: string,
    filePath: string
  ): EpisodeFileIdentity | null
  /** The MAL id of a title; defaults to the rate cache's and `malIdMap`'s mapping. */
  malIdOf?(animeId: string): number | null
  /** S9 (#584)'s pending overlay: Shikimori-bound merge results not yet sent. */
  pendingRates?(
    ownerId: number,
    malId: number
  ): Partial<Record<SyncRateField, SyncRateFieldClock>> | undefined
}

type Rates = { episodes: number; status: string; score: number; rewatches: number }

const UNKNOWN_CLOCK = { at: 0, origin: LEGACY_ORIGIN }

/** The MAL id the rate cache, or failing that `malIdMap`, gives a smotret `animeId`. */
export function defaultMalIdOf(store: StorageService): (animeId: string) => number | null {
  const byAnime = new Map<string, number>()
  const malIdMap = store.get<Record<string, { id?: number }> | undefined>('malIdMap') ?? {}
  for (const [malId, anime] of Object.entries(malIdMap)) {
    if (anime?.id !== undefined) byAnime.set(String(anime.id), Number(malId))
  }
  const cached = store.get<CachedRateEntry[] | undefined>('shikimoriUserRates') ?? []
  for (const entry of cached) {
    const id = (entry.smotretAnime as { id?: number } | null)?.id
    if (id !== undefined) byAnime.set(String(id), entry.rate.target_id)
  }
  return (animeId) => byAnime.get(animeId) ?? null
}

/**
 * The signed-in owner's rate for `malId`, with a clock per field, or undefined.
 *
 * The value is the rate cache, overlaid by the owner's latest queued edit and
 * then by S9's pending overlay. A field's clock is its `syncMeta.rates` stamp
 * **only while the stamp records the value seen here**. Otherwise (a queued
 * edit that was discarded or dropped, whose value Shikimori never received)
 * the stamp is inert and the field takes the Shikimori clock: the cache's
 * `serverUpdatedAt`, or `at: 0` without one. Rules 4–7 never decide on `at`,
 * so no rate clock can win a merge on its own.
 */
export function projectRate(
  store: StorageService,
  malId: number,
  deps: Pick<ProjectDeps, 'pendingRates'> = {}
): SyncRateState | undefined {
  const owner = store.get<{ id: number } | null | undefined>('shikimoriUser')?.id
  if (owner === undefined) return undefined
  const cached = (store.get<CachedRateEntry[] | undefined>('shikimoriUserRates') ?? []).find(
    (e) => e.rate.target_id === malId
  )
  let values: Rates | undefined = cached
    ? {
        episodes: cached.rate.episodes,
        status: cached.rate.status,
        score: cached.rate.score,
        rewatches: cached.rate.rewatches ?? 0
      }
    : undefined
  const queued = (store.get<QueuedShikimoriUpdate[] | undefined>('shikimoriUpdateQueue') ?? [])
    .filter((e) => e.malId === malId)
    .at(-1)
  if (queued) values = { ...queued.after }
  const pending = deps.pendingRates?.(owner, malId) ?? {}
  if (!values) {
    if (RATE_FIELDS.some((f) => pending[f] === undefined)) return undefined
    values = { episodes: 0, status: '', score: 0, rewatches: 0 }
  }
  const stamps = store.get<SyncMeta | undefined>('syncMeta')?.rates?.[`${owner}:${malId}`] ?? {}
  const serverAt = cached?.rate.serverUpdatedAt ? Date.parse(cached.rate.serverUpdatedAt) : NaN
  const shikimoriClock = { at: Number.isFinite(serverAt) ? serverAt : 0, origin: SHIKIMORI_ORIGIN }
  const field = <K extends SyncRateField>(f: K): SyncField<Rates[K]> => {
    const over = pending[f]
    if (over) return { value: over.value as Rates[K], at: over.at, origin: over.origin }
    const value = values![f]
    const stamp = stamps[f]
    const clock = stamp && sameValue(stamp.value, value) ? stamp : shikimoriClock
    return { value, at: clock.at, origin: clock.origin }
  }
  return {
    malId,
    episodes: field('episodes'),
    status: field('status'),
    score: field('score'),
    rewatches: field('rewatches')
  }
}

function membership(
  clock: SyncMembershipClock | undefined
): { live: SyncField<true> } | { stone: SyncTombstone } | null {
  if (!clock) return null
  if (clock.deleted) return { stone: { deleted: true, at: clock.at, origin: clock.origin } }
  return { live: { value: true, at: clock.at, origin: clock.origin } }
}

/** `projectSyncDoc(store, scope, deps)`: the in-scope part of local watch state. */
export function projectSyncDoc(
  store: StorageService,
  scope: Iterable<string | number>,
  deps: ProjectDeps
): SyncDoc {
  const ids = [...new Set([...scope].map(String))].sort()
  const inScope = new Set(ids)
  const installId = store.get<string | undefined>('installId') ?? ''
  const watchProgress =
    store.get<Record<string, WatchProgressEntry> | undefined>('watchProgress') ?? {}
  const library = store.get<Record<string, unknown> | undefined>('library') ?? {}
  const priority = store.get<string[] | undefined>('priorityAnimeIds') ?? []
  const meta = store.get<SyncMeta | undefined>('syncMeta')
  const dismissedKeys = store.get<string[] | undefined>('dismissedContinueWatching') ?? []
  const skipDetections =
    store.get<Record<string, ShowSkipDetections> | undefined>('skipDetections') ?? {}
  const malIdOf = deps.malIdOf ?? defaultMalIdOf(store)

  const titles: Record<string, SyncTitleState> = {}
  const tombstones: SyncDoc['tombstones'] = {}
  for (const id of ids) titles[id] = { ...(meta?.unknown?.titles?.[id] ?? {}) }

  for (const [key, row] of Object.entries(watchProgress)) {
    const sep = key.indexOf(':')
    const id = key.slice(0, sep)
    if (sep < 0 || !inScope.has(id)) continue
    const episodeInt = key.slice(sep + 1)
    const clocks = watchSyncOf(row)
    const missing = { at: 0, origin: installId }
    const position: SyncWatchPosition = { position: row.position, duration: row.duration }
    if (row.translationId !== undefined) position.translationId = row.translationId
    const watch = (titles[id].watch ??= {})
    watch[episodeInt] = {
      position: { value: position, ...(clocks.position ?? missing) },
      watched: { value: !!row.watched, ...(clocks.watched ?? missing) },
      watchedAt: row.watchedAt ?? null
    }
  }

  for (const id of ids) {
    const title = titles[id]
    const clocks = meta?.titles?.[id]
    const starred = membership(clocks?.starred)
    if (library[id]) {
      title.starred =
        starred && 'live' in starred ? starred.live : { value: true, ...UNKNOWN_CLOCK }
    } else if (starred && 'stone' in starred) {
      ;(tombstones[id] ??= {}).starred = starred.stone
    }
    const prioritised = membership(clocks?.priority)
    if (priority.includes(id)) {
      title.priority =
        prioritised && 'live' in prioritised ? prioritised.live : { value: true, ...UNKNOWN_CLOCK }
    } else if (prioritised && 'stone' in prioritised) {
      ;(tombstones[id] ??= {}).priority = prioritised.stone
    }

    const malId = malIdOf(id)
    if (malId !== null) {
      const rate = projectRate(store, malId, deps)
      if (rate) title.rate = rate
    }

    const prefix = `${id}:`
    const dismissed = dismissedKeys
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort()
    if (dismissed.length > 0) title.dismissed = [...new Set(dismissed)]

    const det = skipDetections[id]
    if (det) {
      const skip = stripSkip(det, (ep, filePath) => deps.resolveEpisodeFile(id, ep, filePath))
      if (skip) title.skip = skip
    }
  }

  const orderClock = meta?.priorityOrder ?? UNKNOWN_CLOCK
  return {
    ...(meta?.unknown?.doc ?? {}),
    stateVersion: STATE_VERSION,
    stateMinor: STATE_MINOR,
    installId,
    titles,
    priorityOrder: {
      value: priority.filter((id) => inScope.has(id)),
      at: orderClock.at,
      origin: orderClock.origin
    },
    tombstones
  }
}
