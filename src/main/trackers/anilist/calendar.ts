// AniList's airing calendar (#709): the `calendar` source's AniList branch of
// `tracker:get-calendar`. `docs/trackers.md` § AniList → The calendar.
//
// - The tracked set is AniList's own list (`anilistUserRates`): its watching,
//   rewatching and planned titles, as Shikimori's filter is. An empty cache is
//   filled first; a failed list read is logged and the calendar is empty.
// - One `Page.media(id_in)` request per 50 tracked titles (the provider's
//   `getCalendar`, at `interactive`, token-less), one `nextAiringEpisode` per
//   title, matched on `id`. A title with none, or with no `idMal`, drops out,
//   and an adult one does unless the `displayAdultContent` cached with
//   `anilistUser` is on.
// - The cache has Shikimori's rules (`serveCalendar`): a 5-minute TTL, served
//   stale offline and after a failed fetch, invalidated by every change to the
//   tracked set (`anilistCalendarSyncHooks`), and snapshotted per user to
//   `userData/anilist-snapshots.json`.

import type { AnimeSearchResult } from '../../smotret-api'
import type { StorageService } from '../../store/types'
import type { CalendarEntry } from '../../services/shikimori-sync'
import type { TrackerSyncServiceDeps } from '../../services/trackers/sync'
import {
  createCalendarCache,
  createDisplaySnapshots,
  serveCalendar,
  type CalendarSnapshot
} from '../display-snapshots'
import { appStatusFromAnilist } from '../scores'
import { titleOf, type AniListCachedRow, type AniListMedia, type AniListUser } from './provider'

/** The calendar's TTL: Shikimori's `CALENDAR_CACHE_TTL_MS`. */
export const ANILIST_CALENDAR_TTL_MS = 5 * 60 * 1000

const TRACKED_STATUSES = new Set<CalendarEntry['userStatus']>(['watching', 'rewatching', 'planned'])

/** A `Page.media` calendar row, as the provider's `getCalendar` returns it. */
export interface AniListCalendarMedia extends Pick<
  AniListMedia,
  'id' | 'idMal' | 'title' | 'coverImage' | 'format'
> {
  isAdult?: boolean | null
  nextAiringEpisode?: { episode?: number | null; airingAt?: number | null } | null
}

/** A tracked title: its MAL id and the canonical status of AniList's rate. */
export interface TrackedTitle {
  malId: number
  status: CalendarEntry['userStatus']
}

/** The tracked set, keyed by AniList media id: watching, rewatching and planned rows. */
export function trackedCalendarTitles(
  rows: readonly AniListCachedRow[]
): Map<number, TrackedTitle> {
  const out = new Map<number, TrackedTitle>()
  for (const row of rows) {
    const entry = row?.entry
    const mediaId = entry?.media?.id ?? entry?.mediaId
    const malId = entry?.media?.idMal
    if (typeof mediaId !== 'number' || typeof malId !== 'number') continue
    const status = appStatusFromAnilist(entry.status)
    if (TRACKED_STATUSES.has(status)) out.set(mediaId, { malId, status })
  }
  return out
}

/** A kept calendar row: tracked, with a MAL id and a next airing, and allowed by the adult rule. */
export interface CalendarRow {
  media: AniListCalendarMedia & {
    idMal: number
    nextAiringEpisode: { episode: number; airingAt: number }
  }
  tracked: TrackedTitle
}

/** Matches the response to the tracked set on `id`, and drops what can't be shown. */
export function calendarRows(
  tracked: ReadonlyMap<number, TrackedTitle>,
  media: readonly (AniListCalendarMedia | null | undefined)[],
  displayAdultContent: boolean
): CalendarRow[] {
  const out: CalendarRow[] = []
  for (const m of media) {
    if (!m) continue
    const t = tracked.get(m.id)
    if (!t) continue
    if (typeof m.idMal !== 'number') continue
    const next = m.nextAiringEpisode
    if (typeof next?.episode !== 'number' || typeof next.airingAt !== 'number') continue
    if (m.isAdult && !displayAdultContent) continue
    out.push({ media: m as CalendarRow['media'], tracked: t })
  }
  return out
}

/** `CalendarEntry` for each row, with smotret's id and poster when it has the title. */
export function toCalendarEntries(
  rows: readonly CalendarRow[],
  smotret: Readonly<Record<number, AnimeSearchResult>>
): CalendarEntry[] {
  return rows.map(({ media, tracked }) => {
    const s = smotret[media.idMal] ?? null
    return {
      malId: media.idMal,
      animeId: s?.id ?? null,
      name: titleOf(media as AniListMedia),
      posterUrl: s?.posterUrlSmall || media.coverImage?.large || '',
      kind: media.format ? media.format.toLowerCase() : '',
      episodeInt: String(media.nextAiringEpisode.episode),
      nextEpisodeAt: new Date(media.nextAiringEpisode.airingAt * 1000).toISOString(),
      userStatus: tracked.status
    }
  })
}

