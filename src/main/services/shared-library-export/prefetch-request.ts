// The downloads an export pre-fetches (#577), built in main the way the detail
// page builds them (`use-episode-downloads.ts`), so the renderer doesn't have
// to be open on the title: the token check, `downloadedAnime` before the
// enqueue, and the same `DownloadRequest` fields, folder name included.

import { addDownloadedAnime } from '../../lib/downloaded-anime'

export const TOKEN_REQUIRED = 'API token is required for downloads. Set it in Settings.'
export const NEEDS_INTERNET = 'Needs internet to download'

export interface PrefetchStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/** Whether this PC can pre-fetch now: online, with an API token, and a download queue wired. */
export function prefetchGate(opts: {
  canEnqueue: boolean
  offline: boolean
  token: unknown
}): ExportPrefetchGate {
  if (!opts.canEnqueue) return 'unavailable'
  if (opts.offline) return 'offline'
  if (typeof opts.token !== 'string' || opts.token === '') return 'no-token'
  return 'ok'
}

/** The download folder's name: the renderer's `getAnimeName` (romaji, ru, title). */
export function downloadName(anime: Pick<AnimeSearchResult, 'title' | 'titles'>): string {
  return anime.titles?.romaji || anime.titles?.ru || anime.title
}

/** `detail` as the `AnimeSearchResult` `downloadedAnime` holds. */
function searchResultOf(d: AnimeSearchResult): AnimeSearchResult {
  return {
    id: d.id,
    title: d.title,
    titles: d.titles ?? {},
    posterUrlSmall: d.posterUrlSmall,
    numberOfEpisodes: d.numberOfEpisodes,
    type: d.type,
    typeTitle: d.typeTitle,
    year: d.year,
    season: d.season
  }
}

/** The title's record: `downloadedAnime`, else `library`, else the cached details. */
export function prefetchAnime(
  get: (key: string) => unknown,
  animeId: number
): AnimeSearchResult | null {
  const pick = (key: string): AnimeSearchResult | undefined =>
    (get(key) as Record<string, AnimeSearchResult> | undefined)?.[animeId]
  const known = pick('downloadedAnime') ?? pick('library')
  if (known) return known
  const detail = (get('animeCache') as Record<string, { animeDetail?: AnimeDetail | null }>)?.[
    animeId
  ]?.animeDetail
  return detail ? searchResultOf(detail) : null
}

/** One not-downloaded episode in the translation picked. */
export interface PrefetchPick {
  animeId: number
  episodeInt: string
  /** The cached `episodeFull`, the detail page's `episodeLabel`. */
  label: string
  option: ExportPrefetchOption
}

export function prefetchRequest(anime: AnimeSearchResult, pick: PrefetchPick): DownloadRequest {
  return {
    translationId: pick.option.translationId,
    height: pick.option.height,
    animeName: downloadName(anime),
    episodeLabel: pick.label,
    episodeInt: pick.episodeInt,
    animeId: anime.id,
    translationType: pick.option.translationType,
    author: pick.option.author
  }
}

/**
 * Registers each title in `downloadedAnime`, then enqueues its episodes, as
 * the detail page does: without the record, the files would sit under a
 * title Downloads and the cleanup paths don't know.
 */
export async function enqueuePrefetch(
  deps: {
    store: PrefetchStore
    enqueue: (requests: DownloadRequest[]) => Promise<void>
  },
  picks: readonly PrefetchPick[]
): Promise<{ pick: PrefetchPick; request: DownloadRequest }[]> {
  const out: { pick: PrefetchPick; request: DownloadRequest }[] = []
  const byTitle = new Map<number, PrefetchPick[]>()
  for (const p of picks) byTitle.set(p.animeId, [...(byTitle.get(p.animeId) ?? []), p])
  for (const [animeId, list] of byTitle) {
    const anime = prefetchAnime((k) => deps.store.get(k), animeId)
    if (!anime) continue
    const requests = list.map((p) => prefetchRequest(anime, p))
    addDownloadedAnime(deps.store, anime)
    await deps.enqueue(requests)
    list.forEach((pick, i) => out.push({ pick, request: requests[i] }))
  }
  return out
}