/** The whole mapping, pure: the rates, the `Page.media` response and the adult option in. */
export function anilistCalendarEntries(input: {
  rows: readonly AniListCachedRow[]
  media: readonly (AniListCalendarMedia | null | undefined)[]
  displayAdultContent: boolean
  smotret?: Readonly<Record<number, AnimeSearchResult>>
}): CalendarEntry[] {
  const kept = calendarRows(
    trackedCalendarTitles(input.rows),
    input.media,
    input.displayAdultContent
  )
  return toCalendarEntries(kept, input.smotret ?? {})
}

export type AniListCachedCalendar = CalendarSnapshot<CalendarEntry>

export interface AniListCalendarDeps {
  store: StorageService
  /** The provider's `getCalendar`: `Page.media(id_in)`, chunked by 50, at `interactive`. */
  getCalendar: (opts: { ids: readonly number[] }) => Promise<unknown[]>
  /** Fills an empty `anilistUserRates` (the instance's `fetchAndCacheRates`); needs the token. */
  fetchRates: () => Promise<unknown>
  lookupByMalIds: (malIds: number[]) => Promise<Record<number, AnimeSearchResult>>
  isOffline: () => boolean
  /** `userData/anilist-snapshots.json`; unset keeps the snapshot in memory. */
  snapshotsPath?: string
  log?: Pick<Console, 'warn'>
}

export interface AniListCalendar {
  /** `tracker:get-calendar`'s AniList branch. */
  get(force?: boolean): Promise<ShikiSnapshotResult<CalendarEntry[]>>
  /** Marks the cached calendar stale: online the next read refetches. */
  invalidate(): void
  /** Drops the snapshot and its file: AniList logout and account switch. */
  clear(): void
  /** The signed-in user's snapshot, or null. */
  cached(): AniListCachedCalendar | null
}

export function createAniListCalendar(deps: AniListCalendarDeps): AniListCalendar {
  const { store } = deps
  const log = deps.log ?? console
  const storedUser = (): AniListUser | null =>
    (store.get('anilistUser') as AniListUser | null | undefined) ?? null
  const currentUserId = (): number | undefined => storedUser()?.id
  const cachedRows = (): AniListCachedRow[] =>
    (store.get('anilistUserRates') as AniListCachedRow[] | undefined) ?? []

  // A loaded calendar starts invalidated, as Shikimori's does.
  const snapshots = createDisplaySnapshots<{ calendar: AniListCachedCalendar }>({
    path: deps.snapshotsPath,
    sections: ['calendar'],
    currentUserId,
    label: '[anilist]',
    revive: { calendar: (stored, userId) => ({ ...stored, userId, invalidated: true }) }
  })

  const cache = createCalendarCache(snapshots)

  async function fetchCalendar(): Promise<AniListCachedCalendar> {
    // Before the rates read: an invalidation from here on marks what this stores (#747).
    const since = cache.begin()
    const userId = currentUserId() ?? null
    let rows = cachedRows()
    if (rows.length === 0) {
      try {
        await deps.fetchRates()
        rows = cachedRows()
      } catch (err) {
        log.warn('[anilist] calendar: rate fetch failed:', err)
      }
    }
    const tracked = trackedCalendarTitles(rows)
    if (tracked.size === 0) return cache.put([], userId, since)
    const media = (await deps.getCalendar({ ids: [...tracked.keys()] })) as AniListCalendarMedia[]
    const kept = calendarRows(tracked, media, storedUser()?.displayAdultContent === true)
    const malIds = [...new Set(kept.map((r) => r.media.idMal))]
    const smotret = malIds.length > 0 ? await deps.lookupByMalIds(malIds) : {}
    return cache.put(toCalendarEntries(kept, smotret), userId, since)
  }

  return {
    get: (force = false) =>
      serveCalendar({
        cached: () => cache.get(),
        isOffline: deps.isOffline,
        fetch: fetchCalendar,
        force,
        ttlMs: ANILIST_CALENDAR_TTL_MS,
        label: '[anilist]'
      }),
    invalidate: () => cache.invalidate(),
    clear: () => snapshots.clear(),
    cached: () => cache.get()
  }
}

/**
 * The AniList sync instance's two rate hooks (#709 § 1): every entry written
 * into `anilistUserRates` (a live or queued edit's cache patch, the drain's
 * reconcile) and every rate refresh invalidates the calendar; the refresh then
 * runs `onRatesRefreshed` (T11a's `tickIfAiringSource`).
 */
export function anilistCalendarSyncHooks(
  calendar: Pick<AniListCalendar, 'invalidate'>,
  onRatesRefreshed?: (trackerId: TrackerId) => void
): Required<Pick<TrackerSyncServiceDeps, 'onRateUpdated' | 'onRatesRefreshed'>> {
  return {
    onRateUpdated: () => calendar.invalidate(),
    onRatesRefreshed: (trackerId) => {
      calendar.invalidate()
      onRatesRefreshed?.(trackerId)
    }
  }
}
